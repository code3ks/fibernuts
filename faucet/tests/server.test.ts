import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { FaucetConfig } from "../src/config.js";
import { FaucetStore } from "../src/database.js";
import { createFaucetServer } from "../src/server.js";
import { FaucetService } from "../src/service.js";
import type { FiberPort, MintPort } from "../src/upstream.js";

const ORIGIN = "https://market.example.test";
const PAYMENT_HASH = `0x${"44".repeat(32)}`;

function activeConfig(): FaucetConfig {
  return {
    host: "127.0.0.1",
    port: 8091,
    databasePath: ":memory:",
    publicOrigin: "http://127.0.0.1:8091",
    allowedOrigins: new Set([ORIGIN]),
    mintUrl: "https://mint.example.test",
    mintApiUrl: "http://mint:8085",
    fiberRpcUrl: "http://127.0.0.1:8227",
    enabled: true,
    amount: 1000,
    unit: "rusd",
    network: "testnet",
    unitScale: 1_000_000,
    invoiceCurrency: "Fibt",
    udtScript: {
      codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      hashType: "type",
      args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
    },
    clientCooldownSeconds: 86_400,
    networkDailyClaimLimit: 3,
    dailyClaimLimit: 25,
    maxRequestsPerMinute: 120,
    maxFeeBaseUnits: 5_000_000,
    maxFeeRate: 5,
    recoveryDelaySeconds: 10,
    reconciliationIntervalSeconds: 10,
    sensitiveRetentionSeconds: 604_800,
    upstreamTimeoutMs: 10_000,
    bodyLimitBytes: 4096,
    identifierSecret: "server-test-identifier-secret-long-enough",
    trustProxy: false,
  };
}

test("the HTTP surface keeps claims in POST bodies and returns only aggregate status", async (t) => {
  const config = activeConfig();
  const store = new FaucetStore(":memory:", () => 1000);
  const mint: MintPort = {
    async getQuote(quoteId) {
      return {
        quoteId,
        invoice: "fibt1syntheticfaucetinvoicepayload",
        amount: 1000,
        unit: "rusd",
        pubkey: `02${"55".repeat(32)}`,
        expiry: 10_000,
        phase: "unpaid",
      };
    },
  };
  const fiber: FiberPort = {
    async parseInvoice() { return { paymentHash: PAYMENT_HASH, currency: "Fibt", amount: 1_000_000_000n, udtScript: config.udtScript }; },
    async getPayment() { return { paymentHash: PAYMENT_HASH, status: "Success", fee: 0n }; },
    async sendPayment() { return { paymentHash: PAYMENT_HASH, status: "Success", fee: 0n }; },
  };
  const service = new FaucetService(config, store, mint, fiber, () => 1000);
  const server = createFaucetServer(config, service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    server.close();
    store.close();
  });

  const preflight = await fetch(`${base}/v1/claims`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);

  const claimed = await fetch(`${base}/v1/claims`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ quote_id: "quote-server-test", client_id: "c".repeat(43) }),
  });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), {
    status: "paid",
    amount: 1000,
    unit: "rusd",
    message: "The Fiber payment settled. The mint is ready to issue ecash.",
    retry_after_seconds: 2,
  });

  const stats = await fetch(`${base}/v1/stats`, { headers: { Origin: ORIGIN } });
  assert.deepEqual(await stats.json(), { claimsTotal: 1, claimsToday: 1, paidTotal: 1, issuedTotal: 0 });

  const queryLeak = await fetch(`${base}/v1/claims?quote_id=secret`, { headers: { Origin: ORIGIN } });
  assert.equal(queryLeak.status, 400);
  assert.equal((await queryLeak.json() as { error: string }).error, "query_forbidden");

  const forbidden = await fetch(`${base}/v1/config`, { headers: { Origin: "https://attacker.example" } });
  assert.equal(forbidden.status, 403);
});
