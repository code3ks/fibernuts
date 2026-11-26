import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSensitiveData,
  loadManifest,
  validateManifest,
} from "./verify-settlement-evidence.mjs";

test("public evidence manifest covers every declared failure and redaction class", () => {
  const summary = validateManifest(loadManifest());
  assert.equal(summary.deterministic_scenarios, 16);
  assert.equal(summary.redaction_checks, 7);
  assert.equal(summary.live_scenarios.length, 3);
  assertNoSensitiveData(JSON.stringify(summary), "machine-readable settlement summary");
});

test("evidence commands must select the declared test", () => {
  const manifest = structuredClone(loadManifest());
  manifest.deterministic_evidence[0].command =
    "cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment a_different_test -- --exact";
  assert.throws(() => validateManifest(manifest), /command does not select its evidence/);

  const commentedSelector = structuredClone(loadManifest());
  commentedSelector.deterministic_evidence[0].command =
    `cargo test --manifest-path mint/Cargo.toml -p cdk-fiber --test mint_payment a_different_test -- --exact # ${commentedSelector.deterministic_evidence[0].selector}`;
  assert.throws(() => validateManifest(commentedSelector), /shell control syntax/);

  const wrongValidator = structuredClone(loadManifest());
  wrongValidator.ordinary_ci.validator = "node scripts/unrelated.mjs";
  assert.throws(() => validateManifest(wrongValidator), /ordinary CI must be node-free and non-economic/);
});

test("report scanner rejects every synthetic secret class", () => {
  const canaries = [
    `cashuB${"a".repeat(40)}`,
    `creqA${"b".repeat(40)}`,
    `fibt1${"q".repeat(50)}`,
    `ckt1${"c".repeat(50)}`,
    "person@example.test",
    `0x03${"44".repeat(32)}`,
    `0x${"11".repeat(32)}`,
    "quotePrivateKey=synthetic-report-secret",
    "proofSecret=synthetic-report-proof",
    "readCapability=synthetic-report-capability",
    "credential=synthetic-report-credential",
    "authorization=synthetic-report-authorization",
    "seed=synthetic-report-seed",
    "preimage=synthetic-report-preimage",
    "quote_id=synthetic-user-linked-quote"
  ];

  for (const canary of canaries) {
    assert.throws(() => assertNoSensitiveData(JSON.stringify({ evidence: canary })));
  }

  assert.throws(() => assertNoSensitiveData(JSON.stringify({ refundPublicKey: "synthetic-public-key" })));
});
