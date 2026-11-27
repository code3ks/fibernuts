# M1 settlement reliability and refund report

Report date: 2026-11-27

Status: release candidate; public review has not started

Planned source tag: [`m1-settlement-reliability`](https://github.com/code3ks/fibernuts/releases/tag/m1-settlement-reliability)

## Outcome

M1 makes incoming and outgoing Fiber settlement recoverable across interruption without treating a
timeout as failure, dispatching a second payment, delivering a second credit event, or crediting both
sides of a vendor-settlement/refund race. It also moves the supported direct-settlement pair to Fiber
`v0.10.1` and CDK `v0.18.3`, exposes honest wallet recovery states, and makes failure and redaction
coverage reproducible.

This report distinguishes deterministic CI, opt-in devnet evidence, and public-deployment claims.
Ordinary CI does not contact a Fiber node or perform an economic operation.

## Delivered work

| Area | Issue | Pull request | Result |
|---|---|---|---|
| Durable settlement journal | [#6](https://github.com/code3ks/fibernuts/issues/6) | [#34](https://github.com/code3ks/fibernuts/pull/34) | Scoped, versioned journal with fail-closed migration and recovery |
| Incoming recovery | [#7](https://github.com/code3ks/fibernuts/issues/7) | [#35](https://github.com/code3ks/fibernuts/pull/35) | Restored invoice watches and at-most-once credit events |
| Outgoing recovery | [#8](https://github.com/code3ks/fibernuts/issues/8) | [#36](https://github.com/code3ks/fibernuts/pull/36) | Delayed terminal reconciliation without duplicate dispatch |
| RPC isolation | [#9](https://github.com/code3ks/fibernuts/issues/9) | [#37](https://github.com/code3ks/fibernuts/pull/37) | Request deadlines, bounded concurrency, backoff, and aggregate metrics |
| Wallet recovery | [#10](https://github.com/code3ks/fibernuts/issues/10) | [#38](https://github.com/code3ks/fibernuts/pull/38) | Pending/recoverable states and persisted settlement provenance |
| Vendor refund race | [#11](https://github.com/code3ks/fibernuts/issues/11) | [#39](https://github.com/code3ks/fibernuts/pull/39) | NUT-11 attendee refund with one winning mint swap |
| Stable compatibility | [#12](https://github.com/code3ks/fibernuts/issues/12) | [#33](https://github.com/code3ks/fibernuts/pull/33) | Fiber `v0.10.1` and CDK `v0.18.3` migration and devnet evidence |
| Fault injection and redaction | [#13](https://github.com/code3ks/fibernuts/issues/13) | [#40](https://github.com/code3ks/fibernuts/pull/40) | Failure-class manifest and public-output redaction gates |

The machine-readable [settlement evidence manifest](../evidence/settlement-reliability.json) maps 16
failure scenarios and seven redaction checks to source selectors and exact reproduction commands.

## Reproduce the release checks

Prerequisites are Rust `1.88` or newer with `rustfmt` and `clippy`, Node.js `24`, npm, Protocol
Buffers, and Chrome with the Playwright system dependencies. From a clean checkout of the published
tag:

```sh
git clone https://github.com/code3ks/fibernuts.git
cd fibernuts
git checkout m1-settlement-reliability

rustup component add rustfmt clippy
npm --prefix wallet ci
npm --prefix relay ci
npm --prefix market ci
npm --prefix wallet exec -- playwright install --with-deps chrome
npm --prefix market exec -- playwright install --with-deps chrome

make ci
```

Expected result: the evidence validator, Rust format/lint/test/build checks, wallet tests and browser
checks, relay tests, and market tests and browser checks all exit successfully. The evidence summary
must report 16 deterministic scenarios, all 16 required failure classes, seven redaction checks,
all nine secret classes, all five public sinks, and three separately named opt-in live scenarios.

Actual result on 2026-11-27: passed. `make ci` exited successfully with all 16 declared failure
classes and all redaction classes covered; 125 Rust tests, 40 wallet unit tests, 21 wallet browser
tests, six relay tests, 35 market unit tests, and 24 market browser tests passed. Three live-devnet
tests remained explicitly ignored by ordinary CI, as required.

The merged M1 fault-injection suite also has a public successful
[GitHub Actions run](https://github.com/code3ks/fibernuts/actions/runs/45729727864). Checks for the
published tag will be available from the
[tag check history](https://github.com/code3ks/fibernuts/commits/m1-settlement-reliability/checks).

## Acceptance scenarios

These commands isolate the four milestone-critical behaviors. Each must exit successfully.

### Pending outgoing recovery

```sh
cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment a_timed_out_dispatch_is_reconciled_and_never_sent_twice -- --exact
cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment delayed_outgoing_success_is_announced_once_after_restart_with_actual_fee -- --exact
```

Expected and actual behavior: the durable payment hash is reconciled without another dispatch, and
a delayed success emits once using the original principal plus Fiber's authoritative actual fee.

### Incoming recovery

```sh
cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment an_invoice_paid_while_the_processor_is_down_is_restored_on_start -- --exact
```

Expected and actual behavior: restart restores the invoice/hash binding and emits one credit event
only after Fiber reports `Paid`.

### Isolated RPC timeout

```sh
cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment a_stalled_rpc_reaches_its_deadline_without_blocking_other_reconciliation -- --exact
```

Expected and actual behavior: the stalled request reaches its deadline while another settlement
record continues to reconcile.

### Vendor settlement/refund race

```sh
npm --prefix market test -- --run src/domain/market-runtime.test.ts -t "allows only one balance credit when refund and vendor settlement race"
```

Expected and actual behavior: the mint's first accepted swap is the only balance credit. The losing
path records spent or recoverable state without adding value.

## Verification environment

| Component | Version used for the 2026-11-27 release-candidate run |
|---|---|
| Host | macOS `15.8.1`, arm64 |
| Rust | `rustc 1.94.1`, `cargo 1.94.1`; workspace minimum `1.88` |
| Node.js | `24.13.0` |
| npm | `11.6.2` |
| Protocol Buffers | `libprotoc 34.1` |
| Fiber protocol target | `v0.10.1`, commit `d9b6bbd74faf5b168244e3ddea5b6762a04e0a71` |
| CDK protocol target | `v0.18.3`, commit `b2035a3525c98b22226926bdc20fa128a1351ae5` |

The Fiber/CDK pins, image digests, migration rules, and stable devnet cycle are recorded in the
[compatibility matrix](../compatibility.md). On 2026-11-22, that disposable three-node devnet passed
all three opt-in adapter tests and a stock-mint cycle that issued 200 units, cashed out 100 units
with a one-unit realized fee, and retained 99 spendable units. That is stable-pair devnet evidence,
not public-testnet RUSD, reserve, solvency, or production-availability evidence.

## Security advisory check

The release candidate was checked with:

```sh
npm --prefix wallet audit --audit-level=high
npm --prefix market audit --audit-level=high
npm --prefix relay audit --audit-level=high
npm --prefix faucet audit --audit-level=high
cargo audit --file mint/Cargo.lock
```

All four npm audits report zero vulnerabilities. The Rust lock refresh removes every known high or
critical advisory. A full Rust audit reports one disclosed medium advisory,
[`RUSTSEC-2026-0459`](https://rustsec.org/advisories/RUSTSEC-2026-0459), in bundled SQLite through
`rusqlite 0.39.0`, plus unmaintained transitive `chrono` and `paste` warnings. The SQLite issue
requires the processor to open a database and sibling WAL file written by a less-trusted local
party. Operators must keep the journal directory private to the processor and accept restores only
through the validated operator procedure. Moving to the patched `rusqlite 0.41` line requires
raising the workspace minimum from Rust 1.88 to 1.89. That compatibility update is deferred rather
than represented as complete, and the advisory is not omitted from this report.

## Known limitations and unresolved nonblocking work

- CDK `0.18.3` does not acknowledge a payment-event stream item after the mint database commits it.
  Pull status checks remain the authoritative idempotent recovery path.
- Background incoming polling is bounded by the configured grace period. The durable record remains
  available for an explicit status check and is never converted to failure by elapsed time.
- Fiber may report a paid historical payment without a preimage. Paid state remains authoritative;
  a missing optional payment proof is not failure.
- Browser proofs and operation recovery use local browser storage. This is neither a secure vault
  nor a guaranteed backup, and multi-tab compare-and-swap remains future hardening.
- The stable live cycle used a local dev UDT. It does not establish that the public reference
  deployment has migrated, is solvent, or has sufficient directional RUSD liquidity.
- FiberNuts has not received a formal third-party security audit and is not presented as a
  production mint endorsement.
- The disclosed SQLite advisory and the two unmaintained transitive crates remain nonblocking
  dependency work; none is represented as resolved by the M1 tag.
- Hosted-LSP onboarding, browser-funded channels, reusable package publication, and controlled
  mainnet validation belong to later milestones.

## Incidents and findings

No known user-value loss or mainnet incident occurred during M1. Review findings were resolved
before this release candidate, including repeat-dispatch and migration hardening, wallet dependency
updates, credential-bearing mint URL rejection, diagnostic identity redaction, and stronger
evidence-command and screenshot-surface validation. No fixture or mocked result is reported as a
live Fiber settlement.

## Budget status

The approved grant totals $6,000 in four $1,500 payment stages. The initial $1,500 payment was
received and supported the solo implementation, testing, documentation, and testnet service work
reported above. The $1,500 M1 tranche has not been requested or received. No grant funds are
reported as RUSD reserves, user balances, CKB channel capacity, a third-party audit, or guaranteed
routing liquidity.

## Release and review gate

The source tag must be created from `main` only after the report pull request is reviewed and
merged. Publication of the GitHub release starts a review window of at least seven full days. The
publication timestamp, review deadline, release URL, and any remediation are recorded on
[issue #31](https://github.com/code3ks/fibernuts/issues/31). The M1 tranche is not requested until
that window has elapsed and all critical or high-severity money-safety, privacy, key-handling, and
recovery findings are resolved.
