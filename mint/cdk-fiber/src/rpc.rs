//! The Fiber node JSON-RPC transport.
//!
//! [`FiberRpc`] is the seam the backend logic is written against, so the `MintPayment`
//! implementation can be exercised against a mock without a live node.

use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::Error;
use crate::wire::{
    GetInvoiceResult, InvoiceResult, NewInvoiceParams, ParseInvoiceResult, PaymentResult,
    SendPaymentParams,
};

/// The subset of FNN's JSON-RPC surface a Cashu mint needs.
#[async_trait]
pub trait FiberRpc: std::fmt::Debug + Send + Sync {
    /// Create an invoice payable to this node.
    async fn new_invoice(&self, params: NewInvoiceParams) -> Result<InvoiceResult, Error>;

    /// Look up an invoice this node issued.
    async fn get_invoice(&self, payment_hash: &str) -> Result<GetInvoiceResult, Error>;

    /// Decode a bech32m invoice without paying it.
    async fn parse_invoice(&self, invoice: &str) -> Result<ParseInvoiceResult, Error>;

    /// Route and (unless `dry_run`) dispatch a payment.
    async fn send_payment(&self, params: SendPaymentParams) -> Result<PaymentResult, Error>;

    /// Look up an outgoing payment. `None` means the node has never seen this hash.
    async fn get_payment(&self, payment_hash: &str) -> Result<Option<PaymentResult>, Error>;
}

/// FNN reports an unknown payment hash as an error rather than an empty result, so the text is
/// the only signal that a payment was never dispatched — which must not be read as a failure.
fn is_unknown_payment(message: &str) -> bool {
    message
        .to_ascii_lowercase()
        .contains("payment session not found")
}

#[derive(Serialize)]
struct RpcRequest<'a, P> {
    jsonrpc: &'a str,
    id: u64,
    method: &'a str,
    params: [P; 1],
}

#[derive(serde::Deserialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(serde::Deserialize)]
struct RpcResponse<R> {
    result: Option<R>,
    error: Option<RpcError>,
}

/// A [`FiberRpc`] that speaks JSON-RPC 2.0 over HTTP to a Fiber node.
#[derive(Debug)]
pub struct HttpFiberRpc {
    client: reqwest::Client,
    url: String,
    next_id: AtomicU64,
}

impl HttpFiberRpc {
    /// Point the transport at a node's RPC endpoint, e.g. `http://127.0.0.1:8227`.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            url: url.into(),
            next_id: AtomicU64::new(1),
        }
    }

    async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R, Error> {
        let body = RpcRequest {
            jsonrpc: "2.0",
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            method,
            params: [params],
        };

        let response = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Transport(e.to_string()))?;

        let envelope: RpcResponse<R> = response
            .json()
            .await
            .map_err(|e| Error::Decode(format!("{method}: {e}")))?;

        if let Some(err) = envelope.error {
            return Err(Error::Rpc {
                code: err.code,
                message: err.message,
            });
        }

        envelope.result.ok_or_else(|| {
            Error::Decode(format!(
                "{method}: response carried neither result nor error"
            ))
        })
    }
}

#[derive(Serialize)]
struct PaymentHashParam<'a> {
    payment_hash: &'a str,
}

#[derive(Serialize)]
struct InvoiceParam<'a> {
    invoice: &'a str,
}

#[async_trait]
impl FiberRpc for HttpFiberRpc {
    async fn new_invoice(&self, params: NewInvoiceParams) -> Result<InvoiceResult, Error> {
        self.call("new_invoice", params).await
    }

    async fn get_invoice(&self, payment_hash: &str) -> Result<GetInvoiceResult, Error> {
        self.call("get_invoice", PaymentHashParam { payment_hash })
            .await
    }

    async fn parse_invoice(&self, invoice: &str) -> Result<ParseInvoiceResult, Error> {
        self.call("parse_invoice", InvoiceParam { invoice }).await
    }

    async fn send_payment(&self, params: SendPaymentParams) -> Result<PaymentResult, Error> {
        self.call("send_payment", params).await
    }

    async fn get_payment(&self, payment_hash: &str) -> Result<Option<PaymentResult>, Error> {
        match self
            .call::<_, PaymentResult>("get_payment", PaymentHashParam { payment_hash })
            .await
        {
            Ok(result) => Ok(Some(result)),
            Err(Error::Rpc { message, .. }) if is_unknown_payment(&message) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_payment_is_recognised_from_the_nodes_wording() {
        // Verbatim from fnn 0.9.0-rc2.
        assert!(is_unknown_payment(
            "InvalidParameter: Payment session not found: Hash256(0x1111)"
        ));
    }

    #[test]
    fn other_rpc_errors_are_not_mistaken_for_an_unknown_payment() {
        assert!(!is_unknown_payment(
            "Send payment error: Failed to build route, no path found"
        ));
        assert!(!is_unknown_payment("invoice already exists"));
    }

    #[test]
    fn requests_wrap_params_in_a_single_element_array() {
        let body = RpcRequest {
            jsonrpc: "2.0",
            id: 7,
            method: "get_payment",
            params: [PaymentHashParam {
                payment_hash: "0xab",
            }],
        };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["params"].as_array().unwrap().len(), 1);
        assert_eq!(json["params"][0]["payment_hash"], "0xab");
        assert_eq!(json["jsonrpc"], "2.0");
    }
}
