# FiberNuts testnet claim service

This service pays a fixed number of fixed-amount RUSD mint quotes from a dedicated Fiber testnet
node. It exists so a community member can try the reference application without first operating a
node. It is not a general invoice payer, token issuer, or production faucet.

## Safety boundary

- A browser creates a NUT-20 mint quote locked to a one-time browser key.
- The API accepts only the quote ID and a random browser ID in a POST body.
- The service fetches the quote from one configured mint and requires the configured amount,
  `rusd` unit, valid compressed quote public key, unexpired `fibt1` invoice, exact decoded Fiber
  amount, and byte-exact testnet RUSD type script.
- The quote and payment hash are persisted before dispatch. An unknown response is reconciled with
  `get_payment` before the same invoice can be retried.
- Browser cooldown, a small per-network daily cap, a global daily budget, and network request
  limits bound abuse. Network and browser identifiers are keyed hashes and are removed after the
  retention window. Public stats are aggregate counts only.
- Only the browser sends blinded outputs and receives proofs. The service never sees Cashu proofs or
  the one-time private key.

## API

```text
GET  /healthz
GET  /v1/config
GET  /v1/stats
POST /v1/claims  { "quote_id": "...", "client_id": "..." }
```

Claim data in query strings is rejected. Browser origins must exactly match
`FIBERNUTS_FAUCET_ALLOWED_ORIGINS`.

## Local checks

```sh
npm install
npm test
npm run typecheck
```

The production Compose topology and payer-channel setup are documented in
[`deploy/HOSTING.md`](../deploy/HOSTING.md).
