import {
  CalendarDays,
  Landmark,
  ListOrdered,
  ReceiptText,
  ScanLine,
  ShoppingBasket,
  Store,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { MarketConnectionStatus } from "../hooks/useMarket";
import type { MarketRole } from "../domain/types";
import { EVENT } from "../event/manifest";

export type AttendeeScreen = "event" | "pay" | "cash" | "activity";
export type VendorScreen = "sell" | "order" | "orders" | "cash";
export type MarketScreen = AttendeeScreen | VendorScreen;

interface NavItem {
  id: MarketScreen;
  label: string;
  icon: LucideIcon;
}

const ATTENDEE_NAV: NavItem[] = [
  { id: "event", label: "Event", icon: CalendarDays },
  { id: "pay", label: "Pay", icon: ScanLine },
  { id: "cash", label: "Cash", icon: WalletCards },
  { id: "activity", label: "Activity", icon: ReceiptText },
];

const VENDOR_NAV: NavItem[] = [
  { id: "sell", label: "Sell", icon: ShoppingBasket },
  { id: "order", label: "Order", icon: ReceiptText },
  { id: "orders", label: "Orders", icon: ListOrdered },
  { id: "cash", label: "Cash", icon: Landmark },
];

const TITLE: Record<MarketScreen, string> = {
  event: "Community market",
  pay: "Pay a vendor",
  cash: "RUSD ecash",
  activity: "Activity",
  sell: "New sale",
  order: "Current order",
  orders: "Orders",
};

function statusLabel(status: MarketConnectionStatus): string {
  if (status === "online") return "Mint reachable";
  if (status === "connecting") return "Checking mint";
  if (status === "preview") return "Preview data";
  if (status === "incompatible") return "Mint incompatible";
  return "Mint unavailable";
}

export function Shell({
  role,
  screen,
  status,
  mintName,
  balance,
  toast,
  children,
  onNavigate,
}: {
  role: MarketRole;
  screen: MarketScreen;
  status: MarketConnectionStatus;
  mintName: string;
  balance: string;
  toast: string | null;
  children: ReactNode;
  onNavigate: (screen: MarketScreen) => void;
}) {
  const nav = role === "attendee" ? ATTENDEE_NAV : VENDOR_NAV;
  const switchHref = role === "attendee" ? "/vendor" : "/";
  return (
    <div className="app-canvas">
      <div className="network-tape">
        <span>{EVENT.networkLabel}</span>
        <span aria-hidden="true">/</span>
        <span>RUSD test value only</span>
        {status === "preview" ? <><span aria-hidden="true">/</span><strong>Preview data</strong></> : null}
      </div>
      <div className="app-frame">
        <aside className="sidebar">
          <div className="brand-block">
            <span className="brand-mark" aria-hidden="true" />
            <span><strong>FiberNuts</strong><small>Community Market</small></span>
          </div>
          <div className="role-label"><Store size={15} aria-hidden="true" /> {role === "attendee" ? "Attendee" : "Vendor terminal"}</div>
          <nav aria-label={`${role} navigation`}>
            {nav.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={screen === id ? "nav-item nav-item--active" : "nav-item"} onClick={() => onNavigate(id)}>
                <Icon size={18} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar__footer">
            <div className="mint-summary">
              <span className={`connection-dot connection-dot--${status}`} aria-hidden="true" />
              <span><strong>{mintName}</strong><small>{statusLabel(status)}</small></span>
            </div>
            <a href={switchHref} className="role-switch">Switch to {role === "attendee" ? "vendor" : "attendee"}</a>
          </div>
        </aside>
        <div className="app-surface">
          <header className="mobile-header">
            <div className="brand-block brand-block--compact"><span className="brand-mark" aria-hidden="true" /><strong>FiberNuts</strong></div>
            <div className="mobile-header__title"><strong>{TITLE[screen]}</strong><small>{balance} RUSD ecash</small></div>
            <span className={`connection-dot connection-dot--${status}`} title={statusLabel(status)} aria-label={statusLabel(status)} />
          </header>
          <header className="desktop-header">
            <div><span className="eyebrow">{role === "attendee" ? "Attendee" : "Vendor"}</span><h2>{TITLE[screen]}</h2></div>
            <div className="desktop-header__balance"><span>Spendable</span><strong>{balance} RUSD</strong></div>
          </header>
          <main className="screen" id="main-content">{children}</main>
          <nav className="mobile-nav" aria-label={`${role} navigation`}>
            {nav.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={screen === id ? "mobile-nav__item mobile-nav__item--active" : "mobile-nav__item"} onClick={() => onNavigate(id)}>
                <Icon size={19} aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
