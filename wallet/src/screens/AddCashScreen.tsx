import { CheckCircle2, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { AmountInput, Button, Notice, ProgressSteps, QrPanel, QuickAmounts, StatusBadge } from "../components/Primitives";
import type { AddCashOperation, WalletOperation } from "../domain/operations";
import { fmt, parseAmount } from "../lib/wallet";

export function AddCashScreen({
  ticker,
  mintName,
  online,
  operations,
  onRequest,
  onRefresh,
  onDone,
}: {
  ticker: string;
  mintName: string;
  online: boolean;
  operations: WalletOperation[];
  onRequest: (amount: number) => Promise<AddCashOperation>;
  onRefresh: (operation: AddCashOperation) => Promise<void>;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("10.00");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useMemo(
    () => operations.find((item): item is AddCashOperation => item.kind === "add" && item.id === operationId),
    [operationId, operations],
  );

  const request = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAmount(amount);
    if (parsed === null) {
      setError("Enter an amount with no more than two decimal places.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await onRequest(parsed);
      setOperationId(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The mint invoice could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      await onRefresh(operation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The quote could not be checked.");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setOperationId(null);
    setError(null);
  };

  if (operation) {
    const settled = operation.state === "settled";
    const failed = operation.state === "failed" || operation.state === "expired";
    const observed = ["payment_observed", "issuing", "settled"].includes(operation.state);
    return (
      <div className="flow-column flow-enter">
        <section className="invoice-ticket">
          <div className="invoice-ticket__heading">
            <div>
              <span className="eyebrow">Fiber invoice</span>
              <h2>{settled ? "Cash added" : "Pay from a Fiber wallet"}</h2>
            </div>
            <StatusBadge tone={settled ? "settled" : failed ? "failed" : operation.state === "recoverable" ? "recoverable" : "pending"}>
              {settled ? "Settled" : failed ? "Stopped" : operation.state === "recoverable" ? "Recovery required" : "Waiting"}
            </StatusBadge>
          </div>
          <div className="invoice-ticket__amount"><strong>{fmt(operation.amount)}</strong><span>{ticker}</span></div>
          {!settled && !failed ? <QrPanel value={operation.invoice} label="Fiber invoice" size={196} /> : null}
        </section>
        <ProgressSteps
          steps={[
            { label: "Invoice created", detail: `${mintName} created a Fiber invoice.`, state: "done" },
            { label: "Fiber payment", detail: observed ? "The mint observed payment." : "Waiting for payment to reach the mint.", state: failed ? "failed" : observed ? "done" : "active" },
            { label: "Ecash issued", detail: settled ? "Fresh proofs are in your balance." : "The mint issues proofs after payment settles.", state: settled ? "done" : operation.state === "issuing" ? "active" : failed ? "failed" : "todo" },
          ]}
        />
        {settled ? (
          <Notice tone="settled">The balance changed only after the new proofs were issued and stored.</Notice>
        ) : operation.state === "recoverable" ? (
          <Notice tone="recoverable" title="Payment may have settled">
            The quote is retained. Check it again before creating another invoice.
          </Notice>
        ) : failed ? (
          <Notice tone="failed">No ecash was added. Create a new invoice to try again.</Notice>
        ) : (
          <Notice tone="pending">Keep this screen open or return later. The operation is stored in Activity.</Notice>
        )}
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions">
          {settled || failed ? (
            <Button variant="secondary" icon={RotateCcw} onClick={restart}>Add more</Button>
          ) : (
            <Button variant="secondary" icon={RefreshCw} busy={busy} disabled={!online} onClick={() => void refresh()}>Check now</Button>
          )}
          <Button icon={settled ? CheckCircle2 : Plus} onClick={onDone}>{settled ? "Done" : "Return to wallet"}</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="flow-column" onSubmit={(event) => void request(event)} noValidate>
      <div className="intro-copy">
        <h2>Turn a Fiber payment into ecash</h2>
        <p>{mintName} issues fresh {ticker} proofs only after its Fiber invoice is paid.</p>
      </div>
      {!online ? <Notice tone="recoverable">The mint must be reachable to create an invoice.</Notice> : null}
      <AmountInput id="add-amount" label="Amount to add" value={amount} unit={ticker} onChange={(value) => { setAmount(value); setError(null); }} error={error ?? undefined} disabled={busy} />
      <QuickAmounts values={["5.00", "10.00", "25.00", "50.00"]} onSelect={setAmount} />
      <Notice tone="neutral">The mint controls issuance and redemption. Its unit label is not independent proof of the backing asset or reserves.</Notice>
      <Button type="submit" icon={Plus} busy={busy} disabled={!online}>Create Fiber invoice</Button>
    </form>
  );
}
