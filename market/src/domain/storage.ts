import {
  OutputData,
  deserializeProofs,
  type Proof,
  type ProofLike,
  type SerializedOutputData,
} from "@cashu/cashu-ts";

import type {
  AddCashOperation,
  CashOutOperation,
  StoredMeltQuote,
  StoredSwapPreview,
} from "@wallet-domain/operations";
import { normalizeMintUrl } from "@wallet-lib/payment-request";
import { units } from "@wallet-lib/wallet";

import type { EventManifest } from "../event/manifest";
import type { AttendeePayment, MarketRole, MarketSnapshot, OrderItem, VendorOrder } from "./types";

export class MarketStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MarketStorageError";
  }
}

export function marketStorageKey(manifest: EventManifest, role: MarketRole): string {
  return `fibernuts:market:v1:${manifest.id}:${role}:${normalizeMintUrl(manifest.mintUrl)}`;
}

export function emptyMarketSnapshot(manifest: EventManifest, role: MarketRole): MarketSnapshot {
  return {
    version: 1,
    eventId: manifest.id,
    role,
    mintUrl: manifest.mintUrl,
    unit: manifest.unit,
    proofs: [],
    addCash: [],
    payments: [],
    orders: [],
    cashOut: [],
  };
}

type StoredRecord = Record<string, unknown>;

const ADD_STATES = new Set(["awaiting_payment", "payment_observed", "issuing", "settled", "expired", "recoverable", "failed"]);
const PAYMENT_STATES = new Set(["preparing", "ready_to_deliver", "delivering", "delivered", "unspent", "pending", "spent", "recoverable"]);
const ORDER_STATES = new Set(["registering", "awaiting_payment", "cancelling", "payload_received", "validating", "swapping", "settled", "cancelled", "expired", "rejected", "recoverable"]);
const CASH_OUT_STATES = new Set(["dispatching", "pending", "paid", "failed", "unknown"]);
const QUOTE_STATES = new Set(["UNPAID", "PENDING", "PAID"]);
const CAPABILITY = /^[A-Za-z0-9_-]{43,128}$/;
const PRIVATE_KEY = /^[a-f0-9]{64}$/;
const PUBLIC_KEY = /^(02|03)[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function malformed(label: string): MarketStorageError {
  return new MarketStorageError(`Stored ${label} is malformed.`);
}

function record(value: unknown, label: string): StoredRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw malformed(label);
  return value as StoredRecord;
}

function exactKeys(value: StoredRecord, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw malformed(label);
  }
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(label);
  return value;
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) throw malformed(label);
  return value;
}

function optionalText(value: unknown, label: string, pattern?: RegExp): string | undefined {
  return value === undefined ? undefined : text(value, label, pattern);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw malformed(label);
  return value as number;
}

function optionalInteger(value: unknown, label: string, minimum = 0): number | undefined {
  return value === undefined ? undefined : integer(value, label, minimum);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw malformed(label);
  return value;
}

function oneOf(value: unknown, accepted: Set<string>, label: string): string {
  if (typeof value !== "string" || !accepted.has(value)) throw malformed(label);
  return value;
}

function proofs(value: unknown, label: string): Proof[] {
  try {
    const normalized = deserializeProofs(list(value, label) as ProofLike[]);
    const secrets = new Set<string>();
    for (const proof of normalized) {
      const amount = units(proof.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw malformed(label);
      if (secrets.has(proof.secret)) throw malformed(label);
      secrets.add(proof.secret);
    }
    return normalized;
  } catch (reason) {
    if (reason instanceof MarketStorageError) throw reason;
    throw new MarketStorageError(`Stored ${label} contains invalid proofs.`, reason);
  }
}

function optionalProofs(value: unknown, label: string): Proof[] | undefined {
  return value === undefined ? undefined : proofs(value, label);
}

function outputData(value: unknown, label: string): SerializedOutputData[] {
  try {
    const values = list(value, label) as SerializedOutputData[];
    for (const item of values) OutputData.deserialize(item);
    return values;
  } catch (reason) {
    if (reason instanceof MarketStorageError) throw reason;
    throw new MarketStorageError(`Stored ${label} contains invalid recovery outputs.`, reason);
  }
}

function optionalOutputData(value: unknown, label: string): SerializedOutputData[] | undefined {
  return value === undefined ? undefined : outputData(value, label);
}

function swap(value: unknown, label: string): StoredSwapPreview {
  const raw = record(value, label);
  exactKeys(raw, ["amount", "fees", "keysetId", "inputs"], ["sendOutputs", "keepOutputs", "unselectedProofs"], label);
  const normalized: StoredSwapPreview = {
    amount: integer(raw.amount, `${label} amount`, 1),
    fees: integer(raw.fees, `${label} fees`),
    keysetId: text(raw.keysetId, `${label} keyset`),
    inputs: proofs(raw.inputs, `${label} inputs`),
    sendOutputs: optionalOutputData(raw.sendOutputs, `${label} send outputs`),
    keepOutputs: optionalOutputData(raw.keepOutputs, `${label} keep outputs`),
    unselectedProofs: optionalProofs(raw.unselectedProofs, `${label} unselected proofs`),
  };
  if (normalized.inputs.length === 0) throw malformed(`${label} inputs`);
  return normalized;
}

function optionalSwap(value: unknown, label: string): StoredSwapPreview | undefined {
  return value === undefined ? undefined : swap(value, label);
}

function assertBase(raw: StoredRecord, kind: string, manifest: EventManifest, label: string): void {
  if (raw.kind !== kind) throw malformed(label);
  text(raw.id, `${label} ID`);
  integer(raw.amount, `${label} amount`, 1);
  integer(raw.createdAt, `${label} creation time`);
  integer(raw.updatedAt, `${label} update time`);
  if (typeof raw.mintUrl !== "string" || normalizeMintUrl(raw.mintUrl) !== normalizeMintUrl(manifest.mintUrl)) {
    throw new MarketStorageError(`Stored ${label} belongs to another mint.`);
  }
  if (raw.unit !== manifest.unit) throw new MarketStorageError(`Stored ${label} belongs to another unit.`);
  optionalText(raw.note, `${label} note`);
  optionalText(raw.error, `${label} error`);
}

function normalizeAdd(value: unknown, manifest: EventManifest): AddCashOperation {
  const label = "add-cash operation";
  const raw = record(value, label);
  exactKeys(raw, ["id", "kind", "state", "amount", "createdAt", "updatedAt", "mintUrl", "unit", "quoteId", "invoice"], ["note", "error", "expiry", "outputData", "keysetId", "legacySignature", "payloadSignature"], label);
  assertBase(raw, "add", manifest, label);
  oneOf(raw.state, ADD_STATES, `${label} state`);
  text(raw.quoteId, `${label} quote`);
  text(raw.invoice, `${label} invoice`);
  return {
    ...(raw as unknown as AddCashOperation),
    expiry: optionalInteger(raw.expiry, `${label} expiry`, 1),
    outputData: optionalOutputData(raw.outputData, `${label} outputs`),
    keysetId: optionalText(raw.keysetId, `${label} keyset`),
    legacySignature: optionalText(raw.legacySignature, `${label} legacy signature`),
    payloadSignature: optionalText(raw.payloadSignature, `${label} payload signature`),
  };
}

function assertDeliveryUrl(value: string, manifest: EventManifest, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (reason) {
    throw new MarketStorageError(`Stored ${label} is malformed.`, reason);
  }
  if (
    url.origin !== manifest.paymentTransport.relayOrigin || url.username || url.password ||
    url.search || url.hash || !/^\/v1\/deliver\/[A-Za-z0-9_-]{43,128}$/.test(url.pathname)
  ) throw malformed(label);
}

function validatePayloadJson(value: string, payment: { orderId: string }, manifest: EventManifest): void {
  let payload: StoredRecord;
  try {
    payload = record(JSON.parse(value), "payment payload");
  } catch (reason) {
    if (reason instanceof MarketStorageError) throw reason;
    throw new MarketStorageError("Stored payment payload is malformed.", reason);
  }
  exactKeys(payload, ["id", "unit", "mint", "proofs"], ["memo"], "payment payload");
  if (
    payload.id !== payment.orderId || payload.unit !== manifest.unit || typeof payload.mint !== "string" ||
    normalizeMintUrl(payload.mint) !== normalizeMintUrl(manifest.mintUrl)
  ) throw new MarketStorageError("Stored payment payload belongs to another order, mint, or unit.");
  if (proofs(payload.proofs, "payment payload proofs").length === 0) throw malformed("payment payload proofs");
  optionalText(payload.memo, "payment payload memo");
}

function normalizePayment(value: unknown, manifest: EventManifest): AttendeePayment {
  const label = "attendee payment";
  const raw = record(value, label);
  exactKeys(raw, ["id", "kind", "orderId", "state", "amount", "fee", "unit", "mintUrl", "vendorName", "description", "createdAt", "updatedAt"], ["request", "deliveryUrl", "payloadJson", "token", "swap", "deliveryRetryable", "deliveredAt", "proofStateCheckedAt", "error"], label);
  assertBase(raw, "event_payment", manifest, label);
  const state = oneOf(raw.state, PAYMENT_STATES, `${label} state`) as AttendeePayment["state"];
  const payment: AttendeePayment = {
    ...(raw as unknown as AttendeePayment),
    state,
    orderId: text(raw.orderId, `${label} order ID`),
    fee: integer(raw.fee, `${label} fee`),
    vendorName: text(raw.vendorName, `${label} vendor`),
    description: text(raw.description, `${label} description`),
    request: optionalText(raw.request, `${label} request`, /^creq[ab]/i),
    deliveryUrl: optionalText(raw.deliveryUrl, `${label} delivery URL`),
    payloadJson: optionalText(raw.payloadJson, `${label} payload`),
    token: optionalText(raw.token, `${label} token`, /^cashu[AB]/i),
    swap: optionalSwap(raw.swap, `${label} swap`),
    deliveryRetryable: optionalBoolean(raw.deliveryRetryable, `${label} retry flag`),
    deliveredAt: optionalInteger(raw.deliveredAt, `${label} delivery time`, 1),
    proofStateCheckedAt: optionalInteger(raw.proofStateCheckedAt, `${label} proof-state time`),
  };
  if (payment.deliveryUrl) assertDeliveryUrl(payment.deliveryUrl, manifest, `${label} delivery URL`);
  if (payment.payloadJson) validatePayloadJson(payment.payloadJson, payment, manifest);
  const completeDelivery = Boolean(payment.token && payment.payloadJson && payment.deliveryUrl);
  if (state === "preparing" && !(payment.swap && payment.request && payment.deliveryUrl)) throw malformed(label);
  if (["ready_to_deliver", "delivering", "delivered", "unspent", "pending"].includes(state) && !completeDelivery) throw malformed(label);
  if (state === "recoverable" && !payment.swap && !completeDelivery) throw malformed(label);
  if (state === "spent" && (payment.token || payment.payloadJson || payment.swap || payment.request || payment.deliveryUrl)) throw malformed(label);
  if (payment.deliveryRetryable === false && state !== "recoverable") throw malformed(label);
  if (payment.deliveredAt && !completeDelivery && state !== "spent") throw malformed(label);
  return payment;
}

function normalizeItems(value: unknown, label: string): OrderItem[] {
  const items = list(value, label).map((item, index): OrderItem => {
    const raw = record(item, `${label} item ${index + 1}`);
    exactKeys(raw, ["itemId", "label", "quantity", "unitPrice"], [], `${label} item ${index + 1}`);
    return {
      itemId: text(raw.itemId, `${label} item ID`),
      label: text(raw.label, `${label} item label`),
      quantity: integer(raw.quantity, `${label} item quantity`, 1),
      unitPrice: integer(raw.unitPrice, `${label} item price`, 1),
    };
  });
  if (items.length === 0) throw malformed(label);
  return items;
}

function normalizeOrder(value: unknown, manifest: EventManifest): VendorOrder {
  const label = "vendor order";
  const raw = record(value, label);
  exactKeys(raw, ["id", "kind", "state", "eventId", "vendorId", "items", "amount", "unit", "mintUrl", "description", "expiresAt", "createdAt", "updatedAt"], ["request", "requestDigest", "deliveryUrl", "readCapability", "writeCapability", "privateKey", "publicKey", "incomingToken", "incomingSwap", "relayRegistered", "relayAcknowledged", "error"], label);
  assertBase(raw, "vendor_order", manifest, label);
  const state = oneOf(raw.state, ORDER_STATES, `${label} state`) as VendorOrder["state"];
  if (raw.eventId !== manifest.id || !manifest.vendors.some((vendor) => vendor.id === raw.vendorId)) {
    throw new MarketStorageError("Stored vendor order belongs to another event or vendor.");
  }
  const items = normalizeItems(raw.items, `${label} items`);
  const amount = integer(raw.amount, `${label} amount`, 1);
  let total = 0;
  for (const item of items) {
    const subtotal = item.quantity * item.unitPrice;
    total += subtotal;
    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total)) throw malformed(`${label} total`);
  }
  if (total !== amount) throw malformed(`${label} total`);
  const order: VendorOrder = {
    ...(raw as unknown as VendorOrder),
    state,
    items,
    amount,
    description: text(raw.description, `${label} description`),
    expiresAt: integer(raw.expiresAt, `${label} expiry`, 1),
    request: optionalText(raw.request, `${label} request`, /^creq[ab]/i),
    requestDigest: optionalText(raw.requestDigest, `${label} request digest`, DIGEST),
    deliveryUrl: optionalText(raw.deliveryUrl, `${label} delivery URL`),
    readCapability: optionalText(raw.readCapability, `${label} read capability`, CAPABILITY),
    writeCapability: optionalText(raw.writeCapability, `${label} write capability`, CAPABILITY),
    privateKey: optionalText(raw.privateKey, `${label} private key`, PRIVATE_KEY),
    publicKey: optionalText(raw.publicKey, `${label} public key`, PUBLIC_KEY),
    incomingToken: optionalText(raw.incomingToken, `${label} incoming token`, /^cashu[AB]/i),
    incomingSwap: optionalSwap(raw.incomingSwap, `${label} incoming swap`),
    relayRegistered: optionalBoolean(raw.relayRegistered, `${label} relay registration`),
    relayAcknowledged: optionalBoolean(raw.relayAcknowledged, `${label} relay acknowledgement`),
  };
  if (order.deliveryUrl) assertDeliveryUrl(order.deliveryUrl, manifest, `${label} delivery URL`);
  const registration = Boolean(order.request && order.requestDigest && order.deliveryUrl && order.readCapability && order.writeCapability && order.privateKey && order.publicKey);
  if (["registering", "awaiting_payment", "cancelling"].includes(state) && !registration) throw malformed(label);
  if (["payload_received", "validating"].includes(state) && !(order.incomingToken && order.privateKey && order.publicKey)) throw malformed(label);
  if (state === "swapping" && !(order.incomingSwap && order.privateKey && order.publicKey)) throw malformed(label);
  if (["settled", "cancelled", "expired"].includes(state) && (order.privateKey || order.incomingToken || order.incomingSwap || order.request || order.deliveryUrl || order.writeCapability)) throw malformed(label);
  return order;
}

function normalizeQuote(value: unknown, manifest: EventManifest): StoredMeltQuote {
  const label = "cash-out quote";
  const raw = record(value, label);
  exactKeys(raw, ["quote", "amount", "feeReserve", "unit", "state", "expiry", "request"], [], label);
  if (raw.unit !== manifest.unit) throw new MarketStorageError("Stored cash-out quote belongs to another unit.");
  return {
    quote: text(raw.quote, `${label} ID`),
    amount: integer(raw.amount, `${label} amount`, 1),
    feeReserve: integer(raw.feeReserve, `${label} fee reserve`),
    unit: manifest.unit,
    state: oneOf(raw.state, QUOTE_STATES, `${label} state`) as StoredMeltQuote["state"],
    expiry: integer(raw.expiry, `${label} expiry`, 1),
    request: text(raw.request, `${label} request`),
  };
}

function normalizeCashOut(value: unknown, manifest: EventManifest): CashOutOperation {
  const label = "cash-out operation";
  const raw = record(value, label);
  exactKeys(raw, ["id", "kind", "state", "amount", "createdAt", "updatedAt", "mintUrl", "unit", "invoice", "quote"], ["note", "error", "cashuFee", "reservedProofs", "outputData", "keysetId", "recoverySwap"], label);
  assertBase(raw, "cashout", manifest, label);
  const quote = normalizeQuote(raw.quote, manifest);
  const invoice = text(raw.invoice, `${label} invoice`);
  if (quote.request !== invoice || quote.amount !== raw.amount) throw malformed(label);
  return {
    ...(raw as unknown as CashOutOperation),
    state: oneOf(raw.state, CASH_OUT_STATES, `${label} state`) as CashOutOperation["state"],
    invoice,
    quote,
    cashuFee: optionalInteger(raw.cashuFee, `${label} proof fee`),
    reservedProofs: optionalProofs(raw.reservedProofs, `${label} reserved proofs`),
    outputData: optionalOutputData(raw.outputData, `${label} change outputs`),
    keysetId: optionalText(raw.keysetId, `${label} keyset`),
    recoverySwap: optionalSwap(raw.recoverySwap, `${label} recovery swap`),
  };
}

function uniqueIds(records: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of records) {
    if (ids.has(item.id)) throw new MarketStorageError(`Stored ${label} contains a duplicate identifier.`);
    ids.add(item.id);
  }
}

function assertSpendableProofsAreNotReserved(snapshot: MarketSnapshot): void {
  const spendable = new Set(snapshot.proofs.map((proof) => proof.secret));
  const reserved = [
    ...snapshot.payments.flatMap((payment) => payment.swap?.inputs ?? []),
    ...snapshot.cashOut.flatMap((operation) => operation.reservedProofs ?? []),
  ];
  if (reserved.some((proof) => spendable.has(proof.secret))) {
    throw new MarketStorageError("Stored spendable and reserved proof sets overlap.");
  }
}

function normalizeSnapshot(input: unknown, manifest: EventManifest, role: MarketRole): MarketSnapshot {
  const value = record(input, "market data");
  exactKeys(value, ["version", "eventId", "role", "mintUrl", "unit", "proofs", "addCash", "payments", "orders", "cashOut"], [], "market data");
  if (
    value.version !== 1 || value.eventId !== manifest.id || value.role !== role ||
    typeof value.mintUrl !== "string" || normalizeMintUrl(value.mintUrl) !== normalizeMintUrl(manifest.mintUrl) ||
    value.unit !== manifest.unit
  ) throw new MarketStorageError("Stored market value belongs to another event, role, mint, or unit.");
  const snapshot: MarketSnapshot = {
    version: 1,
    eventId: manifest.id,
    role,
    mintUrl: manifest.mintUrl,
    unit: manifest.unit,
    proofs: proofs(value.proofs, "spendable proofs"),
    addCash: list(value.addCash, "add-cash operations").map((item) => normalizeAdd(item, manifest)),
    payments: list(value.payments, "payments").map((item) => normalizePayment(item, manifest)),
    orders: list(value.orders, "orders").map((item) => normalizeOrder(item, manifest)),
    cashOut: list(value.cashOut, "cash-out operations").map((item) => normalizeCashOut(item, manifest)),
  };
  if (role === "attendee" && snapshot.orders.length > 0) throw new MarketStorageError("Stored attendee data contains vendor orders.");
  if (role === "vendor" && snapshot.payments.length > 0) throw new MarketStorageError("Stored vendor data contains attendee payments.");
  uniqueIds(snapshot.addCash, "add-cash operations");
  uniqueIds(snapshot.payments, "payments");
  uniqueIds(snapshot.orders, "orders");
  uniqueIds(snapshot.cashOut, "cash-out operations");
  assertSpendableProofsAreNotReserved(snapshot);
  return snapshot;
}

export function loadMarketSnapshot(
  manifest: EventManifest,
  role: MarketRole,
  storage: Storage = localStorage,
): MarketSnapshot {
  const encoded = storage.getItem(marketStorageKey(manifest, role));
  if (!encoded) return emptyMarketSnapshot(manifest, role);
  try {
    return normalizeSnapshot(JSON.parse(encoded), manifest, role);
  } catch (reason) {
    if (reason instanceof MarketStorageError) throw reason;
    throw new MarketStorageError("Stored market data could not be read. Value-moving actions are disabled.", reason);
  }
}

export function saveMarketSnapshot(
  manifest: EventManifest,
  snapshot: MarketSnapshot,
  storage: Storage = localStorage,
): void {
  let normalized: MarketSnapshot;
  try {
    normalized = normalizeSnapshot(snapshot, manifest, snapshot.role);
  } catch (reason) {
    if (reason instanceof MarketStorageError) throw reason;
    throw new MarketStorageError("Refusing to store malformed market data.", reason);
  }
  try {
    storage.setItem(marketStorageKey(manifest, normalized.role), JSON.stringify(normalized));
  } catch (reason) {
    throw new MarketStorageError("The operation could not be persisted. Stop and keep this tab open; do not repeat it.", reason);
  }
}
