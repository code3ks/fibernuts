import { describe, expect, it } from "vitest";

import { EVENT } from "../event/manifest";
import { emptyMarketSnapshot, loadMarketSnapshot, marketStorageKey, saveMarketSnapshot } from "./storage";

const storedProof = {
  amount: 250,
  id: "synthetic_keyset",
  secret: "synthetic-storage-proof",
  C: `02${"11".repeat(32)}`,
};

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
});
