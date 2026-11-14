# Controlled mainnet validation

This profile defines a small, direct-channel mainnet validation of FiberNuts. It is not a public
mainnet mint, hosted-LSP deployment, deposit service, proof of reserves, security audit, or
production endorsement.

**Current decision: NO-GO.** Recording the asset and limits does not authorize a mainnet action.
Every gate below must pass, the named reviewers must accept the evidence, and an operator must
explicitly start the run. No mainnet hosted-LSP work is included.

Last reviewed: 2026-11-14.

## Mainnet RUSD identity

The recorded mainnet RUSD metadata is:

```yaml
name: RUSD
decimals: 8
type_hash: 0x71ff665b40ba044b1981ea9a8965189559c8e01e8cdfa34a3cc565e1f870a95c
script:
  code_hash: 0x26a33e0815888a4a0614a0b7d09fa951e0993ff21e55905510104a0b1312032b
  hash_type: type
  args: 0x360c9d87b2824c357958c23e8878f686001e88e9527a08ea229e7d9ba7fe39a7
cell_dep:
  out_point:
    tx_hash: 0x8ec1081bd03e5417bb4467e96f4cec841acdd35924538a35e7547fe320118977
    index: 0x0
  dep_type: code
```

Unit conversions:

- `1 RUSD = 100,000,000` on-chain base units.
- `1 FiberNuts rusd unit = 0.01 RUSD = 1,000,000` on-chain base units.
- `5 RUSD = 500,000,000` base units.
- `50 RUSD = 5,000,000,000` base units.

The type script, type hash, decimals, and cell dependency are recorded from the pinned
[CKBFansDAO token registry](https://github.com/CKBFansDAO/xudtlogos/blob/3540c19603f85f3e46d4b535e7849cbe40762876/public/tokens/token_list.json),
whose RUSD entry links the Stable++ project. The type script and 8-decimal amount are independently
cross-checked against the mainnet mint transaction in the
[Nervos Web3 Platform test](https://github.com/nervosnetwork/Web3-Platform/blob/a74d39a15254091d72ecbc15bafa9713ba1f6469/src/aggregator/ckb/handlers/activity/xudt.test.ts#L91).

Fiber `v0.10.1` does not include RUSD in its stock mainnet UDT whitelist; its sample mainnet config
includes USDI. Therefore a ticker match or testnet RUSD configuration is not acceptable evidence.
The exact mainnet script above must be added explicitly and verified before a node starts.

## Independent verification

Reviewers must reproduce these checks from primary data rather than copy values from this file.

1. Read the RUSD entry at token-registry commit
   `3540c19603f85f3e46d4b535e7849cbe40762876` and record the script, type hash, decimals, and
   dependency.
2. Query mainnet transaction
   `0xf55e5ba3ae2159565cb4760b7b34f9c0a893186f34bb8ecd274fb3a99e75e213` from a trusted CKB node.
3. Confirm outputs `0x2`, `0x3`, and `0x4` use the recorded RUSD type script. Confirm the transaction
   is committed in block `0x2482764d5f7a37c62bab630009a4b46ba05ceb3b0f7db5a0c5c4907b566edde5`.
4. Decode each matching output data as a 16-byte little-endian unsigned integer and cross-check the
   8-decimal interpretation against the registry and Nervos test.
5. Query dependency transaction
   `0x8ec1081bd03e5417bb4467e96f4cec841acdd35924538a35e7547fe320118977` and confirm output `0x0`
   exists before using it as a `code` dependency.
6. Start the pinned Fiber binary with the candidate whitelist on an isolated node, call `node_info`,
   and compare the returned UDT script byte for byte. Do not infer identity from `name: RUSD`.

Example RPC query, with a reviewer-supplied trusted endpoint:

```sh
CKB_RPC_URL="https://your-trusted-mainnet-rpc.example"
TX_HASH="0xf55e5ba3ae2159565cb4760b7b34f9c0a893186f34bb8ecd274fb3a99e75e213"

curl -fsS -H 'content-type: application/json' \
  --data "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"get_transaction\",\"params\":[\"$TX_HASH\"]}" \
  "$CKB_RPC_URL" | jq '.result | {tx_status, outputs: .transaction.outputs, outputs_data: .transaction.outputs_data}'
```

An explicit Stable++ confirmation of the script and decimal metadata is required immediately before
the run. Any disagreement between the issuer, registry, chain data, Fiber configuration, or node
response is a no-go condition.

## Candidate Fiber whitelist entry

This entry is input to an isolated preflight, not a production configuration to deploy blindly:

```yaml
ckb:
  udt_whitelist:
    - name: RUSD
      script:
        code_hash: 0x26a33e0815888a4a0614a0b7d09fa951e0993ff21e55905510104a0b1312032b
        hash_type: type
        args: 0x360c9d87b2824c357958c23e8878f686001e88e9527a08ea229e7d9ba7fe39a7
      cell_deps:
        - cell_dep:
            out_point:
              tx_hash: 0x8ec1081bd03e5417bb4467e96f4cec841acdd35924538a35e7547fe320118977
              index: 0x0
            dep_type: code
```

`auto_accept_amount` is deliberately omitted. Fiber treats a configured value as a minimum and
would therefore auto-accept every nonnegative amount if it were set to zero. The validation uses
one explicitly approved direct channel between named nodes.

## Value limits

- Maximum total live Cashu liability: **50 RUSD**.
- Maximum principal per add-cash or cash-out operation: **5 RUSD**.
- Minimum evidence set: **10 reconciled direct-channel operations**.
- Participants: named operator wallets and nodes only.
- Assets and capacity: supplied by participating operators, not by user deposits or protocol funds.
- Access: no public mint URL, public faucet, open registration, public hosted LSP, or unrestricted
  deposit path.

`Live Cashu liability` means valid outstanding RUSD-denominated proofs issued by the validation
mint and not yet redeemed or invalidated. The operator must measure it from the mint database and
reconciliation report before and after every operation. On-chain wallet balance and Fiber channel
capacity are not substitutes for this liability measure.

## Required preflight

All items must pass in one recorded run:

- exact source tag, image digest, dependency lock, and SBOM are recorded;
- Fiber and CDK versions match `docs/compatibility.md` and their stable migration suites pass;
- exact network is mainnet and exact RUSD script, decimals, cell dependency, and unit scale pass
  independent verification;
- mint liability cap and per-operation cap are enforced in configuration and tested below the cap;
- one named direct RUSD channel is ready with sufficient directional liquidity and CKB capacity;
- wallet addresses, Fiber node IDs, mint identity, and operator contacts are recorded privately for
  incident response;
- processor, mint, Fiber node, databases, keys, and channel recovery material have tested backups;
- clock, disk, RPC, TLS, health, reconciliation, and log-redaction checks pass;
- every prior high-severity money-safety or key-handling finding is resolved;
- shutdown, pause, reconciliation, channel-close, and asset-return procedures are rehearsed on
  testnet;
- reviewers accept the preflight evidence and explicitly record a go decision.

## Operation procedure

1. Record pre-operation mint liability, on-chain balances, channel state, and directional balance.
2. Confirm the requested principal is at most 5 RUSD and projected liability is at most 50 RUSD.
3. Execute one add-cash or cash-out through the named direct channel.
4. Wait for authoritative Fiber and CDK terminal state. A timeout remains ambiguous and pauses the
   run.
5. Reconcile quote ID, payment hash, principal, actual fee, proofs issued or destroyed, liability,
   channel balance, and on-chain effect without publishing bearer secrets.
6. Record pass, failure, recovery, and any variance before the next operation.

At least one nonzero-fee case and one planned restart/recovery case are required. Forced failures
must not expose more than the 5 RUSD per-operation cap.

## No-go and stop conditions

Do not start, or stop immediately, when any of these is true:

- asset identity, decimals, dependency, network, or unit mapping is unverified or conflicting;
- a binary, image, wallet, signer, or configuration differs from the reviewed preflight;
- a high-severity security or money-safety finding is open;
- backups or restore rehearsal fail;
- caps cannot be enforced or current liability cannot be measured;
- the channel is not ready or directional liquidity is insufficient;
- an operation is ambiguous, reconciliation differs, a duplicate dispatch is suspected, or a
  balance changes without authoritative settlement;
- secret redaction fails;
- a required reviewer withdraws approval;
- the incident operator cannot pause new operations immediately.

No-go is an acceptable outcome. The result is documented as a blocked validation, not converted
into a broader or less controlled mainnet experiment.

## Incident and shutdown procedure

1. Stop new quotes and disable all ingress while preserving databases and logs.
2. Snapshot versions, configuration hashes, channel state, and redacted operation records.
3. Reconcile every non-terminal quote and payment by its existing identity; do not resend blindly.
4. Notify the named participants and reviewers with the value at risk and known state.
5. Resolve or wait out ambiguous payments before returning proofs or moving backing assets.
6. When liabilities reach zero, close the direct channel according to the rehearsed procedure and
   verify on-chain settlement.
7. Return remaining operator-supplied assets through the recorded operator process.
8. Publish a redacted incident report before any restart or expanded validation.

## Evidence record

The final report includes:

- versions, commits, image digests, configuration hashes, network, asset identity, and node IDs;
- reviewer go/no-go records;
- operation count, principal, actual fee, terminal state, recovery path, and reconciliation result;
- maximum observed live liability and proof that both caps held;
- start/end channel and on-chain balances;
- incidents, ambiguous states, retries, restarts, and remediation;
- confirmation that no bearer proofs, keys, credentials, or user-linked invoices were published;
- shutdown/channel-close outcome and remaining liabilities.

The report does not claim solvency, privacy beyond Cashu's blind-signature boundary, public service
readiness, or successful hosted-LSP mainnet operation.
