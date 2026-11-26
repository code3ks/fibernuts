//! Durable correlation state for Fiber settlement.
//!
//! The journal records intent and the last observation needed to reconcile with Fiber after a
//! restart. It is never an authority for settlement: callers must still query the Fiber node
//! before issuing ecash, releasing proofs, or retrying an outgoing payment.

use std::collections::HashSet;
use std::fmt;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior, MAIN_DB};
use thiserror::Error;

use crate::wire::{self, Currency, Script};

const SCHEMA_VERSION: u32 = 2;
const RECORD_VERSION: u32 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const RECORD_COLUMNS: &str = "
    record_version, direction, quote_id, payment_hash, invoice, principal_base,
    mint_url, unit, unit_scale, network, asset_kind, asset_code_hash, asset_hash_type,
    asset_args, fee_ceiling_base, actual_fee_base, observed_state, attempt_id, event_state,
    deadline_unix, reconciliation_count, dispatch_count, last_reconciled_at,
    next_reconcile_at, last_error_class, revision, created_at, updated_at, terminal_at
";

/// Errors raised while opening, validating, or mutating the settlement journal.
#[derive(Error)]
pub enum JournalError {
    /// SQLite could not complete the requested operation.
    #[error("settlement journal storage error")]
    Storage(rusqlite::Error),

    /// A thread panicked while holding the journal connection.
    #[error("settlement journal lock is unavailable")]
    LockUnavailable,

    /// The database was created by a newer implementation.
    #[error(
        "settlement journal schema version {found} is incompatible with supported version {supported}"
    )]
    IncompatibleSchema {
        /// Version found in the database.
        found: u32,
        /// Newest version this implementation understands.
        supported: u32,
    },

    /// A durable record failed strict decoding or validation.
    #[error("settlement journal contains a corrupt `{field}` field")]
    CorruptRecord {
        /// The field that could not be decoded safely.
        field: &'static str,
    },

    /// A replay tried to bind an existing identity to different economic intent.
    #[error("settlement journal operation conflicts with an existing durable identity")]
    Conflict,

    /// The database belongs to another mint or settlement asset.
    #[error("settlement journal scope does not match the configured mint and asset")]
    ScopeMismatch,

    /// A caller tried to move an operation backwards or across direction-specific states.
    #[error("invalid settlement journal state transition")]
    InvalidTransition,

    /// A compare-and-swap update used a stale revision.
    #[error("settlement journal operation changed concurrently")]
    ConcurrentUpdate,

    /// A new record was malformed before it reached SQLite.
    #[error("invalid settlement journal operation: {0}")]
    InvalidOperation(&'static str),

    /// Backup and restore never overwrite a destination implicitly.
    #[error("settlement journal destination already exists")]
    DestinationExists,

    /// A filesystem operation around an atomic backup failed.
    #[error("settlement journal filesystem error")]
    Io(std::io::Error),
}

impl fmt::Debug for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl From<rusqlite::Error> for JournalError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error)
    }
}

impl From<std::io::Error> for JournalError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Whether value is entering or leaving the mint over Fiber.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettlementDirection {
    /// A Fiber invoice whose settlement may make a mint quote eligible for issuance.
    Incoming,
    /// A Fiber payment funded by proofs reserved for a melt quote.
    Outgoing,
}

impl SettlementDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Incoming => "incoming",
            Self::Outgoing => "outgoing",
        }
    }

    fn parse(raw: &str) -> Result<Self, JournalError> {
        match raw {
            "incoming" => Ok(Self::Incoming),
            "outgoing" => Ok(Self::Outgoing),
            _ => Err(JournalError::CorruptRecord { field: "direction" }),
        }
    }
}

/// Exact settlement asset identity stored alongside every operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettlementAsset {
    /// Native CKB settlement.
    Native,
    /// A CKB UDT identified by its complete type script.
    Udt(Script),
}

impl From<Option<Script>> for SettlementAsset {
    fn from(script: Option<Script>) -> Self {
        match script {
            Some(script) => Self::Udt(script),
            None => Self::Native,
        }
    }
}

/// Immutable identity shared by all records in one journal database.
#[derive(Clone, PartialEq, Eq)]
pub struct JournalScope {
    mint_url: String,
    unit: String,
    unit_scale: u64,
    network: Currency,
    asset: SettlementAsset,
}

impl fmt::Debug for JournalScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JournalScope")
            .field("mint_url", &"[REDACTED]")
            .field("unit", &self.unit)
            .field("unit_scale", &self.unit_scale)
            .field("network", &self.network)
            .field("asset", &self.asset)
            .finish()
    }
}

impl JournalScope {
    /// Build a scope from the processor's configured mint and Fiber asset.
    pub fn new(
        mint_url: impl Into<String>,
        unit: impl Into<String>,
        unit_scale: u64,
        network: Currency,
        asset: SettlementAsset,
    ) -> Self {
        Self {
            mint_url: mint_url.into(),
            unit: unit.into(),
            unit_scale,
            network,
            asset,
        }
    }

    /// Canonical mint URL this database belongs to.
    pub fn mint_url(&self) -> &str {
        &self.mint_url
    }

    /// Cashu unit carried by its records.
    pub fn unit(&self) -> &str {
        &self.unit
    }

    /// Fiber base units represented by one Cashu unit.
    pub fn unit_scale(&self) -> u64 {
        self.unit_scale
    }

    /// Fiber network carried by its records.
    pub fn network(&self) -> Currency {
        self.network
    }

    /// Exact native or UDT settlement identity.
    pub fn asset(&self) -> &SettlementAsset {
        &self.asset
    }
}

/// Last authoritative Fiber state observed for an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservedState {
    /// Incoming invoice is open and payable.
    IncomingOpen,
    /// Incoming invoice has an unsettled TLC and is not issuance-eligible.
    IncomingReceived,
    /// Incoming invoice is authoritatively paid.
    IncomingPaid,
    /// Incoming invoice was cancelled.
    IncomingCancelled,
    /// Incoming invoice expired.
    IncomingExpired,
    /// Outgoing quote has been priced but not prepared for dispatch.
    OutgoingQuoted,
    /// Stable outgoing intent is durable before a payment RPC.
    OutgoingDispatchPrepared,
    /// Fiber created an outgoing payment session.
    OutgoingCreated,
    /// Fiber reports an outgoing TLC in flight.
    OutgoingInflight,
    /// Fiber reports authoritative outgoing success.
    OutgoingSucceeded,
    /// Fiber reports authoritative outgoing failure.
    OutgoingFailed,
    /// Fiber reports that no outgoing session exists for the stable hash.
    OutgoingUnknown,
}

impl ObservedState {
    fn as_str(self) -> &'static str {
        match self {
            Self::IncomingOpen => "incoming_open",
            Self::IncomingReceived => "incoming_received",
            Self::IncomingPaid => "incoming_paid",
            Self::IncomingCancelled => "incoming_cancelled",
            Self::IncomingExpired => "incoming_expired",
            Self::OutgoingQuoted => "outgoing_quoted",
            Self::OutgoingDispatchPrepared => "outgoing_dispatch_prepared",
            Self::OutgoingCreated => "outgoing_created",
            Self::OutgoingInflight => "outgoing_inflight",
            Self::OutgoingSucceeded => "outgoing_succeeded",
            Self::OutgoingFailed => "outgoing_failed",
            Self::OutgoingUnknown => "outgoing_unknown",
        }
    }

    fn parse(raw: &str) -> Result<Self, JournalError> {
        match raw {
            "incoming_open" => Ok(Self::IncomingOpen),
            "incoming_received" => Ok(Self::IncomingReceived),
            "incoming_paid" => Ok(Self::IncomingPaid),
            "incoming_cancelled" => Ok(Self::IncomingCancelled),
            "incoming_expired" => Ok(Self::IncomingExpired),
            "outgoing_quoted" => Ok(Self::OutgoingQuoted),
            "outgoing_dispatch_prepared" => Ok(Self::OutgoingDispatchPrepared),
            "outgoing_created" => Ok(Self::OutgoingCreated),
            "outgoing_inflight" => Ok(Self::OutgoingInflight),
            "outgoing_succeeded" => Ok(Self::OutgoingSucceeded),
            "outgoing_failed" => Ok(Self::OutgoingFailed),
            "outgoing_unknown" => Ok(Self::OutgoingUnknown),
            _ => Err(JournalError::CorruptRecord {
                field: "observed_state",
            }),
        }
    }

    fn direction(self) -> SettlementDirection {
        match self {
            Self::IncomingOpen
            | Self::IncomingReceived
            | Self::IncomingPaid
            | Self::IncomingCancelled
            | Self::IncomingExpired => SettlementDirection::Incoming,
            Self::OutgoingQuoted
            | Self::OutgoingDispatchPrepared
            | Self::OutgoingCreated
            | Self::OutgoingInflight
            | Self::OutgoingSucceeded
            | Self::OutgoingFailed
            | Self::OutgoingUnknown => SettlementDirection::Outgoing,
        }
    }

    pub(crate) fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::IncomingOpen => matches!(
                next,
                Self::IncomingReceived
                    | Self::IncomingPaid
                    | Self::IncomingCancelled
                    | Self::IncomingExpired
            ),
            Self::IncomingReceived => matches!(
                next,
                Self::IncomingPaid | Self::IncomingCancelled | Self::IncomingExpired
            ),
            Self::IncomingPaid | Self::IncomingCancelled | Self::IncomingExpired => false,
            Self::OutgoingQuoted => matches!(
                next,
                Self::OutgoingDispatchPrepared
                    | Self::OutgoingCreated
                    | Self::OutgoingInflight
                    | Self::OutgoingSucceeded
                    | Self::OutgoingFailed
                    | Self::OutgoingUnknown
            ),
            Self::OutgoingDispatchPrepared => matches!(
                next,
                Self::OutgoingCreated
                    | Self::OutgoingInflight
                    | Self::OutgoingSucceeded
                    | Self::OutgoingFailed
                    | Self::OutgoingUnknown
            ),
            Self::OutgoingUnknown => matches!(
                next,
                Self::OutgoingDispatchPrepared
                    | Self::OutgoingCreated
                    | Self::OutgoingInflight
                    | Self::OutgoingSucceeded
                    | Self::OutgoingFailed
            ),
            Self::OutgoingCreated => matches!(
                next,
                Self::OutgoingInflight | Self::OutgoingSucceeded | Self::OutgoingFailed
            ),
            Self::OutgoingInflight => {
                matches!(next, Self::OutgoingSucceeded | Self::OutgoingFailed)
            }
            Self::OutgoingSucceeded | Self::OutgoingFailed => false,
        }
    }
}

/// Progress of the deduplicated terminal notification associated with an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventState {
    /// The operation has not crossed an event-producing boundary.
    NotApplicable,
    /// A terminal event still needs delivery or acknowledgement.
    Pending,
    /// Terminal delivery has been durably recorded.
    Delivered,
}

impl EventState {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::Pending => "pending",
            Self::Delivered => "delivered",
        }
    }

    fn parse(raw: &str) -> Result<Self, JournalError> {
        match raw {
            "not_applicable" => Ok(Self::NotApplicable),
            "pending" => Ok(Self::Pending),
            "delivered" => Ok(Self::Delivered),
            _ => Err(JournalError::CorruptRecord {
                field: "event_state",
            }),
        }
    }
}

/// Bounded failure classes that are safe to retain without raw RPC text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciliationErrorClass {
    /// The Fiber RPC endpoint could not be reached.
    RpcUnavailable,
    /// A bounded operation exceeded its deadline.
    Timeout,
    /// Fiber rejected the operation or lookup.
    NodeRejected,
    /// A response could not be decoded or violated the expected contract.
    InvalidResponse,
}

impl ReconciliationErrorClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::RpcUnavailable => "rpc_unavailable",
            Self::Timeout => "timeout",
            Self::NodeRejected => "node_rejected",
            Self::InvalidResponse => "invalid_response",
        }
    }

    fn parse(raw: &str) -> Result<Self, JournalError> {
        match raw {
            "rpc_unavailable" => Ok(Self::RpcUnavailable),
            "timeout" => Ok(Self::Timeout),
            "node_rejected" => Ok(Self::NodeRejected),
            "invalid_response" => Ok(Self::InvalidResponse),
            _ => Err(JournalError::CorruptRecord {
                field: "last_error_class",
            }),
        }
    }
}

/// Versioned durable settlement operation.
#[derive(Clone, PartialEq, Eq)]
pub struct SettlementOperation {
    record_version: u32,
    direction: SettlementDirection,
    quote_id: String,
    payment_hash: String,
    invoice: String,
    principal_base: u128,
    scope: JournalScope,
    fee_ceiling_base: Option<u128>,
    actual_fee_base: Option<u128>,
    observed_state: ObservedState,
    attempt_id: String,
    event_state: EventState,
    deadline_unix: Option<u64>,
    reconciliation_count: u64,
    dispatch_count: u64,
    last_reconciled_at: Option<u64>,
    next_reconcile_at: u64,
    last_error_class: Option<ReconciliationErrorClass>,
    revision: u64,
    created_at: u64,
    updated_at: u64,
    terminal_at: Option<u64>,
}

impl fmt::Debug for SettlementOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SettlementOperation")
            .field("record_version", &self.record_version)
            .field("direction", &self.direction)
            .field("quote_id", &"[REDACTED]")
            .field("payment_hash", &"[REDACTED]")
            .field("invoice", &"[REDACTED]")
            .field("principal_base", &self.principal_base)
            .field("scope", &self.scope)
            .field("fee_ceiling_base", &self.fee_ceiling_base)
            .field("actual_fee_base", &self.actual_fee_base)
            .field("observed_state", &self.observed_state)
            .field("attempt_id", &"[REDACTED]")
            .field("event_state", &self.event_state)
            .field("revision", &self.revision)
            .field("terminal_at", &self.terminal_at)
            .finish()
    }
}

impl SettlementOperation {
    /// Record format version.
    pub fn record_version(&self) -> u32 {
        self.record_version
    }

    /// Incoming or outgoing direction.
    pub fn direction(&self) -> SettlementDirection {
        self.direction
    }

    /// Stable CDK quote identifier.
    pub fn quote_id(&self) -> &str {
        &self.quote_id
    }

    /// Canonical Fiber payment hash.
    pub fn payment_hash(&self) -> &str {
        &self.payment_hash
    }

    /// Fiber invoice required for authoritative recovery.
    pub fn invoice(&self) -> &str {
        &self.invoice
    }

    /// Invoice principal in Fiber base units.
    pub fn principal_base(&self) -> u128 {
        self.principal_base
    }

    /// Mint, unit, network, and asset binding.
    pub fn scope(&self) -> &JournalScope {
        &self.scope
    }

    /// Maximum routing fee authorized for an outgoing payment, in base units.
    pub fn fee_ceiling_base(&self) -> Option<u128> {
        self.fee_ceiling_base
    }

    /// Authoritative terminal routing fee, when known.
    pub fn actual_fee_base(&self) -> Option<u128> {
        self.actual_fee_base
    }

    /// Last authoritative Fiber state.
    pub fn observed_state(&self) -> ObservedState {
        self.observed_state
    }

    /// Stable identity reused across attempts and restarts.
    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    /// Terminal notification progress.
    pub fn event_state(&self) -> EventState {
        self.event_state
    }

    /// Economic operation deadline, when one is defined.
    pub fn deadline_unix(&self) -> Option<u64> {
        self.deadline_unix
    }

    /// Number of authoritative reconciliation observations.
    pub fn reconciliation_count(&self) -> u64 {
        self.reconciliation_count
    }

    /// Number of durable dispatch boundaries crossed with the same attempt identity.
    pub fn dispatch_count(&self) -> u64 {
        self.dispatch_count
    }

    /// Last reconciliation timestamp.
    pub fn last_reconciled_at(&self) -> Option<u64> {
        self.last_reconciled_at
    }

    /// Earliest time the recovery worker should revisit this operation.
    pub fn next_reconcile_at(&self) -> u64 {
        self.next_reconcile_at
    }

    /// Last bounded error class, excluding raw RPC data.
    pub fn last_error_class(&self) -> Option<ReconciliationErrorClass> {
        self.last_error_class
    }

    /// Compare-and-swap revision.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Creation timestamp.
    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    /// Last durable update timestamp.
    pub fn updated_at(&self) -> u64 {
        self.updated_at
    }

    /// Time the operation became fully terminal, including event delivery where applicable.
    pub fn terminal_at(&self) -> Option<u64> {
        self.terminal_at
    }
}

/// New immutable operation identity to insert into the journal.
#[derive(Clone)]
pub struct NewSettlementOperation {
    record: SettlementOperation,
}

impl NewSettlementOperation {
    /// Build an incoming invoice record before returning the invoice to CDK.
    pub fn incoming(
        scope: JournalScope,
        quote_id: impl Into<String>,
        payment_hash: impl Into<String>,
        invoice: impl Into<String>,
        principal_base: u128,
        deadline_unix: u64,
        now_unix: u64,
    ) -> Self {
        Self::new(
            SettlementDirection::Incoming,
            scope,
            quote_id.into(),
            payment_hash.into(),
            invoice.into(),
            principal_base,
            None,
            ObservedState::IncomingOpen,
            EventState::Pending,
            Some(deadline_unix),
            now_unix,
        )
    }

    /// Build an outgoing quote record before returning its fee ceiling to CDK.
    pub fn outgoing(
        scope: JournalScope,
        quote_id: impl Into<String>,
        payment_hash: impl Into<String>,
        invoice: impl Into<String>,
        principal_base: u128,
        fee_ceiling_base: Option<u128>,
        now_unix: u64,
    ) -> Self {
        Self::new(
            SettlementDirection::Outgoing,
            scope,
            quote_id.into(),
            payment_hash.into(),
            invoice.into(),
            principal_base,
            fee_ceiling_base,
            ObservedState::OutgoingQuoted,
            EventState::NotApplicable,
            None,
            now_unix,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        direction: SettlementDirection,
        scope: JournalScope,
        quote_id: String,
        payment_hash: String,
        invoice: String,
        principal_base: u128,
        fee_ceiling_base: Option<u128>,
        observed_state: ObservedState,
        event_state: EventState,
        deadline_unix: Option<u64>,
        now_unix: u64,
    ) -> Self {
        let attempt_id = format!("{}:{quote_id}:{payment_hash}", direction.as_str());
        Self {
            record: SettlementOperation {
                record_version: RECORD_VERSION,
                direction,
                quote_id,
                payment_hash,
                invoice,
                principal_base,
                scope,
                fee_ceiling_base,
                actual_fee_base: None,
                observed_state,
                attempt_id,
                event_state,
                deadline_unix,
                reconciliation_count: 0,
                dispatch_count: 0,
                last_reconciled_at: None,
                next_reconcile_at: now_unix,
                last_error_class: None,
                revision: 0,
                created_at: now_unix,
                updated_at: now_unix,
                terminal_at: None,
            },
        }
    }
}

/// One authoritative observation to apply with compare-and-swap semantics.
#[derive(Debug, Clone, Copy)]
pub struct ReconciliationObservation {
    /// Revision the caller observed before querying Fiber.
    pub expected_revision: u64,
    /// Authoritative state returned by Fiber.
    pub state: ObservedState,
    /// Actual terminal routing fee, in base units.
    pub actual_fee_base: Option<u128>,
    /// Time the observation completed.
    pub checked_at: u64,
    /// Earliest time another reconciliation should run.
    pub next_reconcile_at: u64,
    /// New economic deadline, used when preparing outgoing dispatch.
    pub deadline_unix: Option<u64>,
}

/// SQLite-backed durable settlement journal.
pub struct SettlementJournal {
    connection: Mutex<Connection>,
}

impl fmt::Debug for SettlementJournal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SettlementJournal").finish_non_exhaustive()
    }
}

impl SettlementJournal {
    /// Open or create a journal at `path`, migrating older supported schemas atomically.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalError> {
        let path = path.as_ref();
        validate_file_path(path)?;
        let mut connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        validate_database(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Open an isolated in-memory journal. Intended for deterministic tests and embedders that
    /// provide their own process-level durability boundary.
    pub fn in_memory() -> Result<Self, JournalError> {
        let mut connection = Connection::open_in_memory()?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;
        validate_database(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Bind an empty journal to one configured mint and exact settlement asset. Repeating the
    /// same binding is idempotent; any conflicting binding fails closed.
    pub fn bind_scope(&self, scope: &JournalScope) -> Result<(), JournalError> {
        validate_scope(scope)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match read_scope(&transaction)? {
            Some(existing) if existing == *scope => {}
            Some(_) => return Err(JournalError::ScopeMismatch),
            None => {
                let (kind, code_hash, hash_type, args) = asset_columns(&scope.asset);
                transaction.execute(
                    "INSERT INTO journal_scope (
                        singleton, mint_url, unit, unit_scale, network, asset_kind,
                        asset_code_hash, asset_hash_type, asset_args
                     ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        scope.mint_url,
                        scope.unit,
                        scope.unit_scale.to_string(),
                        network_to_str(scope.network),
                        kind,
                        code_hash,
                        hash_type,
                        args,
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Return the scope this database is bound to, if it has been initialized by a backend.
    pub fn scope(&self) -> Result<Option<JournalScope>, JournalError> {
        let connection = self.lock()?;
        read_scope(&connection)
    }

    /// Insert an operation atomically. Exact replay returns the durable row; conflicting quote or
    /// payment-hash reuse fails without a partial insert.
    pub fn insert(
        &self,
        new_operation: NewSettlementOperation,
    ) -> Result<SettlementOperation, JournalError> {
        validate_record(&new_operation.record, false)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let bound_scope = read_scope(&transaction)?.ok_or(JournalError::ScopeMismatch)?;
        if bound_scope != new_operation.record.scope {
            return Err(JournalError::ScopeMismatch);
        }

        if let Some(existing) = query_by_quote(
            &transaction,
            new_operation.record.direction,
            &new_operation.record.quote_id,
        )? {
            if same_insert_identity(&existing, &new_operation.record) {
                transaction.commit()?;
                return Ok(existing);
            }
            return Err(JournalError::Conflict);
        }

        if query_by_hash(
            &transaction,
            new_operation.record.direction,
            &new_operation.record.payment_hash,
        )?
        .is_some()
        {
            return Err(JournalError::Conflict);
        }

        insert_record(&transaction, &new_operation.record)?;
        transaction.commit()?;
        Ok(new_operation.record)
    }

    /// Find an operation by its CDK quote identifier.
    pub fn by_quote_id(
        &self,
        direction: SettlementDirection,
        quote_id: &str,
    ) -> Result<Option<SettlementOperation>, JournalError> {
        let connection = self.lock()?;
        query_by_quote(&connection, direction, quote_id)
    }

    /// Find an operation by its canonical Fiber payment hash.
    pub fn by_payment_hash(
        &self,
        direction: SettlementDirection,
        payment_hash: &str,
    ) -> Result<Option<SettlementOperation>, JournalError> {
        let canonical = canonical_hash(payment_hash)
            .map_err(|_| JournalError::InvalidOperation("payment hash"))?;
        let connection = self.lock()?;
        query_by_hash(&connection, direction, &canonical)
    }

    /// Return every nonterminal operation in deterministic recovery order.
    pub fn recovery_queue(&self) -> Result<Vec<SettlementOperation>, JournalError> {
        let connection = self.lock()?;
        let sql = format!(
            "SELECT {RECORD_COLUMNS} FROM settlement_operations
             WHERE terminal_at IS NULL
             ORDER BY next_reconcile_at ASC, created_at ASC, direction ASC, quote_id ASC"
        );
        let mut statement = connection.prepare(&sql)?;
        let raw = statement
            .query_map([], raw_record_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let operations = raw
            .into_iter()
            .map(decode_record)
            .collect::<Result<Vec<_>, _>>()?;
        let bound_scope = read_scope(&connection)?.ok_or(JournalError::ScopeMismatch)?;
        if operations
            .iter()
            .any(|operation| operation.scope() != &bound_scope)
        {
            return Err(JournalError::ScopeMismatch);
        }
        Ok(operations)
    }

    /// Atomically mark the stable outgoing attempt as ready for one bounded dispatch call.
    pub fn prepare_outgoing_dispatch(
        &self,
        quote_id: &str,
        expected_revision: u64,
        deadline_unix: u64,
        now_unix: u64,
    ) -> Result<SettlementOperation, JournalError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = query_by_quote(&transaction, SettlementDirection::Outgoing, quote_id)?
            .ok_or(JournalError::Conflict)?;
        require_revision(&current, expected_revision)?;
        if current.dispatch_count != 0
            || current.event_state != EventState::NotApplicable
            || !current
                .observed_state
                .can_transition_to(ObservedState::OutgoingDispatchPrepared)
        {
            return Err(JournalError::InvalidTransition);
        }

        let deadline = current.deadline_unix.unwrap_or(deadline_unix);
        let event_state = EventState::Pending;
        let terminal_at = terminal_at(
            SettlementDirection::Outgoing,
            ObservedState::OutgoingDispatchPrepared,
            event_state,
            now_unix,
        );
        let changed = transaction.execute(
            "UPDATE settlement_operations SET
                observed_state = ?1, event_state = ?2, deadline_unix = ?3,
                dispatch_count = dispatch_count + 1, revision = revision + 1,
                updated_at = ?4, terminal_at = ?5
             WHERE direction = 'outgoing' AND quote_id = ?6 AND revision = ?7",
            params![
                ObservedState::OutgoingDispatchPrepared.as_str(),
                event_state.as_str(),
                to_i64(deadline, "deadline_unix")?,
                to_i64(now_unix, "updated_at")?,
                terminal_at.map(|v| to_i64(v, "terminal_at")).transpose()?,
                quote_id,
                to_i64(expected_revision, "revision")?,
            ],
        )?;
        if changed != 1 {
            return Err(JournalError::ConcurrentUpdate);
        }
        let updated = query_by_quote(&transaction, SettlementDirection::Outgoing, quote_id)?
            .ok_or(JournalError::Conflict)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Apply one authoritative Fiber observation and its reconciliation schedule atomically.
    pub fn record_observation(
        &self,
        direction: SettlementDirection,
        quote_id: &str,
        observation: ReconciliationObservation,
    ) -> Result<SettlementOperation, JournalError> {
        if observation.state.direction() != direction {
            return Err(JournalError::InvalidTransition);
        }
        if observation.actual_fee_base.is_some()
            && observation.state != ObservedState::OutgoingSucceeded
        {
            return Err(JournalError::InvalidOperation(
                "actual fee before outgoing success",
            ));
        }
        if observation.state == ObservedState::OutgoingSucceeded
            && observation.actual_fee_base.is_none()
        {
            return Err(JournalError::InvalidOperation(
                "missing actual fee for outgoing success",
            ));
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        require_revision(&current, observation.expected_revision)?;
        if !current.observed_state.can_transition_to(observation.state) {
            return Err(JournalError::InvalidTransition);
        }

        if let (Some(existing), Some(observed)) =
            (current.actual_fee_base, observation.actual_fee_base)
        {
            if existing != observed {
                return Err(JournalError::Conflict);
            }
        }
        if observation
            .actual_fee_base
            .zip(current.fee_ceiling_base)
            .is_some_and(|(actual, ceiling)| actual > ceiling)
        {
            return Err(JournalError::InvalidOperation(
                "actual fee exceeds fee ceiling",
            ));
        }
        if let (Some(existing), Some(observed)) = (current.deadline_unix, observation.deadline_unix)
        {
            if existing != observed {
                return Err(JournalError::Conflict);
            }
        }
        let actual_fee = observation.actual_fee_base.or(current.actual_fee_base);
        let deadline = observation.deadline_unix.or(current.deadline_unix);
        let terminal = current.terminal_at.or_else(|| {
            terminal_at(
                direction,
                observation.state,
                current.event_state,
                observation.checked_at,
            )
        });
        let changed = transaction.execute(
            "UPDATE settlement_operations SET
                observed_state = ?1, actual_fee_base = ?2, deadline_unix = ?3,
                reconciliation_count = reconciliation_count + 1,
                last_reconciled_at = ?4, next_reconcile_at = ?5,
                last_error_class = NULL, revision = revision + 1,
                updated_at = ?4, terminal_at = ?6
             WHERE direction = ?7 AND quote_id = ?8 AND revision = ?9",
            params![
                observation.state.as_str(),
                actual_fee.map(|value| value.to_string()),
                deadline.map(|v| to_i64(v, "deadline_unix")).transpose()?,
                to_i64(observation.checked_at, "last_reconciled_at")?,
                to_i64(observation.next_reconcile_at, "next_reconcile_at")?,
                terminal.map(|v| to_i64(v, "terminal_at")).transpose()?,
                direction.as_str(),
                quote_id,
                to_i64(observation.expected_revision, "revision")?,
            ],
        )?;
        if changed != 1 {
            return Err(JournalError::ConcurrentUpdate);
        }
        let updated =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Record a bounded reconciliation error without replacing the last authoritative state.
    pub fn record_reconciliation_error(
        &self,
        direction: SettlementDirection,
        quote_id: &str,
        expected_revision: u64,
        error_class: ReconciliationErrorClass,
        checked_at: u64,
        next_reconcile_at: u64,
    ) -> Result<SettlementOperation, JournalError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        require_revision(&current, expected_revision)?;
        if current.terminal_at.is_some() {
            return Err(JournalError::InvalidTransition);
        }

        let changed = transaction.execute(
            "UPDATE settlement_operations SET
                reconciliation_count = reconciliation_count + 1,
                last_reconciled_at = ?1, next_reconcile_at = ?2,
                last_error_class = ?3, revision = revision + 1, updated_at = ?1
             WHERE direction = ?4 AND quote_id = ?5 AND revision = ?6",
            params![
                to_i64(checked_at, "last_reconciled_at")?,
                to_i64(next_reconcile_at, "next_reconcile_at")?,
                error_class.as_str(),
                direction.as_str(),
                quote_id,
                to_i64(expected_revision, "revision")?,
            ],
        )?;
        if changed != 1 {
            return Err(JournalError::ConcurrentUpdate);
        }
        let updated =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Durably deduplicate delivery of a terminal settlement event.
    pub fn mark_event_delivered(
        &self,
        direction: SettlementDirection,
        quote_id: &str,
        expected_revision: u64,
        now_unix: u64,
    ) -> Result<SettlementOperation, JournalError> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        require_revision(&current, expected_revision)?;
        let terminal_state = match direction {
            SettlementDirection::Incoming => current.observed_state == ObservedState::IncomingPaid,
            SettlementDirection::Outgoing => matches!(
                current.observed_state,
                ObservedState::OutgoingSucceeded | ObservedState::OutgoingFailed
            ),
        };
        if current.event_state != EventState::Pending || !terminal_state {
            return Err(JournalError::InvalidTransition);
        }

        let terminal = terminal_at(
            direction,
            current.observed_state,
            EventState::Delivered,
            now_unix,
        );
        let changed = transaction.execute(
            "UPDATE settlement_operations SET
                event_state = 'delivered', revision = revision + 1,
                updated_at = ?1, terminal_at = ?2
             WHERE direction = ?3 AND quote_id = ?4 AND revision = ?5",
            params![
                to_i64(now_unix, "updated_at")?,
                terminal.map(|v| to_i64(v, "terminal_at")).transpose()?,
                direction.as_str(),
                quote_id,
                to_i64(expected_revision, "revision")?,
            ],
        )?;
        if changed != 1 {
            return Err(JournalError::ConcurrentUpdate);
        }
        let updated =
            query_by_quote(&transaction, direction, quote_id)?.ok_or(JournalError::Conflict)?;
        transaction.commit()?;
        Ok(updated)
    }

    /// Delete terminal records strictly older than `cutoff_unix`. Nonterminal records are never
    /// pruned, regardless of age.
    pub fn prune_terminal_before(&self, cutoff_unix: u64) -> Result<usize, JournalError> {
        let connection = self.lock()?;
        validate_semantic_content(&connection)?;
        Ok(connection.execute(
            "DELETE FROM settlement_operations
             WHERE terminal_at IS NOT NULL AND terminal_at < ?1",
            [to_i64(cutoff_unix, "terminal_at")?],
        )?)
    }

    /// Create an integrity-checked online backup without overwriting an existing destination.
    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<(), JournalError> {
        let destination = destination.as_ref();
        validate_file_path(destination)?;
        if destination.exists() {
            return Err(JournalError::DestinationExists);
        }
        let temporary = reserve_temporary(destination)?;

        let result = (|| {
            self.lock()?.backup(MAIN_DB, &temporary, None)?;
            let backup = Connection::open(&temporary)?;
            validate_database(&backup)?;
            drop(backup);
            publish_without_overwrite(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    /// Restore an integrity-checked backup into a new destination. Existing databases are never
    /// replaced implicitly.
    pub fn restore(
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> Result<Self, JournalError> {
        let source = source.as_ref();
        let destination = destination.as_ref();
        validate_file_path(source)?;
        validate_file_path(destination)?;
        if destination.exists() {
            return Err(JournalError::DestinationExists);
        }
        let source_connection =
            Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        validate_restore_source(&source_connection)?;

        let temporary = reserve_temporary(destination)?;
        let result = (|| {
            source_connection.backup(MAIN_DB, &temporary, None)?;
            let mut restored = Connection::open(&temporary)?;
            configure_connection(&restored)?;
            migrate(&mut restored)?;
            validate_database(&restored)?;
            drop(restored);
            publish_without_overwrite(&temporary, destination)?;
            Self::open(destination)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, JournalError> {
        self.connection
            .lock()
            .map_err(|_| JournalError::LockUnavailable)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), JournalError> {
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    let _: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), JournalError> {
    let raw_version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let version = u32::try_from(raw_version).map_err(|_| JournalError::IncompatibleSchema {
        found: u32::MAX,
        supported: SCHEMA_VERSION,
    })?;
    match version {
        0 => migrate_from_empty(connection),
        1 => migrate_v1_to_v2(connection),
        SCHEMA_VERSION => Ok(()),
        found => Err(JournalError::IncompatibleSchema {
            found,
            supported: SCHEMA_VERSION,
        }),
    }
}

fn migrate_from_empty(connection: &mut Connection) -> Result<(), JournalError> {
    let existing: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if existing != 0 {
        return Err(JournalError::IncompatibleSchema {
            found: 0,
            supported: SCHEMA_VERSION,
        });
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE journal_scope (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            mint_url TEXT NOT NULL,
            unit TEXT NOT NULL,
            unit_scale TEXT NOT NULL,
            network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet')),
            asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native', 'udt')),
            asset_code_hash TEXT,
            asset_hash_type TEXT,
            asset_args TEXT
        ) STRICT;

        CREATE TABLE settlement_operations (
            record_version INTEGER NOT NULL CHECK (record_version = 1),
            direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
            quote_id TEXT NOT NULL,
            payment_hash TEXT NOT NULL,
            invoice TEXT NOT NULL,
            principal_base TEXT NOT NULL,
            mint_url TEXT NOT NULL,
            unit TEXT NOT NULL,
            unit_scale TEXT NOT NULL,
            network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet')),
            asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native', 'udt')),
            asset_code_hash TEXT,
            asset_hash_type TEXT,
            asset_args TEXT,
            fee_ceiling_base TEXT,
            actual_fee_base TEXT,
            observed_state TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            event_state TEXT NOT NULL CHECK (
                event_state IN ('not_applicable', 'pending', 'delivered')
            ),
            deadline_unix INTEGER,
            reconciliation_count INTEGER NOT NULL CHECK (reconciliation_count >= 0),
            dispatch_count INTEGER NOT NULL CHECK (dispatch_count >= 0),
            last_reconciled_at INTEGER,
            next_reconcile_at INTEGER NOT NULL,
            last_error_class TEXT,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            terminal_at INTEGER,
            PRIMARY KEY (direction, quote_id),
            UNIQUE (direction, payment_hash)
        ) STRICT;

        CREATE INDEX settlement_recovery_order
            ON settlement_operations (terminal_at, next_reconcile_at, created_at);
        PRAGMA user_version = 2;",
    )?;
    transaction.commit()?;
    Ok(())
}

fn migrate_v1_to_v2(connection: &mut Connection) -> Result<(), JournalError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let invalid_outgoing: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM settlement_operations
         WHERE direction = 'outgoing'
           AND (
               event_state != 'not_applicable'
               OR (observed_state IN ('outgoing_succeeded', 'outgoing_failed')
                   AND terminal_at IS NULL)
               OR (observed_state NOT IN ('outgoing_succeeded', 'outgoing_failed')
                   AND terminal_at IS NOT NULL)
           )",
        [],
        |row| row.get(0),
    )?;
    if invalid_outgoing != 0 {
        return Err(JournalError::CorruptRecord {
            field: "v1 outgoing terminal state",
        });
    }
    transaction.execute(
        "UPDATE settlement_operations
         SET event_state = 'pending'
         WHERE direction = 'outgoing'
           AND dispatch_count > 0
           AND terminal_at IS NULL
           AND event_state = 'not_applicable'",
        [],
    )?;
    transaction.pragma_update(None, "user_version", 2)?;
    validate_semantic_content(&transaction)?;
    transaction.commit()?;
    Ok(())
}

fn validate_restore_source(connection: &Connection) -> Result<(), JournalError> {
    let raw_version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let version = u32::try_from(raw_version).map_err(|_| JournalError::IncompatibleSchema {
        found: u32::MAX,
        supported: SCHEMA_VERSION,
    })?;
    if !(1..=SCHEMA_VERSION).contains(&version) {
        return Err(JournalError::IncompatibleSchema {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(JournalError::CorruptRecord { field: "database" });
    }
    connection.prepare("SELECT singleton, mint_url, unit FROM journal_scope LIMIT 0")?;
    let sql = format!("SELECT {RECORD_COLUMNS} FROM settlement_operations LIMIT 0");
    connection.prepare(&sql)?;
    Ok(())
}

fn validate_database(connection: &Connection) -> Result<(), JournalError> {
    let raw_version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let version = u32::try_from(raw_version).map_err(|_| JournalError::IncompatibleSchema {
        found: u32::MAX,
        supported: SCHEMA_VERSION,
    })?;
    if version != SCHEMA_VERSION {
        return Err(JournalError::IncompatibleSchema {
            found: version,
            supported: SCHEMA_VERSION,
        });
    }
    let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(JournalError::CorruptRecord { field: "database" });
    }
    connection.prepare("SELECT singleton, mint_url, unit FROM journal_scope LIMIT 0")?;
    let sql = format!("SELECT {RECORD_COLUMNS} FROM settlement_operations LIMIT 0");
    connection.prepare(&sql)?;
    validate_semantic_content(connection)?;
    Ok(())
}

fn validate_semantic_content(connection: &Connection) -> Result<(), JournalError> {
    let scope_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM journal_scope", [], |row| row.get(0))?;
    let bound_scope = read_scope(connection)?;
    if scope_count > 1 || (scope_count == 1 && bound_scope.is_none()) {
        return Err(JournalError::CorruptRecord { field: "scope" });
    }
    let sql = format!("SELECT {RECORD_COLUMNS} FROM settlement_operations");
    let mut statement = connection.prepare(&sql)?;
    let raw_records = statement
        .query_map([], raw_record_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    if !raw_records.is_empty() && bound_scope.is_none() {
        return Err(JournalError::ScopeMismatch);
    }
    let mut quote_ids = HashSet::with_capacity(raw_records.len());
    let mut payment_hashes = HashSet::with_capacity(raw_records.len());
    for raw in raw_records {
        let operation = decode_record(raw)?;
        if bound_scope.as_ref() != Some(operation.scope()) {
            return Err(JournalError::ScopeMismatch);
        }
        if !quote_ids.insert((
            operation.direction().as_str(),
            operation.quote_id().to_string(),
        )) || !payment_hashes.insert((
            operation.direction().as_str(),
            operation.payment_hash().to_string(),
        )) {
            return Err(JournalError::CorruptRecord {
                field: "operation identity",
            });
        }
    }
    Ok(())
}

fn validate_scope(scope: &JournalScope) -> Result<(), JournalError> {
    let mint_url = reqwest::Url::parse(&scope.mint_url)
        .map_err(|_| JournalError::InvalidOperation("mint URL"))?;
    if scope.mint_url.trim() != scope.mint_url
        || !matches!(mint_url.scheme(), "https" | "http")
        || mint_url.host_str().is_none()
        || !mint_url.username().is_empty()
        || mint_url.password().is_some()
        || scope.mint_url.ends_with('/')
        || mint_url.query().is_some()
        || mint_url.fragment().is_some()
    {
        return Err(JournalError::InvalidOperation("mint URL"));
    }
    if scope.unit.is_empty()
        || scope.unit.trim() != scope.unit
        || scope.unit != scope.unit.to_lowercase()
    {
        return Err(JournalError::InvalidOperation("unit"));
    }
    if scope.unit_scale == 0 {
        return Err(JournalError::InvalidOperation("unit scale"));
    }
    validate_asset(&scope.asset)
}

fn validate_asset(asset: &SettlementAsset) -> Result<(), JournalError> {
    let SettlementAsset::Udt(script) = asset else {
        return Ok(());
    };
    canonical_hash(&script.code_hash)
        .map_err(|_| JournalError::InvalidOperation("asset code hash"))?;
    if !matches!(
        script.hash_type.as_str(),
        "type" | "data" | "data1" | "data2"
    ) {
        return Err(JournalError::InvalidOperation("asset hash type"));
    }
    let args = script
        .args
        .strip_prefix("0x")
        .ok_or(JournalError::InvalidOperation("asset args"))?;
    if args.len() % 2 != 0 || !args.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(JournalError::InvalidOperation("asset args"));
    }
    Ok(())
}

fn validate_record(record: &SettlementOperation, decoded: bool) -> Result<(), JournalError> {
    let invalid = |field| {
        if decoded {
            JournalError::CorruptRecord { field }
        } else {
            JournalError::InvalidOperation(field)
        }
    };
    if record.record_version != RECORD_VERSION {
        return Err(invalid("record_version"));
    }
    validate_scope(&record.scope).map_err(|_| invalid("scope"))?;
    if record.quote_id.is_empty() || record.quote_id.len() > 512 {
        return Err(invalid("quote_id"));
    }
    if record.quote_id.parse::<cdk_common::QuoteId>().is_err() {
        return Err(invalid("quote_id"));
    }
    if canonical_hash(&record.payment_hash).map_err(|_| invalid("payment_hash"))?
        != record.payment_hash
    {
        return Err(invalid("payment_hash"));
    }
    if record.invoice.is_empty() || record.invoice.len() > 16_384 {
        return Err(invalid("invoice"));
    }
    if record.observed_state.direction() != record.direction {
        return Err(invalid("observed_state"));
    }
    if record.attempt_id.is_empty() || record.attempt_id.len() > 1_200 {
        return Err(invalid("attempt_id"));
    }
    let expected_attempt = format!(
        "{}:{}:{}",
        record.direction.as_str(),
        record.quote_id,
        record.payment_hash
    );
    if record.attempt_id != expected_attempt {
        return Err(invalid("attempt_id"));
    }
    if record.direction == SettlementDirection::Incoming
        && record.event_state == EventState::NotApplicable
    {
        return Err(invalid("event_state"));
    }
    if record.direction == SettlementDirection::Outgoing {
        let terminal_state = matches!(
            record.observed_state,
            ObservedState::OutgoingSucceeded | ObservedState::OutgoingFailed
        );
        let valid_event_state = match record.event_state {
            EventState::NotApplicable => {
                record.dispatch_count == 0 || (terminal_state && record.terminal_at.is_some())
            }
            EventState::Pending => record.dispatch_count > 0,
            EventState::Delivered => record.dispatch_count > 0 && terminal_state,
        };
        if !valid_event_state {
            return Err(invalid("event_state"));
        }
    }
    if record.direction == SettlementDirection::Incoming && record.fee_ceiling_base.is_some() {
        return Err(invalid("fee_ceiling_base"));
    }
    if record.direction == SettlementDirection::Incoming
        && (record.deadline_unix.is_none() || record.dispatch_count != 0)
    {
        return Err(invalid("incoming recovery metadata"));
    }
    if record.direction == SettlementDirection::Outgoing
        && ((record.dispatch_count > 1)
            || (record.dispatch_count > 0 && record.deadline_unix.is_none())
            || (record.observed_state == ObservedState::OutgoingDispatchPrepared
                && record.dispatch_count == 0))
    {
        return Err(invalid("outgoing recovery metadata"));
    }
    if (record.reconciliation_count == 0) != record.last_reconciled_at.is_none()
        || (record.last_error_class.is_some() && record.last_reconciled_at.is_none())
    {
        return Err(invalid("reconciliation metadata"));
    }
    let event_revision = u64::from(record.event_state == EventState::Delivered);
    if record.revision
        != record
            .reconciliation_count
            .saturating_add(record.dispatch_count)
            .saturating_add(event_revision)
    {
        return Err(invalid("revision"));
    }
    if (record.observed_state == ObservedState::OutgoingSucceeded)
        != record.actual_fee_base.is_some()
    {
        return Err(invalid("actual_fee_base"));
    }
    if record
        .actual_fee_base
        .zip(record.fee_ceiling_base)
        .is_some_and(|(actual, ceiling)| actual > ceiling)
    {
        return Err(invalid("actual_fee_base"));
    }
    let delivered_state_is_valid = match record.direction {
        SettlementDirection::Incoming => record.observed_state == ObservedState::IncomingPaid,
        SettlementDirection::Outgoing => matches!(
            record.observed_state,
            ObservedState::OutgoingSucceeded | ObservedState::OutgoingFailed
        ),
    };
    if record.event_state == EventState::Delivered && !delivered_state_is_valid {
        return Err(invalid("event_state"));
    }
    if record.updated_at < record.created_at
        || record
            .last_reconciled_at
            .is_some_and(|value| value > record.updated_at)
        || record
            .terminal_at
            .is_some_and(|value| value < record.created_at || value > record.updated_at)
    {
        return Err(invalid("timestamps"));
    }
    let expected_terminal =
        is_terminal(record.direction, record.observed_state, record.event_state);
    if expected_terminal != record.terminal_at.is_some() {
        return Err(invalid("terminal_at"));
    }
    Ok(())
}

fn read_scope(connection: &Connection) -> Result<Option<JournalScope>, JournalError> {
    let raw = connection
        .query_row(
            "SELECT mint_url, unit, unit_scale, network, asset_kind,
                    asset_code_hash, asset_hash_type, asset_args
             FROM journal_scope WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .optional()?;
    raw.map(
        |(mint_url, unit, scale, network, kind, code_hash, hash_type, args)| {
            let scope = JournalScope {
                mint_url,
                unit,
                unit_scale: parse_decimal(&scale, "unit_scale")?,
                network: parse_network(&network)?,
                asset: decode_asset(&kind, code_hash, hash_type, args)?,
            };
            validate_scope(&scope).map_err(|_| JournalError::CorruptRecord { field: "scope" })?;
            Ok(scope)
        },
    )
    .transpose()
}

fn query_by_quote(
    connection: &Connection,
    direction: SettlementDirection,
    quote_id: &str,
) -> Result<Option<SettlementOperation>, JournalError> {
    let sql = format!(
        "SELECT {RECORD_COLUMNS} FROM settlement_operations
         WHERE direction = ?1 AND quote_id = ?2"
    );
    let operation = connection
        .query_row(
            &sql,
            params![direction.as_str(), quote_id],
            raw_record_from_row,
        )
        .optional()?
        .map(decode_record)
        .transpose()?;
    ensure_operation_scope(connection, operation.as_ref())?;
    Ok(operation)
}

fn query_by_hash(
    connection: &Connection,
    direction: SettlementDirection,
    payment_hash: &str,
) -> Result<Option<SettlementOperation>, JournalError> {
    let sql = format!(
        "SELECT {RECORD_COLUMNS} FROM settlement_operations
         WHERE direction = ?1 AND payment_hash = ?2"
    );
    let operation = connection
        .query_row(
            &sql,
            params![direction.as_str(), payment_hash],
            raw_record_from_row,
        )
        .optional()?
        .map(decode_record)
        .transpose()?;
    ensure_operation_scope(connection, operation.as_ref())?;
    Ok(operation)
}

fn ensure_operation_scope(
    connection: &Connection,
    operation: Option<&SettlementOperation>,
) -> Result<(), JournalError> {
    let Some(operation) = operation else {
        return Ok(());
    };
    if read_scope(connection)?.as_ref() == Some(operation.scope()) {
        Ok(())
    } else {
        Err(JournalError::ScopeMismatch)
    }
}

fn insert_record(
    connection: &Connection,
    record: &SettlementOperation,
) -> Result<(), JournalError> {
    let (asset_kind, code_hash, hash_type, args) = asset_columns(&record.scope.asset);
    connection.execute(
        "INSERT INTO settlement_operations (
            record_version, direction, quote_id, payment_hash, invoice, principal_base,
            mint_url, unit, unit_scale, network, asset_kind, asset_code_hash, asset_hash_type,
            asset_args, fee_ceiling_base, actual_fee_base, observed_state, attempt_id,
            event_state, deadline_unix, reconciliation_count, dispatch_count,
            last_reconciled_at, next_reconcile_at, last_error_class, revision,
            created_at, updated_at, terminal_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
            ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
         )",
        params![
            i64::from(record.record_version),
            record.direction.as_str(),
            record.quote_id,
            record.payment_hash,
            record.invoice,
            record.principal_base.to_string(),
            record.scope.mint_url,
            record.scope.unit,
            record.scope.unit_scale.to_string(),
            network_to_str(record.scope.network),
            asset_kind,
            code_hash,
            hash_type,
            args,
            record.fee_ceiling_base.map(|value| value.to_string()),
            record.actual_fee_base.map(|value| value.to_string()),
            record.observed_state.as_str(),
            record.attempt_id,
            record.event_state.as_str(),
            record
                .deadline_unix
                .map(|value| to_i64(value, "deadline_unix"))
                .transpose()?,
            to_i64(record.reconciliation_count, "reconciliation_count")?,
            to_i64(record.dispatch_count, "dispatch_count")?,
            record
                .last_reconciled_at
                .map(|value| to_i64(value, "last_reconciled_at"))
                .transpose()?,
            to_i64(record.next_reconcile_at, "next_reconcile_at")?,
            record.last_error_class.map(|value| value.as_str()),
            to_i64(record.revision, "revision")?,
            to_i64(record.created_at, "created_at")?,
            to_i64(record.updated_at, "updated_at")?,
            record
                .terminal_at
                .map(|value| to_i64(value, "terminal_at"))
                .transpose()?,
        ],
    )?;
    Ok(())
}

#[derive(Debug)]
struct RawRecord {
    record_version: i64,
    direction: String,
    quote_id: String,
    payment_hash: String,
    invoice: String,
    principal_base: String,
    mint_url: String,
    unit: String,
    unit_scale: String,
    network: String,
    asset_kind: String,
    asset_code_hash: Option<String>,
    asset_hash_type: Option<String>,
    asset_args: Option<String>,
    fee_ceiling_base: Option<String>,
    actual_fee_base: Option<String>,
    observed_state: String,
    attempt_id: String,
    event_state: String,
    deadline_unix: Option<i64>,
    reconciliation_count: i64,
    dispatch_count: i64,
    last_reconciled_at: Option<i64>,
    next_reconcile_at: i64,
    last_error_class: Option<String>,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    terminal_at: Option<i64>,
}

fn raw_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRecord> {
    Ok(RawRecord {
        record_version: row.get(0)?,
        direction: row.get(1)?,
        quote_id: row.get(2)?,
        payment_hash: row.get(3)?,
        invoice: row.get(4)?,
        principal_base: row.get(5)?,
        mint_url: row.get(6)?,
        unit: row.get(7)?,
        unit_scale: row.get(8)?,
        network: row.get(9)?,
        asset_kind: row.get(10)?,
        asset_code_hash: row.get(11)?,
        asset_hash_type: row.get(12)?,
        asset_args: row.get(13)?,
        fee_ceiling_base: row.get(14)?,
        actual_fee_base: row.get(15)?,
        observed_state: row.get(16)?,
        attempt_id: row.get(17)?,
        event_state: row.get(18)?,
        deadline_unix: row.get(19)?,
        reconciliation_count: row.get(20)?,
        dispatch_count: row.get(21)?,
        last_reconciled_at: row.get(22)?,
        next_reconcile_at: row.get(23)?,
        last_error_class: row.get(24)?,
        revision: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        terminal_at: row.get(28)?,
    })
}

fn decode_record(raw: RawRecord) -> Result<SettlementOperation, JournalError> {
    let record = SettlementOperation {
        record_version: from_i64(raw.record_version, "record_version")?,
        direction: SettlementDirection::parse(&raw.direction)?,
        quote_id: raw.quote_id,
        payment_hash: raw.payment_hash,
        invoice: raw.invoice,
        principal_base: parse_decimal(&raw.principal_base, "principal_base")?,
        scope: JournalScope {
            mint_url: raw.mint_url,
            unit: raw.unit,
            unit_scale: parse_decimal(&raw.unit_scale, "unit_scale")?,
            network: parse_network(&raw.network)?,
            asset: decode_asset(
                &raw.asset_kind,
                raw.asset_code_hash,
                raw.asset_hash_type,
                raw.asset_args,
            )?,
        },
        fee_ceiling_base: raw
            .fee_ceiling_base
            .map(|value| parse_decimal(&value, "fee_ceiling_base"))
            .transpose()?,
        actual_fee_base: raw
            .actual_fee_base
            .map(|value| parse_decimal(&value, "actual_fee_base"))
            .transpose()?,
        observed_state: ObservedState::parse(&raw.observed_state)?,
        attempt_id: raw.attempt_id,
        event_state: EventState::parse(&raw.event_state)?,
        deadline_unix: raw
            .deadline_unix
            .map(|value| from_i64(value, "deadline_unix"))
            .transpose()?,
        reconciliation_count: from_i64(raw.reconciliation_count, "reconciliation_count")?,
        dispatch_count: from_i64(raw.dispatch_count, "dispatch_count")?,
        last_reconciled_at: raw
            .last_reconciled_at
            .map(|value| from_i64(value, "last_reconciled_at"))
            .transpose()?,
        next_reconcile_at: from_i64(raw.next_reconcile_at, "next_reconcile_at")?,
        last_error_class: raw
            .last_error_class
            .map(|value| ReconciliationErrorClass::parse(&value))
            .transpose()?,
        revision: from_i64(raw.revision, "revision")?,
        created_at: from_i64(raw.created_at, "created_at")?,
        updated_at: from_i64(raw.updated_at, "updated_at")?,
        terminal_at: raw
            .terminal_at
            .map(|value| from_i64(value, "terminal_at"))
            .transpose()?,
    };
    validate_record(&record, true)?;
    Ok(record)
}

fn same_insert_identity(existing: &SettlementOperation, proposed: &SettlementOperation) -> bool {
    existing.record_version == proposed.record_version
        && existing.direction == proposed.direction
        && existing.quote_id == proposed.quote_id
        && existing.payment_hash == proposed.payment_hash
        && existing.invoice == proposed.invoice
        && existing.principal_base == proposed.principal_base
        && existing.scope == proposed.scope
        && existing.fee_ceiling_base == proposed.fee_ceiling_base
        && existing.attempt_id == proposed.attempt_id
        && (existing.direction == SettlementDirection::Outgoing
            || existing.deadline_unix == proposed.deadline_unix)
}

fn require_revision(
    operation: &SettlementOperation,
    expected_revision: u64,
) -> Result<(), JournalError> {
    if operation.revision == expected_revision {
        Ok(())
    } else {
        Err(JournalError::ConcurrentUpdate)
    }
}

fn terminal_at(
    direction: SettlementDirection,
    state: ObservedState,
    event_state: EventState,
    now_unix: u64,
) -> Option<u64> {
    is_terminal(direction, state, event_state).then_some(now_unix)
}

fn is_terminal(
    direction: SettlementDirection,
    state: ObservedState,
    event_state: EventState,
) -> bool {
    match direction {
        SettlementDirection::Incoming => match state {
            ObservedState::IncomingPaid => event_state == EventState::Delivered,
            ObservedState::IncomingCancelled | ObservedState::IncomingExpired => true,
            _ => false,
        },
        SettlementDirection::Outgoing => {
            matches!(
                state,
                ObservedState::OutgoingSucceeded | ObservedState::OutgoingFailed
            ) && matches!(
                event_state,
                EventState::NotApplicable | EventState::Delivered
            )
        }
    }
}

fn parse_decimal<T>(raw: &str, field: &'static str) -> Result<T, JournalError>
where
    T: std::str::FromStr + ToString,
{
    let value = raw
        .parse::<T>()
        .map_err(|_| JournalError::CorruptRecord { field })?;
    if value.to_string() != raw {
        return Err(JournalError::CorruptRecord { field });
    }
    Ok(value)
}

fn to_i64(value: u64, field: &'static str) -> Result<i64, JournalError> {
    i64::try_from(value).map_err(|_| JournalError::InvalidOperation(field))
}

fn from_i64<T>(value: i64, field: &'static str) -> Result<T, JournalError>
where
    T: TryFrom<u64>,
{
    let unsigned = u64::try_from(value).map_err(|_| JournalError::CorruptRecord { field })?;
    T::try_from(unsigned).map_err(|_| JournalError::CorruptRecord { field })
}

fn canonical_hash(raw: &str) -> Result<String, crate::Error> {
    wire::hash_from_hex(raw).map(|bytes| wire::hash_to_hex(&bytes))
}

fn network_to_str(network: Currency) -> &'static str {
    match network {
        Currency::Fibb => "mainnet",
        Currency::Fibt => "testnet",
        Currency::Fibd => "devnet",
    }
}

fn parse_network(raw: &str) -> Result<Currency, JournalError> {
    match raw {
        "mainnet" => Ok(Currency::Fibb),
        "testnet" => Ok(Currency::Fibt),
        "devnet" => Ok(Currency::Fibd),
        _ => Err(JournalError::CorruptRecord { field: "network" }),
    }
}

type AssetColumns<'a> = (
    &'static str,
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
);

fn asset_columns(asset: &SettlementAsset) -> AssetColumns<'_> {
    match asset {
        SettlementAsset::Native => ("native", None, None, None),
        SettlementAsset::Udt(script) => (
            "udt",
            Some(script.code_hash.as_str()),
            Some(script.hash_type.as_str()),
            Some(script.args.as_str()),
        ),
    }
}

fn decode_asset(
    kind: &str,
    code_hash: Option<String>,
    hash_type: Option<String>,
    args: Option<String>,
) -> Result<SettlementAsset, JournalError> {
    match (kind, code_hash, hash_type, args) {
        ("native", None, None, None) => Ok(SettlementAsset::Native),
        ("udt", Some(code_hash), Some(hash_type), Some(args)) => {
            let asset = SettlementAsset::Udt(Script {
                code_hash,
                hash_type,
                args,
            });
            validate_asset(&asset).map_err(|_| JournalError::CorruptRecord { field: "asset" })?;
            Ok(asset)
        }
        _ => Err(JournalError::CorruptRecord { field: "asset" }),
    }
}

fn temporary_destination(destination: &Path, sequence: u64) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(format!(".partial-{}-{sequence}", std::process::id()));
    PathBuf::from(name)
}

fn validate_file_path(path: &Path) -> Result<(), JournalError> {
    let rendered = path.to_string_lossy();
    if path.as_os_str().is_empty() || rendered == ":memory:" || rendered.starts_with("file:") {
        return Err(JournalError::InvalidOperation("journal path"));
    }
    Ok(())
}

fn reserve_temporary(destination: &Path) -> Result<PathBuf, JournalError> {
    loop {
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = temporary_destination(destination, sequence);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => {
                drop(file);
                return Ok(temporary);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(JournalError::Io(error)),
        }
    }
}

fn publish_without_overwrite(temporary: &Path, destination: &Path) -> Result<(), JournalError> {
    match std::fs::hard_link(temporary, destination) {
        Ok(()) => {
            std::fs::remove_file(temporary)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(JournalError::DestinationExists)
        }
        Err(error) => Err(JournalError::Io(error)),
    }
}
