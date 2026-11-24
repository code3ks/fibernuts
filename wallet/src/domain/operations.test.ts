import { describe, expect, it } from "vitest";

import { operationGuidance, operationNeedsAttention, presentOperation, type WalletOperation } from "./operations";

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

    expect(presentOperation(detected).tone).toBe("pending");
    expect(presentOperation(detected).phase).toBe("pending");
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
    expect(presentOperation(cashout).phase).toBe("recoverable");
    expect(operationNeedsAttention(cashout)).toBe(true);
    expect(operationGuidance(cashout).valueStatus).toMatch(/remain reserved/i);
    expect(operationGuidance(cashout).nextAction).toMatch(/same quote/i);
  });

  it("distinguishes active processing from a pending external result", () => {
    const preparing = { ...base, kind: "send", state: "preparing" } satisfies WalletOperation;
    const pending = {
      ...base,
      kind: "send",
      state: "acceptance_pending",
      token: "cashuBsynthetic",
    } satisfies WalletOperation;

    expect(presentOperation(preparing)).toMatchObject({ tone: "processing", phase: "processing" });
    expect(presentOperation(pending)).toMatchObject({ tone: "pending", phase: "pending" });
    expect(operationGuidance(pending).valueStatus).toMatch(/not spendable/i);
  });

  it("describes removed incoming tokens as stopped rather than failed settlement", () => {
    const discarded = { ...base, kind: "receive", state: "discarded" } satisfies WalletOperation;

    expect(presentOperation(discarded)).toMatchObject({ tone: "neutral", phase: "stopped" });
    expect(operationGuidance(discarded).known).toMatch(/explicitly removed/i);
    expect(operationNeedsAttention(discarded)).toBe(false);
  });

  it("only marks completed incoming value as settled", () => {
    const settled = { ...base, kind: "receive", state: "settled" } satisfies WalletOperation;
    expect(presentOperation(settled).tone).toBe("settled");
    expect(operationNeedsAttention(settled)).toBe(false);
  });
});
