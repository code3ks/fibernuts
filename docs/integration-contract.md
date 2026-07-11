# The cdk ⇄ Fiber integration contract

Everything `cdk-fiber` relies on, verified against **cdk `v0.17.2`** (commit `6132607`), **fiber
`v0.9.0-rc7`** source, and a **live fnn `0.9.0-rc2`** testnet node. Nothing here is inferred from
documentation; each claim cites the file that establishes it, and the traps were found by reading
code that contradicts its own comments.

Read this before changing anything in `mint/cdk-fiber/`.

---

## 1. `MintPayment` is an options-enum trait, not a per-method trait

`cdk-common/src/payment.rs:418` declares eleven methods. Five carry the whole request in an enum:

```rust
async fn create_incoming_payment_request(&self, options: IncomingPaymentOptions) -> ...;
async fn get_payment_quote(&self, unit: &CurrencyUnit, options: OutgoingPaymentOptions) -> ...;
async fn make_payment(&self, unit: &CurrencyUnit, options: OutgoingPaymentOptions) -> ...;
async fn check_incoming_payment_status(&self, id: &PaymentIdentifier) -> Result<Vec<WaitPaymentResponse>, _>;
async fn check_outgoing_payment(&self, id: &PaymentIdentifier) -> Result<MakePaymentResponse, _>;
```

A Fiber backend lives in the `Custom` variant of both option enums. `IncomingPaymentOptions::Custom`
and all four `OutgoingPaymentOptions` variants are `Box`ed.

`is_payment_event_stream_active` and `cancel_payment_event_stream` are **sync** `fn`s inside an
`#[async_trait]` impl. `start`/`stop` have default `Ok(())` bodies.

### The error type is pinned by the gRPC server, not the trait

The trait permits `type Err: Into<Error> + From<Error>`, but the only constructor,
`PaymentProcessorServer::new` (`cdk-payment-processor/src/proto/server.rs:46`), demands:

```rust
payment_processor: Arc<dyn MintPayment<Err = cdk_common::payment::Error> + Send + Sync>
```

Unsize coercion preserves associated types, so a backend with a custom `Err` can *never* become
that trait object. **Set `type Err = cdk_common::payment::Error;`** and bridge your own error with
`impl From<MyError> for payment::Error { Self::Lightning(Box::new(e)) }`.

---

## 2. Trap: the gRPC bridge silently drops `method`

`CustomIncomingPaymentOptions` and `CustomOutgoingPaymentOptions` both carry a `method: String` in
Rust. The protobuf has **no such field**. On the way back to Rust the server hardcodes it:

```rust
// server.rs:234
method: "".to_string(),
// server.rs:333
method: String::new(), // Will be set from variant
// server.rs:456
method: String::new(), // Method will be determined from context
```

Those comments are aspirational — `grep` shows the field is never assigned anywhere. A backend that
validates `options.method == "fiber"` rejects **every request the mint ever makes**, and the failure
surfaces as an opaque HTTP 500.

`cdk-fiber` therefore never inspects `method` and serves exactly one method. The regression test is
`the_empty_method_delivered_by_the_grpc_bridge_is_accepted`.

Two more artefacts of the same bridge:

- `CustomOutgoingPaymentOptions.request` travels in a proto field literally named `offer`
  (`client.rs:331` → `server.rs:457`, `request: opts.offer`).
- `get_payment_quote`'s custom path hardcodes `max_fee_amount: None, timeout_secs: None`
  (`server.rs:334`). Only `make_payment` preserves them. Quote-time fee reserve must be computed
  by the backend, not read from the request.

The **unit does** survive: `AmountMessage { value, unit }` (`payment_processor.proto:17`).

---

## 3. Trap: the processor swallows your error message

`server.rs:283` maps any backend failure to a bare status:

```rust
.map_err(|_| Status::internal("Could not create invoice"))?
```

The mint operator sees nothing useful. `cdk-fiber` logs every failure through `tracing` before
returning, because that log line is the only diagnostic that survives.

### And on the melt path, cdk relabels it "Unit unsupported"

A failed melt **quote** is masked twice. When `get_payment_quote` fails — no route, wrong unit, or a
**self-payment** (an invoice payable to the mint's own node) — the node's real message
(`allow_self_payment is not enabled…`) is first flattened to `Status::internal("Could not get
quote")` by the gRPC layer, and then cdk-mintd's melt handler maps *any* such failure to
`Error::UnsupportedUnit` → the NUT error **`Unit unsupported` (11013)**
(`cdk/src/mint/melt/mod.rs:735-741`).

So a wallet that pastes an unroutable invoice — most commonly one this same mint issued — gets a
misleading "Unit unsupported", not "no route" or "cannot pay yourself". The failure is surfaced at
*quote* time, before any proof is spent, which is the one saving grace. The demo wallet translates
this error (`explainMeltError`) rather than showing it raw.

---

## 4. Stock `cdk-mintd` runs a custom unit and a custom method — no fork

Verified end to end. The mechanism is not the one the build plan assumed:

| thing | where it comes from |
|---|---|
| the **method** (`fiber`) | the **backend**, as a key of `get_settings().custom` (`lib.rs:924`) |
| the **unit** (`rusd`) | the **config**, `[ln].unit` (`lib.rs:709`) |

`get_settings().unit` is only used to *validate* the config's unit
(`validate_backend_unit`, `lib.rs:977-1005`). It requires an **exact string match** for custom
units — sat↔msat is the sole conversion. Mismatch aborts startup.

`grpc-processor` is in `cdk-mintd`'s **default** cargo features (`Cargo.toml:14`), so a published
`cdk-mintd` already has it.

Custom methods get parameterised axum routes (`cdk-axum/src/custom_router.rs:30`), so a mint with
method `fiber` serves `/v1/mint/quote/fiber`, `/v1/melt/quote/fiber`, `/v1/mint/fiber`, and friends.
Method names allow alphanumerics, `-`, `_`; `bolt11`/`bolt12`/`onchain` are reserved.

### Config gotchas, both empirically confirmed

- **`min_mint`/`max_mint`/`min_melt`/`max_melt` are mandatory** whenever an `[ln]` section exists in
  the file. They have no serde default, and `Ln` is deserialized inside an untagged enum, so
  omitting them yields the useless error
  `data did not match any variant of untagged enum LnOneOrMany for key ln`.
  The commented-out limits in `example.config.toml:121` are misleading.
- **`[grpc_processor].addr` needs a URL scheme.** The client builds
  `Channel::from_shared(format!("{addr}:{port}"))`, and tonic rejects a URI without one.
  `example.config.toml:321` shows `addr = "127.0.0.1"`, which fails. Use `http://127.0.0.1`.
- **Case matters.** `CurrencyUnit::from_str` does not uppercase custom units, but the
  `CurrencyUnit::custom()` helper does. `Custom("rusd") != Custom("RUSD")` even though both render
  as `"rusd"`. Use lowercase everywhere.
- `ln_backend` is spelled `"grpcprocessor"` — no dash, no underscore. (`grpc-processor` is the
  *cargo feature* name.)

### Server binds an IP; the client dials a URL

`PaymentProcessorServer::new(processor, addr, port)` does `SocketAddr::new(addr.parse()?, port)` —
a **bare IP**, no scheme. `cdk-mintd`'s `[grpc_processor].addr` is a **tonic URI** and needs
`http://`. The same conceptual address is written two different ways.

### `start()` returns immediately

`server.start(tls_dir)` spawns the server with `tokio::spawn` and falls through to `Ok(())`
(`server.rs:128-141`). A binary that returns from `main` right after would kill the runtime and the
detached task with it. `fibernuts-processor` awaits `ctrl_c`.

---

## 5. Fiber invoices: standard vs hold

`new_invoice` resolves the invoice kind from two optional fields (`rpc/invoice.rs:187-203`):

| `payment_preimage` | `payment_hash` | result |
|---|---|---|
| absent | absent | **standard**: node generates a random preimage, stores it, auto-settles the TLC |
| present | absent | standard, with a caller-supplied preimage |
| absent | present | **hold invoice**: TLC is held until `settle_invoice` |
| present | present | hard error `BothPaymenthashAndPreimage` |

A mint must never hold, so `cdk-fiber` omits **both** fields. Confirmed live: a minimal
`new_invoice` params object is accepted and yields status `Open`.

`CkbInvoiceStatus` is `Open | Cancelled | Expired | Received | Paid` (bare PascalCase on the wire).

> **`Received` is not paid.** It means a TLC arrived and has *not* settled. Crediting a wallet on
> `Received` mints ecash against money the mint does not hold. Only `Paid` credits.

---

## 6. Fiber payments

`send_payment` and `get_payment` both return `GetPaymentCommandResult`.

### The preimage is never exposed

No preimage field exists on the wire type or on the internal `SendPaymentResponse`, under any
`cfg`. The node *has* it — `attempt.preimage = Some(fulfill.payment_preimage)`
(`fiber/payment.rs:1794`) — but no RPC surfaces it. This is a deliberate gap, not an oversight.

Consequence: `MakePaymentResponse.payment_proof` is always `None`. `Option<String>` permits it.

### `dry_run: true` returns a real routed fee

The dry-run path still calls `build_payment_routes` and returns `fee = session.fee_paid()`
(`fiber/payment.rs:1972`, comment at `:1305`). It computes a genuine route and fee without storing
a session or dispatching a TLC, and errors when no route exists. This is exactly what a melt quote
needs, and it is how `get_payment_quote` prices.

### Trap: `max_fee_amount` is silently clamped

```rust
// fiber/payment.rs:435
let max_fee_amount_by_rate = calculate_fee_with_base(amount, max_fee_rate, 1000)?;
let max_fee_amount = match command.max_fee_amount {
    Some(f) => Some(f.min(max_fee_amount_by_rate)),   // <-- min(), not the value you passed
    None    => Some(max_fee_amount_by_rate),
};
```

`DEFAULT_MAX_FEE_RATE = 5` per thousand — **0.5%**. Any reserve above 0.5% of the amount is quietly
cut down, and the payment then fails to route for a fee the mint already quoted and collected from
the wallet. `cdk-fiber` raises `max_fee_rate` to `ceil(max_fee * 1000 / amount)` whenever the
reserve exceeds the default (`amount::max_fee_rate_for`).

### Trap: a payment hash can only be re-sent after `Failed`

`fiber/payment.rs:1946-1967` rejects a re-send unless the prior session is `Failed`. A retried melt
must therefore *look up* the existing session and report it, not dispatch a second TLC.
`make_payment` calls `get_payment` first.

### Unknown payments error rather than return empty

```
InvalidParameter: Payment session not found: Hash256(0x1111…)
```

That string is the only signal a payment was never dispatched. It must map to
`MeltQuoteState::Unknown`, **never** `Failed` — `Failed` would hand the wallet its proofs back.

### `PaymentStatus` and the melt state map

| fiber | cdk `MeltQuoteState` | why |
|---|---|---|
| `Success` | `Paid` | settled |
| `Failed` | `Failed` | terminally failed |
| `Created`, `Inflight` | `Pending` | in flight |
| *timeout while polling* | `Pending` | **never `Failed`** — the TLC may still settle |
| *no session* | `Unknown` | never dispatched |

`routers` on the result is `#[cfg(debug_assertions)]`; a release node omits it. Deserialize
tolerantly.

`GetPaymentCommandResult` returns `fee` but **not** `amount`. Track the amount from the invoice.

### Paying by invoice merges the rest

`validate_field` (`fiber/payment.rs:400`) merges `amount` and `udt_type_script` from the invoice,
and errors with `"<field> does not match the invoice"` if you pass a conflicting value. So pass
**only** `invoice` on the melt path.

---

## 7. Wire encoding

FNN encodes integers as `0x`-prefixed, **minimal-form** lowercase hex. Zero is `"0x0"`, never
`"0x00"`; its deserializers reject redundant leading zeros and a missing `0x`.

Conventions differ within one payload:

| type | encoding |
|---|---|
| `u64` / `u128` | `"0x{:x}"`, minimal form |
| `Hash256` (payment hash, preimage) | `0x` + 64 hex chars |
| `Pubkey` | 66 hex chars, **no** `0x` |
| `Script` (`udt_type_script`) | JSON object `{code_hash, hash_type, args}` on **input** |

`udt_type_script` is asymmetric: a structured object going in, a molecule-serialized hex string
coming back inside `invoice.data.attrs` as `{"udt_script": "0x…"}`.

`Currency` is `Fibb` (mainnet) / `Fibt` (testnet) / `Fibd` (devnet), bare PascalCase, and
`new_invoice` rejects a currency that disagrees with the node's own chain.

Omitted optional fields decode as `None` — confirmed live with a minimal `new_invoice` body.

### Why the wire types are hand-rolled

`fiber-json-types` is published (`0.9.0-rc7`) and carries these exact types. Depending on it pulls
the `ckb-*` tree: **412 transitive packages**, and an MSRV of **Rust 1.95**, which fails to build on
1.93. For four structs, `mint/cdk-fiber/src/wire.rs` re-declares them and tests the encodings.

---

## 8. RUSD and rounding

RUSD carries 8 decimals. One ecash unit is one RUSD **cent**: `unit_scale = 1_000_000` base units.
Coarse units keep Cashu's power-of-two keysets small.

Rounding always favours mint solvency:

- funds the mint **receives** round **down** (`from_base_floor`) — never over-credit a wallet;
- amounts the mint **charges** round **up** (`from_base_ceil`) — never under-charge a melt.

RUSD on testnet, from the node's own `udt_cfg_infos` whitelist:

```
code_hash 0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a
hash_type type
args      0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b
```

---

## 9. Running against a dev chain

Verified live on a `fiber-forge` devnet (`nervos/fiber:0.9.0-rc7`), three nodes, `simple_udt`
channels. Four things differ from testnet, and each fails loudly or silently if missed.

- **The currency must match the chain.** `new_invoice` on a dev chain rejects `Fibt` with
  `Currency must be Fibd with the chain network` (`rpc/invoice.rs:175-184`, `fiber/config.rs:451`).
  Set `FIBERNUTS_NETWORK=devnet`.
- **`simple_udt` is `hash_type: "data1"`,** not `type`. The default in `fibernuts-processor` is
  `type`, so `FIBERNUTS_UDT_HASH_TYPE=data1` is required.
- **The node's `udt_cfg_infos` whitelist stores `args` as a regex** (`"0x.*"`), not a literal. Read
  the concrete script off the funded channel (`list_channels[].funding_udt_type_script`) or the
  issuance cell — never off the whitelist.
- **The invoice's `udt_type_script` must be byte-identical to the channel's.** A mismatched `args`
  produces an invoice that creates fine and then never routes: `new_invoice` performs no whitelist
  check at all (the whitelist gates channel *opening*, not invoicing).

### A channel's opener holds all of it

A UDT channel's acceptor contributes exactly zero (`fiber/network.rs:1374-1375`). The opener can
only send; the acceptor can only receive. So **the peer must open the channel into the mint**, or no
wallet can ever mint: every deposit invoice sits `Open` forever because the payer has no outbound
liquidity. Melt works afterwards, because minting is what moves balance onto the mint's side.

## 10. Rounding is not free

Ecash units are integers, and `unit_scale` is coarse (1 unit = 1e6 base units for RUSD). A routing
fee smaller than one ecash unit still has to be charged as one.

Measured on a two-hop devnet melt of 40 units ($0.40) whose router charged 0.1%:

```
routed fee (dry_run)  =     40_000 base =  0.04 units
quoted fee reserve    = ceil(0.04) = 1, +1% cushion -> ceil(1.01) = 2 units   ($0.02)
mint's on-chain spend = 40_000_000 + 40_000 = 40.04 units
total_spent charged   = ceil(40.04) = 41 units                                ($0.41)
change returned       = 42 - 41 = 1 unit
```

The mint spent 40.04 and charged 41, keeping a **0.96-unit remainder**. That is the intended
direction: `from_base_ceil` on anything the mint charges means the mint can over-collect a sub-unit
dust amount, but can never be left short. Rounding the other way would make every melt with a
fractional fee a small loss. A finer `unit_scale` shrinks the remainder at the cost of a larger
keyset.

## 11. Known limits

- **`payment_proof` is always `None`.** Not a choice; FNN exposes no preimage. A mint that must
  prove payment out-of-band cannot do so through this RPC surface.
- **The event stream is best-effort.** `cdk-fiber` sweeps open invoices on an interval and emits
  `Event::PaymentReceived`. The watch set is in memory, so a restart forgets it. Correctness does
  not depend on the stream: `check_incoming_payment_status` is authoritative, and the mint calls it
  whenever a wallet checks its quote.
- **Melt events are not emitted.** `make_payment` awaits a terminal state and returns it. A melt
  that times out returns `Pending`; the mint resolves it via `check_outgoing_payment`.
- Amountless invoices are rejected — the backend cannot price them.
