import assert from "node:assert/strict";
import test from "node:test";

import type { FaucetConfig } from "../src/config.js";
import { FaucetStore } from "../src/database.js";
import { HttpError } from "../src/protocol.js";
import { FaucetService } from "../src/service.js";
import type {
  FiberPayment,
  FiberPort,
  MintPort,
  MintQuoteView,
  ParsedFiberInvoice,
} from "../src/upstream.js";

const PAYMENT_A = `0x${"11".repeat(32)}`;
const PAYMENT_B = `0x${"22".repeat(32)}`;
const CLIENT_A = "a".repeat(43);
const CLIENT_B = "b".repeat(43);
const NETWORK_A = "198.51.100.10";
const NETWORK_B = "198.51.100.11";
const QUOTE_PUBKEY = `02${"33".repeat(32)}`;

function config(overrides: Partial<FaucetConfig> = {}): FaucetConfig {
  return {
    host: "127.0.0.1",
    port: 8091,
    databasePath: ":memory:",
    publicOrigin: "http://127.0.0.1:8091",
    allowedOrigins: new Set(["http://127.0.0.1:5175"]),
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
    identifierSecret: "test-identifier-secret-with-enough-entropy",
    trustProxy: false,
    ...overrides,
  };
}

function quote(id = "quote-test-0001", overrides: Partial<MintQuoteView> = {}): MintQuoteView {
  return {
    quoteId: id,
    invoice: `fibt1${id.replaceAll("-", "")}invoicepayload`,
    amount: 1000,
    unit: "rusd",
    pubkey: QUOTE_PUBKEY,
    expiry: 10_000,
    phase: "unpaid",
    ...overrides,
  };
}

class FakeMint implements MintPort {
  readonly quotes = new Map<string, MintQuoteView>();

  async getQuote(quoteId: string): Promise<MintQuoteView> {
    const value = this.quotes.get(quoteId);
    if (!value) throw new HttpError(404, "quote_not_found", "Missing test quote.");
    return { ...value };
  }
}

class FakeFiber implements FiberPort {
  readonly invoices = new Map<string, ParsedFiberInvoice>();
  readonly payments = new Map<string, FiberPayment>();
  sendCount = 0;
  loseNextResponse = false;

  async parseInvoice(invoice: string): Promise<ParsedFiberInvoice> {
    const parsed = this.invoices.get(invoice);
    if (!parsed) throw new HttpError(502, "fiber_response", "Missing test invoice.");
    return parsed;
  }

  async getPayment(paymentHash: string): Promise<FiberPayment | null> {
    return this.payments.get(paymentHash) ?? null;
  }

  async sendPayment(invoice: string): Promise<FiberPayment> {
    this.sendCount += 1;
    const parsed = await this.parseInvoice(invoice);
    const payment: FiberPayment = { paymentHash: parsed.paymentHash, status: "Success", fee: 0n };
    this.payments.set(parsed.paymentHash, payment);
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new HttpError(502, "fiber_unavailable", "Synthetic lost response.");
    }
    return payment;
  }
}

function setup(overrides: Partial<FaucetConfig> = {}) {
  let now = 1000;
  const activeConfig = config(overrides);
  const store = new FaucetStore(":memory:", () => now);
  const mint = new FakeMint();
  const fiber = new FakeFiber();
  const service = new FaucetService(activeConfig, store, mint, fiber, () => now);
  const addQuote = (value: MintQuoteView, paymentHash: string) => {
    mint.quotes.set(value.quoteId, value);
    fiber.invoices.set(value.invoice, {
      paymentHash,
      currency: "Fibt",
      amount: BigInt(value.amount) * BigInt(activeConfig.unitScale),
      udtScript: activeConfig.udtScript,
    });
  };
  return { activeConfig, store, mint, fiber, service, addQuote, setNow: (value: number) => { now = value; } };
}

test("a valid locked quote is paid once and later observed as issued", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote();
  fixture.addQuote(firstQuote, PAYMENT_A);

  const first = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(first.status, "paid");
  assert.equal(fixture.fiber.sendCount, 1);

  const duplicate = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(duplicate.status, "paid");
  assert.equal(fixture.fiber.sendCount, 1);

  fixture.mint.quotes.set(firstQuote.quoteId, { ...firstQuote, phase: "issued" });
  const issued = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(issued.status, "issued");
  assert.deepEqual(fixture.service.publicStats(), {
    claimsTotal: 1,
    claimsToday: 1,
    paidTotal: 1,
    issuedTotal: 1,
  });
});

test("a lost dispatch response checks the payment hash instead of paying twice", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote();
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.fiber.loseNextResponse = true;

  const ambiguous = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(ambiguous.status, "recoverable");
  assert.equal(fixture.fiber.sendCount, 1);

  const recovered = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(recovered.status, "paid");
  assert.equal(fixture.fiber.sendCount, 1);
});

test("a failed faucet payment can reconcile after the invoice is paid elsewhere", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-manual-payment");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.fiber.sendPayment = async () => {
    fixture.fiber.sendCount += 1;
    return { paymentHash: PAYMENT_A, status: "Failed", fee: 0n };
  };

  const failed = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(failed.status, "failed");
  assert.equal(fixture.fiber.sendCount, 1);

  fixture.mint.quotes.set(firstQuote.quoteId, { ...firstQuote, phase: "paid" });
  const paidElsewhere = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(paidElsewhere.status, "paid");
  assert.equal(fixture.fiber.sendCount, 1);

  fixture.mint.quotes.set(firstQuote.quoteId, { ...firstQuote, phase: "issued" });
  const issued = await fixture.service.claim(firstQuote.quoteId, CLIENT_A);
  assert.equal(issued.status, "issued");
  assert.deepEqual(fixture.service.publicStats(), {
    claimsTotal: 1,
    claimsToday: 1,
    paidTotal: 1,
    issuedTotal: 1,
  });
});

test("an unlocked quote is rejected before the payer node sees its invoice", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const unlocked = quote("quote-unlocked", { pubkey: null });
  fixture.addQuote(unlocked, PAYMENT_A);

  await assert.rejects(
    fixture.service.claim(unlocked.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "quote_unlocked",
  );
  assert.equal(fixture.fiber.sendCount, 0);
});

test("a quote paid before expiry can still be reconciled as issued after expiry", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const expiring = quote("quote-expiring", { expiry: 1020 });
  fixture.addQuote(expiring, PAYMENT_A);
  assert.equal((await fixture.service.claim(expiring.quoteId, CLIENT_A)).status, "paid");

  fixture.setNow(1100);
  fixture.mint.quotes.set(expiring.quoteId, { ...expiring, phase: "issued" });
  assert.equal((await fixture.service.claim(expiring.quoteId, CLIENT_A)).status, "issued");
  assert.equal(fixture.fiber.sendCount, 1);
});

test("a mismatched payment hash is never dispatched a second time", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-hash-mismatch");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.fiber.sendPayment = async () => {
    fixture.fiber.sendCount += 1;
    return { paymentHash: PAYMENT_B, status: "Success", fee: 0n };
  };

  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  fixture.setNow(2000);
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  assert.equal(fixture.fiber.sendCount, 1);
  assert.equal(fixture.store.open().length, 0);
});

test("reconciliation rejects a mismatched payment lookup response", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-lookup-mismatch");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.fiber.loseNextResponse = true;
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  fixture.fiber.payments.set(PAYMENT_A, { paymentHash: PAYMENT_B, status: "Success", fee: 0n });

  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  assert.equal(fixture.fiber.sendCount, 1);
  assert.equal(fixture.store.open().length, 0);
});

test("a stored claim is never retried after the mint changes immutable quote data", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-mutated");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.fiber.loseNextResponse = true;
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  fixture.fiber.payments.clear();
  fixture.mint.quotes.set(firstQuote.quoteId, { ...firstQuote, pubkey: `03${"44".repeat(32)}` });

  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "recoverable");
  assert.equal(fixture.fiber.sendCount, 1);
  assert.equal(fixture.store.open().length, 0);
});

test("retention removes claim identifiers without removing aggregate demand", async (t) => {
  const fixture = setup({ sensitiveRetentionSeconds: 3600 });
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-retention");
  fixture.addQuote(firstQuote, PAYMENT_A);
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "paid");

  fixture.setNow(5000);
  assert.equal(fixture.store.scrub(3600), 1);
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_B)).status, "paid");
  assert.deepEqual(fixture.service.publicStats(), {
    claimsTotal: 1,
    claimsToday: 1,
    paidTotal: 1,
    issuedTotal: 0,
  });
  assert.equal(fixture.fiber.sendCount, 1);
});

test("an existing quote is bound to the browser that reserved it", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote();
  fixture.addQuote(firstQuote, PAYMENT_A);
  await fixture.service.claim(firstQuote.quoteId, CLIENT_A);

  await assert.rejects(
    fixture.service.claim(firstQuote.quoteId, CLIENT_B),
    (reason: unknown) => reason instanceof HttpError && reason.status === 404 && reason.code === "claim_not_found",
  );
  assert.equal(fixture.fiber.sendCount, 1);
});

test("the same browser cannot reserve a second quote during its cooldown", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-test-0001");
  const secondQuote = quote("quote-test-0002");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.addQuote(secondQuote, PAYMENT_B);
  await fixture.service.claim(firstQuote.quoteId, CLIENT_A);

  await assert.rejects(
    fixture.service.claim(secondQuote.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.status === 429 && reason.code === "claim_cooldown",
  );
  assert.equal(fixture.fiber.sendCount, 1);
});

test("wrong amount, unit, network, and decoded invoice amount fail before dispatch", async (t) => {
  const fixture = setup();
  t.after(() => fixture.store.close());
  const wrongAmount = quote("quote-wrong-amount", { amount: 999 });
  fixture.addQuote(wrongAmount, PAYMENT_A);
  await assert.rejects(
    fixture.service.claim(wrongAmount.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "quote_mismatch",
  );

  const wrongUnit = quote("quote-wrong-unit", { unit: "sat" });
  fixture.addQuote(wrongUnit, PAYMENT_A);
  await assert.rejects(
    fixture.service.claim(wrongUnit.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "quote_mismatch",
  );

  const wrongNetwork = quote("quote-wrong-network", { invoice: "fib1mainnetinvoicepayload" });
  fixture.addQuote(wrongNetwork, PAYMENT_A);
  await assert.rejects(
    fixture.service.claim(wrongNetwork.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "wrong_network",
  );

  const wrongDecodedAmount = quote("quote-wrong-decoded");
  fixture.addQuote(wrongDecodedAmount, PAYMENT_A);
  fixture.fiber.invoices.set(wrongDecodedAmount.invoice, {
    paymentHash: PAYMENT_A,
    currency: "Fibt",
    amount: 999_000_000n,
    udtScript: fixture.activeConfig.udtScript,
  });
  await assert.rejects(
    fixture.service.claim(wrongDecodedAmount.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "invoice_mismatch",
  );

  const wrongAsset = quote("quote-wrong-asset");
  fixture.addQuote(wrongAsset, PAYMENT_A);
  fixture.fiber.invoices.set(wrongAsset.invoice, {
    paymentHash: PAYMENT_A,
    currency: "Fibt",
    amount: 1_000_000_000n,
    udtScript: { ...fixture.activeConfig.udtScript, args: `0x${"99".repeat(32)}` },
  });
  await assert.rejects(
    fixture.service.claim(wrongAsset.quoteId, CLIENT_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "invoice_mismatch",
  );
  assert.equal(fixture.fiber.sendCount, 0);
});

test("the global daily budget rejects new claims without affecting an existing claim", async (t) => {
  const fixture = setup({ dailyClaimLimit: 1, clientCooldownSeconds: 60 });
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-limit-0001");
  const secondQuote = quote("quote-limit-0002");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.addQuote(secondQuote, PAYMENT_B);
  await fixture.service.claim(firstQuote.quoteId, CLIENT_A);

  await assert.rejects(
    fixture.service.claim(secondQuote.quoteId, CLIENT_B),
    (reason: unknown) => reason instanceof HttpError && reason.code === "daily_limit",
  );
  assert.equal((await fixture.service.claim(firstQuote.quoteId, CLIENT_A)).status, "paid");
  assert.equal(fixture.service.publicConfig().remainingToday, 0);
});

test("one network address cannot consume the whole daily budget", async (t) => {
  const fixture = setup({ networkDailyClaimLimit: 1, clientCooldownSeconds: 60 });
  t.after(() => fixture.store.close());
  const firstQuote = quote("quote-network-0001");
  const secondQuote = quote("quote-network-0002");
  const thirdQuote = quote("quote-network-0003");
  fixture.addQuote(firstQuote, PAYMENT_A);
  fixture.addQuote(secondQuote, PAYMENT_B);
  fixture.addQuote(thirdQuote, PAYMENT_B);
  await fixture.service.claim(firstQuote.quoteId, CLIENT_A, NETWORK_A);

  await assert.rejects(
    fixture.service.claim(secondQuote.quoteId, CLIENT_B, NETWORK_A),
    (reason: unknown) => reason instanceof HttpError && reason.code === "network_limit",
  );
  assert.equal((await fixture.service.claim(thirdQuote.quoteId, CLIENT_B, NETWORK_B)).status, "paid");
  assert.equal(fixture.fiber.sendCount, 2);
});
