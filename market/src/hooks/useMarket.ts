import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AddCashOperation, CashOutOperation } from "@wallet-domain/operations";
import { FibernutsWallet, MintCompatibilityError, sumProofs, type MeltQuote, type MintProfile } from "@wallet-lib/wallet";

import { EVENT, PREVIEW_MODE } from "../event/manifest";
import {
  MarketRuntime,
  type CashOutReview,
  type PaymentReview,
} from "../domain/market-runtime";
import { previewSnapshot } from "../domain/preview";
import {
  MarketStorageError,
  emptyMarketSnapshot,
  loadMarketSnapshot,
  marketStorageKey,
  saveMarketSnapshot,
} from "../domain/storage";
import { safeErrorMessage } from "../domain/errors";
import {
  FaucetClient,
  faucetClientId,
  type FaucetClaim,
  type FaucetConfig,
} from "../domain/faucet";
import type { AttendeePayment, MarketRole, MarketSnapshot, OrderItem, VendorOrder } from "../domain/types";

export type MarketConnectionStatus = "connecting" | "online" | "offline" | "incompatible" | "preview";
export type FaucetConnectionStatus = "loading" | "available" | "paused" | "unavailable" | "preview";

const faucetClient = new FaucetClient(EVENT.faucet.origin);

interface InitialState {
  snapshot: MarketSnapshot;
  error: string | null;
}

function describe(reason: unknown): string {
  return safeErrorMessage(reason);
}

function initialState(role: MarketRole): InitialState {
  if (PREVIEW_MODE) return { snapshot: previewSnapshot(EVENT, role), error: null };
  try {
    return { snapshot: loadMarketSnapshot(EVENT, role), error: null };
  } catch (reason) {
    return {
      snapshot: emptyMarketSnapshot(EVENT, role),
      error: describe(reason),
    };
  }
}

export interface MarketController {
  role: MarketRole;
  snapshot: MarketSnapshot;
  balance: number;
  profile: MintProfile | null;
  status: MarketConnectionStatus;
  connectionError: string | null;
  storageError: string | null;
  busy: boolean;
  toast: string | null;
  preview: boolean;
  faucetConfig: FaucetConfig | null;
  faucetStatus: FaucetConnectionStatus;
  faucetError: string | null;
  retryConnection: () => void;
  retryFaucet: () => void;
  reviewPayment: (encoded: string) => Promise<PaymentReview>;
  confirmPayment: (review: PaymentReview) => Promise<AttendeePayment>;
  retryPaymentDelivery: (payment: AttendeePayment) => Promise<AttendeePayment>;
  checkPayment: (payment: AttendeePayment) => Promise<AttendeePayment>;
  createOrder: (items: OrderItem[]) => Promise<VendorOrder>;
  pollOrder: (order: VendorOrder) => Promise<VendorOrder>;
  cancelOrder: (order: VendorOrder) => Promise<VendorOrder>;
  requestAddCash: (amount: number) => Promise<AddCashOperation>;
  requestTestCash: () => Promise<AddCashOperation>;
  fundTestCash: (operation: AddCashOperation) => Promise<FaucetClaim>;
  refreshAddCash: (operation: AddCashOperation) => Promise<AddCashOperation>;
  quoteCashOut: (invoice: string) => Promise<MeltQuote>;
  reviewCashOut: (quote: MeltQuote) => Promise<CashOutReview>;
  confirmCashOut: (review: CashOutReview) => Promise<CashOutOperation>;
  refreshCashOut: (operation: CashOutOperation) => Promise<CashOutOperation>;
}

export function useMarket(role: MarketRole): MarketController {
  const initial = useMemo(() => initialState(role), [role]);
  const [snapshot, setSnapshot] = useState(initial.snapshot);
  const [wallet, setWallet] = useState<FibernutsWallet | null>(null);
  const [profile, setProfile] = useState<MintProfile | null>(null);
  const [status, setStatus] = useState<MarketConnectionStatus>(PREVIEW_MODE ? "preview" : "connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [faucetConfig, setFaucetConfig] = useState<FaucetConfig | null>(null);
  const [faucetStatus, setFaucetStatus] = useState<FaucetConnectionStatus>(PREVIEW_MODE ? "preview" : "loading");
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetReloadKey, setFaucetReloadKey] = useState(0);
  const snapshotRef = useRef(snapshot);
  const inFlightRef = useRef(false);

  const commit = useCallback((next: MarketSnapshot) => {
    if (!PREVIEW_MODE) saveMarketSnapshot(EVENT, next);
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const reloadStoredSnapshot = useCallback(() => {
    if (PREVIEW_MODE) return snapshotRef.current;
    const fresh = loadMarketSnapshot(EVENT, role);
    snapshotRef.current = fresh;
    setSnapshot(fresh);
    return fresh;
  }, [role]);

  useEffect(() => {
    if (PREVIEW_MODE) return;
    let cancelled = false;
    setWallet(null);
    setProfile(null);
    setStatus("connecting");
    setConnectionError(null);
    if (!("locks" in navigator)) {
      setStatus("incompatible");
      setConnectionError("This browser cannot coordinate payment operations across tabs. Use a current Chromium browser for this testnet demo.");
      return;
    }
    const nextWallet = new FibernutsWallet(EVENT.mintUrl);
    void nextWallet.load().then(() => {
      if (cancelled) return;
      if (nextWallet.unit.toLowerCase() !== EVENT.unit) {
        setStatus("incompatible");
        setProfile(nextWallet.profile);
        setConnectionError(`This mint advertises ${nextWallet.ticker}, not RUSD. Stored value was not changed.`);
        return;
      }
      setWallet(nextWallet);
      setProfile(nextWallet.profile);
      setStatus("online");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof MintCompatibilityError) {
        setStatus("incompatible");
        try { setProfile(nextWallet.profile); } catch { setProfile(null); }
      } else {
        setStatus("offline");
      }
      setConnectionError(describe(reason));
    });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    if (PREVIEW_MODE) return;
    let cancelled = false;
    setFaucetConfig(null);
    setFaucetStatus("loading");
    setFaucetError(null);
    void faucetClient.config().then((next) => {
      if (cancelled) return;
      if (next.mint !== EVENT.mintUrl || next.unit !== EVENT.unit || next.network !== EVENT.network) {
        throw new Error("The community faucet is configured for a different mint, asset, or network.");
      }
      setFaucetConfig(next);
      setFaucetStatus(next.enabled ? "available" : "paused");
      if (!next.enabled) setFaucetError("Today's community claim budget is unavailable.");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setFaucetStatus("unavailable");
      setFaucetError(describe(reason));
    });
    return () => { cancelled = true; };
  }, [faucetReloadKey]);

  useEffect(() => {
    if (PREVIEW_MODE) return;
    const key = marketStorageKey(EVENT, role);
    const sync = (event: StorageEvent) => {
      if (event.key !== key) return;
      try {
        reloadStoredSnapshot();
        setStorageError(null);
      } catch (reason) {
        setStorageError(describe(reason));
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [reloadStoredSnapshot, role]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runtime = useMemo(() => wallet ? new MarketRuntime({
    manifest: EVENT,
    vendor: EVENT.vendors[0],
    wallet,
    getSnapshot: () => snapshotRef.current,
    commit,
    notify: setToast,
  }) : null, [commit, wallet]);

  const requireRuntime = useCallback(() => {
    if (PREVIEW_MODE) throw new Error("Preview data cannot perform network or value-moving actions.");
    if (storageError) throw new MarketStorageError("Stored market data must be repaired before moving value.");
    if (!runtime || status !== "online") throw new Error("The configured mint is not available.");
    return runtime;
  }, [runtime, status, storageError]);

  const runLocked = useCallback(async <T,>(task: (active: MarketRuntime) => Promise<T>): Promise<T> => {
    if (inFlightRef.current) throw new Error("Another payment operation is already in progress.");
    const active = requireRuntime();
    inFlightRef.current = true;
    setBusy(true);
    try {
      let result: T | undefined;
      await navigator.locks.request(`fibernuts:${EVENT.id}:${role}:${EVENT.mintUrl}`, { mode: "exclusive" }, async () => {
        reloadStoredSnapshot();
        result = await task(active);
      });
      if (result === undefined) throw new Error("The payment operation did not return a result.");
      return result;
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, [reloadStoredSnapshot, requireRuntime, role]);

  const reviewPayment = useCallback(async (encoded: string) => {
    reloadStoredSnapshot();
    return requireRuntime().reviewPayment(encoded);
  }, [reloadStoredSnapshot, requireRuntime]);

  const confirmPayment = useCallback((review: PaymentReview) => runLocked((active) => active.confirmPayment(review)), [runLocked]);
  const retryPaymentDelivery = useCallback((payment: AttendeePayment) => runLocked((active) => active.deliverStoredPayment(payment)), [runLocked]);
  const checkPayment = useCallback((payment: AttendeePayment) => runLocked((active) => active.checkPayment(payment)), [runLocked]);
  const createOrder = useCallback((items: OrderItem[]) => runLocked((active) => active.createOrder(items)), [runLocked]);
  const pollOrder = useCallback((order: VendorOrder) => runLocked(async (active) => {
    if (order.state === "cancelling") return active.cancelOrder(order);
    if (!order.relayRegistered && !order.incomingToken && !order.incomingSwap) return active.registerStoredOrder(order);
    return active.pollOrder(order);
  }), [runLocked]);
  const cancelOrder = useCallback((order: VendorOrder) => runLocked((active) => active.cancelOrder(order)), [runLocked]);
  const requestAddCash = useCallback((amount: number) => runLocked((active) => active.requestAddCash(amount)), [runLocked]);
  const requestTestCash = useCallback(() => {
    if (!faucetConfig || faucetStatus !== "available") throw new Error(faucetError ?? "The community faucet is not available.");
    return runLocked((active) => active.requestTestCash(faucetConfig.amount));
  }, [faucetConfig, faucetError, faucetStatus, runLocked]);
  const fundTestCash = useCallback((operation: AddCashOperation) => runLocked(async (active) => {
    if (
      operation.fundingSource !== "faucet" ||
      operation.mintUrl !== EVENT.mintUrl || operation.unit !== EVENT.unit ||
      (faucetConfig !== null && operation.amount !== faucetConfig.amount)
    ) {
      throw new Error("This stored mint quote does not match the community faucet.");
    }
    const current = snapshotRef.current.addCash.find((item) => item.id === operation.id);
    if (!current || current.quoteId !== operation.quoteId) throw new Error("The stored claim could not be found.");
    const claim = await faucetClient.claim(current.quoteId, faucetClientId(EVENT.faucet.origin));
    if (claim.status === "failed") active.recordTestCashPayerFailure(current, claim.message);
    return claim;
  }), [faucetConfig, runLocked]);
  const refreshAddCash = useCallback(async (operation: AddCashOperation) => {
    const refreshed = await runLocked((active) => active.refreshAddCash(operation));
    if (refreshed.fundingSource === "faucet" && refreshed.state === "settled") {
      void faucetClient.claim(refreshed.quoteId, faucetClientId(EVENT.faucet.origin)).catch(() => undefined);
    }
    return refreshed;
  }, [runLocked]);
  const quoteCashOut = useCallback((invoice: string) => requireRuntime().quoteCashOut(invoice), [requireRuntime]);
  const reviewCashOut = useCallback((quote: MeltQuote) => {
    reloadStoredSnapshot();
    return requireRuntime().reviewCashOut(quote);
  }, [reloadStoredSnapshot, requireRuntime]);
  const confirmCashOut = useCallback((review: CashOutReview) => runLocked((active) => active.confirmCashOut(review)), [runLocked]);
  const refreshCashOut = useCallback((operation: CashOutOperation) => runLocked((active) => active.refreshCashOut(operation)), [runLocked]);

  useEffect(() => {
    if (!runtime || status !== "online" || PREVIEW_MODE || storageError) return;
    const resume = () => {
      if (inFlightRef.current) return;
      const current = snapshotRef.current;
      const order = current.orders.find((item) => (
        ["registering", "awaiting_payment", "cancelling", "payload_received", "validating", "swapping", "recoverable"].includes(item.state) ||
        (item.state === "settled" && !item.relayAcknowledged && item.readCapability)
      ));
      if (role === "vendor" && order) {
        void pollOrder(order).catch(() => undefined);
        return;
      }
      const payment = current.payments.find((item) => ["delivered", "unspent", "pending"].includes(item.state));
      if (role === "attendee" && payment) {
        void checkPayment(payment).catch(() => undefined);
        return;
      }
      const add = current.addCash.find((item) => ["awaiting_payment", "payment_observed", "issuing", "recoverable"].includes(item.state));
      if (add) {
        void refreshAddCash(add).catch(() => undefined);
        return;
      }
      const cashOut = current.cashOut.find((item) => ["dispatching", "pending", "unknown"].includes(item.state));
      if (cashOut) void refreshCashOut(cashOut).catch(() => undefined);
    };
    const initialTimer = window.setTimeout(resume, role === "vendor" ? 800 : 1800);
    const interval = window.setInterval(resume, role === "vendor" ? 4000 : 10000);
    window.addEventListener("focus", resume);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", resume);
    };
  }, [checkPayment, pollOrder, refreshAddCash, refreshCashOut, role, runtime, status, storageError]);

  return {
    role,
    snapshot,
    balance: sumProofs(snapshot.proofs),
    profile,
    status,
    connectionError,
    storageError,
    busy,
    toast,
    preview: PREVIEW_MODE,
    faucetConfig,
    faucetStatus,
    faucetError,
    retryConnection: () => setReloadKey((value) => value + 1),
    retryFaucet: () => setFaucetReloadKey((value) => value + 1),
    reviewPayment,
    confirmPayment,
    retryPaymentDelivery,
    checkPayment,
    createOrder,
    pollOrder,
    cancelOrder,
    requestAddCash,
    requestTestCash,
    fundTestCash,
    refreshAddCash,
    quoteCashOut,
    reviewCashOut,
    confirmCashOut,
    refreshCashOut,
  };
}
