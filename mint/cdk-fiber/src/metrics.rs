//! Aggregate settlement health counters that exclude operation identifiers and payment data.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::error::RpcFailureClass;

/// Privacy-preserving snapshot of Fiber RPC and reconciliation activity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReconciliationMetricsSnapshot {
    /// Total Fiber JSON-RPC calls observed by the backend.
    pub rpc_calls_total: u64,
    /// Cumulative Fiber JSON-RPC latency in microseconds.
    pub rpc_latency_micros_total: u64,
    /// Highest observed Fiber JSON-RPC latency in microseconds.
    pub rpc_latency_micros_max: u64,
    /// Calls that exhausted the configured request deadline.
    pub rpc_timeouts_total: u64,
    /// Retryable connection, transport, and HTTP failures.
    pub rpc_transport_failures_total: u64,
    /// Authoritative JSON-RPC or non-retryable HTTP rejections.
    pub rpc_protocol_failures_total: u64,
    /// Responses that failed JSON decoding.
    pub rpc_invalid_responses_total: u64,
    /// Read-only status queries repeated after an initial observation or error.
    pub reconciliation_retries_total: u64,
    /// Operations currently waiting for reconciliation or event delivery.
    pub reconciliation_backlog: u64,
    /// Reconciliation operations currently executing.
    pub reconciliation_in_flight: u64,
}

#[derive(Debug, Default)]
pub(crate) struct ReconciliationMetrics {
    rpc_calls_total: AtomicU64,
    rpc_latency_micros_total: AtomicU64,
    rpc_latency_micros_max: AtomicU64,
    rpc_timeouts_total: AtomicU64,
    rpc_transport_failures_total: AtomicU64,
    rpc_protocol_failures_total: AtomicU64,
    rpc_invalid_responses_total: AtomicU64,
    reconciliation_retries_total: AtomicU64,
    reconciliation_backlog: AtomicU64,
    reconciliation_in_flight: AtomicU64,
}

impl ReconciliationMetrics {
    pub(crate) fn record_rpc(&self, elapsed: Duration, failure: Option<RpcFailureClass>) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        self.rpc_calls_total.fetch_add(1, Ordering::Relaxed);
        self.rpc_latency_micros_total
            .fetch_add(micros, Ordering::Relaxed);
        self.rpc_latency_micros_max
            .fetch_max(micros, Ordering::Relaxed);

        match failure {
            Some(RpcFailureClass::RetryableTransport) => {
                self.rpc_transport_failures_total
                    .fetch_add(1, Ordering::Relaxed);
            }
            Some(RpcFailureClass::AuthoritativeProtocol) => {
                self.rpc_protocol_failures_total
                    .fetch_add(1, Ordering::Relaxed);
            }
            Some(RpcFailureClass::InvalidResponse) => {
                self.rpc_invalid_responses_total
                    .fetch_add(1, Ordering::Relaxed);
            }
            Some(RpcFailureClass::Local) | None => {}
        }
    }

    pub(crate) fn record_timeout(&self) {
        self.rpc_timeouts_total.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_retry(&self) {
        self.reconciliation_retries_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn set_backlog(&self, backlog: usize) {
        self.reconciliation_backlog
            .store(backlog as u64, Ordering::Relaxed);
    }

    pub(crate) fn begin_reconciliation(&self) -> ReconciliationGuard<'_> {
        self.reconciliation_in_flight
            .fetch_add(1, Ordering::Relaxed);
        ReconciliationGuard { metrics: self }
    }

    pub(crate) fn snapshot(&self) -> ReconciliationMetricsSnapshot {
        ReconciliationMetricsSnapshot {
            rpc_calls_total: self.rpc_calls_total.load(Ordering::Relaxed),
            rpc_latency_micros_total: self.rpc_latency_micros_total.load(Ordering::Relaxed),
            rpc_latency_micros_max: self.rpc_latency_micros_max.load(Ordering::Relaxed),
            rpc_timeouts_total: self.rpc_timeouts_total.load(Ordering::Relaxed),
            rpc_transport_failures_total: self.rpc_transport_failures_total.load(Ordering::Relaxed),
            rpc_protocol_failures_total: self.rpc_protocol_failures_total.load(Ordering::Relaxed),
            rpc_invalid_responses_total: self.rpc_invalid_responses_total.load(Ordering::Relaxed),
            reconciliation_retries_total: self.reconciliation_retries_total.load(Ordering::Relaxed),
            reconciliation_backlog: self.reconciliation_backlog.load(Ordering::Relaxed),
            reconciliation_in_flight: self.reconciliation_in_flight.load(Ordering::Relaxed),
        }
    }
}

pub(crate) struct ReconciliationGuard<'a> {
    metrics: &'a ReconciliationMetrics,
}

impl Drop for ReconciliationGuard<'_> {
    fn drop(&mut self) {
        self.metrics
            .reconciliation_in_flight
            .fetch_sub(1, Ordering::Relaxed);
    }
}
