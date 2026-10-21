# FiberNuts Community Market

This is the event application built on the FiberNuts protocol. An attendee spends RUSD Cashu ecash
from a browser wallet, a vendor receives a NUT-18 POST payment locked to the vendor's ephemeral
P2PK key, and the vendor swaps it for fresh proofs before the order is shown as paid. Fiber remains
the add-cash and cash-out rail at the edge of the application.

The application is testnet-only. Browser storage contains bearer proofs and recovery material; use
separate browser profiles for attendee and vendor roles and never treat the demo balance as money.

## Local development

```sh
cp .env.example .env
npm ci
npm test
npm run dev
```

The attendee application is at `/`; the vendor terminal is at `/vendor`. During local development,
the mint defaults to the Vite origin and is proxied to `http://127.0.0.1:8085`. The relay defaults
to `http://127.0.0.1:8090`, and the optional fixed-amount testnet claim service defaults to
`http://127.0.0.1:8091`.

## Configuration

- `VITE_MINT_URL`: HTTPS origin of a compatible RUSD Cashu mint.
- `VITE_RELAY_ORIGIN`: HTTPS origin of the FiberNuts payment relay.
- `VITE_FAUCET_ORIGIN`: HTTPS origin of the bounded testnet quote payer.
- `VITE_NETWORK_LABEL`: visible network label; keep test deployments clearly labeled.
- `VITE_PREVIEW_DATA`: set to `true` only for inert synthetic screenshots. Preview mode disables
  network and value-moving actions.

Vite embeds these values at build time. Changing them requires a new deployment.

## Vercel

Create a Vercel project with this repository and set **Root Directory** to `market`. Keep the
detected framework as Vite, then add all five variables from `.env.example` to Production and
Preview as appropriate. The included `vercel.json` installs the shared wallet and market lockfiles,
builds `dist`, preserves the direct `/vendor` entry route, and applies baseline browser security
headers.

The production relay must allow the exact deployed browser origin through
`FIBERNUTS_RELAY_ALLOWED_ORIGINS`. Do not use a wildcard origin: relay URLs contain bearer
capabilities. A successful static deployment proves only that the interface loads; verify one
low-value two-browser testnet cycle before presenting it as live.

The claim service must allow the same exact browser origin through
`FIBERNUTS_FAUCET_ALLOWED_ORIGINS`. It pays only a fixed quote from its configured mint; it is not a
general Fiber payment API.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

The browser suite uses a deterministic synthetic mint and relay. It does not prove public testnet
routing, mint reserves, RUSD liquidity, or deployment health.
