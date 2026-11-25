import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  preserveOutput: "always",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: true,
    timeout: 30_000,
    env: {
      VITE_MINT_URL: "http://127.0.0.1:5174",
      VITE_NETWORK_LABEL: "CKB Testnet / Fiber",
      VITE_ASSET_CODE_HASH: `0x${"11".repeat(32)}`,
      VITE_ASSET_HASH_TYPE: "type",
      VITE_ASSET_ARGS: `0x${"22".repeat(32)}`,
    },
  },
});
