//! JSON-RPC wire types for the Fiber Network Node (FNN).
//!
//! These mirror `fiber-json-types` but are re-declared here so the crate does not pull the
//! `ckb-*` dependency tree (which raises the MSRV to 1.95 and adds ~400 transitive packages)
//! for what amounts to a handful of structs.
//!
//! FNN encodes every integer as a `0x`-prefixed, minimal-form lowercase hex string: zero is
//! `"0x0"`, never `"0x00"`. Its deserializers reject redundant leading zeros, so the encoders
//! here must emit minimal form. Hashes are `0x`-prefixed 32-byte hex; note that FNN's *pubkeys*
//! are hex *without* a `0x` prefix — a different convention in the same payload.

use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Parses one of FNN's `0x`-prefixed hex integers. Leading zeros are tolerated on the way in;
/// only the encoder has to emit minimal form.
fn parse_hex_u128(raw: &str) -> Result<u128, String> {
    let body = raw
        .strip_prefix("0x")
        .ok_or_else(|| format!("expected a 0x-prefixed hex integer, got `{raw}`"))?;
    u128::from_str_radix(body, 16).map_err(|e| format!("bad hex integer `{raw}`: {e}"))
}

/// Encodes an optional `u64` the way FNN reads it. Serialize-only: no response field the mint
/// consumes carries one.
fn serialize_opt_hex_u64<S: serde::Serializer>(v: &Option<u64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(v) => s.serialize_str(&format!("0x{v:x}")),
        None => s.serialize_none(),
    }
}

/// A `#[serde(with = ...)]` codec for a required `0x`-hex integer.
macro_rules! hex_codec {
    ($m:ident, $t:ty, $parse:path) => {
        pub(crate) mod $m {
            use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

            pub fn serialize<S: Serializer>(v: &$t, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&format!("0x{:x}", v))
            }

            pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<$t, D::Error> {
                let raw = String::deserialize(d)?;
                $parse(&raw).map_err(D::Error::custom)
            }
        }
    };
}

/// The same, for an optional field: absent decodes to `None`, `None` encodes to `null`.
macro_rules! hex_codec_opt {
    ($m:ident, $t:ty, $parse:path) => {
        pub(crate) mod $m {
            use serde::{de::Error as _, Deserialize, Deserializer, Serializer};

            pub fn serialize<S: Serializer>(v: &Option<$t>, s: S) -> Result<S::Ok, S::Error> {
                match v {
                    Some(v) => s.serialize_str(&format!("0x{:x}", v)),
                    None => s.serialize_none(),
                }
            }

            pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<$t>, D::Error> {
                match Option::<String>::deserialize(d)? {
                    Some(raw) => $parse(&raw).map(Some).map_err(D::Error::custom),
                    None => Ok(None),
                }
            }
        }
    };
}

hex_codec!(hex_u128, u128, super::parse_hex_u128);
hex_codec_opt!(opt_hex_u128, u128, super::parse_hex_u128);

/// Renders a 32-byte hash the way FNN expects it: `0x` followed by 64 lowercase hex chars.
pub fn hash_to_hex(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Parses a 32-byte hash. FNN emits the `0x` prefix; it is tolerated as absent on input.
pub fn hash_from_hex(raw: &str) -> Result<[u8; 32], Error> {
    let body = raw.strip_prefix("0x").unwrap_or(raw);
    if body.len() != 64 {
        return Err(Error::InvalidHash(raw.to_string()));
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&body[i * 2..i * 2 + 2], 16)
            .map_err(|_| Error::InvalidHash(raw.to_string()))?;
    }
    Ok(out)
}

/// A CKB script, as FNN's JSON-RPC encodes it. Identifies the UDT (e.g. RUSD).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Script {
    /// `0x`-prefixed 32-byte code hash.
    pub code_hash: String,
    /// One of `type`, `data`, `data1`, `data2`.
    pub hash_type: String,
    /// `0x`-prefixed script args.
    pub args: String,
}

/// The invoice's network. Serialized as the bare PascalCase variant name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    /// Mainnet.
    Fibb,
    /// Testnet.
    Fibt,
    /// Devnet.
    Fibd,
}

/// Lifecycle of an invoice held by the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CkbInvoiceStatus {
    /// Created, unpaid.
    Open,
    /// Cancelled by the payee.
    Cancelled,
    /// Past its expiry.
    Expired,
    /// A TLC arrived but has not settled. Only reachable for hold invoices.
    Received,
    /// Settled. The only status that means the mint holds the funds.
    Paid,
}

/// Parameters for `new_invoice`.
///
/// `payment_preimage` and `payment_hash` are deliberately absent. FNN treats *both* being
/// omitted as a request for a standard invoice: it generates a random preimage, stores it, and
/// auto-settles an arriving TLC. Supplying only `payment_hash` would instead create a *hold*
/// invoice, whose TLC stalls in `Received` until `settle_invoice` is called. A mint must never
/// hold, so both fields stay off the wire.
#[derive(Debug, Clone, Serialize)]
pub struct NewInvoiceParams {
    /// Amount in the UDT's base units (RUSD has 8 decimals).
    #[serde(with = "hex_u128")]
    pub amount: u128,
    /// Human-readable memo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Must match the node's network or FNN rejects the call.
    pub currency: Currency,
    /// Seconds until the invoice expires.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_hex_u64"
    )]
    pub expiry: Option<u64>,
    /// The UDT this invoice is denominated in. Absent means native CKB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udt_type_script: Option<Script>,
}

/// The body of a decoded invoice.
#[derive(Debug, Clone, Deserialize)]
pub struct InvoiceData {
    /// `0x`-prefixed payment hash.
    pub payment_hash: String,
}

/// A decoded Fiber invoice.
#[derive(Debug, Clone, Deserialize)]
pub struct CkbInvoice {
    /// The invoice's network.
    pub currency: Currency,
    /// Amount in the UDT's base units. Absent for amountless invoices.
    #[serde(default, with = "opt_hex_u128")]
    pub amount: Option<u128>,
    /// Payload carrying the payment hash.
    pub data: InvoiceData,
}

/// Result of `new_invoice`.
#[derive(Debug, Clone, Deserialize)]
pub struct InvoiceResult {
    /// The bech32m-encoded invoice the payer scans.
    pub invoice_address: String,
    /// The decoded invoice.
    pub invoice: CkbInvoice,
}

/// Result of `get_invoice`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetInvoiceResult {
    /// The decoded invoice.
    pub invoice: CkbInvoice,
    /// Current lifecycle status.
    pub status: CkbInvoiceStatus,
}

/// Result of `parse_invoice`.
#[derive(Debug, Clone, Deserialize)]
pub struct ParseInvoiceResult {
    /// The decoded invoice.
    pub invoice: CkbInvoice,
}

/// Terminal and in-flight states of an outgoing payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PaymentStatus {
    /// Session created; no TLC dispatched yet.
    Created,
    /// A TLC is in flight.
    Inflight,
    /// Settled.
    Success,
    /// Terminally failed.
    Failed,
}

/// Parameters for `send_payment`.
///
/// Only `invoice` identifies the payment: FNN merges the amount and `udt_type_script` out of the
/// invoice itself, and rejects the call if a field passed here disagrees with it. Passing them
/// redundantly buys nothing and risks a `does not match the invoice` error.
#[derive(Debug, Clone, Serialize)]
pub struct SendPaymentParams {
    /// The bech32m invoice to pay.
    pub invoice: String,
    /// Absolute fee ceiling in the UDT's base units.
    #[serde(skip_serializing_if = "Option::is_none", with = "opt_hex_u128")]
    pub max_fee_amount: Option<u128>,
    /// Fee ceiling as parts-per-thousand of the amount. FNN clamps the effective ceiling to
    /// `min(max_fee_amount, amount * max_fee_rate / 1000)`, defaulting the rate to 5 (0.5%),
    /// so a reserve above 0.5% is silently cut unless this is raised to match.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_hex_u64"
    )]
    pub max_fee_rate: Option<u64>,
    /// Compute a route and its fee without dispatching a TLC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// Result of both `send_payment` and `get_payment`.
///
/// There is no preimage field, under any build configuration. FNN keeps the preimage on its
/// internal `PaymentAttempt` and never surfaces it through the RPC layer, so a mint settling
/// over Fiber cannot populate cdk's `payment_proof`.
#[derive(Debug, Clone, Deserialize)]
pub struct PaymentResult {
    /// `0x`-prefixed payment hash.
    pub payment_hash: String,
    /// Current status.
    pub status: PaymentStatus,
    /// Routing fee actually paid, in the UDT's base units. Populated on a `dry_run` too.
    #[serde(with = "hex_u128")]
    pub fee: u128,
    /// Free-form failure reason when `status` is `Failed`.
    #[serde(default)]
    pub failed_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Req {
        #[serde(with = "hex_u128")]
        a: u128,
        #[serde(default, with = "opt_hex_u128")]
        b: Option<u128>,
    }

    #[test]
    fn integers_serialize_in_minimal_hex_form() {
        let json = serde_json::to_string(&Req { a: 0, b: Some(100) }).unwrap();
        assert_eq!(json, r#"{"a":"0x0","b":"0x64"}"#);
    }

    #[test]
    fn zero_is_0x0_never_0x00() {
        // FNN's deserializer rejects redundant leading zeros, so this is load-bearing.
        let json = serde_json::to_string(&Req { a: 0, b: None }).unwrap();
        assert!(json.contains(r#""a":"0x0""#), "{json}");
    }

    #[test]
    fn integers_round_trip() {
        let v = Req {
            a: u128::MAX,
            b: Some(u128::MAX),
        };
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(serde_json::from_str::<Req>(&json).unwrap(), v);
    }

    #[test]
    fn hex_integers_require_the_0x_prefix() {
        assert!(serde_json::from_str::<Req>(r#"{"a":"64"}"#).is_err());
    }

    #[test]
    fn absent_optional_integer_decodes_as_none() {
        assert_eq!(
            serde_json::from_str::<Req>(r#"{"a":"0x1"}"#).unwrap().b,
            None
        );
    }

    #[test]
    fn hashes_round_trip_through_hex() {
        let bytes = [0xabu8; 32];
        let hex = hash_to_hex(&bytes);
        assert_eq!(hex.len(), 66);
        assert!(hex.starts_with("0xab"));
        assert_eq!(hash_from_hex(&hex).unwrap(), bytes);
    }

    #[test]
    fn hashes_parse_with_or_without_the_prefix() {
        let bare = "5e51a85b7382b235440249867bc49e43fb30afb21bcf4663cb2ebf4f97c60078";
        assert_eq!(
            hash_from_hex(bare).unwrap(),
            hash_from_hex(&format!("0x{bare}")).unwrap()
        );
    }

    #[test]
    fn wrong_length_hashes_are_rejected() {
        assert!(hash_from_hex("0xdead").is_err());
        assert!(hash_from_hex("0xzz").is_err());
    }

    #[test]
    fn new_invoice_params_omit_preimage_and_hash() {
        // Both absent is what makes FNN mint a standard, auto-settling invoice.
        let json = serde_json::to_value(NewInvoiceParams {
            amount: 100,
            description: None,
            currency: Currency::Fibt,
            expiry: None,
            udt_type_script: None,
        })
        .unwrap();
        let obj = json.as_object().unwrap();
        assert!(!obj.contains_key("payment_preimage"));
        assert!(!obj.contains_key("payment_hash"));
        assert_eq!(obj.get("currency").unwrap(), "Fibt");
    }

    #[test]
    fn invoice_status_uses_bare_pascal_case() {
        assert_eq!(
            serde_json::to_string(&CkbInvoiceStatus::Paid).unwrap(),
            r#""Paid""#
        );
        assert_eq!(
            serde_json::from_str::<CkbInvoiceStatus>(r#""Received""#).unwrap(),
            CkbInvoiceStatus::Received
        );
    }

    #[test]
    fn payment_result_tolerates_the_debug_only_routers_field() {
        // `routers` is #[cfg(debug_assertions)] on the node; a release node omits it entirely.
        let with_routers =
            r#"{"payment_hash":"0x00","status":"Success","fee":"0x2a","routers":[]}"#;
        let r: PaymentResult = serde_json::from_str(with_routers).unwrap();
        assert_eq!(r.status, PaymentStatus::Success);
        assert_eq!(r.fee, 42);
        assert!(r.failed_error.is_none());
    }
}
