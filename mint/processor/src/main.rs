//! `fibernuts-processor` — serves [`cdk_fiber::FiberBackend`] over cdk's gRPC payment-processor
//! protocol, so a stock `cdk-mintd` can settle a Cashu mint over the Fiber Network.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use cdk_common::payment::MintPayment;
use cdk_common::CurrencyUnit;
use cdk_fiber::config::rusd_testnet_script;
use cdk_fiber::wire::{Currency, Script};
use cdk_fiber::{FiberBackend, FiberConfig, SettlementJournal};
use cdk_payment_processor::PaymentProcessorServer;
use tokio::signal;

/// Reads `name`, falling back to `default`.
fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// Reads and parses `name`, erroring rather than silently falling back on a malformed value.
fn env_parse<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match std::env::var(name) {
        Ok(raw) => raw
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid value for {name}: {e}")),
        Err(_) => Ok(default),
    }
}

fn currency_from(raw: &str) -> Result<Currency> {
    match raw.to_ascii_lowercase().as_str() {
        "mainnet" | "fibb" => Ok(Currency::Fibb),
        "testnet" | "fibt" => Ok(Currency::Fibt),
        "devnet" | "fibd" => Ok(Currency::Fibd),
        other => {
            anyhow::bail!("FIBERNUTS_NETWORK must be mainnet, testnet or devnet, got `{other}`")
        }
    }
}

/// The UDT invoices are denominated in. Unset falls back to RUSD on testnet; `native` settles in
/// CKB instead.
fn udt_script() -> Result<Option<Script>> {
    match std::env::var("FIBERNUTS_UDT_CODE_HASH") {
        Ok(code_hash) if code_hash.eq_ignore_ascii_case("native") => Ok(None),
        Ok(code_hash) => Ok(Some(Script {
            code_hash,
            hash_type: env_or("FIBERNUTS_UDT_HASH_TYPE", "type"),
            args: std::env::var("FIBERNUTS_UDT_ARGS")
                .context("FIBERNUTS_UDT_ARGS is required alongside FIBERNUTS_UDT_CODE_HASH")?,
        })),
        Err(_) => Ok(Some(rusd_testnet_script())),
    }
}

fn load_config() -> Result<FiberConfig> {
    let unit = env_or("FIBERNUTS_UNIT", "rusd");
    anyhow::ensure!(
        unit.trim() == unit && unit == unit.to_lowercase(),
        "FIBERNUTS_UNIT must use its canonical lowercase spelling without surrounding whitespace"
    );

    Ok(FiberConfig {
        mint_url: env_or("FIBERNUTS_MINT_URL", "http://127.0.0.1:8085"),
        unit: CurrencyUnit::custom(unit),
        currency: currency_from(&env_or("FIBERNUTS_NETWORK", "testnet"))?,
        udt_type_script: udt_script()?,
        unit_scale: env_parse("FIBERNUTS_UNIT_SCALE", 1_000_000u64)?,
        invoice_expiry: Duration::from_secs(env_parse("FIBERNUTS_INVOICE_EXPIRY_SECS", 3600u64)?),
        fee_percent: env_parse("FIBERNUTS_FEE_PERCENT", 1u8)?,
        min_fee_reserve: env_parse("FIBERNUTS_MIN_FEE_RESERVE", 1u64)?,
        poll_interval: Duration::from_secs(env_parse("FIBERNUTS_POLL_SECS", 3u64)?),
        rpc_connect_timeout: Duration::from_secs(env_parse(
            "FIBERNUTS_RPC_CONNECT_TIMEOUT_SECS",
            3u64,
        )?),
        rpc_request_timeout: Duration::from_secs(env_parse(
            "FIBERNUTS_RPC_REQUEST_TIMEOUT_SECS",
            10u64,
        )?),
        reconciliation_max_backoff: Duration::from_secs(env_parse(
            "FIBERNUTS_RECONCILE_MAX_BACKOFF_SECS",
            60u64,
        )?),
        reconciliation_concurrency: env_parse("FIBERNUTS_RECONCILE_CONCURRENCY", 8usize)?,
        incoming_watch_grace: Duration::from_secs(env_parse(
            "FIBERNUTS_INCOMING_WATCH_GRACE_SECS",
            86_400u64,
        )?),
        payment_timeout: Duration::from_secs(env_parse("FIBERNUTS_PAYMENT_TIMEOUT_SECS", 60u64)?),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,cdk_fiber=debug".into()),
        )
        .init();

    let rpc_url = env_or("FIBERNUTS_FIBER_RPC", "http://127.0.0.1:8227");
    // `PaymentProcessorServer` parses this as a bare IP to bind. CDK 0.18 also expects its
    // `[grpc_processor].address` as a bare host and chooses the scheme from its TLS policy.
    let listen_addr = env_or("FIBERNUTS_LISTEN_ADDR", "127.0.0.1");
    let listen_port: u16 = env_parse("FIBERNUTS_LISTEN_PORT", 50051u16)?;
    let journal_path = std::env::var("FIBERNUTS_JOURNAL_PATH")
        .context("FIBERNUTS_JOURNAL_PATH must point to persistent processor storage")?;
    let retention_secs: u64 = env_parse("FIBERNUTS_JOURNAL_RETENTION_SECS", 7_776_000u64)?;

    let config = load_config()?;
    let journal = Arc::new(
        SettlementJournal::open(&journal_path)
            .with_context(|| format!("could not open settlement journal at {journal_path}"))?,
    );
    let backend = FiberBackend::http(rpc_url.clone(), config.clone(), journal.clone())
        .context("could not initialize the Fiber settlement journal scope")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let pruned = journal
        .prune_terminal_before(now.saturating_sub(retention_secs))
        .context("could not apply settlement journal retention")?;
    tracing::info!(
        %rpc_url,
        unit = %config.unit,
        scale = config.unit_scale,
        udt = config.udt_type_script.is_some(),
        rpc_connect_timeout_secs = config.rpc_connect_timeout.as_secs(),
        rpc_request_timeout_secs = config.rpc_request_timeout.as_secs(),
        reconciliation_concurrency = config.reconciliation_concurrency,
        pruned_terminal_operations = pruned,
        "starting fibernuts-processor"
    );

    backend
        .start()
        .await
        .map_err(|e| anyhow::anyhow!("could not start the fiber backend: {e}"))?;

    // The constructor pins the trait object's error type, so the backend must use
    // `Err = cdk_common::payment::Error` exactly.
    let processor: Arc<dyn MintPayment<Err = cdk_common::payment::Error> + Send + Sync> =
        Arc::new(backend.clone());

    let mut server = PaymentProcessorServer::new(processor, &listen_addr, listen_port)
        .context("could not build the gRPC server")?;

    // `start` spawns the server into a background task and returns immediately; without an await
    // on a shutdown signal the runtime would drop and take the server with it.
    server
        .start(None)
        .await
        .context("could not start the gRPC server")?;
    tracing::info!("listening on {listen_addr}:{listen_port}");

    signal::ctrl_c()
        .await
        .context("could not listen for ctrl-c")?;
    tracing::info!("shutting down");

    server
        .stop()
        .await
        .context("could not stop the gRPC server")?;
    backend
        .stop()
        .await
        .map_err(|e| anyhow::anyhow!("could not stop the fiber backend: {e}"))?;

    Ok(())
}
