import { ArrowDownLeft, ArrowUpRight, Landmark, Plus, RefreshCw, WalletCards } from "lucide-react";

import type { AppScreen } from "../domain/navigation";
import { operationNeedsAttention, type WalletOperation } from "../domain/operations";
import { fmt } from "../lib/wallet";
import type { MintConnectionStatus } from "../components/AppShell";
import { OperationList } from "../components/OperationList";
import { Button, Notice } from "../components/Primitives";

export function HomeScreen({
  balance,
  proofCount,
  ticker,
  mintName,
  status,
  connectionError,
  operations,
  onNavigate,
  onOpenOperation,
  onRetry,
}: {
  balance: number;
  proofCount: number;
  ticker: string;
  mintName: string;
  status: MintConnectionStatus;
  connectionError?: string | null;
  operations: WalletOperation[];
  onNavigate: (screen: AppScreen) => void;
  onOpenOperation: (operation: WalletOperation) => void;
  onRetry: () => void;
}) {
  const attention = operations.filter(operationNeedsAttention);
  const recent = operations.slice(0, 3);

  return (
    <div className="home-layout">
      <div className="home-layout__primary">
        {status === "offline" || status === "incompatible" ? (
          <Notice
            tone="recoverable"
            title={status === "incompatible" ? "This mint is not compatible" : "Cannot reach the mint"}
            action={
              <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>
                Check again
              </Button>
            }
          >
            <p>
              Stored proofs remain in this browser. Adding cash, cashing out, and settling incoming payments
              {status === "incompatible" ? " require a mint that advertises Fiber for this unit." : " must wait until the mint responds."}
            </p>
            {connectionError ? <p className="notice__technical">{connectionError}</p> : null}
          </Notice>
        ) : null}

        <section className="balance-receipt" aria-labelledby="balance-heading">
          <div className="balance-receipt__pattern" aria-hidden="true" />
          <div className="balance-receipt__heading">
            <span id="balance-heading">{ticker} ecash - stored in this browser</span>
            <WalletCards size={23} aria-hidden="true" />
          </div>
          <div className="balance-receipt__amount">
            <strong>{fmt(balance)}</strong>
            <span>{ticker}</span>
          </div>
          <p className="balance-receipt__units">
            {balance} ecash units - {proofCount} {proofCount === 1 ? "proof" : "proofs"} - 1 unit = 0.01 {ticker}
          </p>
          <div className="balance-receipt__issuer">
            <p>
              Issued by <strong>{mintName}</strong>. The mint claims custody of the backing {ticker}.
            </p>
            <button type="button" onClick={() => onNavigate("mint")}>
              Mint details
            </button>
          </div>
        </section>

        {balance === 0 ? (
          <section className="empty-balance">
            <Landmark size={30} aria-hidden="true" />
            <h2>No ecash stored yet</h2>
            <p>Add cash to have the active mint issue {ticker} ecash after a settled Fiber payment.</p>
            <Button icon={Plus} onClick={() => onNavigate("add")} disabled={status !== "online"}>
              Add cash
            </Button>
          </section>
        ) : (
          <div className="wallet-actions">
            <button type="button" className="wallet-action wallet-action--pay" onClick={() => onNavigate("pay")}>
              <ArrowUpRight size={22} aria-hidden="true" />
              <span>Pay</span>
            </button>
            <button type="button" className="wallet-action wallet-action--request" onClick={() => onNavigate("request")}>
              <ArrowDownLeft size={22} aria-hidden="true" />
              <span>Request</span>
            </button>
            <Button variant="secondary" icon={Plus} onClick={() => onNavigate("add")} disabled={status !== "online"}>
              Add cash
            </Button>
            <Button variant="secondary" icon={Landmark} onClick={() => onNavigate("cashout")} disabled={status !== "online"}>
              Cash out
            </Button>
          </div>
        )}

        {attention.length > 0 ? (
          <section className="home-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Needs attention</span>
                <h2>Unresolved money</h2>
              </div>
              <span className="count-badge">{attention.length}</span>
            </div>
            <OperationList operations={attention} onOpen={onOpenOperation} compact />
          </section>
        ) : null}
      </div>

      <aside className="home-layout__activity">
        <section className="home-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Recent</span>
              <h2>Activity</h2>
            </div>
            {recent.length > 0 ? (
              <button type="button" className="text-button" onClick={() => onNavigate("activity")}>
                All activity
              </button>
            ) : null}
          </div>
          {recent.length > 0 ? (
            <OperationList operations={recent} onOpen={onOpenOperation} compact />
          ) : (
            <div className="empty-activity">
              <WalletCards size={26} aria-hidden="true" />
              <strong>Nothing has moved yet</strong>
              <p>Added cash, payments, and cash-outs will appear here with their current state.</p>
            </div>
          )}
        </section>

        <div className="trust-note">
          <strong>Bearer payments with bounded custodial trust.</strong>
          <span>No on-chain transfer graph. Blind signatures reduce mint-side linkability.</span>
        </div>
      </aside>
    </div>
  );
}
