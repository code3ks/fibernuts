import { PaymentRequest } from "@cashu/cashu-ts";

import { units } from "./wallet";

export interface DecodedPaymentRequest {
  id?: string;
  amount: number;
  unit: string;
  mints: string[];
  description: string;
  singleUse: boolean;
  encoded: string;
}

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeMintUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Mint URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Mint URLs must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Mint URLs must not contain query parameters or fragments.");
  }
  if (/%[0-9a-f]{2}/i.test(url.pathname)) {
    throw new Error("Mint URL paths must not contain percent-encoded characters.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function createPaymentRequest(
  amount: number,
  unit: string,
  mintUrl: string,
  description: string,
): DecodedPaymentRequest {
  const id = requestId();
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedUnit = unit.toLowerCase();
  const request = new PaymentRequest(undefined, id, amount, normalizedUnit, [normalizedMint], description, true);
  const encoded = request.toEncodedRequest();

  return {
    id,
    amount,
    unit: normalizedUnit,
    mints: [normalizedMint],
    description,
    singleUse: true,
    encoded,
  };
}

export function decodePaymentRequest(encoded: string): DecodedPaymentRequest {
  const value = encoded.trim();
  if (!/^creq[ab]/i.test(value)) {
    throw new Error("This is not a Cashu payment request. Requests begin with creq.");
  }

  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(value);
  } catch {
    throw new Error("The payment request could not be decoded. Ask the recipient to create it again.");
  }

  if (!request.amount) throw new Error("This request does not specify an amount.");
  if (!request.unit) throw new Error("This request does not specify a unit.");
  if (request.singleUse && !request.id) {
    throw new Error("This single-use request has no request ID, so replay cannot be prevented.");
  }

  const amount = units(request.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("This request does not contain a valid positive amount.");
  }

  return {
    id: request.id,
    amount,
    unit: request.unit.toLowerCase(),
    mints: (request.mints ?? []).map(normalizeMintUrl),
    description: request.description?.trim() || "Payment",
    singleUse: request.singleUse,
    encoded: value,
  };
}

export function validatePaymentRequest(
  request: DecodedPaymentRequest,
  mintUrl: string,
  unit: string,
  balance: number,
): void {
  if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
    throw new Error("This request does not contain a valid positive amount.");
  }

  if (request.unit !== unit.toLowerCase()) {
    throw new Error(`This request is denominated in ${request.unit.toUpperCase()}, not ${unit.toUpperCase()}.`);
  }

  const activeMint = normalizeMintUrl(mintUrl);
  if (request.mints.length > 0 && !request.mints.includes(activeMint)) {
    throw new Error("This request accepts ecash from another mint. No proofs were changed.");
  }

  if (request.amount > balance) {
    throw new Error("This request is larger than your spendable ecash balance.");
  }
}
