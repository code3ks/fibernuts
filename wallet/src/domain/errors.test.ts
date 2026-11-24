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
    const secret = "s".repeat(80);
    expect(safeErrorMessage(new Error(`secret=${secret}`))).not.toContain(secret);
    expect(safeErrorMessage({ message: "not trusted" }, "Safe fallback")).toBe("Safe fallback");
    expect(safeErrorMessage(new Error("x".repeat(800)))).toHaveLength(500);
  });
});
