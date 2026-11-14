# Compatibility targets

This document separates the deployed FiberNuts baseline from the versions selected for the next
reviewed implementation work. A target is not supported until its acceptance checks pass. Exact
versions and commits are used because the CDK payment trait, Fiber wire behavior, and hosted-LSP
interfaces can change independently.

Last reviewed: 2026-11-14.

## Status vocabulary

- **Tested:** exercised by the current repository tests or a named live environment.
- **Pinned:** selected for implementation and review, but not yet a supported FiberNuts release.
- **External:** owned upstream and not controlled by FiberNuts.
- **Blocked:** must not be presented as working until the stated gate passes.
- **Unsupported:** outside the current protocol boundary.

## Version matrix

| Surface | Exact target | Status | FiberNuts use |
|---|---|---|---|
| Current Fiber baseline | `nervos/fiber:0.9.0-rc7` | Tested | Existing devnet, public-testnet deployment, and hand-written JSON-RPC types |
| Stable Fiber target | `v0.10.1`, commit `d9b6bbd74faf5b168244e3ddea5b6762a04e0a71` | Pinned | Migrate the direct-node adapter and test environments after contract and recovery tests pass |
| Current CDK baseline | `cdk-common =0.17.2`, `cdk-payment-processor =0.17.2`, `cashubtc/mintd:0.17.2` | Tested | Existing processor and stock mint integration |
| Stable CDK target | `v0.18.3`, commit `b2035a3525c98b22226926bdc20fa128a1351ae5` | Pinned | Migrate the adapter, processor, and stock `cdk-mintd` together |
| Browser Fiber client | `@nervosnetwork/fiber-js@0.10.1` | Pinned | Browser-side Fiber APIs used by the hosted onboarding adapter |
| Hosted LSP | Fiber PR [#1623](https://github.com/nervosnetwork/fiber/pull/1623), `lsp-support` commit `5d564bd0bc86892544b62d594d48d4eeafa4194a` | External, blocked | Project-operated public-testnet LSP and typed tenant adapter; never a silent dependency on the moving branch head |
| Hosted-LSP design | Fiber issue [#1625](https://github.com/nervosnetwork/fiber/issues/1625) | External | Security and lifecycle requirements; the issue describes a prototype, not production readiness |
| CKB browser connector | `@ckb-ccc/ccc@1.3.6`, `@ckb-ccc/connector-react@2.2.2`, release commit `9ffef01a181751dacf1edde83ed43fcfb4646ded` | Pinned | First supported provider path is JoyID through CCC on public testnet |
| External funding example | `joii2020/fiber-wallet` commit `77decbbe17ef39f1e443015bae41e74e6dd3960d` | External reference | Transaction conversion, JoyID redirect signing, and witness-only merge behavior |
| Fiber Loop | Fiber PR [#1643](https://github.com/nervosnetwork/fiber/pull/1643), commit `14d6f8c8384b6a2fcfd04e88ded155755d064f17` | External, optional | Compatibility observation only; not an onboarding or settlement dependency |

Fiber `v0.10.1` uses V2 P2P messaging. Existing V1 channels continue to operate, but a `v0.10.x`
node cannot open a new channel with an older node. An upgrade plan must inventory existing channels,
upgrade both intended peers before opening new channels, and preserve a rollback path that does not
reuse a migrated store with an older binary.

## Direct settlement target

The stable migration is one coherent change:

1. Update `cdk-common` and `cdk-payment-processor` to exactly `0.18.3` and run the adapter against an
   unmodified `cdk-mintd 0.18.3`.
2. Update the Fiber node and test fixtures to exactly `v0.10.1`.
3. Re-verify every load-bearing statement in `docs/integration-contract.md` against those sources.
4. Run the full deterministic suite, restart/fault-injection suite, and opt-in live devnet cycle.
5. Deploy only after mint, melt, delayed settlement, fee accounting, asset validation, event
   delivery, and restart recovery all pass together.

Until those checks pass, `0.17.2` plus `0.9.0-rc7` remains the only tested FiberNuts combination.
Mixing one upgraded side with one baseline side is unsupported.

## Hosted-LSP target

The hosted path is isolated behind a typed adapter. The pinned upstream revision supplies tenant
registration, tenant-scoped Biscuit authorization, hosted channel state, remote signing requests,
and restart-aware delivery. It remains an unmerged upstream change and still documents production
gaps around credential recovery, signer-session fencing, durable continuations, and complete wallet
policy.

The project-operated public-testnet deployment is the acceptance environment. A Fiber-team public
LSP, if available, is an interoperability target rather than a release dependency.

Required adapter boundaries:

- tenant registration and credential storage;
- signer readiness and typed signing-request polling;
- private-channel open, funding, ready, closing, and recovery states;
- invoice, payment, and preimage authorization scoped to one tenant;
- timeouts that remain recoverable rather than being converted to terminal failure;
- tenant-isolated diagnostics that do not expose another tenant's state.

No hosted-LSP code is used on mainnet under this compatibility target.

## Browser funding target

JoyID through CCC is the first reviewed browser-provider path. The browser obtains a CCC signer,
selects cells for the exact RUSD type script and required CKB capacity, and asks Fiber to construct
the channel transaction with `open_channel_with_external_funding`.

Once Fiber returns `unsigned_funding_tx`, the transaction structure is frozen. The client may fill
only the witnesses for wallet-controlled inputs. It must not rebuild or change inputs, outputs,
output data, cell dependencies, or the channel identifier. The signed transaction is returned with
`submit_signed_funding_tx`; the wallet must not separately broadcast a different transaction.

The integration uses these reviewed APIs and behaviors:

- CCC signer connection and exact network/address inspection;
- `signOnlyTransaction` or the provider-specific JoyID redirect flow;
- Fiber `open_channel_with_external_funding`;
- Fiber `submit_signed_funding_tx`;
- Fiber `abandon_channel` only before signed submission;
- conflicting-input recovery or force close after signed submission, as defined by Fiber's
  external-funding lifecycle.

Funding review must show the network, funding lock, RUSD type script, RUSD amount, CKB capacity,
known fees, LSP identity, and recovery consequence before requesting a signature. Root wallet keys
and hosted-channel signing secrets stay outside the LSP process.

## Fallback and change rules

- If a stable Fiber or CDK migration breaks a money-safety invariant, keep the tested baseline and
  publish the blocker. Do not deploy a partial upgrade.
- If hosted-LSP PR `#1623` changes, evaluate the new commit as a separate target. Do not follow the
  branch head automatically.
- If the pinned hosted revision cannot pass the signer and restart gates, hosted onboarding remains
  unavailable; a direct-node flow is not described as equivalent onboarding.
- If JoyID or CCC cannot produce witness-only signatures for the frozen funding transaction, stop
  before submission. Adding another provider requires its own compatibility and interruption tests.
- Fiber Loop remains optional. Loop delays or UDT limitations do not relax direct-channel
  acceptance criteria.
- A version, API, security-boundary, or mainnet-exposure change requires a recorded review before
  implementation.

## Unsupported combinations

- arbitrary unpinned Fiber, CDK, `cdk-mintd`, hosted-LSP, or CCC versions;
- public mainnet hosted-LSP onboarding;
- automatic migration of V1 channels to V2;
- a wallet that rebuilds Fiber's unsigned funding transaction;
- LSP custody of root wallet keys or client signing secrets;
- Loop as a required source of onboarding liquidity;
- silently accepting a different network, unit, mint, or UDT type script.

## Primary sources

- [Fiber `v0.10.1`](https://github.com/nervosnetwork/fiber/releases/tag/v0.10.1)
- [Fiber external-funding contract](https://github.com/nervosnetwork/fiber/blob/d9b6bbd74faf5b168244e3ddea5b6762a04e0a71/docs/external-funding.md)
- [Hosted-LSP implementation PR](https://github.com/nervosnetwork/fiber/pull/1623)
- [Hosted-LSP design and open limitations](https://github.com/nervosnetwork/fiber/issues/1625)
- [CDK `v0.18.3`](https://github.com/cashubtc/cdk/releases/tag/v0.18.3)
- [CCC release commit](https://github.com/ckb-devrel/ccc/commit/9ffef01a181751dacf1edde83ed43fcfb4646ded)
- [Fiber wallet external-funding example](https://github.com/joii2020/fiber-wallet/tree/77decbbe17ef39f1e443015bae41e74e6dd3960d)
- [Fiber Loop PR](https://github.com/nervosnetwork/fiber/pull/1643)
