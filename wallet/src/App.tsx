import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Proof } from "@cashu/cashu-ts";

import {
  explainMeltError,
  FibernutsWallet,
  fmt,
  loadProofs,
  parseAmount,
  saveProofs,
  sumProofs,
  units,
  type MeltQuote,
  type MintQuote,
} from "./lib/wallet";

/** In dev, vite proxies /v1 to the mint, so same-origin works. */
const DEFAULT_MINT = window.location.port === "5174" ? window.location.origin : "http://127.0.0.1:8085";

const TABS: { id: Tab; glyph: string }[] = [
  { id: "mint", glyph: "↓" },
  { id: "send", glyph: "→" },
  { id: "receive", glyph: "←" },
  { id: "melt", glyph: "↑" },
];
type Tab = "mint" | "send" | "receive" | "melt";

export default function App() {
  const [mintUrl, setMintUrl] = useState(DEFAULT_MINT);
  const [wallet, setWallet] = useState<FibernutsWallet | null>(null);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [tab, setTab] = useState<Tab>("mint");
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWallet(null);
    setError(null);
    setStatus("connecting");

    const w = new FibernutsWallet(mintUrl);
    w.load()
      .then(() => {
        if (cancelled) return;
        setWallet(w);
        setProofs(loadProofs(mintUrl));
        setStatus("online");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus("offline");
        setError(`No mint at ${mintUrl} — ${describe(e)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [mintUrl]);

  const commit = useCallback(
    (next: Proof[]) => {
      setProofs(next);
      saveProofs(mintUrl, next);
    },
    [mintUrl],
  );

  const balance = sumProofs(proofs);
  const ticker = wallet?.ticker ?? "···";
  const host = safeHost(mintUrl);

  return (
    <div className="scene">
      <div className="grid" aria-hidden />
      <div className="scan" aria-hidden />

      <main className="shell">
        <header className="masthead">
          <div className="brand">
            <BrandMark />
            <div className="wordmark">
              <h1>
                FIBER<span>NUTS</span>
              </h1>
              <p className="tagline">
                ecash over the fiber network<span className="tick"> ▮</span>
              </p>
            </div>
          </div>
          <div className={`link link-${status}`}>
            <span className="dot" />
            <span className="link-label">{status === "online" ? "linked" : status}</span>
          </div>
        </header>

        <section className="vault">
          <Corner />
          <div className="vault-head">
            <span>balance</span>
            <span className="vault-asset">{ticker}</span>
          </div>
          <div className="vault-amount">
            <span className="amount">{fmt(balance)}</span>
            <span className="amount-unit">{ticker}</span>
          </div>
          <div className="vault-meta">
            <span>{balance} units</span>
            <span className="sep">/</span>
            <span>{proofs.length} proofs</span>
            <span className="sep">/</span>
            <span>bearer · local</span>
          </div>
        </section>

        <div className="conn">
          <span className="conn-caret">mint@</span>
          <input
            aria-label="mint url"
            value={mintUrl}
            spellCheck={false}
            onChange={(e) => setMintUrl(e.target.value.trim())}
          />
        </div>

        {error && <p className="alert">{error}</p>}

        <nav className="rail">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "seg on" : "seg"}
              onClick={() => setTab(t.id)}
            >
              <span className="seg-glyph">{t.glyph}</span>
              {t.id}
            </button>
          ))}
        </nav>

        {wallet ? (
          <>
            {tab === "mint" && <MintPanel wallet={wallet} proofs={proofs} commit={commit} ticker={ticker} />}
            {tab === "send" && <SendPanel wallet={wallet} proofs={proofs} commit={commit} ticker={ticker} />}
            {tab === "receive" && <ReceivePanel wallet={wallet} proofs={proofs} commit={commit} ticker={ticker} />}
            {tab === "melt" && <MeltPanel wallet={wallet} proofs={proofs} commit={commit} ticker={ticker} />}
          </>
        ) : (
          <section className="panel booting">
            <span className="spinner" /> {status === "offline" ? "no signal" : "establishing link…"}
          </section>
        )}

        <footer className="readout">
          <span>◈ {host}</span>
          <span>unit={ticker.toLowerCase()}</span>
          <span>1 unit = 1 cent</span>
        </footer>
      </main>
    </div>
  );
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

interface PanelProps {
  wallet: FibernutsWallet;
  proofs: Proof[];
  commit: (next: Proof[]) => void;
  ticker: string;
}

function MintPanel({ wallet, proofs, commit, ticker }: PanelProps) {
  const [amount, setAmount] = useState("1.00");
  const [quote, setQuote] = useState<MintQuote | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const polling = useRef<number | null>(null);

  const stopPolling = () => {
    if (polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  const request = async () => {
    const value = parseAmount(amount);
    if (value === null) {
      setNote("Enter an amount like 1.00 (minimum 0.01).");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const q = await wallet.requestMint(value);
      setQuote(q);
      setNote("Pay this Fiber invoice. The mint credits you once the TLC settles.");

      stopPolling();
      polling.current = window.setInterval(async () => {
        try {
          if (!(await wallet.mintQuotePaid(q.quote))) return;
          stopPolling();
          const claimed = await wallet.claim(q);
          commit([...proofs, ...claimed]);
          setQuote(null);
          setNote(`Minted ${fmt(sumProofs(claimed))} ${ticker}.`);
        } catch (e) {
          stopPolling();
          setNote(describe(e));
        }
      }, 2000);
    } catch (e) {
      setNote(describe(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Mint" caption={`Issue a ${ticker} invoice on the Fiber node. Pay it to get ecash.`}>
      <div className="row">
        <MoneyInput value={amount} onChange={setAmount} ticker={ticker} />
        <button className="go" disabled={busy} onClick={request}>
          {busy ? "···" : "request"}
        </button>
      </div>
      {quote && (
        <>
          <Copyable label="fiber invoice" value={quote.request} />
          <p className="waiting">
            <span className="spinner" /> waiting for settlement
          </p>
        </>
      )}
      <Note note={note} />
    </Panel>
  );
}

function SendPanel({ wallet, proofs, commit, ticker }: PanelProps) {
  const [amount, setAmount] = useState("0.50");
  const [token, setToken] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const create = async () => {
    const value = parseAmount(amount);
    if (value === null) return setNote("Enter an amount like 0.50.");
    if (value > sumProofs(proofs)) return setNote("Not enough balance.");
    setNote(null);
    try {
      const { token: t, keep } = await wallet.send(value, proofs);
      commit(keep);
      setToken(t);
    } catch (e) {
      setNote(describe(e));
    }
  };

  return (
    <Panel title="Send" caption="Cut a bearer token from your balance. Whoever holds it can redeem it.">
      <div className="row">
        <MoneyInput value={amount} onChange={setAmount} ticker={ticker} />
        <button className="go" onClick={create}>
          cut token
        </button>
      </div>
      {token && <Copyable label="cashu token" value={token} />}
      <Note note={note} />
    </Panel>
  );
}

function ReceivePanel({ wallet, proofs, commit, ticker }: PanelProps) {
  const [token, setToken] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const redeem = async () => {
    if (!token.trim()) return;
    setNote(null);
    try {
      const received = await wallet.receive(token.trim());
      commit([...proofs, ...received]);
      setToken("");
      setNote(`Received ${fmt(sumProofs(received))} ${ticker}.`);
    } catch (e) {
      setNote(describe(e));
    }
  };

  return (
    <Panel title="Receive" caption="Redeem a token issued by this mint.">
      <textarea
        rows={4}
        value={token}
        spellCheck={false}
        placeholder="cashuB…"
        onChange={(e) => setToken(e.target.value)}
      />
      <button className="go wide" onClick={redeem}>
        redeem
      </button>
      <Note note={note} />
    </Panel>
  );
}

function MeltPanel({ wallet, proofs, commit, ticker }: PanelProps) {
  const [invoice, setInvoice] = useState("");
  const [quote, setQuote] = useState<MeltQuote | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const price = async () => {
    if (!invoice.trim()) return;
    setBusy(true);
    setNote(null);
    setQuote(null);
    try {
      setQuote(await wallet.requestMelt(invoice.trim()));
    } catch (e) {
      // The mint probes a real route here, so "no route" surfaces before any proof is spent —
      // but cdk reports it as the misleading "Unit unsupported", so translate it.
      setNote(explainMeltError(describe(e)));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (!quote) return;
    setBusy(true);
    setNote(null);
    try {
      const remaining = await wallet.melt(quote, proofs);
      commit(remaining);
      setQuote(null);
      setInvoice("");
      setNote("Paid.");
    } catch (e) {
      setNote(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const total = quote ? units(quote.amount) + units(quote.fee_reserve) : 0;
  const short = quote ? total > sumProofs(proofs) : false;

  return (
    <Panel
      title="Melt"
      caption="Spend ecash to pay an external Fiber invoice — a merchant, another node. Not an invoice from this mint (that would be the mint paying itself)."
    >
      <textarea
        rows={3}
        value={invoice}
        spellCheck={false}
        placeholder="external fibt1… / fibd1… invoice"
        onChange={(e) => setInvoice(e.target.value)}
      />
      <button className="go wide" disabled={busy} onClick={price}>
        {busy ? "···" : "get quote"}
      </button>

      {quote && (
        <div className="quote">
          <Line label="amount" value={`${fmt(units(quote.amount))} ${ticker}`} />
          <Line label="fee reserve" value={`${fmt(units(quote.fee_reserve))} ${ticker}`} />
          <Line label="total" value={`${fmt(total)} ${ticker}`} strong />
          <button className="go wide" disabled={busy || short} onClick={pay}>
            {short ? "insufficient balance" : "pay invoice"}
          </button>
        </div>
      )}
      <Note note={note} />
    </Panel>
  );
}

function Panel({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <section className="panel">
      <Corner />
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="panel-index">// {title.toLowerCase()}</span>
      </div>
      <p className="caption">{caption}</p>
      {children}
    </section>
  );
}

function MoneyInput({ value, onChange, ticker }: { value: string; onChange: (v: string) => void; ticker: string }) {
  return (
    <div className="money">
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" />
      <span className="money-unit">{ticker}</span>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "line strong" : "line"}>
      <span>{label}</span>
      <span className="line-val">{value}</span>
    </div>
  );
}

function Note({ note }: { note: string | null }) {
  if (!note) return null;
  return <p className="note">{note}</p>;
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <div className="copy-head">
        <span>{label}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <code>{value}</code>
    </div>
  );
}

function Corner() {
  return (
    <>
      <span className="corner tl" aria-hidden />
      <span className="corner tr" aria-hidden />
      <span className="corner bl" aria-hidden />
      <span className="corner br" aria-hidden />
    </>
  );
}

function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 48 48" width="42" height="42" aria-hidden>
      <defs>
        <linearGradient id="fn" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22e0ff" />
          <stop offset="1" stopColor="#ff2d78" />
        </linearGradient>
      </defs>
      <path
        d="M24 3 42 13.5v21L24 45 6 34.5v-21z"
        fill="none"
        stroke="url(#fn)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M24 12 34 18v12l-10 6-10-6V18z"
        fill="none"
        stroke="url(#fn)"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <circle cx="24" cy="24" r="3.4" fill="url(#fn)" />
    </svg>
  );
}
