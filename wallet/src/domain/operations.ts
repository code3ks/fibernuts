import type { Proof, SerializedOutputData } from "@cashu/cashu-ts";

import type { SettlementContext } from "./settlement-context";

export type OperationTone = "neutral" | "processing" | "pending" | "settled" | "failed" | "recoverable";
export type OperationPhase = "processing" | "pending" | "settled" | "failed" | "recoverable" | "stopped";

interface BaseOperation {
  id: string;
  amount: number;
  createdAt: number;
  updatedAt: number;
  mintUrl: string;
  unit: string;
  note?: string;
  error?: string;
  context?: SettlementContext;
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
  fundingSource?: "faucet";
  quotePubkey?: string;
  quotePrivateKey?: string;
  outputData?: SerializedOutputData[];
  keysetId?: string;
  legacySignature?: string;
  payloadSignature?: string;
}

export type SendState =
  | "preparing"
  | "awaiting_acceptance"
  | "acceptance_pending"
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

export type ReceiveState =
  | "detected"
  | "checking"
  | "securing"
  | "settled"
  | "recoverable"
  | "rejected"
  | "spent"
  | "discarded"
  | "failed";

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
  phase: OperationPhase;
  direction: "in" | "out";
}

const PRESENTATION: Record<WalletOperation["kind"], Record<string, Omit<OperationPresentation, "direction">>> = {
  add: {
    awaiting_payment: { title: "Added cash", stateLabel: "Awaiting Fiber payment", stateShort: "Awaiting", tone: "pending", phase: "pending" },
    payment_observed: { title: "Added cash", stateLabel: "Payment observed", stateShort: "Processing", tone: "processing", phase: "processing" },
    issuing: { title: "Added cash", stateLabel: "Issuing ecash", stateShort: "Processing", tone: "processing", phase: "processing" },
    settled: { title: "Added cash", stateLabel: "Added", stateShort: "Added", tone: "settled", phase: "settled" },
    expired: { title: "Added cash", stateLabel: "Invoice expired", stateShort: "Expired", tone: "failed", phase: "stopped" },
    recoverable: { title: "Added cash", stateLabel: "Status unknown - recoverable", stateShort: "Recoverable", tone: "recoverable", phase: "recoverable" },
    failed: { title: "Added cash", stateLabel: "Not added", stateShort: "Failed", tone: "failed", phase: "failed" },
  },
  send: {
    preparing: { title: "Sent payment", stateLabel: "Preparing token", stateShort: "Processing", tone: "processing", phase: "processing" },
    awaiting_acceptance: { title: "Sent payment", stateLabel: "Awaiting claim", stateShort: "Awaiting", tone: "pending", phase: "pending" },
    acceptance_pending: { title: "Sent payment", stateLabel: "Claim in progress", stateShort: "Pending", tone: "pending", phase: "pending" },
    accepted: { title: "Sent payment", stateLabel: "Token spent", stateShort: "Spent", tone: "settled", phase: "settled" },
    reclaiming: { title: "Sent payment", stateLabel: "Reclaiming", stateShort: "Processing", tone: "processing", phase: "processing" },
    reclaimed: { title: "Sent payment", stateLabel: "Value reclaimed", stateShort: "Reclaimed", tone: "settled", phase: "settled" },
    recovery_required: { title: "Sent payment", stateLabel: "Status unknown - recoverable", stateShort: "Recoverable", tone: "recoverable", phase: "recoverable" },
  },
  receive: {
    detected: { title: "Received payment", stateLabel: "Token detected", stateShort: "Awaiting", tone: "pending", phase: "pending" },
    checking: { title: "Received payment", stateLabel: "Checking issuer", stateShort: "Processing", tone: "processing", phase: "processing" },
    securing: { title: "Received payment", stateLabel: "Securing payment", stateShort: "Processing", tone: "processing", phase: "processing" },
    settled: { title: "Received payment", stateLabel: "Settled with fresh proofs", stateShort: "Settled", tone: "settled", phase: "settled" },
    recoverable: { title: "Received payment", stateLabel: "Status unknown - token stored", stateShort: "Recoverable", tone: "recoverable", phase: "recoverable" },
    rejected: { title: "Received payment", stateLabel: "Token rejected", stateShort: "Rejected", tone: "failed", phase: "failed" },
    spent: { title: "Received payment", stateLabel: "Already spent", stateShort: "Spent", tone: "failed", phase: "failed" },
    discarded: { title: "Received payment", stateLabel: "Removed from device", stateShort: "Removed", tone: "neutral", phase: "stopped" },
    failed: { title: "Received payment", stateLabel: "Not settled", stateShort: "Failed", tone: "failed", phase: "failed" },
  },
  cashout: {
    dispatching: { title: "Cashed out", stateLabel: "Dispatching payment", stateShort: "Processing", tone: "processing", phase: "processing" },
    pending: { title: "Cashed out", stateLabel: "Payment pending", stateShort: "Pending", tone: "pending", phase: "pending" },
    paid: { title: "Cashed out", stateLabel: "Fiber payment paid", stateShort: "Paid", tone: "settled", phase: "settled" },
    failed: { title: "Cashed out", stateLabel: "Authoritatively failed", stateShort: "Failed", tone: "failed", phase: "failed" },
    unknown: { title: "Cashed out", stateLabel: "Status unknown - recoverable", stateShort: "Unknown", tone: "recoverable", phase: "recoverable" },
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
    return ["preparing", "awaiting_acceptance", "acceptance_pending", "reclaiming", "recovery_required"].includes(operation.state);
  }
  if (operation.kind === "receive") {
    return ["detected", "checking", "securing", "recoverable"].includes(operation.state);
  }
  return ["dispatching", "pending", "unknown"].includes(operation.state);
}

export function operationHasBearerSecret(operation: WalletOperation): operation is SendOperation | ReceiveOperation {
  return (operation.kind === "send" || operation.kind === "receive") && Boolean(operation.token);
}

export interface OperationGuidance {
  known: string;
  valueStatus: string;
  nextAction: string;
}

export function operationGuidance(operation: WalletOperation): OperationGuidance {
  if (operation.kind === "add") {
    if (operation.state === "settled") return {
      known: "The mint completed issuance and the resulting proofs were stored.",
      valueStatus: "The amount is included in the spendable balance.",
      nextAction: "No recovery action is required.",
    };
    if (operation.state === "expired" || operation.state === "failed") return {
      known: operation.state === "expired" ? "The stored Fiber invoice expired." : "The mint did not issue proofs for this quote.",
      valueStatus: "No ecash from this operation is included in the balance.",
      nextAction: "Create a new add-cash quote only if you still want to fund the wallet.",
    };
    if (operation.state === "awaiting_payment") return {
      known: "The mint quote and Fiber invoice are stored; full payment has not been observed.",
      valueStatus: "No ecash has been credited and no wallet proofs are reserved.",
      nextAction: "Pay the stored invoice or check this same quote before creating another one.",
    };
    return {
      known: operation.outputData?.length
        ? "The paid quote and exact blinded outputs are stored for replay-safe issuance."
        : "The quote is stored, but proof issuance has not completed.",
      valueStatus: "The amount is not spendable until fresh proofs are persisted.",
      nextAction: "Keep this operation and check the same quote when the mint is reachable.",
    };
  }

  if (operation.kind === "send") {
    if (operation.state === "accepted") return {
      known: "The mint reports every outgoing proof spent. The wallet cannot identify who claimed the bearer token.",
      valueStatus: "The amount is no longer part of this wallet's balance.",
      nextAction: "No recovery action is available or required.",
    };
    if (operation.state === "reclaimed") return {
      known: "The outgoing proofs were still unspent and the reclaim swap completed.",
      valueStatus: "Fresh replacement proofs are included in the spendable balance.",
      nextAction: "No recovery action is required.",
    };
    if (operation.state === "preparing") return {
      known: "The selected inputs and exact token outputs are stored, but token creation has not completed.",
      valueStatus: "The selected value remains excluded from the spendable balance.",
      nextAction: "Retry the stored preparation; do not create another payment for the same request.",
    };
    if (operation.state === "reclaiming") return {
      known: "The mint reported the token unspent and the exact reclaim outputs are stored.",
      valueStatus: "The token value remains excluded until fresh proofs are persisted.",
      nextAction: "Resume the stored reclaim swap when the mint is reachable.",
    };
    if (operation.state === "acceptance_pending") return {
      known: "The mint reports that at least one outgoing proof is currently pending.",
      valueStatus: "The token value is not spendable and cannot be safely reclaimed yet.",
      nextAction: "Wait and check the same token again; do not send or reclaim it elsewhere.",
    };
    if (operation.state === "recovery_required") return {
      known: operation.swap
        ? "Prepared recovery outputs are stored, but the mint result is unresolved."
        : "The wallet could not establish one authoritative spend state for the stored token.",
      valueStatus: "The outgoing value remains excluded from the spendable balance.",
      nextAction: "Check the stored operation again; reclaim only after every proof is authoritatively unspent.",
    };
    return {
      known: "The bearer token is stored, but no successful claim has been proven.",
      valueStatus: "The token amount and fee remain outside the spendable balance.",
      nextAction: "Redisplay the same token or check its proof state before considering reclaim.",
    };
  }

  if (operation.kind === "receive") {
    if (operation.state === "settled") return {
      known: "The issuing mint accepted the token and returned fresh proofs.",
      valueStatus: "The amount is included in the spendable balance.",
      nextAction: "No recovery action is required.",
    };
    if (["rejected", "spent", "failed"].includes(operation.state)) return {
      known: operation.state === "spent"
        ? "The issuing mint reports the original bearer proofs already spent."
        : "The token did not pass the checks required for settlement.",
      valueStatus: "No value from this token is included in the balance.",
      nextAction: operation.token
        ? "Keep the token for external recovery or explicitly remove this device's copy."
        : "No wallet recovery action remains for this record.",
    };
    if (operation.state === "discarded") return {
      known: "The locally stored bearer token was explicitly removed before settlement.",
      valueStatus: "No value was added, and this wallet no longer holds a recovery copy.",
      nextAction: "Use another retained copy if one exists; this record cannot restore the token.",
    };
    return {
      known: operation.swap
        ? "The original token and exact fresh-proof outputs are stored for recovery."
        : "The incoming bearer token is stored, but settlement is not authoritative yet.",
      valueStatus: "The amount is not included in the spendable balance.",
      nextAction: "Keep the stored recovery data and retry the same settlement when the mint is reachable.",
    };
  }

  if (operation.state === "paid") return {
    known: "The mint reports the external Fiber invoice paid and returned any signed change.",
    valueStatus: "The payment debit is final; persisted change is included in the balance.",
    nextAction: "No recovery action is required.",
  };
  if (operation.state === "failed") return {
    known: "The mint returned a terminal unpaid result and released its proof reservation.",
    valueStatus: "The wallet recovered the reserved value into fresh spendable proofs.",
    nextAction: "Create a new cash-out only after reviewing a new quote.",
  };
  if (operation.state === "pending") return {
    known: "The mint reports the same Fiber payment still pending.",
    valueStatus: "The selected proofs remain reserved and excluded from the spendable balance.",
    nextAction: "Check the same quote later; do not submit another payment for this invoice.",
  };
  if (operation.state === "dispatching") return {
    known: "The quote, selected proofs, and change outputs were stored before dispatch.",
    valueStatus: "The selected proofs are reserved while the payment result is established.",
    nextAction: "Keep this operation stored and wait for the first status result.",
  };
  return {
    known: "The wallet could not establish whether the mint accepted or completed the cash-out request.",
    valueStatus: "The selected proofs remain reserved and excluded from the spendable balance.",
    nextAction: "Check the same quote again; do not repeat the cash-out or treat the value as refunded.",
  };
}

export function createOperationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
