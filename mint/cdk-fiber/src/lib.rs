//! A [Fiber Network](https://github.com/nervosnetwork/fiber) payment backend for the
//! [Cashu Development Kit](https://github.com/cashubtc/cdk).
//!
//! `cdk-fiber` implements cdk's [`MintPayment`] trait against a Fiber node's JSON-RPC API, so a
//! stock `cdk-mintd` can run a Cashu mint that settles over Fiber payment channels. Because Fiber
//! channels can be funded with a UDT, the mint can issue ecash denominated in a stablecoin —
//! fibernuts ships RUSD by default.
//!
//! # Wiring
//!
//! The backend reaches `cdk-mintd` as an out-of-process gRPC payment processor. Two facts about
//! that bridge shape this crate's API:
//!
//! - The `method` field of the `Custom` payment options is **not carried across the gRPC wire**.
//!   `cdk-payment-processor` reconstructs it as an empty string, so this backend never inspects
//!   it and serves exactly one method: [`METHOD`].
//! - The unit *is* carried, and `cdk-mintd` refuses to start unless the unit it is configured
//!   with matches the one [`MintPayment::get_settings`] reports.
//!
//! # Settlement semantics
//!
//! Two invariants keep the mint solvent, both dictated by how Fiber behaves:
//!
//! - Incoming invoices are **standard**, never hold invoices, and only [`CkbInvoiceStatus::Paid`]
//!   credits a wallet. An invoice sitting in `Received` has an unsettled TLC against it.
//! - An outgoing payment that has not reached a terminal state is reported as
//!   `MeltQuoteState::Pending`, never `Failed`. Reporting `Failed` would return the wallet's
//!   proofs while the TLC may still settle, letting it spend the same money twice.

#![warn(missing_docs)]

use std::collections::HashSet;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use cdk_common::nuts::MeltQuoteState;
use cdk_common::payment::{
    self, CreateIncomingPaymentResponse, CustomOutgoingPaymentOptions, Event,
    IncomingPaymentOptions, MakePaymentResponse, MintPayment, OutgoingPaymentOptions,
    PaymentIdentifier, PaymentQuoteResponse, SettingsResponse, WaitPaymentResponse,
};
use cdk_common::{Amount, CurrencyUnit};
use futures::stream::StreamExt;
use futures::Stream;
use tokio::sync::{mpsc, Mutex};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

pub mod amount;
pub mod config;
pub mod error;
pub mod journal;
pub mod rpc;
pub mod wire;

pub use config::FiberConfig;
pub use error::Error;
pub use journal::SettlementJournal;
pub use rpc::{FiberRpc, HttpFiberRpc};
pub use wire::CkbInvoiceStatus;

use journal::{
    JournalError, JournalScope, NewSettlementOperation, ObservedState, ReconciliationErrorClass,
    ReconciliationObservation, SettlementAsset, SettlementDirection, SettlementOperation,
};
use wire::{NewInvoiceParams, PaymentStatus, SendPaymentParams};

/// The single Cashu payment method this backend serves.
pub const METHOD: &str = "fiber";

/// Buffered payment events. Matches the depth cdk's own backends use.
const EVENT_BUFFER: usize = 8;

struct Inner {
    rpc: Arc<dyn FiberRpc>,
    config: FiberConfig,
    scope: JournalScope,
    journal: Arc<SettlementJournal>,
    events: mpsc::Sender<Event>,
    receiver: Mutex<Option<mpsc::Receiver<Event>>>,
    watching: Mutex<HashSet<String>>,
    cancel: CancellationToken,
    stream_active: AtomicBool,
}

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inner")
            .field("rpc", &self.rpc)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

/// Clears the stream-active flag whenever the handed-out stream is dropped.
struct ActiveGuard(Arc<Inner>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.stream_active.store(false, Ordering::SeqCst);
    }
}

/// A cdk payment backend that settles over a Fiber node.
#[derive(Debug, Clone)]
pub struct FiberBackend {
    inner: Arc<Inner>,
}

impl FiberBackend {
    /// Build a backend over any [`FiberRpc`] transport and durable settlement journal.
    pub fn new(
        rpc: Arc<dyn FiberRpc>,
        config: FiberConfig,
        journal: Arc<SettlementJournal>,
    ) -> Result<Self, Error> {
        let scope = JournalScope::new(
            config.mint_url.clone(),
            config.unit.to_string(),
            config.unit_scale,
            config.currency,
            SettlementAsset::from(config.udt_type_script.clone()),
        );
        journal.bind_scope(&scope)?;
        let (events, receiver) = mpsc::channel(EVENT_BUFFER);
        Ok(Self {
            inner: Arc::new(Inner {
                rpc,
                config,
                scope,
                journal,
                events,
                receiver: Mutex::new(Some(receiver)),
                watching: Mutex::new(HashSet::new()),
                cancel: CancellationToken::new(),
                stream_active: AtomicBool::new(false),
            }),
        })
    }

    /// Build a backend that talks JSON-RPC to a node over HTTP.
    pub fn http(
        rpc_url: impl Into<String>,
        config: FiberConfig,
        journal: Arc<SettlementJournal>,
    ) -> Result<Self, Error> {
        Self::new(Arc::new(HttpFiberRpc::new(rpc_url)), config, journal)
    }

    /// The unit this backend settles in.
    pub fn unit(&self) -> &CurrencyUnit {
        &self.inner.config.unit
    }

    fn ensure_unit(&self, requested: &CurrencyUnit) -> Result<(), Error> {
        // Match CDK 0.18's normalized wire/config representation even when a caller manually
        // constructs a `Custom` variant instead of using `CurrencyUnit::custom`.
        let configured = self.inner.config.unit.to_string();
        if requested.to_string() == configured {
            return Ok(());
        }
        Err(Error::UnitMismatch {
            configured,
            requested: requested.to_string(),
        })
    }

    fn ecash(&self, value: u64) -> Amount<CurrencyUnit> {
        Amount::new(value, self.inner.config.unit.clone())
    }

    fn zero(&self) -> Amount<CurrencyUnit> {
        self.ecash(0)
    }

    fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }

    fn next_reconcile_at(&self, now: u64) -> u64 {
        now.saturating_add(self.inner.config.poll_interval.as_secs().max(1))
    }

    /// Resolve the invoice a melt refers to into its payment hash and amount.
    async fn resolve_invoice(&self, invoice: &str) -> Result<([u8; 32], String, u128), Error> {
        let parsed = self.inner.rpc.parse_invoice(invoice).await?;
        let hash_hex = parsed.invoice.data.payment_hash.clone();
        self.validate_invoice(&hash_hex, &parsed.invoice, None)?;
        let hash = wire::hash_from_hex(&hash_hex)?;
        let hash_hex = wire::hash_to_hex(&hash);
        let amount = parsed.invoice.amount.ok_or(Error::AmountlessInvoice)?;
        Ok((hash, hash_hex, amount))
    }

    fn validate_invoice(
        &self,
        expected_hash: &str,
        invoice: &wire::CkbInvoice,
        expected_amount: Option<u128>,
    ) -> Result<(), Error> {
        let config = &self.inner.config;
        if invoice.currency != config.currency {
            return Err(Error::InvoiceNetworkMismatch {
                configured: format!("{:?}", config.currency),
                invoice: format!("{:?}", invoice.currency),
            });
        }
        let invoice_asset = invoice.data.udt_type_script()?;
        let asset_matches = match (&invoice_asset, &config.udt_type_script) {
            (None, None) => true,
            (Some(invoice), Some(configured)) => {
                invoice
                    .code_hash
                    .eq_ignore_ascii_case(&configured.code_hash)
                    && invoice
                        .hash_type
                        .eq_ignore_ascii_case(&configured.hash_type)
                    && invoice.args.eq_ignore_ascii_case(&configured.args)
            }
            _ => false,
        };
        if !asset_matches {
            return Err(Error::InvoiceAssetMismatch);
        }
        let expected = wire::hash_to_hex(&wire::hash_from_hex(expected_hash)?);
        let actual = wire::hash_to_hex(&wire::hash_from_hex(&invoice.data.payment_hash)?);
        if actual != expected {
            return Err(Error::Journal(JournalError::Conflict));
        }
        if let Some(expected_amount) = expected_amount {
            if invoice.amount != Some(expected_amount) {
                return Err(Error::Journal(JournalError::Conflict));
            }
        }
        Ok(())
    }

    fn validate_operation_identity(
        &self,
        operation: &SettlementOperation,
        invoice: &str,
        payment_hash: &str,
        principal_base: u128,
        fee_ceiling_base: Option<u128>,
    ) -> Result<(), Error> {
        if operation.scope() != &self.inner.scope
            || operation.invoice() != invoice
            || operation.payment_hash() != payment_hash
            || operation.principal_base() != principal_base
            || operation.fee_ceiling_base() != fee_ceiling_base
        {
            return Err(JournalError::Conflict.into());
        }
        Ok(())
    }

    fn observe(
        &self,
        operation: &SettlementOperation,
        state: ObservedState,
        actual_fee_base: Option<u128>,
        now: u64,
    ) -> Result<SettlementOperation, Error> {
        Ok(self.inner.journal.record_observation(
            operation.direction(),
            operation.quote_id(),
            ReconciliationObservation {
                expected_revision: operation.revision(),
                state,
                actual_fee_base,
                checked_at: now,
                next_reconcile_at: self.next_reconcile_at(now),
                deadline_unix: None,
            },
        )?)
    }

    fn observe_by_hash(
        &self,
        direction: SettlementDirection,
        payment_hash: &str,
        state: ObservedState,
        actual_fee_base: Option<u128>,
        now: u64,
    ) -> Result<Option<SettlementOperation>, Error> {
        for _ in 0..3 {
            let Some(operation) = self
                .inner
                .journal
                .by_payment_hash(direction, payment_hash)?
            else {
                return Ok(None);
            };
            match self.observe(&operation, state, actual_fee_base, now) {
                Ok(updated) => return Ok(Some(updated)),
                Err(Error::Journal(JournalError::ConcurrentUpdate)) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(JournalError::ConcurrentUpdate.into())
    }

    fn record_rpc_error(
        &self,
        operation: &SettlementOperation,
        error: &Error,
        now: u64,
    ) -> Result<(), Error> {
        let class = match error {
            Error::Transport(_) => ReconciliationErrorClass::RpcUnavailable,
            Error::Decode(_) | Error::InvalidHash(_) => ReconciliationErrorClass::InvalidResponse,
            _ => ReconciliationErrorClass::NodeRejected,
        };
        self.inner.journal.record_reconciliation_error(
            operation.direction(),
            operation.quote_id(),
            operation.revision(),
            class,
            now,
            self.next_reconcile_at(now),
        )?;
        Ok(())
    }

    fn incoming_state(status: CkbInvoiceStatus) -> ObservedState {
        match status {
            CkbInvoiceStatus::Open => ObservedState::IncomingOpen,
            CkbInvoiceStatus::Received => ObservedState::IncomingReceived,
            CkbInvoiceStatus::Paid => ObservedState::IncomingPaid,
            CkbInvoiceStatus::Cancelled => ObservedState::IncomingCancelled,
            CkbInvoiceStatus::Expired => ObservedState::IncomingExpired,
        }
    }

    fn outgoing_state(status: PaymentStatus) -> ObservedState {
        match status {
            PaymentStatus::Created => ObservedState::OutgoingCreated,
            PaymentStatus::Inflight => ObservedState::OutgoingInflight,
            PaymentStatus::Success => ObservedState::OutgoingSucceeded,
            PaymentStatus::Failed => ObservedState::OutgoingFailed,
        }
    }

    /// Poll the node until an outgoing payment reaches a terminal state or the deadline passes.
    async fn await_settlement(
        &self,
        hash_hex: &str,
        initial: wire::PaymentResult,
        timeout: Duration,
    ) -> Result<wire::PaymentResult, Error> {
        if matches!(
            initial.status,
            PaymentStatus::Success | PaymentStatus::Failed
        ) {
            return Ok(initial);
        }

        let deadline = tokio::time::Instant::now() + timeout;
        let mut latest = initial;
        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(self.inner.config.poll_interval).await;
            match self.inner.rpc.get_payment(hash_hex).await {
                Ok(Some(current)) => {
                    let terminal = matches!(
                        current.status,
                        PaymentStatus::Success | PaymentStatus::Failed
                    );
                    latest = current;
                    if terminal {
                        return Ok(latest);
                    }
                }
                // A payment the node has forgotten mid-flight is not a failure we can act on.
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(error = %e, "polling payment failed");
                }
            }
        }
        Ok(latest)
    }

    /// Translate a Fiber payment into cdk's melt response.
    fn payment_response(
        &self,
        hash: [u8; 32],
        result: &wire::PaymentResult,
        amount_base: u128,
    ) -> Result<MakePaymentResponse, Error> {
        let scale = self.inner.config.unit_scale;
        let status = match result.status {
            PaymentStatus::Success => MeltQuoteState::Paid,
            PaymentStatus::Failed => MeltQuoteState::Failed,
            // Still in flight. Never `Failed`: the wallet must not get its proofs back while a
            // TLC that may yet settle is outstanding.
            PaymentStatus::Created | PaymentStatus::Inflight => MeltQuoteState::Pending,
        };

        // `total_spent` is only authoritative once the payment settled.
        let total_spent = if status == MeltQuoteState::Paid {
            let spent = amount_base
                .checked_add(result.fee)
                .ok_or(Error::AmountOverflow {
                    amount: amount_base,
                    scale,
                })?;
            self.ecash(amount::from_base_ceil(spent, scale)?)
        } else {
            self.zero()
        };

        if status == MeltQuoteState::Failed {
            tracing::warn!("fiber payment failed");
        }

        let payment_proof = if status == MeltQuoteState::Paid {
            result.payment_preimage.clone()
        } else {
            None
        };

        Ok(MakePaymentResponse {
            payment_lookup_id: PaymentIdentifier::PaymentHash(hash),
            payment_proof,
            status,
            total_spent,
        })
    }

    async fn sweep_invoices(&self) {
        let pending: Vec<String> = {
            let watching = self.inner.watching.lock().await;
            watching.iter().cloned().collect()
        };

        for hash_hex in pending {
            let operation = match self
                .inner
                .journal
                .by_payment_hash(SettlementDirection::Incoming, &hash_hex)
            {
                Ok(Some(operation)) => operation,
                Ok(None) => {
                    tracing::error!("watched invoice is missing from the settlement journal");
                    self.unwatch(&hash_hex).await;
                    continue;
                }
                Err(error) => {
                    tracing::error!(error = %error, "settlement journal could not be read");
                    continue;
                }
            };
            let invoice = match self.inner.rpc.get_invoice(&hash_hex).await {
                Ok(invoice) => invoice,
                Err(e) => {
                    let now = Self::now_unix();
                    if let Err(journal_error) = self.record_rpc_error(&operation, &e, now) {
                        tracing::error!(error = %journal_error, "invoice reconciliation error could not be recorded");
                    }
                    tracing::warn!(error = %e, "polling invoice failed");
                    continue;
                }
            };

            if let Err(error) = self.validate_invoice(
                &hash_hex,
                &invoice.invoice,
                Some(operation.principal_base()),
            ) {
                tracing::error!(error = %error, "reconciled invoice conflicts with durable intent");
                continue;
            }
            let now = Self::now_unix();
            if let Err(error) = self.observe_by_hash(
                SettlementDirection::Incoming,
                &hash_hex,
                Self::incoming_state(invoice.status),
                None,
                now,
            ) {
                tracing::error!(error = %error, "invoice observation could not be recorded");
                continue;
            }

            match invoice.status {
                CkbInvoiceStatus::Paid => {
                    match self.received_event(&hash_hex, invoice.invoice.amount) {
                        Ok(event) => {
                            if self.inner.events.send(event).await.is_err() {
                                tracing::debug!("payment event stream closed; stopping sweep");
                                return;
                            }
                            self.unwatch(&hash_hex).await;
                        }
                        Err(e) => {
                            tracing::error!(error = %e, "settled invoice could not be reported");
                            self.unwatch(&hash_hex).await;
                        }
                    }
                }
                CkbInvoiceStatus::Cancelled | CkbInvoiceStatus::Expired => {
                    self.unwatch(&hash_hex).await;
                }
                // `Open` is still payable. `Received` means a TLC arrived but has not settled,
                // so the mint does not hold the funds and must not credit the wallet.
                CkbInvoiceStatus::Open | CkbInvoiceStatus::Received => {}
            }
        }
    }

    fn received_event(&self, hash_hex: &str, amount_base: Option<u128>) -> Result<Event, Error> {
        let amount_base = amount_base.ok_or(Error::AmountlessInvoice)?;
        let hash = wire::hash_from_hex(hash_hex)?;
        let ecash = amount::from_base_floor(amount_base, self.inner.config.unit_scale)?;
        Ok(Event::PaymentReceived(WaitPaymentResponse {
            payment_identifier: PaymentIdentifier::PaymentHash(hash),
            payment_amount: self.ecash(ecash),
            payment_id: hash_hex.to_string(),
        }))
    }

    async fn unwatch(&self, hash_hex: &str) {
        self.inner.watching.lock().await.remove(hash_hex);
    }
}

fn lookup_hash(identifier: &PaymentIdentifier) -> Result<String, Error> {
    match identifier {
        PaymentIdentifier::PaymentHash(hash) => Ok(wire::hash_to_hex(hash)),
        other => Err(Error::UnsupportedIdentifier(other.kind())),
    }
}

fn custom_outgoing(options: OutgoingPaymentOptions) -> Result<CustomOutgoingPaymentOptions, Error> {
    match options {
        OutgoingPaymentOptions::Custom(opts) => Ok(*opts),
        _ => Err(Error::UnsupportedMethod { method: METHOD }),
    }
}

#[async_trait]
impl MintPayment for FiberBackend {
    type Err = payment::Error;

    async fn start(&self) -> Result<(), Self::Err> {
        let recoverable = self.inner.journal.recovery_queue()?;
        let backend = self.clone();
        let cancel = self.inner.cancel.clone();
        let interval = self.inner.config.poll_interval;

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = ticker.tick() => backend.sweep_invoices().await,
                }
            }
            tracing::info!("fiber invoice sweeper stopped");
        });

        tracing::info!(
            unit = %self.inner.config.unit,
            recoverable_operations = recoverable.len(),
            "cdk-fiber started"
        );
        Ok(())
    }

    async fn stop(&self) -> Result<(), Self::Err> {
        self.inner.cancel.cancel();
        self.inner.stream_active.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        // `cdk-mintd` registers exactly the methods it finds as keys of `custom`, and requires
        // this unit to match its normalized `[payment_backend].unit`.
        let mut custom = std::collections::HashMap::new();
        custom.insert(METHOD.to_string(), "{}".to_string());

        Ok(SettingsResponse {
            unit: self.inner.config.unit.to_string(),
            bolt11: None,
            bolt12: None,
            onchain: None,
            custom,
        })
    }

    async fn create_incoming_payment_request(
        &self,
        options: IncomingPaymentOptions,
    ) -> Result<CreateIncomingPaymentResponse, Self::Err> {
        let opts = match options {
            IncomingPaymentOptions::Custom(opts) => *opts,
            _ => return Err(Error::UnsupportedMethod { method: METHOD }.into()),
        };
        // `opts.method` is deliberately not inspected: the gRPC bridge always delivers it empty.
        let requested_amount = opts.amount.ok_or(Error::AmountlessIncomingRequest)?;
        self.ensure_unit(requested_amount.unit())?;

        let config = &self.inner.config;
        let now = Self::now_unix();
        let (relative_expiry, absolute_expiry) = match opts.unix_expiry {
            Some(at) => (at.saturating_sub(now).max(1), at),
            None => {
                let secs = config.invoice_expiry.as_secs();
                (secs, now.saturating_add(secs))
            }
        };

        let amount = amount::to_base(requested_amount.value(), config.unit_scale);
        let quote_id = opts.quote_id.to_string();
        if let Some(existing) = self
            .inner
            .journal
            .by_quote_id(SettlementDirection::Incoming, &quote_id)?
        {
            if existing.scope() != &self.inner.scope
                || existing.principal_base() != amount
                || opts
                    .unix_expiry
                    .is_some_and(|expiry| existing.deadline_unix() != Some(expiry))
            {
                return Err(JournalError::Conflict.into());
            }
            let hash = wire::hash_from_hex(existing.payment_hash())?;
            self.inner
                .watching
                .lock()
                .await
                .insert(existing.payment_hash().to_string());
            return Ok(CreateIncomingPaymentResponse {
                request_lookup_id: PaymentIdentifier::PaymentHash(hash),
                request: existing.invoice().to_string(),
                expiry: existing.deadline_unix(),
                extra_json: None,
            });
        }

        let created = self
            .inner
            .rpc
            .new_invoice(NewInvoiceParams {
                amount,
                description: opts.description,
                currency: config.currency,
                expiry: Some(relative_expiry),
                udt_type_script: config.udt_type_script.clone(),
            })
            .await
            .inspect_err(|e| tracing::error!(error = %e, "new_invoice failed"))?;

        let hash = wire::hash_from_hex(&created.invoice.data.payment_hash)?;
        let hash_hex = wire::hash_to_hex(&hash);
        self.validate_invoice(&hash_hex, &created.invoice, Some(amount))?;
        let durable = self.inner.journal.insert(NewSettlementOperation::incoming(
            self.inner.scope.clone(),
            quote_id,
            hash_hex,
            created.invoice_address,
            amount,
            absolute_expiry,
            now,
        ))?;
        self.inner
            .watching
            .lock()
            .await
            .insert(durable.payment_hash().to_string());

        Ok(CreateIncomingPaymentResponse {
            request_lookup_id: PaymentIdentifier::PaymentHash(hash),
            request: durable.invoice().to_string(),
            expiry: durable.deadline_unix(),
            extra_json: None,
        })
    }

    async fn check_incoming_payment_status(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        let hash_hex = lookup_hash(payment_identifier)?;
        let durable = self
            .inner
            .journal
            .by_payment_hash(SettlementDirection::Incoming, &hash_hex)?;
        let invoice = match self.inner.rpc.get_invoice(&hash_hex).await {
            Ok(invoice) => invoice,
            Err(error) => {
                if let Some(operation) = durable.as_ref() {
                    let now = Self::now_unix();
                    self.record_rpc_error(operation, &error, now)?;
                }
                return Err(error.into());
            }
        };
        self.validate_invoice(
            &hash_hex,
            &invoice.invoice,
            durable.as_ref().map(SettlementOperation::principal_base),
        )?;
        let now = Self::now_unix();
        self.observe_by_hash(
            SettlementDirection::Incoming,
            &hash_hex,
            Self::incoming_state(invoice.status),
            None,
            now,
        )?;

        // Anything short of `Paid` means the mint does not hold the funds. In particular
        // `Received` is a TLC awaiting settlement, not money in hand.
        if invoice.status != CkbInvoiceStatus::Paid {
            return Ok(vec![]);
        }

        let amount_base = invoice.invoice.amount.ok_or(Error::AmountlessInvoice)?;
        let ecash = amount::from_base_floor(amount_base, self.inner.config.unit_scale)?;

        Ok(vec![WaitPaymentResponse {
            payment_identifier: payment_identifier.clone(),
            payment_amount: self.ecash(ecash),
            payment_id: hash_hex,
        }])
    }

    async fn get_payment_quote(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<PaymentQuoteResponse, Self::Err> {
        self.ensure_unit(unit)?;
        let opts = custom_outgoing(options)?;
        let config = &self.inner.config;
        let quote_id = opts.quote_id.to_string();

        if let Some(existing) = self
            .inner
            .journal
            .by_quote_id(SettlementDirection::Outgoing, &quote_id)?
        {
            if existing.scope() != &self.inner.scope || existing.invoice() != opts.request {
                return Err(JournalError::Conflict.into());
            }
            let hash = wire::hash_from_hex(existing.payment_hash())?;
            let amount = amount::from_base_ceil(existing.principal_base(), config.unit_scale)?;
            let fee_base = existing.fee_ceiling_base().ok_or(JournalError::Conflict)?;
            let fee = amount::from_base_ceil(fee_base, config.unit_scale)?;
            return Ok(PaymentQuoteResponse {
                request_lookup_id: Some(PaymentIdentifier::PaymentHash(hash)),
                amount: self.ecash(amount),
                fee: self.ecash(fee),
                state: MeltQuoteState::Unpaid,
                extra_json: None,
                estimated_blocks: None,
                fee_options: None,
            });
        }

        let (hash, hash_hex, amount_base) = self.resolve_invoice(&opts.request).await?;

        // A dry run builds a real route and returns the fee it would pay, without dispatching a
        // TLC. If no route exists the node errors here, and the mint rejects the melt quote.
        let probe = self
            .inner
            .rpc
            .send_payment(SendPaymentParams {
                invoice: opts.request.clone(),
                max_fee_amount: None,
                max_fee_rate: None,
                dry_run: Some(true),
            })
            .await
            .inspect_err(|e| tracing::warn!(error = %e, "melt quote route probe failed"))?;

        let amount = amount::from_base_ceil(amount_base, config.unit_scale)?;
        let fee = amount::fee_reserve(
            probe.fee,
            config.unit_scale,
            config.fee_percent,
            config.min_fee_reserve,
        )?;
        let fee_base = amount::to_base(fee, config.unit_scale);
        self.inner.journal.insert(NewSettlementOperation::outgoing(
            self.inner.scope.clone(),
            quote_id,
            hash_hex,
            opts.request,
            amount_base,
            Some(fee_base),
            Self::now_unix(),
        ))?;

        Ok(PaymentQuoteResponse {
            request_lookup_id: Some(PaymentIdentifier::PaymentHash(hash)),
            amount: self.ecash(amount),
            fee: self.ecash(fee),
            state: MeltQuoteState::Unpaid,
            extra_json: None,
            estimated_blocks: None,
            fee_options: None,
        })
    }

    async fn make_payment(
        &self,
        unit: &CurrencyUnit,
        options: OutgoingPaymentOptions,
    ) -> Result<MakePaymentResponse, Self::Err> {
        self.ensure_unit(unit)?;
        let opts = custom_outgoing(options)?;
        let config = &self.inner.config;

        let (hash, hash_hex, amount_base) = self.resolve_invoice(&opts.request).await?;
        let max_fee_amount = opts
            .max_fee_amount
            .map(|fee| amount::to_base(fee.value(), config.unit_scale));
        let quote_id = opts.quote_id.to_string();
        let mut operation = match self
            .inner
            .journal
            .by_quote_id(SettlementDirection::Outgoing, &quote_id)?
        {
            Some(existing) => {
                self.validate_operation_identity(
                    &existing,
                    &opts.request,
                    &hash_hex,
                    amount_base,
                    max_fee_amount,
                )?;
                existing
            }
            None => self.inner.journal.insert(NewSettlementOperation::outgoing(
                self.inner.scope.clone(),
                quote_id.clone(),
                hash_hex.clone(),
                opts.request.clone(),
                amount_base,
                max_fee_amount,
                Self::now_unix(),
            ))?,
        };

        // A durable hash identifies the one Fiber attempt. Any existing node session, including a
        // terminal failure, is reported rather than automatically creating another economic side
        // effect for a duplicated CDK call.
        match self.inner.rpc.get_payment(&hash_hex).await {
            Ok(Some(existing)) => {
                let now = Self::now_unix();
                operation = self.observe(
                    &operation,
                    Self::outgoing_state(existing.status),
                    (existing.status == PaymentStatus::Success).then_some(existing.fee),
                    now,
                )?;
                tracing::info!(
                    state = ?operation.observed_state(),
                    "melt already has a Fiber session; reporting it"
                );
                return Ok(self.payment_response(hash, &existing, amount_base)?);
            }
            Ok(None) => {}
            Err(error) => {
                let now = Self::now_unix();
                self.record_rpc_error(&operation, &error, now)?;
                return Err(error.into());
            }
        }

        // A missing node session is not enough to repeat a dispatch whose response may have been
        // lost. Only an intent that has never crossed the durable dispatch boundary can proceed.
        // Recovery may later prove a retry safe, but an ordinary duplicate CDK call cannot.
        if operation.dispatch_count() > 0
            || !matches!(
                operation.observed_state(),
                ObservedState::OutgoingQuoted | ObservedState::OutgoingUnknown
            )
        {
            if operation
                .observed_state()
                .can_transition_to(ObservedState::OutgoingUnknown)
            {
                self.observe(
                    &operation,
                    ObservedState::OutgoingUnknown,
                    None,
                    Self::now_unix(),
                )?;
            }
            return Ok(MakePaymentResponse {
                payment_lookup_id: PaymentIdentifier::PaymentHash(hash),
                payment_proof: None,
                status: MeltQuoteState::Unknown,
                total_spent: self.zero(),
            });
        }

        let now = Self::now_unix();
        operation = self.observe(&operation, ObservedState::OutgoingUnknown, None, now)?;
        let timeout = opts
            .timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(config.payment_timeout);
        let deadline = now.saturating_add(timeout.as_secs());
        operation = self.inner.journal.prepare_outgoing_dispatch(
            &quote_id,
            operation.revision(),
            deadline,
            now,
        )?;

        // Without a matching rate, FNN clamps the ceiling back to 0.5% of the amount and the
        // payment fails to route for a fee the mint has already quoted.
        let max_fee_rate =
            max_fee_amount.and_then(|fee| amount::max_fee_rate_for(amount_base, fee));

        let dispatched = match self
            .inner
            .rpc
            .send_payment(SendPaymentParams {
                invoice: opts.request.clone(),
                max_fee_amount,
                max_fee_rate,
                dry_run: Some(false),
            })
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let now = Self::now_unix();
                self.record_rpc_error(&operation, &error, now)?;
                tracing::error!(error = %error, "send_payment failed");
                return Err(error.into());
            }
        };
        let now = Self::now_unix();
        operation = self.observe(
            &operation,
            Self::outgoing_state(dispatched.status),
            (dispatched.status == PaymentStatus::Success).then_some(dispatched.fee),
            now,
        )?;
        let settled = self
            .await_settlement(&hash_hex, dispatched, timeout)
            .await?;
        self.observe(
            &operation,
            Self::outgoing_state(settled.status),
            (settled.status == PaymentStatus::Success).then_some(settled.fee),
            Self::now_unix(),
        )?;

        Ok(self.payment_response(hash, &settled, amount_base)?)
    }

    async fn check_outgoing_payment(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        let hash_hex = lookup_hash(payment_identifier)?;
        let durable = self
            .inner
            .journal
            .by_payment_hash(SettlementDirection::Outgoing, &hash_hex)?;

        let node_result = match self.inner.rpc.get_payment(&hash_hex).await {
            Ok(result) => result,
            Err(error) => {
                if let Some(operation) = durable.as_ref() {
                    self.record_rpc_error(operation, &error, Self::now_unix())?;
                }
                return Err(error.into());
            }
        };
        match node_result {
            Some(result) => {
                let hash = wire::hash_from_hex(&hash_hex)?;
                if durable.is_some() {
                    self.observe_by_hash(
                        SettlementDirection::Outgoing,
                        &hash_hex,
                        Self::outgoing_state(result.status),
                        (result.status == PaymentStatus::Success).then_some(result.fee),
                        Self::now_unix(),
                    )?;
                }
                let principal = durable
                    .as_ref()
                    .map(SettlementOperation::principal_base)
                    .unwrap_or(0);
                Ok(self.payment_response(hash, &result, principal)?)
            }
            // The node never saw this hash: the TLC was never dispatched. `Unknown` lets the mint
            // retry, where `Failed` would be a claim we cannot support.
            None => {
                if let Some(operation) = durable.as_ref() {
                    if operation
                        .observed_state()
                        .can_transition_to(ObservedState::OutgoingUnknown)
                    {
                        self.observe_by_hash(
                            SettlementDirection::Outgoing,
                            &hash_hex,
                            ObservedState::OutgoingUnknown,
                            None,
                            Self::now_unix(),
                        )?;
                    } else if operation.terminal_at().is_none() {
                        self.inner.journal.record_reconciliation_error(
                            SettlementDirection::Outgoing,
                            operation.quote_id(),
                            operation.revision(),
                            ReconciliationErrorClass::InvalidResponse,
                            Self::now_unix(),
                            self.next_reconcile_at(Self::now_unix()),
                        )?;
                    }
                }
                Ok(MakePaymentResponse {
                    payment_lookup_id: payment_identifier.clone(),
                    payment_proof: None,
                    status: MeltQuoteState::Unknown,
                    total_spent: self.zero(),
                })
            }
        }
    }

    async fn wait_payment_event(
        &self,
    ) -> Result<Pin<Box<dyn Stream<Item = Event> + Send>>, Self::Err> {
        let receiver = self
            .inner
            .receiver
            .lock()
            .await
            .take()
            .ok_or(Error::StreamAlreadyTaken)?;

        self.inner.stream_active.store(true, Ordering::SeqCst);
        let guard = ActiveGuard(self.inner.clone());
        let cancel = self.inner.cancel.clone();

        let stream = ReceiverStream::new(receiver)
            .take_until(async move { cancel.cancelled().await })
            .map(move |event| {
                // Holding the guard in the closure ties the active flag to the stream's lifetime.
                let _active = &guard;
                event
            });

        Ok(Box::pin(stream))
    }

    fn is_payment_event_stream_active(&self) -> bool {
        self.inner.stream_active.load(Ordering::SeqCst)
    }

    fn cancel_payment_event_stream(&self) {
        self.inner.cancel.cancel();
    }
}
