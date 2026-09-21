import { describe, expect, it } from "vitest";

import { operationNeedsAttention, presentOperation, type WalletOperation } from "./operations";

const base = {
  id: "operation-1",
  amount: 250,
  createdAt: 1,
  updatedAt: 1,
  mintUrl: "https://mint.example",
  unit: "rusd",
};

describe("operation presentation", () => {
  it("does not call an incoming token settled before the receive swap succeeds", () => {
    const detected = { ...base, kind: "receive", state: "detected", token: "cashu-test" } satisfies WalletOperation;

    expect(presentOperation(detected).tone).toBe("neutral");
    expect(presentOperation(detected).stateLabel).toBe("Token detected");
    expect(operationNeedsAttention(detected)).toBe(true);
  });

  it("keeps ambiguous cash outs recoverable", () => {
    const cashout = {
      ...base,
      kind: "cashout",
      state: "unknown",
      invoice: "fibt-test",
      quote: {
        quote: "quote-1",
        amount: 250,
        feeReserve: 2,
        unit: "rusd",
        state: "PENDING",
        expiry: 100,
        request: "fibt-test",
      },
    } satisfies WalletOperation;

    expect(presentOperation(cashout).tone).toBe("recoverable");
    expect(operationNeedsAttention(cashout)).toBe(true);
  });

  it("only marks completed incoming value as settled", () => {
    const settled = { ...base, kind: "receive", state: "settled" } satisfies WalletOperation;
    expect(presentOperation(settled).tone).toBe("settled");
    expect(operationNeedsAttention(settled)).toBe(false);
  });
});
