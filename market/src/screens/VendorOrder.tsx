import { Ban, CheckCircle2, Clock3, RefreshCw, ShoppingBasket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fmt } from "@wallet-lib/wallet";

import { Button, Notice, QrPanel, ScreenHeading, StatusBadge, type Tone } from "../components/Primitives";
import { safeErrorMessage } from "../domain/errors";
import type { VendorOrder as VendorOrderRecord } from "../domain/types";
import type { MarketController } from "../hooks/useMarket";

function orderPresentation(order: VendorOrderRecord): { label: string; tone: Tone; detail: string } {
  switch (order.state) {
    case "registering": return { label: "Registering", tone: "pending", detail: "Creating a durable delivery slot." };
    case "awaiting_payment": return { label: "Ready to scan", tone: "pending", detail: "Waiting for the attendee payment." };
    case "cancelling": return { label: "Cancelling", tone: "pending", detail: "Resolving whether delivery already won." };
    case "payload_received": return { label: "Token received", tone: "pending", detail: "Stored locally before relay acknowledgement." };
    case "validating": return { label: "Checking issuer", tone: "pending", detail: "Verifying amount, mint, lock, and proof state." };
    case "swapping": return { label: "Securing payment", tone: "pending", detail: "Asking the mint for fresh vendor proofs." };
    case "settled": return { label: "Paid", tone: "settled", detail: "Fresh proofs are persisted in the vendor balance." };
    case "cancelled": return { label: "Cancelled", tone: "neutral", detail: "The delivery slot closed before a payload arrived." };
    case "expired": return { label: "Expired", tone: "failed", detail: "No delivered payload was found before expiry." };
    case "rejected": return { label: "Rejected", tone: "failed", detail: order.error ?? "The delivered token failed validation." };
    case "recoverable": return { label: "Recovery required", tone: "recoverable", detail: order.error ?? "Stored state can be checked again." };
  }
}

export function VendorOrder({ market, orderId, onNewSale }: { market: MarketController; orderId: string | null; onNewSale: () => void }) {
  const [, setClock] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const order = useMemo(() => {
    if (orderId) return market.snapshot.orders.find((item) => item.id === orderId) ?? null;
    return [...market.snapshot.orders].sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  }, [market.snapshot.orders, orderId]);

  useEffect(() => {
    if (!order || order.state !== "awaiting_payment") return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [order]);

  if (!order) {
    return (
      <div className="empty-state">
        <ShoppingBasket size={30} aria-hidden="true" />
        <h1>No active order</h1>
        <p>Build a cart to create the first vendor charge.</p>
        <Button onClick={onNewSale}>Start a sale</Button>
      </div>
    );
  }

  const presentation = orderPresentation(order);
  const seconds = Math.max(0, order.expiresAt - Math.floor(Date.now() / 1000));
  const terminal = ["settled", "cancelled", "expired", "rejected"].includes(order.state);
  const canCancel = order.state === "awaiting_payment";
  const canCheck = !terminal || (order.state === "settled" && !order.relayAcknowledged);

  const check = async () => {
    setError(null);
    try { await market.pollOrder(order); }
    catch (reason) { setError(safeErrorMessage(reason, "The order could not be checked.")); }
  };
  const cancel = async () => {
    setError(null);
    try { await market.cancelOrder(order); }
    catch (reason) { setError(safeErrorMessage(reason, "The order could not be cancelled.")); }
  };

  return (
    <div className="flow-column flow-enter">
      <ScreenHeading eyebrow={order.description} title={order.state === "settled" ? "Payment settled" : "Customer order"}>Relay delivery and mint settlement remain separate states.</ScreenHeading>
      <section className="charge-ticket">
        <div className="charge-ticket__head"><StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>{order.state === "awaiting_payment" ? <span className="expiry"><Clock3 size={14} aria-hidden="true" /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : null}</div>
        <div className="charge-ticket__amount"><strong>{fmt(order.amount)}</strong><span>RUSD</span></div>
        <div className="charge-ticket__items">{order.items.map((item) => <span key={item.itemId}>{item.quantity} × {item.label}</span>)}</div>
        {order.state === "awaiting_payment" && order.request ? <QrPanel value={order.request} label="Payment request" size={220} /> : null}
        {order.state === "settled" ? <div className="settlement-stamp"><CheckCircle2 size={22} aria-hidden="true" /> Fresh proofs stored</div> : null}
      </section>
      <Notice tone={presentation.tone} title={presentation.label}>{presentation.detail}</Notice>
      {order.state === "awaiting_payment" ? <Notice tone="neutral">The QR contains a public payment request, not wallet proofs. The returned payment is locked to this order's vendor key.</Notice> : null}
      {order.error && order.state !== "recoverable" && order.state !== "rejected" ? <Notice tone="recoverable">{order.error}</Notice> : null}
      {error ? <Notice tone="failed">{error}</Notice> : null}
      <div className="split-actions">
        {canCancel ? <Button variant="danger" icon={Ban} busy={market.busy} onClick={() => void cancel()}>Cancel charge</Button> : terminal && canCheck ? <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void check()}>Finish cleanup</Button> : <span />}
        {terminal ? <Button icon={ShoppingBasket} onClick={onNewSale}>Next sale</Button> : <Button variant="secondary" icon={RefreshCw} busy={market.busy} onClick={() => void check()}>Refresh</Button>}
      </div>
    </div>
  );
}
