# FiberNuts payment relay

The relay delivers a standard NUT-18 payment payload from an attendee browser to a vendor browser.
It does not issue ecash, swap proofs, hold wallet balances, or decide that an order is paid.

The vendor generates independent read and write capabilities before registering an order. The
relay stores only SHA-256 capability hashes. The write capability appears in the payment request;
the read capability remains on the vendor device.

## Run locally

Node.js 24 or newer is required for the built-in SQLite module.

```sh
cp .env.example .env
set -a
. ./.env
set +a
npm ci
npm test
npm run build
npm start
```

`POST /v1/orders` registers one short-lived slot. `POST /v1/deliver/:write-capability` durably
stores the first matching NUT-18 payload and returns `202`; retrying the same payload is idempotent,
while replacement is rejected. The vendor uses the read capability as a bearer authorization for
`GET /v1/inbox`, `POST /v1/inbox/ack`, and `POST /v1/inbox/cancel`.

Acknowledgement means the vendor persisted the payload locally. It does not mean the mint accepted
the proofs. The vendor application may display `Paid` only after its receive-side swap returns and
fresh proofs are persisted.

## Deployment boundaries

- Terminate TLS before the service and set `FIBERNUTS_RELAY_PUBLIC_ORIGIN` to the HTTPS origin.
- Allow only the deployed market origins through `FIBERNUTS_RELAY_ALLOWED_ORIGINS`.
- Mount `/app/data` persistently when using the container.
- Disable reverse-proxy and platform request-body logging. Capability-bearing delivery paths must
  also be excluded from access logs or irreversibly redacted.
- Back up the SQLite database as sensitive transient bearer data.
- A successful `/healthz` response proves only that the process and database opened.
