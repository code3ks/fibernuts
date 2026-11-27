# FiberNuts protocol deployment model

A fair question, because "a mint" is infrastructure and the deployment model isn't obvious. The
short version: **FiberNuts is not one hosted service. It is protocol software an operator self-hosts
to run an independent mint, much like a mail server or Lightning node.** Anyone can stand one up;
each mint has its own issuer, reserves, policies, and trust boundary.

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
- **fibernuts-processor**, the gRPC backend where the core `cdk-fiber` adapter runs;
- **cdk-mintd**, the stock Cashu mint server, exposing an HTTP API at, say, `https://mint.acme.com`;
- optionally the **wallet** as a static site, though users can bring their own.

A public testnet trial may also run the optional `faucet/` service with a separate funded Fiber
node. It pays a bounded number of fixed, browser-locked mint quotes so users can test an application
before consumer LSP and wallet funding flows exist. It is reference infrastructure, not part of the
mint trust model and not a general payment endpoint.

**The users** need only a compatible Cashu wallet to hold and transfer ecash. Adding cash and
cashing out also require access to a Fiber payer or wallet with a routable RUSD channel unless an
operator exposes a separate funding integration. Users point the wallet in this repository, or
another wallet that supports the mint's Fiber method and RUSD unit, at the operator's mint URL.
They:

- **add cash** by paying the mint's Fiber invoice, so RUSD flows in over a channel;
- **hold** bearer tokens on their own device, while accepting that browser storage is not a secure
  vault or guaranteed backup;
- **send and receive** tokens directly without an on-chain transaction or public transfer graph;
- **cash out** through a Fiber invoice when the mint accepts the request and a route has enough
  directional liquidity.

The operator's four services are the protocol infrastructure. Token handling and direct transfers
remain local to users; entry and exit also involve the external Fiber payment rail.

## Is it hosted?

Not centrally. There is no canonical FiberNuts service everyone shares. The model is **one operator,
one mint**, federated like email servers or Lightning nodes. A project-maintained reference instance
can demonstrate interoperability and provide a deployment template, but it is not a protocol trust
anchor and other operators do not depend on it.

`cdk-fiber` itself isn't "hosted" at all — it's a **library**, compiled into the processor. The
upstream goal is for it to live in `cashubtc/cdk` next to `cdk-cln` and `cdk-lnd`, so *any* Cashu
mint can flip a config switch and settle over Fiber. That's the real distribution story: not
"use my mint," but "any mint can now speak Fiber."

## The trust model — say it plainly

A Cashu mint is **custodial**. The operator holds the RUSD backing; users hold ecash, which is an
IOU on that mint. Users trust the operator to preserve the reserve and honor redemption. Direct
bearer transfers do not create an on-chain transfer graph, and blind signatures prevent the mint
from directly linking issuance to redemption. Timing, amount, network, browser, and mint-policy
metadata remain visible.

Fiber provides the route by which value can **enter and leave** the mint over payment channels. It
does not guarantee an exit: redemption still depends on mint availability and policy plus enough
directional route liquidity. A user can be unable to redeem even while holding valid ecash. When
those conditions are met, the mint can pay RUSD back over Fiber.

This is the same tradeoff every Cashu mint makes; fibernuts's contribution is making the backing
asset a **stablecoin settled over Fiber**, so the IOU is denominated in dollars rather than a
volatile coin, and the in/out rails are CKB payment channels.

## Production deployment requirements

The `devnet.md` and `testnet.md` runbooks verify the protocol mechanism. A production mint also
needs:

- **Liquidity.** Inbound RUSD channels so users can mint, outbound so they can melt. This is the
  genuine operational work — the same liquidity management any Lightning/Fiber node operator does.
- **TLS + a domain** in front of `cdk-mintd`, and a real `mnemonic` kept safe (it seeds the mint's
  signing keys — lose it and you can't honor outstanding ecash).
- **Backups** of the mint database (it records which quotes were paid and which proofs were spent).
- **Backups** of the processor settlement journal (it records stable quote/payment correlation and
  every nonterminal recovery intent). It is required alongside, not instead of, the mint database.
  Journal schema upgrades are automatic and transactional; back up the stopped processor volume
  before deploying a version that changes the schema.
- **Monitoring** of channel balances and the processor↔node link. The processor exposes
  aggregate-only RPC latency, timeout, retry, in-flight reconciliation, and backlog counters; set
  the `cdk_fiber::metrics` tracing target to `trace` to emit snapshots without operation IDs,
  invoices, hashes, or bearer data.

None of that changes `cdk-fiber`; it's the ordinary cost of running a payment service.

## Who would actually use it

- a **merchant** issuing store credit or gift cards intended to be redeemable for RUSD;
- a **community or DAO** running internal, private, instant payments without a chain fee per transfer;
- an **exchange or app** offering instant, private RUSD withdrawals that settle over Fiber;
- a **game** issuing in-app currency backed by an operator-managed RUSD reserve.

In every case the pattern is the same: the operator runs the mint, users hold bearer ecash, and
Fiber moves the real stablecoin in and out.
