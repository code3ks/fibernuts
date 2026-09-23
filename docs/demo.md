# Running / testing the mint (real world)

The mint is live at **https://mint.fibernuts.xyz**. Anyone can use it by pointing a Cashu wallet
at it and paying its Fiber invoices from **their own** Fiber node. To mint you must first connect
your node to the mint and open an RUSD channel — the mint has no way to credit you until a channel
carries the payment. This is that flow, end to end.

## What you need

- **The wallet** — open **https://fibernuts.xyz** in a browser. No install. It's already
  pointed at the mint.
- **Your own testnet Fiber node** (`fnn`) holding **RUSD** — this is what pays the mint's invoices.
  There is no consumer Fiber-wallet GUI yet, so you drive the node with `fnn-cli`.
  - Fund it with a little **testnet CKB** (channel cell + fees): https://faucet.nervos.org
  - Get **testnet RUSD** from the Stable++ faucet — see `deploy/testnet.md` for the exact steps.

Set an alias for your node's RPC:

```sh
fnn() { fnn-cli -u <your-node-rpc> "$@"; }     # e.g. http://127.0.0.1:8227
```

## Mint coordinates (paste as-is)

```sh
MINT_ADDR="/ip4/157.230.15.176/tcp/8228/p2p/QmbsNpwt8zpXoTMFg1xDUq5qpNvcdZQfeykbKMY9nd8e1H"
MINT_PUBKEY="03698c4b37049adb4f28a3eb2aa2a57f0a56cf25959a4d2161df5597f23c7d7d94"
MINT_CKB_ADDRESS="ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdy3egfd2s8w505cvtld77scx806ljhducha5aaa"
RUSD='{"code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a","hash_type":"type","args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}'
```

Amounts: in the **wallet you type RUSD** (e.g. `1.00`); in **`fnn-cli` you use base units**, where
`1.00 RUSD = 100_000_000`.

`MINT_CKB_ADDRESS` is only the operator's funding address for channel cells and fees. Do not send
RUSD there expecting ecash. The node opening the channel must hold the on-chain RUSD; opening the
channel moves that RUSD into outbound Fiber balance toward the mint.

## Step 1 — Connect to the mint and open an RUSD channel

You do this once. Your node funds the channel with RUSD (that RUSD is what you'll spend to mint).

```sh
fnn peer connect_peer --address "$MINT_ADDR"

fnn channel open_channel --pubkey "$MINT_PUBKEY" \
    --funding-amount 1000000000 --public true \
    --funding-udt-type-script "$RUSD"
```

- `--funding-amount 1000000000` = **10 RUSD**. The mint **auto-accepts** RUSD channels ≥ 10 RUSD
  (`auto_accept_amount`) — no action from the operator.
- If `open_channel` errors with *"waiting for peer to send Init message"*, the peer handshake is
  still finishing — wait a few seconds and re-run it.

Wait until the channel is ready:

```sh
fnn channel list_channels        # find your channel to $MINT_PUBKEY, state must be ChannelReady
```

The funding tx has to confirm on testnet, so this takes a few minutes. Once it's `ChannelReady`,
you never repeat this — every future mint is just the pay step below.

## Step 2 — Mint (turn your RUSD into ecash)

1. In the wallet → **Mint** tab → type an amount (≤ what you funded, e.g. `1.00`) → **request**.
2. The wallet shows a Fiber invoice (`fibt1…`) and starts polling. Pay it from your node:

```sh
fnn payment send_payment --invoice "<paste the fibt… invoice>"
```

3. The payment routes over your channel to the mint; the wallet auto-credits within a couple of
   seconds. You now hold RUSD ecash.

## Step 3 — Send / receive (peer to peer, no node needed)

- **Send** tab → amount → you get a `cashuB…` token string.
- The recipient opens the same wallet URL (a second browser / incognito / phone) → **Receive** →
  pastes it. The ecash is now theirs. This part is pure browser — no Fiber node involved.

## Step 4 — Melt (cash out ecash back to RUSD)

Have a node issue an RUSD invoice (yours, or the recipient's), then pay it from the wallet:

```sh
fnn invoice new_invoice --amount 50000000 --currency Fibt --udt-type-script "$RUSD"   # 0.50 RUSD
```

Paste the `fibt…` invoice into the wallet's **Melt** tab → **pay invoice**. The mint pays it over
Fiber and burns the proofs.

## Notes

- **The mint serves anyone.** It credits ecash to whoever pays an invoice it issued — different
  users pay from different nodes. You're not tied to one node; each payer just needs its own RUSD
  channel to the mint.
- **Sanity check the mint is up:** `curl -s https://mint.fibernuts.xyz/v1/info` (returns the
  `fiber`/`rusd` methods).
- **Melt needs the mint to have outbound RUSD** (which it gains as people mint). If a melt fails with
  `Unit unsupported`, that's cdk's generic label for a failed route — usually the mint's outbound
  RUSD is below the melt amount. Mint some first, or melt less.
- Operator side (deploying the mint itself) is in `deploy/HOSTING.md`; getting testnet RUSD is in
  `deploy/testnet.md`.
