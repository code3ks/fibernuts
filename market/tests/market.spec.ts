import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createBlindSignature, deriveKeysetId, getPubKeyFromPrivKey, pointFromHex } from "@cashu/cashu-ts";

const viewports = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
];

interface SharedServices {
  payload: Record<string, unknown> | null;
  orderId: string | null;
  vendorSettled: boolean;
  acknowledged: boolean;
  deliveryAttempts?: string[];
  dropNextDeliveryResponse?: boolean;
  mintQuoteAmount?: number;
  mintQuotePaid?: boolean;
}

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
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.body).toBeLessThanOrEqual(sizes.viewport + 1);
}

function cors(route: Route) {
  return {
    "Access-Control-Allow-Origin": route.request().headers().origin ?? "http://127.0.0.1:5175",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

async function mockServices(context: BrowserContext, shared: SharedServices) {
  const privateKeys = new Map<string, Uint8Array>();
  const keys = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const amount = String(2 ** index);
    const privateKey = new Uint8Array(32);
    privateKey[31] = index + 1;
    privateKeys.set(amount, privateKey);
    const publicKey = Array.from(getPubKeyFromPrivKey(privateKey), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [amount, publicKey];
  }));
  const keyset = { id: deriveKeysetId(keys, { unit: "rusd", input_fee_ppk: 0 }), unit: "rusd", keys };
  const mintKey = keys["1"];
  const signOutputs = (outputs: Array<{ amount: number | string; B_: string; id: string }> = []) => {
    return outputs.map((output) => {
      const privateKey = privateKeys.get(String(output.amount));
      if (!privateKey) throw new Error(`Synthetic mint has no key for denomination ${String(output.amount)}`);
      const signature = createBlindSignature(pointFromHex(output.B_), privateKey, output.id);
      return { id: output.id, amount: output.amount, C_: signature.C_.toHex(true) };
    });
  };
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.port === "8090") {
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(route) });
      if (path === "/v1/orders" && request.method() === "POST") {
        const body = request.postDataJSON() as { order_id: string };
        shared.orderId = body.order_id;
        return route.fulfill({ status: 201, headers: cors(route), json: { status: "open" } });
      }
      if (path.startsWith("/v1/deliver/") && request.method() === "POST") {
        shared.deliveryAttempts?.push(request.postData() ?? "");
        const next = request.postDataJSON() as Record<string, unknown>;
        if (shared.payload && JSON.stringify(shared.payload) !== JSON.stringify(next)) {
          return route.fulfill({ status: 409, headers: cors(route), json: { error: "payload_conflict" } });
        }
        shared.payload = next;
        if (shared.dropNextDeliveryResponse) {
          shared.dropNextDeliveryResponse = false;
          return route.abort("connectionreset");
        }
        return route.fulfill({ status: 202, headers: cors(route), json: { status: "stored" } });
      }
      if (path === "/v1/inbox" && request.method() === "GET") {
        return shared.payload
          ? route.fulfill({ status: 200, headers: cors(route), json: shared.payload })
          : route.fulfill({ status: 204, headers: cors(route) });
      }
      if (path === "/v1/inbox/ack" && request.method() === "POST") {
        shared.acknowledged = true;
        return route.fulfill({ status: 200, headers: cors(route), json: { status: "acknowledged" } });
      }
      if (path === "/v1/inbox/cancel" && request.method() === "POST") {
        return shared.payload
          ? route.fulfill({ status: 409, headers: cors(route), json: { error: "delivery_won" } })
          : route.fulfill({ status: 200, headers: cors(route), json: { status: "cancelled" } });
      }
      return route.fulfill({ status: 404, headers: cors(route), json: { error: "synthetic_not_found" } });
    }
    if (path === "/v1/info") {
      return route.fulfill({ json: {
        name: "CKB Community Test Mint",
        pubkey: mintKey,
        version: "synthetic/1.0",
        description: "Synthetic browser-test mint",
        contact: [],
        nuts: {
          "4": { methods: [{ method: "fiber", unit: "rusd", min_amount: 1, max_amount: 500000 }], disabled: false },
          "5": { methods: [{ method: "fiber", unit: "rusd", min_amount: 1, max_amount: 500000 }], disabled: false },
          "7": { supported: true },
          "9": { supported: true },
          "10": { supported: true },
          "11": { supported: true },
          "19": { ttl: null, cached_endpoints: [{ method: "POST", path: "/v1/swap" }, { method: "POST", path: "/v1/mint/fiber" }] },
        },
      } });
    }
    if (path === "/v1/keysets") return route.fulfill({ json: { keysets: [{ id: keyset.id, unit: "rusd", active: true, input_fee_ppk: 0 }] } });
    if (path === "/v1/keys" || path.startsWith("/v1/keys/")) return route.fulfill({ json: { keysets: [keyset] } });
    if (path === "/v1/checkstate" && request.method() === "POST") {
      const body = request.postDataJSON() as { Ys?: string[] };
      const state = shared.vendorSettled ? "SPENT" : "UNSPENT";
      return route.fulfill({ json: { states: (body.Ys ?? []).map((Y) => ({ Y, state, witness: null })) } });
    }
    if (path === "/v1/swap" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        inputs?: Array<{ witness?: string }>;
        outputs?: Array<{ amount: number | string; B_: string; id: string }>;
      };
      if (body.inputs?.some((input) => typeof input.witness === "string" && input.witness.length > 0)) shared.vendorSettled = true;
      return route.fulfill({ json: { signatures: signOutputs(body.outputs) } });
    }
    if (path === "/v1/mint/quote/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { amount?: number | string };
      shared.mintQuoteAmount = Number(body.amount);
      shared.mintQuotePaid = false;
      return route.fulfill({ json: {
        quote: "market-mint-quote",
        request: "fibt1synthetic-market-mint-invoice",
        state: "UNPAID",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        amount: shared.mintQuoteAmount,
        unit: "rusd",
      } });
    }
    if (path === "/v1/mint/quote/fiber/market-mint-quote" && request.method() === "GET") {
      const amount = shared.mintQuoteAmount ?? 1000;
      return route.fulfill({ json: {
        quote: "market-mint-quote",
        request: "fibt1synthetic-market-mint-invoice",
        state: shared.mintQuotePaid ? "PAID" : "UNPAID",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        amount,
        amount_paid: shared.mintQuotePaid ? amount : 0,
        unit: "rusd",
      } });
    }
    if (path === "/v1/mint/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { outputs?: Array<{ amount: number | string; B_: string; id: string }> };
      return route.fulfill({ json: { signatures: signOutputs(body.outputs) } });
    }
    if (path === "/v1/melt/quote/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { request?: string };
      return route.fulfill({ json: {
        quote: "market-melt-quote",
        request: body.request,
        state: "UNPAID",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        amount: 250,
        fee_reserve: 2,
        unit: "rusd",
      } });
    }
    if (path === "/v1/melt/fiber" && request.method() === "POST") {
      const body = request.postDataJSON() as { outputs?: Array<{ amount: number | string; B_: string; id: string }> };
      const [blank] = body.outputs ?? [];
      return route.fulfill({ json: {
        quote: "market-melt-quote",
        request: "fibt1external-market-invoice",
        state: "PAID",
        expiry: Math.floor(Date.now() / 1000) + 3600,
        amount: 250,
        fee_reserve: 2,
        payment_preimage: null,
        change: blank ? signOutputs([{ ...blank, amount: 4 }]) : [],
        unit: "rusd",
      } });
    }
    return route.fulfill({ status: 404, json: { detail: "Synthetic endpoint not implemented" } });
  });
  return keyset.id;
}

async function seedAttendee(page: Page, keysetId: string) {
  await page.addInitScript(({ activeKeysetId }) => {
    const mintUrl = "http://127.0.0.1:5175";
    const key = `fibernuts:market:v1:ckb-community-market:attendee:${mintUrl}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      eventId: "ckb-community-market",
      role: "attendee",
      mintUrl,
      unit: "rusd",
      proofs: [{ amount: 1024, id: activeKeysetId, secret: "synthetic-attendee-source-proof", C: `02${"33".repeat(32)}` }],
      addCash: [],
      payments: [],
      orders: [],
      cashOut: [],
    }));
  }, { activeKeysetId: keysetId });
}

test("publishes branded sharing metadata and icons", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("CKB Community Market | FiberNuts");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "FiberNuts Community Market");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://fibernuts.xyz/social-card.png");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg");
  const favicon = await page.request.get("/favicon.svg");
  expect(favicon.ok()).toBe(true);
});

for (const viewport of viewports) {
  test(`attendee event is stable at ${viewport.name} width`, async ({ page }, testInfo) => {
    const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
    const keysetId = await mockServices(page.context(), shared);
    await seedAttendee(page, keysetId);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "CKB Community Market" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan to pay" })).toBeEnabled();
    await expect(page.locator(".balance-receipt__amount strong")).toHaveText("10.24");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`event-${viewport.name}.png`), fullPage: true, animations: "disabled" });
  });
}

test("vendor and attendee complete one locked POST payment in isolated browser contexts", async ({ browser }, testInfo) => {
  const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
  const vendorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const attendeeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const keysetId = await mockServices(vendorContext, shared);
  await mockServices(attendeeContext, shared);
  const vendor = await vendorContext.newPage();
  const attendee = await attendeeContext.newPage();
  await seedAttendee(attendee, keysetId);

  await vendor.goto("/vendor");
  await expect(vendor.getByRole("heading", { name: "Block Cafe" })).toBeVisible();
  await vendor.getByRole("button", { name: "Add one Coffee" }).click();
  await vendor.getByRole("button", { name: "Review charge" }).click();
  await vendor.getByRole("button", { name: "Create charge" }).click();
  await expect(vendor.locator(".charge-ticket .status")).toHaveText("Ready to scan");
  await expect(vendor.locator(".qr-panel__code svg")).toBeVisible();

  const request = await vendor.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.includes(":vendor:"));
    const stored = key ? JSON.parse(localStorage.getItem(key) ?? "{}") : {};
    return stored.orders?.[0]?.request as string | undefined;
  });
  expect(request).toMatch(/^creq/i);

  await attendee.goto("/");
  await attendee.locator(".mobile-nav").getByRole("button", { name: "Pay" }).click();
  await attendee.getByLabel("Cashu payment request").fill(request ?? "");
  await attendee.getByRole("button", { name: "Review payment" }).click();
  await expect(attendee.getByRole("heading", { name: "Coffee" })).toBeVisible();
  await expect(attendee.getByText("Vendor-only payment")).toBeVisible();
  await attendee.getByRole("button", { name: "Pay 2.50 RUSD" }).click();
  await expect(attendee.getByText("Delivered", { exact: true })).toBeVisible();
  expect(shared.payload).not.toBeNull();

  const vendorCheck = vendor.getByRole("button", { name: "Check now" });
  if (await vendorCheck.isVisible()) await vendorCheck.click();
  await expect(vendor.getByRole("heading", { name: "Payment settled" })).toBeVisible();
  await expect(vendor.getByText("Fresh proofs stored")).toBeVisible();
  expect(shared.acknowledged).toBe(true);
  expect(shared.vendorSettled).toBe(true);

  const attendeeCheck = attendee.getByRole("button", { name: "Check proof state" });
  if (await attendeeCheck.isVisible()) await attendeeCheck.click();
  await expect(attendee.getByText("Vendor-key spend observed")).toBeVisible();
  await expect(vendor.locator("body")).not.toContainText("cashuB");
  await expect(attendee.locator("body")).not.toContainText("cashuB");
  await expectNoHorizontalOverflow(vendor);
  await expectNoHorizontalOverflow(attendee);
  await vendor.screenshot({ path: testInfo.outputPath("vendor-settled.png"), fullPage: true, animations: "disabled" });
  await attendee.screenshot({ path: testInfo.outputPath("attendee-spent.png"), fullPage: true, animations: "disabled" });

  await vendorContext.close();
  await attendeeContext.close();
});

test("a lost delivery response resumes the identical payload after reload", async ({ browser }) => {
  const shared: SharedServices = {
    payload: null,
    orderId: null,
    vendorSettled: false,
    acknowledged: false,
    deliveryAttempts: [],
    dropNextDeliveryResponse: true,
  };
  const vendorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const attendeeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const keysetId = await mockServices(vendorContext, shared);
  await mockServices(attendeeContext, shared);
  const vendor = await vendorContext.newPage();
  const attendee = await attendeeContext.newPage();
  await seedAttendee(attendee, keysetId);

  await vendor.goto("/vendor");
  await vendor.getByRole("button", { name: "Add one Coffee" }).click();
  await vendor.getByRole("button", { name: "Review charge" }).click();
  await vendor.getByRole("button", { name: "Create charge" }).click();
  await expect(vendor.locator(".charge-ticket .status")).toHaveText("Ready to scan");
  const request = await vendor.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.includes(":vendor:"));
    return key ? JSON.parse(localStorage.getItem(key) ?? "{}").orders?.[0]?.request as string | undefined : undefined;
  });

  await attendee.goto("/");
  await attendee.locator(".mobile-nav").getByRole("button", { name: "Pay" }).click();
  await attendee.getByLabel("Cashu payment request").fill(request ?? "");
  await attendee.getByRole("button", { name: "Review payment" }).click();
  await attendee.getByRole("button", { name: "Pay 2.50 RUSD" }).click();
  await expect(attendee.getByText("Action required")).toBeVisible();
  await expect(attendee.getByRole("button", { name: "Resume payment" })).toBeVisible();
  expect(shared.deliveryAttempts).toHaveLength(1);

  await attendee.reload();
  await attendee.locator(".mobile-nav").getByRole("button", { name: "Activity" }).click();
  await expect(attendee.getByRole("button", { name: "Resume same payment" })).toBeVisible();
  await attendee.getByRole("button", { name: "Resume same payment" }).click();
  await expect.poll(() => shared.deliveryAttempts?.length).toBe(2);
  expect(shared.deliveryAttempts?.[1]).toBe(shared.deliveryAttempts?.[0]);
  await expect(attendee.locator(".activity-entry .status")).toHaveText(/delivered|unspent/i);

  await vendorContext.close();
  await attendeeContext.close();
});

test("cash activity survives reload through issuance and cash-out", async ({ page }, testInfo) => {
  const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
  const keysetId = await mockServices(page.context(), shared);
  await seedAttendee(page, keysetId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator(".mobile-nav").getByRole("button", { name: "Cash" }).click();
  await page.locator(".cash-actions").getByRole("button", { name: /Add cash/ }).click();
  await page.getByRole("button", { name: "Create Fiber invoice" }).click();
  await expect(page.getByRole("heading", { name: "Pay from a Fiber wallet" })).toBeVisible();
  await expect(page.locator(".qr-panel__code svg")).toBeVisible();

  await page.reload();
  await page.locator(".mobile-nav").getByRole("button", { name: "Cash" }).click();
  const addActivity = page.locator(".cash-history").getByRole("button", { name: /Add cash/ });
  await expect(addActivity).toContainText("Awaiting Fiber payment");
  await addActivity.click();
  await expect(page.getByRole("heading", { name: "Pay from a Fiber wallet" })).toBeVisible();
  shared.mintQuotePaid = true;
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByRole("heading", { name: "Cash added" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".screen-heading h1")).toHaveText("20.24 RUSD ecash");

  await page.locator(".cash-actions").getByRole("button", { name: /Cash out/ }).click();
  await page.getByLabel("External Fiber invoice").fill("fibt1external-market-invoice");
  await page.getByRole("button", { name: "Review quote" }).click();
  await expect(page.getByText("Maximum debit", { exact: true })).toBeVisible();
  await expect(page.getByText("2.52 RUSD")).toBeVisible();
  await page.getByRole("button", { name: "Confirm cash-out" }).click();
  await expect(page.getByRole("heading", { name: "Invoice paid" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".cash-history").getByRole("button", { name: /Cash out/ })).toContainText("Paid");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("cash-cycle-mobile.png"), fullPage: true, animations: "disabled" });
});

test("vendor catalog and attendee navigation work from the keyboard", async ({ page }) => {
  const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
  await mockServices(page.context(), shared);
  await page.goto("/vendor");
  const addCoffee = page.getByRole("button", { name: "Add one Coffee" });
  await addCoffee.focus();
  await expect(addCoffee).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Coffee quantity")).toHaveText("1");
});

test("camera denial preserves the attendee paste path", async ({ page }) => {
  const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
  await mockServices(page.context(), shared);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException("Synthetic camera denial", "NotAllowedError"); } },
    });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.locator(".mobile-nav").getByRole("button", { name: "Pay" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByText("Camera unavailable")).toBeVisible();
  await expect(page.getByLabel("Cashu payment request")).toBeVisible();
});

test("offline mint state preserves local value and disables payment", async ({ page }) => {
  await page.context().route("**/v1/**", (route) => route.abort("connectionrefused"));
  await seedAttendee(page, `01${"ab".repeat(32)}`);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "CKB Community Market" })).toBeVisible();
  await expect(page.getByText("Your locally stored ecash was not changed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan to pay" })).toBeDisabled();
  await expect(page.locator(".balance-receipt__amount strong")).toHaveText("10.24");
});

test("corrupt stored state fails closed while leaving the event readable", async ({ page }) => {
  const shared: SharedServices = { payload: null, orderId: null, vendorSettled: false, acknowledged: false };
  await mockServices(page.context(), shared);
  await page.addInitScript(() => {
    const mintUrl = "http://127.0.0.1:5175";
    localStorage.setItem(`fibernuts:market:v1:ckb-community-market:attendee:${mintUrl}`, JSON.stringify({
      version: 1,
      eventId: "ckb-community-market",
      role: "attendee",
      mintUrl,
      unit: "rusd",
      proofs: [],
      addCash: [],
      payments: [{ id: "corrupt", state: "settled" }],
      orders: [],
      cashOut: [],
    }));
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "CKB Community Market" })).toBeVisible();
  await expect(page.getByText("Stored wallet data could not be read")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan to pay" })).toBeDisabled();
});
