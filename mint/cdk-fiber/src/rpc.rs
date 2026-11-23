//! The Fiber node JSON-RPC transport.
//!
//! [`FiberRpc`] is the seam the backend logic is written against, so the `MintPayment`
//! implementation can be exercised against a mock without a live node.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::Error;
use crate::wire::{
    GetInvoiceResult, InvoiceResult, NewInvoiceParams, ParseInvoiceResult, PaymentResult,
    SendPaymentParams,
};

/// The subset of FNN's JSON-RPC surface a Cashu mint needs.
#[allow(clippy::double_must_use)] // async-trait generates must-use futures on newer compilers.
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
    pub fn new(url: impl Into<String>) -> Result<Self, Error> {
        Self::with_timeouts(url, Duration::from_secs(3), Duration::from_secs(10))
    }

    /// Build a transport with explicit connection and complete-request deadlines.
    pub fn with_timeouts(
        url: impl Into<String>,
        connect_timeout: Duration,
        request_timeout: Duration,
    ) -> Result<Self, Error> {
        if connect_timeout.is_zero() {
            return Err(Error::InvalidConfiguration {
                field: "rpc_connect_timeout",
                reason: "must be greater than zero",
            });
        }
        if request_timeout.is_zero() {
            return Err(Error::InvalidConfiguration {
                field: "rpc_request_timeout",
                reason: "must be greater than zero",
            });
        }
        let client = reqwest::Client::builder()
            .connect_timeout(connect_timeout)
            .timeout(request_timeout)
            .build()
            .map_err(|error| Error::Transport(error.to_string()))?;
        Ok(Self {
            client,
            url: url.into(),
            next_id: AtomicU64::new(1),
        })
    }

    async fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &'static str,
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
            .map_err(|error| request_error(method, error))?;

        if !response.status().is_success() {
            return Err(Error::HttpStatus {
                status: response.status().as_u16(),
            });
        }

        let envelope: RpcResponse<R> = response
            .json()
            .await
            .map_err(|error| request_error(method, error))?;

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

fn request_error(operation: &'static str, error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::RpcTimeout { operation }
    } else if error.is_decode() {
        Error::Decode(format!("{operation}: {}", error.without_url()))
    } else {
        Error::Transport(error.without_url().to_string())
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;
    use crate::error::RpcFailureClass;

    const TEST_HASH: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    fn local_server(response: &'static [u8], delay: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            thread::sleep(delay);
            let _ = stream.write_all(response);
        });
        format!("http://{address}")
    }

    #[test]
    fn unknown_payment_is_recognised_from_the_nodes_wording() {
        // Preserved by the pinned Fiber v0.10.1 RPC implementation.
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

    #[test]
    fn http_deadlines_must_be_positive() {
        assert!(HttpFiberRpc::with_timeouts(
            "http://127.0.0.1:8227",
            Duration::ZERO,
            Duration::from_secs(1),
        )
        .is_err());
        assert!(HttpFiberRpc::with_timeouts(
            "http://127.0.0.1:8227",
            Duration::from_secs(1),
            Duration::ZERO,
        )
        .is_err());
    }

    #[tokio::test]
    async fn an_unresponsive_http_endpoint_reaches_the_request_deadline() {
        let url = local_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            Duration::from_millis(200),
        );
        let rpc =
            HttpFiberRpc::with_timeouts(url, Duration::from_secs(1), Duration::from_millis(20))
                .unwrap();

        let error = rpc.get_payment(TEST_HASH).await.unwrap_err();
        assert!(matches!(error, Error::RpcTimeout { .. }));
    }

    #[tokio::test]
    async fn malformed_http_json_is_an_invalid_response() {
        let url = local_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nnot-json",
            Duration::ZERO,
        );
        let rpc = HttpFiberRpc::new(url).unwrap();

        let error = rpc.get_payment(TEST_HASH).await.unwrap_err();
        assert!(matches!(error, Error::Decode(_)));
        assert_eq!(error.rpc_failure_class(), RpcFailureClass::InvalidResponse);
    }

    #[tokio::test]
    async fn overloaded_http_endpoint_is_retryable_without_parsing_its_body() {
        let url = local_server(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            Duration::ZERO,
        );
        let rpc = HttpFiberRpc::new(url).unwrap();

        let error = rpc.get_payment(TEST_HASH).await.unwrap_err();
        assert!(matches!(error, Error::HttpStatus { status: 503 }));
        assert_eq!(
            error.rpc_failure_class(),
            RpcFailureClass::RetryableTransport
        );
    }

    #[tokio::test]
    async fn disconnected_transport_errors_do_not_expose_url_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let rpc = HttpFiberRpc::new(format!("http://operator:synthetic-secret@{address}")).unwrap();

        let error = rpc.get_payment(TEST_HASH).await.unwrap_err();
        assert!(matches!(error, Error::Transport(_)));
        assert!(!error.to_string().contains("synthetic-secret"));
    }
}
