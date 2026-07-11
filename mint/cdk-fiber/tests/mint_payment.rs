//! The `MintPayment` contract, exercised against a scripted node.
//!
//! These tests encode the invariants that keep a mint solvent. Each one corresponds to a
//! behaviour of the real Fiber node that was verified against fnn 0.9.0-rc2 / v0.9.0-rc7 source.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use cdk_common::nuts::MeltQuoteState;
use cdk_common::payment::{
    CustomIncomingPaymentOptions, CustomOutgoingPaymentOptions, IncomingPaymentOptions,
    MintPayment, OutgoingPaymentOptions, PaymentIdentifier,
};
use cdk_common::{Amount, CurrencyUnit, QuoteId};
use tokio::sync::Mutex;

use cdk_fiber::error::Error;
use cdk_fiber::rpc::FiberRpc;
use cdk_fiber::wire::{
    CkbInvoice, CkbInvoiceStatus, GetInvoiceResult, InvoiceData, InvoiceResult, NewInvoiceParams,
    ParseInvoiceResult, PaymentResult, PaymentStatus, SendPaymentParams,
};
use cdk_fiber::{FiberBackend, FiberConfig};

const HASH_HEX: &str = "0x5e51a85b7382b235440249867bc49e43fb30afb21bcf4663cb2ebf4f97c60078";
const INVOICE: &str = "fibt1001pqn7qyqsm6uqzg7dwfhdvmratf9umr7lfhtc";
const SCALE: u64 = 1_000_000;

/// The invoice amount used throughout: 100 ecash units == 1.00 RUSD.
const AMOUNT_ECASH: u64 = 100;
const AMOUNT_BASE: u128 = AMOUNT_ECASH as u128 * SCALE as u128;

fn invoice(amount: Option<u128>) -> CkbInvoice {
    CkbInvoice {
        currency: cdk_fiber::wire::Currency::Fibt,
        amount,
        data: InvoiceData {
            payment_hash: HASH_HEX.to_string(),
        },
    }
}

fn payment(status: PaymentStatus, fee: u128) -> PaymentResult {
    PaymentResult {
        payment_hash: HASH_HEX.to_string(),
        status,
        fee,
        failed_error: None,
    }
}

#[derive(Default)]
struct Script {
    invoice_status: Option<CkbInvoiceStatus>,
    /// Popped per call; the last entry repeats once exhausted.
    get_payment: VecDeque<Option<PaymentResult>>,
    send_payment: Option<PaymentResult>,
    send_error: bool,
}

#[derive(Default)]
struct Recorded {
    new_invoices: Vec<NewInvoiceParams>,
    sends: Vec<SendPaymentParams>,
}

struct MockNode {
    script: Mutex<Script>,
    recorded: Mutex<Recorded>,
}

impl std::fmt::Debug for MockNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MockNode")
    }
}

impl MockNode {
    fn new(script: Script) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script),
            recorded: Mutex::new(Recorded::default()),
        })
    }
}

#[async_trait]
impl FiberRpc for MockNode {
    async fn new_invoice(&self, params: NewInvoiceParams) -> Result<InvoiceResult, Error> {
        self.recorded.lock().await.new_invoices.push(params.clone());
        Ok(InvoiceResult {
            invoice_address: INVOICE.to_string(),
            invoice: invoice(Some(params.amount)),
        })
    }

    async fn get_invoice(&self, _payment_hash: &str) -> Result<GetInvoiceResult, Error> {
        let status = self
            .script
            .lock()
            .await
            .invoice_status
            .unwrap_or(CkbInvoiceStatus::Open);
        Ok(GetInvoiceResult {
            invoice: invoice(Some(AMOUNT_BASE)),
            status,
        })
    }

    async fn parse_invoice(&self, _invoice: &str) -> Result<ParseInvoiceResult, Error> {
        Ok(ParseInvoiceResult {
            invoice: invoice(Some(AMOUNT_BASE)),
        })
    }

    async fn send_payment(&self, params: SendPaymentParams) -> Result<PaymentResult, Error> {
        self.recorded.lock().await.sends.push(params.clone());
        let script = self.script.lock().await;
        if script.send_error {
            return Err(Error::Rpc {
                code: -32000,
                message: "Send payment error: Failed to build route".to_string(),
            });
        }
        Ok(script
            .send_payment
            .clone()
            .unwrap_or_else(|| payment(PaymentStatus::Created, 0)))
    }

    async fn get_payment(&self, _payment_hash: &str) -> Result<Option<PaymentResult>, Error> {
        let mut script = self.script.lock().await;
        match script.get_payment.len() {
            0 => Ok(None),
            1 => Ok(script.get_payment[0].clone()),
            _ => Ok(script
                .get_payment
                .pop_front()
                .flatten()
                .map(Some)
                .unwrap_or(None)),
        }
    }
}

fn config() -> FiberConfig {
    FiberConfig {
        // Keep the settlement loop fast; these tests never touch a real node.
        poll_interval: Duration::from_millis(1),
        payment_timeout: Duration::from_millis(30),
        fee_percent: 0,
        min_fee_reserve: 0,
        ..FiberConfig::rusd_testnet()
    }
}

fn backend(script: Script) -> (FiberBackend, Arc<MockNode>) {
    let node = MockNode::new(script);
    (FiberBackend::new(node.clone(), config()), node)
}

fn rusd() -> CurrencyUnit {
    CurrencyUnit::Custom("rusd".to_string())
}

/// The gRPC bridge always delivers `method` as an empty string; mirror that here.
fn incoming(amount: u64, unit: CurrencyUnit) -> IncomingPaymentOptions {
    IncomingPaymentOptions::Custom(Box::new(CustomIncomingPaymentOptions {
        method: String::new(),
        description: Some("fibernuts".to_string()),
        amount: Amount::new(amount, unit),
        unix_expiry: None,
        extra_json: None,
    }))
}

fn outgoing(max_fee: Option<u64>) -> OutgoingPaymentOptions {
    OutgoingPaymentOptions::Custom(Box::new(CustomOutgoingPaymentOptions {
        method: String::new(),
        request: INVOICE.to_string(),
        max_fee_amount: max_fee.map(|f| Amount::new(f, rusd())),
        timeout_secs: None,
        melt_options: None,
        extra_json: None,
        quote_id: QuoteId::new(),
    }))
}

fn hash_id() -> PaymentIdentifier {
    PaymentIdentifier::PaymentHash(cdk_fiber::wire::hash_from_hex(HASH_HEX).unwrap())
}

#[tokio::test]
async fn settings_advertise_the_fiber_method_and_the_configured_unit() {
    // cdk-mintd registers methods from the `custom` keys and aborts unless `unit` string-matches
    // its own `[ln].unit`.
    let (backend, _) = backend(Script::default());
    let settings = backend.get_settings().await.unwrap();

    assert_eq!(settings.unit, "rusd");
    assert!(settings.custom.contains_key("fiber"));
    assert!(settings.bolt11.is_none());
    assert!(settings.onchain.is_none());
}

#[tokio::test]
async fn an_incoming_request_creates_a_standard_auto_settling_invoice() {
    let (backend, node) = backend(Script::default());
    backend
        .create_incoming_payment_request(incoming(AMOUNT_ECASH, rusd()))
        .await
        .unwrap();

    let recorded = node.recorded.lock().await;
    let params = &recorded.new_invoices[0];
    assert_eq!(params.amount, AMOUNT_BASE);

    // Omitting both preimage and hash is what makes FNN auto-settle rather than hold the TLC.
    let json = serde_json::to_value(params).unwrap();
    let obj = json.as_object().unwrap();
    assert!(!obj.contains_key("payment_preimage"));
    assert!(!obj.contains_key("payment_hash"));
    assert!(
        obj.contains_key("udt_type_script"),
        "RUSD must be denominated"
    );
}

#[tokio::test]
async fn the_empty_method_delivered_by_the_grpc_bridge_is_accepted() {
    // cdk-payment-processor reconstructs `method` as "", so rejecting on it would break every
    // request the mint ever makes.
    let (backend, _) = backend(Script::default());
    assert!(backend
        .create_incoming_payment_request(incoming(AMOUNT_ECASH, rusd()))
        .await
        .is_ok());
}

#[tokio::test]
async fn an_incoming_request_in_a_foreign_unit_is_rejected() {
    let (backend, _) = backend(Script::default());
    assert!(backend
        .create_incoming_payment_request(incoming(AMOUNT_ECASH, CurrencyUnit::Sat))
        .await
        .is_err());
}

#[tokio::test]
async fn a_settled_invoice_credits_the_wallet() {
    let (backend, _) = backend(Script {
        invoice_status: Some(CkbInvoiceStatus::Paid),
        ..Script::default()
    });

    let paid = backend
        .check_incoming_payment_status(&hash_id())
        .await
        .unwrap();
    assert_eq!(paid.len(), 1);
    assert_eq!(paid[0].payment_amount.value(), AMOUNT_ECASH);
}

#[tokio::test]
async fn a_received_invoice_does_not_credit_the_wallet() {
    // `Received` means a TLC arrived but has NOT settled. Crediting here would mint ecash against
    // money the mint does not hold.
    let (backend, _) = backend(Script {
        invoice_status: Some(CkbInvoiceStatus::Received),
        ..Script::default()
    });

    assert!(backend
        .check_incoming_payment_status(&hash_id())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn an_unpaid_invoice_does_not_credit_the_wallet() {
    for status in [
        CkbInvoiceStatus::Open,
        CkbInvoiceStatus::Cancelled,
        CkbInvoiceStatus::Expired,
    ] {
        let (backend, _) = backend(Script {
            invoice_status: Some(status),
            ..Script::default()
        });
        assert!(
            backend
                .check_incoming_payment_status(&hash_id())
                .await
                .unwrap()
                .is_empty(),
            "{status:?} must not credit"
        );
    }
}

#[tokio::test]
async fn a_melt_quote_prices_from_the_nodes_dry_run_fee() {
    let routed_fee = 3 * SCALE as u128; // 3 ecash units
    let (backend, node) = backend(Script {
        send_payment: Some(payment(PaymentStatus::Created, routed_fee)),
        ..Script::default()
    });

    let quote = backend
        .get_payment_quote(&rusd(), outgoing(None))
        .await
        .unwrap();

    assert_eq!(quote.amount.value(), AMOUNT_ECASH);
    assert_eq!(quote.fee.value(), 3);
    assert_eq!(quote.state, MeltQuoteState::Unpaid);

    // The quote must probe, never dispatch a TLC.
    let recorded = node.recorded.lock().await;
    assert_eq!(recorded.sends.len(), 1);
    assert_eq!(recorded.sends[0].dry_run, Some(true));
}

#[tokio::test]
async fn an_unroutable_melt_quote_is_rejected() {
    let (backend, _) = backend(Script {
        send_error: true,
        ..Script::default()
    });
    assert!(backend
        .get_payment_quote(&rusd(), outgoing(None))
        .await
        .is_err());
}

#[tokio::test]
async fn a_successful_melt_reports_paid_and_charges_amount_plus_fee() {
    let fee = 2 * SCALE as u128;
    let (backend, _) = backend(Script {
        get_payment: VecDeque::from(vec![None, Some(payment(PaymentStatus::Success, fee))]),
        send_payment: Some(payment(PaymentStatus::Success, fee)),
        ..Script::default()
    });

    let result = backend.make_payment(&rusd(), outgoing(None)).await.unwrap();

    assert_eq!(result.status, MeltQuoteState::Paid);
    assert_eq!(result.total_spent.value(), AMOUNT_ECASH + 2);
    // FNN never exposes the preimage, so there is no proof to hand back.
    assert!(result.payment_proof.is_none());
}

#[tokio::test]
async fn a_failed_melt_reports_failed() {
    let (backend, _) = backend(Script {
        get_payment: VecDeque::from(vec![None, Some(payment(PaymentStatus::Failed, 0))]),
        send_payment: Some(payment(PaymentStatus::Failed, 0)),
        ..Script::default()
    });

    let result = backend.make_payment(&rusd(), outgoing(None)).await.unwrap();
    assert_eq!(result.status, MeltQuoteState::Failed);
    assert_eq!(result.total_spent.value(), 0);
}

#[tokio::test]
async fn a_melt_that_never_settles_reports_pending_never_failed() {
    // Reporting `Failed` on a timeout would return the wallet's proofs while the TLC may still
    // settle, letting it spend the same money twice.
    let (backend, _) = backend(Script {
        get_payment: VecDeque::from(vec![None, Some(payment(PaymentStatus::Inflight, 0))]),
        send_payment: Some(payment(PaymentStatus::Inflight, 0)),
        ..Script::default()
    });

    let result = backend.make_payment(&rusd(), outgoing(None)).await.unwrap();
    assert_eq!(result.status, MeltQuoteState::Pending);
    assert_eq!(result.total_spent.value(), 0);
}

#[tokio::test]
async fn an_in_flight_melt_is_never_dispatched_twice() {
    // FNN refuses to re-send a payment whose session is not `Failed`; a retried melt must report
    // the existing session instead of dispatching a second TLC.
    let (backend, node) = backend(Script {
        get_payment: VecDeque::from(vec![Some(payment(PaymentStatus::Inflight, 0))]),
        ..Script::default()
    });

    let result = backend.make_payment(&rusd(), outgoing(None)).await.unwrap();

    assert_eq!(result.status, MeltQuoteState::Pending);
    assert!(
        node.recorded.lock().await.sends.is_empty(),
        "a second TLC must not be dispatched"
    );
}

#[tokio::test]
async fn an_already_settled_melt_is_reported_without_re_paying() {
    let fee = SCALE as u128;
    let (backend, node) = backend(Script {
        get_payment: VecDeque::from(vec![Some(payment(PaymentStatus::Success, fee))]),
        ..Script::default()
    });

    let result = backend.make_payment(&rusd(), outgoing(None)).await.unwrap();

    assert_eq!(result.status, MeltQuoteState::Paid);
    assert!(node.recorded.lock().await.sends.is_empty());
}

#[tokio::test]
async fn a_melt_raises_the_fee_rate_when_the_reserve_exceeds_half_a_percent() {
    // 10 ecash units of fee on 100 units is 10%. Left at FNN's default 0.5% rate the ceiling is
    // clamped and the payment fails to route for a fee the mint already quoted.
    let (backend, node) = backend(Script {
        get_payment: VecDeque::from(vec![None, Some(payment(PaymentStatus::Success, 0))]),
        send_payment: Some(payment(PaymentStatus::Success, 0)),
        ..Script::default()
    });

    backend
        .make_payment(&rusd(), outgoing(Some(10)))
        .await
        .unwrap();

    let recorded = node.recorded.lock().await;
    let sent = &recorded.sends[0];
    assert_eq!(sent.dry_run, Some(false));
    assert_eq!(sent.max_fee_amount, Some(10 * SCALE as u128));

    let rate = sent
        .max_fee_rate
        .expect("rate must be raised above the default 5");
    assert!(rate >= 100, "10% of the amount needs 100ppt, got {rate}");
    assert!(AMOUNT_BASE * rate as u128 / 1000 >= 10 * SCALE as u128);
}

#[tokio::test]
async fn a_modest_fee_reserve_leaves_the_default_rate_alone() {
    let (backend, node) = backend(Script {
        get_payment: VecDeque::from(vec![None, Some(payment(PaymentStatus::Success, 0))]),
        send_payment: Some(payment(PaymentStatus::Success, 0)),
        ..Script::default()
    });

    // 0 ecash units of reserve is well under 0.5% of the amount.
    backend
        .make_payment(&rusd(), outgoing(Some(0)))
        .await
        .unwrap();

    assert_eq!(node.recorded.lock().await.sends[0].max_fee_rate, None);
}

#[tokio::test]
async fn an_outgoing_payment_the_node_never_saw_is_unknown_not_failed() {
    // `Failed` would let the mint hand the wallet its proofs back. The node simply has no record.
    let (backend, _) = backend(Script::default());

    let result = backend.check_outgoing_payment(&hash_id()).await.unwrap();
    assert_eq!(result.status, MeltQuoteState::Unknown);
    assert_eq!(result.total_spent.value(), 0);
}

#[tokio::test]
async fn a_known_outgoing_payment_reports_its_state() {
    let (backend, _) = backend(Script {
        get_payment: VecDeque::from(vec![Some(payment(PaymentStatus::Inflight, 0))]),
        ..Script::default()
    });

    let result = backend.check_outgoing_payment(&hash_id()).await.unwrap();
    assert_eq!(result.status, MeltQuoteState::Pending);
    assert!(result.payment_proof.is_none());
}

#[tokio::test]
async fn a_melt_in_a_foreign_unit_is_rejected() {
    let (backend, _) = backend(Script::default());
    assert!(backend
        .get_payment_quote(&CurrencyUnit::Sat, outgoing(None))
        .await
        .is_err());
    assert!(backend
        .make_payment(&CurrencyUnit::Sat, outgoing(None))
        .await
        .is_err());
}

#[tokio::test]
async fn the_event_stream_is_handed_out_exactly_once() {
    let (backend, _) = backend(Script::default());

    assert!(!backend.is_payment_event_stream_active());
    let _stream = backend.wait_payment_event().await.unwrap();
    assert!(backend.is_payment_event_stream_active());

    // The receiver is taken; a second subscription must fail rather than silently deadlock.
    assert!(backend.wait_payment_event().await.is_err());
}

#[tokio::test]
async fn dropping_the_stream_clears_the_active_flag() {
    let (backend, _) = backend(Script::default());

    let stream = backend.wait_payment_event().await.unwrap();
    assert!(backend.is_payment_event_stream_active());

    drop(stream);
    assert!(!backend.is_payment_event_stream_active());
}

#[tokio::test]
async fn a_settled_invoice_is_announced_on_the_event_stream() {
    use futures::StreamExt;

    let (backend, _) = backend(Script {
        invoice_status: Some(CkbInvoiceStatus::Paid),
        ..Script::default()
    });

    let mut stream = backend.wait_payment_event().await.unwrap();
    backend
        .create_incoming_payment_request(incoming(AMOUNT_ECASH, rusd()))
        .await
        .unwrap();
    backend.start().await.unwrap();

    let event = tokio::time::timeout(Duration::from_secs(2), stream.next())
        .await
        .expect("the sweeper must announce a settled invoice")
        .expect("stream must yield");

    match event {
        cdk_common::payment::Event::PaymentReceived(received) => {
            assert_eq!(received.payment_amount.value(), AMOUNT_ECASH);
            assert_eq!(received.payment_identifier, hash_id());
        }
        other => panic!("expected PaymentReceived, got {other:?}"),
    }

    backend.stop().await.unwrap();
}
