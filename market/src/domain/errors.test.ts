import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "./errors";

describe("safe error messages", () => {
  it("redacts bearer values from third-party errors", () => {
    const token = `cashuB${"a".repeat(80)}`;
    const invoice = `fibt1${"q".repeat(120)}`;
    const capability = "w".repeat(43);
    const message = safeErrorMessage(new Error(`failed ${token} ${invoice} /v1/deliver/${capability}`));

    expect(message).not.toContain(token);
    expect(message).not.toContain(invoice);
    expect(message).not.toContain(capability);
    expect(message).toContain("[redacted Cashu token]");
  });

  it("uses a bounded fallback for unknown failures", () => {
    const canaries = {
      proof: "synthetic-proof-secret",
      key: "2".repeat(64),
      quote: "quote-user-linked-canary",
      capability: "r".repeat(43),
      address: `ckt1${"b".repeat(64)}`,
      email: "attendee@example.test",
    };
    const message = safeErrorMessage(new Error(
      `proofSecret=${canaries.proof} refundPrivateKey=${canaries.key} quoteId=${canaries.quote} ` +
      `writeCapability=${canaries.capability} address=${canaries.address} user=${canaries.email}`,
    ));
    for (const canary of Object.values(canaries)) expect(message).not.toContain(canary);
    expect(safeErrorMessage({ value: "not printable" }, "Safe fallback")).toBe("Safe fallback");
    expect(safeErrorMessage(new Error("x".repeat(800)))).toHaveLength(500);
  });
});
