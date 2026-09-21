import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  CircleDot,
  Home,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { primaryScreen, SCREEN_TITLES, type AppScreen } from "../domain/navigation";
import { Brand } from "./Primitives";

const NAVIGATION: Array<{ screen: "home" | "pay" | "request" | "activity"; label: string; icon: LucideIcon }> = [
  { screen: "home", label: "Home", icon: Home },
  { screen: "pay", label: "Pay", icon: ArrowUpRight },
  { screen: "request", label: "Request", icon: ArrowDownLeft },
  { screen: "activity", label: "Activity", icon: Activity },
];

export type MintConnectionStatus = "connecting" | "online" | "offline" | "incompatible";

export function AppShell({
  screen,
  mintName,
  mintHost,
  network,
  ticker,
  status,
  onNavigate,
  onBack,
  children,
  toast,
}: {
  screen: AppScreen;
  mintName: string;
  mintHost: string;
  network: string;
  ticker: string;
  status: MintConnectionStatus;
  onNavigate: (screen: AppScreen) => void;
  onBack: () => void;
  children: ReactNode;
  toast?: string | null;
}) {
  const active = primaryScreen(screen);
  const isHome = screen === "home";

  return (
    <div className="app-canvas">
      <div className="network-tape" role="status">
        <span>{network}</span>
        <span aria-hidden="true">/</span>
        <span>{ticker} ecash</span>
        <span aria-hidden="true">/</span>
        <span>{status === "online" ? "Mint compatible" : status === "connecting" ? "Checking mint" : status === "incompatible" ? "Mint incompatible" : "Mint unavailable"}</span>
      </div>

      <div className="app-frame">
        <aside className="desktop-sidebar" aria-label="Wallet navigation">
          <Brand />
          <nav className="desktop-nav">
            {NAVIGATION.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.screen}
                  className={active === item.screen ? "desktop-nav__item desktop-nav__item--active" : "desktop-nav__item"}
                  aria-current={active === item.screen ? "page" : undefined}
                  onClick={() => onNavigate(item.screen)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <button type="button" className="sidebar-mint" onClick={() => onNavigate("mint")}>
            <span className={`connection-dot connection-dot--${status}`} aria-hidden="true" />
            <span className="sidebar-mint__copy">
              <strong>{mintName}</strong>
              <span>{mintHost}</span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <p className="sidebar-trust">The mint controls redemption for {ticker}. Reachable is not proof of asset identity or solvency.</p>
        </aside>

        <section className="app-surface">
          <header className="mobile-header">
            {isHome ? (
              <>
                <Brand compact />
                <button type="button" className="mint-chip" onClick={() => onNavigate("mint")}>
                  <span className={`connection-dot connection-dot--${status}`} aria-hidden="true" />
                  <span>
                    <strong>{mintName}</strong>
                    <small>{mintHost}</small>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <button type="button" className="back-button" onClick={onBack} aria-label="Go back" title="Go back">
                  <ArrowLeft size={19} aria-hidden="true" />
                </button>
                <div className="mobile-header__title">
                  <strong>{SCREEN_TITLES[screen]}</strong>
                  <span>{mintHost}</span>
                </div>
                <span className={`connection-dot connection-dot--${status}`} aria-label={`Mint ${status}`} />
              </>
            )}
          </header>

          <header className="desktop-content-header">
            <div>
              <span className="eyebrow">FiberNuts wallet</span>
              <h1>{SCREEN_TITLES[screen]}</h1>
            </div>
            <button type="button" className="desktop-mint-chip" onClick={() => onNavigate("mint")}>
              <span className={`connection-dot connection-dot--${status}`} aria-hidden="true" />
              <span>{mintName}</span>
              <span className="mono">{mintHost}</span>
            </button>
          </header>

          <main className={`screen screen--${screen}`}>{children}</main>

          <nav className="mobile-nav" aria-label="Wallet navigation">
            {NAVIGATION.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.screen}
                  className={active === item.screen ? "mobile-nav__item mobile-nav__item--active" : "mobile-nav__item"}
                  aria-current={active === item.screen ? "page" : undefined}
                  onClick={() => onNavigate(item.screen)}
                >
                  <Icon size={20} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </section>
      </div>

      {toast ? (
        <div className="toast" role="status">
          <CircleDot size={16} aria-hidden="true" />
          <span>{toast}</span>
        </div>
      ) : null}
    </div>
  );
}

export function WalletLoadingShell({ mintHost, network }: { mintHost: string; network: string }) {
  return (
    <div className="app-canvas">
      <div className="network-tape">
        <span>{network}</span>
        <span>/</span>
        <span>Checking mint</span>
      </div>
      <div className="loading-wallet" aria-busy="true" aria-label="Loading wallet">
        <Brand />
        <WalletCards size={34} aria-hidden="true" />
        <strong>Opening your wallet</strong>
        <span className="mono">{mintHost}</span>
        <div className="loading-wallet__skeletons" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
