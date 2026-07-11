import {
  Mint,
  Wallet,
  getEncodedToken,
  type Amount,
  type MeltQuoteBaseResponse,
  type MintQuoteBaseResponse,
  type Proof,
} from "@cashu/cashu-ts";

/** The Cashu payment method fibernuts serves. */
export const METHOD = "fiber";

/** The unit the wallet falls back to when the mint advertises none. */
export const DEFAULT_UNIT = "rusd";

/** The mint's quote response for the `fiber` method. */
export type MintQuote = MintQuoteBaseResponse & {
  amount: Amount;
  amount_paid?: Amount;
};

/** cdk's custom melt quote carries a fee reserve alongside the base fields. */
export type MeltQuote = MeltQuoteBaseResponse & {
  fee_reserve: Amount;
};

/**
 * Coerce a cashu-ts amount to a plain integer.
 *
 * cashu-ts models amounts as an `Amount` class (with `.toNumber()`), but a proof's amount
 * serializes to a **string** through JSON — so once proofs round-trip through localStorage the
 * class is gone. Handle every shape the value can actually take at runtime.
 */
export function units(amount: Amount | number | string | bigint): number {
  if (typeof amount === "number") return amount;
  if (typeof amount === "bigint") return Number(amount);
  if (typeof amount === "string") return Number(amount);
  if (typeof (amount as { toNumber?: () => number }).toNumber === "function") {
    return (amount as { toNumber: () => number }).toNumber();
  }
  return Number(amount);
}

/** Store proof amounts as plain numbers, so they survive JSON and re-feed cleanly to cashu-ts. */
function normalizeProof(p: Proof): Proof {
  return { ...p, amount: units(p.amount) } as unknown as Proof;
}

/** Renders ecash units at cent granularity, e.g. 12345 -> "123.45". No currency symbol —
 * the unit ticker is shown alongside, because the backing asset need not be dollars. */
export function fmt(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Parses a "12.34" amount into 1234 ecash units. Returns null when not a clean amount. */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim().replace(/^[$]/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, cents = ""] = trimmed.split(".");
  const value = Number(whole) * 100 + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((total, p) => total + units(p.amount), 0);
}

/**
 * Turn a melt-quote failure into something actionable.
 *
 * cdk-mintd relabels *any* failed melt route-probe — no route, wrong unit, a self-payment — as
 * the catch-all `Unit unsupported` (NUT error 11013). The most common cause in practice is pasting
 * an invoice issued by this same mint: melt asks the mint to *pay* the invoice, and a mint cannot
 * pay its own node. A mint invoice is paid *to* the mint (the Mint tab); Melt pays an external one.
 */
export function explainMeltError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("unit unsupported") || m.includes("could not get quote") || m.includes("11013")) {
    return "The mint could not route a payment to this invoice. Melt pays an external Fiber invoice — you cannot melt an invoice issued by this mint (that would be the mint paying itself). Use an invoice from a different node that the mint can reach, in the same unit.";
  }
  return message;
}

const storageKey = (mintUrl: string) => `fibernuts:proofs:${mintUrl}`;

export function loadProofs(mintUrl: string): Proof[] {
  try {
    const raw = localStorage.getItem(storageKey(mintUrl));
    if (!raw) return [];
    return (JSON.parse(raw) as Proof[]).map(normalizeProof);
  } catch {
    return [];
  }
}

export function saveProofs(mintUrl: string, proofs: Proof[]): void {
  localStorage.setItem(storageKey(mintUrl), JSON.stringify(proofs.map(normalizeProof)));
}

/** A wallet bound to one mint. Its unit is whatever the mint advertises — RUSD, or any other
 * asset the operator's Fiber node settles. */
export class FibernutsWallet {
  readonly mintUrl: string;
  /** The mint's unit, lowercase (e.g. `rusd`, `fnut`). Resolved by `load()`. */
  unit = DEFAULT_UNIT;
  private wallet: Wallet;

  constructor(mintUrl: string) {
    this.mintUrl = mintUrl;
    this.wallet = new Wallet(new Mint(mintUrl), { unit: this.unit });
  }

  /** The unit as a display ticker, e.g. `RUSD`. */
  get ticker(): string {
    return this.unit.toUpperCase();
  }

  async load(): Promise<void> {
    const detected = await this.detectUnit();
    if (detected && detected !== this.unit) {
      this.unit = detected;
      this.wallet = new Wallet(new Mint(this.mintUrl), { unit: this.unit });
    }
    await this.wallet.loadMint();
  }

  /** Read the mint's advertised unit from its keysets, so the wallet labels amounts correctly. */
  private async detectUnit(): Promise<string | null> {
    try {
      const res = await fetch(`${this.mintUrl.replace(/\/$/, "")}/v1/keysets`);
      if (!res.ok) return null;
      const body = (await res.json()) as { keysets?: Array<{ unit?: string; active?: boolean }> };
      const active = body.keysets?.find((k) => k.active && k.unit) ?? body.keysets?.find((k) => k.unit);
      return active?.unit ?? null;
    } catch {
      return null;
    }
  }

  /** Ask the mint for a Fiber invoice to pay. */
  async requestMint(amount: number): Promise<MintQuote> {
    return this.wallet.createMintQuote<MintQuote>(METHOD, { amount, unit: this.unit });
  }

  /** Whether the mint has seen the quote's invoice settle. */
  async mintQuotePaid(quote: string): Promise<boolean> {
    const state = await this.wallet.checkMintQuote<MintQuote>(METHOD, quote);
    return state.amount_paid !== undefined && units(state.amount_paid) > 0;
  }

  /** Redeem a settled quote for proofs. */
  async claim(quote: MintQuote): Promise<Proof[]> {
    return this.wallet.mintProofs(METHOD, quote.amount, quote);
  }

  /**
   * Price a Fiber invoice. The mint runs a real route probe on its node here, so an unroutable
   * invoice is rejected at quote time rather than after the wallet has spent its proofs.
   */
  async requestMelt(invoice: string): Promise<MeltQuote> {
    // The HTTP body carries `method` even though the mint's gRPC bridge strips it before the
    // backend ever sees it — cdk's `MeltQuoteCustomRequest` requires the field.
    return this.wallet.createMeltQuote<MeltQuote>(METHOD, {
      method: METHOD,
      request: invoice,
      unit: this.unit,
    });
  }

  /** Spend proofs to settle a melt quote. Returns the proofs that survive as change. */
  async melt(quote: MeltQuote, proofs: Proof[]): Promise<Proof[]> {
    const needed = units(quote.amount) + units(quote.fee_reserve);
    const { send, keep } = await this.wallet.send(needed, proofs);
    const result = await this.wallet.meltProofs(METHOD, quote, send);
    return [...keep, ...result.change];
  }

  /** Split `amount` out of `proofs` into a transferable token. */
  async send(amount: number, proofs: Proof[]): Promise<{ token: string; keep: Proof[] }> {
    const { send, keep } = await this.wallet.send(amount, proofs);
    const token = getEncodedToken({ mint: this.mintUrl, proofs: send, unit: this.unit });
    return { token, keep };
  }

  /** Redeem a token issued by this mint. */
  async receive(token: string): Promise<Proof[]> {
    return this.wallet.receive(token);
  }
}
