import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";

import { AppShell, type MintConnectionStatus } from "./components/AppShell";
import type { AppScreen } from "./domain/navigation";
import {
  createOperationId,
  operationNeedsAttention,
  type AddCashOperation,
  type CashOutOperation,
  type ReceiveOperation,
  type SendOperation,
  type StoredMeltQuote,
  type WalletOperation,
} from "./domain/operations";
import { normalizeMintUrl, validatePaymentRequest, type DecodedPaymentRequest } from "./lib/payment-request";
import {
  loadActiveMint,
  loadWalletSnapshot,
  saveActiveMint,
  saveWalletSnapshot,
  type WalletSnapshot,
} from "./lib/storage";
import {
  DEFAULT_UNIT,
  FibernutsWallet,
  MintCompatibilityError,
  mintQuoteIsPaid,
  sumProofs,
  units,
  type MeltQuote,
  type MintProfile,
  type MintQuote,
  type PreparedMint,
  type PreparedSend,
} from "./lib/wallet";
import { ActivityScreen, OperationDetailScreen } from "./screens/ActivityScreen";
import { AddCashScreen } from "./screens/AddCashScreen";
import { CashOutScreen, type CashOutPreparation } from "./screens/CashOutScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { MintScreen } from "./screens/MintScreen";
import { PayScreen, type OutgoingPreparation } from "./screens/PayScreen";
import { RequestScreen } from "./screens/RequestScreen";

const DEFAULT_MINT =
  import.meta.env.VITE_MINT_URL ??
  (window.location.port === "5174" ? window.location.origin : "https://mint.fibernuts.xyz");
const NETWORK_LABEL = import.meta.env.VITE_NETWORK_LABEL ?? "Network not declared";

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function replaceOperation(operations: WalletOperation[], next: WalletOperation): WalletOperation[] {
  const exists = operations.some((operation) => operation.id === next.id);
  return exists
    ? operations.map((operation) => (operation.id === next.id ? next : operation))
    : [next, ...operations];
}

function proofFingerprint(proofs: Proof[]): string {
  const identities = proofs.map((proof) => [proof.id, proof.secret, units(proof.amount)] as const);
  identities.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify(identities);
}

function assertSingleUseRequestAvailable(request: DecodedPaymentRequest, operations: WalletOperation[]): void {
  if (!request.singleUse || !request.id) return;
  const existing = operations.find(
    (operation) => operation.kind === "send" && operation.requestId === request.id && operation.state !== "reclaimed",
  );
  if (existing) {
    throw new Error("This single-use request already has a payment operation. Open Activity to check or recover it.");
  }
}

function asMintQuote(operation: AddCashOperation, checked?: MintQuote): MintQuote {
  return {
    ...checked,
    quote: operation.quoteId,
    request: operation.invoice,
    amount: operation.amount,
    unit: operation.unit,
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

export default function App() {
  const [mintUrl, setMintUrl] = useState(() => loadActiveMint(DEFAULT_MINT));
  const [snapshot, setSnapshot] = useState<WalletSnapshot>(() => loadWalletSnapshot(loadActiveMint(DEFAULT_MINT)));
  const [wallet, setWallet] = useState<FibernutsWallet | null>(null);
  const [profile, setProfile] = useState<MintProfile | null>(null);
  const [status, setStatus] = useState<MintConnectionStatus>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [screen, setScreen] = useState<AppScreen>("home");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  const inFlightRef = useRef(new Set<string>());

  const commitSnapshot = useCallback(
    (next: WalletSnapshot) => {
      saveWalletSnapshot(mintUrl, next);
      snapshotRef.current = next;
      setSnapshot(next);
    },
    [mintUrl],
  );

  const persistOperation = useCallback(
    (operation: WalletOperation, proofs?: Proof[], clearMatchingRequest = false) => {
      const current = snapshotRef.current;
      const next: WalletSnapshot = {
        version: current.version,
        unit: current.unit,
        proofs: proofs ?? current.proofs,
        operations: replaceOperation(current.operations, operation),
        openRequest:
          clearMatchingRequest && operation.kind === "receive" && operation.requestId === current.openRequest?.id
            ? undefined
            : current.openRequest,
      };
      commitSnapshot(next);
      return operation;
    },
    [commitSnapshot],
  );

  useEffect(() => {
    let cancelled = false;
    const stored = loadWalletSnapshot(mintUrl);
    snapshotRef.current = stored;
    setSnapshot(stored);
    setWallet(null);
    setProfile(null);
    setStatus("connecting");
    setConnectionError(null);

    const nextWallet = new FibernutsWallet(mintUrl);
    void nextWallet
      .load()
      .then(() => {
        if (cancelled) return;
        const current = snapshotRef.current;
        if (current.unit && current.unit !== nextWallet.unit) {
          setProfile(nextWallet.profile);
          setStatus("incompatible");
          setConnectionError(
            `Stored wallet value is bound to ${current.unit.toUpperCase()}, but this mint now advertises ${nextWallet.ticker}. No proofs or operations were changed.`,
          );
          return;
        }
        if (!current.unit) {
          const bound = {
            ...current,
            unit: nextWallet.unit,
            operations: current.operations.filter((operation) => operation.unit.toLowerCase() === nextWallet.unit),
            openRequest: current.openRequest?.unit.toLowerCase() === nextWallet.unit ? current.openRequest : undefined,
          };
          saveWalletSnapshot(mintUrl, bound);
          snapshotRef.current = bound;
          setSnapshot(bound);
        }
        setWallet(nextWallet);
        setProfile(nextWallet.profile);
        setStatus("online");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        if (reason instanceof MintCompatibilityError) {
          setProfile(nextWallet.profile);
          setStatus("incompatible");
        } else {
          setStatus("offline");
        }
        setConnectionError(describe(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [mintUrl, reloadKey]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const runLocked = useCallback(async <T,>(id: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (inFlightRef.current.has(id)) return undefined;
    inFlightRef.current.add(id);
    try {
      return await task();
    } finally {
      inFlightRef.current.delete(id);
    }
  }, []);

  const prepareOutgoing = useCallback(
    async (request: DecodedPaymentRequest): Promise<OutgoingPreparation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const proofs = snapshotRef.current.proofs;
      const balance = sumProofs(proofs);
      assertSingleUseRequestAvailable(request, snapshotRef.current.operations);
      validatePaymentRequest(request, mintUrl, wallet.ticker, balance);
      const prepared = await wallet.prepareSend(request.amount, proofs);
      return {
        request: request.encoded,
        prepared,
        balance,
        debit: prepared.debit,
        fee: prepared.fee,
        proofFingerprint: proofFingerprint(proofs),
      };
    },
    [mintUrl, wallet],
  );

  const createOutgoing = useCallback(
    async (request: DecodedPaymentRequest, preparation: OutgoingPreparation): Promise<SendOperation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const currentProofs = snapshotRef.current.proofs;
      assertSingleUseRequestAvailable(request, snapshotRef.current.operations);
      validatePaymentRequest(request, mintUrl, wallet.ticker, sumProofs(currentProofs));
      if (
        preparation.request !== request.encoded ||
        preparation.proofFingerprint !== proofFingerprint(currentProofs)
      ) {
        throw new Error("The wallet balance changed. Review the recalculated amount before paying.");
      }
      saveWalletSnapshot(mintUrl, snapshotRef.current);
      const prepared: PreparedSend = preparation.prepared;
      const now = Date.now();
      if (prepared.mode === "offline") {
        const operation: SendOperation = {
          id: createOperationId(),
          kind: "send",
          state: "awaiting_acceptance",
          amount: request.amount,
          createdAt: now,
          updatedAt: now,
          mintUrl,
          unit: wallet.unit,
          note: request.description,
          requestId: request.id,
          token: wallet.encodeProofs(prepared.send),
          fee: prepared.fee,
        };
        persistOperation(operation, prepared.keep);
        return operation;
      }

      const preparing: SendOperation = {
        id: createOperationId(),
        kind: "send",
        state: "preparing",
        amount: request.amount,
        createdAt: now,
        updatedAt: now,
        mintUrl,
        unit: wallet.unit,
        note: request.description,
        requestId: request.id,
        swap: prepared.swap,
        fee: prepared.fee,
      };
      persistOperation(preparing, prepared.swap.unselectedProofs ?? []);
      try {
        saveWalletSnapshot(mintUrl, snapshotRef.current);
        const result = await wallet.completePreparedSend(prepared.swap);
        const ready: SendOperation = {
          ...preparing,
          state: "awaiting_acceptance",
          updatedAt: Date.now(),
          token: result.token,
          swap: undefined,
        };
        persistOperation(ready, [...snapshotRef.current.proofs, ...result.change]);
        return ready;
      } catch (reason) {
        const recoverable: SendOperation = {
          ...preparing,
          state: "recovery_required",
          updatedAt: Date.now(),
          error: `Token preparation is stored for retry. ${describe(reason)}`,
        };
        persistOperation(recoverable);
        return recoverable;
      }
    },
    [mintUrl, persistOperation, wallet],
  );

  const settleReceive = useCallback(
    async (operation: ReceiveOperation): Promise<ReceiveOperation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      let latest = operation;
      try {
        if (!latest.swap) {
          if (!latest.token) throw new Error("The stored token is not available for recovery.");
          const token = latest.token;
          const checking: ReceiveOperation = { ...latest, state: "checking", updatedAt: Date.now(), error: undefined };
          persistOperation(checking);
          latest = checking;
          let swap;
          try {
            swap = await wallet.prepareReceive(token);
          } catch (reason) {
            const failed: ReceiveOperation = {
              ...checking,
              state: "failed",
              updatedAt: Date.now(),
              error: `Token validation failed. ${describe(reason)}`,
            };
            persistOperation(failed);
            return failed;
          }
          if (latest.requestedAmount !== undefined && swap.amount !== latest.requestedAmount) {
            const failed: ReceiveOperation = {
              ...checking,
              state: "failed",
              amount: swap.amount,
              updatedAt: Date.now(),
              error: `The token settles to ${wallet.ticker} ${swap.amount} units, but the open request requires ${latest.requestedAmount}. It was not claimed.`,
            };
            persistOperation(failed);
            return failed;
          }
          const tokenState = await wallet.checkTokenState(token);
          if (tokenState === "spent" || tokenState === "mixed") {
            const failed: ReceiveOperation = {
              ...checking,
              state: "failed",
              updatedAt: Date.now(),
              error: tokenState === "spent"
                ? "These bearer proofs were already spent. No value was added to this wallet."
                : "The token contains conflicting proof states. It cannot be settled as one payment.",
            };
            persistOperation(failed);
            return failed;
          }
          if (tokenState === "pending") {
            const recoverable: ReceiveOperation = {
              ...checking,
              state: "recoverable",
              updatedAt: Date.now(),
              error: "These proofs are pending at the mint. The token is stored and will be checked again.",
            };
            persistOperation(recoverable);
            return recoverable;
          }
          latest = {
            ...checking,
            state: "securing",
            amount: swap.amount,
            updatedAt: Date.now(),
            swap,
          };
          persistOperation(latest);
        }
        if (!latest.swap) throw new Error("Prepared receive recovery data is unavailable.");
        saveWalletSnapshot(mintUrl, snapshotRef.current);
        const received = await wallet.completePreparedReceive(latest.swap);
        const settled: ReceiveOperation = {
          ...latest,
          state: "settled",
          updatedAt: Date.now(),
          token: undefined,
          swap: undefined,
          error: undefined,
        };
        persistOperation(settled, [...snapshotRef.current.proofs, ...received], true);
        setToast(`${received.length} fresh ${wallet.ticker} proofs stored`);
        return settled;
      } catch (reason) {
        let state: ReceiveOperation["state"] = "recoverable";
        if (!latest.swap && latest.token) {
          try {
            if ((await wallet.checkTokenState(latest.token)) === "spent") state = "failed";
          } catch {
            state = "recoverable";
          }
        }
        const recoverable: ReceiveOperation = {
          ...latest,
          state,
          updatedAt: Date.now(),
          error: describe(reason),
        };
        persistOperation(recoverable);
        return recoverable;
      }
    },
    [mintUrl, persistOperation, wallet],
  );

  const receiveToken = useCallback(
    async (token: string, note: string): Promise<ReceiveOperation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const inspected = wallet.inspectToken(token);
      if (normalizeMintUrl(inspected.mint) !== normalizeMintUrl(mintUrl)) {
        throw new Error(`This token was issued by ${safeHost(inspected.mint)}, not the active mint.`);
      }
      if (inspected.unit !== wallet.unit.toLowerCase()) {
        throw new Error(`This token is denominated in ${inspected.unit.toUpperCase()}, not ${wallet.ticker}.`);
      }
      saveWalletSnapshot(mintUrl, snapshotRef.current);
      const now = Date.now();
      const openRequest = snapshotRef.current.openRequest;
      const operation: ReceiveOperation = {
        id: createOperationId(),
        kind: "receive",
        state: "detected",
        amount: inspected.amount,
        createdAt: now,
        updatedAt: now,
        mintUrl,
        unit: wallet.unit,
        note,
        requestId: openRequest?.id,
        requestedAmount: openRequest?.amount,
        token: token.trim(),
      };
      persistOperation(operation);
      return (await runLocked(operation.id, () => settleReceive(operation))) ?? operation;
    },
    [mintUrl, persistOperation, runLocked, settleReceive, wallet],
  );

  const requestAdd = useCallback(
    async (amount: number): Promise<AddCashOperation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const quote = await wallet.requestMint(amount);
      const now = Date.now();
      const operation: AddCashOperation = {
        id: createOperationId(),
        kind: "add",
        state: "awaiting_payment",
        amount,
        createdAt: now,
        updatedAt: now,
        mintUrl,
        unit: wallet.unit,
        quoteId: quote.quote,
        invoice: quote.request,
        expiry: quote.expiry ?? undefined,
      };
      persistOperation(operation);
      return operation;
    },
    [mintUrl, persistOperation, wallet],
  );

  const refreshAdd = useCallback(
    async (operation: AddCashOperation): Promise<void> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      await runLocked(operation.id, async () => {
        let latest = operation;
        try {
          const checked = await wallet.checkMintQuote(operation.quoteId);
          const paid = mintQuoteIsPaid(checked);
          if (!paid) {
            if (operation.expiry && operation.expiry * 1000 < Date.now()) {
              persistOperation({ ...operation, state: "expired", updatedAt: Date.now(), error: "The Fiber invoice expired before payment was observed." });
            }
            return;
          }

          let issuing: AddCashOperation = {
            ...operation,
            state: "payment_observed",
            updatedAt: Date.now(),
            error: undefined,
          };
          persistOperation(issuing);
          latest = issuing;

          if (!issuing.outputData || !issuing.keysetId) {
            const prepared = await wallet.prepareMint(asMintQuote(issuing, checked));
            issuing = {
              ...issuing,
              state: "issuing",
              updatedAt: Date.now(),
              outputData: prepared.outputData,
              keysetId: prepared.keysetId,
              legacySignature: prepared.legacySignature,
              payloadSignature: prepared.payloadSignature,
            };
            persistOperation(issuing);
            latest = issuing;
          }

          if (!issuing.outputData || !issuing.keysetId) {
            throw new Error("Prepared mint recovery data was not available after persistence.");
          }

          const prepared: PreparedMint = {
            outputData: issuing.outputData,
            keysetId: issuing.keysetId,
            legacySignature: issuing.legacySignature,
            payloadSignature: issuing.payloadSignature,
          };
          saveWalletSnapshot(mintUrl, snapshotRef.current);
          const proofs = await wallet.completeMint(asMintQuote(issuing, checked), prepared);
          const settled: AddCashOperation = {
            ...issuing,
            state: "settled",
            updatedAt: Date.now(),
            outputData: undefined,
            keysetId: undefined,
            legacySignature: undefined,
            payloadSignature: undefined,
            error: undefined,
          };
          persistOperation(settled, [...snapshotRef.current.proofs, ...proofs]);
          setToast(`${wallet.ticker} ecash issued and stored`);
        } catch (reason) {
          persistOperation({
            ...latest,
            state: "recoverable",
            updatedAt: Date.now(),
            error: describe(reason),
          });
          throw reason;
        }
      });
    },
    [mintUrl, persistOperation, runLocked, wallet],
  );

  const quoteCashOut = useCallback(
    async (invoice: string): Promise<MeltQuote> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      return wallet.requestMelt(invoice);
    },
    [wallet],
  );

  const prepareCashOut = useCallback(
    async (quote: MeltQuote): Promise<CashOutPreparation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const proofs = snapshotRef.current.proofs;
      const balance = sumProofs(proofs);
      const prepared = await wallet.prepareMelt(quote, proofs);
      return {
        quote,
        prepared,
        balance,
        maximumDebit: units(quote.amount) + units(quote.fee_reserve) + prepared.inputFee,
        proofFingerprint: proofFingerprint(proofs),
      };
    },
    [wallet],
  );

  const refreshCashOut = useCallback(
    async (operation: CashOutOperation): Promise<void> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      await runLocked(operation.id, async () => {
        let latest = operation;
        try {
          const checked = await wallet.checkMeltQuote(operation.quote.quote);
          if (checked.state === "PAID") {
            if (checked.change?.length && !latest.outputData?.length) {
              throw new Error("The mint returned change, but its stored recovery outputs are missing.");
            }
            const change = latest.outputData?.length
              ? wallet.recoverMeltChange(latest.outputData, asMeltQuote(latest.quote, checked))
              : [];
            persistOperation(
              {
                ...latest,
                state: "paid",
                updatedAt: Date.now(),
                quote: { ...latest.quote, state: "PAID" },
                reservedProofs: undefined,
                outputData: undefined,
                keysetId: undefined,
                recoverySwap: undefined,
                error: undefined,
              },
              [...snapshotRef.current.proofs, ...change],
            );
            setToast("Fiber invoice reported paid");
            return;
          }

          if (checked.state === "PENDING") {
            persistOperation({
              ...latest,
              state: "pending",
              updatedAt: Date.now(),
              quote: { ...latest.quote, state: "PENDING" },
              error: undefined,
            });
            return;
          }

          if (!latest.reservedProofs?.length) {
            throw new Error("The payment is unpaid, but no reserved proofs are available for recovery.");
          }
          if (!latest.recoverySwap) {
            const proofState = await wallet.checkProofsState(latest.reservedProofs);
            if (proofState !== "unspent") {
              persistOperation({
                ...latest,
                state: "unknown",
                updatedAt: Date.now(),
                error: `The quote is unpaid, but its reserved proofs are ${proofState}.`,
              });
              return;
            }
            const recoverySwap = await wallet.prepareReceive(wallet.encodeProofs(latest.reservedProofs));
            latest = {
              ...latest,
              state: "unknown",
              updatedAt: Date.now(),
              recoverySwap,
              error: "The mint confirmed the payment was unpaid. Recovering the reserved proofs.",
            };
            persistOperation(latest);
          }
          if (!latest.recoverySwap) throw new Error("Prepared cash-out recovery data is unavailable.");
          saveWalletSnapshot(mintUrl, snapshotRef.current);
          const recovered = await wallet.completePreparedReceive(latest.recoverySwap);
          persistOperation(
            {
              ...latest,
              state: "failed",
              updatedAt: Date.now(),
              quote: { ...latest.quote, state: "UNPAID" },
              reservedProofs: undefined,
              outputData: undefined,
              keysetId: undefined,
              recoverySwap: undefined,
              error: "The mint confirmed the payment was unpaid. Reserved value was recovered.",
            },
            [...snapshotRef.current.proofs, ...recovered],
          );
        } catch (reason) {
          persistOperation({ ...latest, state: "unknown", updatedAt: Date.now(), error: describe(reason) });
          throw reason;
        }
      });
    },
    [mintUrl, persistOperation, runLocked, wallet],
  );

  const confirmCashOut = useCallback(
    async (preparation: CashOutPreparation): Promise<CashOutOperation> => {
      if (!wallet) throw new Error("The mint is not reachable.");
      const currentProofs = snapshotRef.current.proofs;
      if (preparation.proofFingerprint !== proofFingerprint(currentProofs)) {
        throw new Error("The wallet balance changed. Review the recalculated maximum debit before cashing out.");
      }
      const { quote, prepared } = preparation;
      saveWalletSnapshot(mintUrl, snapshotRef.current);
      const now = Date.now();
      const operation: CashOutOperation = {
        id: createOperationId(),
        kind: "cashout",
        state: "dispatching",
        amount: units(quote.amount),
        createdAt: now,
        updatedAt: now,
        mintUrl,
        unit: wallet.unit,
        invoice: quote.request,
        quote: storeMeltQuote(quote),
        cashuFee: prepared.inputFee,
        reservedProofs: prepared.reservedProofs,
        outputData: prepared.outputData,
        keysetId: prepared.keysetId,
      };
      persistOperation(operation, prepared.keep);

      try {
        const result = await wallet.executeMelt(quote, prepared);
        if (result.state === "PAID") {
          const paid: CashOutOperation = {
            ...operation,
            state: "paid",
            updatedAt: Date.now(),
            quote: { ...operation.quote, state: "PAID" },
            reservedProofs: undefined,
            outputData: undefined,
            keysetId: undefined,
          };
          persistOperation(paid, [...snapshotRef.current.proofs, ...result.change]);
          return paid;
        }
        const unresolved: CashOutOperation = {
          ...operation,
          state: result.state === "PENDING" ? "pending" : "unknown",
          updatedAt: Date.now(),
          quote: { ...operation.quote, state: result.state },
          outputData: result.outputData,
          error: result.state === "UNPAID" ? "The mint returned unpaid; check status to recover reserved value." : undefined,
        };
        persistOperation(unresolved);
        return unresolved;
      } catch (reason) {
        const unknown: CashOutOperation = {
          ...operation,
          state: "unknown",
          updatedAt: Date.now(),
          error: describe(reason),
        };
        persistOperation(unknown);
        return unknown;
      }
    },
    [mintUrl, persistOperation, wallet],
  );

  const refreshSend = useCallback(
    async (operation: SendOperation): Promise<void> => {
      if (!wallet) return;
      await runLocked(operation.id, async () => {
        if (operation.swap) {
          try {
            saveWalletSnapshot(mintUrl, snapshotRef.current);
            if (operation.token) {
              const proofs = await wallet.completePreparedReceive(operation.swap);
              persistOperation(
                { ...operation, state: "reclaimed", updatedAt: Date.now(), token: undefined, swap: undefined, error: undefined },
                [...snapshotRef.current.proofs, ...proofs],
              );
              setToast("Unaccepted token reclaimed");
            } else {
              const result = await wallet.completePreparedSend(operation.swap);
              persistOperation(
                { ...operation, state: "awaiting_acceptance", updatedAt: Date.now(), token: result.token, swap: undefined, error: undefined },
                [...snapshotRef.current.proofs, ...result.change],
              );
              setToast("Outgoing token prepared");
            }
          } catch (reason) {
            persistOperation({ ...operation, state: "recovery_required", updatedAt: Date.now(), error: describe(reason) });
            throw reason;
          }
          return;
        }
        if (operation.token) {
          const tokenState = await wallet.checkTokenState(operation.token);
          if (tokenState === "spent") {
            persistOperation({ ...operation, state: "accepted", updatedAt: Date.now(), token: undefined, error: undefined });
          } else if (tokenState === "mixed") {
            persistOperation({ ...operation, state: "recovery_required", updatedAt: Date.now(), error: "The token's proofs do not share one spend state." });
          }
        }
      });
    },
    [mintUrl, persistOperation, runLocked, wallet],
  );

  const reclaimSend = useCallback(
    async (operation: SendOperation): Promise<void> => {
      if (!wallet || !operation.token) throw new Error("The stored bearer token is unavailable.");
      const token = operation.token;
      await runLocked(operation.id, async () => {
        const tokenState = await wallet.checkTokenState(token);
        if (tokenState === "spent") {
          persistOperation({ ...operation, state: "accepted", updatedAt: Date.now(), token: undefined, error: undefined });
          return;
        }
        if (tokenState !== "unspent") {
          throw new Error("The token is not safely reclaimable yet.");
        }
        let reclaiming: SendOperation = { ...operation, state: "reclaiming", updatedAt: Date.now(), error: undefined };
        try {
          const swap = await wallet.prepareReceive(token);
          reclaiming = { ...reclaiming, swap };
          persistOperation(reclaiming);
          saveWalletSnapshot(mintUrl, snapshotRef.current);
          const proofs = await wallet.completePreparedReceive(swap);
          persistOperation(
            { ...reclaiming, state: "reclaimed", updatedAt: Date.now(), token: undefined, swap: undefined, error: undefined },
            [...snapshotRef.current.proofs, ...proofs],
          );
          setToast("Unaccepted token reclaimed");
        } catch (reason) {
          persistOperation({ ...reclaiming, state: "recovery_required", updatedAt: Date.now(), error: describe(reason) });
          throw reason;
        }
      });
    },
    [mintUrl, persistOperation, runLocked, wallet],
  );

  const refreshOperation = useCallback(
    async (operation: WalletOperation): Promise<void> => {
      if (operation.kind === "add") return refreshAdd(operation);
      if (operation.kind === "send") return refreshSend(operation);
      if (operation.kind === "receive") {
        await runLocked(operation.id, () => settleReceive(operation));
        return;
      }
      return refreshCashOut(operation);
    },
    [refreshAdd, refreshCashOut, refreshSend, runLocked, settleReceive],
  );

  const reclaimOperation = useCallback(
    async (operation: WalletOperation): Promise<void> => {
      if (operation.kind !== "send") throw new Error("Only an unaccepted outgoing token can be reclaimed here.");
      return reclaimSend(operation);
    },
    [reclaimSend],
  );

  const discardIncomingToken = useCallback(
    async (operation: WalletOperation): Promise<void> => {
      const discarded = await runLocked(operation.id, async () => {
        const latest = snapshotRef.current.operations.find((item) => item.id === operation.id);
        if (latest?.kind !== "receive" || !latest.token) {
          throw new Error("The stored incoming token is no longer available.");
        }
        if (latest.swap) {
          throw new Error("Recovery has already started. Keep the stored outputs until the mint returns a definitive result.");
        }
        const failed: ReceiveOperation = {
          ...latest,
          state: "failed",
          updatedAt: Date.now(),
          token: undefined,
          error: "The bearer token was removed from this device before settlement. No value was added to the balance.",
        };
        persistOperation(failed);
        return failed;
      });
      if (!discarded) throw new Error("This operation is being checked. Try removal again after the check finishes.");
    },
    [persistOperation, runLocked],
  );

  useEffect(() => {
    if (status !== "online" || !wallet) return;
    const refreshUnresolved = () => {
      snapshotRef.current.operations.filter(operationNeedsAttention).forEach((operation) => {
        void refreshOperation(operation).catch(() => undefined);
      });
    };
    refreshUnresolved();
    const interval = window.setInterval(refreshUnresolved, 12000);
    window.addEventListener("focus", refreshUnresolved);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshUnresolved);
    };
  }, [refreshOperation, status, wallet]);

  const navigate = (next: AppScreen) => {
    if (next !== "operation") setSelectedOperationId(null);
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const openOperation = (operation: WalletOperation) => {
    setSelectedOperationId(operation.id);
    setScreen("operation");
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const changeMint = (next: string) => {
    saveActiveMint(next);
    setMintUrl(next);
    setScreen("home");
    setSelectedOperationId(null);
  };

  const saveOpenRequest = useCallback(
    (request: DecodedPaymentRequest) => {
      const current = snapshotRef.current;
      commitSnapshot({ ...current, openRequest: request });
    },
    [commitSnapshot],
  );

  const clearOpenRequest = useCallback(() => {
    const current = snapshotRef.current;
    commitSnapshot({ ...current, openRequest: undefined });
  }, [commitSnapshot]);

  const ticker = wallet?.ticker ?? snapshot.unit?.toUpperCase() ?? profile?.unit.toUpperCase() ?? snapshot.operations[0]?.unit.toUpperCase() ?? DEFAULT_UNIT.toUpperCase();
  const mintName = profile?.name || safeHost(mintUrl);
  const selectedOperation = snapshot.operations.find((operation) => operation.id === selectedOperationId);
  const balance = sumProofs(snapshot.proofs);
  const orderedOperations = useMemo(
    () => [...snapshot.operations].sort((left, right) => right.createdAt - left.createdAt),
    [snapshot.operations],
  );

  let content;
  if (screen === "home") {
    content = <HomeScreen balance={balance} proofCount={snapshot.proofs.length} ticker={ticker} mintName={mintName} status={status} connectionError={connectionError} operations={orderedOperations} onNavigate={navigate} onOpenOperation={openOperation} onRetry={() => setReloadKey((value) => value + 1)} />;
  } else if (screen === "pay") {
    content = <PayScreen ticker={ticker} mintName={mintName} operations={orderedOperations} onPreparePayment={prepareOutgoing} onCreatePayment={createOutgoing} onDone={() => navigate("home")} />;
  } else if (screen === "request") {
    content = <RequestScreen ticker={ticker} mintUrl={mintUrl} mintName={mintName} online={status === "online"} operations={orderedOperations} savedRequest={snapshot.openRequest} onSaveRequest={saveOpenRequest} onClearRequest={clearOpenRequest} onReceive={receiveToken} onDone={() => navigate("home")} />;
  } else if (screen === "add") {
    content = <AddCashScreen ticker={ticker} mintName={mintName} online={status === "online"} operations={orderedOperations} onRequest={requestAdd} onRefresh={refreshAdd} onDone={() => navigate("home")} />;
  } else if (screen === "cashout") {
    content = <CashOutScreen balance={balance} ticker={ticker} mintName={mintName} online={status === "online"} operations={orderedOperations} onQuote={quoteCashOut} onPrepare={prepareCashOut} onConfirm={confirmCashOut} onRefresh={refreshCashOut} onDone={() => navigate("home")} />;
  } else if (screen === "activity") {
    content = <ActivityScreen operations={orderedOperations} onOpen={openOperation} />;
  } else if (screen === "operation" && selectedOperation) {
    content = <OperationDetailScreen operation={selectedOperation} ticker={ticker} online={status === "online"} onRefresh={refreshOperation} onReclaim={reclaimOperation} onDiscard={discardIncomingToken} />;
  } else if (screen === "mint") {
    content = <MintScreen mintUrl={mintUrl} ticker={ticker} network={NETWORK_LABEL} status={status} profile={profile} connectionError={connectionError} onChangeMint={changeMint} onRetry={() => setReloadKey((value) => value + 1)} />;
  } else {
    content = <ActivityScreen operations={orderedOperations} onOpen={openOperation} />;
  }

  return (
    <AppShell
      screen={screen}
      mintName={mintName}
      mintHost={safeHost(mintUrl)}
      network={NETWORK_LABEL}
      ticker={ticker}
      status={status}
      onNavigate={navigate}
      onBack={() => navigate(screen === "operation" ? "activity" : "home")}
      toast={toast}
    >
      {content}
    </AppShell>
  );
}
