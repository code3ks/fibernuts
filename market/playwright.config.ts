import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  preserveOutput: "always",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5175",
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
