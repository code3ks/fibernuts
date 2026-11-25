import type { Proof } from "@cashu/cashu-ts";

import type {
  AddCashOperation,
  CashOutOperation,
  StoredSwapPreview,
} from "@wallet-domain/operations";

export type MarketRole = "attendee" | "vendor";

export type PaymentState =
  | "preparing"
  | "ready_to_deliver"
  | "delivering"
  | "delivered"
  | "unspent"
  | "pending"
  | "refunding"
  | "refunded"
  | "spent"
  | "recoverable";

export interface AttendeePayment {
  id: string;
  kind: "event_payment";
  orderId: string;
  state: PaymentState;
  amount: number;
  fee: number;
  unit: "rusd";
  mintUrl: string;
  vendorName: string;
  description: string;
  request?: string;
  deliveryUrl?: string;
  payloadJson?: string;
  token?: string;
  swap?: StoredSwapPreview;
  refundPrivateKey?: string;
  refundPublicKey?: string;
  refundLocktime?: number;
  refundSwap?: StoredSwapPreview;
  deliveryRetryable?: boolean;
  deliveredAt?: number;
  proofStateCheckedAt?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export type OrderState =
  | "registering"
  | "awaiting_payment"
  | "cancelling"
  | "payload_received"
  | "validating"
  | "swapping"
  | "settled"
  | "cancelled"
  | "expired"
  | "rejected"
  | "recoverable";

export interface OrderItem {
  itemId: string;
  label: string;
  quantity: number;
  unitPrice: number;
}

export interface VendorOrder {
  id: string;
  kind: "vendor_order";
  state: OrderState;
  eventId: string;
  vendorId: string;
  items: OrderItem[];
  amount: number;
  unit: "rusd";
  mintUrl: string;
  description: string;
  expiresAt: number;
  request?: string;
  requestDigest?: string;
  deliveryUrl?: string;
  readCapability?: string;
  writeCapability?: string;
  privateKey?: string;
  publicKey?: string;
  incomingToken?: string;
  incomingSwap?: StoredSwapPreview;
  relayRegistered?: boolean;
  relayAcknowledged?: boolean;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface MarketSnapshot {
  version: 1;
  eventId: string;
  role: MarketRole;
  mintUrl: string;
  unit: "rusd";
  proofs: Proof[];
  addCash: AddCashOperation[];
  payments: AttendeePayment[];
  orders: VendorOrder[];
  cashOut: CashOutOperation[];
}

export type MarketActivity = AddCashOperation | AttendeePayment | VendorOrder | CashOutOperation;

export function paymentCanRetry(payment: AttendeePayment): boolean {
  if (!["preparing", "ready_to_deliver", "delivering", "recoverable"].includes(payment.state)) return false;
  if (payment.refundSwap) return false;
  if (payment.deliveredAt || payment.deliveryRetryable === false) return false;
  if (payment.swap) return Boolean(payment.request && payment.deliveryUrl);
  return Boolean(payment.token && payment.payloadJson && payment.deliveryUrl);
}

export function paymentCanCheck(payment: AttendeePayment): boolean {
  return Boolean(payment.token) && !payment.refundSwap && ["delivered", "unspent", "pending", "recoverable"].includes(payment.state);
}

export function paymentHasRefundPath(payment: AttendeePayment): boolean {
  return Boolean(
    payment.token && payment.refundPrivateKey && payment.refundPublicKey &&
    Number.isSafeInteger(payment.refundLocktime) && (payment.refundLocktime ?? 0) > 0,
  );
}

export function paymentCanRefund(payment: AttendeePayment, now = Date.now()): boolean {
  if (!paymentHasRefundPath(payment) || now < (payment.refundLocktime ?? 0) * 1000) return false;
  return ["delivered", "unspent", "pending", "recoverable", "refunding"].includes(payment.state);
}
