import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Info,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Share2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

import type { OperationTone, WalletOperation } from "../domain/operations";

const TONE_ICON: Record<OperationTone, LucideIcon> = {
  neutral: Info,
  pending: Clock3,
  settled: CheckCircle2,
  failed: XCircle,
  recoverable: RefreshCw,
};

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"}>
      <svg className="brand__mark" width="26" height="29" viewBox="0 0 20 22" fill="none" aria-hidden="true">
        <path
          d="M10 1.5c4.4 0 8 3.7 8 9.4 0 6-3.6 9.6-8 9.6s-8-3.6-8-9.6c0-5.7 3.6-9.4 8-9.4Z"
          className="brand__mark-fill"
        />
        <path
          d="M10 1.5c4.4 0 8 3.7 8 9.4 0 6-3.6 9.6-8 9.6s-8-3.6-8-9.6c0-5.7 3.6-9.4 8-9.4Z"
          className="brand__mark-line"
        />
        <path d="M10 4.6c2.2 1.9 3.4 4.2 3.4 6.6 0 2.6-1.2 4.9-3.4 6.8" className="brand__mark-detail" />
      </svg>
      <span className="brand__name">FiberNuts</span>
    </div>
  );
}

type ButtonVariant = "primary" | "accent" | "secondary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  busy = false,
  icon: Icon,
  children,
  className = "",
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`button button--${variant} ${className}`.trim()}
      aria-busy={busy || undefined}
      disabled={busy || disabled}
    >
      {busy ? <LoaderCircle className="button__spinner" size={18} aria-hidden="true" /> : Icon ? <Icon size={18} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function AmountInput({
  id,
  label,
  value,
  unit,
  onChange,
  error,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className={`amount-field${error ? " amount-field--error" : ""}`}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          placeholder="0.00"
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>{unit}</span>
      </div>
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function QuickAmounts({ values, onSelect }: { values: string[]; onSelect: (value: string) => void }) {
  return (
    <div className="quick-amounts" aria-label="Suggested amounts">
      {values.map((value) => (
        <button type="button" key={value} onClick={() => onSelect(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}

export function StatusBadge({ tone, children }: { tone: OperationTone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: OperationTone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`notice notice--${tone}`} role={tone === "failed" ? "alert" : "status"}>
      <Icon className="notice__icon" size={19} aria-hidden="true" />
      <div className="notice__body">
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
        {action ? <div className="notice__action">{action}</div> : null}
      </div>
    </div>
  );
}

export interface ProgressStep {
  label: string;
  detail: string;
  state: "todo" | "active" | "done" | "failed";
}

export function ProgressSteps({ steps }: { steps: ProgressStep[] }) {
  return (
    <ol className="progress-steps">
      {steps.map((step) => (
        <li className={`progress-step progress-step--${step.state}`} key={step.label}>
          <span className="progress-step__rail" aria-hidden="true">
            <span className="progress-step__dot">{step.state === "done" ? <Check size={12} /> : step.state === "failed" ? "!" : ""}</span>
            <span className="progress-step__line" />
          </span>
          <span className="progress-step__copy">
            <strong>{step.label}</strong>
            <span>{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function QrPanel({
  value,
  label,
  sensitive = false,
  shareable = false,
  size = 212,
}: {
  value: string;
  label: string;
  sensitive?: boolean;
  shareable?: boolean;
  size?: number;
}) {
  return (
    <div className="qr-panel">
      <div className="qr-panel__code" style={{ "--qr-size": `${size}px` } as CSSProperties}>
        <QRCodeSVG value={value} size={size} level="M" marginSize={2} title={`${label} QR code`} />
      </div>
      <code className={sensitive ? "qr-panel__text qr-panel__text--sensitive" : "qr-panel__text"}>
        {sensitive ? `${value.slice(0, 24)}...${value.slice(-10)}` : `${value.slice(0, 30)}...${value.slice(-10)}`}
      </code>
      <div className="qr-panel__actions">
        <CopyButton value={value} label={sensitive ? "Copy token" : `Copy ${label.toLowerCase()}`} sensitive={sensitive} />
        {shareable ? <ShareButton value={value} label={`Share ${label.toLowerCase()}`} /> : null}
      </div>
    </div>
  );
}

function ShareButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<"shared" | "copied" | null>(null);
  const share = async () => {
    try {
      const canShare = "share" in navigator && typeof navigator.share === "function";
      if (canShare) {
        await navigator.share({ title: label, text: value });
      } else {
        await navigator.clipboard.writeText(value);
      }
      setResult(canShare ? "shared" : "copied");
      window.setTimeout(() => setResult(null), 1500);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setResult(null);
    }
  };

  return (
    <button type="button" className="copy-button" onClick={() => void share()}>
      {result ? <Check size={16} aria-hidden="true" /> : <Share2 size={16} aria-hidden="true" />}
      <span>{result === "shared" ? "Shared" : result === "copied" ? "Copied" : label}</span>
    </button>
  );
}

export function CopyButton({ value, label = "Copy", sensitive = false }: { value: string; label?: string; sensitive?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => void copy()}
      aria-label={sensitive ? `${label}. This is bearer data.` : label}
    >
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

export function OperationGlyph({ operation }: { operation: WalletOperation }) {
  const Icon = operation.kind === "add" ? Plus : operation.kind === "send" ? ArrowUpRight : operation.kind === "receive" ? ArrowDownLeft : Minus;
  return <Icon size={17} aria-hidden="true" />;
}

export function FormTextarea({
  id,
  label,
  value,
  placeholder,
  rows = 4,
  onChange,
  error,
  hint,
}: {
  id?: string;
  label: string;
  value: string;
  placeholder: string;
  rows?: number;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        rows={rows}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p className="field__error" id={`${inputId}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />;
}

export function ErrorBoundaryFallback({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Notice tone="failed" title="The wallet could not continue">
      <p>{message}</p>
      <Button variant="secondary" onClick={onRetry} icon={RefreshCw}>
        Reload wallet
      </Button>
    </Notice>
  );
}

export function WarningIcon() {
  return <AlertTriangle size={18} aria-hidden="true" />;
}
