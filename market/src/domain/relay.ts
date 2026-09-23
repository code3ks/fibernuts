import type { PaymentRequestPayload } from "@cashu/cashu-ts";

import type { EventManifest } from "../event/manifest";
import type { CreatedVendorRequest } from "./payment";

export class RelayError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "RelayError";
  }
}

async function responseError(response: Response, fallback: string): Promise<RelayError> {
  try {
    const body = await response.json() as { message?: string; error?: string };
    return new RelayError(body.message || fallback, response.status, body.error);
  } catch {
    return new RelayError(fallback, response.status);
  }
}

export async function registerDeliverySlot(
  manifest: EventManifest,
  request: CreatedVendorRequest,
  amount: number,
): Promise<void> {
  const response = await fetch(`${manifest.paymentTransport.relayOrigin}/v1/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_id: request.orderId,
      amount,
      unit: manifest.unit,
      mint: manifest.mintUrl,
      request_digest: request.requestDigest,
      expires_at: request.expiresAt,
      write_capability: request.writeCapability,
      read_capability: request.readCapability,
    }),
  });
  if (!response.ok) throw await responseError(response, "The payment request could not be registered.");
}

export async function deliverPayment(deliveryUrl: string, payloadJson: string): Promise<void> {
  const response = await fetch(deliveryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payloadJson,
  });
  if (response.status !== 202) throw await responseError(response, "The payment could not be delivered.");
}

export async function readPayment(relayOrigin: string, readCapability: string): Promise<PaymentRequestPayload | null> {
  const response = await fetch(`${relayOrigin}/v1/inbox`, {
    headers: { Authorization: `Bearer ${readCapability}` },
    cache: "no-store",
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await responseError(response, "The payment inbox could not be read.");
  return await response.json() as PaymentRequestPayload;
}

async function inboxAction(relayOrigin: string, readCapability: string, action: "ack" | "cancel"): Promise<void> {
  const response = await fetch(`${relayOrigin}/v1/inbox/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${readCapability}` },
  });
  if (!response.ok) throw await responseError(response, `The payment inbox could not ${action}.`);
}

export function acknowledgePayment(relayOrigin: string, readCapability: string): Promise<void> {
  return inboxAction(relayOrigin, readCapability, "ack");
}

export function cancelDeliverySlot(relayOrigin: string, readCapability: string): Promise<void> {
  return inboxAction(relayOrigin, readCapability, "cancel");
}
