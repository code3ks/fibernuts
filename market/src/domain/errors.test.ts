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
    expect(safeErrorMessage({ value: "not printable" }, "Safe fallback")).toBe("Safe fallback");
    expect(safeErrorMessage(new Error("x".repeat(800)))).toHaveLength(500);
  });
});
