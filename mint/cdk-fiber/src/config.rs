//! Backend configuration.

use std::time::Duration;

use cdk_common::CurrencyUnit;

use crate::wire::{Currency, Script};

/// The RUSD UDT type script on CKB testnet, as whitelisted by Fiber v0.10.1.
pub fn rusd_testnet_script() -> Script {
    Script {
        code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a".into(),
        hash_type: "type".into(),
        args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b".into(),
    }
}

/// How the backend talks to its Fiber node and prices what it settles.
#[derive(Debug, Clone)]
pub struct FiberConfig {
    /// Canonical public URL of the Cashu mint this processor serves. Journal records are bound to
    /// this URL so a database cannot be reused silently for another issuer.
    pub mint_url: String,

    /// The unit the mint issues. It must resolve to the same normalized CDK currency unit as
    /// `[payment_backend].unit` and the gRPC processor's `supported_units` allowlist.
    pub unit: CurrencyUnit,

    /// The network of the invoices this node issues. FNN rejects a mismatch with its own chain.
    pub currency: Currency,

    /// The UDT to denominate invoices in. `None` settles in native CKB.
    pub udt_type_script: Option<Script>,

    /// Base units per ecash unit. For RUSD (8 decimals) at cent granularity this is `1_000_000`.
    pub unit_scale: u64,

    /// How long a mint invoice stays payable.
    pub invoice_expiry: Duration,

    /// Percentage cushion added to the node's routed fee when quoting a melt.
    pub fee_percent: u8,

    /// Smallest fee reserve, in ecash units, charged on any melt.
    pub min_fee_reserve: u64,

    /// How often to poll the node for invoice settlement and payment progress.
    pub poll_interval: Duration,

    /// Maximum time allowed to establish an HTTP connection to the Fiber node.
    pub rpc_connect_timeout: Duration,

    /// Maximum time allowed for one complete Fiber JSON-RPC request and response.
    pub rpc_request_timeout: Duration,

    /// Longest delay between read-only reconciliation attempts after repeated errors.
    pub reconciliation_max_backoff: Duration,

    /// Maximum number of settlement records reconciled concurrently.
    pub reconciliation_concurrency: usize,

    /// How long background invoice reconciliation continues after the invoice deadline. A record
    /// remains durable after this grace period and can still be reconciled by an explicit status
    /// check.
    pub incoming_watch_grace: Duration,

    /// How long `make_payment` waits for a terminal payment status before reporting `Pending`.
    pub payment_timeout: Duration,
}

impl FiberConfig {
    /// The defaults fibernuts ships: RUSD on testnet, one ecash unit per RUSD cent.
    pub fn rusd_testnet() -> Self {
        Self {
            mint_url: "http://127.0.0.1:8085".into(),
            unit: CurrencyUnit::custom("rusd"),
            currency: Currency::Fibt,
            udt_type_script: Some(rusd_testnet_script()),
            unit_scale: 1_000_000,
            invoice_expiry: Duration::from_secs(3600),
            fee_percent: 1,
            min_fee_reserve: 1,
            poll_interval: Duration::from_secs(3),
            rpc_connect_timeout: Duration::from_secs(3),
            rpc_request_timeout: Duration::from_secs(10),
            reconciliation_max_backoff: Duration::from_secs(60),
            reconciliation_concurrency: 8,
            incoming_watch_grace: Duration::from_secs(86_400),
            payment_timeout: Duration::from_secs(60),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_unit_renders_as_the_string_mintd_must_be_configured_with() {
        assert_eq!(FiberConfig::rusd_testnet().unit.to_string(), "rusd");
    }

    #[test]
    fn the_rusd_script_matches_the_nodes_whitelist() {
        // Verbatim from the testnet node's `udt_cfg_infos` (chain_hash 0x10639e08…). A truncated
        // `args` would build invoices the network does not recognise as RUSD, so it must be the
        // full 32-byte owner-lock hash — 66 chars including the `0x`.
        let s = rusd_testnet_script();
        assert_eq!(s.hash_type, "type");
        assert_eq!(s.code_hash.len(), 66, "code_hash must be a 32-byte hash");
        assert_eq!(
            s.args.len(),
            66,
            "args must be the full 32-byte owner-lock hash"
        );
        assert_eq!(
            s.args,
            "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
        );
    }
}
