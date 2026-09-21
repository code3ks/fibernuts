import { ArrowRight, CheckCircle2, Landmark, RefreshCw } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { Button, FormTextarea, Notice, ProgressSteps, StatusBadge } from "../components/Primitives";
import { QrScanner } from "../components/QrScanner";
import type { CashOutOperation, WalletOperation } from "../domain/operations";
import { explainMeltError, fmt, units, type MeltQuote, type PreparedMelt } from "../lib/wallet";

type CashOutView = "invoice" | "review" | "dispatching" | "status";

export interface CashOutPreparation {
  quote: MeltQuote;
  prepared: PreparedMelt;
  balance: number;
  maximumDebit: number;
  proofFingerprint: string;
}

export function CashOutScreen({
  balance,
  ticker,
  mintName,
  online,
  operations,
  onQuote,
  onPrepare,
  onConfirm,
  onRefresh,
  onDone,
}: {
  balance: number;
  ticker: string;
  mintName: string;
  online: boolean;
  operations: WalletOperation[];
  onQuote: (invoice: string) => Promise<MeltQuote>;
  onPrepare: (quote: MeltQuote) => Promise<CashOutPreparation>;
  onConfirm: (preparation: CashOutPreparation) => Promise<CashOutOperation>;
  onRefresh: (operation: CashOutOperation) => Promise<void>;
  onDone: () => void;
}) {
  const [view, setView] = useState<CashOutView>("invoice");
  const [invoice, setInvoice] = useState("");
  const [quote, setQuote] = useState<MeltQuote | null>(null);
  const [preparation, setPreparation] = useState<CashOutPreparation | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useMemo(
    () => operations.find((item): item is CashOutOperation => item.kind === "cashout" && item.id === operationId),
    [operationId, operations],
  );

  const price = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoice.trim()) {
      setError("Paste a Fiber invoice first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onQuote(invoice.trim());
      const nextPreparation = await onPrepare(result);
      setQuote(result);
      setPreparation(nextPreparation);
      setView("review");
    } catch (reason) {
      setError(explainMeltError(reason instanceof Error ? reason.message : "The invoice could not be quoted."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!quote || !preparation) return;
    setView("dispatching");
    setError(null);
    try {
      const current = await onPrepare(quote);
      if (
        current.balance !== preparation.balance ||
        current.maximumDebit !== preparation.maximumDebit
      ) {
        setPreparation(current);
        setError("Your spendable balance changed. Review the updated maximum debit before confirming again.");
        setView("review");
        return;
      }
      const created = await onConfirm(current);
      setOperationId(created.id);
      setView("status");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The payment could not be prepared.");
      setView("review");
    }
  };

  const refresh = async () => {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      await onRefresh(operation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The payment status could not be checked.");
    } finally {
      setBusy(false);
    }
  };

  if (view === "dispatching") {
    return (
      <div className="processing-state" role="status" aria-live="polite">
        <span className="processing-state__spinner" aria-hidden="true" />
        <h2>Preparing the cash-out</h2>
        <p>The selected proofs and recovery data are stored before {mintName} is asked to pay.</p>
      </div>
    );
  }

  if (view === "status" && operation) {
    const paid = operation.state === "paid";
    const failed = operation.state === "failed";
    return (
      <div className="flow-column flow-enter">
        <section className="result-receipt">
          <StatusBadge tone={paid ? "settled" : failed ? "failed" : operation.state === "unknown" ? "recoverable" : "pending"}>
            {paid ? "Invoice paid" : failed ? "Payment failed" : operation.state === "unknown" ? "Status unknown" : "Payment pending"}
          </StatusBadge>
          <div className="result-receipt__amount"><strong>{fmt(operation.amount)}</strong><span>{ticker}</span></div>
          <h2>{paid ? "Cash-out complete" : failed ? "Proofs recovered" : "Waiting for a definitive result"}</h2>
        </section>
        <ProgressSteps
          steps={[
            { label: "Proofs reserved", detail: "Inputs and change recovery data were stored together.", state: "done" },
            { label: "Payment dispatched", detail: "The mint was asked to pay the Fiber invoice.", state: failed ? "failed" : "done" },
            { label: "Final result", detail: paid ? "The invoice is paid and change is stored." : failed ? "The mint confirmed failure and value was recovered." : "The mint has not returned a final state.", state: paid ? "done" : failed ? "failed" : "active" },
          ]}
        />
        {operation.state === "unknown" ? (
          <Notice tone="recoverable" title="Do not pay again yet">The operation and reserved proofs remain stored. Check the same quote until the mint reports paid or safely failed.</Notice>
        ) : operation.state === "pending" ? (
          <Notice tone="pending">A pending mint response is not payment confirmation.</Notice>
        ) : paid ? (
          <Notice tone="settled">The mint reported the invoice paid. Any returned change was added to your balance.</Notice>
        ) : (
          <Notice tone="failed">The mint reported no payment and the reserved value was recovered into fresh proofs.</Notice>
        )}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions">
          {!paid && !failed ? <Button variant="secondary" icon={RefreshCw} busy={busy} disabled={!online} onClick={() => void refresh()}>Check status</Button> : <span />}
          <Button icon={CheckCircle2} onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  if (view === "review" && quote && preparation) {
    const amount = units(quote.amount);
    const fee = units(quote.fee_reserve);
    const cashuFee = preparation.prepared.inputFee;
    const total = preparation.maximumDebit;
    const insufficient = total > balance;
    return (
      <div className="flow-column flow-enter">
        <section className="review-receipt">
          <span className="eyebrow">Cash-out review</span>
          <div className="review-receipt__amount"><strong>{fmt(amount)}</strong><span>{ticker}</span></div>
          <dl className="detail-list">
            <div><dt>Invoice amount</dt><dd className="mono">{fmt(amount)} {ticker}</dd></div>
            <div><dt>Maximum fee reserve</dt><dd className="mono">{fmt(fee)} {ticker}</dd></div>
            <div><dt>Cashu proof fee</dt><dd className="mono">{fmt(cashuFee)} {ticker}</dd></div>
            <div><dt>Maximum debit</dt><dd className="mono">{fmt(total)} {ticker}</dd></div>
            <div className="detail-list__total"><dt>Balance after maximum</dt><dd className="mono">{fmt(preparation.balance - total)} {ticker}</dd></div>
          </dl>
        </section>
        <Notice tone="recoverable">The fee reserve is a ceiling. Unused change is recovered only after the mint returns a final response.</Notice>
        {insufficient ? <Notice tone="failed">The maximum debit is larger than your spendable balance.</Notice> : null}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions split-actions--confirm">
          <Button variant="secondary" onClick={() => { setView("invoice"); setQuote(null); setPreparation(null); }}>Cancel</Button>
          <Button icon={ArrowRight} onClick={() => void confirm()} disabled={insufficient || !online}>Confirm cash-out</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="flow-column" onSubmit={(event) => void price(event)} noValidate>
      <div className="intro-copy">
        <Landmark size={29} aria-hidden="true" />
        <h2>Pay an external Fiber invoice</h2>
        <p>The active mint pays the invoice and consumes your ecash. An invoice from this same mint cannot be paid here.</p>
      </div>
      <QrScanner label="Scan an external Fiber invoice" onResult={(value) => { setInvoice(value); setError(null); }} />
      <div className="or-divider"><span>or paste</span></div>
      <FormTextarea id="cashout-invoice" label="External Fiber invoice" value={invoice} placeholder="fibt1... or fibd1..." rows={5} onChange={(value) => { setInvoice(value); setError(null); }} error={error ?? undefined} hint="Getting a quote does not reserve or spend proofs." />
      <Button type="submit" icon={ArrowRight} busy={busy} disabled={!online}>Review quote</Button>
    </form>
  );
}
