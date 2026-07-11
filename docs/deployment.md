# Who runs this, and how people use it

A fair question, because "a mint" is infrastructure and the deployment model isn't obvious. The
short version: **fibernuts is not one hosted service — it's software an operator self-hosts to run
their own mint, the way you'd run a mail server or a Lightning node.** Anyone can stand one up; each
mint is independent.

## The two sides

**The operator** runs the mint. That's a merchant, a community, an exchange, a game — anyone who
wants to issue ecash backed by RUSD on Fiber. They run four things on a server:

```
                       ┌───────────────── the operator's server ─────────────────┐
  wallets ──HTTPS──▶   │  cdk-mintd  ──gRPC──▶  fibernuts-processor  ──JSON-RPC──▶ │ ──▶ CKB
  (the public)         │  (the mint API)        (cdk-fiber inside)     Fiber node  │
                       └──────────────────────────────────────────────────────────┘
```

- a **Fiber node**, with RUSD channels — this is the operator's liquidity and settlement rail;
- **fibernuts-processor**, the gRPC backend (this is where `cdk-fiber`, the deliverable, runs);
- **cdk-mintd**, the stock Cashu mint server, exposing an HTTP API at, say, `https://mint.acme.com`;
- optionally the **wallet** as a static site, though users can bring their own.

**The users** run nothing. They point any Cashu wallet — the one in this repo, or any NUT-04/NUT-05
wallet (Cashu.me, Nutstash, a mobile app, a CLI) — at the operator's mint URL. They:

- **mint** ecash by paying the mint's Fiber invoice (RUSD flows in over a channel),
- **hold** bearer tokens in their own device (the mint never sees who holds what),
- **send / receive** those tokens peer-to-peer — instant, free, private, off the mint entirely,
- **melt** back to RUSD over Fiber when they want to cash out.

So the "infra" is the operator's four services. Everything a user does is an HTTP call to that mint
plus local token handling.

## Is it hosted?

Not centrally. There is no single fibernuts service everyone shares. The model is **one operator,
one mint** — federated, like email servers or Lightning nodes. For the hackathon there'd be **one
reference instance** (deploy it to a VPS, Railway, Render, Fly — anywhere that runs a Rust binary and
can reach a Fiber node), and that instance is both the demo and the template others copy.

`cdk-fiber` itself isn't "hosted" at all — it's a **library**, compiled into the processor. The
upstream goal is for it to live in `cashubtc/cdk` next to `cdk-cln` and `cdk-lnd`, so *any* Cashu
mint can flip a config switch and settle over Fiber. That's the real distribution story: not
"use my mint," but "any mint can now speak Fiber."

## The trust model — say it plainly

A Cashu mint is **custodial**. The operator holds the RUSD backing; users hold ecash, which is an
IOU on that mint. Users trust the operator not to disappear with the reserve. In exchange they get
transfers that are instant, free, and private — the mint cannot tell who paid whom, or who holds a
balance.

Fiber is what keeps this from being a closed silo: value **enters and leaves** the mint over real
payment channels. A user isn't trapped — they melt back to RUSD on Fiber (and, via Fiber's
cross-chain hub, potentially onward to Bitcoin Lightning) whenever they choose. The mint is a fast,
private layer *on top of* real settlement, not a walled garden.

This is the same tradeoff every Cashu mint makes; fibernuts's contribution is making the backing
asset a **stablecoin settled over Fiber**, so the IOU is denominated in dollars rather than a
volatile coin, and the in/out rails are CKB payment channels.

## What a real deployment needs beyond the demo

The demos in `devnet.md` / `testnet.md` are the mechanism. A production mint additionally needs:

- **Liquidity.** Inbound RUSD channels so users can mint, outbound so they can melt. This is the
  genuine operational work — the same liquidity management any Lightning/Fiber node operator does.
- **TLS + a domain** in front of `cdk-mintd`, and a real `mnemonic` kept safe (it seeds the mint's
  signing keys — lose it and you can't honor outstanding ecash).
- **Backups** of the mint database (it records which quotes were paid and which proofs were spent).
- **Monitoring** of channel balances and the processor↔node link.

None of that changes `cdk-fiber`; it's the ordinary cost of running a payment service.

## Who would actually use it

- a **merchant** issuing store credit or gift cards backed by a stablecoin, redeemable for real RUSD;
- a **community or DAO** running internal, private, instant payments without a chain fee per transfer;
- an **exchange or app** offering instant, private RUSD withdrawals that settle over Fiber;
- a **game** issuing in-app currency that's actually redeemable, not just a database number.

In every case the pattern is the same: the operator runs the mint, users hold bearer ecash, and
Fiber moves the real stablecoin in and out.
