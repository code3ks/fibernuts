import { ReceiptText } from "lucide-react";

import { fmt } from "@wallet-lib/wallet";

import { ScreenHeading, StatusBadge, type Tone } from "../components/Primitives";
import type { VendorOrder } from "../domain/types";
import type { MarketController } from "../hooks/useMarket";

function tone(order: VendorOrder): Tone {
  if (order.state === "settled") return "settled";
  if (["cancelled", "expired", "rejected"].includes(order.state)) return "failed";
  if (order.state === "recoverable") return "recoverable";
  return "pending";
}

function label(order: VendorOrder): string {
  return order.state === "settled" ? "Paid" : order.state.replaceAll("_", " ");
}

export function VendorOrders({ market, onOpen }: { market: MarketController; onOpen: (id: string) => void }) {
  const orders = [...market.snapshot.orders].sort((left, right) => {
    const leftTerminal = ["settled", "cancelled", "expired", "rejected"].includes(left.state);
    const rightTerminal = ["settled", "cancelled", "expired", "rejected"].includes(right.state);
    return Number(leftTerminal) - Number(rightTerminal) || right.createdAt - left.createdAt;
  });
  return (
    <div className="flow-column flow-enter">
      <ScreenHeading eyebrow="Local register" title="Orders">Unresolved orders stay first and keep their recovery state in this browser.</ScreenHeading>
      {orders.length === 0 ? <div className="empty-state"><ReceiptText size={30} aria-hidden="true" /><h2>No orders yet</h2><p>Completed and unresolved charges will appear here.</p></div> : (
        <div className="activity-list">
          {orders.map((order) => (
            <button type="button" className="activity-row" key={order.id} onClick={() => onOpen(order.id)}>
              <span><strong>{order.description}</strong><small>{new Date(order.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span>
              <span><strong className="mono">{fmt(order.amount)} RUSD</strong><StatusBadge tone={tone(order)}>{label(order)}</StatusBadge></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
