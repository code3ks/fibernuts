import type { PaymentRequestPayload, Proof } from "@cashu/cashu-ts";

import {
  createOperationId,
  type AddCashOperation,
  type CashOutOperation,
  type StoredMeltQuote,
  type StoredSwapPreview,
} from "@wallet-domain/operations";
import { normalizeMintUrl, paymentRequestLock } from "@wallet-lib/payment-request";
import {
  mintQuoteIsPaid,
  sumProofs,
  units,
  type LockedMintQuote,
  type MeltQuote,
  type MintProfile,
  type MintQuote,
  type PreparedMelt,
  type PreparedMint,
  type PreparedSend,
  type TokenSpendState,
} from "@wallet-lib/wallet";

import type { EventManifest, VendorManifest } from "../event/manifest";
import {
  createPaymentPayload,
  createVendorRequest,
  validateEventPaymentRequest,
  type CreatedVendorRequest,
  type ValidatedEventRequest,
} from "./payment";
import {
  RelayError,
  acknowledgePayment,
  cancelDeliverySlot,
  deliverPayment,
  readPayment,
  registerDeliverySlot,
} from "./relay";
import { safeErrorMessage } from "./errors";
import type { AttendeePayment, MarketSnapshot, OrderItem, VendorOrder } from "./types";

export interface MarketWallet {
  readonly mintUrl: string;
  readonly unit: string;
  readonly ticker: string;
  readonly profile: MintProfile;
  prepareSend(amount: number, proofs: Proof[], lock?: ReturnType<typeof paymentRequestLock>): Promise<PreparedSend>;
  completePreparedSend(swap: StoredSwapPreview): Promise<{ token: string; change: Proof[] }>;
  inspectToken(token: string): { amount: number; mint: string; unit: string; proofs: Proof[]; memo?: string };
  encodeProofs(proofs: Proof[]): string;
  tokenIsLockedTo(token: string, publicKey: string): boolean;
  prepareReceive(token: string, privateKey?: string): Promise<StoredSwapPreview>;
  completePreparedReceive(swap: StoredSwapPreview): Promise<Proof[]>;
  checkTokenState(token: string): Promise<TokenSpendState>;
  requestMint(amount: number): Promise<MintQuote>;
  requestLockedMint(amount: number): Promise<LockedMintQuote>;
  checkMintQuote(quote: string): Promise<MintQuote>;
  prepareMint(quote: MintQuote, quotePrivateKey?: string): Promise<PreparedMint>;
  completeMint(quote: MintQuote, prepared: PreparedMint): Promise<Proof[]>;
  requestMelt(invoice: string): Promise<MeltQuote>;
  checkMeltQuote(quote: string): Promise<MeltQuote>;
  prepareMelt(quote: MeltQuote, proofs: Proof[]): Promise<PreparedMelt>;
  executeMelt(quote: MeltQuote, prepared: Omit<PreparedMelt, "keep">): Promise<{
    state: "UNPAID" | "PENDING" | "PAID";
    change: Proof[];
    outputData: PreparedMelt["outputData"];
  }>;
  recoverMeltChange(outputData: PreparedMelt["outputData"], quote: MeltQuote): Proof[];
  checkProofsState(proofs: Proof[]): Promise<TokenSpendState>;
}

export interface RelayPort {
  register(manifest: EventManifest, request: CreatedVendorRequest, amount: number): Promise<void>;
  deliver(deliveryUrl: string, payloadJson: string): Promise<void>;
  read(relayOrigin: string, readCapability: string): Promise<PaymentRequestPayload | null>;
  acknowledge(relayOrigin: string, readCapability: string): Promise<void>;
  cancel(relayOrigin: string, readCapability: string): Promise<void>;
}

export const browserRelay: RelayPort = {
  register: registerDeliverySlot,
  deliver: deliverPayment,
  read: readPayment,
  acknowledge: acknowledgePayment,
  cancel: cancelDeliverySlot,
};

export interface PaymentReview {
  validated: ValidatedEventRequest;
  prepared: Extract<PreparedSend, { mode: "swap" }>;
  balance: number;
  debit: number;
  fee: number;
  proofFingerprint: string;
}

export interface CashOutReview {
  quote: MeltQuote;
  prepared: PreparedMelt;
  balance: number;
  maximumDebit: number;
  proofFingerprint: string;
}

interface RuntimeOptions {
  manifest: EventManifest;
  vendor: VendorManifest;
  wallet: MarketWallet;
  getSnapshot: () => MarketSnapshot;
  commit: (snapshot: MarketSnapshot) => void;
  relay?: RelayPort;
  notify?: (message: string) => void;
  now?: () => number;
}

function describe(reason: unknown): string {
  return safeErrorMessage(reason);
}

function deliveryCanRetry(reason: unknown): boolean {
  if (!(reason instanceof RelayError) || reason.status === undefined) return true;
  return reason.status === 408 || reason.status === 429 || reason.status >= 500;
}

function proofFingerprint(proofs: Proof[]): string {
  const identities = proofs.map((proof) => JSON.stringify(
    { ...proof, amount: units(proof.amount) },
    (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value,
  ));
  identities.sort((left, right) => left.localeCompare(right));
  return JSON.stringify(identities);
}

function replacePayment(payments: AttendeePayment[], next: AttendeePayment): AttendeePayment[] {
  return payments.some((payment) => payment.id === next.id)
    ? payments.map((payment) => payment.id === next.id ? next : payment)
    : [next, ...payments];
}

function replaceOrder(orders: VendorOrder[], next: VendorOrder): VendorOrder[] {
  return orders.some((order) => order.id === next.id)
    ? orders.map((order) => order.id === next.id ? next : order)
    : [next, ...orders];
}

function replaceAdd(operations: AddCashOperation[], next: AddCashOperation): AddCashOperation[] {
  return operations.some((operation) => operation.id === next.id)
    ? operations.map((operation) => operation.id === next.id ? next : operation)
    : [next, ...operations];
}

function replaceCashOut(operations: CashOutOperation[], next: CashOutOperation): CashOutOperation[] {
  return operations.some((operation) => operation.id === next.id)
    ? operations.map((operation) => operation.id === next.id ? next : operation)
    : [next, ...operations];
}

function asMintQuote(operation: AddCashOperation, checked?: MintQuote): MintQuote {
  return {
    ...checked,
    quote: operation.quoteId,
    request: operation.invoice,
    amount: operation.amount,
    unit: operation.unit,
    ...(operation.quotePubkey ? { pubkey: operation.quotePubkey } : {}),
  } as unknown as MintQuote;
}

function storeMeltQuote(quote: MeltQuote): StoredMeltQuote {
  return {
    quote: quote.quote,
    amount: units(quote.amount),
    feeReserve: units(quote.fee_reserve),
    unit: quote.unit,
    state: quote.state,
    expiry: quote.expiry ?? Math.floor(Date.now() / 1000) + 3600,
    request: quote.request,
  };
}

function asMeltQuote(stored: StoredMeltQuote, checked?: MeltQuote): MeltQuote {
  return {
    ...checked,
    quote: stored.quote,
    amount: stored.amount,
    fee_reserve: stored.feeReserve,
    unit: stored.unit,
    state: checked?.state ?? stored.state,
    expiry: checked?.expiry ?? stored.expiry,
    request: stored.request,
  } as unknown as MeltQuote;
}

function orderDescription(items: OrderItem[]): string {
  return items.map((item) => item.quantity === 1 ? item.label : `${item.quantity}x ${item.label}`).join(", ").slice(0, 280);
}

function paymentPayload(value: PaymentRequestPayload): asserts value is PaymentRequestPayload & {
  id: string;
  mint: string;
  unit: string;
  proofs: Proof[];
} {
  if (
    !value || typeof value.id !== "string" || typeof value.mint !== "string" ||
    typeof value.unit !== "string" || !Array.isArray(value.proofs) || value.proofs.length === 0
  ) throw new Error("The delivery service returned a malformed payment payload.");
}

export class MarketRuntime {
  private readonly manifest: EventManifest;
  private readonly vendor: VendorManifest;
  private readonly wallet: MarketWallet;
  private readonly getSnapshot: () => MarketSnapshot;
  private readonly commitSnapshot: (snapshot: MarketSnapshot) => void;
  private readonly relay: RelayPort;
  private readonly notify: (message: string) => void;
  private readonly now: () => number;

  constructor(options: RuntimeOptions) {
    this.manifest = options.manifest;
    this.vendor = options.vendor;
    this.wallet = options.wallet;
    this.getSnapshot = options.getSnapshot;
    this.commitSnapshot = options.commit;
    this.relay = options.relay ?? browserRelay;
    this.notify = options.notify ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  private assertRole(role: MarketSnapshot["role"]): void {
    if (this.getSnapshot().role !== role) throw new Error(`This action requires the ${role} application.`);
  }

  private commitPayment(payment: AttendeePayment, proofs?: Proof[]): AttendeePayment {
    const current = this.getSnapshot();
    this.commitSnapshot({
      ...current,
      proofs: proofs ?? current.proofs,
      payments: replacePayment(current.payments, payment),
    });
    return payment;
  }

  private commitOrder(order: VendorOrder, proofs?: Proof[]): VendorOrder {
    const current = this.getSnapshot();
    this.commitSnapshot({
      ...current,
      proofs: proofs ?? current.proofs,
      orders: replaceOrder(current.orders, order),
    });
    return order;
  }

  private commitAdd(operation: AddCashOperation, proofs?: Proof[]): AddCashOperation {
    const current = this.getSnapshot();
    this.commitSnapshot({
      ...current,
      proofs: proofs ?? current.proofs,
      addCash: replaceAdd(current.addCash, operation),
    });
    return operation;
  }

  private commitCashOut(operation: CashOutOperation, proofs?: Proof[]): CashOutOperation {
    const current = this.getSnapshot();
    this.commitSnapshot({
      ...current,
      proofs: proofs ?? current.proofs,
      cashOut: replaceCashOut(current.cashOut, operation),
    });
    return operation;
  }

  async reviewPayment(encoded: string): Promise<PaymentReview> {
    this.assertRole("attendee");
    const current = this.getSnapshot();
    const balance = sumProofs(current.proofs);
    const validated = validateEventPaymentRequest(encoded, this.manifest, balance);
    const existing = current.payments.find((payment) => payment.orderId === validated.orderId);
    if (existing) throw new Error("This single-use order already has a payment. Open Activity to inspect it.");
    const lock = paymentRequestLock(validated.request);
    if (!lock) throw new Error("The vendor-only payment lock is unavailable.");
    const prepared = await this.wallet.prepareSend(validated.request.amount, current.proofs, lock);
    if (prepared.mode !== "swap") throw new Error("Locked market payments must use a prepared swap.");
    return {
      validated,
      prepared,
      balance,
      debit: prepared.debit,
      fee: prepared.fee,
      proofFingerprint: proofFingerprint(current.proofs),
    };
  }

  async confirmPayment(review: PaymentReview): Promise<AttendeePayment> {
    this.assertRole("attendee");
    const current = this.getSnapshot();
    if (current.payments.some((payment) => payment.orderId === review.validated.orderId)) {
      throw new Error("This single-use order already has a payment. Open Activity to inspect it.");
    }
    if (proofFingerprint(current.proofs) !== review.proofFingerprint) {
      throw new Error("The ecash balance changed. Review the recalculated debit before paying.");
    }
    validateEventPaymentRequest(review.validated.request.encoded, this.manifest, sumProofs(current.proofs));
    const timestamp = this.now();
    let payment: AttendeePayment = {
      id: createOperationId(),
      kind: "event_payment",
      orderId: review.validated.orderId,
      state: "preparing",
      amount: review.validated.request.amount,
      fee: review.fee,
      unit: "rusd",
      mintUrl: this.manifest.mintUrl,
      vendorName: review.validated.vendor.name,
      description: review.validated.request.description,
      request: review.validated.request.encoded,
      deliveryUrl: review.validated.deliveryUrl,
      swap: review.prepared.swap,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.commitPayment(payment, review.prepared.swap.unselectedProofs ?? []);
    try {
      payment = await this.finishPaymentPreparation(payment);
    } catch (reason) {
      return this.commitPayment({
        ...payment,
        state: "recoverable",
        updatedAt: this.now(),
        error: `Payment preparation is stored for retry. ${describe(reason)}`,
      });
    }
    return this.deliverStoredPayment(payment);
  }

  private async finishPaymentPreparation(payment: AttendeePayment): Promise<AttendeePayment> {
    if (!payment.swap || !payment.request || !payment.deliveryUrl) {
      throw new Error("Stored payment preparation data is incomplete.");
    }
    const request = validateEventPaymentRequest(payment.request, this.manifest, Number.MAX_SAFE_INTEGER);
    const result = await this.wallet.completePreparedSend(payment.swap);
    const payloadJson = JSON.stringify(createPaymentPayload(this.wallet, result.token, request.request));
    const ready: AttendeePayment = {
      ...payment,
      state: "ready_to_deliver",
      token: result.token,
      payloadJson,
      swap: undefined,
      updatedAt: this.now(),
      error: undefined,
    };
    return this.commitPayment(ready, [...this.getSnapshot().proofs, ...result.change]);
  }

  async deliverStoredPayment(input: AttendeePayment): Promise<AttendeePayment> {
    this.assertRole("attendee");
    let payment = this.getSnapshot().payments.find((item) => item.id === input.id) ?? input;
    if (payment.swap && !payment.token) payment = await this.finishPaymentPreparation(payment);
    if (!payment.deliveryUrl || !payment.payloadJson || !payment.token) {
      throw new Error("The stored delivery payload is incomplete.");
    }
    const deliveryUrl = payment.deliveryUrl;
    const payloadJson = payment.payloadJson;
    payment = this.commitPayment({
      ...payment,
      state: "delivering",
      deliveryRetryable: true,
      updatedAt: this.now(),
      error: undefined,
    });
    try {
      await this.relay.deliver(deliveryUrl, payloadJson);
      payment = this.commitPayment({
        ...payment,
        state: "delivered",
        deliveryRetryable: undefined,
        deliveredAt: this.now(),
        updatedAt: this.now(),
        error: undefined,
      });
      this.notify("Payment delivered to the vendor");
      return payment;
    } catch (reason) {
      const retryable = deliveryCanRetry(reason);
      return this.commitPayment({
        ...payment,
        state: "recoverable",
        deliveryRetryable: retryable,
        updatedAt: this.now(),
        error: retryable
          ? `The same stored payment can be retried. ${describe(reason)}`
          : `Delivery was rejected and will not be retried automatically. ${describe(reason)}`,
      });
    }
  }

  async checkPayment(input: AttendeePayment): Promise<AttendeePayment> {
    this.assertRole("attendee");
    const payment = this.getSnapshot().payments.find((item) => item.id === input.id) ?? input;
    if (!payment.token) return payment;
    try {
      const state = await this.wallet.checkTokenState(payment.token);
      if (state === "spent") {
        return this.commitPayment({
          ...payment,
          state: "spent",
          token: undefined,
          payloadJson: undefined,
          request: undefined,
          deliveryUrl: undefined,
          deliveryRetryable: undefined,
          proofStateCheckedAt: this.now(),
          updatedAt: this.now(),
          error: undefined,
        });
      }
      if (state === "unspent") {
        if (payment.deliveryRetryable === false && !payment.deliveredAt) {
          return this.commitPayment({ ...payment, proofStateCheckedAt: this.now(), updatedAt: this.now() });
        }
        return this.commitPayment({ ...payment, state: "unspent", proofStateCheckedAt: this.now(), updatedAt: this.now(), error: undefined });
      }
      if (state === "pending") {
        if (payment.deliveryRetryable === false && !payment.deliveredAt) {
          return this.commitPayment({ ...payment, proofStateCheckedAt: this.now(), updatedAt: this.now() });
        }
        return this.commitPayment({
          ...payment,
          state: "pending",
          proofStateCheckedAt: this.now(),
          updatedAt: this.now(),
          error: "The mint reports that the payment proofs are pending. No final state is known yet.",
        });
      }
      return this.commitPayment({
        ...payment,
        state: "recoverable",
        proofStateCheckedAt: this.now(),
        updatedAt: this.now(),
        error: "The payment proofs have mixed states. Keep this record and check again.",
      });
    } catch (reason) {
      return this.commitPayment({
        ...payment,
        state: "recoverable",
        updatedAt: this.now(),
        error: `Proof state is unavailable. ${describe(reason)}`,
      });
    }
  }

  async createOrder(items: OrderItem[]): Promise<VendorOrder> {
    this.assertRole("vendor");
    if (items.length === 0) throw new Error("Add at least one item before charging.");
    const amount = items.reduce((total, item) => total + item.unitPrice * item.quantity, 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("The order total is invalid.");
    for (const item of items) {
      if (!Number.isSafeInteger(item.unitPrice) || item.unitPrice <= 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("The order contains an invalid item quantity or price.");
      }
    }
    const description = orderDescription(items);
    const request = await createVendorRequest(this.manifest, this.vendor, amount, description, Math.floor(this.now() / 1000));
    const timestamp = this.now();
    let order: VendorOrder = {
      id: request.orderId,
      kind: "vendor_order",
      state: "registering",
      eventId: this.manifest.id,
      vendorId: this.vendor.id,
      items,
      amount,
      unit: "rusd",
      mintUrl: this.manifest.mintUrl,
      description,
      expiresAt: request.expiresAt,
      request: request.request.encoded,
      requestDigest: request.requestDigest,
      deliveryUrl: request.deliveryUrl,
      readCapability: request.readCapability,
      writeCapability: request.writeCapability,
      privateKey: request.privateKey,
      publicKey: request.publicKey,
      relayRegistered: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.commitOrder(order);
    try {
      await this.relay.register(this.manifest, request, amount);
      order = this.commitOrder({ ...order, state: "awaiting_payment", relayRegistered: true, updatedAt: this.now(), error: undefined });
      return order;
    } catch (reason) {
      return this.commitOrder({
        ...order,
        state: "recoverable",
        updatedAt: this.now(),
        error: `The charge is stored but not ready to scan. ${describe(reason)}`,
      });
    }
  }

  private storedRequest(order: VendorOrder): CreatedVendorRequest {
    if (
      !order.request || !order.requestDigest || !order.deliveryUrl || !order.readCapability ||
      !order.writeCapability || !order.privateKey || !order.publicKey
    ) throw new Error("Stored order registration data is incomplete.");
    return {
      orderId: order.id,
      privateKey: order.privateKey,
      publicKey: order.publicKey,
      readCapability: order.readCapability,
      writeCapability: order.writeCapability,
      deliveryUrl: order.deliveryUrl,
      expiresAt: order.expiresAt,
      request: validateEventPaymentRequest(order.request, this.manifest, Number.MAX_SAFE_INTEGER).request,
      requestDigest: order.requestDigest,
    };
  }

  async registerStoredOrder(input: VendorOrder): Promise<VendorOrder> {
    this.assertRole("vendor");
    const order = this.getSnapshot().orders.find((item) => item.id === input.id) ?? input;
    try {
      await this.relay.register(this.manifest, this.storedRequest(order), order.amount);
      return this.commitOrder({ ...order, state: "awaiting_payment", relayRegistered: true, updatedAt: this.now(), error: undefined });
    } catch (reason) {
      return this.commitOrder({ ...order, state: "recoverable", updatedAt: this.now(), error: describe(reason) });
    }
  }

  async pollOrder(input: VendorOrder): Promise<VendorOrder> {
    this.assertRole("vendor");
    let order = this.getSnapshot().orders.find((item) => item.id === input.id) ?? input;
    if (order.state === "settled" && !order.relayAcknowledged && order.readCapability) {
      return this.acknowledgeSettledOrder(order);
    }
    if (order.incomingToken || order.incomingSwap) return this.settleOrder(order);
    if (!order.readCapability) throw new Error("The stored order has no private inbox capability.");
    const readCapability = order.readCapability;
    try {
      const payload = await this.relay.read(this.manifest.paymentTransport.relayOrigin, readCapability);
      if (!payload) {
        if (order.expiresAt * 1000 <= this.now()) {
          return this.expireOrder(order);
        }
        return order;
      }
      paymentPayload(payload);
      if (payload.id !== order.id) {
        return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered payment belongs to another order." });
      }
      if (payload.unit.toLowerCase() !== "rusd" || normalizeMintUrl(payload.mint) !== normalizeMintUrl(this.manifest.mintUrl)) {
        return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered payment has the wrong mint or unit." });
      }
      const token = this.wallet.encodeProofs(payload.proofs);
      order = this.commitOrder({
        ...order,
        state: "payload_received",
        incomingToken: token,
        updatedAt: this.now(),
        error: undefined,
      });
      try {
        await this.relay.acknowledge(this.manifest.paymentTransport.relayOrigin, readCapability);
        order = this.commitOrder({ ...order, relayAcknowledged: true, updatedAt: this.now() });
      } catch (reason) {
        order = this.commitOrder({
          ...order,
          relayAcknowledged: false,
          updatedAt: this.now(),
          error: `Payment is stored locally; relay acknowledgement will be retried. ${describe(reason)}`,
        });
      }
      return this.settleOrder(order);
    } catch (reason) {
      if (reason instanceof RelayError && [404, 410].includes(reason.status ?? 0) && order.expiresAt * 1000 <= this.now()) {
        return this.expireOrder(order);
      }
      return this.commitOrder({ ...order, state: "recoverable", updatedAt: this.now(), error: describe(reason) });
    }
  }

  async settleOrder(input: VendorOrder): Promise<VendorOrder> {
    this.assertRole("vendor");
    let order = this.getSnapshot().orders.find((item) => item.id === input.id) ?? input;
    try {
      if (!order.incomingSwap) {
        if (!order.incomingToken || !order.privateKey || !order.publicKey) {
          throw new Error("Stored vendor settlement data is incomplete.");
        }
        const incomingToken = order.incomingToken;
        const privateKey = order.privateKey;
        const publicKey = order.publicKey;
        order = this.commitOrder({ ...order, state: "validating", updatedAt: this.now(), error: undefined });
        let inspected: ReturnType<MarketWallet["inspectToken"]>;
        try {
          inspected = this.wallet.inspectToken(incomingToken);
        } catch {
          return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered token is malformed." });
        }
        if (
          normalizeMintUrl(inspected.mint) !== normalizeMintUrl(this.manifest.mintUrl) ||
          inspected.unit.toLowerCase() !== "rusd" || inspected.amount !== order.amount
        ) return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered token does not match the order amount, mint, and unit exactly." });
        if (!this.wallet.tokenIsLockedTo(incomingToken, publicKey)) {
          return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered proofs are not locked exclusively to this vendor key." });
        }
        const state = await this.wallet.checkTokenState(incomingToken);
        if (state === "spent") {
          return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered proofs were already spent." });
        }
        if (state === "mixed") {
          return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The delivered proofs have conflicting states." });
        }
        if (state === "pending") {
          return this.commitOrder({ ...order, state: "recoverable", updatedAt: this.now(), error: "The mint reports that the delivered proofs are pending." });
        }
        const swap = await this.wallet.prepareReceive(incomingToken, privateKey);
        if (swap.amount !== order.amount) {
          return this.commitOrder({ ...order, state: "rejected", updatedAt: this.now(), error: "The prepared settlement amount does not equal the order total." });
        }
        order = this.commitOrder({ ...order, state: "swapping", incomingSwap: swap, updatedAt: this.now(), error: undefined });
      }
      if (!order.incomingSwap) throw new Error("Prepared settlement recovery data is unavailable.");
      const proofs = await this.wallet.completePreparedReceive(order.incomingSwap);
      const settled = this.commitOrder({
        ...order,
        state: "settled",
        request: undefined,
        requestDigest: undefined,
        deliveryUrl: undefined,
        writeCapability: undefined,
        readCapability: order.relayAcknowledged ? undefined : order.readCapability,
        privateKey: undefined,
        incomingToken: undefined,
        incomingSwap: undefined,
        updatedAt: this.now(),
        error: undefined,
      }, [...this.getSnapshot().proofs, ...proofs]);
      this.notify(`${this.wallet.ticker} payment settled with fresh proofs`);
      return settled;
    } catch (reason) {
      return this.commitOrder({ ...order, state: "recoverable", updatedAt: this.now(), error: describe(reason) });
    }
  }

  private async acknowledgeSettledOrder(order: VendorOrder): Promise<VendorOrder> {
    if (!order.readCapability) return order;
    try {
      await this.relay.acknowledge(this.manifest.paymentTransport.relayOrigin, order.readCapability);
      return this.commitOrder({ ...order, relayAcknowledged: true, readCapability: undefined, updatedAt: this.now(), error: undefined });
    } catch (reason) {
      return this.commitOrder({ ...order, updatedAt: this.now(), error: `Relay cleanup is pending. ${describe(reason)}` });
    }
  }

  private expireOrder(order: VendorOrder): VendorOrder {
    return this.commitOrder({
      ...order,
      state: "expired",
      request: undefined,
      requestDigest: undefined,
      deliveryUrl: undefined,
      readCapability: undefined,
      writeCapability: undefined,
      privateKey: undefined,
      updatedAt: this.now(),
      error: undefined,
    });
  }

  async cancelOrder(input: VendorOrder): Promise<VendorOrder> {
    this.assertRole("vendor");
    let order = this.getSnapshot().orders.find((item) => item.id === input.id) ?? input;
    if (!order.readCapability) throw new Error("The stored order cannot be cancelled.");
    const readCapability = order.readCapability;
    order = this.commitOrder({ ...order, state: "cancelling", updatedAt: this.now(), error: undefined });
    try {
      await this.relay.cancel(this.manifest.paymentTransport.relayOrigin, readCapability);
      return this.commitOrder({
        ...order,
        state: "cancelled",
        request: undefined,
        requestDigest: undefined,
        deliveryUrl: undefined,
        readCapability: undefined,
        writeCapability: undefined,
        privateKey: undefined,
        updatedAt: this.now(),
      });
    } catch (reason) {
      if (reason instanceof RelayError && reason.status === 409) return this.pollOrder(order);
      return this.commitOrder({ ...order, state: "recoverable", updatedAt: this.now(), error: describe(reason) });
    }
  }

  async requestAddCash(amount: number): Promise<AddCashOperation> {
    const quote = await this.wallet.requestMint(amount);
    const timestamp = this.now();
    return this.commitAdd({
      id: createOperationId(),
      kind: "add",
      state: "awaiting_payment",
      amount,
      createdAt: timestamp,
      updatedAt: timestamp,
      mintUrl: this.manifest.mintUrl,
      unit: "rusd",
      quoteId: quote.quote,
      invoice: quote.request,
      expiry: quote.expiry ?? undefined,
    });
  }

  async requestTestCash(amount: number): Promise<AddCashOperation> {
    const locked = await this.wallet.requestLockedMint(amount);
    const timestamp = this.now();
    return this.commitAdd({
      id: createOperationId(),
      kind: "add",
      state: "awaiting_payment",
      amount,
      createdAt: timestamp,
      updatedAt: timestamp,
      mintUrl: this.manifest.mintUrl,
      unit: "rusd",
      quoteId: locked.quote.quote,
      invoice: locked.quote.request,
      expiry: locked.quote.expiry ?? undefined,
      fundingSource: "faucet",
      quotePubkey: locked.publicKey,
      quotePrivateKey: locked.privateKey,
    });
  }

  recordTestCashPayerFailure(input: AddCashOperation, message: string): AddCashOperation {
    const operation = this.getSnapshot().addCash.find((item) => item.id === input.id) ?? input;
    if (operation.fundingSource !== "faucet") throw new Error("This is not a community testnet claim.");
    return this.commitAdd({
      ...operation,
      state: "recoverable",
      updatedAt: this.now(),
      error: message,
    });
  }

  async refreshAddCash(input: AddCashOperation): Promise<AddCashOperation> {
    let operation = this.getSnapshot().addCash.find((item) => item.id === input.id) ?? input;
    try {
      const checked = await this.wallet.checkMintQuote(operation.quoteId);
      if (operation.quotePubkey) {
        if (!checked.pubkey || checked.pubkey.toLowerCase() !== operation.quotePubkey.toLowerCase()) {
          throw new Error("The mint did not return the expected browser lock for this quote.");
        }
      }
      if (!mintQuoteIsPaid(checked)) {
        if (operation.expiry && operation.expiry * 1000 <= this.now()) {
          return this.commitAdd({ ...operation, state: "expired", updatedAt: this.now(), error: "The Fiber invoice expired before payment was observed." });
        }
        return operation;
      }
      operation = this.commitAdd({ ...operation, state: "payment_observed", updatedAt: this.now(), error: undefined });
      if (!operation.outputData || !operation.keysetId) {
        const prepared = await this.wallet.prepareMint(asMintQuote(operation, checked), operation.quotePrivateKey);
        operation = this.commitAdd({
          ...operation,
          state: "issuing",
          outputData: prepared.outputData,
          keysetId: prepared.keysetId,
          legacySignature: prepared.legacySignature,
          payloadSignature: prepared.payloadSignature,
          quotePrivateKey: undefined,
          updatedAt: this.now(),
        });
      }
      if (!operation.outputData || !operation.keysetId) throw new Error("Stored issuance recovery data is incomplete.");
      const proofs = await this.wallet.completeMint(asMintQuote(operation, checked), {
        outputData: operation.outputData,
        keysetId: operation.keysetId,
        legacySignature: operation.legacySignature,
        payloadSignature: operation.payloadSignature,
      });
      const settled = this.commitAdd({
        ...operation,
        state: "settled",
        outputData: undefined,
        keysetId: undefined,
        legacySignature: undefined,
        payloadSignature: undefined,
        updatedAt: this.now(),
        error: undefined,
      }, [...this.getSnapshot().proofs, ...proofs]);
      this.notify("RUSD ecash issued and stored");
      return settled;
    } catch (reason) {
      return this.commitAdd({ ...operation, state: "recoverable", updatedAt: this.now(), error: describe(reason) });
    }
  }

  quoteCashOut(invoice: string): Promise<MeltQuote> {
    return this.wallet.requestMelt(invoice);
  }

  async reviewCashOut(quote: MeltQuote): Promise<CashOutReview> {
    const current = this.getSnapshot();
    const prepared = await this.wallet.prepareMelt(quote, current.proofs);
    return {
      quote,
      prepared,
      balance: sumProofs(current.proofs),
      maximumDebit: units(quote.amount) + units(quote.fee_reserve) + prepared.inputFee,
      proofFingerprint: proofFingerprint(current.proofs),
    };
  }

  async confirmCashOut(review: CashOutReview): Promise<CashOutOperation> {
    const current = this.getSnapshot();
    if (review.proofFingerprint !== proofFingerprint(current.proofs)) {
      throw new Error("The ecash balance changed. Review the recalculated maximum debit before cashing out.");
    }
    const timestamp = this.now();
    let operation = this.commitCashOut({
      id: createOperationId(),
      kind: "cashout",
      state: "dispatching",
      amount: units(review.quote.amount),
      createdAt: timestamp,
      updatedAt: timestamp,
      mintUrl: this.manifest.mintUrl,
      unit: "rusd",
      invoice: review.quote.request,
      quote: storeMeltQuote(review.quote),
      cashuFee: review.prepared.inputFee,
      reservedProofs: review.prepared.reservedProofs,
      outputData: review.prepared.outputData,
      keysetId: review.prepared.keysetId,
    }, review.prepared.keep);
    try {
      const result = await this.wallet.executeMelt(review.quote, review.prepared);
      if (result.state === "PAID") {
        operation = this.commitCashOut({
          ...operation,
          state: "paid",
          quote: { ...operation.quote, state: "PAID" },
          reservedProofs: undefined,
          outputData: undefined,
          keysetId: undefined,
          updatedAt: this.now(),
          error: undefined,
        }, [...this.getSnapshot().proofs, ...result.change]);
        return operation;
      }
      return this.commitCashOut({
        ...operation,
        state: result.state === "PENDING" ? "pending" : "unknown",
        quote: { ...operation.quote, state: result.state },
        outputData: result.outputData,
        updatedAt: this.now(),
        error: result.state === "UNPAID" ? "The mint returned unpaid; check status before recovering reserved value." : undefined,
      });
    } catch (reason) {
      return this.commitCashOut({ ...operation, state: "unknown", updatedAt: this.now(), error: describe(reason) });
    }
  }

  async refreshCashOut(input: CashOutOperation): Promise<CashOutOperation> {
    let operation = this.getSnapshot().cashOut.find((item) => item.id === input.id) ?? input;
    try {
      const checked = await this.wallet.checkMeltQuote(operation.quote.quote);
      if (checked.state === "PAID") {
        if (checked.change?.length && !operation.outputData?.length) throw new Error("Stored change recovery outputs are missing.");
        const change = operation.outputData?.length
          ? this.wallet.recoverMeltChange(operation.outputData, asMeltQuote(operation.quote, checked))
          : [];
        return this.commitCashOut({
          ...operation,
          state: "paid",
          quote: { ...operation.quote, state: "PAID" },
          reservedProofs: undefined,
          outputData: undefined,
          keysetId: undefined,
          recoverySwap: undefined,
          updatedAt: this.now(),
          error: undefined,
        }, [...this.getSnapshot().proofs, ...change]);
      }
      if (checked.state === "PENDING") {
        return this.commitCashOut({ ...operation, state: "pending", quote: { ...operation.quote, state: "PENDING" }, updatedAt: this.now(), error: undefined });
      }
      if (!operation.reservedProofs?.length) throw new Error("The payment is unpaid, but its reserved proofs are unavailable.");
      if (!operation.recoverySwap) {
        const state = await this.wallet.checkProofsState(operation.reservedProofs);
        if (state !== "unspent") {
          return this.commitCashOut({ ...operation, state: "unknown", updatedAt: this.now(), error: `Reserved proofs are ${state}.` });
        }
        const recoverySwap = await this.wallet.prepareReceive(this.wallet.encodeProofs(operation.reservedProofs));
        operation = this.commitCashOut({
          ...operation,
          state: "unknown",
          recoverySwap,
          updatedAt: this.now(),
          error: "The mint confirmed the Fiber payment was unpaid. Recovering reserved ecash.",
        });
      }
      if (!operation.recoverySwap) throw new Error("Stored cash-out recovery data is incomplete.");
      const recovered = await this.wallet.completePreparedReceive(operation.recoverySwap);
      return this.commitCashOut({
        ...operation,
        state: "failed",
        quote: { ...operation.quote, state: "UNPAID" },
        reservedProofs: undefined,
        outputData: undefined,
        keysetId: undefined,
        recoverySwap: undefined,
        updatedAt: this.now(),
        error: "The mint confirmed the payment was unpaid. Reserved ecash was recovered.",
      }, [...this.getSnapshot().proofs, ...recovered]);
    } catch (reason) {
      return this.commitCashOut({ ...operation, state: "unknown", updatedAt: this.now(), error: describe(reason) });
    }
  }
}
