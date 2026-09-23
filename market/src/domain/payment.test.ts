import { PaymentRequest, PaymentRequestTransportType } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { createPaymentRequest } from "@wallet-lib/payment-request";

import { EVENT } from "../event/manifest";
import { createVendorRequest, validateEventPaymentRequest } from "./payment";

describe("event payment requests", () => {
  it("creates a single-use request locked to a persisted vendor key", async () => {
    const created = await createVendorRequest(EVENT, EVENT.vendors[0], 250, "Block Cafe - Coffee", 1_800_000_000);
    const validated = validateEventPaymentRequest(created.request.encoded, EVENT, 1000, 1_800_000_001);

    expect(created.privateKey).toMatch(/^[a-f0-9]{64}$/);
    expect(created.publicKey).toMatch(/^(02|03)[a-f0-9]{64}$/);
    expect(created.readCapability).not.toBe(created.writeCapability);
    expect(validated.orderId).toBe(created.orderId);
    expect(validated.vendor.id).toBe("block-cafe");
    expect(validated.lockPublicKey).toBe(created.publicKey);
  });

  it("rejects an unapproved relay and a request without the exact lock", () => {
    const target = `https://evil.example/v1/deliver/${"w".repeat(43)}`;
    const unlocked = createPaymentRequest(250, "rusd", EVENT.mintUrl, "Coffee", {
      id: "order_1234567890abcdef",
      transport: [{
        type: PaymentRequestTransportType.POST,
        target,
        tags: [["event_id", EVENT.id], ["vendor_id", "block-cafe"], ["expires_at", "1800000300"]],
      }],
    });
    expect(() => validateEventPaymentRequest(unlocked.encoded, EVENT, 1000, 1_800_000_001)).toThrow(/unapproved/i);

    const relayedButUnlocked = createPaymentRequest(250, "rusd", EVENT.mintUrl, "Coffee", {
      id: "order_1234567890abcdef",
      transport: [{
        type: PaymentRequestTransportType.POST,
        target: `${EVENT.paymentTransport.relayOrigin}/v1/deliver/${"w".repeat(43)}`,
        tags: [["event_id", EVENT.id], ["vendor_id", "block-cafe"], ["expires_at", "1800000300"]],
      }],
    });
    expect(() => validateEventPaymentRequest(relayedButUnlocked.encoded, EVENT, 1000, 1_800_000_001)).toThrow(/vendor-only lock/i);
  });

  it("rejects requests that do not bind payment to the configured mint", () => {
    const created = createPaymentRequest(250, "rusd", EVENT.mintUrl, "Coffee", {
      id: "order_1234567890abcdef",
    });
    const request = PaymentRequest.fromEncodedRequest(created.encoded);
    const withoutMint = new PaymentRequest(
      request.transport,
      request.id,
      request.amount,
      request.unit,
      [],
      request.description,
      request.singleUse,
      request.nut10,
    ).toEncodedRequest();

    expect(() => validateEventPaymentRequest(withoutMint, EVENT, 1000, 1_800_000_001)).toThrow(/exactly one accepted mint/i);
  });
});
