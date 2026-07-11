# Hosting a fibernuts mint

This bundle runs the whole mint on one server: the Fiber node, `fibernuts-processor`, a stock
`cdk-mintd`, and a TLS proxy — four containers, one `docker compose up`.

```
┌──────────────────── your VPS (public IP) ─────────────────────┐
│  fnn  ──127.0.0.1:8227──  processor  ──127.0.0.1:50051──  mintd │
│   │                                                        │   │
└───│────────────────────────────────────────────────────── │ ──┘
   :8228 (public P2P)          Caddy :443 ──proxy──▶ mintd :8085
   routing/announcement        https://mint.you.com   (the mint API)
```

The processor and mintd share the Fiber node's network namespace, so they reach it over
`127.0.0.1` — that keeps fnn's RPC private (no auth to manage) while its P2P port stays public so
payments can route to you. Only two ports face the internet: fnn's `8228` and Caddy's `80`/`443`.

## What you need

- A **VPS** with a **public IPv4** (any small box — 1 vCPU / 1 GB is plenty), Docker + Compose v2.
- A **domain** (or subdomain) you own, with an **A record** pointing at the VPS IP, e.g.
  `mint.you.com`. This is *your* domain — you buy/own it; nothing to look up.
- Ports **80, 443, 8228** open in the firewall.

## Deploy

You fill in exactly **two** things — your domain and a mnemonic. The server's public IP is
auto-detected, and the node's key password is auto-generated; you don't touch either.

```sh
cd fibernuts/deploy
cp .env.example .env
# edit .env: set MINT_DOMAIN (your domain) and MINT_MNEMONIC (a 12-word phrase — the file
# has a one-liner to generate one). Everything else is optional.
chmod 600 .env

docker compose up -d --build
```

That's it. Compose detects this server's public IP, builds the processor, pulls the fnn and mintd
images, generates the Fiber node's config (announcing that IP) and a fresh CKB key + key-password on
first boot, and Caddy fetches a TLS cert for your domain.

Check it came up:

```sh
docker compose ps
curl -s https://mint.you.com/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":1000000}]
```

Confirm the node is announcing publicly (so wallets can route to it):

```sh
docker compose exec fnn fnn-cli --url http://127.0.0.1:8227 info | grep -A2 addresses
# should list /ip4/<YOUR_PUBLIC_IP>/tcp/8228/p2p/<PeerId>
```

## The one thing `compose up` does NOT do: liquidity

A running mint isn't a *usable* mint until it has RUSD channels — this is the operational work, the
same as running any Lightning/Fiber node:

- **To let users mint** (receive), you need **inbound RUSD**: someone opens a public RUSD channel
  *into* your node, or you open one to a hub and rebalance. Your node auto-accepts RUSD channels
  ≥ 10 RUSD (`auto_accept_amount`).
- **To let users melt** (cash out), you need **outbound RUSD** — which you accumulate as users mint.
- The node also needs a little **testnet CKB** for the channel commitment cell — send some to its
  address (get the address with `fnn-cli` → `default_funding_lock_script`, faucet at
  `https://faucet.nervos.org`).
- Testnet **RUSD** itself comes from the Stable++ faucet (`https://testnet0815.stablepp.xyz/faucet`)
  via a wallet — it's issuer-controlled, you can't self-mint it. See `deploy/testnet.md`.

Until a funded RUSD channel exists, the mint will issue invoices that no one can pay. That's a
liquidity task, not a deployment one.

## Secrets and backups — read this

- **`MINT_MNEMONIC` is the mint's master key.** Every signing key is derived from it. Anyone who has
  it can forge unlimited ecash; if you *lose* it, every token you've issued becomes impossible to
  honor and holders lose their money. Generate a fresh one, back it up **offline and encrypted**,
  never commit it, never change it for the life of the mint.
- **Back up the `fnn-data` volume** (the CKB key, its auto-generated encryption password, and the
  channel state) and **`mintd-data`** (which quotes were paid, which proofs were spent). Losing
  `fnn-data` loses the node's on-chain funds; losing `mintd-data` corrupts the mint's accounting.
- Keep `.env` at `chmod 600` and out of git (`.gitignore` already excludes it).

## Operating

```sh
docker compose logs -f mintd         # mint activity
docker compose logs -f processor     # cdk-fiber ↔ node (the only place backend errors surface)
docker compose restart processor     # safe to restart; it reconnects
docker compose down                  # stop (volumes persist)
```

## If something's off

| symptom | cause → fix |
|---|---|
| `/v1/info` unreachable / no cert | DNS A record not pointing at the VPS yet, or 80/443 blocked. Caddy needs both to issue a cert. `docker compose logs caddy`. |
| node not in the routing graph / nobody can pay | `PUBLIC_IP` wrong or `8228` firewalled. It must be your real public IP and reachable. |
| mintd exits: `data did not match any variant of untagged enum LnOneOrMany` | a required `[ln]` limit is missing from `mintd.host.toml`. All four min/max are mandatory. |
| mint quote fails with `Unit unsupported` | that's cdk's generic label for a backend/route failure — read `docker compose logs processor` for the real reason (usually no route / no liquidity). |
| processor can't reach the node | the `network_mode: service:fnn` link — don't add `ports:` or `networks:` to processor/mintd; Docker rejects it and the loopback link breaks. |
| build fails: Dockerfile path | your Docker is old; upgrade to Compose v2 / BuildKit, or run the build from the repo root. |

## Not on testnet?

Point at mainnet by setting `FIBERNUTS_NETWORK=mainnet` and swapping the RUSD script + fnn `chain`
to mainnet values — but mainnet RUSD liquidity is a real commitment, so start on testnet.

## Reproducible local version

For a demo with no server and no faucet, `deploy/devnet.md` runs the full cycle on a throwaway local
network (its asset is a stand-in UDT, not canonical RUSD). This hosting bundle is the real,
public version.
