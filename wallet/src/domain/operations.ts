import type { Proof, SerializedOutputData } from "@cashu/cashu-ts";

export type OperationTone = "neutral" | "pending" | "settled" | "failed" | "recoverable";

interface BaseOperation {
  id: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
  mintUrl: string;
  unit: string;
  note?: string;
  error?: string;
}

export interface StoredSwapPreview {
  amount: number;
  fees: number;
  keysetId: string;
  inputs: Proof[];
  sendOutputs?: SerializedOutputData[];
  keepOutputs?: SerializedOutputData[];
  unselectedProofs?: Proof[];
}

export type AddCashState =
  | "awaiting_payment"
  | "payment_observed"
  | "issuing"
  | "settled"
  | "expired"
  | "recoverable"
  | "failed";

export interface AddCashOperation extends BaseOperation {
  kind: "add";
  state: AddCashState;
  quoteId: string;
  invoice: string;
  expiry?: number;
  outputData?: SerializedOutputData[];
  keysetId?: string;
  legacySignature?: string;
  payloadSignature?: string;
}

export type SendState =
  | "preparing"
  | "awaiting_acceptance"
  | "accepted"
  | "reclaiming"
  | "reclaimed"
  | "recovery_required";

export interface SendOperation extends BaseOperation {
  kind: "send";
  state: SendState;
  fee?: number;
  token?: string;
  requestId?: string;
  swap?: StoredSwapPreview;
}

export type ReceiveState = "detected" | "checking" | "securing" | "settled" | "recoverable" | "failed";

export interface ReceiveOperation extends BaseOperation {
  kind: "receive";
  state: ReceiveState;
  requestId?: string;
  requestedAmount?: number;
  token?: string;
  swap?: StoredSwapPreview;
}

export type CashOutState = "dispatching" | "pending" | "paid" | "failed" | "unknown";

export interface StoredMeltQuote {
  quote: string;
  amount: number;
  feeReserve: number;
  unit: string;
  state: "UNPAID" | "PENDING" | "PAID";
  expiry: number;
  request: string;
}

export interface CashOutOperation extends BaseOperation {
  kind: "cashout";
  state: CashOutState;
  invoice: string;
  quote: StoredMeltQuote;
  cashuFee?: number;
  reservedProofs?: Proof[];
  outputData?: SerializedOutputData[];
  keysetId?: string;
  recoverySwap?: StoredSwapPreview;
}

export type WalletOperation = AddCashOperation | SendOperation | ReceiveOperation | CashOutOperation;

export interface OperationPresentation {
  title: string;
  stateLabel: string;
  stateShort: string;
  tone: OperationTone;
  direction: "in" | "out";
}

const PRESENTATION: Record<WalletOperation["kind"], Record<string, Omit<OperationPresentation, "direction">>> = {
  add: {
    awaiting_payment: { title: "Added cash", stateLabel: "Awaiting Fiber payment", stateShort: "Awaiting", tone: "pending" },
    payment_observed: { title: "Added cash", stateLabel: "Payment observed", stateShort: "Observed", tone: "pending" },
    issuing: { title: "Added cash", stateLabel: "Issuing ecash", stateShort: "Issuing", tone: "pending" },
    settled: { title: "Added cash", stateLabel: "Added", stateShort: "Added", tone: "settled" },
    expired: { title: "Added cash", stateLabel: "Invoice expired", stateShort: "Expired", tone: "failed" },
    recoverable: { title: "Added cash", stateLabel: "Recovery required", stateShort: "Recoverable", tone: "recoverable" },
    failed: { title: "Added cash", stateLabel: "Not added", stateShort: "Failed", tone: "failed" },
  },
  send: {
    preparing: { title: "Sent payment", stateLabel: "Preparing token", stateShort: "Preparing", tone: "pending" },
    awaiting_acceptance: { title: "Sent payment", stateLabel: "Awaiting acceptance", stateShort: "Awaiting", tone: "pending" },
    accepted: { title: "Sent payment", stateLabel: "Accepted", stateShort: "Accepted", tone: "settled" },
    reclaiming: { title: "Sent payment", stateLabel: "Reclaiming", stateShort: "Reclaiming", tone: "pending" },
    reclaimed: { title: "Sent payment", stateLabel: "Reclaimed", stateShort: "Reclaimed", tone: "recoverable" },
    recovery_required: { title: "Sent payment", stateLabel: "Recovery required", stateShort: "Recoverable", tone: "recoverable" },
  },
  receive: {
    detected: { title: "Received payment", stateLabel: "Token detected", stateShort: "Detected", tone: "neutral" },
    checking: { title: "Received payment", stateLabel: "Checking issuer", stateShort: "Checking", tone: "pending" },
    securing: { title: "Received payment", stateLabel: "Securing payment", stateShort: "Securing", tone: "pending" },
    settled: { title: "Received payment", stateLabel: "Settled", stateShort: "Settled", tone: "settled" },
    recoverable: { title: "Received payment", stateLabel: "Token stored", stateShort: "Recoverable", tone: "recoverable" },
    failed: { title: "Received payment", stateLabel: "Not settled", stateShort: "Failed", tone: "failed" },
  },
  cashout: {
    dispatching: { title: "Cashed out", stateLabel: "Dispatching payment", stateShort: "Dispatching", tone: "pending" },
    pending: { title: "Cashed out", stateLabel: "Pending", stateShort: "Pending", tone: "pending" },
    paid: { title: "Cashed out", stateLabel: "Paid", stateShort: "Paid", tone: "settled" },
    failed: { title: "Cashed out", stateLabel: "Authoritatively failed", stateShort: "Failed", tone: "failed" },
    unknown: { title: "Cashed out", stateLabel: "Status unknown", stateShort: "Unknown", tone: "recoverable" },
  },
};

export function presentOperation(operation: WalletOperation): OperationPresentation {
  const item = PRESENTATION[operation.kind][operation.state];
  return { ...item, direction: operation.kind === "add" || operation.kind === "receive" ? "in" : "out" };
}

export function operationNeedsAttention(operation: WalletOperation): boolean {
  if (operation.kind === "add") {
    return ["awaiting_payment", "payment_observed", "issuing", "recoverable"].includes(operation.state);
  }
  if (operation.kind === "send") {
    return ["preparing", "awaiting_acceptance", "reclaiming", "recovery_required"].includes(operation.state);
  }
  if (operation.kind === "receive") {
    return ["detected", "checking", "securing", "recoverable"].includes(operation.state);
  }
  return ["dispatching", "pending", "unknown"].includes(operation.state);
}

export function operationHasBearerSecret(operation: WalletOperation): operation is SendOperation | ReceiveOperation {
  return (operation.kind === "send" || operation.kind === "receive") && Boolean(operation.token);
}

export function createOperationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
