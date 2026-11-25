# FiberNuts

> An open protocol adapter connecting **Cashu ecash** to **Fiber Network** settlement, with **RUSD**
> as the reference stablecoin asset.

## What it is

FiberNuts is a Cashu-over-Fiber protocol implementation. Its core library is **`cdk-fiber`**, a Rust
crate implementing the [Cashu Development Kit](https://github.com/cashubtc/cdk)'s `MintPayment`
trait against a Fiber node's JSON-RPC API. Drop it in and an **unmodified `cdk-mintd`** becomes a
Fiber-settled Cashu mint. Nothing is forked, patched, or vendored.

Three properties come out of the combination, and none of them hold for either system alone:

- **Instant and private.** Cashu proofs are bearer tokens. Sending one is a message, not a
  transaction, and the mint cannot tell who holds what.
- **Denominated in a stablecoin.** Fiber channels can be funded with a UDT, so an ecash unit is one
  RUSD **cent** rather than a fraction of a volatile coin.
- **Really settled.** Ecash is a claim on the mint; the mint's claim is a Fiber channel balance,
  which is a claim on CKB. Wallets mint by paying a Fiber invoice and melt by having the mint pay
  one.

```
wallet ──HTTP──▶ cdk-mintd ──gRPC──▶ fibernuts-processor ──JSON-RPC──▶ fiber node ──▶ CKB
             (stock, unforked)         (wraps cdk-fiber)
```

| component | what it is |
|---|---|
| `mint/cdk-fiber/` | the core protocol adapter: CDK's `MintPayment` over Fiber JSON-RPC |
| `mint/processor/` | `fibernuts-processor`, serving the adapter over CDK's gRPC protocol |
| `wallet/` | a reference wallet for minting, sending, receiving, and melting RUSD ecash |
| `market/` | the Community Market reference application for attendee and vendor payments |
| `relay/` | capability-scoped delivery for vendor-locked payment requests |
| `faucet/` | a bounded testnet service that pays fixed, browser-locked mint quotes |
| `deploy/` | operator deployment plus reproducible devnet and testnet integration environments |

**Who runs this?** An operator self-hosts the mint (a Fiber node + `fibernuts-processor` + a stock
`cdk-mintd`); users point any Cashu wallet at it and hold bearer ecash. It's federated infrastructure
— one operator, one mint — not a central service. `docs/deployment.md` explains the model and the
custodial trust tradeoff; **`deploy/HOSTING.md` + `deploy/compose.yaml`** stand the whole mint up on a
server with one `docker compose up`.

## Protocol status

**The full cycle works, with real money moving across real payment channels.** The original live
evidence used a 3-node Fiber devnet (`nervos/fiber:0.9.0-rc7`) and stock `cdk-mintd 0.17.2`.
The current adapter and deployment files pin Fiber `v0.10.1` and CDK `v0.18.3`; both the
deterministic money-safety suite and a three-node local devnet mint/cash-out cycle cover that stable
pair. Live evidence always names the versions it exercised and is not silently carried forward
across upgrades. The mint registers
`PaymentProcessorKey { unit: Custom("rusd"), method: Custom("fiber") }` and advertises NUT-04/NUT-05
for method `fiber`, unit `rusd`.

In the original release-candidate baseline cycle, a wallet minted **$1.00** by paying the mint's
Fiber invoice, sent **$0.30** as a bearer token and received it back, then melted **$0.40** to an
invoice on a node two hops away. Channel balances, read off the nodes:

| | mint's node | payer's node |
|---|---|---|
| start | $0.00 | $1000.00 |
| after minting $1.00 | $1.00 | $999.00 |
| after melting $0.40 | $0.5996 | $999.40 |

The payment routed through a middle node that charged a real 0.1% fee, so the melt quote's dry-run
fee estimate, its reserve, and the change returned to the wallet were all exercised on live
settlement rather than in a mock. `docs/integration-contract.md` §10 walks the arithmetic.

The stable compatibility rerun minted 200 ecash units through stock `cdk-mintd 0.18.3`, then paid
an external 100-unit invoice over Fiber `0.10.1`. The external invoice reached `Paid`, the realized
fee was 1 unit, and the wallet retained 99 units. `docs/compatibility.md` records the exact pins and
scope of that evidence.

Three `#[ignore]`d live tests also passed against the stable devnet and assert the rules a mint
cannot get wrong — including one that forges a **hold invoice**, pays it for real, waits for the
node to park the TLC in `Received`, and proves the backend credits nothing. `make ci` never touches
a node.

Two runbooks reproduce it end to end: **`deploy/devnet.md`** stands up a throwaway 3-node network
with zero external dependencies (the asset is a dev UDT standing in for RUSD), and
**`deploy/testnet.md`** does it on public testnet with the real Stable++ RUSD — honest about the one
hard part, which is acquiring testnet RUSD.

## Try the live mint

A reference mint is live on public testnet at **https://mint.fibernuts.xyz**, with the wallet at
**https://fibernuts.xyz** and the Community Market at **https://market.fibernuts.xyz**. The wallet
is already pointed at the reference mint. Holding, sending, and receiving ecash needs nothing but
the wallet. The Market can offer one bounded testnet claim when the operator-funded quote payer is
available; the normal mint and melt paths still require a routable RUSD channel.

The reference mint's public coordinates are:

```sh
MINT_URL="https://mint.fibernuts.xyz"
MINT_ADDR="/ip4/157.230.15.176/tcp/8228/p2p/QmbsNpwt8zpXoTMFg1xDUq5qpNvcdZQfeykbKMY9nd8e1H"
MINT_PUBKEY="03698c4b37049adb4f28a3eb2aa2a57f0a56cf25959a4d2161df5597f23c7d7d94"
MINT_CKB_ADDRESS="ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdy3egfd2s8w505cvtld77scx806ljhducha5aaa"
```

`MINT_CKB_ADDRESS` funds the mint operator's side of Fiber channel cells and fees. It is not a
Cashu deposit address: sending CKB or RUSD to it does not issue ecash.

To **mint from the reference wallet** (deposit RUSD) you pay the mint's Fiber invoice from your own Fiber node, so first
fund your node with testnet CKB and on-chain RUSD, then open a public RUSD channel from that node
into the mint. The mint auto-accepts RUSD channels ≥ 10 RUSD:

```sh
fnn() { fnn-cli -u <your-node-rpc> "$@"; }
RUSD='{"code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a","hash_type":"type","args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}'

fnn peer connect_peer --address "$MINT_ADDR"
fnn channel open_channel --pubkey "$MINT_PUBKEY" --funding-amount 1000000000 --public true --funding-udt-type-script "$RUSD"
fnn channel list_channels        # wait until state is ChannelReady
```

Then in the wallet: **Mint** → enter an amount → it shows a `fibt…` invoice → pay it with
`fnn payment send_payment --invoice <fibt…>` and the balance credits. **Send/Receive** move ecash
browser-to-browser; **Melt** cashes out to an invoice from `fnn invoice new_invoice --currency Fibt
--udt-type-script "$RUSD"`. Wallet amounts are RUSD; `fnn-cli` uses base units (`1.00 RUSD = 100_000_000`).

## Run your own mint

You need a Fiber node, `protoc`, and a Rust toolchain.

```sh
# 1. the payment backend, wrapping your Fiber node
cargo build --release --manifest-path mint/Cargo.toml -p fibernuts-processor
mkdir -p /tmp/fibernuts-processor
FIBERNUTS_FIBER_RPC=http://127.0.0.1:8227 \
FIBERNUTS_MINT_URL=http://127.0.0.1:8085 \
FIBERNUTS_JOURNAL_PATH=/tmp/fibernuts-processor/settlement.sqlite3 \
./mint/target/release/fibernuts-processor

# 2. a stock, unmodified mint
cargo install cdk-mintd --version 0.18.3 --locked
export CDK_MINTD_MNEMONIC="your twelve word mnemonic"
cdk-mintd --work-dir /tmp/fibernuts-mint config init --new-mint \
  --file deploy/mintd.config.toml
cdk-mintd --work-dir /tmp/fibernuts-mint --enable-logging

# 3. the wallet
npm --prefix wallet ci && npm --prefix wallet run dev    # http://127.0.0.1:5174
```

Confirm the mint picked up the backend:

```sh
curl -s localhost:8085/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":500000}]
```

The processor is configured by environment — `FIBERNUTS_FIBER_RPC`, `FIBERNUTS_MINT_URL`,
the required persistent `FIBERNUTS_JOURNAL_PATH`, `FIBERNUTS_LISTEN_ADDR` (a bare IP),
`FIBERNUTS_LISTEN_PORT`, `FIBERNUTS_UNIT`, `FIBERNUTS_UNIT_SCALE`,
`FIBERNUTS_NETWORK`, `FIBERNUTS_UDT_CODE_HASH` / `FIBERNUTS_UDT_ARGS` (or `native` for CKB),
`FIBERNUTS_FEE_PERCENT`, `FIBERNUTS_MIN_FEE_RESERVE`, `FIBERNUTS_POLL_SECS`,
`FIBERNUTS_RPC_CONNECT_TIMEOUT_SECS`, `FIBERNUTS_RPC_REQUEST_TIMEOUT_SECS`,
`FIBERNUTS_RECONCILE_MAX_BACKOFF_SECS`, `FIBERNUTS_RECONCILE_CONCURRENCY`,
`FIBERNUTS_PAYMENT_TIMEOUT_SECS`, `FIBERNUTS_INCOMING_WATCH_GRACE_SECS`, and
`FIBERNUTS_JOURNAL_RETENTION_SECS`. Every node call has a deadline. Read-only recovery queries use
bounded jittered backoff and bounded concurrency; a timed-out value-moving call is reconciled by
its durable payment hash and is never blindly repeated. Settlement records are bound to the mint
URL, unit, network, scale, and exact asset; only old terminal records are pruned.

## Money safety

A mint that mishandles an ambiguous payment loses money. Five rules, each a named test:

- **Only `Paid` credits a wallet.** A Fiber invoice in `Received` has a TLC against it that has
  *not* settled. Crediting there mints ecash against money the mint does not hold.
- **A melt that has not settled is `Pending`, never `Failed`.** `Failed` hands the wallet its proofs
  back while the TLC may still settle — the same money, spent twice.
- **A payment the node never saw is `Unknown`, never `Failed`.**
- **A retried melt never dispatches a second TLC.** Fiber refuses to re-send a payment hash whose
  session is not `Failed`, so the backend reports the existing session instead.
- **A melt invoice must encode the configured network and exact settlement asset.** A wrong-network,
  native-CKB, malformed, or different-UDT invoice is rejected before the route probe and before any
  wallet proofs can be reserved.

Rounding follows the same principle: funds **received** round down, amounts **charged** round up.
If a melt remains pending after the request ends, the durable payment hash is reconciled after
restart. Terminal success or failure is reported once with the original quote ID; successful
accounting uses the original principal plus Fiber's authoritative actual fee.

Invoices are **standard**, never hold invoices. Omitting both `payment_preimage` and `payment_hash`
is what makes the node generate a preimage and auto-settle; supplying only a hash would create a
hold invoice whose TLC stalls until manually settled.

## What this cost to get right

Both cdk and the Fiber node ship comments that contradict their code. `docs/integration-contract.md`
records what they actually do, with citations. The four that would have silently broken a mint:

- **The gRPC bridge drops `method`.** `cdk-payment-processor` has no proto field for it and
  reconstructs it as `""` — under a comment reading `// Will be set from variant`, which never
  happens. A backend that validates `method == "fiber"` rejects every request the mint ever makes.
- **Fiber silently clamps your fee ceiling.** `max_fee_amount` is reduced to
  `min(yours, amount × 0.5%)`. Any reserve above 0.5% is quietly cut, and the payment then fails to
  route for a fee the mint already quoted and collected. `cdk-fiber` raises `max_fee_rate` to match.
- **CDK 0.18 configuration is database-backed.** `--config` is rejected at startup. Initialize a
  new mint with `config init --new-mint`, or import an existing mint with
  `config init --existing-mint`; using the wrong mode is an identity/accounting error.
- **Plaintext gRPC is now explicit.** `[grpc_processor].address` is a bare host, and either
  `tls_dir` or `allow_insecure = true` is required. FiberNuts permits plaintext only when mintd
  and the processor share the same loopback namespace.

Two more worth knowing: Fiber `v0.10.1` exposes the preimage learned from a successful payment, so
`cdk-fiber` returns it as `payment_proof` only for a paid melt and redacts it from debug output;
and `send_payment` with `dry_run: true` returns a genuinely routed fee without dispatching a TLC,
which is exactly what a melt quote needs.

## Development

```sh
make setup       # rustfmt + clippy, checks for protoc
make test
make evidence-ci # validate deterministic coverage and public-output redaction evidence
make ci          # evidence + fmt-check + lint + test + build (what CI runs)
```

`cdk-fiber` reaches the node only through an injectable `FiberRpc` trait, so the whole
`MintPayment` implementation is tested against a mock, and `make ci` never touches a node. An
opt-in suite (`--ignored`) runs the same invariants against a real devnet; `deploy/devnet.md` has
the command. The machine-readable evidence index is
[`docs/evidence/settlement-reliability.json`](docs/evidence/settlement-reliability.json); its live
scenarios remain excluded from ordinary CI. cdk is pinned to `=0.18.3`: its `MintPayment` trait
changes shape across minor versions.

The Fiber wire types are hand-rolled rather than taken from the published `fiber-json-types`, which
pulls the broad `ckb-*` type tree into a small payment adapter. The subset is checked directly
against the exact pinned Fiber source and covered by encoding tests.

## Protocol references

- [`docs/spec.md`](docs/spec.md) defines the money flows, units, and protocol boundary.
- [`docs/integration-contract.md`](docs/integration-contract.md) records the load-bearing CDK and
  Fiber behavior verified by the current adapter.
- [`docs/compatibility.md`](docs/compatibility.md) separates historical live evidence, the stable
  direct-settlement pins, and the hosted-LSP and browser-wallet targets.
- [`docs/failure-model.md`](docs/failure-model.md) defines authoritative state, recovery rules, and
  the settlement, signer, browser-key, and refund threat model.
- [`docs/mainnet-validation.md`](docs/mainnet-validation.md) records the mainnet RUSD identity and
  the no-go-by-default validation gate.

## Roadmap

- Fold `deploy/devnet.md` into a single `make demo` target.
- Upstream `cdk-fiber` to `cashubtc/cdk` alongside `cdk-cln` and `cdk-lnd`.
- Multi-unit mints: one processor per unit today.

## License

MIT.
