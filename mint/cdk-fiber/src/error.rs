//! Errors raised by the Fiber payment backend.

use std::fmt;

use thiserror::Error;

use crate::journal::JournalError;

/// Operational class of a Fiber RPC failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcFailureClass {
    /// No authoritative JSON-RPC response was received; a read-only query may be retried.
    RetryableTransport,
    /// The node or HTTP endpoint authoritatively rejected the request.
    AuthoritativeProtocol,
    /// A response arrived but could not be validated or decoded safely.
    InvalidResponse,
    /// The failure happened before or after the RPC boundary in local protocol logic.
    Local,
}

/// Everything that can go wrong between the mint and the Fiber node.
#[derive(Error)]
pub enum Error {
    /// Durable settlement correlation could not be read or updated safely.
    #[error(transparent)]
    Journal(#[from] JournalError),

    /// The HTTP request to the node never produced a JSON-RPC response.
    #[error("fiber node unreachable")]
    Transport(String),

    /// The configured request deadline elapsed without a complete response.
    #[error("fiber node `{operation}` request exceeded its deadline")]
    RpcTimeout {
        /// JSON-RPC method whose deadline elapsed.
        operation: &'static str,
    },

    /// The HTTP endpoint rejected the request before a JSON-RPC envelope was returned.
    #[error("fiber node returned HTTP status {status}")]
    HttpStatus {
        /// HTTP response status code.
        status: u16,
    },

    /// The node answered with a JSON-RPC error object.
    #[error("fiber node rpc error {code}")]
    Rpc {
        /// JSON-RPC error code.
        code: i64,
        /// JSON-RPC error message.
        message: String,
    },

    /// The node's response did not match the expected shape.
    #[error("fiber node returned an unexpected response")]
    Decode(String),

    /// A hex string was not a 32-byte `0x`-prefixed hash.
    #[error("invalid 32-byte hash")]
    InvalidHash(String),

    /// The mint asked for a payment method this backend does not serve.
    #[error("cdk-fiber serves only the `{method}` payment method")]
    UnsupportedMethod {
        /// The single method this backend serves.
        method: &'static str,
    },

    /// The mint asked to settle in a unit this backend does not serve.
    #[error("the mint requested an unsupported settlement unit")]
    UnitMismatch {
        /// The unit this backend was configured with.
        configured: String,
        /// The unit the mint requested.
        requested: String,
    },

    /// An amount could not be converted between ecash units and Fiber base units.
    #[error("amount {amount} overflows when scaled by {scale}")]
    AmountOverflow {
        /// The offending amount.
        amount: u128,
        /// The configured unit scale.
        scale: u64,
    },

    /// A Fiber invoice carried no amount, which this backend cannot price.
    #[error("fiber invoice carries no amount")]
    AmountlessInvoice,

    /// The mint omitted the amount needed to create a fixed-value Fiber invoice.
    #[error("incoming Fiber payment request carries no amount")]
    AmountlessIncomingRequest,

    /// A Fiber invoice belongs to a different chain than the configured Fiber node.
    #[error("fiber invoice network does not match the configured network")]
    InvoiceNetworkMismatch {
        /// The network configured for this payment backend.
        configured: String,
        /// The network encoded by the supplied invoice.
        invoice: String,
    },

    /// A Fiber invoice's Molecule-encoded UDT script could not be decoded unambiguously.
    #[error("fiber invoice carries an invalid asset script")]
    InvalidInvoiceAsset,

    /// A Fiber invoice is not denominated in the exact asset configured for this backend.
    #[error("fiber invoice asset does not match the configured settlement asset")]
    InvoiceAssetMismatch,

    /// A Fiber payment response referred to a different payment than the requested operation.
    #[error("fiber payment response does not match the requested payment")]
    PaymentHashMismatch,

    /// A terminal money result could not be tied to its durable quote and principal.
    #[error("terminal Fiber payment has no durable settlement operation")]
    MissingSettlementOperation,

    /// The mint looked a payment up by something other than its payment hash.
    #[error("cdk-fiber identifies payments only by payment hash")]
    UnsupportedIdentifier(String),

    /// `wait_payment_event` was called while another subscriber owns the stream.
    #[error("the payment event stream already has an active subscriber")]
    StreamAlreadyTaken,

    /// A backend setting cannot provide the required bounded behavior.
    #[error("invalid `{field}` configuration: {reason}")]
    InvalidConfiguration {
        /// Configuration field that failed validation.
        field: &'static str,
        /// Stable, non-sensitive explanation of the constraint.
        reason: &'static str,
    },
}

// Error variants retain raw node text for classification, but diagnostics must never render it.
impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl Error {
    /// Classify whether an RPC-related failure is retryable without inspecting error text.
    pub fn rpc_failure_class(&self) -> RpcFailureClass {
        match self {
            Self::Transport(_) | Self::RpcTimeout { .. } => RpcFailureClass::RetryableTransport,
            Self::HttpStatus { status }
                if *status == 408 || *status == 429 || (500..=599).contains(status) =>
            {
                RpcFailureClass::RetryableTransport
            }
            Self::HttpStatus { .. } | Self::Rpc { .. } => RpcFailureClass::AuthoritativeProtocol,
            Self::Decode(_)
            | Self::InvalidHash(_)
            | Self::PaymentHashMismatch
            | Self::InvoiceNetworkMismatch { .. }
            | Self::InvalidInvoiceAsset
            | Self::InvoiceAssetMismatch
            | Self::AmountlessInvoice
            | Self::Journal(JournalError::Conflict) => RpcFailureClass::InvalidResponse,
            _ => RpcFailureClass::Local,
        }
    }
}

impl From<Error> for cdk_common::payment::Error {
    fn from(e: Error) -> Self {
        Self::Backend(Box::new(e))
    }
}

impl From<JournalError> for cdk_common::payment::Error {
    fn from(e: JournalError) -> Self {
        Self::from(Error::Journal(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_and_protocol_failures_have_distinct_retry_classes() {
        assert_eq!(
            Error::Transport("disconnected".to_string()).rpc_failure_class(),
            RpcFailureClass::RetryableTransport
        );
        assert_eq!(
            Error::RpcTimeout {
                operation: "get_payment"
            }
            .rpc_failure_class(),
            RpcFailureClass::RetryableTransport
        );
        assert_eq!(
            Error::HttpStatus { status: 503 }.rpc_failure_class(),
            RpcFailureClass::RetryableTransport
        );
        assert_eq!(
            Error::Rpc {
                code: -32_000,
                message: "request rejected".to_string(),
            }
            .rpc_failure_class(),
            RpcFailureClass::AuthoritativeProtocol
        );
        assert_eq!(
            Error::HttpStatus { status: 400 }.rpc_failure_class(),
            RpcFailureClass::AuthoritativeProtocol
        );
        assert_eq!(
            Error::Decode("malformed response".to_string()).rpc_failure_class(),
            RpcFailureClass::InvalidResponse
        );
    }

    #[test]
    fn untrusted_error_fields_never_reach_display_or_debug_output() {
        let canary = "synthetic-bearer-secret-never-log";
        let errors = [
            Error::Transport(canary.to_string()),
            Error::Rpc {
                code: -32_000,
                message: canary.to_string(),
            },
            Error::Decode(canary.to_string()),
            Error::InvalidHash(canary.to_string()),
            Error::UnitMismatch {
                configured: "rusd".to_string(),
                requested: canary.to_string(),
            },
            Error::InvoiceNetworkMismatch {
                configured: canary.to_string(),
                invoice: canary.to_string(),
            },
            Error::UnsupportedIdentifier(canary.to_string()),
        ];

        for error in errors {
            assert!(!format!("{error}").contains(canary));
            assert!(!format!("{error:?}").contains(canary));
        }
    }
}
