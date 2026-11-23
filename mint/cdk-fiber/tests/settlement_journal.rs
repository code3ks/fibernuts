//! Storage-level tests for restart recovery, atomic identity binding, migrations, and retention.

use std::sync::{Arc, Barrier};

use cdk_fiber::config::rusd_testnet_script;
use cdk_fiber::journal::{
    EventState, JournalError, JournalScope, NewSettlementOperation, ObservedState,
    ReconciliationErrorClass, ReconciliationObservation, SettlementAsset, SettlementDirection,
    SettlementJournal,
};
use cdk_fiber::wire::Currency;
use rusqlite::Connection;
use tempfile::tempdir;

const HASH_A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const QUOTE_A: &str = "550e8400-e29b-41d4-a716-446655440000";
const QUOTE_B: &str = "550e8400-e29b-41d4-a716-446655440001";
const QUOTE_C: &str = "550e8400-e29b-41d4-a716-446655440002";
const QUOTE_D: &str = "550e8400-e29b-41d4-a716-446655440003";

fn scope() -> JournalScope {
    JournalScope::new(
        "https://mint.example",
        "rusd",
        1_000_000,
        Currency::Fibt,
        SettlementAsset::Udt(rusd_testnet_script()),
    )
}

fn incoming(
    quote_id: &str,
    payment_hash: &str,
    principal_base: u128,
    now: u64,
) -> NewSettlementOperation {
    NewSettlementOperation::incoming(
        scope(),
        quote_id,
        payment_hash,
        format!("fibt-synthetic-{quote_id}"),
        principal_base,
        now + 3_600,
        now,
    )
}

fn outgoing(quote_id: &str, payment_hash: &str, now: u64) -> NewSettlementOperation {
    NewSettlementOperation::outgoing(
        scope(),
        quote_id,
        payment_hash,
        format!("fibt-synthetic-{quote_id}"),
        100_000_000,
        Some(2_000_000),
        now,
    )
}

fn open_bound(path: &std::path::Path) -> SettlementJournal {
    let journal = SettlementJournal::open(path).unwrap();
    journal.bind_scope(&scope()).unwrap();
    journal
}

#[test]
fn the_file_constructor_rejects_volatile_storage() {
    for path in [":memory:", "file::memory:?cache=shared"] {
        let error = SettlementJournal::open(path).unwrap_err();
        assert!(matches!(
            error,
            JournalError::InvalidOperation("journal path")
        ));
    }
}

#[test]
fn restart_recovers_every_nonterminal_operation_in_deterministic_order() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("settlement.sqlite3");
    {
        let journal = open_bound(&path);
        journal.insert(incoming(QUOTE_A, HASH_A, 10, 30)).unwrap();
        journal.insert(outgoing(QUOTE_B, HASH_B, 10)).unwrap();
    }

    let reopened = SettlementJournal::open(&path).unwrap();
    assert_eq!(reopened.scope().unwrap(), Some(scope()));
    let recovered = reopened.recovery_queue().unwrap();
    assert_eq!(recovered.len(), 2);
    assert_eq!(recovered[0].quote_id(), QUOTE_B);
    assert_eq!(recovered[1].quote_id(), QUOTE_A);
    assert_eq!(recovered[0].record_version(), 1);
}

#[test]
fn exact_replay_is_idempotent_but_changed_economic_intent_fails_closed() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let operation = incoming(QUOTE_A, HASH_A, 100, 10);

    let first = journal.insert(operation.clone()).unwrap();
    let replay = journal.insert(operation).unwrap();
    assert_eq!(first, replay);

    let error = journal
        .insert(incoming(QUOTE_A, HASH_A, 101, 10))
        .unwrap_err();
    assert!(matches!(error, JournalError::Conflict));
    assert_eq!(
        journal
            .by_quote_id(SettlementDirection::Incoming, QUOTE_A)
            .unwrap()
            .unwrap()
            .principal_base(),
        100
    );
}

#[test]
fn a_secondary_key_conflict_rolls_back_the_complete_insert() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();

    let error = journal
        .insert(incoming(QUOTE_B, HASH_A, 100, 11))
        .unwrap_err();
    assert!(matches!(error, JournalError::Conflict));
    assert!(journal
        .by_quote_id(SettlementDirection::Incoming, QUOTE_B)
        .unwrap()
        .is_none());
    assert_eq!(journal.recovery_queue().unwrap().len(), 1);
}

#[test]
fn compare_and_swap_rejects_a_stale_dispatch_writer() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();

    let prepared = journal
        .prepare_outgoing_dispatch(QUOTE_A, inserted.revision(), 90, 20)
        .unwrap();
    assert_eq!(prepared.dispatch_count(), 1);
    assert_eq!(prepared.event_state(), EventState::Pending);
    assert_eq!(
        prepared.observed_state(),
        ObservedState::OutgoingDispatchPrepared
    );

    let error = journal
        .prepare_outgoing_dispatch(QUOTE_A, inserted.revision(), 90, 21)
        .unwrap_err();
    assert!(matches!(error, JournalError::ConcurrentUpdate));
    let error = journal
        .prepare_outgoing_dispatch(QUOTE_A, prepared.revision(), 90, 22)
        .unwrap_err();
    assert!(matches!(error, JournalError::InvalidTransition));
    assert_eq!(
        journal
            .by_quote_id(SettlementDirection::Outgoing, QUOTE_A)
            .unwrap()
            .unwrap()
            .dispatch_count(),
        1
    );
}

#[test]
fn monotonic_states_cannot_be_reopened_after_authoritative_expiry() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    let expired = journal
        .record_observation(
            SettlementDirection::Incoming,
            QUOTE_A,
            ReconciliationObservation {
                expected_revision: inserted.revision(),
                state: ObservedState::IncomingExpired,
                actual_fee_base: None,
                checked_at: 20,
                next_reconcile_at: 30,
                deadline_unix: None,
            },
        )
        .unwrap();
    assert_eq!(expired.terminal_at(), Some(20));

    let error = journal
        .record_observation(
            SettlementDirection::Incoming,
            QUOTE_A,
            ReconciliationObservation {
                expected_revision: expired.revision(),
                state: ObservedState::IncomingPaid,
                actual_fee_base: None,
                checked_at: 21,
                next_reconcile_at: 31,
                deadline_unix: None,
            },
        )
        .unwrap_err();
    assert!(matches!(error, JournalError::InvalidTransition));
}

#[test]
fn reconciliation_errors_preserve_the_last_authoritative_state() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();

    let updated = journal
        .record_reconciliation_error(
            SettlementDirection::Outgoing,
            QUOTE_A,
            inserted.revision(),
            ReconciliationErrorClass::RpcUnavailable,
            20,
            25,
        )
        .unwrap();
    assert_eq!(updated.observed_state(), ObservedState::OutgoingQuoted);
    assert_eq!(
        updated.last_error_class(),
        Some(ReconciliationErrorClass::RpcUnavailable)
    );
    assert_eq!(updated.reconciliation_count(), 1);
    assert_eq!(updated.next_reconcile_at(), 25);
}

#[test]
fn an_authoritative_fee_above_the_durable_ceiling_fails_closed() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();

    let error = journal
        .record_observation(
            SettlementDirection::Outgoing,
            QUOTE_A,
            ReconciliationObservation {
                expected_revision: inserted.revision(),
                state: ObservedState::OutgoingSucceeded,
                actual_fee_base: Some(2_000_001),
                checked_at: 20,
                next_reconcile_at: 30,
                deadline_unix: None,
            },
        )
        .unwrap_err();

    assert!(matches!(
        error,
        JournalError::InvalidOperation("actual fee exceeds fee ceiling")
    ));
    let unchanged = journal
        .by_quote_id(SettlementDirection::Outgoing, QUOTE_A)
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.observed_state(), ObservedState::OutgoingQuoted);
    assert!(unchanged.actual_fee_base().is_none());
}

#[test]
fn paid_incoming_remains_recoverable_until_event_delivery_is_durable() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    let paid = journal
        .record_observation(
            SettlementDirection::Incoming,
            QUOTE_A,
            ReconciliationObservation {
                expected_revision: inserted.revision(),
                state: ObservedState::IncomingPaid,
                actual_fee_base: None,
                checked_at: 20,
                next_reconcile_at: 25,
                deadline_unix: None,
            },
        )
        .unwrap();
    assert_eq!(paid.event_state(), EventState::Pending);
    assert!(paid.terminal_at().is_none());
    assert_eq!(journal.recovery_queue().unwrap().len(), 1);

    let delivered = journal
        .mark_event_delivered(SettlementDirection::Incoming, QUOTE_A, paid.revision(), 21)
        .unwrap();
    assert_eq!(delivered.event_state(), EventState::Delivered);
    assert_eq!(delivered.terminal_at(), Some(21));
    assert!(journal.recovery_queue().unwrap().is_empty());
}

#[test]
fn terminal_outgoing_remains_recoverable_until_event_delivery_is_durable() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();
    let prepared = journal
        .prepare_outgoing_dispatch(QUOTE_A, inserted.revision(), 90, 20)
        .unwrap();
    let paid = journal
        .record_observation(
            SettlementDirection::Outgoing,
            QUOTE_A,
            ReconciliationObservation {
                expected_revision: prepared.revision(),
                state: ObservedState::OutgoingSucceeded,
                actual_fee_base: Some(1_000_000),
                checked_at: 21,
                next_reconcile_at: 22,
                deadline_unix: None,
            },
        )
        .unwrap();

    assert_eq!(paid.event_state(), EventState::Pending);
    assert!(paid.terminal_at().is_none());
    assert_eq!(journal.recovery_queue().unwrap(), vec![paid.clone()]);

    let delivered = journal
        .mark_event_delivered(SettlementDirection::Outgoing, QUOTE_A, paid.revision(), 23)
        .unwrap();
    assert_eq!(delivered.event_state(), EventState::Delivered);
    assert_eq!(delivered.terminal_at(), Some(23));
    assert!(journal.recovery_queue().unwrap().is_empty());
}

#[test]
fn version_one_migration_restores_only_unresolved_outgoing_notifications() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("version-one.sqlite3");
    let restored_path = directory.path().join("restored.sqlite3");
    {
        let journal = open_bound(&path);
        let pending = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();
        journal
            .prepare_outgoing_dispatch(QUOTE_A, pending.revision(), 90, 20)
            .unwrap();

        let completed = journal.insert(outgoing(QUOTE_B, HASH_B, 10)).unwrap();
        let completed = journal
            .prepare_outgoing_dispatch(QUOTE_B, completed.revision(), 90, 20)
            .unwrap();
        let completed = journal
            .record_observation(
                SettlementDirection::Outgoing,
                QUOTE_B,
                ReconciliationObservation {
                    expected_revision: completed.revision(),
                    state: ObservedState::OutgoingSucceeded,
                    actual_fee_base: Some(1_000_000),
                    checked_at: 21,
                    next_reconcile_at: 22,
                    deadline_unix: None,
                },
            )
            .unwrap();
        journal
            .mark_event_delivered(
                SettlementDirection::Outgoing,
                QUOTE_B,
                completed.revision(),
                23,
            )
            .unwrap();
    }

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE settlement_operations
             SET event_state = 'not_applicable',
                 revision = revision - CASE WHEN quote_id = ?1 THEN 1 ELSE 0 END",
            [QUOTE_B],
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    drop(connection);

    let restored = SettlementJournal::restore(&path, &restored_path).unwrap();
    let restored_pending = restored
        .by_quote_id(SettlementDirection::Outgoing, QUOTE_A)
        .unwrap()
        .unwrap();
    assert_eq!(restored_pending.event_state(), EventState::Pending);
    assert_eq!(restored.recovery_queue().unwrap(), vec![restored_pending]);

    let migrated = SettlementJournal::open(&path).unwrap();
    let pending = migrated
        .by_quote_id(SettlementDirection::Outgoing, QUOTE_A)
        .unwrap()
        .unwrap();
    let completed = migrated
        .by_quote_id(SettlementDirection::Outgoing, QUOTE_B)
        .unwrap()
        .unwrap();

    assert_eq!(pending.event_state(), EventState::Pending);
    assert!(pending.terminal_at().is_none());
    assert_eq!(completed.event_state(), EventState::NotApplicable);
    assert!(completed.terminal_at().is_some());
    assert_eq!(migrated.recovery_queue().unwrap(), vec![pending]);
}

#[test]
fn version_one_migration_rejects_a_terminal_row_without_its_terminal_marker() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("corrupt-version-one.sqlite3");
    {
        let journal = open_bound(&path);
        let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();
        let prepared = journal
            .prepare_outgoing_dispatch(QUOTE_A, inserted.revision(), 90, 20)
            .unwrap();
        let completed = journal
            .record_observation(
                SettlementDirection::Outgoing,
                QUOTE_A,
                ReconciliationObservation {
                    expected_revision: prepared.revision(),
                    state: ObservedState::OutgoingSucceeded,
                    actual_fee_base: Some(1_000_000),
                    checked_at: 21,
                    next_reconcile_at: 22,
                    deadline_unix: None,
                },
            )
            .unwrap();
        journal
            .mark_event_delivered(
                SettlementDirection::Outgoing,
                QUOTE_A,
                completed.revision(),
                23,
            )
            .unwrap();
    }

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE settlement_operations
             SET event_state = 'not_applicable', revision = revision - 1, terminal_at = NULL",
            [],
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord {
            field: "v1 outgoing terminal state"
        }
    ));
}

#[test]
fn version_one_migration_rolls_back_when_transformed_content_is_invalid() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("invalid-version-one.sqlite3");
    {
        let journal = open_bound(&path);
        let inserted = journal.insert(outgoing(QUOTE_A, HASH_A, 10)).unwrap();
        journal
            .prepare_outgoing_dispatch(QUOTE_A, inserted.revision(), 90, 20)
            .unwrap();
    }

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE settlement_operations
             SET event_state = 'not_applicable', dispatch_count = 2, revision = 2",
            [],
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 1).unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord {
            field: "outgoing recovery metadata"
        }
    ));

    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    let event_state: String = connection
        .query_row(
            "SELECT event_state FROM settlement_operations WHERE quote_id = ?1",
            [QUOTE_A],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, 1);
    assert_eq!(event_state, "not_applicable");
}

#[test]
fn retention_deletes_only_old_terminal_operations() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let old = journal.insert(incoming(QUOTE_C, HASH_A, 100, 1)).unwrap();
    journal.insert(incoming(QUOTE_D, HASH_B, 100, 1)).unwrap();
    journal
        .record_observation(
            SettlementDirection::Incoming,
            QUOTE_C,
            ReconciliationObservation {
                expected_revision: old.revision(),
                state: ObservedState::IncomingExpired,
                actual_fee_base: None,
                checked_at: 5,
                next_reconcile_at: 6,
                deadline_unix: None,
            },
        )
        .unwrap();

    assert_eq!(journal.prune_terminal_before(6).unwrap(), 1);
    assert!(journal
        .by_quote_id(SettlementDirection::Incoming, QUOTE_C)
        .unwrap()
        .is_none());
    assert!(journal
        .by_quote_id(SettlementDirection::Incoming, QUOTE_D)
        .unwrap()
        .is_some());
}

#[test]
fn a_newer_schema_version_is_rejected_without_mutation() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("future.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 99).unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::IncompatibleSchema {
            found: 99,
            supported: 2
        }
    ));
}

#[test]
fn a_corrupt_row_fails_the_recovery_read_instead_of_being_skipped() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("corrupt.sqlite3");
    {
        let journal = open_bound(&path);
        journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    }
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE settlement_operations SET principal_base = 'not-a-number'",
            [],
        )
        .unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord {
            field: "principal_base"
        }
    ));
}

#[test]
fn incomplete_recovery_metadata_fails_closed_on_open() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("incomplete.sqlite3");
    {
        let journal = open_bound(&path);
        journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    }
    let connection = Connection::open(&path).unwrap();
    connection
        .execute("UPDATE settlement_operations SET deadline_unix = NULL", [])
        .unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord {
            field: "incoming recovery metadata"
        }
    ));
}

#[test]
fn a_database_with_duplicate_operation_identity_fails_closed_on_open() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("duplicate.sqlite3");
    {
        let journal = open_bound(&path);
        journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    }
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "ALTER TABLE settlement_operations RENAME TO original_operations;
             CREATE TABLE settlement_operations AS SELECT * FROM original_operations;
             INSERT INTO settlement_operations SELECT * FROM original_operations;
             DROP TABLE original_operations;",
        )
        .unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord {
            field: "operation identity"
        }
    ));
}

#[test]
fn a_database_with_multiple_scope_rows_fails_closed_on_open() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("duplicate-scope.sqlite3");
    {
        let journal = open_bound(&path);
        journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    }
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "ALTER TABLE journal_scope RENAME TO original_scope;
             CREATE TABLE journal_scope AS SELECT * FROM original_scope;
             INSERT INTO journal_scope SELECT * FROM original_scope;
             DROP TABLE original_scope;",
        )
        .unwrap();
    drop(connection);

    let error = SettlementJournal::open(&path).unwrap_err();
    assert!(matches!(
        error,
        JournalError::CorruptRecord { field: "scope" }
    ));
}

#[test]
fn online_backup_and_non_overwriting_restore_preserve_recovery_state() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("source.sqlite3");
    let backup = directory.path().join("backup.sqlite3");
    let restored = directory.path().join("restored.sqlite3");
    let journal = open_bound(&source);
    journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();

    journal.backup_to(&backup).unwrap();
    let error = journal.backup_to(&backup).unwrap_err();
    assert!(matches!(error, JournalError::DestinationExists));

    let restored_journal = SettlementJournal::restore(&backup, &restored).unwrap();
    assert_eq!(restored_journal.scope().unwrap(), Some(scope()));
    assert_eq!(restored_journal.recovery_queue().unwrap().len(), 1);

    let error = SettlementJournal::restore(&backup, &restored).unwrap_err();
    assert!(matches!(error, JournalError::DestinationExists));
}

#[test]
fn concurrent_backups_publish_exactly_one_valid_destination() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("source.sqlite3");
    let backup = directory.path().join("backup.sqlite3");
    let journal = Arc::new(open_bound(&source));
    journal.insert(incoming(QUOTE_A, HASH_A, 100, 10)).unwrap();
    let barrier = Arc::new(Barrier::new(3));

    let handles = (0..2)
        .map(|_| {
            let journal = journal.clone();
            let backup = backup.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                journal.backup_to(backup)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();

    let results = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(JournalError::DestinationExists)))
            .count(),
        1
    );

    let reopened = SettlementJournal::open(&backup).unwrap();
    assert_eq!(reopened.recovery_queue().unwrap().len(), 1);
}

#[test]
fn database_scope_cannot_be_rebound_to_another_mint() {
    let journal = SettlementJournal::in_memory().unwrap();
    journal.bind_scope(&scope()).unwrap();
    let other = JournalScope::new(
        "https://other.example",
        "rusd",
        1_000_000,
        Currency::Fibt,
        SettlementAsset::Udt(rusd_testnet_script()),
    );

    let error = journal.bind_scope(&other).unwrap_err();
    assert!(matches!(error, JournalError::ScopeMismatch));
}

#[test]
fn debug_and_schema_exclude_bearer_and_signing_material() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("settlement.sqlite3");
    let journal = open_bound(&path);
    let operation = journal.insert(incoming(QUOTE_A, HASH_C, 100, 10)).unwrap();
    let debug = format!("{operation:?}");
    assert!(!debug.contains(QUOTE_A));
    assert!(!debug.contains(HASH_C));
    assert!(!debug.contains("fibt-synthetic"));

    drop(journal);
    let connection = Connection::open(&path).unwrap();
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info('settlement_operations')")
        .unwrap();
    let columns = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    for forbidden in [
        "proof",
        "token",
        "preimage",
        "mnemonic",
        "private_key",
        "signing_key",
    ] {
        assert!(!columns.iter().any(|column| column.contains(forbidden)));
    }
}
