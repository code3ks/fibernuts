import { describe, expect, it } from "vitest";
import { PaymentRequest } from "@cashu/cashu-ts";

import { createPaymentRequest, decodePaymentRequest, normalizeMintUrl, validatePaymentRequest } from "./payment-request";

describe("Cashu payment requests", () => {
  it("round-trips the meetup payment through NUT-18", () => {
    const created = createPaymentRequest(250, "rusd", "https://mint.example/", "Coffee");
    const decoded = decodePaymentRequest(created.encoded);

    expect(decoded.amount).toBe(250);
    expect(decoded.unit).toBe("rusd");
    expect(decoded.mints).toEqual(["https://mint.example"]);
    expect(decoded.description).toBe("Coffee");
    expect(decoded.singleUse).toBe(true);
  });

  it("normalizes equivalent mint URLs before comparing them", () => {
    expect(normalizeMintUrl("https://mint.example///")).toBe("https://mint.example");
    const request = createPaymentRequest(250, "rusd", "https://mint.example/", "Coffee");

    expect(() => validatePaymentRequest(request, "https://mint.example", "rusd", 500)).not.toThrow();
  });

  it("rejects mint identities with unsafe URL components", () => {
    expect(() => normalizeMintUrl("ftp://mint.example")).toThrow(/HTTP or HTTPS/i);
    expect(() => normalizeMintUrl("https://user:secret@mint.example")).toThrow(/credentials/i);
    expect(() => normalizeMintUrl("https://mint.example?network=other")).toThrow(/query parameters/i);
    expect(() => normalizeMintUrl("https://mint.example/#other")).toThrow(/fragments/i);
  });

  it("rejects wrong-mint, wrong-unit, and insufficient-balance requests", () => {
    const request = createPaymentRequest(250, "rusd", "https://mint.example", "Coffee");

    expect(() => validatePaymentRequest(request, "https://other.example", "rusd", 500)).toThrow(/another mint/i);
    expect(() => validatePaymentRequest(request, "https://mint.example", "sat", 500)).toThrow(/not SAT/i);
    expect(() => validatePaymentRequest(request, "https://mint.example", "rusd", 100)).toThrow(/larger/i);
    expect(() => validatePaymentRequest({ ...request, amount: 0 }, "https://mint.example", "rusd", 500)).toThrow(/positive amount/i);
  });

  it("rejects bearer tokens as payment requests", () => {
    expect(() => decodePaymentRequest("cashuBo2FteB")).toThrow(/not a Cashu payment request/i);
  });

  it("rejects a single-use request that cannot be replay-protected", () => {
    const encoded = new PaymentRequest(
      undefined,
      undefined,
      250,
      "rusd",
      ["https://mint.example"],
      "Coffee",
      true,
    ).toEncodedRequest();

    expect(() => decodePaymentRequest(encoded)).toThrow(/no request ID/i);
  });
});
