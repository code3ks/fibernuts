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

**The full cycle works, with real money moving across real payment channels.** Verified against a
live 3-node Fiber devnet (`nervos/fiber:0.9.0-rc7`) and a stock `cdk-mintd 0.17.2` installed
straight from crates.io. The mint registers
`PaymentProcessorKey { unit: Custom("rusd"), method: Custom("fiber") }` and advertises NUT-04/NUT-05
for method `fiber`, unit `rusd`.

A wallet minted **$1.00** by paying the mint's Fiber invoice, sent **$0.30** as a bearer token and
received it back, then melted **$0.40** to an invoice on a node two hops away. Channel balances,
read off the nodes:

| | mint's node | payer's node |
|---|---|---|
| start | $0.00 | $1000.00 |
| after minting $1.00 | $1.00 | $999.00 |
| after melting $0.40 | $0.5996 | $999.40 |

The payment routed through a middle node that charged a real 0.1% fee, so the melt quote's dry-run
fee estimate, its reserve, and the change returned to the wallet were all exercised on live
settlement rather than in a mock. `docs/integration-contract.md` §10 walks the arithmetic.

Three `#[ignore]`d live tests run against that devnet and assert the rules a mint cannot get wrong —
including one that forges a **hold invoice**, pays it for real, waits for the node to park the TLC in
`Received`, and proves the backend credits nothing. `make ci` never touches a node.

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
FIBERNUTS_FIBER_RPC=http://127.0.0.1:8227 ./mint/target/release/fibernuts-processor

# 2. a stock, unmodified mint
cargo install cdk-mintd --version 0.17.2
cdk-mintd --config deploy/mintd.config.toml     # set a real `mnemonic` first

# 3. the wallet
npm --prefix wallet ci && npm --prefix wallet run dev    # http://127.0.0.1:5174
```

Confirm the mint picked up the backend:

```sh
curl -s localhost:8085/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":500000}]
```

The processor is configured by environment — `FIBERNUTS_FIBER_RPC`, `FIBERNUTS_LISTEN_ADDR`
(a bare IP), `FIBERNUTS_LISTEN_PORT`, `FIBERNUTS_UNIT`, `FIBERNUTS_UNIT_SCALE`,
`FIBERNUTS_NETWORK`, `FIBERNUTS_UDT_CODE_HASH` / `FIBERNUTS_UDT_ARGS` (or `native` for CKB),
`FIBERNUTS_FEE_PERCENT`, `FIBERNUTS_MIN_FEE_RESERVE`, `FIBERNUTS_POLL_SECS`,
`FIBERNUTS_PAYMENT_TIMEOUT_SECS`. All have working defaults for RUSD on testnet.

## Money safety

A mint that mishandles an ambiguous payment loses money. Four rules, each a named test:

- **Only `Paid` credits a wallet.** A Fiber invoice in `Received` has a TLC against it that has
  *not* settled. Crediting there mints ecash against money the mint does not hold.
- **A melt that has not settled is `Pending`, never `Failed`.** `Failed` hands the wallet its proofs
  back while the TLC may still settle — the same money, spent twice.
- **A payment the node never saw is `Unknown`, never `Failed`.**
- **A retried melt never dispatches a second TLC.** Fiber refuses to re-send a payment hash whose
  session is not `Failed`, so the backend reports the existing session instead.

Rounding follows the same principle: funds **received** round down, amounts **charged** round up.

Invoices are **standard**, never hold invoices. Omitting both `payment_preimage` and `payment_hash`
is what makes the node generate a preimage and auto-settle; supplying only a hash would create a
hold invoice whose TLC stalls until manually settled.

## What this cost to get right

Both cdk and the Fiber node ship comments that contradict their code. `docs/integration-contract.md`
records what they actually do, with citations. The three that would have silently broken a mint:

- **The gRPC bridge drops `method`.** `cdk-payment-processor` has no proto field for it and
  reconstructs it as `""` — under a comment reading `// Will be set from variant`, which never
  happens. A backend that validates `method == "fiber"` rejects every request the mint ever makes.
- **Fiber silently clamps your fee ceiling.** `max_fee_amount` is reduced to
  `min(yours, amount × 0.5%)`. Any reserve above 0.5% is quietly cut, and the payment then fails to
  route for a fee the mint already quoted and collected. `cdk-fiber` raises `max_fee_rate` to match.
- **`cdk-mintd`'s own example config does not work.** `[grpc_processor].addr` needs an `http://`
  scheme (the example omits it), and the four `min_mint`/`max_mint`/`min_melt`/`max_melt` limits are
  mandatory — omitting them fails with `data did not match any variant of untagged enum LnOneOrMany`.

Two more worth knowing: the Fiber node **never exposes a payment preimage** through any RPC, so
`payment_proof` is always `None`; and `send_payment` with `dry_run: true` returns a genuinely routed
fee without dispatching a TLC, which is exactly what a melt quote needs.

## Development

```sh
make setup   # rustfmt + clippy, checks for protoc
make test
make ci      # fmt-check + lint + test + build (what CI runs)
```

`cdk-fiber` reaches the node only through an injectable `FiberRpc` trait, so the whole
`MintPayment` implementation is tested against a mock, and `make ci` never touches a node. An
opt-in suite (`--ignored`) runs the same invariants against a real devnet; `deploy/devnet.md` has
the command. cdk is pinned to `=0.17.2`: its `MintPayment` trait changes shape across minor
versions.

The Fiber wire types are hand-rolled rather than taken from the published `fiber-json-types`, which
drags in the `ckb-*` tree — 412 transitive packages and an MSRV of Rust 1.95 — for four structs.

## Roadmap

- Fold `deploy/devnet.md` into a single `make demo` target.
- Upstream `cdk-fiber` to `cashubtc/cdk` alongside `cdk-cln` and `cdk-lnd`.
- Persist the invoice watch set, so the payment event stream survives a restart (correctness does
  not depend on it today — `check_incoming_payment_status` is authoritative).
- Melt events on the payment stream, once a pending melt can be resolved without polling.
- Multi-unit mints: one processor per unit today.

## License

MIT.
