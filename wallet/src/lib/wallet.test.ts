import { describe, expect, it, vi } from "vitest";
import {
  createBlindSignature,
  createNewMintKeys,
  deriveKeysetId,
  OutputData,
  pointFromHex,
  serializeMintKeys,
} from "@cashu/cashu-ts";

import {
  explainMeltError,
  FibernutsWallet,
  fmt,
  matchRestoredSignatures,
  mintQuoteIsPaid,
  parseAmount,
  sumProofs,
  units,
} from "./wallet";

describe("wallet amount helpers", () => {
  it("parses decimal currency without accepting zero or excess precision", () => {
    expect(parseAmount("12.34")).toBe(1234);
    expect(parseAmount("$0.01")).toBe(1);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("1.001")).toBeNull();
    expect(parseAmount("not money")).toBeNull();
  });

  it("formats signed cent values and restores serialized proof amounts", () => {
    expect(fmt(1234)).toBe("12.34");
    expect(fmt(-5)).toBe("-0.05");
    expect(units("8")).toBe(8);
    expect(sumProofs([{ amount: "2" }, { amount: 4 }] as never[])).toBe(6);
  });

  it("turns the mint's masked route error into actionable copy", () => {
    expect(explainMeltError("11013 Unit unsupported")).toMatch(/could not route/i);
    expect(explainMeltError("another error")).toBe("another error");
  });

  it("does not treat a partial custom mint payment as fully funded", () => {
    const quote = {
      quote: "quote-1",
      request: "fibt1synthetic",
      amount: 1000,
      amount_paid: 999,
      unit: "rusd",
      state: "UNPAID",
    };

    expect(mintQuoteIsPaid(quote as never)).toBe(false);
    expect(mintQuoteIsPaid({ ...quote, state: undefined, amount_paid: 1000 } as never)).toBe(true);
    expect(mintQuoteIsPaid({ ...quote, amount_paid: 1000 } as never)).toBe(false);
    expect(mintQuoteIsPaid({ ...quote, state: "PAID", amount_paid: 0 } as never)).toBe(true);
  });

  it("covers the recipient's proof fee in an exact offline send", async () => {
    const wallet = new FibernutsWallet("https://mint.example");
    const source = [{ amount: 1024, id: "keyset", secret: "source", C: `02${"11".repeat(32)}` }];
    const cashuWallet = {
      sendOffline: vi.fn(() => ({ keep: [], send: source })),
      getFeesForProofs: vi.fn(() => 1),
    };
    (wallet as unknown as { wallet: typeof cashuWallet }).wallet = cashuWallet;

    const prepared = await wallet.prepareSend(1023, source as never);

    expect(cashuWallet.sendOffline).toHaveBeenCalledWith(1023, source, { includeFees: true });
    expect(prepared).toMatchObject({ mode: "offline", debit: 1024, fee: 1 });
  });

  it("returns only newly issued change after an online send", async () => {
    const wallet = new FibernutsWallet("https://mint.example");
    const point = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
    const keysetId = deriveKeysetId({ "1": point, "2": point, "4": point }, { unit: "rusd" });
    const freshChange = { amount: 1, id: keysetId, secret: "fresh", C: point };
    const staleUnselected = { amount: 4, id: keysetId, secret: "old", C: point };
    const sent = { amount: 2, id: keysetId, secret: "sent", C: point };
    const cashuWallet = {
      completeSwap: vi.fn(async () => ({ keep: [freshChange, staleUnselected], send: [sent] })),
    };
    (wallet as unknown as { wallet: typeof cashuWallet }).wallet = cashuWallet;

    const result = await wallet.completePreparedSend({
      amount: 2,
      fees: 0,
      keysetId,
      inputs: [],
      keepOutputs: [{ blindedMessage: { amount: "1", B_: "blind-change", id: keysetId }, blindingFactor: "1", secret: "01" }],
      sendOutputs: [{ blindedMessage: { amount: "2", B_: "blind-send", id: keysetId }, blindingFactor: "2", secret: "02" }],
      unselectedProofs: [staleUnselected] as never,
    } as never);

    expect(result.change).toEqual([freshChange]);
    expect(result.token).toMatch(/^cashu/i);
  });

  it("matches restored signatures to stored blinded outputs rather than response order", () => {
    const expected = [
      { blindedMessage: { amount: "1", B_: "blind-one", id: "keyset" }, blindingFactor: "1", secret: "01" },
      { blindedMessage: { amount: "2", B_: "blind-two", id: "keyset" }, blindingFactor: "2", secret: "02" },
    ];
    const response = {
      outputs: [
        { amount: 2, B_: "blind-two", id: "keyset" },
        { amount: 1, B_: "blind-one", id: "keyset" },
      ],
      signatures: [
        { amount: 2, id: "keyset", C_: "signature-two" },
        { amount: 1, id: "keyset", C_: "signature-one" },
      ],
    };

    expect(matchRestoredSignatures(expected as never, response as never)?.map((item) => item.C_)).toEqual([
      "signature-one",
      "signature-two",
    ]);
  });

  it("rejects incomplete, duplicated, or amount-mismatched restore responses", () => {
    const expected = [
      { blindedMessage: { amount: "1", B_: "blind-one", id: "keyset" }, blindingFactor: "1", secret: "01" },
    ];
    const validOutput = { amount: 1, B_: "blind-one", id: "keyset" };
    const validSignature = { amount: 1, id: "keyset", C_: "signature-one" };

    expect(matchRestoredSignatures(expected as never, { outputs: [], signatures: [] } as never)).toBeNull();
    expect(matchRestoredSignatures([...expected, ...expected] as never, {
      outputs: [validOutput, validOutput],
      signatures: [validSignature, validSignature],
    } as never)).toBeNull();
    expect(matchRestoredSignatures(expected as never, {
      outputs: [validOutput],
      signatures: [{ ...validSignature, amount: 2 }],
    } as never)).toBeNull();
  });

  it("recovers a spendable proof when a swap committed but its response was lost", async () => {
    const pair = createNewMintKeys(4, new Uint8Array(32).fill(7), { unit: "rusd" });
    const keys = serializeMintKeys(pair.pubKeys);
    const keyset = { id: pair.keysetId, keys };
    const [output] = OutputData.createRandomData(1, keyset);
    const blindSignature = createBlindSignature(
      pointFromHex(output.blindedMessage.B_),
      pair.privKeys["1"],
      pair.keysetId,
    );
    const signature = {
      id: pair.keysetId,
      amount: 1,
      C_: blindSignature.C_.toHex(true),
    };
    const restore = vi.fn(async () => ({
      outputs: [output.blindedMessage],
      signatures: [signature],
    }));
    const cashuWallet = {
      completeSwap: vi.fn(async () => { throw new Error("response lost"); }),
      mint: { restore },
      getMintInfo: () => ({ nuts: { "12": { supported: false } } }),
      getKeyset: () => keyset,
    };
    const wallet = new FibernutsWallet("https://mint.example");
    (wallet as unknown as { wallet: typeof cashuWallet }).wallet = cashuWallet;

    const proofs = await wallet.completePreparedReceive({
      amount: 1,
      fees: 0,
      keysetId: pair.keysetId,
      inputs: [],
      keepOutputs: [OutputData.serialize(output)],
    });

    expect(restore).toHaveBeenCalledOnce();
    expect(proofs).toHaveLength(1);
    expect(units(proofs[0].amount)).toBe(1);
    expect(proofs[0].secret).toBe(new TextDecoder().decode(output.secret));
  });
});
