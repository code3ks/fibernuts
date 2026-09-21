import { Activity, Eye, EyeOff, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { OperationList } from "../components/OperationList";
import { Button, CopyButton, Notice, StatusBadge } from "../components/Primitives";
import { operationHasBearerSecret, presentOperation, type WalletOperation } from "../domain/operations";
import { fmt } from "../lib/wallet";

export function ActivityScreen({ operations, onOpen }: { operations: WalletOperation[]; onOpen: (operation: WalletOperation) => void }) {
  if (operations.length === 0) {
    return (
      <div className="screen-empty">
        <Activity size={32} aria-hidden="true" />
        <h2>No wallet activity yet</h2>
        <p>Added cash, outgoing tokens, incoming swaps, and cash-outs will appear here with their current state.</p>
      </div>
    );
  }

  return (
    <div className="flow-column">
      <div className="intro-copy">
        <h2>Every movement, including unfinished ones</h2>
        <p>Open an item to inspect what is settled, what remains uncertain, and which recovery action is available.</p>
      </div>
      <OperationList operations={operations} onOpen={onOpen} />
    </div>
  );
}

function operationDescription(operation: WalletOperation): string {
  if (operation.kind === "add") {
    if (operation.state === "settled") return "The Fiber payment was observed and fresh proofs were issued into this wallet.";
    if (operation.state === "recoverable") return "The quote is stored, but proof issuance did not finish. Check the same quote again.";
    if (operation.state === "expired" || operation.state === "failed") return "This quote did not add any proofs to the wallet.";
    return "The mint quote is stored while payment and issuance complete.";
  }
  if (operation.kind === "send") {
    if (operation.state === "accepted") return "The recipient spent the outgoing proofs. The bearer token is no longer reusable.";
    if (operation.state === "reclaimed") return "The token was still unspent and its value was swapped back into this wallet.";
    if (operation.swap && !operation.token) return "The selected inputs and output secrets are stored, but the outgoing bearer token has not been produced yet.";
    if (operation.swap) return "The reclaim swap is stored and can be replayed without choosing new outputs.";
    return "The bearer token is stored, but acceptance has not been proven. Keep it private or check before reclaiming.";
  }
  if (operation.kind === "receive") {
    if (operation.state === "settled") return "The incoming bearer token was swapped for fresh proofs and is included in the balance.";
    if (operation.state === "failed") return "The incoming token did not settle and is not included in the balance.";
    return "The incoming token is retained for recovery but is not included in the balance until a swap succeeds.";
  }
  if (operation.state === "paid") return "The mint reports the external Fiber invoice paid. Returned change was stored with the result.";
  if (operation.state === "failed") return "The mint reported failure and the reserved value was recovered into fresh proofs.";
  return "The payment does not have a definitive result. Reserved proofs remain attached to this operation.";
}

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function OperationDetailScreen({
  operation,
  ticker,
  online,
  onRefresh,
  onReclaim,
  onDiscard,
}: {
  operation: WalletOperation;
  ticker: string;
  online: boolean;
  onRefresh: (operation: WalletOperation) => Promise<void>;
  onReclaim: (operation: WalletOperation) => Promise<void>;
  onDiscard: (operation: WalletOperation) => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const presentation = presentOperation(operation);
  const bearer = operationHasBearerSecret(operation) ? operation.token : undefined;
  const canRefresh =
    (operation.kind === "add" && !["settled", "failed", "expired"].includes(operation.state)) ||
    (operation.kind === "send" && !["accepted", "reclaimed"].includes(operation.state)) ||
    (operation.kind === "receive" && operation.state !== "settled" && operation.state !== "failed") ||
    (operation.kind === "cashout" && !["paid", "failed"].includes(operation.state));
  const canReclaim = operation.kind === "send" && Boolean(operation.token) && !operation.swap && ["awaiting_acceptance", "recovery_required"].includes(operation.state);
  const canDiscard = operation.kind === "receive" && Boolean(operation.token) && !operation.swap && operation.state !== "settled";

  const run = async (action: "refresh" | "reclaim" | "discard") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "refresh") await onRefresh(operation);
      else if (action === "reclaim") await onReclaim(operation);
      else await onDiscard(operation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flow-column flow-enter">
      <section className="operation-detail">
        <div className="operation-detail__heading">
          <div>
            <span className="eyebrow">{presentation.title}</span>
            <div className="operation-detail__amount">
              <strong>{presentation.direction === "in" ? "+" : "-"}{fmt(operation.amount)}</strong>
              <span>{ticker}</span>
            </div>
          </div>
          <StatusBadge tone={presentation.tone}>{presentation.stateLabel}</StatusBadge>
        </div>
        <p className="operation-detail__description">{operationDescription(operation)}</p>
        <dl className="detail-list">
          <div><dt>Created</dt><dd>{timestamp(operation.createdAt)}</dd></div>
          <div><dt>Last checked</dt><dd>{timestamp(operation.updatedAt)}</dd></div>
          {operation.kind === "send" && operation.fee !== undefined ? <div><dt>Cashu proof fees</dt><dd className="mono">{fmt(operation.fee)} {ticker}</dd></div> : null}
          {operation.kind === "cashout" && operation.cashuFee !== undefined ? <div><dt>Cashu proof fee</dt><dd className="mono">{fmt(operation.cashuFee)} {ticker}</dd></div> : null}
          <div><dt>Mint</dt><dd className="mono detail-list__clip">{operation.mintUrl}</dd></div>
          <div><dt>Operation ID</dt><dd className="mono detail-list__clip">{operation.id}</dd></div>
        </dl>
      </section>

      {operation.error ? <Notice tone={presentation.tone === "failed" ? "failed" : "recoverable"}>{operation.error}</Notice> : null}

      {bearer ? (
        <section className="bearer-secret">
          <div className="section-heading">
            <div><span className="eyebrow">Sensitive</span><h2>Bearer token</h2></div>
            <Button variant="ghost" icon={revealed ? EyeOff : Eye} onClick={() => setRevealed((value) => !value)}>
              {revealed ? "Hide" : "Reveal"}
            </Button>
          </div>
          {revealed ? (
            <>
              <Notice tone="recoverable">Anyone with this token may be able to claim it. Reveal or copy it only for recovery or delivery.</Notice>
              <code className="bearer-secret__value">{bearer}</code>
              <CopyButton value={bearer} label="Copy bearer token" sensitive />
            </>
          ) : (
            <div className="bearer-secret__hidden" aria-label="Bearer token hidden">•••• •••• •••• ••••</div>
          )}
        </section>
      ) : null}

      {canDiscard && confirmDiscard ? (
        <Notice
          tone="failed"
          title="Remove this bearer token?"
          action={(
            <div className="split-actions">
              <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>Keep token</Button>
              <Button variant="danger" icon={Trash2} busy={busy} onClick={() => void run("discard")}>Remove token</Button>
            </div>
          )}
        >
          This cannot be undone. If no other copy exists, the value may be permanently lost. Removal is unavailable after a recovery swap has started.
        </Notice>
      ) : null}

      {error ? <Notice tone="failed">{error}</Notice> : null}
      {canRefresh || canReclaim ? (
        <div className="split-actions">
          {canRefresh ? <Button variant="secondary" icon={RefreshCw} busy={busy} disabled={!online} onClick={() => void run("refresh")}>Check status</Button> : <span />}
          {canReclaim ? <Button variant="danger" icon={RotateCcw} busy={busy} disabled={!online} onClick={() => void run("reclaim")}>Reclaim if unspent</Button> : null}
        </div>
      ) : null}
      {canDiscard && !confirmDiscard ? (
        <Button variant="danger" icon={Trash2} onClick={() => setConfirmDiscard(true)}>Remove from this device</Button>
      ) : null}
    </div>
  );
}
