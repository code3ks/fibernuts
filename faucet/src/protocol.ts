import { createHmac } from "node:crypto";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ClaimRequest {
  quoteId: string;
  clientId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseClaimRequest(value: unknown): ClaimRequest {
  if (!record(value) || Object.keys(value).length !== 2 || !("quote_id" in value) || !("client_id" in value)) {
    throw new HttpError(400, "invalid_request", "The claim request is malformed.");
  }
  if (typeof value.quote_id !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(value.quote_id)) {
    throw new HttpError(400, "invalid_quote", "The mint quote identifier is invalid.");
  }
  if (typeof value.client_id !== "string" || !/^[A-Za-z0-9_-]{43,64}$/.test(value.client_id)) {
    throw new HttpError(400, "invalid_client", "The browser claim identifier is invalid.");
  }
  return { quoteId: value.quote_id, clientId: value.client_id };
}

export function identifierHash(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`, "utf8").digest("hex");
}

export function nextUtcDay(now: number): number {
  return (Math.floor(now / 86_400) + 1) * 86_400;
}

export function startOfUtcDay(now: number): number {
  return Math.floor(now / 86_400) * 86_400;
}
