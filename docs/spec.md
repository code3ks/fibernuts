# fibernuts — specification

## 1. What this is

**fibernuts** is a Cashu mint that settles over the **Fiber Network**, issuing ecash denominated in
**RUSD** — a stablecoin, not a volatile asset.

The judged artifact is **`cdk-fiber`**: a crate implementing the Cashu Development Kit's
`MintPayment` trait against a Fiber node's JSON-RPC API. With it, an **unmodified `cdk-mintd`**
becomes a Fiber-settled mint. Nothing is forked.

Three properties follow from the combination, and none of them hold for either system alone:

- **Instant, private, off-chain payments.** Cashu proofs are bearer tokens: transfer is a message,
  not a transaction. The mint learns nothing about who holds what.
- **Stablecoin denomination.** Fiber channels can be funded with a UDT, so the ecash unit is a RUSD
  cent rather than a fraction of a volatile coin.
- **Real settlement.** Ecash is a claim on the mint; the mint's claim is a Fiber channel balance,
  which is a claim on CKB. Wallets mint by paying a Fiber invoice and melt by having the mint pay
  one.

## 2. Components

| component | what it is |
|---|---|
| `mint/cdk-fiber` | library crate: `MintPayment` over Fiber JSON-RPC. The deliverable. |
| `mint/processor` | `fibernuts-processor` binary: serves `cdk-fiber` over cdk's gRPC payment-processor protocol |
| `wallet/` | a demo wallet that mints, sends, receives and melts RUSD ecash |
| `deploy/` | `cdk-mintd` config, plus `devnet.md`: the full cycle on a local Fiber devnet |

### Why an out-of-process processor

`cdk-mintd` supports an out-of-process payment backend over gRPC (`ln_backend = "grpcprocessor"`),
enabled by default. `cdk-fiber` therefore reaches a stock mint without patching, vendoring or
forking it. `fibernuts-processor` is the thin adapter: it builds a `FiberBackend`, hands it to
`PaymentProcessorServer`, and waits.

```
wallet ──HTTP──▶ cdk-mintd ──gRPC──▶ fibernuts-processor ──JSON-RPC──▶ fiber node ──▶ CKB
             (stock, unforked)         (cdk-fiber)
```

## 3. The money paths

### Mint (wallet acquires ecash)

1. Wallet asks the mint for a quote: `POST /v1/mint/quote/fiber`, amount in ecash units.
2. `cdk-fiber` calls `new_invoice` — a **standard** invoice, denominated in the RUSD UDT.
3. Wallet pays the invoice over Fiber. The node auto-settles the TLC.
4. `cdk-fiber` observes `status == Paid` (via its sweeper, or `check_incoming_payment_status`) and
   the mint signs the wallet's blinded messages.

Only `Paid` credits. `Received` means a TLC arrived and has **not** settled; treating it as payment
would mint ecash against money the mint does not hold.

### Melt (wallet spends ecash to a Fiber invoice)

1. Wallet asks for a melt quote: `POST /v1/melt/quote/fiber`, carrying a Fiber invoice.
2. `cdk-fiber` calls `send_payment` with `dry_run: true`. The node builds a real route and returns
   the fee it *would* pay, without dispatching a TLC. No route ⇒ the quote is rejected.
3. The quoted fee is that routed fee plus a cushion, rounded up, floored at a minimum.
4. Wallet submits proofs. `cdk-fiber` dispatches the payment and polls to a terminal state.

### Failure states

The melt path is where a mint loses money. Three rules:

- **Timeout ⇒ `Pending`, never `Failed`.** A `Failed` melt returns the wallet's proofs while the
  TLC may still settle — the wallet spends the same money twice.
- **Unknown payment ⇒ `Unknown`, never `Failed`.** The node has no session; nothing was dispatched.
- **Never dispatch twice.** Fiber refuses to re-send a payment hash whose session is not `Failed`,
  so a retried melt reports the existing session.

## 4. Units and rounding

RUSD carries 8 decimals. One ecash unit is one RUSD **cent**: `unit_scale = 1_000_000` base units.
Cashu denominates proofs in powers of two, so a coarse unit keeps keysets small.

Rounding always favours the mint's solvency:

| direction | rounding | why |
|---|---|---|
| funds received | **down** | never credit a wallet more than landed |
| amounts charged (melt, fees) | **up** | never under-charge a payment the mint must make |

The mint's `[ln].unit` and `cdk-fiber`'s reported unit must match **byte for byte** — cdk compares
custom units by exact string. Lowercase `rusd` everywhere.

## 5. Configuration

`fibernuts-processor` is configured by environment:

| variable | default | meaning |
|---|---|---|
| `FIBERNUTS_FIBER_RPC` | `http://127.0.0.1:8227` | the Fiber node's JSON-RPC endpoint |
| `FIBERNUTS_LISTEN_ADDR` | `127.0.0.1` | gRPC bind address (a **bare IP**) |
| `FIBERNUTS_LISTEN_PORT` | `50051` | gRPC port |
| `FIBERNUTS_UNIT` | `rusd` | the ecash unit; must be lowercase |
| `FIBERNUTS_UNIT_SCALE` | `1000000` | UDT base units per ecash unit |
| `FIBERNUTS_NETWORK` | `testnet` | `mainnet`, `testnet` or `devnet`; must match the node |
| `FIBERNUTS_UDT_CODE_HASH` | RUSD testnet | the UDT type script; `native` settles in CKB |
| `FIBERNUTS_UDT_ARGS` | RUSD testnet | required alongside a custom code hash |
| `FIBERNUTS_FEE_PERCENT` | `1` | cushion added to the node's routed fee |
| `FIBERNUTS_MIN_FEE_RESERVE` | `1` | floor on the melt fee, in ecash units |
| `FIBERNUTS_POLL_SECS` | `3` | invoice/payment poll interval |
| `FIBERNUTS_PAYMENT_TIMEOUT_SECS` | `60` | how long a melt waits before reporting `Pending` |

`cdk-mintd` is configured by `deploy/mintd.config.toml`. Two settings break a mint silently and are
documented there: `[grpc_processor].addr` requires an `http://` scheme, and the four
`min_mint`/`max_mint`/`min_melt`/`max_melt` limits are mandatory.

## 6. Testing

`cdk-fiber` talks to the node only through the `FiberRpc` trait, so the whole `MintPayment`
implementation is exercised against a scripted mock. Nothing `make ci` runs touches a live node.

The suite encodes the invariants above as named tests — among them
`a_received_invoice_does_not_credit_the_wallet`,
`a_melt_that_never_settles_reports_pending_never_failed`,
`an_outgoing_payment_the_node_never_saw_is_unknown_not_failed`,
`an_in_flight_melt_is_never_dispatched_twice`, and
`the_empty_method_delivered_by_the_grpc_bridge_is_accepted`.

The wire encodings (`0x`-prefixed minimal-form hex, the deliberate absence of `payment_preimage`
and `payment_hash`) are tested directly, because a mistake there is a silent rejection by the node.

A second suite in `mint/cdk-fiber/tests/live_devnet.rs` runs the same invariants against two real
Fiber nodes. It is `#[ignore]`d, so `make ci` stays node-free; `deploy/devnet.md` gives the command.
One of its tests forges a **hold invoice** — the one thing this backend will never create — pays it
for real, waits for the node to park the TLC in `Received`, and asserts nothing is credited.

## 7. Scope

**In scope.** Mint and melt of RUSD ecash over Fiber; a stock `cdk-mintd`; a demo wallet; a local
devnet (`deploy/devnet.md`) and testnet.

**Out of scope.** Multi-unit mints (one unit per processor instance); Lightning interop via the
cross-chain hub; onchain mint/melt; a `payment_proof` (the Fiber node exposes no preimage — see
`docs/integration-contract.md` §6).
