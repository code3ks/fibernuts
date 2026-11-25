import { describe, expect, it } from "vitest";

import {
  createOperatorSettlementDeclaration,
  createSettlementContext,
  normalizeSettlementContext,
  parseFiberAssetIdentity,
} from "./settlement-context";

const script = {
  codeHash: `0x${"11".repeat(32)}`,
  hashType: "type",
  args: `0x${"22".repeat(32)}`,
};

describe("settlement context", () => {
  it("binds an operator declaration only to its exact configured mint", () => {
    const declaration = createOperatorSettlementDeclaration({
      mintUrl: "https://mint.example/",
      network: "CKB Testnet / Fiber",
      assetCodeHash: script.codeHash,
      assetHashType: script.hashType,
      assetArgs: script.args,
    });
    const configured = createSettlementContext({
      mintUrl: "https://mint.example",
      mintName: "Example mint",
      unit: "rusd",
      operatorDeclaration: declaration,
    });
    const custom = createSettlementContext({
      mintUrl: "https://other.example",
      mintName: "Other mint",
      unit: "rusd",
      operatorDeclaration: declaration,
    });

    expect(configured.network?.value).toBe("CKB Testnet / Fiber");
    expect(configured.assetTypeScript?.value).toEqual({ ...script, hashType: "type" });
    expect(custom.network).toBeUndefined();
    expect(custom.assetTypeScript).toBeUndefined();
  });

  it("rejects incomplete or malformed asset scripts", () => {
    expect(parseFiberAssetIdentity({ codeHash: script.codeHash, hashType: "type" })).toBeUndefined();
    expect(parseFiberAssetIdentity({ ...script, codeHash: "0x1234" })).toBeUndefined();
    expect(parseFiberAssetIdentity(script)).toEqual({ ...script, hashType: "type" });
  });

  it("drops malformed optional provenance without losing valid core identity", () => {
    expect(normalizeSettlementContext({
      mintName: { value: "Example", source: "mint_response" },
      unit: { value: "RUSD", source: "mint_response" },
      paymentMethod: { value: "Fiber", source: "mint_response" },
      network: { value: "CKB Testnet", source: "invented" },
      assetTypeScript: { value: { ...script, codeHash: "bad" }, source: "operator_configuration" },
    })).toEqual({
      mintName: { value: "Example", source: "mint_response" },
      unit: { value: "RUSD", source: "mint_response" },
      paymentMethod: { value: "Fiber", source: "mint_response" },
      network: undefined,
      assetTypeScript: undefined,
    });
  });
});
