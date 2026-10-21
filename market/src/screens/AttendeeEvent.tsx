import { ArrowRight, HandCoins, MapPin, Plus, RefreshCw, ScanLine, Store, WalletCards } from "lucide-react";

import { fmt } from "@wallet-lib/wallet";

import { Button, Notice, StatusBadge } from "../components/Primitives";
import { EVENT } from "../event/manifest";
import type { MarketController } from "../hooks/useMarket";

export function AttendeeEvent({ market, onPay, onCash, onClaim }: {
  market: MarketController;
  onPay: () => void;
  onCash: () => void;
  onClaim: () => void;
}) {
  const canMoveValue = market.status === "online" && !market.storageError && !market.preview;
  const canPay = canMoveValue && market.balance > 0;
  const hasNoEcash = market.balance === 0;
  const claimAmount = market.faucetConfig ? fmt(market.faucetConfig.amount) : null;
  const claimLabel = claimAmount ? `Claim ${claimAmount} test RUSD` : "Claim test RUSD";
  return (
    <div className="event-screen flow-enter">
      <section className="event-intro">
        <div>
          <span className="eyebrow">CKB community pop-up</span>
          <h1>{EVENT.name}</h1>
          <p>{EVENT.description}</p>
        </div>
        <div className="event-intro__place"><MapPin size={17} aria-hidden="true" /><span>{EVENT.venue}</span></div>
      </section>

      {market.preview ? <Notice tone="neutral" title="Preview data">Amounts and activity on this build are synthetic. Network actions are disabled.</Notice> : null}
      {market.storageError ? <Notice tone="failed" title="Stored wallet data could not be read">{market.storageError} Value-moving actions are disabled.</Notice> : null}
      {market.status === "offline" ? (
        <Notice
          tone="recoverable"
          title="Mint unavailable"
          action={<Button variant="secondary" icon={RefreshCw} onClick={market.retryConnection}>Try again</Button>}
        >
          Your locally stored ecash was not changed. Paying and settling wait until the mint returns.
        </Notice>
      ) : null}
      {market.status === "incompatible" ? <Notice tone="failed" title="This browser or mint is not compatible">{market.connectionError}</Notice> : null}

      <section className="balance-receipt" aria-label={`${fmt(market.balance)} RUSD ecash balance`}>
        <div className="balance-receipt__top"><span>RUSD ecash</span><StatusBadge tone={market.status === "online" ? "settled" : market.status === "connecting" ? "pending" : "recoverable"}>{market.status === "online" ? "Ready" : market.status === "preview" ? "Preview" : "Unavailable"}</StatusBadge></div>
        <div className="balance-receipt__amount"><strong>{fmt(market.balance)}</strong><span>RUSD</span></div>
        <p>Issued by {market.profile?.name ?? new URL(EVENT.mintUrl).host} · stored in this browser</p>
        {hasNoEcash ? (
          <div className="balance-receipt__zero">
            <span><strong>No ecash yet</strong><small>Fund this browser before paying a vendor.</small></span>
            {market.faucetStatus === "available" ? (
              <Button icon={HandCoins} disabled={!canMoveValue} onClick={onClaim}>{claimLabel}</Button>
            ) : market.faucetStatus === "loading" ? (
              <Button busy>Checking test RUSD</Button>
            ) : (
              <Button variant="secondary" icon={Plus} disabled={!canMoveValue} onClick={onCash}>Add cash with Fiber</Button>
            )}
          </div>
        ) : null}
        <div className="receipt-cut" aria-hidden="true" />
      </section>

      <div className="event-primary-action">
        <Button icon={ScanLine} className="button--large" disabled={!canPay} onClick={onPay}>Scan to pay</Button>
        <button type="button" className="cash-link" onClick={onCash}><WalletCards size={17} aria-hidden="true" /> {hasNoEcash ? "Other ways to add RUSD" : "Add or cash out RUSD"}</button>
      </div>

      <section className="vendor-section">
        <div className="section-title"><div><span className="eyebrow">At the market</span><h2>Vendors</h2></div><Store size={22} aria-hidden="true" /></div>
        <div className="vendor-list">
          {EVENT.vendors.map((vendor) => (
            <button type="button" className="vendor-row" key={vendor.id} onClick={onPay}>
              <span className="vendor-row__index">01</span>
              <span><strong>{vendor.name}</strong><small>{vendor.description}</small><em>{vendor.location}</em></span>
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <p className="trust-footnote">Private bearer payments with bounded custodial trust. The mint controls issuance and redemption.</p>
    </div>
  );
}
