import { ArrowRight, CheckCircle2, Landmark, Plus, RefreshCw, WalletCards } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import type { CashOutOperation } from "@wallet-domain/operations";
import { explainMeltError, fmt, parseAmount, units, type MeltQuote } from "@wallet-lib/wallet";

import { AmountField, Button, Notice, QrPanel, ScreenHeading, StatusBadge, TextArea } from "../components/Primitives";
import { QrScanner } from "../components/QrScanner";
import { safeErrorMessage } from "../domain/errors";
import type { CashOutReview } from "../domain/market-runtime";
import { EVENT } from "../event/manifest";
import type { MarketController } from "../hooks/useMarket";

type CashMode = "overview" | "add" | "cashout";

function cashTone(operation: MarketController["snapshot"]["addCash"][number] | CashOutOperation) {
  if (operation.state === "settled" || operation.state === "paid") return "settled" as const;
  if (operation.state === "expired" || operation.state === "failed") return "failed" as const;
  if (operation.state === "recoverable" || operation.state === "unknown") return "recoverable" as const;
  return "pending" as const;
}

function cashLabel(operation: MarketController["snapshot"]["addCash"][number] | CashOutOperation): string {
  if (operation.kind === "add") {
    if (operation.state === "settled") return "Added";
    if (operation.state === "awaiting_payment") return "Awaiting Fiber payment";
    if (operation.state === "payment_observed") return "Payment observed";
    if (operation.state === "issuing") return "Issuing ecash";
  } else {
    if (operation.state === "paid") return "Paid";
    if (operation.state === "dispatching") return "Dispatching";
  }
  return operation.state.replaceAll("_", " ");
}

export function CashScreen({ market }: { market: MarketController }) {
  const [mode, setMode] = useState<CashMode>("overview");
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const mintName = market.profile?.name ?? new URL(EVENT.mintUrl).host;
  const closeOperation = () => { setSelectedOperationId(null); setMode("overview"); };
  if (mode === "add") return <AddCash market={market} mintName={mintName} initialOperationId={selectedOperationId} onBack={closeOperation} />;
  if (mode === "cashout") return <CashOut market={market} mintName={mintName} initialOperationId={selectedOperationId} onBack={closeOperation} />;
  const available = market.status === "online" && !market.storageError && !market.preview;
  const activity = [
    ...market.snapshot.addCash.map((operation) => ({ operation, mode: "add" as const })),
    ...market.snapshot.cashOut.map((operation) => ({ operation, mode: "cashout" as const })),
  ].sort((left, right) => right.operation.createdAt - left.operation.createdAt);
  return (
    <div className="cash-overview flow-enter">
      <ScreenHeading eyebrow="Stored in this browser" title={`${fmt(market.balance)} RUSD ecash`}>Fiber moves RUSD at the boundary. Cashu proofs move value inside the event.</ScreenHeading>
      <section className="mint-ledger">
        <div><span>Issuer</span><strong>{mintName}</strong></div>
        <div><span>Host</span><strong className="mono">{new URL(EVENT.mintUrl).host}</strong></div>
        <div><span>Network</span><strong>{EVENT.networkLabel}</strong></div>
        <div><span>Configured asset</span><strong className="mono">RUSD · {EVENT.assetTypeScript.args.slice(0, 10)}…</strong></div>
      </section>
      {!available ? <Notice tone="recoverable">{market.preview ? "Preview data cannot move value." : "The mint must be reachable before adding or cashing out ecash."}</Notice> : null}
      <div className="cash-actions">
        <button type="button" disabled={!available} onClick={() => { setSelectedOperationId(null); setMode("add"); }}><Plus size={22} aria-hidden="true" /><span><strong>Add cash</strong><small>Pay a Fiber invoice, then receive ecash</small></span><ArrowRight size={18} aria-hidden="true" /></button>
        <button type="button" disabled={!available || market.balance === 0} onClick={() => { setSelectedOperationId(null); setMode("cashout"); }}><Landmark size={22} aria-hidden="true" /><span><strong>Cash out</strong><small>Ask the mint to pay an external Fiber invoice</small></span><ArrowRight size={18} aria-hidden="true" /></button>
      </div>
      <Notice tone="neutral" title="Bounded custodial trust">The mint claims custody of the backing RUSD and controls issuance and redemption. Reachability does not prove reserves or liquidity.</Notice>
      {activity.length > 0 ? (
        <section className="cash-history" aria-labelledby="cash-history-title">
          <div className="section-title"><div><span className="eyebrow">Stored locally</span><h2 id="cash-history-title">Cash activity</h2></div></div>
          <div className="activity-list">
            {activity.map(({ operation, mode: operationMode }) => (
              <button
                type="button"
                className="activity-row"
                key={operation.id}
                onClick={() => { setSelectedOperationId(operation.id); setMode(operationMode); }}
              >
                <span><strong>{operation.kind === "add" ? "Add cash" : "Cash out"}</strong><small>{new Date(operation.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span>
                <span><strong className="mono">{operation.kind === "add" ? "+" : "−"}{fmt(operation.amount)} RUSD</strong><StatusBadge tone={cashTone(operation)}>{cashLabel(operation)}</StatusBadge></span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AddCash({ market, mintName, initialOperationId, onBack }: { market: MarketController; mintName: string; initialOperationId: string | null; onBack: () => void }) {
  const [amount, setAmount] = useState("10.00");
  const [operationId, setOperationId] = useState<string | null>(initialOperationId);
  const [error, setError] = useState<string | null>(null);
  const operation = useMemo(() => market.snapshot.addCash.find((item) => item.id === operationId) ?? null, [market.snapshot.addCash, operationId]);
  const request = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAmount(amount);
    if (!parsed) return setError("Enter a positive amount with no more than two decimal places.");
    setError(null);
    try { setOperationId((await market.requestAddCash(parsed)).id); }
    catch (reason) { setError(safeErrorMessage(reason, "The Fiber invoice could not be created.")); }
  };
  const refresh = async () => {
    if (!operation) return;
    setError(null);
    try { await market.refreshAddCash(operation); }
    catch (reason) { setError(safeErrorMessage(reason, "The quote could not be checked.")); }
  };
  if (operation) {
    const settled = operation.state === "settled";
    const stopped = operation.state === "expired" || operation.state === "failed";
    return (
      <div className="flow-column flow-enter">
        <ScreenHeading eyebrow="Fiber in" title={settled ? "Cash added" : "Pay from a Fiber wallet"}>Ecash appears only after the paid quote returns fresh proofs.</ScreenHeading>
        <section className="invoice-ticket">
          <div><StatusBadge tone={settled ? "settled" : stopped ? "failed" : operation.state === "recoverable" ? "recoverable" : "pending"}>{settled ? "Issued" : stopped ? "Stopped" : operation.state === "recoverable" ? "Recovery required" : "Waiting"}</StatusBadge><strong>{fmt(operation.amount)} <small>RUSD</small></strong></div>
          {!settled && !stopped ? <QrPanel value={operation.invoice} label="Fiber invoice" size={206} /> : null}
        </section>
        {operation.error ? <Notice tone="recoverable">{operation.error}</Notice> : settled ? <Notice tone="settled">Fresh proofs were issued and persisted before this balance changed.</Notice> : <Notice tone="pending">The quote remains in local activity, so this screen can be left and checked again.</Notice>}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions"><Button variant="secondary" onClick={onBack}>Back to cash</Button>{!settled && !stopped ? <Button icon={RefreshCw} busy={market.busy} onClick={() => void refresh()}>Check now</Button> : <Button icon={CheckCircle2} onClick={onBack}>Done</Button>}</div>
      </div>
    );
  }
  return (
    <form className="flow-column" onSubmit={(event) => void request(event)} noValidate>
      <ScreenHeading eyebrow="Fiber in" title="Add RUSD ecash">{mintName} issues blinded proofs after its Fiber invoice is paid.</ScreenHeading>
      <AmountField id="add-cash-amount" label="Amount to add" value={amount} onChange={(value) => { setAmount(value); setError(null); }} error={error} />
      <div className="quick-amounts">{["5.00", "10.00", "25.00", "50.00"].map((value) => <button type="button" key={value} onClick={() => setAmount(value)}>{value}</button>)}</div>
      <Notice tone="neutral">A paid Fiber invoice is not yet ecash. The balance updates only after issuance succeeds.</Notice>
      <div className="split-actions"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button type="submit" icon={Plus} busy={market.busy}>Create Fiber invoice</Button></div>
    </form>
  );
}

function CashOut({ market, mintName, initialOperationId, onBack }: { market: MarketController; mintName: string; initialOperationId: string | null; onBack: () => void }) {
  const [invoice, setInvoice] = useState("");
  const [quote, setQuote] = useState<MeltQuote | null>(null);
  const [review, setReview] = useState<CashOutReview | null>(null);
  const [operationId, setOperationId] = useState<string | null>(initialOperationId);
  const [error, setError] = useState<string | null>(null);
  const operation = useMemo(() => market.snapshot.cashOut.find((item) => item.id === operationId) ?? null, [market.snapshot.cashOut, operationId]);
  const price = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoice.trim()) return setError("Paste or scan an external Fiber invoice first.");
    setError(null);
    try {
      const nextQuote = await market.quoteCashOut(invoice.trim());
      setQuote(nextQuote);
      setReview(await market.reviewCashOut(nextQuote));
    } catch (reason) {
      setError(explainMeltError(safeErrorMessage(reason, "The invoice could not be quoted.")));
    }
  };
  const confirm = async () => {
    if (!review) return;
    setError(null);
    try { setOperationId((await market.confirmCashOut(review)).id); }
    catch (reason) { setError(safeErrorMessage(reason, "The cash-out could not be prepared.")); }
  };
  const refresh = async (item: CashOutOperation) => {
    setError(null);
    try { await market.refreshCashOut(item); }
    catch (reason) { setError(safeErrorMessage(reason, "The final state could not be checked.")); }
  };
  if (operation) {
    const terminal = operation.state === "paid" || operation.state === "failed";
    return (
      <div className="flow-column flow-enter">
        <ScreenHeading eyebrow="Fiber out" title={operation.state === "paid" ? "Invoice paid" : operation.state === "failed" ? "Value recovered" : "Awaiting a final result"}>Timeouts and unknown responses never restore reserved ecash by themselves.</ScreenHeading>
        <section className="payment-result"><StatusBadge tone={operation.state === "paid" ? "settled" : operation.state === "failed" ? "failed" : operation.state === "unknown" ? "recoverable" : "pending"}>{operation.state}</StatusBadge><div className="payment-result__amount"><strong>{fmt(operation.amount)}</strong><span>RUSD</span></div></section>
        {operation.error ? <Notice tone={operation.state === "failed" ? "failed" : "recoverable"}>{operation.error}</Notice> : null}
        {!terminal ? <Notice tone="pending">Reserved proofs stay outside the spendable balance until the mint reports paid or authoritatively unpaid.</Notice> : null}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions"><Button variant="secondary" onClick={onBack}>Back to cash</Button>{terminal ? <Button icon={CheckCircle2} onClick={onBack}>Done</Button> : <Button icon={RefreshCw} busy={market.busy} onClick={() => void refresh(operation)}>Check status</Button>}</div>
      </div>
    );
  }
  if (review && quote) {
    const total = review.maximumDebit;
    return (
      <div className="flow-column flow-enter">
        <ScreenHeading eyebrow="Final review" title="Cash out through Fiber">Review the maximum debit before proofs are reserved.</ScreenHeading>
        <section className="review-ticket">
          <div className="review-ticket__amount"><strong>{fmt(units(quote.amount))}</strong><span>RUSD</span></div>
          <dl className="detail-list">
            <div><dt>Fiber fee reserve</dt><dd className="mono">{fmt(units(quote.fee_reserve))} RUSD</dd></div>
            <div><dt>Cashu proof fee</dt><dd className="mono">{fmt(review.prepared.inputFee)} RUSD</dd></div>
            <div><dt>Maximum debit</dt><dd className="mono">{fmt(total)} RUSD</dd></div>
            <div className="detail-list__total"><dt>Balance after maximum</dt><dd className="mono">{fmt(review.balance - total)} RUSD</dd></div>
          </dl>
        </section>
        <Notice tone="recoverable">Unused fee reserve returns only as mint-issued change after a final response.</Notice>
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions split-actions--confirm"><Button variant="secondary" onClick={() => { setReview(null); setQuote(null); }}>Back</Button><Button icon={ArrowRight} busy={market.busy} disabled={total > review.balance} onClick={() => void confirm()}>Confirm cash-out</Button></div>
      </div>
    );
  }
  return (
    <form className="flow-column" onSubmit={(event) => void price(event)} noValidate>
      <ScreenHeading eyebrow="Fiber out" title="Pay an external invoice">{mintName} will quote the route, reserve ecash, and pay through Fiber.</ScreenHeading>
      <QrScanner label="Scan an external Fiber invoice" onResult={(value) => { setInvoice(value); setError(null); }} />
      <div className="or-divider"><span>or paste</span></div>
      <TextArea id="cashout-invoice" label="External Fiber invoice" value={invoice} onChange={(value) => { setInvoice(value); setError(null); }} placeholder="fibt1..." hint="Use an invoice from a different Fiber node, denominated in RUSD." error={error} rows={5} />
      <div className="split-actions"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button type="submit" icon={WalletCards} busy={market.busy}>Review quote</Button></div>
    </form>
  );
}
