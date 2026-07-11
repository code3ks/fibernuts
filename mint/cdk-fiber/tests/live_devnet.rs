//! Money-safety invariants, checked against a **live** pair of Fiber nodes.
//!
//! Ignored by default: `make ci` never touches a node. Bring up two connected nodes with a channel
//! whose liquidity flows *peer → mint*, then:
//!
//! ```sh
//! FIBERNUTS_TEST_RPC=http://127.0.0.1:8300 \
//! FIBERNUTS_TEST_PEER_RPC=http://127.0.0.1:8301 \
//! FIBERNUTS_TEST_NETWORK=devnet \
//! FIBERNUTS_TEST_UDT_CODE_HASH=0x… FIBERNUTS_TEST_UDT_HASH_TYPE=data1 FIBERNUTS_TEST_UDT_ARGS=0x… \
//! cargo test --test live_devnet -- --ignored --nocapture
//! ```
//!
//! The three rules under test are the ones that would let a mint lose money:
//! a held TLC must not credit, an unseen payment must not read as failed, and a settled invoice
//! must credit exactly what landed.

use std::sync::Arc;
use std::time::{Duration, Instant};

use cdk_common::nuts::MeltQuoteState;
use cdk_common::payment::{
    CustomIncomingPaymentOptions, IncomingPaymentOptions, MintPayment, PaymentIdentifier,
};
use cdk_common::{Amount, CurrencyUnit};
use serde_json::{json, Value};

use cdk_fiber::wire::{Currency, Script};
use cdk_fiber::{FiberBackend, FiberConfig, HttpFiberRpc};

const SCALE: u64 = 1_000_000;
/// 25 ecash units, i.e. $0.25 at cent granularity.
const AMOUNT_ECASH: u64 = 25;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Skips the test body when the devnet environment is absent.
macro_rules! require_env {
    () => {
        match (env("FIBERNUTS_TEST_RPC"), env("FIBERNUTS_TEST_PEER_RPC")) {
            (Some(mint), Some(peer)) => (mint, peer),
            _ => {
                eprintln!("skipping: set FIBERNUTS_TEST_RPC and FIBERNUTS_TEST_PEER_RPC");
                return;
            }
        }
    };
}

fn udt_script() -> Option<Script> {
    Some(Script {
        code_hash: env("FIBERNUTS_TEST_UDT_CODE_HASH")?,
        hash_type: env("FIBERNUTS_TEST_UDT_HASH_TYPE").unwrap_or_else(|| "type".into()),
        args: env("FIBERNUTS_TEST_UDT_ARGS")?,
    })
}

fn currency() -> Currency {
    match env("FIBERNUTS_TEST_NETWORK").as_deref() {
        Some("mainnet") => Currency::Fibb,
        Some("testnet") => Currency::Fibt,
        _ => Currency::Fibd,
    }
}

fn backend(rpc_url: &str) -> FiberBackend {
    FiberBackend::new(
        Arc::new(HttpFiberRpc::new(rpc_url)),
        FiberConfig {
            unit: CurrencyUnit::Custom("rusd".into()),
            currency: currency(),
            udt_type_script: udt_script(),
            unit_scale: SCALE,
            poll_interval: Duration::from_millis(250),
            payment_timeout: Duration::from_secs(20),
            ..FiberConfig::rusd_testnet()
        },
    )
}

/// A raw JSON-RPC call, used only for the things cdk-fiber deliberately cannot do — such as
/// minting a *hold* invoice, which a solvent mint must never create.
async fn rpc(url: &str, method: &str, params: Value) -> Value {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": [params]});
    let response: Value = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .expect("node unreachable")
        .json()
        .await
        .expect("node returned malformed json");

    assert!(
        response.get("error").is_none(),
        "{method} failed: {}",
        response["error"]
    );
    response["result"].clone()
}

async fn invoice_status(url: &str, payment_hash: &str) -> String {
    rpc(url, "get_invoice", json!({ "payment_hash": payment_hash }))
        .await
        .get("status")
        .and_then(Value::as_str)
        .expect("no status")
        .to_string()
}

/// Polls until the invoice reaches `wanted`, or panics with the last status seen.
async fn await_status(url: &str, payment_hash: &str, wanted: &str, within: Duration) {
    let deadline = Instant::now() + within;
    let mut last = String::new();
    while Instant::now() < deadline {
        last = invoice_status(url, payment_hash).await;
        if last == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    panic!("invoice never reached {wanted}; last status was {last}");
}

fn incoming(amount: u64) -> IncomingPaymentOptions {
    IncomingPaymentOptions::Custom(Box::new(CustomIncomingPaymentOptions {
        // The gRPC bridge always delivers this empty; mirror it.
        method: String::new(),
        description: Some("fibernuts live test".into()),
        amount: Amount::new(amount, CurrencyUnit::Custom("rusd".into())),
        unix_expiry: None,
        extra_json: None,
    }))
}

#[tokio::test]
#[ignore = "requires a live two-node Fiber devnet"]
async fn a_settled_invoice_credits_exactly_what_landed() {
    let (mint_rpc, peer_rpc) = require_env!();
    let backend = backend(&mint_rpc);

    let created = backend
        .create_incoming_payment_request(incoming(AMOUNT_ECASH))
        .await
        .expect("could not create invoice");

    let PaymentIdentifier::PaymentHash(hash) = created.request_lookup_id.clone() else {
        panic!("expected a payment-hash identifier");
    };
    let hash_hex = cdk_fiber::wire::hash_to_hex(&hash);

    // Nothing has been paid yet.
    let before = backend
        .check_incoming_payment_status(&created.request_lookup_id)
        .await
        .expect("status check failed");
    assert!(before.is_empty(), "an unpaid invoice must not credit");

    rpc(
        &peer_rpc,
        "send_payment",
        json!({ "invoice": created.request }),
    )
    .await;
    await_status(&mint_rpc, &hash_hex, "Paid", Duration::from_secs(30)).await;

    let credited = backend
        .check_incoming_payment_status(&created.request_lookup_id)
        .await
        .expect("status check failed");

    assert_eq!(credited.len(), 1, "a settled invoice credits exactly once");
    assert_eq!(
        credited[0].payment_amount.value(),
        AMOUNT_ECASH,
        "credited amount must equal the invoiced amount"
    );
}

#[tokio::test]
#[ignore = "requires a live two-node Fiber devnet"]
async fn a_held_tlc_is_never_credited() {
    let (mint_rpc, peer_rpc) = require_env!();
    let backend = backend(&mint_rpc);

    // A hold invoice: `payment_hash` supplied, `payment_preimage` withheld. The node accepts the
    // TLC and parks it in `Received` until someone reveals the preimage. cdk-fiber never creates
    // one; we forge it here precisely to prove the backend refuses to credit it.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let payment_hash = format!("0x{seed:064x}");

    let mut params = json!({
        "amount": format!("0x{:x}", AMOUNT_ECASH as u128 * SCALE as u128),
        "currency": currency(),
        "payment_hash": payment_hash,
        "description": "held tlc",
    });
    if let Some(script) = udt_script() {
        params["udt_type_script"] = serde_json::to_value(script).unwrap();
    }
    let created = rpc(&mint_rpc, "new_invoice", params).await;
    let invoice = created["invoice_address"].as_str().unwrap().to_string();

    rpc(&peer_rpc, "send_payment", json!({ "invoice": invoice })).await;
    await_status(
        &mint_rpc,
        &payment_hash,
        "Received",
        Duration::from_secs(30),
    )
    .await;

    let identifier =
        PaymentIdentifier::PaymentHash(cdk_fiber::wire::hash_from_hex(&payment_hash).unwrap());
    let credited = backend
        .check_incoming_payment_status(&identifier)
        .await
        .expect("status check failed");

    // Release the parked TLC before asserting, so a failure here cannot strand the peer's funds.
    rpc(
        &mint_rpc,
        "cancel_invoice",
        json!({ "payment_hash": payment_hash }),
    )
    .await;

    assert!(
        credited.is_empty(),
        "a Received (held, unsettled) TLC must never credit a wallet — the mint does not hold those funds"
    );
}

#[tokio::test]
#[ignore = "requires a live two-node Fiber devnet"]
async fn a_payment_the_node_never_saw_is_unknown_not_failed() {
    let (mint_rpc, _) = require_env!();
    let backend = backend(&mint_rpc);

    let identifier = PaymentIdentifier::PaymentHash([0x11; 32]);
    let result = backend
        .check_outgoing_payment(&identifier)
        .await
        .expect("check_outgoing_payment must not error on an unknown hash");

    assert_eq!(
        result.status,
        MeltQuoteState::Unknown,
        "an unseen payment must read as Unknown; Failed would hand a wallet its proofs back"
    );
    assert_eq!(result.total_spent.value(), 0);
    assert!(result.payment_proof.is_none(), "fnn exposes no preimage");
}
