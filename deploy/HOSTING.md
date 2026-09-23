# Hosting FiberNuts services

This bundle runs the mint and payment relay on one server: the Fiber node,
`fibernuts-processor`, a stock `cdk-mintd`, the relay, and a TLS proxy. One
`docker compose up` starts all five services.

```
┌────────────────────── your VPS (public IP) ──────────────────────┐
│  fnn ──127.0.0.1:8227── processor ──127.0.0.1:50051── mintd     │
│   │                                                    relay     │
└───│──────────────────────── Caddy :443 ────────────────┬─────────┘
   :8228 public P2P        https://mint.you.com          https://pay.you.com
                           mint API                      payment delivery
```

The processor and mintd share the Fiber node's network namespace, so they reach it over
`127.0.0.1` — that keeps fnn's RPC private (no auth to manage) while its P2P port stays public so
payments can route to you. Only two ports face the internet: fnn's `8228` and Caddy's `80`/`443`.

## What you need

- A **VPS** with a **public IPv4**. Runtime is light, but the on-server Rust image build is not;
  use 2 vCPU / 4 GB RAM for a straightforward first deployment. Docker + Compose v2 are required.
- Two **subdomains** you own, with **A records** pointing at the VPS IP, e.g. `mint.you.com` and
  `pay.you.com`. The relay uses a separate hostname so its browser-origin boundary stays explicit.
- Ports **80, 443, 8228** open in the firewall.

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
| UDP | 443 | All IPv4 and IPv6; optional, for Caddy HTTP/3 |

Allow all outbound traffic. Do not expose the Fiber RPC port `8227`, processor port `50051`, or
mintd port `8085`.

## Point the domain at it

First confirm the registrar has published authoritative nameservers for the domain:

```sh
dig +short NS fibernuts.xyz
```

If that is empty or reports `NXDOMAIN`, finish the domain registration or nameserver delegation at
the registrar before continuing. Then, at the active DNS provider for `fibernuts.xyz`, create both
records:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| `A` | `mint` | The Droplet or Reserved IPv4 | `300` while setting up |
| `A` | `pay` | The same Droplet or Reserved IPv4 | `300` while setting up |

Do not add an `AAAA` record unless the Droplet and Fiber announcement are intentionally configured
for IPv6. Wait until this prints the expected IPv4 before starting Caddy:

```sh
dig +short A mint.fibernuts.xyz
dig +short A pay.fibernuts.xyz
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

Set the mint and relay domains, the exact deployed market origin allowed to call the relay, and the
mint mnemonic. The server's public IP is auto-detected, and the node's key password is
auto-generated.

```sh
cd fibernuts/deploy
cp .env.example .env
nano .env
# Set MINT_DOMAIN, RELAY_DOMAIN, MARKET_ALLOWED_ORIGINS, and MINT_MNEMONIC.
# The example file includes the expected shapes and a mnemonic generator.
chmod 600 .env

sudo docker compose config --quiet
sudo docker compose up -d --build
```

Compose detects this server's public IP, builds the processor and relay, pulls the fnn and mintd
images, generates the Fiber node's config and a fresh CKB key plus key password on first boot, and
Caddy fetches TLS certificates for both API domains.

Check it came up:

```sh
sudo docker compose ps
curl -fsS https://mint.fibernuts.xyz/v1/info | jq '.nuts["4"].methods'
# [{"method":"fiber","unit":"rusd","min_amount":1,"max_amount":1000000}]
curl -fsS https://pay.fibernuts.xyz/healthz | jq
# {"status":"ok"}
```

Confirm the node is announcing publicly (so wallets can route to it):

```sh
sudo docker compose exec fnn fnn-cli --url http://127.0.0.1:8227 info | grep -A2 addresses
# should list /ip4/<YOUR_PUBLIC_IP>/tcp/8228/p2p/<PeerId>
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

For the market application, also set `VITE_RELAY_ORIGIN=https://pay.fibernuts.xyz`. Its deployed
origin must exactly match `MARKET_ALLOWED_ORIGINS` in the server `.env`; the relay deliberately
rejects browser requests from every other origin.

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
- Treat `relay-data` as sensitive transient bearer data. Back it up only when required for incident
  recovery, encrypt that backup, and delete it after the configured retention window.
- Keep `.env` at `chmod 600` and out of git (`.gitignore` already excludes it).

## Operating

```sh
sudo docker compose logs -f mintd         # mint activity
sudo docker compose logs -f processor     # cdk-fiber ↔ node (the only place backend errors surface)
sudo docker compose logs -f relay         # status and errors; no request access log
sudo docker compose restart processor     # safe to restart; it reconnects
sudo docker compose down                  # stop (volumes persist)
```

## If something's off

| symptom | cause → fix |
|---|---|
| `/v1/info` unreachable / no cert | DNS A record not pointing at the VPS yet, or 80/443 blocked. Caddy needs both to issue a cert. `docker compose logs caddy`. |
| relay returns `origin_forbidden` | `MARKET_ALLOWED_ORIGINS` does not exactly match the browser's scheme and hostname. Update it and recreate the relay container. |
| relay health check fails | inspect `docker compose logs relay`; verify `relay-data` is writable and `RELAY_DOMAIN` uses the public HTTPS hostname. |
| node not in the routing graph / nobody can pay | `PUBLIC_IP` wrong or `8228` firewalled. It must be your real public IP and reachable. |
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
