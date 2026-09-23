import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AddressInfo } from "node:net";

import type { RelayConfig } from "../src/config.js";
import { RelayStore } from "../src/database.js";
import { createRelayServer } from "../src/server.js";

const resources: Array<() => void> = [];

afterEach(() => {
  while (resources.length) resources.pop()?.();
});

function secret(character: string): string {
  return character.repeat(43);
}

async function setup(now = Math.floor(Date.now() / 1000)) {
  const directory = mkdtempSync(join(tmpdir(), "fibernuts-relay-"));
  const database = join(directory, "relay.sqlite3");
  const store = new RelayStore(database, () => now);
  const config: RelayConfig = {
    host: "127.0.0.1",
    port: 0,
    databasePath: database,
    publicOrigin: "http://127.0.0.1",
    allowedOrigins: new Set(["https://market.example"]),
    maxTtlSeconds: 600,
    retentionSeconds: 3600,
    maxRequestsPerMinute: 1000,
    bodyLimitBytes: 128 * 1024,
  };
  const server = createRelayServer(config, store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  resources.push(() => {
    server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin, store, database, directory, now };
}

function registration(now: number) {
  return {
    order_id: "order_1234567890abcdef",
    amount: 250,
    unit: "rusd",
    mint: "https://mint.fibernuts.xyz",
    request_digest: `sha256:${"a".repeat(64)}`,
    expires_at: now + 300,
    write_capability: secret("w"),
    read_capability: secret("r"),
  };
}

function payload() {
  return {
    id: "order_1234567890abcdef",
    memo: "Block Cafe - Coffee",
    unit: "rusd",
    mint: "https://mint.fibernuts.xyz",
    proofs: [{ amount: 250, id: "keyset_1", secret: "synthetic-secret-value", C: "ab".repeat(33) }],
  };
}

async function post(origin: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://market.example", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("stores, leases, acknowledges, and deduplicates one standard payload", async () => {
  const { origin, now } = await setup();
  const order = registration(now);
  assert.equal((await post(origin, "/v1/orders", order)).status, 201);
  assert.equal((await post(origin, "/v1/orders", order)).status, 200);

  const delivered = await post(origin, `/v1/deliver/${order.write_capability}`, payload());
  assert.equal(delivered.status, 202);
  assert.equal((await delivered.json() as { duplicate: boolean }).duplicate, false);
  const duplicate = await post(origin, `/v1/deliver/${order.write_capability}`, payload());
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

  const read = await fetch(`${origin}/v1/inbox`, {
    headers: { Authorization: `Bearer ${order.read_capability}`, Origin: "https://market.example" },
  });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), payload());

  const ack = await post(origin, "/v1/inbox/ack", undefined, { Authorization: `Bearer ${order.read_capability}` });
  assert.equal(ack.status, 200);
  const afterAck = await fetch(`${origin}/v1/inbox`, {
    headers: { Authorization: `Bearer ${order.read_capability}`, Origin: "https://market.example" },
  });
  assert.equal(afterAck.status, 410);
});

test("rejects payload replacement, wrong authority, and disallowed origins", async () => {
  const { origin, now } = await setup();
  const order = registration(now);
  await post(origin, "/v1/orders", order);
  await post(origin, `/v1/deliver/${order.write_capability}`, payload());
  const changed = payload();
  changed.proofs[0].secret = "another-synthetic-secret";
  assert.equal((await post(origin, `/v1/deliver/${order.write_capability}`, changed)).status, 409);

  const unauthorized = await fetch(`${origin}/v1/inbox`, {
    headers: { Authorization: `Bearer ${order.write_capability}`, Origin: "https://market.example" },
  });
  assert.equal(unauthorized.status, 404);
  const forbidden = await fetch(`${origin}/healthz`, { headers: { Origin: "https://evil.example" } });
  assert.equal(forbidden.status, 403);
});

test("rejects both underpayment and overpayment before storing bearer value", async () => {
  const { origin, now } = await setup();
  const underpaid = registration(now);
  underpaid.order_id = "order_underpaid_123456";
  underpaid.write_capability = secret("u");
  underpaid.read_capability = secret("v");
  await post(origin, "/v1/orders", underpaid);
  const underpaidPayload = payload();
  underpaidPayload.id = underpaid.order_id;
  underpaidPayload.proofs[0].amount = 249;
  assert.equal((await post(origin, `/v1/deliver/${underpaid.write_capability}`, underpaidPayload)).status, 422);

  const overpaid = registration(now);
  overpaid.order_id = "order_overpaid_1234567";
  overpaid.write_capability = secret("x");
  overpaid.read_capability = secret("y");
  await post(origin, "/v1/orders", overpaid);
  const overpaidPayload = payload();
  overpaidPayload.id = overpaid.order_id;
  overpaidPayload.proofs[0].amount = 251;
  assert.equal((await post(origin, `/v1/deliver/${overpaid.write_capability}`, overpaidPayload)).status, 422);
});

test("cancellation has one winner and cannot hide a delivered payload", async () => {
  const first = await setup();
  const cancelled = registration(first.now);
  await post(first.origin, "/v1/orders", cancelled);
  assert.equal((await post(first.origin, "/v1/inbox/cancel", undefined, { Authorization: `Bearer ${cancelled.read_capability}` })).status, 200);
  assert.equal((await post(first.origin, `/v1/deliver/${cancelled.write_capability}`, payload())).status, 410);

  const second = await setup();
  const delivered = registration(second.now);
  await post(second.origin, "/v1/orders", delivered);
  await post(second.origin, `/v1/deliver/${delivered.write_capability}`, payload());
  assert.equal((await post(second.origin, "/v1/inbox/cancel", undefined, { Authorization: `Bearer ${delivered.read_capability}` })).status, 409);
});

test("a delivered payload survives a store restart", async () => {
  const { origin, now, store, database } = await setup();
  const order = registration(now);
  await post(origin, "/v1/orders", order);
  await post(origin, `/v1/deliver/${order.write_capability}`, payload());
  store.close();
  const reopened = new RelayStore(database, () => now);
  resources.push(() => reopened.close());
  assert.deepEqual(reopened.read(order.read_capability), payload());
});

test("request expiry cannot delete a payload that won delivery", () => {
  const directory = mkdtempSync(join(tmpdir(), "fibernuts-relay-expiry-"));
  const database = join(directory, "relay.sqlite3");
  let now = 1_800_000_000;
  const store = new RelayStore(database, () => now);
  resources.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const order = registration(now);
  store.register({
    orderId: order.order_id,
    amount: order.amount,
    unit: order.unit,
    mint: order.mint,
    requestDigest: order.request_digest,
    expiresAt: order.expires_at,
    writeCapability: order.write_capability,
    readCapability: order.read_capability,
  });
  store.deliver(order.write_capability, payload());
  now = order.expires_at + 1;

  assert.deepEqual(store.read(order.read_capability), payload());
});
