import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = resolve(ROOT, "docs/evidence/settlement-reliability.json");
const PUBLIC_SOURCE_ROOTS = ["docs/", "market/", "mint/", "relay/", "scripts/", "wallet/"];
const ALLOWED_COMMAND_PREFIXES = [
  "cargo test --manifest-path mint/Cargo.toml ",
  "node --test ",
  "npm --prefix market run test:e2e -- ",
  "npm --prefix market test -- ",
  "npm --prefix wallet run test:e2e -- ",
  "npm --prefix wallet test -- "
];

const SENSITIVE_PATTERNS = [
  ["Cashu token", /cashu[AB][A-Za-z0-9_-]{20,}/i],
  ["payment request", /creq[ab][A-Za-z0-9_-]{20,}/i],
  ["Fiber invoice", /fib(?:t|d|b)1[0-9a-z]{30,}/i],
  ["CKB address", /\b(?:ckb|ckt)1[0-9a-z]{40,}\b/i],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["compressed public key", /\b(?:0x)?(?:02|03)[a-f0-9]{64}\b/i],
  ["32-byte value", /\b(?:0x)?[a-f0-9]{64}\b/i],
  ["named secret", /["']?(?:secret|proofSecret|token|privateKey|private_key|publicKey|public_key|quotePrivateKey|quote_secret|quoteSecret|quotePubkey|refundPrivateKey|refundPublicKey|readCapability|writeCapability|authorization|credential|mnemonic|seed|preimage|paymentHash|payment_hash|paymentId|payment_id|quoteId|quote_id|requestId|request_id|orderId|order_id|clientId|client_id|operationId|operation_id)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i]
];

function fail(message) {
  throw new Error(`Settlement evidence validation failed: ${message}`);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return value;
}

function sourceText(source, selector) {
  if (typeof source !== "string" || isAbsolute(source) || source.includes("..") || !PUBLIC_SOURCE_ROOTS.some((root) => source.startsWith(root))) {
    fail(`unsafe evidence source path ${String(source)}`);
  }
  const path = resolve(ROOT, source);
  if (!path.startsWith(`${ROOT}${sep}`) || !existsSync(path)) fail(`missing evidence source ${source}`);
  const text = readFileSync(path, "utf8");
  if (typeof selector !== "string" || selector.length === 0 || !text.includes(selector)) {
    fail(`${source} no longer contains selector ${String(selector)}`);
  }
  return text;
}

function validateEntry(entry, kind) {
  if (!entry || typeof entry !== "object" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id ?? "")) {
    fail(`${kind} evidence has an invalid id`);
  }
  if (typeof entry.command !== "string" || entry.command.length === 0) fail(`${entry.id} has no command`);
  const text = sourceText(entry.source, entry.selector);
  if (!ALLOWED_COMMAND_PREFIXES.some((prefix) => entry.command.startsWith(prefix))) fail(`${entry.id} uses an unsupported evidence command`);
  if (/[\r\n;`<>|&#$]/.test(entry.command)) fail(`${entry.id} contains shell control syntax`);
  if (!entry.command.includes(entry.selector)) fail(`${entry.id} command does not select its evidence`);
  const workspace = entry.source.split("/", 1)[0];
  if (entry.command.startsWith("npm --prefix ") && !entry.command.startsWith(`npm --prefix ${workspace} `)) {
    fail(`${entry.id} command targets a different workspace`);
  }
  if (entry.source.endsWith(".mjs") && !entry.command.includes(entry.source)) fail(`${entry.id} command targets a different script`);
  if (entry.source.includes("/tests/") && entry.source.endsWith(".rs")) {
    const target = entry.source.split("/").at(-1).replace(/\.rs$/, "");
    if (!entry.command.includes(`--test ${target} `)) fail(`${entry.id} command targets a different Rust test`);
  }
  if (kind === "deterministic" && entry.command.includes("--ignored")) fail(`${entry.id} puts a live test in deterministic evidence`);
  if (kind === "deterministic" && (typeof entry.invariant !== "string" || entry.invariant.length === 0)) fail(`${entry.id} has no invariant`);
  if (kind === "live") {
    if (entry.opt_in !== true || !entry.command.includes("--ignored")) fail(`${entry.id} is not explicitly opt-in`);
    if (typeof entry.network !== "string" || entry.network.length === 0) fail(`${entry.id} has no network`);
    if (typeof entry.expected_economic_effect !== "string" || entry.expected_economic_effect.length === 0) fail(`${entry.id} has no expected economic effect`);
    const offset = text.indexOf(entry.selector);
    const attributes = text.slice(Math.max(0, offset - 180), offset);
    if (!/#\[ignore(?:\s*=\s*"[^"]*")?\]/.test(attributes)) fail(`${entry.id} no longer points to an ignored test`);
  }
}

function covered(entries, field) {
  return new Set(entries.flatMap((entry) => stringArray(entry[field], `${entry.id}.${field}`)));
}

function requireCoverage(required, actual, label) {
  for (const item of required) if (!actual.has(item)) fail(`${label} ${item} has no evidence`);
  for (const item of actual) if (!required.includes(item)) fail(`${label} ${item} is not declared`);
}

export function assertNoSensitiveData(value, label = "public evidence") {
  for (const [kind, pattern] of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${label} contains a synthetic ${kind}`);
  }
}

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateManifest(manifest) {
  if (manifest?.schema_version !== 1 || manifest.scope !== "settlement-reliability-and-redaction") fail("unsupported manifest identity");
  if (
    manifest.ordinary_ci?.command !== "make ci" ||
    manifest.ordinary_ci?.validator !== "node scripts/verify-settlement-evidence.mjs" ||
    manifest.ordinary_ci?.live_network_access !== false
  ) {
    fail("ordinary CI must be node-free and non-economic");
  }
  const requiredFailures = stringArray(manifest.required_failure_classes, "required_failure_classes");
  const requiredSecrets = stringArray(manifest.required_secret_classes, "required_secret_classes");
  const requiredSinks = stringArray(manifest.required_sinks, "required_sinks");
  const deterministic = manifest.deterministic_evidence;
  const redaction = manifest.redaction_evidence;
  const live = manifest.live_scenarios;
  if (![deterministic, redaction, live].every(Array.isArray)) fail("evidence collections must be arrays");

  const ids = [...deterministic, ...redaction, ...live].map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail("evidence ids must be unique");
  deterministic.forEach((entry) => validateEntry(entry, "deterministic"));
  redaction.forEach((entry) => validateEntry(entry, "redaction"));
  live.forEach((entry) => validateEntry(entry, "live"));
  requireCoverage(requiredFailures, covered(deterministic, "failure_classes"), "failure class");
  requireCoverage(requiredSecrets, covered(redaction, "secret_classes"), "secret class");
  requireCoverage(requiredSinks, covered(redaction, "sinks"), "redaction sink");

  const serialized = JSON.stringify(manifest);
  assertNoSensitiveData(serialized, "settlement evidence manifest");
  return {
    schema_version: manifest.schema_version,
    scope: manifest.scope,
    deterministic_scenarios: deterministic.length,
    covered_failure_classes: [...covered(deterministic, "failure_classes")].sort(),
    redaction_checks: redaction.length,
    covered_secret_classes: [...covered(redaction, "secret_classes")].sort(),
    covered_sinks: [...covered(redaction, "sinks")].sort(),
    live_scenarios: live.map(({ id, network, opt_in }) => ({ id, network, opt_in }))
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const summary = validateManifest(loadManifest());
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
