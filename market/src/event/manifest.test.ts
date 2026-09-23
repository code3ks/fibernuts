import { describe, expect, it } from "vitest";

import { EVENT, validateEventManifest } from "./manifest";

describe("event manifest", () => {
  it("binds the market to one testnet RUSD identity", () => {
    expect(EVENT.network).toBe("testnet");
    expect(EVENT.unit).toBe("rusd");
    expect(EVENT.assetTypeScript.codeHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(EVENT.paymentTransport.mode).toBe("post_p2pk");
  });

  it("rejects duplicate IDs, floating prices, and unsafe origins", () => {
    expect(() => validateEventManifest({ ...EVENT, vendors: [EVENT.vendors[0], EVENT.vendors[0]] })).toThrow(/unique/i);
    expect(() => validateEventManifest({
      ...EVENT,
      vendors: [{ ...EVENT.vendors[0], catalog: [{ ...EVENT.vendors[0].catalog[0], price: 2.5 }] }],
    })).toThrow(/positive integer/i);
    expect(() => validateEventManifest({
      ...EVENT,
      paymentTransport: { mode: "post_p2pk", relayOrigin: "https://user:secret@relay.example" },
    })).toThrow(/without credentials/i);
  });

  it("rejects unsupported runtime fields and transport modes", () => {
    expect(() => validateEventManifest({ ...EVENT, hidden: true })).toThrow(/unsupported fields/i);
    expect(() => validateEventManifest({
      ...EVENT,
      paymentTransport: { ...EVENT.paymentTransport, mode: "post_bearer_testnet" },
    })).toThrow(/unsupported payment transport/i);
  });
});
