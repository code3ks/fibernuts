import { ArrowRight, Minus, Plus, RotateCcw, ShoppingBasket } from "lucide-react";
import { useMemo, useState } from "react";

import { fmt, parseAmount } from "@wallet-lib/wallet";

import { Button, IconButton, Notice, ScreenHeading } from "../components/Primitives";
import { safeErrorMessage } from "../domain/errors";
import type { OrderItem, VendorOrder } from "../domain/types";
import { EVENT } from "../event/manifest";
import type { MarketController } from "../hooks/useMarket";

export function VendorSell({ market, onOrder }: { market: MarketController; onOrder: (order: VendorOrder) => void }) {
  const vendor = EVENT.vendors[0];
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [tip, setTip] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo<OrderItem[]>(() => vendor.catalog.flatMap((catalogItem) => {
    if (catalogItem.price === "custom") {
      const parsed = parseAmount(tip);
      return parsed ? [{ itemId: catalogItem.id, label: catalogItem.label, quantity: 1, unitPrice: parsed }] : [];
    }
    const quantity = quantities[catalogItem.id] ?? 0;
    return quantity > 0 ? [{ itemId: catalogItem.id, label: catalogItem.label, quantity, unitPrice: catalogItem.price }] : [];
  }), [quantities, tip, vendor.catalog]);
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const available = market.status === "online" && !market.storageError && !market.preview;

  const adjust = (id: string, amount: number) => {
    setReviewing(false);
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(20, (current[id] ?? 0) + amount)) }));
  };

  const create = async () => {
    setError(null);
    try {
      const order = await market.createOrder(items);
      onOrder(order);
    } catch (reason) {
      setError(safeErrorMessage(reason, "The order could not be created."));
    }
  };

  if (reviewing) {
    return (
      <div className="flow-column flow-enter">
        <ScreenHeading eyebrow="Final review" title="Charge this order?">A payable request exists only after the delivery slot is stored and registered.</ScreenHeading>
        <section className="order-review">
          <div className="order-review__lines">
            {items.map((item) => <div key={item.itemId}><span>{item.quantity} × {item.label}</span><strong>{fmt(item.quantity * item.unitPrice)} RUSD</strong></div>)}
          </div>
          <div className="order-review__total"><span>Total</span><strong>{fmt(total)} RUSD</strong></div>
        </section>
        <Notice tone="neutral">The payment request accepts only RUSD ecash from {new URL(EVENT.mintUrl).host} and locks proofs to this browser's vendor key.</Notice>
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions split-actions--confirm">
          <Button variant="secondary" onClick={() => setReviewing(false)}>Edit order</Button>
          <Button icon={ArrowRight} busy={market.busy} disabled={!available} onClick={() => void create()}>Create charge</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="sell-layout flow-enter">
      <div>
        <ScreenHeading eyebrow={vendor.location} title={vendor.name}>Build the next order, then hand the screen to the attendee to scan.</ScreenHeading>
        {!available ? <Notice tone="recoverable">{market.preview ? "Preview data cannot create a real charge." : "The mint must be reachable before a charge can be created."}</Notice> : null}
        <div className="catalog-list">
          {vendor.catalog.map((item) => item.price === "custom" ? (
            <div className="catalog-row catalog-row--custom" key={item.id}>
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
              <label><span>RUSD</span><input aria-label="Contributor tip amount" inputMode="decimal" value={tip} placeholder="0.00" onChange={(event) => { setTip(event.target.value); setReviewing(false); }} /></label>
            </div>
          ) : (
            <div className="catalog-row" key={item.id}>
              <span><strong>{item.label}</strong><small>{item.description}</small><em>{fmt(item.price)} RUSD</em></span>
              <div className="quantity-control">
                <IconButton label={`Remove one ${item.label}`} icon={Minus} disabled={(quantities[item.id] ?? 0) === 0} onClick={() => adjust(item.id, -1)} />
                <output aria-label={`${item.label} quantity`}>{quantities[item.id] ?? 0}</output>
                <IconButton label={`Add one ${item.label}`} icon={Plus} onClick={() => adjust(item.id, 1)} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <aside className="cart-till" aria-label="Current order total">
        <div><ShoppingBasket size={19} aria-hidden="true" /><span>{items.reduce((sum, item) => sum + item.quantity, 0)} items</span></div>
        <strong>{fmt(total)} <small>RUSD</small></strong>
        <Button icon={ArrowRight} disabled={total <= 0 || !available} onClick={() => { setError(null); setReviewing(true); }}>Review charge</Button>
        <button type="button" className="clear-order" disabled={total <= 0} onClick={() => { setQuantities({}); setTip(""); }}><RotateCcw size={15} aria-hidden="true" /> Clear</button>
      </aside>
    </div>
  );
}
