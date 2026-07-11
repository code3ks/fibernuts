# Running the full cycle on public testnet, with real RUSD

This is the "production-real" demo: actual RUSD, the public CKB testnet, no fiber-forge and no dev
chain. It is more setup than `devnet.md` and has one genuine external dependency — **getting RUSD**,
which is issuer-controlled and can't be conjured. Read §1 before committing to this path.

The mechanics below are grounded in Fiber's own operator guide (the "Testnet: UDT (RUSD) Payment"
section of the fiber repo's `docs/public-nodes.md`) and the shipped `config/testnet/config.yml`.
Facts I could verify from source or a live endpoint are unmarked; anything I could not drive
end-to-end is marked **[unverified]**.

## Topology

Same shape as the devnet demo, and for the same reason — a mint can only *receive* if some node
holds outbound liquidity toward it:

```
node B ──RUSD channel──▶ node A            A = your mint's node   (fibernuts points here)
(payer, you run it)      (mint)            B = the payer          (you run it too)
```

**Node B must open the channel into A**, funded with RUSD. Then:

- **Mint** — the wallet asks the mint for an invoice; **B pays it**; A receives RUSD; ecash issued.
- **Melt** — the wallet melts ecash; the mint (A) pays an invoice, spending the RUSD it accumulated.

You need a node you control on the paying side. Public testnet nodes exist and hold RUSD (see §6),
but they only *accept* channels and *issue* invoices — none of them will *initiate* a payment to
your mint on demand, so they can serve as melt targets but cannot mint for you. Hence node B.

---

## 1. The RUSD reality — read this first

RUSD is **Stable++'s** issuer-run stablecoin. Its UDT `args`
(`0x878fcc6f…8526439b`) is Stable++'s owner-lock hash, and CKB's sUDT/xUDT rules only permit minting
in "owner mode" — a transaction spending a cell locked by that owner. **You cannot self-mint
anything the network will accept as RUSD.** (Confirmed against the xUDT owner-mode standard and the
node's whitelist.)

So RUSD must be *acquired*, best-first:

1. **The Stable++ testnet faucet**, which Fiber's own docs link:
   `https://testnet0815.stablepp.xyz/faucet`. It can't fill a node address directly — you claim RUSD
   into a wallet (e.g. JoyID testnet, `https://testnet.joyid.dev/`) and then transfer it on-chain to
   node B's address. **[unverified]** the faucet still dispenses in 2026 — all URLs returned 200, but
   nobody drove the UI. Budget for flakiness.
2. **The Stable++ CDP dapp** (`https://www.stablepp.xyz/`): open a vault with testnet CKB collateral,
   borrow RUSD. **[unverified]** the testnet toggle / vault contracts still function.
3. **Ask a holder.** Stable++ Discord/Telegram, or a transfer from anyone holding testnet RUSD. This
   is the guaranteed path but needs a human handshake — plan ahead.

If none of these land in time, **skip to §7** and issue your own testnet xUDT. That still
demonstrates real Fiber settlement of a real on-chain stablecoin-shaped asset — just not canonical
RUSD, which you should say plainly rather than dress up.

> Because the RUSD script is fixed and public, `cdk-fiber` ships it as the default. The earlier
> truncation bug in `config.rs` is fixed, so on testnet you need **no** `FIBERNUTS_UDT_*` override —
> the defaults are already the correct RUSD script.

---

## 2. Run node B (the payer)

On testnet the CKB chain is public, so — unlike the devnet — node B needs **no** CKB dev chain. The
shipped `config/testnet/config.yml` already points at a public CKB RPC
(`https://testnet.ckbapp.dev/`), carries testnet bootnodes for peer discovery, and whitelists RUSD.
You only move its two ports off A's.

```sh
mkdir -p ~/fibernuts-demo/nodeB && cd ~/fibernuts-demo/nodeB
cp /path/to/fiber/config/testnet/config.yml ./config.yml

# B's ports: P2P 8228 -> 8238, RPC 8227 -> 8237
sed -i.bak 's|tcp/8228|tcp/8238|' ./config.yml
sed -i.bak 's|127.0.0.1:8227|127.0.0.1:8237|' ./config.yml
```

Run it (Docker image `nervos/fiber:0.9.0-rc7` — no `v` prefix; your node A on `0.9.0-rc2` interops
fine, testnet nodes span versions):

```sh
# node B's CKB private key (bare hex, no 0x) at ./ckb/key
docker run --rm -it --name fiber-nodeB \
  -e FIBER_SECRET_KEY_PASSWORD='changeme' -e RUST_LOG=info \
  -v "$HOME/fibernuts-demo/nodeB:/fiber" \
  -p 8238:8238 -p 8237:8237 \
  nervos/fiber:0.9.0-rc7
```

**[unverified]** end-to-end container run; the config/port facts are from source. If you have the
`fnn` binary, run it natively instead:
`FIBER_SECRET_KEY_PASSWORD=changeme fnn -c ./config.yml -d .`

Your existing node A stays as-is on `:8227`/`:8228`. Both A and B must reach each other; if either
is behind NAT/loopback, add `announce_private_addr: true` under `fiber:` in both configs and restart.

## 3. Fund node B: CKB, then RUSD

**CKB** (for channel reserve — a UDT channel commitment cell needs ~140 CKB per side, plus change
and fee; claim generously):

1. Get B's `ckt1…` address — derive it from B's key with `ckb-cli`/`ccc`, or read
   `node_info.default_funding_lock_script` from `:8237` and convert the script to an address
   (`app.ckbccc.com` does this). **[unverified]** exact field name across versions.
2. Paste it into `https://faucet.nervos.org` and claim.

**RUSD** — do the §1 flow, then send the RUSD **to that same `ckt1…` address**. The node funds a UDT
channel by spending B's own on-chain RUSD cells, so the RUSD must physically sit at B's address
first. Get **≥ 20 RUSD** (a comfortable channel size). Confirm it landed:

```sh
ckb-cli wallet get-live-cells --address <ckt1_of_nodeB>
```

If B has no RUSD when you open, the failure is **asynchronous**: `open_channel` returns a
`temporary_channel_id`, then funding aborts with `can not find enough UDT owner cells`. Watch B's log
and `list_channels`, not the `open_channel` return value.

## 4. Connect B → A and open the RUSD channel

Get A's pubkey from `:8227` (`node_info` → `.result.pubkey`), then from B:

```sh
# connect B to A (pubkey is enough if A is announced; else pass a full multiaddr)
curl -s http://127.0.0.1:8237 -H 'content-type: application/json' -d '{
  "id":1,"jsonrpc":"2.0","method":"connect_peer",
  "params":[{"pubkey":"<A_PUBKEY>"}]}'

# open a 20.00 RUSD channel B -> A. funding_amount is raw RUSD base units (8 decimals):
#   20 RUSD = 2_000_000_000 = 0x77359400
curl -s http://127.0.0.1:8237 -H 'content-type: application/json' -d '{
  "id":2,"jsonrpc":"2.0","method":"open_channel","params":[{
    "pubkey":"<A_PUBKEY>",
    "funding_amount":"0x77359400",
    "public":true,
    "funding_udt_type_script":{
      "code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      "hash_type":"type",
      "args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}}]}'
```

This `open_channel` is byte-for-byte the one in Fiber's own `public-nodes.md`. B (opener) supplies
all 20 RUSD plus its own CKB reserve; A (acceptor) contributes **0 RUSD** but still reserves a little
CKB, so **A also needs some testnet CKB**. A auto-accepts because the shipped config sets
`auto_accept_amount: 1000000000` (10 RUSD) for RUSD and 20 ≥ 10.

Poll until ready (from either node):

```sh
curl -s http://127.0.0.1:8237 -H 'content-type: application/json' \
  -d '{"id":3,"jsonrpc":"2.0","method":"list_channels","params":[{}]}' \
  | jq '.result.channels[] | select(.funding_udt_type_script!=null)
        | {state:.state.state_name, local:.local_balance, remote:.remote_balance}'
# want: state ChannelReady, and from A's view local 0x0 / remote 0x77359400 (B holds it all)
```

## 5. Point fibernuts at A, then mint and melt

The processor defaults are already correct for testnet RUSD — only the RPC URL changes:

```sh
cd /Users/truthixify/dev/hacks/fib/fibernuts
cargo build --release --manifest-path mint/Cargo.toml -p fibernuts-processor
FIBERNUTS_FIBER_RPC=http://127.0.0.1:8227 ./mint/target/release/fibernuts-processor
# NETWORK=testnet (Fibt), UNIT=rusd, UNIT_SCALE=1000000, and the RUSD script are all defaults.
```

In `deploy/mintd.config.toml`, tighten the limits under the channel size (20 RUSD = 2000 ecash
units), set a real `mnemonic`, then start `cdk-mintd` as in the top-level README:

```toml
[ln]
unit = "rusd"
min_mint = 1
max_mint = 1000      # $10.00, comfortably under the 20 RUSD channel
min_melt = 1
max_melt = 1000
```

**Mint** — request a quote in the wallet, copy the `fibt1…` invoice, and pay it from B:

```sh
curl -s http://127.0.0.1:8237 -H 'content-type: application/json' \
  -d '{"id":4,"jsonrpc":"2.0","method":"send_payment","params":[{"invoice":"<fibt1… from the quote>"}]}'
```

The wallet credits within a couple of seconds. **Send / receive** a token locally. **Melt** against
an invoice B issues (`new_invoice` on `:8237`), and the mint pays it back over the channel.

## 6. Melting to the public nodes (optional)

Fiber runs public testnet nodes that hold RUSD; `public-nodes.md` documents node1
(`02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71`) and node2, and shows a mint's
node paying node2's RUSD invoices routed `A → node1 → node2`. Once A has RUSD balance to spend (after
minting), you can melt against a node2 invoice instead of B's — a real multi-hop settlement over
infrastructure you don't run. This only covers melt; minting still needs B.

## 7. Fallback: your own testnet xUDT

If real RUSD is out of reach, issue your own testnet xUDT and repoint fibernuts at it. Because
**both** nodes are yours, they'll accept a token the public nodes would reject.

1. Mint a token on CKB testnet whose `args` is the lock hash of a key you hold (via `ccc`
   `ClientPublicTestnet` or `ckb-cli`); fund the issuing address from `faucet.nervos.org` first.
   Record its `{code_hash, hash_type, args}`. **[unverified]** the canonical testnet xUDT code cell —
   look it up or deploy your own.
2. Replace the RUSD `udt_whitelist` entry in **both** A's and B's `config.yml` with your token
   (`code_hash`/`hash_type`/`args` + an `auto_accept_amount`), and restart both. The whitelist is
   per-node and never fetched from chain, so both must carry it.
3. Repoint the processor — you must set **both** vars (`FIBERNUTS_UDT_ARGS` alone is ignored):

```sh
FIBERNUTS_UDT_CODE_HASH=0x<your_code_hash> \
FIBERNUTS_UDT_ARGS=0x<your_owner_lock_hash> \
FIBERNUTS_UDT_HASH_TYPE=type \
FIBERNUTS_UNIT_SCALE=<base units per ecash unit for your token's decimals> \
FIBERNUTS_FIBER_RPC=http://127.0.0.1:8227 ./mint/target/release/fibernuts-processor
```

4. Send your token to B, then run §4–5 unchanged with your token's script in
   `funding_udt_type_script`.

---

## Verified / unverified

- **Verified from source or a live endpoint:** the RUSD script and its byte-for-byte match to
  `cdk-fiber`'s default; the shipped testnet config whitelists RUSD and targets public CKB;
  `open_channel`/payment shapes (Fiber's own `public-nodes.md`); a UDT channel's acceptor contributes
  0; the opener must hold on-chain RUSD first; you cannot self-mint RUSD; `nervos/fiber:0.9.0-rc7`
  exists (rc2 has no image); the processor defaults.
- **Probable, not driven end-to-end:** the Stable++ RUSD faucet still dispenses in 2026.
- **Unverified:** the Stable++ CDP dapp testnet UI; exact CKB faucet amounts; the Docker container run
  end-to-end; the canonical testnet xUDT code cell for §7; exact per-side CKB reserve (budget
  ~140 CKB, confirm via `list_channels`).

For a fully reproducible demo with zero external dependencies, use `devnet.md` instead — the tradeoff
is that its asset is a dev UDT standing in for RUSD, not the canonical Stable++ token.
