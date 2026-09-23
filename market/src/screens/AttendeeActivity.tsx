import { ReceiptText, RefreshCw } from "lucide-react";
import { useState } from "react";

import { fmt } from "@wallet-lib/wallet";

import { Button, Notice, ScreenHeading, StatusBadge, type Tone } from "../components/Primitives";
import { safeErrorMessage } from "../domain/errors";
import { paymentCanCheck, paymentCanRetry, type AttendeePayment } from "../domain/types";
import type { MarketController } from "../hooks/useMarket";

function tone(payment: AttendeePayment): Tone {
  if (payment.state === "spent") return "settled";
  if (payment.state === "recoverable") return "recoverable";
  return "pending";
}

export function AttendeeActivity({ market }: { market: MarketController }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const payments = [...market.snapshot.payments].sort((left, right) => right.createdAt - left.createdAt);
  const recover = async (action: () => Promise<AttendeePayment>, fallback: string) => {
    setActionError(null);
    try {
      await action();
    } catch (reason) {
      setActionError(safeErrorMessage(reason, fallback));
    }
  };
  return (
    <div className="flow-column flow-enter">
      <ScreenHeading eyebrow="Stored locally" title="Payment activity">Delivery and proof consumption are shown separately. Vendor settlement is confirmed on the vendor device.</ScreenHeading>
      {actionError ? <Notice tone="failed">{actionError}</Notice> : null}
      {payments.length === 0 ? <div className="empty-state"><ReceiptText size={30} aria-hidden="true" /><h2>No attendee payments yet</h2><p>Scanned vendor orders will appear here without exposing their bearer payload.</p></div> : (
        <div className="activity-list">
          {payments.map((payment) => {
            const retry = paymentCanRetry(payment);
            const check = paymentCanCheck(payment);
            return (
              <article className="activity-entry" key={payment.id}>
                <div className="activity-entry__summary"><span><strong>{payment.description}</strong><small>{payment.vendorName} · {new Date(payment.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span><span><strong className="mono">−{fmt(payment.amount + payment.fee)} RUSD</strong><StatusBadge tone={tone(payment)}>{payment.state.replaceAll("_", " ")}</StatusBadge></span></div>
                {payment.error ? <Notice tone="recoverable">{payment.error}</Notice> : null}
                {retry ? <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void recover(() => market.retryPaymentDelivery(payment), "The stored payment could not be delivered.")}>Resume same payment</Button> : check ? <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void recover(() => market.checkPayment(payment), "The proof state could not be checked.")}>Check proof state</Button> : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
