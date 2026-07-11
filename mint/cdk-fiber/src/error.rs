//! Errors raised by the Fiber payment backend.

use thiserror::Error;

/// Everything that can go wrong between the mint and the Fiber node.
#[derive(Debug, Error)]
pub enum Error {
    /// The HTTP request to the node never produced a JSON-RPC response.
    #[error("fiber node unreachable: {0}")]
    Transport(String),

    /// The node answered with a JSON-RPC error object.
    #[error("fiber node rpc error {code}: {message}")]
    Rpc {
        /// JSON-RPC error code.
        code: i64,
        /// JSON-RPC error message.
        message: String,
    },

    /// The node's response did not match the expected shape.
    #[error("fiber node returned an unexpected response: {0}")]
    Decode(String),

    /// A hex string was not a 32-byte `0x`-prefixed hash.
    #[error("invalid 32-byte hash: {0}")]
    InvalidHash(String),

    /// The mint asked for a payment method this backend does not serve.
    #[error("cdk-fiber serves only the `{method}` payment method")]
    UnsupportedMethod {
        /// The single method this backend serves.
        method: &'static str,
    },

    /// The mint asked to settle in a unit this backend does not serve.
    #[error(
        "cdk-fiber is configured for unit `{configured}`, but the mint asked for `{requested}`"
    )]
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

    /// The mint looked a payment up by something other than its payment hash.
    #[error("cdk-fiber identifies payments by payment hash, got {0}")]
    UnsupportedIdentifier(String),

    /// `wait_payment_event` was called more than once.
    #[error("the payment event stream has already been taken")]
    StreamAlreadyTaken,
}

impl From<Error> for cdk_common::payment::Error {
    fn from(e: Error) -> Self {
        Self::Lightning(Box::new(e))
    }
}
