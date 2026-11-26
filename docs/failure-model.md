# Threat and failure model

FiberNuts joins three value systems with different authorities: Cashu proofs, a custodial mint, and
Fiber payments backed by CKB assets. This model defines which observation can authorize a balance
change, which states must survive interruption, and which failures remain ambiguous.

This is a design and verification contract. Controls marked **target** are not claims about the
current implementation.

Last reviewed: 2026-11-24.

## Security goals

1. Never issue spendable ecash without authoritative incoming Fiber settlement.
2. Never release or restore spent proofs while an outgoing Fiber payment may still settle.
3. Never dispatch a second economic side effect merely because a response was lost.
4. Preserve enough durable context to reconcile every non-terminal operation after restart.
5. Bind proofs, operations, invoices, and balances to one mint URL, unit, network, and asset.
6. Keep bearer proofs, signing secrets, capabilities, and user-linked identifiers out of logs and
   telemetry.
7. Keep LSP tenant state and signing authority isolated without describing hosted operation as
   trustless or self-custodial.

## Authorities

| Question | Authoritative evidence | Not authoritative |
|---|---|---|
| May a mint quote issue proofs? | Fiber invoice state `Paid`, bound to the expected network and asset | `Received`, an HTTP success, a local timer, or a wallet screenshot |
| Did a cash-out settle? | Fiber payment state `Success`, reconciled by payment hash | Request timeout, process exit, or missing response |
| Did a cash-out fail terminally? | Fiber payment state `Failed` for the same payment hash | Unknown session, offline RPC, or exhausted local retries |
| May received Cashu proofs enter spendable balance? | Issuing mint accepts the proofs and returns fresh proofs, then the local commit succeeds | Token decode, signature shape, QR scan, or relay delivery |
| Is a proof already spent? | Issuing mint's spent-proof database | Browser history or sender assertion |
| Is a hosted channel usable? | Tenant-scoped channel state and signer readiness at the pinned LSP revision | LSP health alone or an on-chain funding transaction alone |
| Is an asset RUSD? | Exact network plus type script and configured decimal/unit mapping | Ticker, logo, mint metadata, or invoice description |
| Is a mint solvent? | Not proven by FiberNuts | Reachability, channel capacity, successful redemption, or operator claims |

## Assets and secrets

| Material | Security property | Storage and reporting rule |
|---|---|---|
| Cashu proofs and encoded tokens | Bearer value | Persist locally; never log, place in URLs, analytics, screenshots, or ordinary test output |
| Mint seed and mnemonic | Controls mint keys | Operator-only secret storage; never in source, images, support bundles, or reports |
| Outgoing payment hash and quote ID | Correlation and idempotency | Durable operation record; hash or redact in public evidence when linkable |
| NUT-11 witness private keys | Authorize vendor settlement or sender refund | Browser-local secret storage; never sent through the relay |
| LSP tenant credential | Authorizes tenant-scoped RPC | Encrypted transport and local storage; redact completely from diagnostics |
| Root signer and channel signer secrets | Control hosted identity and channel transitions | Client-owned; never enter the LSP process |
| CKB wallet key | Funds and signs channel transaction inputs | Remains in the selected wallet/provider; FiberNuts receives signatures, not the key |
| Invoices and preimages | May link or authorize payments | Store only where required for recovery; exclude from public evidence unless synthetic |

Browser storage is not a secure vault or a guaranteed backup. A successful local write proves only
that the browser accepted the write at that moment.

## Common operation states

Every economic operation uses explicit states with monotonic transitions:

```text
Draft
  -> AwaitingExternalAction
  -> Processing
  -> Settled
  -> Failed
  -> AmbiguousRecoverable
```

`Failed` requires authoritative terminal evidence. A deadline, disconnect, process crash, or missing
response produces `AmbiguousRecoverable` unless authoritative state proves a safe retry. A recovery
routine may move an ambiguous operation to `Processing`, `Settled`, or `Failed`; it must not create a
new economic operation under a new idempotency identity.

## Incoming mint settlement

Required durable identity:

- CDK mint quote ID;
- Fiber payment hash and invoice;
- mint URL, Cashu unit, Fiber network, and exact UDT type script;
- requested amount, unit scale, and expiry;
- last authoritative Fiber state and event-delivery state.

State progression:

```text
QuoteCreated -> InvoiceOpen -> InvoiceReceivedUnsettled -> InvoicePaid -> IssuanceEligible
                    |                    |                       |
                    v                    v                       v
                 Expired       AmbiguousRecoverable       EventDelivered
```

Invariants:

- `Received` never authorizes issuance.
- A restored watch checks authoritative state before emitting an event.
- A duplicate `Paid` observation may update reconciliation metadata but cannot issue a second event
  or a second set of proofs for the same mint request.
- Expiry without `Paid` does not erase evidence needed to reconcile a late or previously unseen
  settlement.

Failure cases and required behavior:

| Failure | Required behavior | Verification |
|---|---|---|
| Processor exits after invoice creation | Restore the watch and quote correlation | Restart before payment, then pay once |
| Fiber reports `Received` | Keep issuance unavailable | Hold-invoice negative test |
| `Paid` arrives while processor is offline | Reconcile once after restart | Restart around terminal transition |
| Duplicate store event | Deliver one terminal event | Replay identical event sequence |
| Malformed or wrong-asset invoice state | Reject before issuance | Wrong network, UDT, and unit fixtures |
| Fiber RPC is unavailable | Preserve non-terminal state and retry within bounds | Timeout and recovery test |

## Outgoing cash-out settlement

The journal persists intent before dispatch and binds:

- CDK melt quote ID and quote state;
- Fiber payment hash and original invoice;
- principal, reserved fee, actual fee, and total spent;
- mint URL, unit, network, and exact asset script;
- dispatch attempt, last authoritative node state, terminal event state, and retry metadata.

State progression:

```text
Prepared -> DispatchRecorded -> InFlight -> Settled
                              |       |
                              |       -> FailedAuthoritative
                              -> AmbiguousRecoverable
```

Invariants:

- Intent and idempotency identity are durable before calling Fiber.
- A timeout remains pending or recoverable; it never returns proofs as though payment failed.
- An unknown payment session is distinct from authoritative failure. Recovery may dispatch only
  when the durable record and node state prove that no prior dispatch occurred.
- A retry with an existing non-failed payment hash queries the existing session.
- `total_spent` equals invoice principal plus the actual terminal routing fee, using the configured
  scale and conservative rounding.
- Terminal event delivery is deduplicated independently from Fiber settlement.

Failure cases and required behavior:

| Failure | Required behavior | Verification |
|---|---|---|
| Crash before dispatch | Resume or safely dispatch the recorded intent once | Fault injection at journal boundary |
| Crash after dispatch but before response | Query by payment hash; do not resend blindly | Lost-response restart test |
| Payment remains in flight past deadline | Return pending/recoverable and continue reconciliation | Delayed settlement test |
| Node reports no session | Keep `Unknown` distinct from `Failed` and apply the safe-dispatch rule | Unknown-session fixture |
| Node reports terminal failure | Emit failure once and let CDK apply its proof policy | Failure replay test |
| Actual fee differs from quote reserve | Record actual fee and return correct change | Nonzero-fee live and deterministic tests |
| One RPC call stalls | Bound the call and continue unrelated reconciliation | Concurrency fault test |

## Cashu bearer transfer and receive

Token delivery is not settlement. The receiving path is:

```text
TokenDetected -> MintUnitAndRequestChecked -> SwapInProgress -> FreshProofsPersisted -> Settled
                                            |
                                            -> RecoverableTokenPreserved
```

The token remains unspendable local recovery material until the issuing mint returns fresh proofs
and the fresh proofs plus operation result are committed. Mint refusal, unavailability, unknown
state, or a double-spent response never increases spendable balance.

The outgoing path must persist the encoded token, retained proofs, operation record, and spendable
balance change as one local commit before displaying or copying the token. Reload must redisplay the
same token. Reclaim is permitted only after the issuing mint proves the outgoing proofs remain
unspent.

The browser presents `Processing`, `Pending`, `Settled`, terminal `Failed`, and
`AmbiguousRecoverable` as distinct phases. Every stored operation must explain the current
authoritative evidence, whether value is spendable or reserved, and the only safe next action.
Prepared outputs, reserved proofs, and bearer recovery material remain attached until a terminal
transition authorizes their removal. A pending proof check is not an unspent result and cannot
authorize reclaim.

Operation provenance records the mint response for name, unit, and Fiber method separately from an
operator-declared network and exact asset type script. An operator declaration is scoped to one
normalized mint URL. It must not follow a user-selected custom mint, and presentation must label it
as a declaration rather than independent verification.

## Hosted-LSP and client signer

The hosted LSP controls availability, tenant runtime scheduling, and the public Fiber connection.
The intended client signer controls root and channel signing secrets. Neither boundary proves mint
solvency, unrestricted access, or future redeemability.

Required lifecycle states:

```text
Unregistered -> CredentialIssued -> SignerRestored -> FundingReview
             -> AwaitingWalletSignature -> FundingSubmitted -> ChannelPending
             -> ChannelReady -> Closing -> ClosedOrRecoverable
```

High-risk failures:

| Threat or interruption | Required control |
|---|---|
| Tenant credential theft | Tenant-scoped least privilege, revocation/recovery design, complete redaction |
| Cross-tenant request | Authorization and store namespace reject before state access |
| Registration nonce replay | Cryptographic random nonce, one current nonce per signer, atomic consume |
| Stale signer session | Session fencing or an explicit security gate that blocks public onboarding |
| Signing request changed after review | Typed canonical request and signature over the reviewed value |
| Nonce or channel signer reuse | Persistent signer store, per-channel key isolation, monotonic counters |
| Client or LSP restarts with a request pending | Durable request and continuation; idempotent response submission |
| LSP reports healthy but tenant is not ready | Separate service, tenant, signer, and channel readiness states |
| Wallet changes the funding transaction | Freeze all fields except authorized witnesses; compare before submit |
| Signed funding response is lost | Reconcile channel and transaction state; never create a second opening blindly |
| LSP refuses or requires policy checks | Preserve state and show the actual policy/error; do not imply open access |

The pinned hosted-LSP revision is blocked from a public supported claim until credential recovery,
signer readiness, nonce safety, durable continuations, interruption recovery, and tenant isolation
pass the published tests.

## Browser proofs, keys, and concurrency

Required controls:

- store records are namespaced by mint URL and unit;
- payment requests reject unaccepted mints and wrong units before proof mutation;
- multi-tab mutation uses a lock or compare-and-swap revision so two tabs cannot spend the same
  proof set;
- money actions are disabled while the same operation is in flight;
- prepared outputs and operation state survive reload;
- clipboard previews and errors redact tokens and proofs;
- camera access begins only after a user chooses to scan;
- tokens, proofs, invoices, quote IDs, and capabilities never enter a URL or analytics event.

Storage loss can destroy bearer value. The UI must not imply secure backup until an export,
encryption, or deterministic recovery design has its own threat model and interruption tests.

## Vendor settlement and NUT-11 refund race

A vendor-locked payment has two competing terminal actions: vendor settlement with the vendor key,
or sender refund after the locktime. Exactly one proof spend may succeed at the mint.

Required invariants:

1. The sender cannot attempt refund before the encoded locktime and mint policy permit it.
2. The vendor cannot settle without the vendor key.
3. Relay possession of the token or request capability cannot redeem either path.
4. Both sides persist the token and operation before network mutation.
5. A timeout on either path is ambiguous, not a license for the other side to claim success.
6. Spendability is resolved by the mint; local clocks and relay status are advisory.
7. The losing path records the authoritative spent/refused result without changing balance.

Acceptance requires deterministic race tests for vendor-first, refund-first, concurrent attempts,
lost responses on each side, restart during each attempt, and replay after one terminal spend.

## Durability and retry rules

- Durable state is written before an external value-moving call.
- A database commit and the associated balance/proof mutation share one atomic boundary where the
  storage engine permits it.
- Retry identity is stable across process and browser restarts.
- Backoff is bounded and does not prevent manual recovery or unrelated operations.
- A compensating action is allowed only when authoritative state proves the original action cannot
  still settle.
- Corrupt, conflicting, or incomplete durable state fails closed and remains inspectable.

## Redaction contract

Production logs and public evidence must not contain:

- Cashu proofs or encoded tokens;
- mint seeds, CKB keys, root signer keys, channel signer keys, or tenant credentials;
- NUT-11 witness private keys;
- complete user-linked invoices or preimages;
- raw authorization capabilities;
- browser storage dumps.

Diagnostics may include version, network, operation type, redacted or keyed-hash identifiers,
state transition, bounded timing, error class, and aggregate counters. Redaction tests scan success,
failure, timeout, retry, and panic/error formatting paths.

The versioned [settlement evidence manifest](evidence/settlement-reliability.json) maps each required
failure class and public-output sink to a reproducible test. `make evidence-ci` checks that every
referenced source and selector still exists, that every declared class remains covered, and that the
manifest and its machine-readable summary contain no recognized bearer or user-linked values. Live
economic scenarios are named separately and remain explicit, ignored tests; ordinary CI never runs
them or contacts a Fiber node.

## Current baseline versus target controls

| Control | Current baseline | Required before completion |
|---|---|---|
| Only `Paid` authorizes incoming settlement | Tested | Preserve through stable upgrade and restart journal |
| Timeout/unknown never becomes failed cash-out | Durable restart reconciliation, delayed terminal events, request deadlines, and timeout fault injection tested | Extend live failure evidence at each release pin |
| Exact network and UDT validation | Tested | Re-verify on stable Fiber and mainnet preflight |
| Incoming/outgoing operation journal | Durable scoped schema, restored reconciliation, deduplicated notification handoff, bounded concurrent scheduling, and jittered backoff | Extend live failure evidence and operator health export |
| Wallet recovery and provenance | Processing, pending, terminal, and recoverable states; exact stored settlement context; reload and interrupted cash-out coverage | Multi-tab compare-and-swap and live mint-refusal evidence |
| Outgoing token redisplay/reclaim | Reload and pending-proof coverage in reference browser flows | Multi-tab and live safe-reclaim evidence |
| Hosted tenant and remote signer | Not shipped | Pinned upstream adapter plus public-testnet security gate |
| Browser wallet funding | Not shipped | JoyID/CCC witness-only external funding with interruption tests |
| NUT-11 refund | Browser flow has early-refund refusal, both winner orders, concurrent-race, reload/NUT-09 recovery, and replay coverage | Add public-testnet mint-refusal and interruption evidence |
| Mainnet validation | Not authorized | All conditions in `docs/mainnet-validation.md` pass |

## What this model does not prove

FiberNuts does not prove mint solvency, reserves, operator identity, regulatory approval, network
privacy, payer identity privacy, browser safety, wallet integrity, unrestricted redemption, route
availability, or consensus validity beyond the pinned libraries and nodes used. A health check is
availability evidence only. Channel capacity is not directional liquidity. Blind signatures hide
the direct issuance-to-redemption link but not timing, amount, network, browser, or operator-policy
metadata.
