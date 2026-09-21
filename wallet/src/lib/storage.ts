import { deserializeProofs, type Proof, type ProofLike } from "@cashu/cashu-ts";

import type { CashOutOperation, StoredSwapPreview, WalletOperation } from "../domain/operations";
import { normalizeMintUrl, type DecodedPaymentRequest } from "./payment-request";

const STATE_VERSION = 2;
const ACTIVE_MINT_KEY = "fibernuts:active-mint";

export interface WalletSnapshot {
  version: typeof STATE_VERSION;
  unit?: string;
  proofs: Proof[];
  operations: WalletOperation[];
  openRequest?: DecodedPaymentRequest;
}

function stateKey(mintUrl: string): string {
  return `fibernuts:wallet:v${STATE_VERSION}:${mintUrl}`;
}

function legacyProofKey(mintUrl: string): string {
  return `fibernuts:proofs:${mintUrl}`;
}

function normalizeProofs(proofs: unknown): Proof[] {
  if (!Array.isArray(proofs)) return [];
  try {
    return deserializeProofs(proofs as ProofLike[]);
  } catch {
    return [];
  }
}

function normalizeOperations(value: unknown): WalletOperation[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): WalletOperation[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      !["add", "send", "receive", "cashout"].includes(String(raw.kind)) ||
      typeof raw.mintUrl !== "string" ||
      typeof raw.unit !== "string" ||
      !Number.isSafeInteger(raw.amount) ||
      (raw.amount as number) < 0 ||
      !Number.isFinite(raw.createdAt) ||
      !Number.isFinite(raw.updatedAt)
    ) {
      return [];
    }

    const operation = item as WalletOperation;
    if (operation.kind === "add") {
      if (
        !["awaiting_payment", "payment_observed", "issuing", "settled", "expired", "recoverable", "failed"].includes(operation.state) ||
        typeof operation.quoteId !== "string" ||
        typeof operation.invoice !== "string"
      ) return [];
      return [operation];
    }

    if (operation.kind === "send") {
      if (!["preparing", "awaiting_acceptance", "accepted", "reclaiming", "reclaimed", "recovery_required"].includes(operation.state)) return [];
      return [{
        ...operation,
        fee: Number.isSafeInteger(operation.fee) && (operation.fee ?? -1) >= 0 ? operation.fee : undefined,
        token: typeof operation.token === "string" ? operation.token : undefined,
        swap: normalizeSwap(operation.swap),
      }];
    }

    if (operation.kind === "receive") {
      if (!["detected", "checking", "securing", "settled", "recoverable", "failed"].includes(operation.state)) return [];
      return [{
        ...operation,
        requestId: typeof operation.requestId === "string" ? operation.requestId : undefined,
        requestedAmount: Number.isSafeInteger(operation.requestedAmount) && (operation.requestedAmount ?? 0) > 0
          ? operation.requestedAmount
          : undefined,
        token: typeof operation.token === "string" ? operation.token : undefined,
        swap: normalizeSwap(operation.swap),
      }];
    }

    if (operation.kind === "cashout") {
      if (
        !["dispatching", "pending", "paid", "failed", "unknown"].includes(operation.state) ||
        typeof operation.invoice !== "string" ||
        !operation.quote ||
        typeof operation.quote.quote !== "string" ||
        !Number.isSafeInteger(operation.quote.amount) ||
        !Number.isSafeInteger(operation.quote.feeReserve) ||
        typeof operation.quote.unit !== "string" ||
        typeof operation.quote.request !== "string"
      ) return [];
      const cashout: CashOutOperation = {
        ...operation,
        cashuFee: Number.isSafeInteger(operation.cashuFee) && (operation.cashuFee ?? -1) >= 0
          ? operation.cashuFee
          : undefined,
        reservedProofs: normalizeProofs(operation.reservedProofs),
        recoverySwap: normalizeSwap(operation.recoverySwap),
      };
      return [cashout];
    }

    return [];
  });
}

function normalizeSwap(value: unknown): StoredSwapPreview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const swap = value as Partial<StoredSwapPreview>;
  if (
    !Number.isSafeInteger(swap.amount) ||
    !Number.isSafeInteger(swap.fees) ||
    typeof swap.keysetId !== "string" ||
    !Array.isArray(swap.inputs)
  ) {
    return undefined;
  }
  return {
    amount: swap.amount as number,
    fees: swap.fees as number,
    keysetId: swap.keysetId,
    inputs: normalizeProofs(swap.inputs),
    sendOutputs: Array.isArray(swap.sendOutputs) ? swap.sendOutputs : undefined,
    keepOutputs: Array.isArray(swap.keepOutputs) ? swap.keepOutputs : undefined,
    unselectedProofs: normalizeProofs(swap.unselectedProofs),
  };
}

function normalizeOpenRequest(value: unknown): DecodedPaymentRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Partial<DecodedPaymentRequest>;
  if (
    !Number.isSafeInteger(request.amount) ||
    (request.amount ?? 0) <= 0 ||
    typeof request.unit !== "string" ||
    !Array.isArray(request.mints) ||
    !request.mints.every((mint) => typeof mint === "string") ||
    typeof request.description !== "string" ||
    typeof request.singleUse !== "boolean" ||
    typeof request.encoded !== "string" ||
    !/^creq[ab]/i.test(request.encoded)
  ) {
    return undefined;
  }
  return request as DecodedPaymentRequest;
}

function normalizeUnit(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const unit = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(unit) ? unit : undefined;
}

export function emptyWalletSnapshot(): WalletSnapshot {
  return { version: STATE_VERSION, unit: undefined, proofs: [], operations: [], openRequest: undefined };
}

export function loadWalletSnapshot(mintUrl: string, storage: Storage = localStorage): WalletSnapshot {
  try {
    const encoded = storage.getItem(stateKey(mintUrl));
    if (encoded) {
      const parsed = JSON.parse(encoded) as Partial<WalletSnapshot>;
      const normalizedOperations = normalizeOperations(parsed.operations);
      const operationUnits = [...new Set(normalizedOperations.map((operation) => operation.unit.toLowerCase()))];
      const unit = normalizeUnit(parsed.unit) ?? (operationUnits.length === 1 ? normalizeUnit(operationUnits[0]) : undefined);
      return {
        version: STATE_VERSION,
        unit,
        proofs: normalizeProofs(parsed.proofs),
        operations: unit
          ? normalizedOperations.filter((operation) => operation.unit.toLowerCase() === unit)
          : normalizedOperations,
        openRequest: (() => {
          const request = normalizeOpenRequest(parsed.openRequest);
          return !unit || request?.unit.toLowerCase() === unit ? request : undefined;
        })(),
      };
    }

    const legacy = storage.getItem(legacyProofKey(mintUrl));
    if (!legacy) return emptyWalletSnapshot();

    const migrated = {
      version: STATE_VERSION,
      unit: undefined,
      proofs: normalizeProofs(JSON.parse(legacy)),
      operations: [],
      openRequest: undefined,
    } satisfies WalletSnapshot;
    saveWalletSnapshot(mintUrl, migrated, storage);
    return migrated;
  } catch {
    return emptyWalletSnapshot();
  }
}

export function saveWalletSnapshot(
  mintUrl: string,
  snapshot: WalletSnapshot,
  storage: Storage = localStorage,
): void {
  storage.setItem(
    stateKey(mintUrl),
    JSON.stringify({
      version: STATE_VERSION,
      unit: normalizeUnit(snapshot.unit),
      proofs: snapshot.proofs,
      operations: snapshot.operations,
      openRequest: snapshot.openRequest,
    }),
  );
}

export function loadActiveMint(fallback: string, storage: Storage = localStorage): string {
  try {
    return normalizeMintUrl(storage.getItem(ACTIVE_MINT_KEY) || fallback);
  } catch {
    return normalizeMintUrl(fallback);
  }
}

export function saveActiveMint(mintUrl: string, storage: Storage = localStorage): void {
  storage.setItem(ACTIVE_MINT_KEY, normalizeMintUrl(mintUrl));
}
