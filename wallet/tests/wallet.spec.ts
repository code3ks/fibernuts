import { expect, test, type Page } from "@playwright/test";
import {
  createBlindSignature,
  deriveKeysetId,
  getEncodedToken,
  PaymentRequest,
  pointFromHex,
} from "@cashu/cashu-ts";

const viewports = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];

const uncaughtErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  uncaughtErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(uncaughtErrors.get(page) ?? []).toEqual([]);
});

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function mockCompatibleMint(page: Page, inputFeePpk = 0, proofState: "UNSPENT" | "PENDING" | "SPENT" = "UNSPENT") {
  const key = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
  const keys = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [String(2 ** index), key]));
  const keyset = {
    id: deriveKeysetId(keys, { unit: "rusd", input_fee_ppk: inputFeePpk }),
    unit: "rusd",
    keys,
  };
  const signOutputs = (outputs: Array<{ amount: number | string; B_: string; id: string }> = []) => {
    const privateKey = new Uint8Array(32);
    privateKey[31] = 1;
    return outputs.map((output) => {
      const signature = createBlindSignature(pointFromHex(output.B_), privateKey, output.id);
      return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true) };
    });
  };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/info") {
      await route.fulfill({
        json: {
          name: "CKB Meetup Test Mint",
          pubkey: key,
          version: "mock/1.0",
          description: "Synthetic browser-test mint",
          contact: [],
          nuts: {
            "4": { methods: [{ method: "fiber", unit: "rusd", min_amount: 1, max_amount: 500000 }], disabled: false },
            "5": { methods: [{ method: "fiber", unit: "rusd", min_amount: 1, max_amount: 500000 }], disabled: false },
            "7": { supported: true },
            "9": { supported: true },
            "19": {
              ttl: null,
              cached_endpoints: [
                { method: "POST", path: "/v1/swap" },
                { method: "POST", path: "/v1/mint/fiber" },
              ],
            },
          },
        },
      });
      return;
    }
    if (path === "/v1/keysets") {
      await route.fulfill({ json: { keysets: [{ id: keyset.id, unit: keyset.unit, active: true, input_fee_ppk: inputFeePpk }] } });
      return;
    }
    if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
      await route.fulfill({ json: { keysets: [keyset] } });
      return;
    }
    if (path === "/v1/mint/quote/fiber" && request.method() === "POST") {
      await route.fulfill({
        json: {
          quote: "mint-quote-browser-test",
          request: "fibt1synthetic-browser-test-invoice",
          state: "UNPAID",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          amount: 1000,
          unit: "rusd",
        },
      });
      return;
    }
    if (path === "/v1/mint/quote/fiber/mint-quote-browser-test" && request.method() === "GET") {
      await route.fulfill({
        json: {
          quote: "mint-quote-browser-test",
          request: "fibt1synthetic-browser-test-invoice",
          state: "PAID",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          amount: 1000,
          amount_paid: 1000,
          unit: "rusd",
        },
      });
      return;
    }
    if (path === "/v1/mint/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { outputs?: Array<{ amount: number | string; B_: string; id: string }> };
      await route.fulfill({ json: { signatures: signOutputs(body.outputs) } });
      return;
    }
    if (path === "/v1/melt/quote/fiber" && request.method() === "POST") {
      await route.fulfill({
        json: {
          quote: "melt-quote-browser-test",
          request: "fibt1external-synthetic-invoice",
          state: "UNPAID",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          amount: 250,
          fee_reserve: 2,
          unit: "rusd",
        },
      });
      return;
    }
    if (path === "/v1/melt/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { outputs?: Array<{ amount: number | string; B_: string; id: string }> };
      const [blank] = body.outputs ?? [];
      const change = blank
        ? signOutputs([{ ...blank, amount: 4 }])
        : [];
      await route.fulfill({
        json: {
          quote: "melt-quote-browser-test",
          request: "fibt1external-synthetic-invoice",
          state: "PAID",
          expiry: Math.floor(Date.now() / 1000) + 3600,
          amount: 250,
          fee_reserve: 2,
          payment_preimage: null,
          change,
          unit: "rusd",
        },
      });
      return;
    }
    if (path === "/v1/checkstate" && request.method() === "POST") {
      const body = request.postDataJSON() as { Ys?: string[] };
      await route.fulfill({
        json: { states: (body.Ys ?? []).map((Y) => ({ Y, state: proofState, witness: null })) },
      });
      return;
    }
    if (path === "/v1/swap" && request.method() === "POST") {
      const body = request.postDataJSON() as { outputs?: Array<{ amount: number | string; B_: string; id: string }> };
      await route.fulfill({
        json: { signatures: signOutputs(body.outputs) },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "Synthetic endpoint not implemented" } });
  });
  return keyset.id;
}

test("publishes complete branded sharing metadata", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("FiberNuts | RUSD ecash over Fiber");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://fibernuts.strawhatcrew.xyz/",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://fibernuts.strawhatcrew.xyz/social-card.png",
  );
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute("content", /FiberNuts RUSD ecash wallet/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");

  const dimensions = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/social-card.png";
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(dimensions).toEqual({ width: 1200, height: 630 });

  const manifest = await page.request.get("/site.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({ name: "FiberNuts", theme_color: "#0f5b43" });
});

for (const viewport of viewports) {
  test(`wallet shell is stable at ${viewport.name} width`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByText("Cannot reach the mint")).toBeVisible();
    await expect(page.getByText(/ecash - stored in this browser/i)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`home-${viewport.name}.png`), fullPage: true });
  });
}

test("request and pay flows validate locally on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  await page.locator(".mobile-nav").getByRole("button", { name: "Request" }).click();
  await expect(page.getByRole("heading", { name: "Ask for a specific payment" })).toBeVisible();
  await page.getByLabel("What is it for?").fill("Coffee at the meetup");
  await page.getByRole("button", { name: "Create request" }).click();
  await expect(page.getByText("Cashu payment request")).toBeVisible();
  await expect(page.locator(".qr-panel__code svg")).toBeVisible();
  await expect(page.getByText(/contains no wallet proofs/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Share payment request" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.locator(".flow-enter")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("request-mobile.png"), fullPage: true });

  await page.reload();
  await page.locator(".mobile-nav").getByRole("button", { name: "Request" }).click();
  await expect(page.getByText("Coffee at the meetup")).toBeVisible();

  await page.locator(".mobile-nav").getByRole("button", { name: "Pay" }).click();
  await page.getByRole("button", { name: "Read request" }).click();
  await expect(page.getByText("Paste a Cashu payment request first.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("compatible mint exposes online add-cash and cash-out review states", async ({ page }, testInfo) => {
  const keysetId = await mockCompatibleMint(page);
  await page.addInitScript((activeKeysetId) => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        proofs: [{ amount: 1000, id: activeKeysetId, secret: "synthetic-proof", C: `02${"11".repeat(32)}` }],
        operations: [],
      }),
    );
  }, keysetId);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await expect(page.getByText("CKB Meetup Test Mint").first()).toBeVisible();

  await page.getByRole("button", { name: "Add cash" }).click();
  await expect(page.getByRole("heading", { name: "Turn a Fiber payment into ecash" })).toBeVisible();
  await page.getByRole("button", { name: "Create Fiber invoice" }).click();
  await expect(page.getByText("Pay from a Fiber wallet")).toBeVisible();
  await expect(page.locator(".qr-panel__code svg")).toBeVisible();

  await page.locator(".desktop-nav").getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "Cash out" }).click();
  await page.getByLabel("External Fiber invoice").fill("fibt1external-synthetic-invoice");
  await page.getByRole("button", { name: "Review quote" }).click();
  await expect(page.getByText("Maximum debit")).toBeVisible();
  await expect(page.getByText("2.52 RUSD")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.locator(".flow-enter")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("cashout-review-desktop.png"), fullPage: true });
});

test("paid Fiber quote credits balance only after blind-signature issuance", async ({ page }) => {
  await mockCompatibleMint(page);
  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.getByRole("button", { name: "Add cash" }).click();
  await page.getByRole("button", { name: "Create Fiber invoice" }).click();
  await expect(page.getByText("Pay from a Fiber wallet")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();

  await expect(page.getByText("Cash added")).toBeVisible();
  await expect(page.getByText(/balance changed only after the new proofs/i)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".balance-receipt__amount strong")).toHaveText("10.00");
});

test("paid cash-out stores NUT-08 change before showing completion", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page);
  await page.addInitScript((activeKeysetId) => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        proofs: [{ amount: 256, id: activeKeysetId, secret: "cashout-source", C: `02${"44".repeat(32)}` }],
        operations: [],
      }),
    );
  }, keysetId);

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.getByRole("button", { name: "Cash out" }).click();
  await page.getByLabel("External Fiber invoice").fill("fibt1external-synthetic-invoice");
  await page.getByRole("button", { name: "Review quote" }).click();
  await expect(page.getByText("2.52 RUSD")).toBeVisible();
  await page.getByRole("button", { name: "Confirm cash-out" }).click();

  await expect(page.getByRole("heading", { name: "Cash-out complete" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".balance-receipt__amount strong")).toHaveText("0.04");
});

test("payment review covers proof fees and blocks a repeated single-use request", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page, 1000);
  await page.addInitScript((activeKeysetId) => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        proofs: [{ amount: 1024, id: activeKeysetId, secret: "fee-test-proof", C: `02${"33".repeat(32)}` }],
        operations: [],
      }),
    );
  }, keysetId);
  const request = new PaymentRequest(
    undefined,
    "single-use-browser-test",
    1023,
    "rusd",
    ["http://127.0.0.1:5174"],
    "Meetup lunch",
    true,
  ).toEncodedRequest();

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.locator(".desktop-nav").getByRole("button", { name: "Pay" }).click();
  await page.getByLabel("Cashu payment request").fill(request);
  await page.getByRole("button", { name: "Read request" }).click();
  await expect(page.getByRole("heading", { name: "Meetup lunch" })).toBeVisible();
  await expect(page.getByText("0.01 RUSD")).toBeVisible();
  await expect(page.getByText("10.24 RUSD")).toBeVisible();
  await page.getByRole("button", { name: "Pay 10.23 RUSD" }).click();
  await expect(page.getByText("Awaiting acceptance")).toBeVisible();

  await page.getByRole("button", { name: "Pay again" }).click();
  await page.getByLabel("Cashu payment request").fill(request);
  await page.getByRole("button", { name: "Read request" }).click();
  await expect(page.getByText(/single-use request already has a payment operation/i)).toBeVisible();
});

test("a returned token with the wrong net amount is rejected before swap", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page);
  const mintUrl = "http://127.0.0.1:5174";
  const point = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
  const token = getEncodedToken({
    mint: mintUrl,
    unit: "rusd",
    proofs: [
      { amount: 256, id: keysetId, secret: "underpayment-one", C: point },
      { amount: 128, id: keysetId, secret: "underpayment-two", C: point },
    ],
  });
  let swapRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/swap") swapRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.locator(".desktop-nav").getByRole("button", { name: "Request" }).click();
  await page.getByRole("button", { name: "Create request" }).click();
  await page.getByLabel("Cashu token").fill(token);
  await page.getByRole("button", { name: "Secure payment" }).click();

  await expect(page.getByText("Payment not accepted")).toBeVisible();
  await expect(page.getByText(/open request requires 500/i)).toBeVisible();
  expect(swapRequests).toBe(0);
});

test("an already-spent returned token is terminal without attempting a swap", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page, 0, "SPENT");
  const mintUrl = "http://127.0.0.1:5174";
  const point = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
  const token = getEncodedToken({
    mint: mintUrl,
    unit: "rusd",
    proofs: [256, 128, 64, 32, 16, 4].map((amount, index) => ({
      amount,
      id: keysetId,
      secret: `spent-payment-${index}`,
      C: point,
    })),
  });
  let swapRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/swap") swapRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.locator(".desktop-nav").getByRole("button", { name: "Request" }).click();
  await page.getByRole("button", { name: "Create request" }).click();
  await page.getByLabel("Cashu token").fill(token);
  await page.getByRole("button", { name: "Secure payment" }).click();

  await expect(page.getByText("Payment not accepted")).toBeVisible();
  await expect(page.getByText(/bearer proofs were already spent/i)).toBeVisible();
  expect(swapRequests).toBe(0);
});

test("an incoming token with an unknown keyset fails before network mutation", async ({ page }) => {
  await mockCompatibleMint(page);
  const mintUrl = "http://127.0.0.1:5174";
  const mintPoint = `02${"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}`;
  const unknownKeysetId = deriveKeysetId({ "512": mintPoint }, { unit: "rusd" });
  const token = getEncodedToken({
    mint: mintUrl,
    unit: "rusd",
    proofs: [{ amount: 512, id: unknownKeysetId, secret: "unknown-keyset-payment", C: mintPoint }],
  });
  let stateRequests = 0;
  let swapRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/v1/checkstate") stateRequests += 1;
    if (path === "/v1/swap") swapRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.locator(".desktop-nav").getByRole("button", { name: "Request" }).click();
  await page.getByRole("button", { name: "Create request" }).click();
  await page.getByLabel("Cashu token").fill(token);
  await page.getByRole("button", { name: "Secure payment" }).click();

  await expect(page.getByText(/keyset ID.*known keysets/i)).toBeVisible();
  await expect(page.getByText("Payment not accepted")).toHaveCount(0);
  expect(stateRequests).toBe(0);
  expect(swapRequests).toBe(0);
});

test("incoming value reaches the balance only after fresh proofs are returned", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page);
  const mintUrl = "http://127.0.0.1:5174";
  const point = `02${"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}`;
  const amounts = [256, 128, 64, 32, 16, 4];
  const token = getEncodedToken({
    mint: mintUrl,
    unit: "rusd",
    proofs: amounts.map((amount, index) => ({
      amount,
      id: keysetId,
      secret: `settlement-proof-${index}`,
      C: point,
    })),
  });
  let swapRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/swap") swapRequests += 1;
  });

  await page.goto("/");
  await expect(page.getByText("Mint compatible")).toBeVisible();
  await page.locator(".desktop-nav").getByRole("button", { name: "Request" }).click();
  await page.getByRole("button", { name: "Create request" }).click();
  await page.getByLabel("Cashu token").fill(token);
  await page.getByRole("button", { name: "Secure payment" }).click();

  await expect(page.getByText("Payment settled")).toBeVisible();
  expect(swapRequests).toBe(1);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".balance-receipt__amount strong")).toHaveText("5.00");
});

test("primary navigation is keyboard operable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const requestButton = page.locator(".mobile-nav").getByRole("button", { name: "Request" });
  await requestButton.focus();
  await expect(requestButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Ask for a specific payment" })).toBeVisible();
});

test("camera denial leaves the paste fallback available", async ({ page }) => {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => { throw new DOMException("Camera denied for test", "NotAllowedError"); },
    });
  });
  await page.goto("/");
  await page.locator(".desktop-nav").getByRole("button", { name: "Pay" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();

  await expect(page.getByText("Camera unavailable")).toBeVisible();
  await expect(page.getByLabel("Cashu payment request")).toBeVisible();
});

test("persisted unresolved payment is recoverable without exposing its token", async ({ page }) => {
  await page.addInitScript(() => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        proofs: [],
        operations: [
          {
            id: "send-demo",
            kind: "send",
            state: "awaiting_acceptance",
            amount: 250,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            mintUrl,
            unit: "rusd",
            note: "Coffee at the meetup",
            token: "cashuBthis-is-sensitive-demo-data",
          },
        ],
      }),
    );
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.locator(".desktop-nav").getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: /Coffee at the meetup/i }).click();
  await expect(page.getByText("Bearer token", { exact: true })).toBeVisible();
  await expect(page.getByText("cashuBthis-is-sensitive-demo-data")).toHaveCount(0);
  await page.getByRole("button", { name: "Reveal" }).click();
  await expect(page.getByText("cashuBthis-is-sensitive-demo-data")).toBeVisible();
  await expect(page.getByRole("button", { name: /Reclaim if unspent/i })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test("an unclaimed incoming token requires confirmation before local removal", async ({ page }) => {
  await page.addInitScript(() => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        proofs: [],
        operations: [
          {
            id: "receive-recovery-demo",
            kind: "receive",
            state: "recoverable",
            amount: 250,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            mintUrl,
            unit: "rusd",
            note: "Meetup coffee",
            token: "cashuBsynthetic-incoming-bearer-token",
            error: "The mint is unavailable. The token remains stored.",
          },
        ],
      }),
    );
  });

  await page.goto("/");
  await page.locator(".desktop-nav").getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: /Meetup coffee/i }).click();
  await page.getByRole("button", { name: "Remove from this device" }).click();
  await expect(page.getByText("Remove this bearer token?")).toBeVisible();
  await expect(page.getByText(/may be permanently lost/i)).toBeVisible();
  await page.getByRole("button", { name: "Remove token" }).click();

  await expect(page.getByText(/bearer token was removed from this device/i)).toBeVisible();
  await expect(page.getByText("Bearer token", { exact: true })).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("fibernuts:wallet:v2:http://127.0.0.1:5174") ?? "{}"));
  expect(stored.operations[0].state).toBe("failed");
  expect(stored.operations[0].token).toBeUndefined();
});

test("stored value stays bound to its original unit when mint metadata changes", async ({ page }) => {
  const keysetId = await mockCompatibleMint(page);
  await page.addInitScript(({ activeKeysetId }) => {
    const mintUrl = "http://127.0.0.1:5174";
    localStorage.setItem(
      `fibernuts:wallet:v2:${mintUrl}`,
      JSON.stringify({
        version: 2,
        unit: "sat",
        proofs: [{ amount: 100, id: activeKeysetId, secret: "unit-bound-proof", C: `02${"55".repeat(32)}` }],
        operations: [],
      }),
    );
  }, { activeKeysetId: keysetId });

  await page.goto("/");
  await expect(page.getByText("This mint is not compatible")).toBeVisible();
  await expect(page.getByText(/stored wallet value is bound to SAT/i)).toBeVisible();
  await expect(page.locator(".balance-receipt__amount")).toContainText("SAT");
  await expect(page.getByRole("button", { name: "Cash out" })).toBeDisabled();
});
