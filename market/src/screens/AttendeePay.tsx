import { ArrowLeft, ArrowRight, CheckCircle2, RefreshCw, RotateCcw, ScanLine } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { fmt } from "@wallet-lib/wallet";

import { Button, Notice, ScreenHeading, StatusBadge, TextArea } from "../components/Primitives";
import { QrScanner } from "../components/QrScanner";
import { safeErrorMessage } from "../domain/errors";
import type { PaymentReview } from "../domain/market-runtime";
import {
  paymentCanCheck,
  paymentCanRefund,
  paymentCanRetry,
  paymentHasRefundPath,
  type AttendeePayment,
} from "../domain/types";
import type { MarketController } from "../hooks/useMarket";

type PayView = "scan" | "review" | "processing" | "result";

function paymentTone(payment: AttendeePayment): "neutral" | "pending" | "settled" | "recoverable" {
  if (payment.state === "refunded") return "settled";
  if (payment.state === "spent") return "neutral";
  if (payment.state === "recoverable") return "recoverable";
  return "pending";
}

function paymentLabel(payment: AttendeePayment): string {
  if (payment.state === "refunded") return "Refunded";
  if (payment.state === "refunding") return "Refund in progress";
  if (payment.state === "spent") return "Token spent";
  if (payment.state === "unspent") return "Waiting for vendor";
  if (payment.state === "pending") return "Issuer check pending";
  if (payment.state === "recoverable") return "Action required";
  if (payment.state === "delivered") return "Delivered";
  return "Preparing delivery";
}

export function AttendeePay({ market, onDone }: { market: MarketController; onDone: () => void }) {
  const [view, setView] = useState<PayView>("scan");
  const [encoded, setEncoded] = useState("");
  const [review, setReview] = useState<PaymentReview | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const payment = useMemo(() => market.snapshot.payments.find((item) => item.id === paymentId) ?? null, [market.snapshot.payments, paymentId]);
  const available = market.status === "online" && !market.storageError && !market.preview;

  useEffect(() => {
    if (!payment || !paymentHasRefundPath(payment) || ["refunded", "spent"].includes(payment.state)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [payment]);

  const read = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!encoded.trim()) {
      setError("Paste or scan a vendor payment request first.");
      return;
    }
    setLocalBusy(true);
    setError(null);
    try {
      const next = await market.reviewPayment(encoded.trim());
      setReview(next);
      setView("review");
    } catch (reason) {
      setError(safeErrorMessage(reason, "The payment request could not be read."));
    } finally {
      setLocalBusy(false);
    }
  };

  const confirm = async () => {
    if (!review) return;
    setView("processing");
    setError(null);
    try {
      const created = await market.confirmPayment(review);
      setPaymentId(created.id);
      setView("result");
    } catch (reason) {
      setError(safeErrorMessage(reason, "The payment could not be prepared."));
      setView("review");
    }
  };

  const recover = async (action: () => Promise<AttendeePayment>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(safeErrorMessage(reason, fallback));
    }
  };

  const acceptScan = useCallback((value: string) => {
    setEncoded(value);
    setError(null);
  }, []);

  if (view === "processing") {
    return (
      <div className="processing-state" role="status" aria-live="polite">
        <span className="processing-state__spinner" aria-hidden="true" />
        <h1>Preparing locked ecash</h1>
        <p>The exact token and recovery data are stored before delivery begins.</p>
      </div>
    );
  }

  if (view === "result" && payment) {
    const canRetry = paymentCanRetry(payment);
    const canCheck = paymentCanCheck(payment);
    const hasRefund = paymentHasRefundPath(payment);
    const canRefund = paymentCanRefund(payment, now);
    const refundAt = payment.refundLocktime ? new Date(payment.refundLocktime * 1000) : null;
    const resultCopy = payment.state === "refunded"
      ? `The mint returned ${fmt(payment.amount)} RUSD as fresh spendable proofs. The ${fmt(payment.fee)} RUSD proof fee is not refunded.`
      : payment.state === "spent"
        ? "The mint reports that the delivered token was consumed. This browser did not receive refund proofs, so no value was credited here."
        : payment.state === "refunding"
          ? "The refund request is stored. This screen will credit value only after the mint returns fresh proofs."
          : "The vendor can settle this payment with the mint. Delivery alone is not settlement.";
    const recoveryAction = canRefund
      ? <Button variant="secondary" icon={RotateCcw} busy={market.busy} onClick={() => void recover(() => market.refundPayment(payment), "The stored payment could not be refunded.")}>{payment.refundSwap ? "Resume refund" : "Refund if unspent"}</Button>
      : canRetry
        ? <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void recover(() => market.retryPaymentDelivery(payment), "The stored payment could not be delivered.")}>Resume payment</Button>
        : canCheck
          ? <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void recover(() => market.checkPayment(payment), "The proof state could not be checked.")}>Check proof state</Button>
          : <span />;
    return (
      <div className="flow-column flow-enter">
        <section className="payment-result">
          <StatusBadge tone={paymentTone(payment)}>{paymentLabel(payment)}</StatusBadge>
          <span className="eyebrow">{payment.vendorName}</span>
          <div className="payment-result__amount"><strong>{fmt(payment.amount)}</strong><span>RUSD</span></div>
          <h1>{payment.description}</h1>
          <p>{resultCopy}</p>
        </section>
        {payment.error ? <Notice tone="recoverable" title="Payment needs attention">{payment.error}</Notice> : null}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        {hasRefund && refundAt && !["refunded", "spent"].includes(payment.state) ? (
          <Notice tone={canRefund ? "recoverable" : "pending"} title={canRefund ? "Refund window open" : "Refund protected"}>
            {canRefund
              ? "You may ask the mint to refund this token if it is still unspent. The vendor key remains valid, so the first accepted mint swap wins."
              : `Only the vendor key can spend before ${refundAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. After that, either side may try and the first accepted mint swap wins.`}
          </Notice>
        ) : payment.state === "spent" ? <Notice tone="neutral">The bearer token is no longer retained here. Proof consumption does not identify which device completed the winning swap.</Notice> : null}
        <div className="split-actions">
          {recoveryAction}
          <Button icon={CheckCircle2} onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  if (view === "review" && review) {
    const remaining = review.balance - review.debit;
    return (
      <div className="flow-column flow-enter">
        <ScreenHeading eyebrow={review.validated.vendor.name} title={review.validated.request.description}>Review the exact debit before creating vendor-locked ecash.</ScreenHeading>
        <section className="review-ticket">
          <div className="review-ticket__amount"><strong>{fmt(review.validated.request.amount)}</strong><span>RUSD</span></div>
          <dl className="detail-list">
            <div><dt>Vendor</dt><dd>{review.validated.vendor.name}</dd></div>
            <div><dt>Issuing mint</dt><dd className="mono">{new URL(review.validated.request.mints[0]).host}</dd></div>
            <div><dt>Cashu proof fee</dt><dd className="mono">{fmt(review.fee)} RUSD</dd></div>
            <div><dt>Total debit</dt><dd className="mono">{fmt(review.debit)} RUSD</dd></div>
            <div className="detail-list__total"><dt>Balance after</dt><dd className="mono">{fmt(remaining)} RUSD</dd></div>
          </dl>
        </section>
        <Notice tone="recoverable" title="Timed refund protection">Only the vendor can spend before {new Date(review.refundLocktime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. After that, this wallet can request a refund if the token is still unspent. The first swap accepted by the mint wins.</Notice>
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions split-actions--confirm">
          <Button variant="secondary" icon={ArrowLeft} onClick={() => { setView("scan"); setReview(null); }}>Back</Button>
          <Button icon={ArrowRight} busy={market.busy} disabled={!available} onClick={() => void confirm()}>Pay {fmt(review.validated.request.amount)} RUSD</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="flow-column" onSubmit={(event) => void read(event)} noValidate>
      <ScreenHeading eyebrow="One-scan checkout" title="Scan the vendor order">The request is decoded on this device before any proofs are selected.</ScreenHeading>
      {!available ? <Notice tone="recoverable">The mint must be reachable and live mode must be active before payment.</Notice> : null}
      <QrScanner label="Scan a vendor payment request" onResult={acceptScan} />
      <div className="or-divider"><span>or paste</span></div>
      <TextArea
        id="payment-request"
        label="Cashu payment request"
        value={encoded}
        onChange={(value) => { setEncoded(value); setError(null); }}
        placeholder="creq..."
        hint="Only a request for this event, mint, relay, vendor, and RUSD unit is accepted."
        error={error}
        rows={4}
      />
      <Button type="submit" icon={ScanLine} busy={localBusy} disabled={!available}>Review payment</Button>
    </form>
  );
}
