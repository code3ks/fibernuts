import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Info,
  LoaderCircle,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";

export type Tone = "neutral" | "pending" | "settled" | "failed" | "recoverable";

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: Info,
  pending: Clock3,
  settled: CheckCircle2,
  failed: XCircle,
  recoverable: RefreshCw,
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "accent" | "secondary" | "danger" | "ghost";
  icon?: LucideIcon;
  busy?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  icon: Icon,
  busy = false,
  disabled,
  className = "",
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`button button--${variant} ${className}`.trim()}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
    >
      {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : Icon ? <Icon size={18} aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({ label, icon: Icon, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: LucideIcon;
}) {
  return (
    <button {...props} type="button" className="icon-button" aria-label={label} title={label}>
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={`status status--${tone}`}>
      <Icon size={14} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export function Notice({ tone = "neutral", title, children, action }: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === "failed" ? AlertTriangle : TONE_ICON[tone];
  return (
    <div className={`notice notice--${tone}`} role={tone === "failed" ? "alert" : "status"}>
      <Icon size={19} aria-hidden="true" />
      <div>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
        {action ? <div className="notice__action">{action}</div> : null}
      </div>
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="copy-button" onClick={() => void copy()}>
      {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

export function QrPanel({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  return (
    <div className="qr-panel">
      <div className="qr-panel__code" style={{ "--qr-size": `${size}px` } as CSSProperties}>
        <QRCodeSVG value={value} size={size} level="M" marginSize={2} title={`${label} QR code`} />
      </div>
      <code className="qr-panel__preview">{value.slice(0, 22)}...{value.slice(-8)}</code>
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

export function TextArea({ id, label, value, onChange, placeholder, hint, error, rows = 4 }: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  rows?: number;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <textarea
        id={inputId}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy}
      />
      {error ? <p className="field__error" id={`${inputId}-error`}>{error}</p> : hint ? <p className="field__hint" id={`${inputId}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function AmountField({ id, label, value, onChange, error, disabled }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
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
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>RUSD</span>
      </div>
      {error ? <p className="field__error" id={`${id}-error`}>{error}</p> : null}
    </div>
  );
}

export function ScreenHeading({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="screen-heading">
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}
