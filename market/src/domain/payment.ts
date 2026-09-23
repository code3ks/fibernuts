import {
  PaymentRequestTransportType,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  type PaymentRequestPayload,
} from "@cashu/cashu-ts";

import {
  createPaymentRequest,
  decodePaymentRequest,
  normalizeMintUrl,
  paymentRequestLock,
  postTransport,
  validatePaymentRequest,
  type DecodedPaymentRequest,
} from "@wallet-lib/payment-request";
import type { FibernutsWallet } from "@wallet-lib/wallet";

import type { EventManifest, VendorManifest } from "../event/manifest";

const DELIVERY_PATH = /^\/v1\/deliver\/[A-Za-z0-9_-]{43,128}$/;

export interface CreatedVendorRequest {
  orderId: string;
  privateKey: string;
  publicKey: string;
  readCapability: string;
  writeCapability: string;
  deliveryUrl: string;
  expiresAt: number;
  request: DecodedPaymentRequest;
  requestDigest: string;
}

export interface ValidatedEventRequest {
  request: DecodedPaymentRequest;
  orderId: string;
  vendor: VendorManifest;
  expiresAt: number;
  deliveryUrl: string;
  lockPublicKey: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function tags(transportTags: string[][] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const tag of transportTags ?? []) {
    if (tag.length !== 2 || result.has(tag[0])) throw new Error("The payment request contains invalid transport tags.");
    result.set(tag[0], tag[1]);
  }
  return result;
}

export async function createVendorRequest(
  manifest: EventManifest,
  vendor: VendorManifest,
  amount: number,
  description: string,
  now = Math.floor(Date.now() / 1000),
): Promise<CreatedVendorRequest> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Order amount must be a positive integer.");
  const orderId = `order_${randomCapability().slice(0, 32)}`;
  const readCapability = randomCapability();
  const writeCapability = randomCapability();
  const privateBytes = createRandomSecretKey();
  const privateKey = bytesToHex(privateBytes);
  const publicKey = bytesToHex(getPubKeyFromPrivKey(privateBytes));
  const expiresAt = now + 300;
  const deliveryUrl = `${manifest.paymentTransport.relayOrigin}/v1/deliver/${writeCapability}`;
  const request = createPaymentRequest(amount, manifest.unit, manifest.mintUrl, description, {
    id: orderId,
    transport: [{
      type: PaymentRequestTransportType.POST,
      target: deliveryUrl,
      tags: [
        ["event_id", manifest.id],
        ["vendor_id", vendor.id],
        ["expires_at", String(expiresAt)],
      ],
    }],
    nut10: { kind: "P2PK", data: publicKey, tags: [] },
  });
  return {
    orderId,
    privateKey,
    publicKey,
    readCapability,
    writeCapability,
    deliveryUrl,
    expiresAt,
    request,
    requestDigest: await sha256(request.encoded),
  };
}

export function validateEventPaymentRequest(
  encoded: string,
  manifest: EventManifest,
  balance: number,
  now = Math.floor(Date.now() / 1000),
): ValidatedEventRequest {
  const request = decodePaymentRequest(encoded);
  validatePaymentRequest(request, manifest.mintUrl, manifest.unit, balance);
  if (request.mints.length !== 1 || request.mints[0] !== normalizeMintUrl(manifest.mintUrl)) {
    throw new Error("The event requires exactly one accepted mint.");
  }
  if (!request.singleUse || !request.id) throw new Error("The event requires a single-use order identifier.");
  if ((request.transport ?? []).length !== 1) throw new Error("The event requires exactly one payment transport.");
  const transport = postTransport(request);
  if (!transport) throw new Error("The event requires secure POST delivery.");
  const target = new URL(transport.target);
  if (
    target.origin !== manifest.paymentTransport.relayOrigin ||
    target.username || target.password || target.search || target.hash ||
    !DELIVERY_PATH.test(target.pathname)
  ) {
    throw new Error("The payment request points to an unapproved delivery service.");
  }
  const metadata = tags(transport.tags);
  if ([...metadata.keys()].some((key) => !["event_id", "vendor_id", "expires_at"].includes(key))) {
    throw new Error("The payment request contains unsupported transport metadata.");
  }
  if (metadata.get("event_id") !== manifest.id) throw new Error("This payment request belongs to another event.");
  const vendor = manifest.vendors.find((item) => item.id === metadata.get("vendor_id"));
  if (!vendor) throw new Error("This payment request names an unknown vendor.");
  const expiresAt = Number(metadata.get("expires_at"));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 600) {
    throw new Error("This payment request has expired or has an invalid lifetime.");
  }
  if (request.nut10?.kind !== "P2PK" || (request.nut10.tags?.length ?? 0) !== 0 || !request.nut10.data) {
    throw new Error("This payment request does not contain the required vendor-only lock.");
  }
  const lock = paymentRequestLock(request);
  if (!lock || lock.pubkey !== request.nut10.data || lock.locktime || lock.refundKeys?.length || lock.requiredSignatures) {
    throw new Error("This payment request contains unsupported lock conditions.");
  }
  return {
    request,
    orderId: request.id,
    vendor,
    expiresAt,
    deliveryUrl: transport.target,
    lockPublicKey: request.nut10.data,
  };
}

export function createPaymentPayload(
  wallet: Pick<FibernutsWallet, "inspectToken" | "mintUrl" | "unit">,
  token: string,
  request: DecodedPaymentRequest,
): PaymentRequestPayload {
  if (!request.id) throw new Error("The payment request has no order identifier.");
  const inspected = wallet.inspectToken(token);
  if (normalizeMintUrl(inspected.mint) !== normalizeMintUrl(wallet.mintUrl) || inspected.unit !== wallet.unit) {
    throw new Error("The prepared token does not match the active mint and unit.");
  }
  return {
    id: request.id,
    memo: request.description,
    unit: wallet.unit,
    mint: normalizeMintUrl(wallet.mintUrl),
    proofs: inspected.proofs,
  };
}
