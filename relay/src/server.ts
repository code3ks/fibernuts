import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { RelayConfig } from "./config.js";
import { RelayStore } from "./database.js";
import { HttpError, parsePaymentPayload, parseRegistration } from "./protocol.js";

interface RateEntry {
  minute: number;
  count: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end(encoded);
}

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthorized", "A read capability is required.");
  }
  const value = authorization.slice("Bearer ".length);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new HttpError(401, "unauthorized", "A read capability is required.");
  }
  return value;
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

export function createRelayServer(config: RelayConfig, store: RelayStore): Server {
  const rate = new Map<string, RateEntry>();
  const server = createServer(async (request, response) => {
    try {
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        if (!config.allowedOrigins.has(requestOrigin)) {
          throw new HttpError(403, "origin_forbidden", "This browser origin is not allowed.");
        }
        response.setHeader("Access-Control-Allow-Origin", requestOrigin);
        response.setHeader("Vary", "Origin");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        response.end();
        return;
      }

      const minute = Math.floor(Date.now() / 60000);
      const rateKey = `${request.socket.remoteAddress ?? "unknown"}:${minute}`;
      const current = rate.get(rateKey);
      const next = current?.minute === minute ? current.count + 1 : 1;
      rate.set(rateKey, { minute, count: next });
      if (next > config.maxRequestsPerMinute) {
        throw new HttpError(429, "rate_limited", "Too many requests.");
      }
      if (rate.size > 10000) {
        for (const [key, entry] of rate) if (entry.minute < minute) rate.delete(key);
      }

      const url = new URL(request.url ?? "/", config.publicOrigin);
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/orders") {
        const input = parseRegistration(await readJson(request, config.bodyLimitBytes), Math.floor(Date.now() / 1000), config.maxTtlSeconds);
        const result = store.register(input);
        json(response, result === "created" ? 201 : 200, {
          order_id: input.orderId,
          delivery_url: `${config.publicOrigin}/v1/deliver/${input.writeCapability}`,
          expires_at: input.expiresAt,
        });
        return;
      }
      const delivery = url.pathname.match(/^\/v1\/deliver\/([A-Za-z0-9_-]{43,128})$/);
      if (request.method === "POST" && delivery) {
        const payload = parsePaymentPayload(await readJson(request, config.bodyLimitBytes));
        const result = store.deliver(delivery[1], payload);
        json(response, 202, { status: "delivered", duplicate: result === "duplicate" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/inbox") {
        const payload = store.read(bearer(request));
        if (!payload) {
          response.writeHead(204, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          response.end();
          return;
        }
        json(response, 200, payload);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/inbox/ack") {
        const result = store.acknowledge(bearer(request));
        json(response, 200, { status: "acknowledged", duplicate: result === "duplicate" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/inbox/cancel") {
        const result = store.cancel(bearer(request));
        json(response, 200, { status: "cancelled", duplicate: result === "duplicate" });
        return;
      }
      throw new HttpError(404, "not_found", "The endpoint was not found.");
    } catch (reason) {
      const error = reason instanceof HttpError
        ? reason
        : new HttpError(500, "internal_error", "The relay could not process the request.");
      if (!response.headersSent) json(response, error.status, { error: error.code, message: error.message });
      else response.destroy();
    }
  });
  return server;
}
