# Security Policy

## Supported Scope

The `main` branch and the public reference deployment are under active development. The reference
deployment is testnet-only and has not received a formal security audit. FiberNuts does not support
mainnet or real-value use at this time.

## Reporting A Vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/code3ks/fibernuts/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

If private reporting is unavailable, contact `@code3ks` on Telegram only to arrange a private
reporting channel. Do not send exploit details or sensitive payment material in the initial message.

Include the affected component and version, reproduction steps using synthetic or testnet data,
the expected impact, and any suggested mitigation. Allow reasonable time for investigation before
public disclosure.

## Sensitive Material

Never include real Cashu proofs, encoded tokens, Fiber invoices tied to users, quote identifiers,
mnemonics, seed phrases, private keys, node keys, credentials, or production customer data in a
report. Redact logs and screenshots before attaching them.

Browser proofs and payment keys are currently stored in origin-local browser storage. They are
bearer secrets, are not encrypted by FiberNuts, and are not a recoverable backup. The mint remains
custodial and controls issuance and redemption.
