import type { PaymentRequestPayload, Proof } from "@cashu/cashu-ts";
import { describe, expect, it, vi } from "vitest";

import type { StoredSwapPreview } from "@wallet-domain/operations";
import type { MintQuote } from "@wallet-lib/wallet";

import { EVENT } from "../event/manifest";
import { RelayError } from "./relay";
import { emptyMarketSnapshot } from "./storage";
import { MarketRuntime, type MarketWallet, type RelayPort } from "./market-runtime";
import { paymentCanRetry, type MarketSnapshot, type OrderItem } from "./types";

const proof = (amount: number, secret: string): Proof => ({
  amount,
  id: "synthetic_keyset",
  secret,
  C: `02${"11".repeat(32)}`,
}) as unknown as Proof;

const preparedSwap = (inputs: Proof[], amount = 250): StoredSwapPreview => ({
  amount,
  fees: 0,
  keysetId: "synthetic_keyset",
  inputs,
  sendOutputs: [],
  keepOutputs: [],
  unselectedProofs: [],
});

function state(role: "attendee" | "vendor", proofs: Proof[] = []) {
  let snapshot = { ...emptyMarketSnapshot(EVENT, role), proofs };
  return {
    get: () => snapshot,
    commit: (next: MarketSnapshot) => { snapshot = structuredClone(next); },
  };
}

function wallet(overrides: Partial<MarketWallet> = {}): MarketWallet {
  return {
    mintUrl: EVENT.mintUrl,
    unit: "rusd",
    ticker: "RUSD",
    profile: {} as MarketWallet["profile"],
    prepareSend: vi.fn(async (_amount, proofs) => ({ mode: "swap", swap: preparedSwap(proofs), debit: 250, fee: 0 })),
    completePreparedSend: vi.fn(async () => ({ token: "cashuBsynthetic-locked-token", change: [] })),
    inspectToken: vi.fn(() => ({ amount: 250, mint: EVENT.mintUrl, unit: "rusd", proofs: [proof(250, "locked-proof")] })),
    encodeProofs: vi.fn(() => "cashuBsynthetic-locked-token"),
    tokenIsLockedTo: vi.fn(() => true),
    prepareReceive: vi.fn(async () => preparedSwap([proof(250, "incoming-proof")])),
    completePreparedReceive: vi.fn(async () => [proof(250, "fresh-vendor-proof")]),
    checkTokenState: vi.fn(async () => "unspent"),
    requestMint: vi.fn(),
    requestLockedMint: vi.fn(),
    checkMintQuote: vi.fn(),
    prepareMint: vi.fn(),
    completeMint: vi.fn(),
    requestMelt: vi.fn(),
    checkMeltQuote: vi.fn(),
    prepareMelt: vi.fn(),
    executeMelt: vi.fn(),
    recoverMeltChange: vi.fn(),
    checkProofsState: vi.fn(),
    ...overrides,
  } as MarketWallet;
}

function relay(overrides: Partial<RelayPort> = {}): RelayPort {
  return {
    register: vi.fn(async () => undefined),
    deliver: vi.fn(async () => undefined),
    read: vi.fn(async () => null),
    acknowledge: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}

const coffee: OrderItem[] = [{ itemId: "coffee", label: "Coffee", quantity: 1, unitPrice: 250 }];

describe("market runtime persistence boundaries", () => {
  it("persists a browser-locked faucet quote before issuance and clears the raw key after signing", async () => {
    const store = state("attendee");
    const privateKey = "11".repeat(32);
    const publicKey = `02${"22".repeat(32)}`;
    const lockedQuote = {
      quote: "locked-quote-1",
      request: "fibt1lockedtestinvoice",
      amount: 1000,
      amount_paid: 0,
      amount_issued: 0,
      unit: "rusd",
      state: "UNPAID" as const,
      expiry: 2_000_000_000,
      pubkey: publicKey,
    } as unknown as MintQuote;
    const prepareMint = vi.fn(async (_quote, receivedPrivateKey?: string) => {
      expect(receivedPrivateKey).toBe(privateKey);
      expect(store.get().addCash[0].quotePrivateKey).toBe(privateKey);
      return { outputData: [], keysetId: "synthetic_keyset", payloadSignature: "signed-payload" };
    });
    const completeMint = vi.fn(async () => {
      expect(store.get().addCash[0].state).toBe("issuing");
      expect(store.get().addCash[0].quotePrivateKey).toBeUndefined();
      return [proof(1000, "fresh-faucet-proof")];
    });
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet({
        requestLockedMint: vi.fn(async () => ({ quote: lockedQuote, privateKey, publicKey })),
        checkMintQuote: vi.fn(async () => ({ ...lockedQuote, state: "PAID", amount_paid: 1000 } as unknown as MintQuote)),
        prepareMint,
        completeMint,
      }),
      getSnapshot: store.get,
      commit: store.commit,
    });

    const created = await runtime.requestTestCash(1000);
    expect(created.fundingSource).toBe("faucet");
    expect(created.quotePrivateKey).toBe(privateKey);
    expect(store.get().proofs).toHaveLength(0);

    const settled = await runtime.refreshAddCash(created);
    expect(settled.state).toBe("settled");
    expect(settled.quotePrivateKey).toBeUndefined();
    expect(store.get().proofs).toHaveLength(1);
    expect(prepareMint).toHaveBeenCalledOnce();
    expect(completeMint).toHaveBeenCalledOnce();
  });

  it("does not issue a sponsored quote when the mint omits its browser lock", async () => {
    const store = state("attendee");
    const privateKey = "11".repeat(32);
    const publicKey = `02${"22".repeat(32)}`;
    const lockedQuote = {
      quote: "locked-quote-2",
      request: "fibt1lockedtestinvoice",
      amount: 1000,
      unit: "rusd",
      state: "UNPAID" as const,
      expiry: 2_000_000_000,
      pubkey: publicKey,
    } as unknown as MintQuote;
    const prepareMint = vi.fn();
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet({
        requestLockedMint: vi.fn(async () => ({ quote: lockedQuote, privateKey, publicKey })),
        checkMintQuote: vi.fn(async () => ({ ...lockedQuote, state: "PAID", pubkey: undefined } as unknown as MintQuote)),
        prepareMint,
      }),
      getSnapshot: store.get,
      commit: store.commit,
    });

    const created = await runtime.requestTestCash(1000);
    const checked = await runtime.refreshAddCash(created);

    expect(checked.state).toBe("recoverable");
    expect(checked.error).toMatch(/expected browser lock/i);
    expect(checked.quotePrivateKey).toBe(privateKey);
    expect(prepareMint).not.toHaveBeenCalled();
    expect(store.get().proofs).toHaveLength(0);
  });

  it("persists a community payer failure as recoverable", async () => {
    const store = state("attendee");
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const operation = {
      id: "failed-claim",
      kind: "add" as const,
      state: "awaiting_payment" as const,
      amount: 1000,
      createdAt: 1,
      updatedAt: 1,
      mintUrl: EVENT.mintUrl,
      unit: EVENT.unit,
      quoteId: "failed-quote",
      invoice: "fibt1failedquote",
      fundingSource: "faucet" as const,
      quotePubkey: `02${"22".repeat(32)}`,
      quotePrivateKey: "11".repeat(32),
    };
    store.commit({ ...store.get(), addCash: [operation] });

    const failed = runtime.recordTestCashPayerFailure(operation, "The Fiber payment failed.");

    expect(failed.state).toBe("recoverable");
    expect(failed.error).toBe("The Fiber payment failed.");
    expect(store.get().proofs).toHaveLength(0);
  });

  it("persists vendor keys and the order before registering its relay slot", async () => {
    const store = state("vendor");
    const register = vi.fn(async () => {
      const stored = store.get().orders[0];
      expect(stored.state).toBe("registering");
      expect(stored.privateKey).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.readCapability).toBeTruthy();
      expect(stored.request).toMatch(/^creq/i);
    });
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay({ register }),
      getSnapshot: store.get,
      commit: store.commit,
    });

    const order = await runtime.createOrder(coffee);

    expect(register).toHaveBeenCalledOnce();
    expect(order.state).toBe("awaiting_payment");
  });

  it("stores the exact outgoing payload before delivery and never credits it back", async () => {
    const attendeeProof = proof(500, "attendee-source-proof");
    const store = state("attendee", [attendeeProof]);
    const delivered: string[] = [];
    const deliver = vi.fn(async (_url: string, payloadJson: string) => {
      const stored = store.get().payments[0];
      expect(stored.state).toBe("delivering");
      expect(stored.payloadJson).toBe(payloadJson);
      expect(stored.token).toBe("cashuBsynthetic-locked-token");
      expect(store.get().proofs).toHaveLength(0);
      delivered.push(payloadJson);
    });
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay({ deliver }),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const vendorStore = state("vendor");
    const vendorRuntime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: vendorStore.get,
      commit: vendorStore.commit,
    });
    const order = await vendorRuntime.createOrder(coffee);

    const review = await runtime.reviewPayment(order.request ?? "");
    const payment = await runtime.confirmPayment(review);

    expect(payment.state).toBe("delivered");
    expect(payment.deliveredAt).toEqual(expect.any(Number));
    expect(deliver).toHaveBeenCalledOnce();
    expect(delivered[0]).toBe(store.get().payments[0].payloadJson);
    expect(store.get().proofs).toHaveLength(0);
  });

  it("resumes the stored preparation without selecting a second payment", async () => {
    const attendeeProof = proof(500, "attendee-source-proof");
    const store = state("attendee", [attendeeProof]);
    const completePreparedSend = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic lost swap response"))
      .mockResolvedValueOnce({ token: "cashuBsynthetic-locked-token", change: [] });
    const prepareSend = vi.fn(async (_amount, proofs) => ({ mode: "swap" as const, swap: preparedSwap(proofs), debit: 250, fee: 0 }));
    const deliver = vi.fn(async () => undefined);
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet({ prepareSend, completePreparedSend }),
      relay: relay({ deliver }),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const vendorStore = state("vendor");
    const vendorRuntime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: vendorStore.get,
      commit: vendorStore.commit,
    });
    const order = await vendorRuntime.createOrder(coffee);
    const review = await runtime.reviewPayment(order.request ?? "");

    const recoverable = await runtime.confirmPayment(review);
    expect(recoverable.state).toBe("recoverable");
    expect(recoverable.swap).toBeTruthy();
    expect(store.get().proofs).toHaveLength(0);

    const delivered = await runtime.deliverStoredPayment(recoverable);
    expect(delivered.state).toBe("delivered");
    expect(prepareSend).toHaveBeenCalledOnce();
    expect(completePreparedSend).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledOnce();
    expect(store.get().proofs).toHaveLength(0);
  });

  it("rejects confirmation when any reviewed proof field changes", async () => {
    const attendeeProof = proof(500, "attendee-source-proof");
    const store = state("attendee", [attendeeProof]);
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const vendorStore = state("vendor");
    const vendorRuntime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: vendorStore.get,
      commit: vendorStore.commit,
    });
    const order = await vendorRuntime.createOrder(coffee);
    const review = await runtime.reviewPayment(order.request ?? "");
    store.commit({
      ...store.get(),
      proofs: [{ ...attendeeProof, C: `03${"22".repeat(32)}` } as Proof],
    });

    await expect(runtime.confirmPayment(review)).rejects.toThrow(/balance changed/i);
    expect(store.get().payments).toHaveLength(0);
  });

  it("stops retrying a payload rejected permanently by the relay", async () => {
    const store = state("attendee", [proof(500, "attendee-source-proof")]);
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay({ deliver: vi.fn(async () => { throw new RelayError("synthetic conflict", 409, "payload_conflict"); }) }),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const vendorStore = state("vendor");
    const vendorRuntime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: vendorStore.get,
      commit: vendorStore.commit,
    });
    const order = await vendorRuntime.createOrder(coffee);

    const payment = await runtime.confirmPayment(await runtime.reviewPayment(order.request ?? ""));

    expect(payment.state).toBe("recoverable");
    expect(payment.deliveryRetryable).toBe(false);
    expect(paymentCanRetry(payment)).toBe(false);
    expect(payment.error).toMatch(/will not be retried/i);
  });

  it("does not redeliver after a successful delivery when proof-state lookup fails", async () => {
    const store = state("attendee", [proof(500, "attendee-source-proof")]);
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet({ checkTokenState: vi.fn(async () => { throw new Error("synthetic mint outage"); }) }),
      relay: relay(),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const vendorStore = state("vendor");
    const vendorRuntime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay(),
      getSnapshot: vendorStore.get,
      commit: vendorStore.commit,
    });
    const order = await vendorRuntime.createOrder(coffee);
    const delivered = await runtime.confirmPayment(await runtime.reviewPayment(order.request ?? ""));

    const unavailable = await runtime.checkPayment(delivered);

    expect(unavailable.state).toBe("recoverable");
    expect(unavailable.deliveredAt).toBe(delivered.deliveredAt);
    expect(paymentCanRetry(unavailable)).toBe(false);
    expect(unavailable.error).toMatch(/proof state is unavailable/i);
  });

  it("persists an incoming token before acknowledgement and credits only fresh proofs", async () => {
    const store = state("vendor");
    let orderId = "";
    const payload = (): PaymentRequestPayload => ({
      id: orderId,
      mint: EVENT.mintUrl,
      unit: "rusd",
      memo: "Coffee",
      proofs: [proof(250, "incoming-locked-proof")],
    });
    const acknowledge = vi.fn(async () => {
      const stored = store.get().orders[0];
      expect(stored.state).toBe("payload_received");
      expect(stored.incomingToken).toBe("cashuBsynthetic-locked-token");
      expect(store.get().proofs).toHaveLength(0);
    });
    const completePreparedReceive = vi.fn(async () => {
      expect(store.get().orders[0].state).toBe("swapping");
      expect(store.get().proofs).toHaveLength(0);
      return [proof(250, "fresh-vendor-proof")];
    });
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet({ completePreparedReceive }),
      relay: relay({ read: vi.fn(async () => payload()), acknowledge }),
      getSnapshot: store.get,
      commit: store.commit,
    });
    const order = await runtime.createOrder(coffee);
    orderId = order.id;

    const settled = await runtime.pollOrder(order);

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(completePreparedReceive).toHaveBeenCalledOnce();
    expect(settled.state).toBe("settled");
    expect(settled.incomingToken).toBeUndefined();
    expect(store.get().proofs).toHaveLength(1);
    expect(store.get().proofs[0].secret).toBe("fresh-vendor-proof");
  });

  it("treats the relay's expired response as terminal and clears vendor secrets", async () => {
    let now = 1_800_000_000_000;
    const store = state("vendor");
    const runtime = new MarketRuntime({
      manifest: EVENT,
      vendor: EVENT.vendors[0],
      wallet: wallet(),
      relay: relay({ read: vi.fn(async () => { throw new RelayError("slot closed", 410, "slot_closed"); }) }),
      getSnapshot: store.get,
      commit: store.commit,
      now: () => now,
    });
    const order = await runtime.createOrder(coffee);
    now = (order.expiresAt + 1) * 1000;

    const expired = await runtime.pollOrder(order);

    expect(expired.state).toBe("expired");
    expect(expired.privateKey).toBeUndefined();
    expect(expired.readCapability).toBeUndefined();
    expect(expired.writeCapability).toBeUndefined();
    expect(expired.request).toBeUndefined();
  });
});
