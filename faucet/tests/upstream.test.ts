import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { HttpFiberClient, HttpMintClient } from "../src/upstream.js";

const PAYMENT_HASH = `0x${"66".repeat(32)}`;
const QUOTE_PUBKEY = `03${"77".repeat(32)}`;
const RUSD_CODE_HASH = "1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a";
const RUSD_ARGS = "878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b";
const PACKED_RUSD_SCRIPT = `0x55000000100000003000000031000000${RUSD_CODE_HASH}0120000000${RUSD_ARGS}`;

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("mint and Fiber clients enforce the pinned wire contract", async (t) => {
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/v1/mint/quote/fiber/quote-wire-test") {
      response.end(JSON.stringify({
        quote: "quote-wire-test",
        request: "fibt1syntheticwireinvoice",
        amount: 1000,
        amount_paid: 0,
        amount_issued: 0,
        unit: "RUSD",
        pubkey: QUOTE_PUBKEY.toUpperCase(),
        expiry: 20_000,
        state: "UNPAID",
      }));
      return;
    }
    if (request.method === "POST") {
      const rpc = await body(request);
      calls.push(rpc);
      if (rpc.method === "parse_invoice") {
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { invoice: { currency: "Fibt", amount: "0x3b9aca00", data: {
            payment_hash: PAYMENT_HASH,
            attrs: [{ description: "FiberNuts mint quote" }, { udt_script: PACKED_RUSD_SCRIPT }],
          } } },
        }));
        return;
      }
      if (rpc.method === "send_payment") {
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { payment_hash: PAYMENT_HASH, status: "Success", fee: "0x2a" },
        }));
        return;
      }
      if (rpc.method === "get_payment") {
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "Payment session not found" },
        }));
        return;
      }
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const quote = await new HttpMintClient(base, 1000).getQuote("quote-wire-test");
  assert.deepEqual(quote, {
    quoteId: "quote-wire-test",
    invoice: "fibt1syntheticwireinvoice",
    amount: 1000,
    unit: "rusd",
    pubkey: QUOTE_PUBKEY,
    expiry: 20_000,
    phase: "unpaid",
  });

  const fiber = new HttpFiberClient(base, 1000, 5_000_000, 5);
  assert.deepEqual(await fiber.parseInvoice(quote.invoice), {
    paymentHash: PAYMENT_HASH,
    currency: "Fibt",
    amount: 1_000_000_000n,
    udtScript: {
      codeHash: `0x${RUSD_CODE_HASH}`,
      hashType: "type",
      args: `0x${RUSD_ARGS}`,
    },
  });
  assert.deepEqual(await fiber.sendPayment(quote.invoice), {
    paymentHash: PAYMENT_HASH,
    status: "Success",
    fee: 42n,
  });
  assert.equal(await fiber.getPayment(PAYMENT_HASH), null);

  assert.deepEqual(calls.map((call) => call.method), ["parse_invoice", "send_payment", "get_payment"]);
  assert.deepEqual(calls[1].params, [{
    invoice: quote.invoice,
    max_fee_amount: "0x4c4b40",
    max_fee_rate: "0x5",
    dry_run: false,
  }]);
});
