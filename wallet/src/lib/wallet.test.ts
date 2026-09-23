import { describe, expect, it, vi } from "vitest";
import {
  createBlindSignature,
  createNewMintKeys,
  createP2PKsecret,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
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

  it("forces a swap when creating vendor-key-locked proofs", async () => {
    const wallet = new FibernutsWallet("https://mint.example");
    const source = [{ amount: 512, id: "keyset", secret: "source", C: `02${"11".repeat(32)}` }];
    const preview = {
      amount: 250,
      fees: 1,
      keysetId: "keyset",
      inputs: source,
      sendOutputs: [{ blindedMessage: { amount: "250", B_: "send", id: "keyset" }, blindingFactor: 1n, secret: new Uint8Array([1]) }],
      keepOutputs: [{ blindedMessage: { amount: "261", B_: "keep", id: "keyset" }, blindingFactor: 2n, secret: new Uint8Array([2]) }],
      unselectedProofs: [],
    };
    const cashuWallet = {
      sendOffline: vi.fn(() => { throw new Error("must not use offline proofs"); }),
      prepareSwapToSend: vi.fn(async () => preview),
    };
    (wallet as unknown as { wallet: typeof cashuWallet }).wallet = cashuWallet;

    const lock = { pubkey: `02${"22".repeat(32)}` };
    const prepared = await wallet.prepareSend(250, source as never, lock);

    expect(cashuWallet.sendOffline).not.toHaveBeenCalled();
    expect(cashuWallet.prepareSwapToSend).toHaveBeenCalledWith(
      250,
      source,
      { includeFees: true },
      { send: { type: "p2pk", options: lock }, keep: { type: "random" } },
    );
    expect(prepared).toMatchObject({ mode: "swap", debit: 251, fee: 1 });
  });

  it("rejects a token with extra P2PK spending paths", () => {
    const wallet = new FibernutsWallet("https://mint.example");
    const privateKey = createRandomSecretKey();
    const publicKey = Buffer.from(getPubKeyFromPrivKey(privateKey)).toString("hex");
    const proof = (secret: string) => ({
      amount: 1,
      id: "009a1f293253e41e",
      secret,
      C: `02${"11".repeat(32)}`,
    });
    const exactProof = proof(createP2PKsecret(publicKey));
    const refundableProof = proof(createP2PKsecret(publicKey, [["locktime", "1800000000"], ["refund", publicKey]]));
    vi.spyOn(wallet, "inspectToken").mockImplementation((token) => ({
      amount: 1,
      mint: "https://mint.example",
      unit: "rusd",
      proofs: [token === "exact" ? exactProof : refundableProof] as never,
    }));

    expect(wallet.tokenIsLockedTo("exact", publicKey)).toBe(true);
    expect(wallet.tokenIsLockedTo("refundable", publicKey)).toBe(false);
  });

  it("returns only newly issued change after an online send", async () => {
    const wallet = new FibernutsWallet("https://mint.example");
    const point = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
    const pair = createNewMintKeys(4, new Uint8Array(32).fill(9), { unit: "rusd" });
    const keyset = { id: pair.keysetId, keys: serializeMintKeys(pair.pubKeys) };
    const keysetId = pair.keysetId;
    const [changeOutput] = OutputData.createRandomData(1, keyset);
    const [sendOutput] = OutputData.createRandomData(2, keyset);
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
      keepOutputs: [OutputData.serialize(changeOutput)],
      sendOutputs: [OutputData.serialize(sendOutput)],
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
