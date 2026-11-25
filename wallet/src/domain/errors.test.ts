import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "./errors";

describe("safe wallet error messages", () => {
  it("redacts bearer data and user-linked payment payloads", () => {
    const token = `cashuB${"a".repeat(80)}`;
    const request = `creqA${"b".repeat(80)}`;
    const invoice = `fibt1${"q".repeat(120)}`;
    const message = safeErrorMessage(new Error(`failed ${token} ${request} ${invoice}`));

    expect(message).not.toContain(token);
    expect(message).not.toContain(request);
    expect(message).not.toContain(invoice);
    expect(message).toContain("[redacted Cashu token]");
    expect(message).toContain("[redacted payment request]");
    expect(message).toContain("[redacted Fiber invoice]");
  });

  it("redacts named secrets and bounds untrusted errors", () => {
    const canaries = {
      secret: "s".repeat(80),
      key: "1".repeat(64),
      quote: "quote-user-linked-canary",
      capability: "c".repeat(43),
      address: `ckt1${"a".repeat(64)}`,
      email: "person@example.test",
    };
    const message = safeErrorMessage(new Error(
      `secret=${canaries.secret} refundPrivateKey=${canaries.key} quote_id=${canaries.quote} ` +
      `readCapability=${canaries.capability} address=${canaries.address} owner=${canaries.email}`,
    ));
    for (const canary of Object.values(canaries)) expect(message).not.toContain(canary);
    expect(safeErrorMessage({ message: "not trusted" }, "Safe fallback")).toBe("Safe fallback");
    expect(safeErrorMessage(new Error("x".repeat(800)))).toHaveLength(500);
  });
});
