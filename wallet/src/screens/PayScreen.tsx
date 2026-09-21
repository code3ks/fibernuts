import { ArrowRight, CheckCircle2, RotateCcw, Share2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";

import type { SendOperation, WalletOperation } from "../domain/operations";
import { decodePaymentRequest, type DecodedPaymentRequest } from "../lib/payment-request";
import { fmt, type PreparedSend } from "../lib/wallet";
import { QrScanner } from "../components/QrScanner";
import { Button, FormTextarea, Notice, QrPanel, StatusBadge } from "../components/Primitives";

type PayView = "scan" | "checking" | "review" | "building" | "token";

export interface OutgoingPreparation {
  request: string;
  prepared: PreparedSend;
  balance: number;
  debit: number;
  fee: number;
  proofFingerprint: string;
}

export function PayScreen({
  ticker,
  mintName,
  operations,
  onPreparePayment,
  onCreatePayment,
  onDone,
}: {
  ticker: string;
  mintName: string;
  operations: WalletOperation[];
  onPreparePayment: (request: DecodedPaymentRequest) => Promise<OutgoingPreparation>;
  onCreatePayment: (request: DecodedPaymentRequest, preparation: OutgoingPreparation) => Promise<SendOperation>;
  onDone: () => void;
}) {
  const [view, setView] = useState<PayView>("scan");
  const [pasted, setPasted] = useState("");
  const [request, setRequest] = useState<DecodedPaymentRequest | null>(null);
  const [preparation, setPreparation] = useState<OutgoingPreparation | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  const operation = useMemo(
    () => operations.find((item): item is SendOperation => item.kind === "send" && item.id === operationId),
    [operationId, operations],
  );

  const read = useCallback(
    async (value: string) => {
      try {
        const decoded = decodePaymentRequest(value);
        setRequest(decoded);
        setPasted("");
        setError(null);
        setView("checking");
        const nextPreparation = await onPreparePayment(decoded);
        setPreparation(nextPreparation);
        setView("review");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The payment request could not be read.");
        setPreparation(null);
        setView("scan");
      }
    },
    [onPreparePayment],
  );

  const submitPaste = (event: FormEvent) => {
    event.preventDefault();
    if (!pasted.trim()) {
      setError("Paste a Cashu payment request first.");
      return;
    }
    void read(pasted);
  };

  const confirm = async () => {
    if (!request || !preparation || confirmingRef.current) return;
    confirmingRef.current = true;
    setView("building");
    setError(null);
    try {
      const current = await onPreparePayment(request);
      if (
        current.balance !== preparation.balance ||
        current.debit !== preparation.debit ||
        current.fee !== preparation.fee
      ) {
        setPreparation(current);
        setError("Your spendable balance changed. Review the updated debit before confirming again.");
        setView("review");
        return;
      }
      const created = await onCreatePayment(request, current);
      setOperationId(created.id);
      setView("token");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The payment token could not be created.");
      setView("review");
    } finally {
      confirmingRef.current = false;
    }
  };

  const restart = () => {
    setView("scan");
    setPasted("");
    setRequest(null);
    setPreparation(null);
    setOperationId(null);
    setError(null);
  };

  if (view === "review" && request && preparation) {
    return (
      <div className="flow-column flow-enter">
        <section className="review-receipt">
          <span className="eyebrow">Payment request</span>
          <div className="review-receipt__amount">
            <strong>{fmt(request.amount)}</strong>
            <span>{ticker}</span>
          </div>
          <h2>{request.description}</h2>
          <dl className="detail-list">
            <div>
              <dt>Accepted mint</dt>
              <dd>{mintName}</dd>
            </div>
            <div>
              <dt>Cashu proof fees</dt>
              <dd className="mono">{fmt(preparation.fee)} {ticker}</dd>
            </div>
            <div>
              <dt>Total debit</dt>
              <dd className="mono">{fmt(preparation.debit)} {ticker}</dd>
            </div>
            <div className="detail-list__total">
              <dt>Balance after</dt>
              <dd className="mono">{fmt(preparation.balance - preparation.debit)} {ticker}</dd>
            </div>
          </dl>
        </section>
        <Notice tone="recoverable">
          The fee covers this wallet's split and the recipient's future settlement swap. The bearer token
          leaves your spendable balance only after the token and retained proofs are stored together.
        </Notice>
        {error ? <Notice tone="failed">{error}</Notice> : null}
        <div className="split-actions split-actions--confirm">
          <Button variant="secondary" onClick={restart}>
            Cancel
          </Button>
          <Button icon={ArrowRight} onClick={() => void confirm()}>
            Pay {fmt(request.amount)} {ticker}
          </Button>
        </div>
      </div>
    );
  }

  if (view === "checking") {
    return (
      <div className="processing-state" role="status" aria-live="polite">
        <span className="processing-state__spinner" aria-hidden="true" />
        <h2>Calculating the exact debit</h2>
        <p>The wallet is selecting proofs and checking mint fees locally. Nothing has moved yet.</p>
      </div>
    );
  }

  if (view === "building") {
    return (
      <div className="processing-state" role="status" aria-live="polite">
        <span className="processing-state__spinner" aria-hidden="true" />
        <h2>Preparing your token</h2>
        <p>Reserving the proofs and storing the outgoing token before it is shown.</p>
      </div>
    );
  }

  if (view === "token" && operation && !operation.token) {
    return (
      <div className="flow-column flow-enter">
        <section className="result-receipt">
          <StatusBadge tone="recoverable">Preparation stored</StatusBadge>
          <div className="result-receipt__amount">
            <strong>{fmt(operation.amount)}</strong>
            <span>{ticker}</span>
          </div>
          <h2>The bearer token is not ready yet</h2>
          <Notice tone="recoverable" title="Safe to leave this screen">
            The selected inputs and exact output secrets are stored in Activity. The wallet will retry the same
            swap when the mint responds; it will not create a second payment.
          </Notice>
        </section>
        <Button icon={CheckCircle2} onClick={onDone}>View wallet</Button>
      </div>
    );
  }

  if (view === "token" && operation?.token) {
    const accepted = operation.state === "accepted";
    const token = operation.token;
    const share = async () => {
      try {
        if (navigator.share) {
          await navigator.share({ title: `${fmt(operation.amount)} ${ticker} Cashu payment`, text: token });
        } else {
          await navigator.clipboard.writeText(token);
        }
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("The token could not be shared. Use Copy token instead.");
      }
    };

    return (
      <div className="flow-column flow-enter">
        <section className="token-receipt">
          <div className="token-receipt__head">
            <span className="eyebrow">Bearer payment</span>
            <StatusBadge tone={accepted ? "settled" : "pending"}>{accepted ? "Accepted" : "Awaiting acceptance"}</StatusBadge>
          </div>
          <QrPanel value={operation.token} label="Cashu token" sensitive />
          <div className="token-receipt__amount">
            <strong>{fmt(operation.amount)}</strong>
            <span>{ticker}</span>
          </div>
          <p>{operation.note || "Payment"}</p>
          {accepted ? (
            <Notice tone="settled" title="Accepted by the recipient">
              The original proofs are spent. This bearer token cannot be claimed again.
            </Notice>
          ) : (
            <Notice tone="pending" title="Treat this code like cash">
              Anyone who captures it can try to claim the value. Show it only to the intended recipient.
            </Notice>
          )}
          {error ? <Notice tone="failed">{error}</Notice> : null}
        </section>
        {!accepted ? (
          <Button variant="secondary" icon={Share2} onClick={() => void share()}>
            Share token
          </Button>
        ) : null}
        <div className="split-actions">
          <Button variant="secondary" icon={RotateCcw} onClick={restart}>
            Pay again
          </Button>
          <Button icon={CheckCircle2} onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-column">
      <div className="intro-copy">
        <h2>Read a payment request</h2>
        <p>The request is decoded on this device. No proofs change until you review and confirm it.</p>
      </div>
      <QrScanner label="Scan a Cashu payment request" onResult={(value) => void read(value)} />
      <div className="or-divider"><span>or paste</span></div>
      <form onSubmit={submitPaste} noValidate>
        <FormTextarea
          id="payment-request"
          label="Cashu payment request"
          value={pasted}
          placeholder="creqA..."
          rows={4}
          onChange={(value) => {
            setPasted(value);
            setError(null);
          }}
          error={error ?? undefined}
          hint="Payment requests begin with creqA or CREQB. Bearer tokens begin with cashu."
        />
        <Button type="submit" className="button--full" icon={ArrowRight}>
          Read request
        </Button>
      </form>
    </div>
  );
}
