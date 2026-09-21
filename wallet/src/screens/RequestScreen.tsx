import { ArrowRight, CheckCircle2, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";

import { Button, AmountInput, FormTextarea, Notice, ProgressSteps, QrPanel, QuickAmounts, StatusBadge } from "../components/Primitives";
import { QrScanner } from "../components/QrScanner";
import type { ReceiveOperation, WalletOperation } from "../domain/operations";
import { createPaymentRequest, type DecodedPaymentRequest } from "../lib/payment-request";
import { fmt, parseAmount } from "../lib/wallet";

type RequestView = "create" | "present" | "receiving" | "result";

export function RequestScreen({
  ticker,
  mintUrl,
  mintName,
  online,
  operations,
  savedRequest,
  onSaveRequest,
  onClearRequest,
  onReceive,
  onDone,
}: {
  ticker: string;
  mintUrl: string;
  mintName: string;
  online: boolean;
  operations: WalletOperation[];
  savedRequest?: DecodedPaymentRequest;
  onSaveRequest: (request: DecodedPaymentRequest) => void;
  onClearRequest: () => void;
  onReceive: (token: string, note: string) => Promise<ReceiveOperation>;
  onDone: () => void;
}) {
  const [view, setView] = useState<RequestView>(savedRequest ? "present" : "create");
  const [amount, setAmount] = useState(savedRequest ? fmt(savedRequest.amount) : "5.00");
  const [note, setNote] = useState(savedRequest?.description ?? "");
  const [request, setRequest] = useState<DecodedPaymentRequest | null>(savedRequest ?? null);
  const [token, setToken] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const receivingRef = useRef(false);
  const operation = useMemo(
    () => operations.find((item): item is ReceiveOperation => item.kind === "receive" && item.id === operationId),
    [operationId, operations],
  );

  const buildRequest = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAmount(amount);
    if (parsed === null) {
      setError("Enter an amount with no more than two decimal places.");
      return;
    }
    try {
      const created = createPaymentRequest(parsed, ticker, mintUrl, note.trim() || "FiberNuts payment");
      onSaveRequest(created);
      setRequest(created);
      setError(null);
      setView("present");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be created.");
    }
  };

  const receive = useCallback(
    async (value: string) => {
      if (receivingRef.current) return;
      if (!online) {
        setError("The mint must be reachable to secure an incoming token.");
        return;
      }
      receivingRef.current = true;
      setView("receiving");
      setError(null);
      try {
        const settled = await onReceive(value.trim(), request?.description ?? "Requested payment");
        setOperationId(settled.id);
        setToken("");
        setView("result");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The token could not be secured.");
        setView("present");
      } finally {
        receivingRef.current = false;
      }
    },
    [online, onReceive, request?.description],
  );

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) {
      setError("Paste the sender's Cashu token first.");
      return;
    }
    void receive(token);
  };

  const restart = () => {
    setView("create");
    setRequest(null);
    setToken("");
    setOperationId(null);
    setError(null);
    onClearRequest();
  };

  if (view === "receiving") {
    return (
      <div className="flow-column flow-enter">
        <div className="processing-state" role="status" aria-live="polite">
          <span className="processing-state__spinner" aria-hidden="true" />
          <h2>Securing the payment</h2>
          <p>The token is stored first, then checked and swapped for fresh proofs at {mintName}.</p>
        </div>
        <ProgressSteps
          steps={[
            { label: "Token stored", detail: "The recovery copy is on this device.", state: "done" },
            { label: "Issuer checked", detail: "Mint and unit must match this wallet.", state: "active" },
            { label: "Fresh proofs", detail: "Only this step settles the incoming payment.", state: "todo" },
          ]}
        />
      </div>
    );
  }

  if (view === "result" && operation) {
    const settled = operation.state === "settled";
    const failed = operation.state === "failed";
    return (
      <div className="flow-column flow-enter">
        <section className="result-receipt">
          <StatusBadge tone={settled ? "settled" : failed ? "failed" : "recoverable"}>
            {settled ? "Payment settled" : failed ? "Payment not accepted" : "Token stored"}
          </StatusBadge>
          <div className="result-receipt__amount">
            <strong>{fmt(operation.amount)}</strong>
            <span>{ticker}</span>
          </div>
          <h2>{settled ? "Fresh proofs are now in your balance" : failed ? "The token could not be settled" : "This still needs the mint"}</h2>
          {settled ? (
            <Notice tone="settled">The received bearer token was swapped into proofs controlled by this wallet.</Notice>
          ) : failed ? (
            <Notice tone="failed" title="No value was claimed">
              {operation.error || "The token was rejected before settlement. It is not included in the balance."}
            </Notice>
          ) : (
            <Notice tone="recoverable" title="Not settled yet">
              The original token is retained in Activity so the swap can be retried. It is not counted in the balance.
            </Notice>
          )}
        </section>
        <div className="split-actions">
          <Button variant="secondary" icon={RotateCcw} onClick={restart}>Request again</Button>
          <Button icon={CheckCircle2} onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  if (view === "present" && request) {
    return (
      <div className="flow-column flow-enter">
        <section className="request-ticket">
          <div className="request-ticket__heading">
            <div>
              <span className="eyebrow">Cashu payment request</span>
              <h2>{request.description}</h2>
            </div>
            <strong>{fmt(request.amount)} <span>{ticker}</span></strong>
          </div>
          <QrPanel value={request.encoded} label="Payment request" shareable />
          <p className="request-ticket__issuer">Accepts {ticker} ecash issued by {mintName}</p>
        </section>
        <Notice tone="neutral">
          The QR contains an amount, note, unit, and accepted mint. It contains no wallet proofs and can be shared publicly.
        </Notice>
        <div className="receive-divider"><span>After the sender pays</span></div>
        <QrScanner label="Scan the sender's Cashu token" onResult={(value) => void receive(value)} />
        <form onSubmit={submitToken} noValidate>
          <FormTextarea
            id="incoming-token"
            label="Cashu token"
            value={token}
            placeholder="cashuB..."
            rows={4}
            onChange={(value) => { setToken(value); setError(null); }}
            error={error ?? undefined}
            hint="Receiving is complete only after the mint swaps this token for fresh proofs."
          />
          <Button type="submit" className="button--full" icon={ArrowRight} disabled={!online}>Secure payment</Button>
        </form>
        <Button variant="ghost" onClick={restart}>Change request</Button>
      </div>
    );
  }

  return (
    <form className="flow-column" onSubmit={buildRequest} noValidate>
      <div className="intro-copy">
        <h2>Ask for a specific payment</h2>
        <p>Create a standard Cashu payment request the sender can scan and verify before creating a bearer token.</p>
      </div>
      <AmountInput
        id="request-amount"
        label="Amount to request"
        value={amount}
        unit={ticker}
        onChange={(value) => { setAmount(value); setError(null); }}
        error={error ?? undefined}
      />
      <QuickAmounts values={["1.00", "5.00", "10.00", "25.00"]} onSelect={setAmount} />
      <div className="field">
        <label className="field__label" htmlFor="request-note">What is it for?</label>
        <input id="request-note" value={note} maxLength={80} placeholder="Coffee, ticket, lunch..." onChange={(event) => setNote(event.target.value)} />
        <p className="field__hint">This note is included in the request QR.</p>
      </div>
      <Button type="submit" icon={ArrowRight}>Create request</Button>
    </form>
  );
}
