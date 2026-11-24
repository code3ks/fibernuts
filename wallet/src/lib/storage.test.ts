import { describe, expect, it } from "vitest";

import { loadActiveMint, loadWalletSnapshot, saveActiveMint, saveWalletSnapshot } from "./storage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("wallet storage", () => {
  it("stores proofs, operations, and the open request in one versioned snapshot", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    const snapshot = {
      version: 2 as const,
      unit: "rusd",
      proofs: [{ amount: 2, id: "keyset", secret: "secret", C: `02${"11".repeat(32)}` }] as never[],
      operations: [
        {
          id: "send-1",
          kind: "send" as const,
          state: "awaiting_acceptance" as const,
          amount: 2,
          createdAt: 1,
          updatedAt: 1,
          mintUrl,
          unit: "rusd",
          token: "cashuBsynthetic",
          context: {
            mintName: { value: "Test mint", source: "mint_response" as const },
            unit: { value: "RUSD", source: "mint_response" as const },
            paymentMethod: { value: "Fiber", source: "mint_response" as const },
            network: { value: "CKB Testnet", source: "operator_configuration" as const },
            assetTypeScript: {
              value: {
                codeHash: `0x${"11".repeat(32)}`,
                hashType: "type" as const,
                args: `0x${"22".repeat(32)}`,
              },
              source: "operator_configuration" as const,
            },
          },
        },
      ],
      openRequest: {
        id: "request-1",
        amount: 2,
        unit: "rusd",
        mints: [mintUrl],
        description: "Coffee",
        singleUse: true,
        encoded: "creqAsynthetic",
      },
    };

    saveWalletSnapshot(mintUrl, snapshot, storage);
    const restored = loadWalletSnapshot(mintUrl, storage);

    expect(restored.proofs).toHaveLength(1);
    expect(restored.unit).toBe("rusd");
    expect(restored.operations).toEqual(snapshot.operations);
    expect(restored.openRequest).toEqual(snapshot.openRequest);
    expect(storage.length).toBe(1);
  });

  it("migrates the legacy proof-only key without inventing activity", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    storage.setItem(
      `fibernuts:proofs:${mintUrl}`,
      JSON.stringify([{ amount: 4, id: "keyset", secret: "legacy", C: `02${"22".repeat(32)}` }]),
    );

    const restored = loadWalletSnapshot(mintUrl, storage);

    expect(restored.proofs).toHaveLength(1);
    expect(restored.operations).toEqual([]);
    expect(storage.getItem(`fibernuts:wallet:v2:${mintUrl}`)).not.toBeNull();
  });

  it("drops malformed requests and snapshot entries instead of crashing", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    storage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({ version: 2, proofs: "bad", operations: [null, {}], openRequest: { amount: -1 } }),
    );

    expect(loadWalletSnapshot(mintUrl, storage)).toEqual({
      version: 2,
      unit: undefined,
      proofs: [],
      operations: [],
      openRequest: undefined,
    });
  });

  it("keeps the active mint choice separate from wallet value", () => {
    const storage = new MemoryStorage();
    saveActiveMint("https://mint.example", storage);
    expect(loadActiveMint("https://fallback.example", storage)).toBe("https://mint.example");
  });

  it("falls back when the stored active mint is not a safe HTTP URL", () => {
    const storage = new MemoryStorage();
    storage.setItem("fibernuts:active-mint", "javascript:alert(1)");

    expect(loadActiveMint("https://fallback.example/", storage)).toBe("https://fallback.example");
  });

  it("keeps operations and requests inside the snapshot's bound unit", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    storage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        unit: "rusd",
        proofs: [],
        operations: [
          {
            id: "wrong-unit",
            kind: "send",
            state: "accepted",
            amount: 2,
            createdAt: 1,
            updatedAt: 1,
            mintUrl,
            unit: "sat",
          },
        ],
        openRequest: {
          amount: 2,
          unit: "sat",
          mints: [mintUrl],
          description: "Wrong unit",
          singleUse: false,
          encoded: "creqAsynthetic",
        },
      }),
    );

    const restored = loadWalletSnapshot(mintUrl, storage);
    expect(restored.unit).toBe("rusd");
    expect(restored.operations).toEqual([]);
    expect(restored.openRequest).toBeUndefined();
  });

  it("drops an operation whose mint URL conflicts with the snapshot key", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    storage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        unit: "rusd",
        proofs: [],
        operations: [{
          id: "wrong-mint",
          kind: "send",
          state: "awaiting_acceptance",
          amount: 2,
          createdAt: 1,
          updatedAt: 1,
          mintUrl: "https://other.example",
          unit: "rusd",
          token: "cashuBsynthetic",
        }],
      }),
    );

    expect(loadWalletSnapshot(mintUrl, storage).operations).toEqual([]);
  });

  it("restores new recovery states and drops conflicting provenance", () => {
    const storage = new MemoryStorage();
    const mintUrl = "https://mint.example";
    storage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        unit: "rusd",
        proofs: [],
        operations: [
          {
            id: "pending-send",
            kind: "send",
            state: "acceptance_pending",
            amount: 2,
            createdAt: 1,
            updatedAt: 1,
            mintUrl,
            unit: "rusd",
            token: "cashuBsynthetic",
            context: {
              mintName: { value: "Wrong unit mint", source: "mint_response" },
              unit: { value: "SAT", source: "mint_response" },
              paymentMethod: { value: "Fiber", source: "mint_response" },
            },
          },
          {
            id: "removed-receive",
            kind: "receive",
            state: "discarded",
            amount: 3,
            createdAt: 2,
            updatedAt: 2,
            mintUrl,
            unit: "rusd",
          },
        ],
      }),
    );

    const restored = loadWalletSnapshot(mintUrl, storage);
    expect(restored.operations.map((operation) => operation.state)).toEqual(["acceptance_pending", "discarded"]);
    expect(restored.operations[0].context).toBeUndefined();
  });
});
