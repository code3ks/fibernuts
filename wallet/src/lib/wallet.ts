import {
  CheckStateEnum,
  hasValidDleq,
  parseP2PKSecret,
  Mint,
  OutputData,
  Wallet,
  getEncodedToken,
  type Amount,
  type GetInfoResponse,
  type MeltPreview,
  type MeltQuoteBaseResponse,
  type MintPreview,
  type MintQuoteBaseResponse,
  type PostRestoreResponse,
  type Proof,
  type P2PKOptions,
  type OutputConfig,
  type SerializedBlindedSignature,
  type SerializedOutputData,
  type SwapPreview,
} from "@cashu/cashu-ts";

import type { StoredSwapPreview } from "../domain/operations";

/** The Cashu payment method fibernuts serves. */
export const METHOD = "fiber";

/** The unit the wallet falls back to when the mint advertises none. */
export const DEFAULT_UNIT = "rusd";

/** The mint's quote response for the `fiber` method. */
export type MintQuote = MintQuoteBaseResponse & {
  amount: Amount;
  amount_paid?: Amount;
  state?: "UNPAID" | "PAID" | "ISSUED";
  expiry?: number | null;
};

/** cdk's custom melt quote carries a fee reserve alongside the base fields. */
export type MeltQuote = MeltQuoteBaseResponse & {
  fee_reserve: Amount;
  request: string;
};

export interface MintProfile {
  name: string;
  description?: string;
  version: string;
  pubkey: string;
  contact: GetInfoResponse["contact"];
  supportedNuts: number[];
  unit: string;
  supportsFiberMint: boolean;
  supportsFiberMelt: boolean;
  supportsRestore: boolean;
  supportsReplaySafeMint: boolean;
  supportsReplaySafeSwap: boolean;
}

export class MintCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintCompatibilityError";
  }
}

export interface InspectedToken {
  amount: number;
  mint: string;
  unit: string;
  proofs: Proof[];
  memo?: string;
}

export type TokenSpendState = "unspent" | "pending" | "spent" | "mixed";

export interface PreparedMelt {
  keep: Proof[];
  reservedProofs: Proof[];
  outputData: SerializedOutputData[];
  keysetId: string;
  inputFee: number;
}

export interface PreparedMint {
  outputData: SerializedOutputData[];
  keysetId: string;
  legacySignature?: string;
  payloadSignature?: string;
}

export interface MeltExecution {
  state: "UNPAID" | "PENDING" | "PAID";
  change: Proof[];
  outputData: SerializedOutputData[];
}

export type PreparedSend =
  | { mode: "offline"; keep: Proof[]; send: Proof[]; debit: number; fee: number }
  | { mode: "swap"; swap: StoredSwapPreview; debit: number; fee: number };

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
export function normalizeProof(p: Proof): Proof {
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

/** A custom mint quote is funded only after its state is final or its full amount was observed. */
export function mintQuoteIsPaid(quote: MintQuote): boolean {
  return quote.state === "PAID" || quote.state === "ISSUED" || (
    quote.state === undefined &&
    quote.amount_paid !== undefined &&
    units(quote.amount_paid) >= units(quote.amount)
  );
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

/** A wallet bound to one mint. Its unit is whatever the mint advertises — RUSD, or any other
 * asset the operator's Fiber node settles. */
export class FibernutsWallet {
  readonly mintUrl: string;
  /** The mint's unit, lowercase (e.g. `rusd`, `fnut`). Resolved by `load()`. */
  unit = DEFAULT_UNIT;
  private wallet: Wallet;

  constructor(mintUrl: string) {
    this.mintUrl = mintUrl;
    this.wallet = new Wallet(new Mint(mintUrl), { unit: this.unit, requireSigDleq: true });
  }

  /** The unit as a display ticker, e.g. `RUSD`. */
  get ticker(): string {
    return this.unit.toUpperCase();
  }

  get profile(): MintProfile {
    const info = this.wallet.getMintInfo();
    const supports = (entry: GetInfoResponse["nuts"]["4"] | GetInfoResponse["nuts"]["5"] | undefined) =>
      Boolean(entry && !entry.disabled && Array.isArray(entry.methods) && entry.methods.some(
        (method) => method.method.toLowerCase() === METHOD && method.unit.toLowerCase() === this.unit.toLowerCase(),
      ));
    const cachedEndpoints = info.nuts["19"]?.cached_endpoints ?? [];
    const caches = (path: string) => cachedEndpoints.some(
      (endpoint) => endpoint.method === "POST" && endpoint.path.replace(/\/$/, "") === path,
    );
    return {
      name: info.name,
      description: info.description,
      version: info.version,
      pubkey: info.pubkey,
      contact: info.contact,
      supportedNuts: Object.keys(info.nuts)
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b),
      unit: this.unit,
      supportsFiberMint: supports(info.nuts["4"]),
      supportsFiberMelt: supports(info.nuts["5"]),
      supportsRestore: info.nuts["9"]?.supported === true,
      supportsReplaySafeMint: caches(`/v1/mint/${METHOD}`),
      supportsReplaySafeSwap: caches("/v1/swap"),
    };
  }

  async load(): Promise<void> {
    const detected = await this.detectUnit();
    if (detected && detected !== this.unit) {
      this.unit = detected.toLowerCase();
      this.wallet = new Wallet(new Mint(this.mintUrl), { unit: this.unit, requireSigDleq: true });
    }
    await this.wallet.loadMint();
    const profile = this.profile;
    if (
      !profile.supportsFiberMint ||
      !profile.supportsFiberMelt ||
      !profile.supportsRestore
    ) {
      const missing = [
        !profile.supportsFiberMint ? `mint/${METHOD}` : null,
        !profile.supportsFiberMelt ? `melt/${METHOD}` : null,
        !profile.supportsRestore ? "NUT-09 proof restoration" : null,
      ].filter(Boolean).join(" and ");
      throw new MintCompatibilityError(
        `This server does not advertise ${missing} for unit ${this.ticker}. No wallet operation is available.`,
      );
    }
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
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Add-cash amount must be a positive integer.");
    const quote = await this.wallet.createMintQuote<MintQuote>(METHOD, { amount, unit: this.unit });
    if (typeof quote.unit !== "string" || quote.unit.toLowerCase() !== this.unit || units(quote.amount) !== amount) {
      throw new Error("The mint returned a quote for a different amount or unit.");
    }
    if (!quote.quote || !quote.request) {
      throw new Error("The mint returned an incomplete add-cash quote.");
    }
    return quote;
  }

  /** Whether the mint has seen the quote's invoice settle. */
  async mintQuotePaid(quote: string): Promise<boolean> {
    const state = await this.checkMintQuote(quote);
    return mintQuoteIsPaid(state);
  }

  async checkMintQuote(quote: string): Promise<MintQuote> {
    return this.wallet.checkMintQuote<MintQuote>(METHOD, quote);
  }

  /** Prepare mint outputs so their secrets can be stored before issuance. */
  async prepareMint(quote: MintQuote): Promise<PreparedMint> {
    const preview = await this.wallet.prepareMint(METHOD, quote.amount, quote);
    return {
      outputData: preview.outputData.map(OutputData.serialize),
      keysetId: preview.keysetId,
      legacySignature: preview.legacySignature,
      payloadSignature: preview.payload.signature,
    };
  }

  /** Complete a mint, restoring the exact prepared outputs if the response was lost. */
  async completeMint(quote: MintQuote, prepared: PreparedMint): Promise<Proof[]> {
    const outputData = prepared.outputData.map(OutputData.deserialize);
    const preview: MintPreview<MintQuote> = {
      method: METHOD,
      payload: {
        quote: quote.quote,
        outputs: outputData.map((output) => output.blindedMessage),
        signature: prepared.payloadSignature,
      },
      outputData,
      keysetId: prepared.keysetId,
      quote,
      legacySignature: prepared.legacySignature,
    };
    try {
      return (await this.wallet.completeMint(preview)).map(normalizeProof);
    } catch (reason) {
      const restored = await this.tryRestoreOutputs(prepared.outputData);
      if (restored) return restored;
      throw reason;
    }
  }

  /**
   * Price a Fiber invoice. The mint runs a real route probe on its node here, so an unroutable
   * invoice is rejected at quote time rather than after the wallet has spent its proofs.
   */
  async requestMelt(invoice: string): Promise<MeltQuote> {
    // The HTTP body carries `method` even though the mint's gRPC bridge strips it before the
    // backend ever sees it — cdk's `MeltQuoteCustomRequest` requires the field.
    const quote = await this.wallet.createMeltQuote<MeltQuote>(METHOD, {
      method: METHOD,
      request: invoice,
      unit: this.unit,
    });
    const amount = units(quote.amount);
    const feeReserve = units(quote.fee_reserve);
    if (
      typeof quote.unit !== "string" ||
      quote.unit.toLowerCase() !== this.unit ||
      quote.request !== invoice ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(feeReserve) ||
      feeReserve < 0 ||
      quote.state !== "UNPAID" ||
      !quote.quote
    ) {
      throw new Error("The mint returned an invalid or mismatched cash-out quote.");
    }
    return quote;
  }

  async checkMeltQuote(quote: string): Promise<MeltQuote> {
    return this.wallet.checkMeltQuote<MeltQuote>(METHOD, quote);
  }

  /** Reserve the proofs for a melt and prepare serializable NUT-08 change outputs. */
  async prepareMelt(quote: MeltQuote, proofs: Proof[]): Promise<PreparedMelt> {
    if (quote.expiry && quote.expiry * 1000 <= Date.now()) {
      throw new Error("This cash-out quote has expired. Request a new quote before reserving proofs.");
    }
    const needed = units(quote.amount) + units(quote.fee_reserve);
    const { send, keep } = this.wallet.selectProofsToSend(proofs, needed, true);
    const preview = await this.wallet.prepareMelt(METHOD, quote, send);
    return {
      keep: keep.map(normalizeProof),
      reservedProofs: send.map(normalizeProof),
      outputData: preview.outputData.map(OutputData.serialize),
      keysetId: preview.keysetId,
      inputFee: units(this.wallet.getFeesForProofs(send)),
    };
  }

  /** Dispatch a previously persisted melt reservation. */
  async executeMelt(quote: MeltQuote, prepared: Omit<PreparedMelt, "keep">): Promise<MeltExecution> {
    const outputData = prepared.outputData.map(OutputData.deserialize);
    const preview: MeltPreview<MeltQuote> = {
      method: METHOD,
      inputs: prepared.reservedProofs,
      outputData,
      keysetId: prepared.keysetId,
      quote,
    };
    const result = await this.wallet.completeMelt(preview);
    return {
      state: result.quote.state,
      change: result.change.map(normalizeProof),
      outputData: result.outputData.map(OutputData.serialize),
    };
  }

  recoverMeltChange(outputData: SerializedOutputData[], quote: MeltQuote): Proof[] {
    if (!quote.change?.length) return [];
    return this.wallet
      .createMeltChangeProofs(outputData.map(OutputData.deserialize), quote.change)
      .map(normalizeProof);
  }

  /** Prepare an outgoing split, using a no-network exact selection whenever possible. */
  async prepareSend(amount: number, proofs: Proof[], lock?: P2PKOptions): Promise<PreparedSend> {
    if (lock) {
      const outputConfig: OutputConfig = {
        send: { type: "p2pk", options: lock },
        keep: { type: "random" },
      };
      const preview = await this.wallet.prepareSwapToSend(amount, proofs, { includeFees: true }, outputConfig);
      const swap = serializeSwapPreview(preview);
      const sendAmount = sumStoredOutputs(swap.sendOutputs);
      const debit = sendAmount + swap.fees;
      return { mode: "swap", swap, debit, fee: debit - amount };
    }
    try {
      const { send, keep } = this.wallet.sendOffline(amount, proofs, { includeFees: true });
      const debit = sumProofs(send);
      const fee = units(this.wallet.getFeesForProofs(send));
      if (debit !== amount + fee) throw new Error("Offline selection did not cover the recipient's proof fee.");
      return {
        mode: "offline",
        keep: keep.map(normalizeProof),
        send: send.map(normalizeProof),
        debit,
        fee,
      };
    } catch {
      const preview = await this.wallet.prepareSwapToSend(amount, proofs, { includeFees: true });
      const swap = serializeSwapPreview(preview);
      const sendAmount = sumStoredOutputs(swap.sendOutputs);
      const debit = sendAmount + swap.fees;
      return { mode: "swap", swap, debit, fee: debit - amount };
    }
  }

  async completePreparedSend(swap: StoredSwapPreview): Promise<{ token: string; change: Proof[] }> {
    try {
      const result = await this.wallet.completeSwap(deserializeSwapPreview(swap));
      const send = result.send.map(normalizeProof);
      return {
        token: this.encodeProofs(send),
        // cashu-ts appends the original unselected proofs to `keep`. Those proofs are already in
        // the live snapshot, so returning only fresh keep outputs avoids overwriting concurrent
        // balance changes while this network request is in flight.
        change: result.keep.slice(0, swap.keepOutputs?.length ?? 0).map(normalizeProof),
      };
    } catch (reason) {
      const restored = await this.tryRestoreSwap(swap);
      if (restored) {
        return {
          token: this.encodeProofs(restored.send),
          change: restored.keep.slice(0, swap.keepOutputs?.length ?? 0),
        };
      }
      throw reason;
    }
  }

  prepareReceive(token: string, privateKey?: string): Promise<StoredSwapPreview> {
    if (!privateKey) return this.wallet.prepareSwapToReceive(token).then(serializeSwapPreview);
    const inspected = this.inspectToken(token);
    const signed = this.wallet.signP2PKProofs(inspected.proofs, privateKey);
    return this.wallet.prepareSwapToReceive(signed).then(serializeSwapPreview);
  }

  tokenIsLockedTo(token: string, publicKey: string): boolean {
    const expected = publicKey.toLowerCase();
    return this.inspectToken(token).proofs.every((proof) => {
      try {
        const [kind, condition] = parseP2PKSecret(proof.secret);
        return kind === "P2PK" && condition.data.toLowerCase() === expected && (condition.tags ?? []).length === 0;
      } catch {
        return false;
      }
    });
  }

  async completePreparedReceive(swap: StoredSwapPreview): Promise<Proof[]> {
    try {
      const result = await this.wallet.completeSwap(deserializeSwapPreview(swap));
      return result.keep.map(normalizeProof);
    } catch (reason) {
      const restored = await this.tryRestoreSwap(swap);
      if (restored) return restored.keep;
      throw reason;
    }
  }

  encodeProofs(proofs: Proof[]): string {
    return getEncodedToken({ mint: this.mintUrl, proofs, unit: this.unit });
  }

  inspectToken(token: string): InspectedToken {
    const decoded = this.wallet.decodeToken(token);
    const amount = sumProofs(decoded.proofs);
    if (!Number.isSafeInteger(amount) || amount <= 0 || decoded.proofs.length === 0) {
      throw new Error("This token does not contain a valid positive amount.");
    }
    return {
      amount,
      mint: normalizeUrl(decoded.mint),
      unit: (decoded.unit ?? this.unit).toLowerCase(),
      proofs: decoded.proofs.map(normalizeProof),
      memo: decoded.memo,
    };
  }

  async checkTokenState(token: string): Promise<TokenSpendState> {
    const decoded = this.inspectToken(token);
    return this.checkProofsState(decoded.proofs);
  }

  async checkProofsState(proofs: Proof[]): Promise<TokenSpendState> {
    if (proofs.length === 0) throw new Error("A token with no proofs has no spend state.");
    const states = await this.wallet.checkProofsStates(proofs);
    const unique = new Set(states.map((item) => item.state));
    if (unique.size !== 1) return "mixed";
    const [state] = unique;
    if (state === CheckStateEnum.SPENT) return "spent";
    if (state === CheckStateEnum.PENDING) return "pending";
    if (state === CheckStateEnum.UNSPENT) return "unspent";
    return "mixed";
  }

  /** NUT-09 recovers signatures when a mint committed a request but its response was lost. */
  private async tryRestoreOutputs(serialized: SerializedOutputData[]): Promise<Proof[] | null> {
    if (serialized.length === 0) return [];

    try {
      const outputData = serialized.map(OutputData.deserialize);
      const response = await this.wallet.mint.restore({
        outputs: outputData.map((output) => output.blindedMessage),
      });
      const signatures = matchRestoredSignatures(serialized, response);
      if (!signatures) return null;

      const requireDleq = this.wallet.getMintInfo().nuts["12"]?.supported === true;
      const proofs: Proof[] = [];
      for (let index = 0; index < outputData.length; index += 1) {
        const output = outputData[index];
        const signature = signatures[index];
        const keyset = this.wallet.getKeyset(signature.id);
        const proof = output.toProof(signature, keyset);
        if (requireDleq && !hasValidDleq(proof, keyset)) return null;
        proofs.push(normalizeProof(proof));
      }
      return proofs;
    } catch {
      return null;
    }
  }

  private async tryRestoreSwap(swap: StoredSwapPreview): Promise<{ keep: Proof[]; send: Proof[] } | null> {
    const keepOutputs = swap.keepOutputs ?? [];
    const sendOutputs = swap.sendOutputs ?? [];
    const restored = await this.tryRestoreOutputs([...keepOutputs, ...sendOutputs]);
    if (!restored) return null;

    return {
      keep: [
        ...restored.slice(0, keepOutputs.length),
        ...(swap.unselectedProofs ?? []).map(normalizeProof),
      ],
      send: restored.slice(keepOutputs.length),
    };
  }

}

/** Match NUT-09's sparse, mint-ordered response back to the exact locally stored outputs. */
export function matchRestoredSignatures(
  expected: SerializedOutputData[],
  response: PostRestoreResponse,
): SerializedBlindedSignature[] | null {
  if (response.outputs.length !== expected.length || response.signatures.length !== expected.length) return null;

  const byBlindedMessage = new Map<string, SerializedBlindedSignature>();
  for (let index = 0; index < response.outputs.length; index += 1) {
    const output = response.outputs[index];
    const signature = response.signatures[index];
    if (
      !signature ||
      byBlindedMessage.has(output.B_) ||
      output.id !== signature.id ||
      units(output.amount) !== units(signature.amount)
    ) return null;
    byBlindedMessage.set(output.B_, signature);
  }

  const matched: SerializedBlindedSignature[] = [];
  const seenExpected = new Set<string>();
  for (const output of expected) {
    if (seenExpected.has(output.blindedMessage.B_)) return null;
    seenExpected.add(output.blindedMessage.B_);
    const signature = byBlindedMessage.get(output.blindedMessage.B_);
    if (
      !signature ||
      signature.id !== output.blindedMessage.id ||
      units(signature.amount) !== units(output.blindedMessage.amount)
    ) return null;
    matched.push(signature);
  }
  return matched;
}

function serializeSwapPreview(preview: SwapPreview): StoredSwapPreview {
  return {
    amount: units(preview.amount),
    fees: units(preview.fees),
    keysetId: preview.keysetId,
    inputs: preview.inputs.map(normalizeProof),
    sendOutputs: preview.sendOutputs?.map(OutputData.serialize),
    keepOutputs: preview.keepOutputs?.map(OutputData.serialize),
    unselectedProofs: preview.unselectedProofs?.map(normalizeProof),
  };
}

function deserializeSwapPreview(preview: StoredSwapPreview): SwapPreview {
  return {
    amount: preview.amount,
    fees: preview.fees,
    keysetId: preview.keysetId,
    inputs: preview.inputs,
    sendOutputs: preview.sendOutputs?.map(OutputData.deserialize),
    keepOutputs: preview.keepOutputs?.map(OutputData.deserialize),
    unselectedProofs: preview.unselectedProofs,
  } as unknown as SwapPreview;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function sumStoredOutputs(outputs: SerializedOutputData[] | undefined): number {
  return (outputs ?? []).reduce((total, output) => total + units(output.blindedMessage.amount), 0);
}
