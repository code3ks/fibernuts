import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RegisterOrderInput {
  orderId: string;
  amount: number;
  unit: string;
  mint: string;
  requestDigest: string;
  expiresAt: number;
  writeCapability: string;
  readCapability: string;
}

export interface PaymentProof {
  amount: number | string;
  id: string;
  secret: string;
  C: string;
  dleq?: unknown;
  witness?: unknown;
  p2pk_e?: string;
}

export interface PaymentPayload {
  id: string;
  memo?: string;
  unit: string;
  mint: string;
  proofs: PaymentProof[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "invalid_request", "The request shape is invalid.");
  }
}

function normalizedMint(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_mint", "The mint is invalid.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_mint", "The mint is invalid.");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new HttpError(400, "invalid_mint", "The mint is invalid.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) {
    throw new HttpError(400, code, "A positive integer is required.");
  }
  return parsed as number;
}

function capability(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new HttpError(400, "invalid_capability", "The capability is invalid.");
  }
  return value;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function digestPayload(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export function parseRegistration(value: unknown, now: number, maxTtlSeconds: number): RegisterOrderInput {
  if (!record(value)) throw new HttpError(400, "invalid_request", "The request shape is invalid.");
  exactKeys(value, [
    "order_id",
    "amount",
    "unit",
    "mint",
    "request_digest",
    "expires_at",
    "write_capability",
    "read_capability",
  ]);
  if (typeof value.order_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.order_id)) {
    throw new HttpError(400, "invalid_order", "The order identifier is invalid.");
  }
  if (value.unit !== "rusd") throw new HttpError(400, "invalid_unit", "The unit is invalid.");
  if (typeof value.request_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.request_digest)) {
    throw new HttpError(400, "invalid_digest", "The request digest is invalid.");
  }
  if (!Number.isSafeInteger(value.expires_at)) {
    throw new HttpError(400, "invalid_expiry", "The expiry is invalid.");
  }
  const expiresAt = value.expires_at as number;
  if (expiresAt <= now || expiresAt > now + maxTtlSeconds) {
    throw new HttpError(400, "invalid_expiry", "The expiry is outside the allowed window.");
  }
  const writeCapability = capability(value.write_capability);
  const readCapability = capability(value.read_capability);
  if (writeCapability === readCapability) {
    throw new HttpError(400, "invalid_capability", "Read and write capabilities must differ.");
  }
  return {
    orderId: value.order_id,
    amount: positiveInteger(value.amount, "invalid_amount"),
    unit: value.unit,
    mint: normalizedMint(value.mint),
    requestDigest: value.request_digest,
    expiresAt,
    writeCapability,
    readCapability,
  };
}

export function parsePaymentPayload(value: unknown): PaymentPayload {
  if (!record(value)) throw new HttpError(400, "invalid_payload", "The payment payload is invalid.");
  exactKeys(value, ["id", "unit", "mint", "proofs"], ["memo"]);
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.id)) {
    throw new HttpError(400, "invalid_order", "The order identifier is invalid.");
  }
  if (value.unit !== "rusd") throw new HttpError(400, "invalid_unit", "The unit is invalid.");
  if (value.memo !== undefined && (typeof value.memo !== "string" || value.memo.length > 280)) {
    throw new HttpError(400, "invalid_memo", "The memo is invalid.");
  }
  if (!Array.isArray(value.proofs) || value.proofs.length === 0 || value.proofs.length > 256) {
    throw new HttpError(400, "invalid_proofs", "The proof list is invalid.");
  }
  const proofs = value.proofs.map((item): PaymentProof => {
    if (!record(item)) throw new HttpError(400, "invalid_proofs", "A proof is invalid.");
    exactKeys(item, ["amount", "id", "secret", "C"], ["dleq", "witness", "p2pk_e"]);
    positiveInteger(item.amount, "invalid_proofs");
    if (
      typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
      typeof item.secret !== "string" || item.secret.length < 16 || item.secret.length > 4096 ||
      typeof item.C !== "string" || !/^[A-Fa-f0-9]{32,256}$/.test(item.C) ||
      (item.p2pk_e !== undefined && typeof item.p2pk_e !== "string")
    ) {
      throw new HttpError(400, "invalid_proofs", "A proof is invalid.");
    }
    return item as unknown as PaymentProof;
  });
  return {
    id: value.id,
    memo: value.memo as string | undefined,
    unit: value.unit,
    mint: normalizedMint(value.mint),
    proofs,
  };
}

export function payloadAmount(payload: PaymentPayload): number {
  let total = 0;
  for (const proof of payload.proofs) {
    total += positiveInteger(proof.amount, "invalid_proofs");
    if (!Number.isSafeInteger(total)) {
      throw new HttpError(400, "invalid_proofs", "The proof total is outside the supported range.");
    }
  }
  return total;
}
