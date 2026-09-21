import { CheckCircle2, Link2, RefreshCw, Server, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Notice, StatusBadge } from "../components/Primitives";
import type { MintConnectionStatus } from "../components/AppShell";
import { normalizeMintUrl } from "../lib/payment-request";
import type { MintProfile } from "../lib/wallet";

export function MintScreen({
  mintUrl,
  ticker,
  network,
  status,
  profile,
  connectionError,
  onChangeMint,
  onRetry,
}: {
  mintUrl: string;
  ticker: string;
  network: string;
  status: MintConnectionStatus;
  profile: MintProfile | null;
  connectionError?: string | null;
  onChangeMint: (url: string) => void;
  onRetry: () => void;
}) {
  const [draft, setDraft] = useState(mintUrl);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const normalized = normalizeMintUrl(draft.trim());
      if (!/^https?:\/\//.test(normalized)) throw new Error("Enter a complete http or https mint URL.");
      onChangeMint(normalized);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The mint URL is invalid.");
    }
  };

  return (
    <div className="mint-layout">
      <div className="flow-column">
        <section className="mint-identity">
          <div className="mint-identity__icon"><Server size={27} aria-hidden="true" /></div>
          <div>
            <span className="eyebrow">Active issuer</span>
            <h2>{profile?.name || safeHost(mintUrl)}</h2>
            <p>{profile?.description || "No description was reported by the mint."}</p>
          </div>
          <StatusBadge tone={status === "online" ? "settled" : status === "connecting" ? "pending" : "recoverable"}>
            {status === "online" ? "Compatible" : status === "offline" ? "Unavailable" : status === "incompatible" ? "Incompatible" : "Checking"}
          </StatusBadge>
        </section>
        <dl className="detail-list mint-facts">
          <div><dt>Mint URL</dt><dd className="mono detail-list__clip">{mintUrl}</dd></div>
          <div><dt>Wallet unit</dt><dd>{ticker}</dd></div>
          <div><dt>Network</dt><dd>{network} <span className="fact-source">Local configuration</span></dd></div>
          <div><dt>Fiber add cash</dt><dd>{profile ? (profile.supportsFiberMint ? "Advertised" : "Not advertised") : "Unavailable"}</dd></div>
          <div><dt>Fiber cash out</dt><dd>{profile ? (profile.supportsFiberMelt ? "Advertised" : "Not advertised") : "Unavailable"}</dd></div>
          <div><dt>Lost-response recovery</dt><dd>{profile ? (profile.supportsRestore ? "NUT-09 advertised" : "Not advertised") : "Unavailable"}</dd></div>
          <div><dt>Swap response cache</dt><dd>{profile ? (profile.supportsReplaySafeSwap ? "NUT-19 advertised" : "Not advertised") : "Unavailable"}</dd></div>
          <div><dt>Issuance response cache</dt><dd>{profile ? (profile.supportsReplaySafeMint ? "NUT-19 advertised" : "Not advertised") : "Unavailable"}</dd></div>
          <div><dt>Server version</dt><dd className="mono">{profile?.version || "Unavailable"}</dd></div>
          <div><dt>Supported NUTs</dt><dd className="mono detail-list__clip">{profile?.supportedNuts.length ? profile.supportedNuts.join(", ") : "Unavailable"}</dd></div>
          <div><dt>Public key</dt><dd className="mono detail-list__clip">{profile?.pubkey || "Unavailable"}</dd></div>
        </dl>
        {connectionError ? <Notice tone="recoverable" title={status === "incompatible" ? "Mint is incompatible" : "Mint could not be reached"}>{connectionError}</Notice> : null}
        <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>Check connection</Button>
      </div>

      <aside className="mint-layout__aside">
        <Notice tone="recoverable" title="Bounded custodial trust">
          This mint claims custody of the backing asset and controls issuance and redemption. Cashu reduces transfer linkability; it does not remove mint custody or redemption policy.
        </Notice>
        <div className="trust-boundaries">
          <div><CheckCircle2 size={18} aria-hidden="true" /><span><strong>What the wallet checks</strong>Mint URL, unit, token state, and returned proofs.</span></div>
          <div><ShieldAlert size={18} aria-hidden="true" /><span><strong>What it cannot prove</strong>Backing-asset identity, mint solvency, operator policy, or future redemption access.</span></div>
        </div>
        <form className="change-mint" onSubmit={submit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="mint-url">Mint URL</label>
            <input id="mint-url" type="url" value={draft} spellCheck={false} autoComplete="url" aria-invalid={error ? "true" : undefined} onChange={(event) => { setDraft(event.target.value); setError(null); }} />
            {error ? <p className="field__error">{error}</p> : <p className="field__hint">Balances and activity are kept separately for each mint URL.</p>}
          </div>
          <Button type="submit" icon={Link2}>Use this mint</Button>
        </form>
      </aside>
    </div>
  );
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
