# Hosting FiberNuts services

This bundle runs the mint, payment relay, and bounded community testnet claim service on one server:
two isolated Fiber nodes, `fibernuts-processor`, a stock `cdk-mintd`, the relay, the faucet API, and
a TLS proxy. One `docker compose up` starts the full stack.

```
┌────────────────────────── your VPS (public IP) ──────────────────────────┐
│  fnn ──127.0.0.1:8227── processor ──127.0.0.1:50051── mintd             │
│   │        faucet-fnn ──127.0.0.1:8227── faucet API       relay          │
└───│──────────────│────────────── Caddy :443 ───────────────┬─────────────┘
   :8228          :8238       mint.you.com / claim.you.com  pay.you.com
   mint P2P       payer P2P   mint API / fixed quote payer  payment delivery
```

The processor and mintd share the mint node's network namespace; the faucet API shares the payer
node's namespace. Both JSON-RPC endpoints stay private while P2P remains public. The payer is a
separate node because a Fiber node cannot pay its own invoice.

## What you need

- A **VPS** with a **public IPv4**. Runtime is light, but the on-server Rust image build is not;
  use 2 vCPU / 4 GB RAM for a straightforward first deployment. Docker + Compose v2 are required.
- Three **subdomains** you own, with **A records** pointing at the VPS IP, e.g. `mint.you.com`,
  `pay.you.com`, and `claim.you.com`. The APIs keep separate browser and logging boundaries.
- Ports **80, 443, 8228, 8238** open in the firewall.

## Before replacing an existing mint

A new hostname is a new Cashu mint identity from a wallet's perspective. Existing tokens encode
their issuing mint URL, so holders of tokens from an earlier mint hostname will continue contacting
that hostname.

- For a **fresh test mint**, generate a new mnemonic and start with empty volumes.
- To **preserve an existing mint**, keep its original `MINT_MNEMONIC`, `mintd-data`, and `fnn-data`.
  Keep the old hostname reachable until every old token is redeemed or deliberately retired. Do not
  delete the old Droplet or its volumes before testing restored balances, quotes, and redemption.

Changing the wallet's compiled default only affects new browser profiles. Returning browsers retain
their selected mint URL in local storage and must explicitly switch mints; balances stay isolated by
mint URL and are not copied to the new hostname.

The steps below create a fresh DigitalOcean deployment for `mint.fibernuts.xyz`. A stateful
migration needs a separate backup-and-restore window.

## Create the DigitalOcean Droplet

1. In DigitalOcean, choose **Create → Droplets**.
2. Select an x86-64 **Ubuntu 24.04 LTS** image and a region close to expected users.
3. Choose at least **2 shared vCPU / 4 GB RAM** for the first build. You can measure usage and resize
   later, but do not attempt the Rust build on a memory-starved 1 GB host.
4. Add an SSH key, enable monitoring, name the host `fibernuts-mint`, and create the Droplet.
5. Optionally assign a DigitalOcean Reserved IP before creating DNS. This keeps the public address
   stable if the Droplet is later replaced.

Create a DigitalOcean Cloud Firewall and attach it to the Droplet. Docker-published ports can bypass
host-level UFW rules, so use the provider firewall as the outer boundary.

| Inbound protocol | Port | Source |
| --- | --- | --- |
| TCP | 22 | Your own IP or trusted administration range |
| TCP | 80 | All IPv4 and IPv6 |
| TCP | 443 | All IPv4 and IPv6 |
| TCP | 8228 | All IPv4 and IPv6 |
| TCP | 8238 | All IPv4 and IPv6 |
| UDP | 443 | All IPv4 and IPv6; optional, for Caddy HTTP/3 |

Allow all outbound traffic. Do not expose the Fiber RPC port `8227`, processor port `50051`, or
mintd port `8085`.

## Point the domain at it

First confirm the registrar has published authoritative nameservers for the domain:

```sh
dig +short NS fibernuts.xyz
```

If that is empty or reports `NXDOMAIN`, finish the domain registration or nameserver delegation at
the registrar before continuing. Then, at the active DNS provider for `fibernuts.xyz`, create all
records:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| `A` | `mint` | The Droplet or Reserved IPv4 | `300` while setting up |
| `A` | `pay` | The same Droplet or Reserved IPv4 | `300` while setting up |
| `A` | `claim` | The same Droplet or Reserved IPv4 | `300` while setting up |

Do not add an `AAAA` record unless the Droplet and Fiber announcement are intentionally configured
for IPv6. Wait until this prints the expected IPv4 before starting Caddy:

```sh
dig +short A mint.fibernuts.xyz
dig +short A pay.fibernuts.xyz
dig +short A claim.fibernuts.xyz
```

## Prepare the server

Connect with the SSH key selected during creation:

```sh
ssh root@<DROPLET_IP>
```

Install Git, jq, and Docker Engine from Docker's official Ubuntu repository:

```sh
sudo apt update
sudo apt install -y ca-certificates curl git jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run --rm hello-world
sudo docker compose version
```

Clone this repository:

```sh
REPOSITORY_URL=https://github.com/OWNER/fibernuts.git
git clone "$REPOSITORY_URL" fibernuts
```

## Deploy

Set the three API domains, the exact deployed market origin, the mint mnemonic, and a stable random
claim-identifier secret. The server's public IP is auto-detected, and each node's key password is
auto-generated.

```sh
cd fibernuts/deploy
cp .env.example .env
nano .env
# Set MINT_DOMAIN, RELAY_DOMAIN, FAUCET_DOMAIN, MARKET_ALLOWED_ORIGINS,
# MINT_MNEMONIC, and FAUCET_IDENTIFIER_SECRET.
chmod 600 .env

sudo docker compose config --quiet
sudo docker compose up -d --build
```

Compose detects this server's public IP, builds the processor, relay, and faucet, pulls the fnn and
mintd images, generates separate Fiber keys and configs on first boot, and obtains TLS certificates
for all three API domains.

Check it came up:

```sh
sudo docker compose ps
curl -fsS https://mint.fibernuts.xyz/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":1000000}]
curl -fsS https://pay.fibernuts.xyz/healthz | jq
# {"status":"ok"}
curl -fsS https://claim.fibernuts.xyz/healthz | jq
# {"status":"ok"}
curl -fsS https://claim.fibernuts.xyz/v1/config | jq
```

Confirm the node is announcing publicly (so wallets can route to it):

```sh
sudo docker compose exec fnn fnn-cli --url http://127.0.0.1:8227 info | grep -A2 addresses
# should list /ip4/<YOUR_PUBLIC_IP>/tcp/8228/p2p/<PeerId>
sudo docker compose exec faucet-fnn fnn-cli --url http://127.0.0.1:8227 info | grep -A2 addresses
# should list /ip4/<YOUR_PUBLIC_IP>/tcp/8238/p2p/<different PeerId>
```

Do not destroy the Droplet after this check. Record the public Fiber address and peer public key for
operators who will open channels to this node.

## Point the wallet at the new mint

Do this only after `/v1/info` works and the mint has usable RUSD liquidity:

1. Set `VITE_MINT_URL=https://mint.fibernuts.xyz` in the wallet hosting provider.
2. Redeploy the wallet because Vite embeds this value at build time.
3. In an existing browser profile, open **Mint details**, enter `https://mint.fibernuts.xyz`, and
   choose **Use this mint**. New profiles use the compiled default automatically.
4. Run one small add-cash, send/receive, and cash-out cycle before describing the endpoint as live.

The mint domain is an API endpoint, not the wallet's public page. Keep Open Graph and canonical URLs
pointed at the wallet host until a separate `fibernuts.xyz` or `app.fibernuts.xyz` deployment exists.

For the market application, also set `VITE_RELAY_ORIGIN=https://pay.fibernuts.xyz` and
`VITE_FAUCET_ORIGIN=https://claim.fibernuts.xyz`. Its deployed origin must exactly match
`MARKET_ALLOWED_ORIGINS` in the server `.env`; both services deliberately reject every other
browser origin.

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

## Fund the community claim node

`compose up` creates the separate `faucet-fnn` identity but cannot fund it or open a channel. Before
enabling claims:

1. Read `default_funding_lock_script` from `sudo docker compose exec faucet-fnn fnn-cli info`,
   convert that testnet script to a `ckt1...` address with a CKB address tool, and fund the address
   with testnet CKB plus on-chain RUSD.
2. Read the mint node's `pubkey` and announced `addresses` from
   `sudo docker compose exec fnn fnn-cli info`.
3. Connect the faucet node and open a public RUSD channel into the mint:

```sh
RUSD='{"code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a","hash_type":"type","args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"}'
MINT_ADDR='/ip4/<PUBLIC_IP>/tcp/8228/p2p/<MINT_PEER_ID>'
MINT_PUBKEY='<MINT_PUBKEY>'

sudo docker compose exec faucet-fnn fnn-cli peer connect_peer --address "$MINT_ADDR"
sudo docker compose exec faucet-fnn fnn-cli channel open_channel \
  --pubkey "$MINT_PUBKEY" \
  --funding-amount <RUSD_BASE_UNITS> \
  --public true \
  --funding-udt-type-script "$RUSD"
sudo docker compose exec faucet-fnn fnn-cli channel list_channels
```

One RUSD is `100_000_000` base units. Size the channel and `FAUCET_DAILY_CLAIM_LIMIT` together: the
default `10.00 RUSD` claim consumes `1_000_000_000` base units, and the daily budget must never
promise more than the payer's usable outbound balance. Keep `FAUCET_ENABLED=false` until the channel
is `ChannelReady`, then recreate the faucet container after changing it to `true`.

The service fetches each quote from only `MINT_DOMAIN`, validates exactly `FAUCET_AMOUNT` RUSD and
the packed testnet RUSD type script, decodes it through `faucet-fnn`, and persists the payment hash
before dispatch. It never accepts an
invoice from the browser and cannot issue Cashu proofs. Check aggregate demand without exposing
quote identifiers:

```sh
curl -fsS https://claim.fibernuts.xyz/v1/stats | jq
```

## Secrets and backups — read this

- **`MINT_MNEMONIC` is the mint's master key.** Every signing key is derived from it. Anyone who has
  it can forge unlimited ecash; if you *lose* it, every token you've issued becomes impossible to
  honor and holders lose their money. Generate a fresh one, back it up **offline and encrypted**,
  never commit it, never change it for the life of the mint.
- **Back up the `fnn-data` volume** (the CKB key, its auto-generated encryption password, and the
  channel state) and **`mintd-data`** (which quotes were paid, which proofs were spent). Losing
  `fnn-data` loses the node's on-chain funds; losing `mintd-data` corrupts the mint's accounting.
- **Back up `faucet-fnn-data` and `faucet-data`.** The first contains the separately funded payer
  key and channel state; the second prevents ambiguous claims from being dispatched twice.
- Keep `FAUCET_IDENTIFIER_SECRET` stable. It is not a spending key, but changing it breaks lookup
  and cooldown continuity for stored claims.
- Treat `relay-data` as sensitive transient bearer data. Back it up only when required for incident
  recovery, encrypt that backup, and delete it after the configured retention window.
- Keep `.env` at `chmod 600` and out of git (`.gitignore` already excludes it).

## Operating

```sh
sudo docker compose logs -f mintd         # mint activity
sudo docker compose logs -f processor     # cdk-fiber ↔ node (the only place backend errors surface)
sudo docker compose logs -f relay         # status and errors; no request access log
sudo docker compose logs -f faucet        # lifecycle errors only; quote identifiers are not logged
sudo docker compose logs -f faucet-fnn    # payer routing and channel state
sudo docker compose restart processor     # safe to restart; it reconnects
sudo docker compose down                  # stop (volumes persist)
```

## If something's off

| symptom | cause → fix |
|---|---|
| `/v1/info` unreachable / no cert | DNS A record not pointing at the VPS yet, or 80/443 blocked. Caddy needs both to issue a cert. `docker compose logs caddy`. |
| relay returns `origin_forbidden` | `MARKET_ALLOWED_ORIGINS` does not exactly match the browser's scheme and hostname. Update it and recreate the relay container. |
| relay health check fails | inspect `docker compose logs relay`; verify `relay-data` is writable and `RELAY_DOMAIN` uses the public HTTPS hostname. |
| claim button is unavailable | verify `claim` DNS/TLS, exact `MARKET_ALLOWED_ORIGINS`, and `FAUCET_ENABLED`; then inspect `docker compose logs faucet`. |
| claim remains in progress | inspect `faucet-fnn` payment state and channel outbound balance; resume the same claim instead of creating another. |
| faucet payment has no route | the separate payer needs a ready RUSD channel with outbound balance toward the mint; verify `list_channels` on `faucet-fnn`. |
| node not in the routing graph / nobody can pay | `PUBLIC_IP` wrong or `8228`/`8238` firewalled. Both announced P2P ports must be reachable. |
| mintd exits: `data did not match any variant of untagged enum LnOneOrMany` | a required `[ln]` limit is missing from `mintd.host.toml`. All four min/max are mandatory. |
| mint quote fails with `Unit unsupported` | that's cdk's generic label for a backend/route failure — read `docker compose logs processor` for the real reason (usually no route / no liquidity). |
| processor can't reach the node | the `network_mode: service:fnn` link — don't add `ports:` or `networks:` to processor/mintd; Docker rejects it and the loopback link breaks. |
| build fails: Dockerfile path | your Docker is old; upgrade to Compose v2 / BuildKit, or run the build from the repo root. |

## Network boundary

This bundle is intentionally fixed to CKB testnet RUSD. It has not been reviewed or configured for
mainnet value.

## Reproducible local version

For a demo with no server and no faucet, `deploy/devnet.md` runs the full cycle on a throwaway local
network (its asset is a stand-in UDT, not canonical RUSD). This hosting bundle is the real,
public version.
