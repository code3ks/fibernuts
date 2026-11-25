import { Activity, Eye, EyeOff, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { OperationList } from "../components/OperationList";
import { Button, CopyButton, Notice, StatusBadge } from "../components/Primitives";
import { SettlementFacts } from "../components/SettlementFacts";
import { safeErrorMessage } from "../domain/errors";
import { operationGuidance, operationHasBearerSecret, presentOperation, type WalletOperation } from "../domain/operations";
import { fmt, sumProofs } from "../lib/wallet";

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

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function OperationDetailScreen({
  operation,
  ticker,
  online,
  checking,
  onRefresh,
  onReclaim,
  onDiscard,
}: {
  operation: WalletOperation;
  ticker: string;
  online: boolean;
  checking: boolean;
  onRefresh: (operation: WalletOperation) => Promise<void>;
  onReclaim: (operation: WalletOperation) => Promise<void>;
  onDiscard: (operation: WalletOperation) => Promise<void>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const presentation = presentOperation(operation);
  const guidance = operationGuidance(operation);
  const bearer = operationHasBearerSecret(operation) ? operation.token : undefined;
  const isBusy = busy || checking;
  const canRefresh =
    (operation.kind === "add" && !["settled", "failed", "expired"].includes(operation.state)) ||
    (operation.kind === "send" && !["accepted", "reclaimed"].includes(operation.state)) ||
    (operation.kind === "receive" && !["settled", "rejected", "spent", "discarded", "failed"].includes(operation.state)) ||
    (operation.kind === "cashout" && !["paid", "failed"].includes(operation.state));
  const canReclaim = operation.kind === "send" && Boolean(operation.token) && !operation.swap && ["awaiting_acceptance", "recovery_required"].includes(operation.state);
  const canDiscard = operation.kind === "receive" && Boolean(operation.token) && !operation.swap && operation.state !== "settled";

  const run = async (action: "refresh" | "reclaim" | "discard") => {
    if (checking) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "refresh") await onRefresh(operation);
      else if (action === "reclaim") await onReclaim(operation);
      else await onDiscard(operation);
    } catch (reason) {
      setError(safeErrorMessage(reason, "The operation could not be updated."));
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
        <dl className="detail-list">
          <div><dt>Created</dt><dd>{timestamp(operation.createdAt)}</dd></div>
          <div><dt>Last checked</dt><dd>{timestamp(operation.updatedAt)}</dd></div>
          {operation.kind === "send" && operation.fee !== undefined ? <div><dt>Cashu proof fees</dt><dd className="mono">{fmt(operation.fee)} {ticker}</dd></div> : null}
          {operation.kind === "send" && operation.fee !== undefined ? <div className="detail-list__total"><dt>Total debit</dt><dd className="mono">{fmt(operation.amount + operation.fee)} {ticker}</dd></div> : null}
          {operation.kind === "cashout" ? <div><dt>Invoice amount</dt><dd className="mono">{fmt(operation.quote.amount)} {ticker}</dd></div> : null}
          {operation.kind === "cashout" ? <div><dt>Route fee reserve</dt><dd className="mono">{fmt(operation.quote.feeReserve)} {ticker}</dd></div> : null}
          {operation.kind === "cashout" && operation.cashuFee !== undefined ? <div><dt>Cashu proof fee</dt><dd className="mono">{fmt(operation.cashuFee)} {ticker}</dd></div> : null}
          {operation.kind === "cashout" ? <div className="detail-list__total"><dt>Maximum debit</dt><dd className="mono">{fmt(operation.quote.amount + operation.quote.feeReserve + (operation.cashuFee ?? 0))} {ticker}</dd></div> : null}
          {operation.kind === "cashout" && operation.reservedProofs?.length ? <div><dt>Reserved proof value</dt><dd className="mono">{fmt(sumProofs(operation.reservedProofs))} {ticker}</dd></div> : null}
          {operation.kind === "cashout" && operation.reservedProofs?.length ? <div><dt>Reserved proof count</dt><dd>{operation.reservedProofs.length}</dd></div> : null}
          {"swap" in operation && operation.swap ? <div><dt>Stored input value</dt><dd className="mono">{fmt(sumProofs(operation.swap.inputs))} {ticker}</dd></div> : null}
          {"swap" in operation && operation.swap ? <div><dt>Prepared outputs</dt><dd>{(operation.swap.sendOutputs?.length ?? 0) + (operation.swap.keepOutputs?.length ?? 0)}</dd></div> : null}
          {operation.kind === "add" && operation.outputData?.length ? <div><dt>Prepared issuance outputs</dt><dd>{operation.outputData.length}</dd></div> : null}
          {operation.kind === "cashout" && operation.outputData?.length ? <div><dt>Prepared change outputs</dt><dd>{operation.outputData.length}</dd></div> : null}
        </dl>
      </section>

      <section className="operation-guidance" aria-label="Recovery guidance">
        <div><span>Known</span><p>{guidance.known}</p></div>
        <div><span>Value status</span><p>{guidance.valueStatus}</p></div>
        <div><span>Safe next action</span><p>{guidance.nextAction}</p></div>
      </section>

      <SettlementFacts context={operation.context} mintUrl={operation.mintUrl} unit={operation.unit} title="Stored settlement context" />

      {checking ? <Notice tone="processing" title="Checking this stored operation">Duplicate actions are disabled until the current mint request finishes.</Notice> : null}
      {operation.error ? <Notice tone={presentation.tone}>{operation.error}</Notice> : null}

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
              <Button variant="danger" icon={Trash2} busy={isBusy} onClick={() => void run("discard")}>Remove token</Button>
            </div>
          )}
        >
          This cannot be undone. If no other copy exists, the value may be permanently lost. Removal is unavailable after a recovery swap has started.
        </Notice>
      ) : null}

      {error ? <Notice tone="failed">{error}</Notice> : null}
      {canRefresh || canReclaim ? (
        <div className="split-actions">
          {canRefresh ? <Button variant="secondary" icon={RefreshCw} busy={isBusy} disabled={!online} onClick={() => void run("refresh")}>Check status</Button> : <span />}
          {canReclaim ? <Button variant="danger" icon={RotateCcw} busy={isBusy} disabled={!online} onClick={() => void run("reclaim")}>Reclaim if unspent</Button> : null}
        </div>
      ) : null}
      {canDiscard && !confirmDiscard ? (
        <Button variant="danger" icon={Trash2} disabled={checking} onClick={() => setConfirmDiscard(true)}>Remove from this device</Button>
      ) : null}
    </div>
  );
}
