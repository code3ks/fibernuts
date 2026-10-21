import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("production startup requires HTTPS origins and a random identifier secret", () => {
  const original = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.FIBERNUTS_FAUCET_PUBLIC_ORIGIN = "https://claim.example.test";
    process.env.FIBERNUTS_FAUCET_MINT_URL = "https://mint.example.test";
    process.env.FIBERNUTS_FAUCET_ALLOWED_ORIGINS = "https://market.example.test";
    process.env.FIBERNUTS_FAUCET_IDENTIFIER_SECRET = "paste-a-random-64-character-hex-string-here";
    assert.throws(loadConfig, /random 64-character hex/i);

    process.env.FIBERNUTS_FAUCET_IDENTIFIER_SECRET = "ab".repeat(32);
    process.env.FIBERNUTS_FAUCET_ALLOWED_ORIGINS = "http://market.example.test";
    assert.throws(loadConfig, /must use HTTPS/i);

    process.env.FIBERNUTS_FAUCET_ALLOWED_ORIGINS = "https://market.example.test";
    const config = loadConfig();
    assert.equal(config.allowedOrigins.has("https://market.example.test"), true);
    assert.deepEqual(config.udtScript, {
      codeHash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
      hashType: "type",
      args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b",
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
