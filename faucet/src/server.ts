import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { FaucetConfig } from "./config.js";
import { HttpError, identifierHash, parseClaimRequest } from "./protocol.js";
import { FaucetService } from "./service.js";

interface RateEntry {
  minute: number;
  count: number;
}

function json(response: ServerResponse, status: number, body: unknown, retryAfterSeconds?: number): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
  });
  response.end(encoded);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content_type", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "body_too_large", "The request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

function remoteAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first && first.length <= 128) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function createFaucetServer(config: FaucetConfig, service: FaucetService): Server {
  const rate = new Map<string, RateEntry>();
  return createServer(async (request, response) => {
    try {
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        if (!config.allowedOrigins.has(requestOrigin)) {
          throw new HttpError(403, "origin_forbidden", "This browser origin is not allowed.");
        }
        response.setHeader("Access-Control-Allow-Origin", requestOrigin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        response.end();
        return;
      }

      const minute = Math.floor(Date.now() / 60_000);
      const address = remoteAddress(request, config.trustProxy);
      const rateKey = identifierHash(config.identifierSecret, "rate", address);
      if (!rate.has(rateKey) && rate.size >= 10_000) {
        for (const [key, entry] of rate) if (entry.minute < minute) rate.delete(key);
        if (rate.size >= 10_000) throw new HttpError(429, "rate_limited", "Too many requests.", 60);
      }
      const current = rate.get(rateKey);
      const count = current?.minute === minute ? current.count + 1 : 1;
      rate.set(rateKey, { minute, count });
      if (count > config.maxRequestsPerMinute) throw new HttpError(429, "rate_limited", "Too many requests.", 60);

      const url = new URL(request.url ?? "/", config.publicOrigin);
      if (url.search) throw new HttpError(400, "query_forbidden", "Claim data must not be placed in a URL.");
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/config") {
        json(response, 200, service.publicConfig());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/stats") {
        json(response, 200, service.publicStats());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/claims") {
        const input = parseClaimRequest(await readJson(request, config.bodyLimitBytes));
        const claim = await service.claim(input.quoteId, input.clientId, address);
        const status = claim.status === "paying" || claim.status === "recoverable" ? 202 : 200;
        json(response, status, {
          status: claim.status,
          amount: claim.amount,
          unit: claim.unit,
          message: claim.message,
          ...(claim.retryAfterSeconds ? { retry_after_seconds: claim.retryAfterSeconds } : {}),
        }, claim.retryAfterSeconds);
        return;
      }
      throw new HttpError(404, "not_found", "The endpoint was not found.");
    } catch (reason) {
      const error = reason instanceof HttpError
        ? reason
        : new HttpError(500, "internal_error", "The faucet could not process the request.");
      if (!response.headersSent) {
        json(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {}),
        }, error.retryAfterSeconds);
      } else {
        response.destroy();
      }
    }
  });
}
