# Running the full cycle on a local Fiber devnet

A complete mint → send → receive → melt cycle, with real money moving across real payment channels.
No testnet faucet, no counterparty to beg from.

The devnet comes from [fiber-forge](https://github.com/truthixify/fiber-forge), which bakes the
Fiber contracts into a CKB dev-chain genesis, boots `nervos/fiber:0.9.0-rc7` nodes, funds them, and
issues a dev UDT. That UDT carries **8 decimals**, exactly like RUSD, so `unit_scale` needs no
change from production.

You need Docker running, `protoc`, a Rust toolchain, and Node 20+.

---

## Which node runs the mint, and who opens the channel

This is the one thing that is easy to get backwards.

**A channel's opener holds all of its initial balance.** If the mint's node opens the channel, the
mint has outbound liquidity and the peer has none — so nobody can ever *pay* the mint, and no wallet
can mint ecash.

So: **the peer opens the channel into the mint.**

```
confucius ──UDT 1000──▶ lorentz ──UDT 1000──▶ riemann
 (payer)                (router)               (mint's node)
```

`riemann` runs the mint. `confucius` pays its invoices. `lorentz` sits in the middle and charges a
routing fee, which is what makes the melt quote's fee reserve mean something. A two-node `duo`
network works identically, but every route is one hop and every routing fee is zero.

---

## 1. Bring up the network

```sh
cd ../fiber-forge                       # wherever fiber-forge lives
node bin/forge.mjs up line:3 --ckb-port 8124 --rpc-base 8310 --no-gui --json
```

Node names are generated. Read them back, along with each node's host RPC port:

```sh
node bin/forge.mjs status line3 --json
```

Below, `riemann`/`lorentz`/`confucius` are on `:8310`/`:8311`/`:8312`. Substitute your own.

## 2. Fund the UDT path toward the mint

Each node that must *send* UDT needs UDT on-chain first. Amounts are in whole UDT (× 1e8 base
units), so `10000000000` is 1e18 base units — far more than the demo needs.

```sh
node bin/forge.mjs udt issue line3 confucius 10000000000
node bin/forge.mjs udt issue line3 lorentz   10000000000

# each hop is opened by the node further from the mint
node bin/forge.mjs channel open line3 confucius lorentz 1000 --udt
node bin/forge.mjs channel open line3 lorentz   riemann 1000 --udt
```

1000 whole UDT = 1e11 base units = **100,000 ecash units = $1,000.00** of headroom per hop.

## 3. Read the UDT script

The node's `udt_cfg_infos` whitelist stores `args` as a **regex** (`0x.*`), so read the literal
script off the issuance cell instead. The `hash_type` is **`data1`**, not `type`.

```sh
curl -s -X POST http://127.0.0.1:8310 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}' | jq '.result.udt_cfg_infos'
```

For a `fiber-forge` dev chain the script is stable:

```
code_hash 0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419
hash_type data1
args      0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947
```

## 4. Start the payment backend, pointed at the mint's node

`FIBERNUTS_NETWORK=devnet` matters: a dev chain **rejects** an invoice with currency `Fibt` and
demands `Fibd`.

```sh
cd fibernuts
cargo build --release --manifest-path mint/Cargo.toml -p fibernuts-processor

FIBERNUTS_FIBER_RPC=http://127.0.0.1:8310 \
FIBERNUTS_NETWORK=devnet \
FIBERNUTS_UNIT=rusd \
FIBERNUTS_UNIT_SCALE=1000000 \
FIBERNUTS_UDT_CODE_HASH=0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419 \
FIBERNUTS_UDT_HASH_TYPE=data1 \
FIBERNUTS_UDT_ARGS=0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947 \
FIBERNUTS_POLL_SECS=2 \
./mint/target/release/fibernuts-processor
```

The ecash unit is still called `rusd`. On a dev chain the backing asset is `simple_udt` standing in
for RUSD — same 8 decimals, same code path, same `unit_scale`.

## 5. Start a stock mint

```sh
cargo install cdk-mintd --version 0.17.2
cdk-mintd --config deploy/mintd.config.toml --work-dir /tmp/fibernuts-mint
```

Set a real `mnemonic` in the config first. Confirm the backend registered:

```sh
curl -s localhost:8085/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":500000}]
```

## 6. Move money

```sh
npm --prefix wallet ci && npm --prefix wallet run dev    # http://127.0.0.1:5174
```

In the wallet: **Mint** $1.00 and copy the `fibd1…` invoice. Pay it from the payer node:

```sh
curl -s -X POST http://127.0.0.1:8312 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"send_payment","params":[{"invoice":"fibd1…"}]}'
```

The wallet credits itself within a couple of seconds. **Send** a token, **Receive** it back, then
**Melt** against an invoice issued by the payer node:

```sh
curl -s -X POST http://127.0.0.1:8312 -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"new_invoice","params":[{
    "amount":"0x2625a00", "currency":"Fibd", "description":"melt target",
    "udt_type_script":{"code_hash":"0xe1e3…","hash_type":"data1","args":"0x32e5…"}}]}'
```

`0x2625a00` is 40,000,000 base units — 40 ecash units, $0.40.

### What a correct run looks like

Measured on the 3-node line above:

| | riemann (mint) | confucius (payer) |
|---|---|---|
| start | $0.00 | $1000.00 |
| after minting $1.00 | $1.00 | $999.00 |
| after melting $0.40 | $0.5996 | $999.40 |

The mint quoted a **$0.02** fee reserve, spent **40.04 units** on-chain (a 0.1% routing fee to
`lorentz`), charged the wallet **41 units**, and returned **1 unit** of change. The wallet ends at
$0.59. The mint over-collects the sub-unit remainder rather than ever eating a loss — ecash units
are integers, and the charging side always rounds up.

## 7. Live money-safety tests

The same devnet drives three `#[ignore]`d tests that assert the rules a mint cannot get wrong.
They are excluded from `make ci`, which never touches a node.

```sh
FIBERNUTS_TEST_RPC=http://127.0.0.1:8310 \
FIBERNUTS_TEST_PEER_RPC=http://127.0.0.1:8312 \
FIBERNUTS_TEST_NETWORK=devnet \
FIBERNUTS_TEST_UDT_CODE_HASH=0xe1e3… FIBERNUTS_TEST_UDT_HASH_TYPE=data1 FIBERNUTS_TEST_UDT_ARGS=0x32e5… \
cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test live_devnet -- --ignored
```

`a_held_tlc_is_never_credited` forges a **hold invoice** — the one thing `cdk-fiber` will never
create — pays it for real, waits for the node to park the TLC in `Received`, and asserts the backend
credits nothing. It then cancels the invoice to release the peer's funds.

## 8. Tear down

```sh
node bin/forge.mjs down line3 --purge
```

---

## If it breaks

| symptom | cause | fix |
|---|---|---|
| `Currency must be Fibd with the chain network` | invoice currency does not match the chain | `FIBERNUTS_NETWORK=devnet` |
| mint quote succeeds, payment never routes | the mint's node opened the channel, so the peer has no outbound balance | open each hop from the node *further* from the mint |
| `Payment backend reports unit … but config registers unit …` | `[ln].unit` differs from `FIBERNUTS_UNIT` | make both exactly `rusd`; custom units compare by exact string |
| mintd exits: `data did not match any variant of untagged enum LnOneOrMany` | `min_mint`/`max_mint`/`min_melt`/`max_melt` missing | all four are mandatory in `[ln]` |
| mintd cannot reach the processor | `[grpc_processor].addr` has no scheme | `addr = "http://127.0.0.1"` (the processor *binds* a bare IP; the mint *dials* a URL) |
| melt quote fails, mint says `Unit unsupported` | cdk maps any backend error to a generic code | read the processor's log — the real reason is only there |
| melt quote fails with `allow_self_payment` | the melt invoice was issued by the mint's own node | issue it from the peer |
