import { describe, expect, it } from "vitest";

import { EVENT } from "../event/manifest";
import { emptyMarketSnapshot, loadMarketSnapshot, marketStorageKey, saveMarketSnapshot } from "./storage";

const storedProof = {
  amount: 250,
  id: "synthetic_keyset",
  secret: "synthetic-storage-proof",
  C: `02${"11".repeat(32)}`,
};
const refundPrivateKey = "0".repeat(63) + "1";
const refundPublicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

function deliveredPayment() {
  const orderId = "order-storage-test";
  const deliveryUrl = `${EVENT.paymentTransport.relayOrigin}/v1/deliver/${"w".repeat(43)}`;
  return {
    id: "payment-1",
    kind: "event_payment" as const,
    orderId,
    state: "delivered" as const,
    amount: 250,
    fee: 0,
    unit: "rusd" as const,
    mintUrl: EVENT.mintUrl,
    vendorName: "Block Cafe",
    description: "Coffee",
    request: "creqa-synthetic-request",
    deliveryUrl,
    payloadJson: JSON.stringify({ id: orderId, unit: "rusd", mint: EVENT.mintUrl, proofs: [storedProof] }),
    token: "cashuBsynthetic-token",
    deliveredAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

const refundSwap = {
  amount: 250,
  fees: 0,
  keysetId: "synthetic_keyset",
  inputs: [storedProof],
  sendOutputs: [],
  keepOutputs: [],
  unselectedProofs: [],
};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("market storage", () => {
  it("isolates attendee and vendor value and round-trips one atomic snapshot", () => {
    const storage = new MemoryStorage();
    const attendee = emptyMarketSnapshot(EVENT, "attendee");
    attendee.payments.push(deliveredPayment());
    saveMarketSnapshot(EVENT, attendee, storage);

    expect(loadMarketSnapshot(EVENT, "attendee", storage).payments).toHaveLength(1);
    expect(loadMarketSnapshot(EVENT, "vendor", storage).payments).toHaveLength(0);
    expect(marketStorageKey(EVENT, "attendee")).not.toBe(marketStorageKey(EVENT, "vendor"));
  });

  it("fails closed on corrupt stored records", () => {
    const storage = new MemoryStorage();
    storage.setItem(marketStorageKey(EVENT, "attendee"), JSON.stringify({
      ...emptyMarketSnapshot(EVENT, "attendee"),
      payments: [{ state: "spent" }],
    }));

    expect(() => loadMarketSnapshot(EVENT, "attendee", storage)).toThrow(/malformed/i);
  });

  it("rejects a nested operation bound to another unit", () => {
    const storage = new MemoryStorage();
    storage.setItem(marketStorageKey(EVENT, "attendee"), JSON.stringify({
      ...emptyMarketSnapshot(EVENT, "attendee"),
      payments: [{ ...deliveredPayment(), unit: "sat" }],
    }));

    expect(() => loadMarketSnapshot(EVENT, "attendee", storage)).toThrow(/another unit/i);
  });

  it("rejects a proof that is both spendable and reserved", () => {
    const storage = new MemoryStorage();
    const snapshot = emptyMarketSnapshot(EVENT, "attendee");
    snapshot.proofs = [storedProof] as unknown as typeof snapshot.proofs;
    snapshot.payments = [{
      ...deliveredPayment(),
      state: "preparing",
      payloadJson: undefined,
      token: undefined,
      deliveredAt: undefined,
      swap: {
        amount: 250,
        fees: 0,
        keysetId: "synthetic_keyset",
        inputs: [storedProof] as unknown as typeof snapshot.proofs,
        sendOutputs: [],
        keepOutputs: [],
        unselectedProofs: [],
      },
    }];

    expect(() => saveMarketSnapshot(EVENT, snapshot, storage)).toThrow(/overlap/i);
  });

  it("round-trips complete refund recovery data and rejects partial key material", () => {
    const storage = new MemoryStorage();
    const snapshot = emptyMarketSnapshot(EVENT, "attendee");
    snapshot.payments = [{
      ...deliveredPayment(),
      state: "refunding",
      refundPrivateKey,
      refundPublicKey,
      refundLocktime: 1_800_000_300,
      refundSwap: refundSwap as unknown as typeof snapshot.payments[number]["refundSwap"],
    }];

    saveMarketSnapshot(EVENT, snapshot, storage);
    expect(loadMarketSnapshot(EVENT, "attendee", storage).payments[0].refundSwap?.amount).toBe(250);

    const partial = structuredClone(snapshot);
    partial.payments[0].refundPublicKey = undefined;
    expect(() => saveMarketSnapshot(EVENT, partial, storage)).toThrow(/refund key material/i);

    const mismatched = structuredClone(snapshot);
    mismatched.payments[0].refundPrivateKey = "11".repeat(32);
    expect(() => saveMarketSnapshot(EVENT, mismatched, storage)).toThrow(/refund key material/i);
  });

  it("rejects refund keys without the bound payment request", () => {
    const storage = new MemoryStorage();
    const snapshot = emptyMarketSnapshot(EVENT, "attendee");
    snapshot.payments = [{
      ...deliveredPayment(),
      request: undefined,
      refundPrivateKey,
      refundPublicKey,
      refundLocktime: 1_800_000_300,
    }];

    expect(() => saveMarketSnapshot(EVENT, snapshot, storage)).toThrow(/refund request/i);
  });
});
