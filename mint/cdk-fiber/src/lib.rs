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
pub mod rpc;
pub mod wire;

pub use config::FiberConfig;
pub use error::Error;
pub use rpc::{FiberRpc, HttpFiberRpc};
pub use wire::CkbInvoiceStatus;

use wire::{NewInvoiceParams, PaymentStatus, SendPaymentParams};

/// The single Cashu payment method this backend serves.
pub const METHOD: &str = "fiber";

/// Buffered payment events. Matches the depth cdk's own backends use.
const EVENT_BUFFER: usize = 8;

struct Inner {
    rpc: Arc<dyn FiberRpc>,
    config: FiberConfig,
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
    /// Build a backend over any [`FiberRpc`] transport.
    pub fn new(rpc: Arc<dyn FiberRpc>, config: FiberConfig) -> Self {
        let (events, receiver) = mpsc::channel(EVENT_BUFFER);
        Self {
            inner: Arc::new(Inner {
                rpc,
                config,
                events,
                receiver: Mutex::new(Some(receiver)),
                watching: Mutex::new(HashSet::new()),
                cancel: CancellationToken::new(),
                stream_active: AtomicBool::new(false),
            }),
        }
    }

    /// Build a backend that talks JSON-RPC to a node over HTTP.
    pub fn http(rpc_url: impl Into<String>, config: FiberConfig) -> Self {
        Self::new(Arc::new(HttpFiberRpc::new(rpc_url)), config)
    }

    /// The unit this backend settles in.
    pub fn unit(&self) -> &CurrencyUnit {
        &self.inner.config.unit
    }

    fn ensure_unit(&self, requested: &CurrencyUnit) -> Result<(), Error> {
        // Compare rendered names rather than the enum: cdk's `Custom` variants compare by exact
        // string, so `Custom("RUSD")` and `Custom("rusd")` are unequal despite denoting one unit.
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

    /// Resolve the invoice a melt refers to into its payment hash and amount.
    async fn resolve_invoice(&self, invoice: &str) -> Result<([u8; 32], String, u128), Error> {
        let parsed = self.inner.rpc.parse_invoice(invoice).await?;
        let hash_hex = parsed.invoice.data.payment_hash.clone();
        let hash = wire::hash_from_hex(&hash_hex)?;
        let amount = parsed.invoice.amount.ok_or(Error::AmountlessInvoice)?;
        Ok((hash, hash_hex, amount))
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
                    tracing::warn!(payment_hash = %hash_hex, error = %e, "polling payment failed");
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

        if let (MeltQuoteState::Failed, Some(reason)) = (status, result.failed_error.as_ref()) {
            tracing::warn!(reason = %reason, "fiber payment failed");
        }

        Ok(MakePaymentResponse {
            payment_lookup_id: PaymentIdentifier::PaymentHash(hash),
            // FNN never surfaces the preimage through its RPC layer, under any build.
            payment_proof: None,
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
            let invoice = match self.inner.rpc.get_invoice(&hash_hex).await {
                Ok(invoice) => invoice,
                Err(e) => {
                    tracing::warn!(payment_hash = %hash_hex, error = %e, "polling invoice failed");
                    continue;
                }
            };

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
                            tracing::error!(payment_hash = %hash_hex, error = %e, "settled invoice could not be reported");
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

        tracing::info!(unit = %self.inner.config.unit, "cdk-fiber started");
        Ok(())
    }

    async fn stop(&self) -> Result<(), Self::Err> {
        self.inner.cancel.cancel();
        self.inner.stream_active.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn get_settings(&self) -> Result<SettingsResponse, Self::Err> {
        // `cdk-mintd` registers exactly the methods it finds as keys of `custom`, and aborts if
        // this unit does not string-match its own `[ln].unit`.
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
        self.ensure_unit(opts.amount.unit())?;

        let config = &self.inner.config;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let (relative_expiry, absolute_expiry) = match opts.unix_expiry {
            Some(at) => (at.saturating_sub(now).max(1), at),
            None => {
                let secs = config.invoice_expiry.as_secs();
                (secs, now.saturating_add(secs))
            }
        };

        let amount = amount::to_base(opts.amount.value(), config.unit_scale);
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

        let hash_hex = created.invoice.data.payment_hash.clone();
        let hash = wire::hash_from_hex(&hash_hex)?;
        self.inner.watching.lock().await.insert(hash_hex);

        Ok(CreateIncomingPaymentResponse {
            request_lookup_id: PaymentIdentifier::PaymentHash(hash),
            request: created.invoice_address,
            expiry: Some(absolute_expiry),
            extra_json: None,
        })
    }

    async fn check_incoming_payment_status(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<Vec<WaitPaymentResponse>, Self::Err> {
        let hash_hex = lookup_hash(payment_identifier)?;
        let invoice = self.inner.rpc.get_invoice(&hash_hex).await?;

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

        let (hash, _, amount_base) = self.resolve_invoice(&opts.request).await?;

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

        // FNN refuses to re-send a payment for a hash whose session is not `Failed`, so a retried
        // melt must report the existing session rather than dispatch a second TLC.
        if let Some(existing) = self.inner.rpc.get_payment(&hash_hex).await? {
            if existing.status != PaymentStatus::Failed {
                tracing::info!(payment_hash = %hash_hex, "melt already dispatched; reporting existing session");
                return Ok(self.payment_response(hash, &existing, amount_base)?);
            }
        }

        let max_fee_amount = opts
            .max_fee_amount
            .map(|fee| amount::to_base(fee.value(), config.unit_scale));
        // Without a matching rate, FNN clamps the ceiling back to 0.5% of the amount and the
        // payment fails to route for a fee the mint has already quoted.
        let max_fee_rate =
            max_fee_amount.and_then(|fee| amount::max_fee_rate_for(amount_base, fee));

        let dispatched = self
            .inner
            .rpc
            .send_payment(SendPaymentParams {
                invoice: opts.request.clone(),
                max_fee_amount,
                max_fee_rate,
                dry_run: Some(false),
            })
            .await
            .inspect_err(|e| tracing::error!(error = %e, "send_payment failed"))?;

        let timeout = opts
            .timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(config.payment_timeout);
        let settled = self
            .await_settlement(&hash_hex, dispatched, timeout)
            .await?;

        Ok(self.payment_response(hash, &settled, amount_base)?)
    }

    async fn check_outgoing_payment(
        &self,
        payment_identifier: &PaymentIdentifier,
    ) -> Result<MakePaymentResponse, Self::Err> {
        let hash_hex = lookup_hash(payment_identifier)?;

        match self.inner.rpc.get_payment(&hash_hex).await? {
            Some(result) => {
                let hash = wire::hash_from_hex(&hash_hex)?;
                // The amount is unknown without the invoice; `total_spent` is only read once the
                // payment settled, and a settled payment reports its own fee.
                Ok(self.payment_response(hash, &result, 0)?)
            }
            // The node never saw this hash: the TLC was never dispatched. `Unknown` lets the mint
            // retry, where `Failed` would be a claim we cannot support.
            None => Ok(MakePaymentResponse {
                payment_lookup_id: payment_identifier.clone(),
                payment_proof: None,
                status: MeltQuoteState::Unknown,
                total_spent: self.zero(),
            }),
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
