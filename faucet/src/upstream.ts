import { HttpError } from "./protocol.js";

export type QuotePhase = "unpaid" | "paid" | "issued";

export interface MintQuoteView {
  quoteId: string;
  invoice: string;
  amount: number;
  unit: string;
  pubkey: string | null;
  expiry: number;
  phase: QuotePhase;
}

export type FiberPaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

export interface FiberPayment {
  paymentHash: string;
  status: FiberPaymentStatus;
  fee: bigint;
}

export interface ParsedFiberInvoice {
  paymentHash: string;
  currency: string;
  amount: bigint;
  udtScript: FiberUdtScript | null;
}

export interface FiberUdtScript {
  codeHash: string;
  hashType: "data" | "type" | "data1" | "data2";
  args: string;
}

export interface MintPort {
  getQuote(quoteId: string): Promise<MintQuoteView>;
}

export interface FiberPort {
  parseInvoice(invoice: string): Promise<ParsedFiberInvoice>;
  getPayment(paymentHash: string): Promise<FiberPayment | null>;
  sendPayment(invoice: string): Promise<FiberPayment>;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(502, "upstream_response", message);
  }
  return value as Record<string, unknown>;
}

function integerLike(value: unknown, message: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new HttpError(502, "upstream_response", message);
  }
  return parsed as number;
}

function hexInteger(value: unknown, message: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new HttpError(502, "upstream_response", message);
  }
  return BigInt(value);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error("truncated molecule value");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function decodePackedScript(value: unknown): FiberUdtScript {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new HttpError(502, "fiber_response", "The Fiber invoice has an invalid asset script.");
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(value.slice(2), "hex"));
    const total = readUint32(bytes, 0);
    const codeHashOffset = readUint32(bytes, 4);
    const hashTypeOffset = readUint32(bytes, 8);
    const argsOffset = readUint32(bytes, 12);
    if (
      total !== bytes.length || codeHashOffset !== 16 ||
      hashTypeOffset - codeHashOffset !== 32 || argsOffset - hashTypeOffset !== 1
    ) throw new Error("invalid script table");
    // Molecule Bytes stores the payload length; the four-byte prefix is not part of that count.
    const argsLength = readUint32(bytes, argsOffset);
    if (argsOffset + 4 + argsLength !== bytes.length) throw new Error("invalid script args");
    const hashTypes = ["data", "type", "data1", undefined, "data2"] as const;
    const hashType = hashTypes[bytes[hashTypeOffset]];
    if (!hashType) throw new Error("invalid script hash type");
    return {
      codeHash: `0x${Buffer.from(bytes.slice(codeHashOffset, hashTypeOffset)).toString("hex")}`,
      hashType,
      args: `0x${Buffer.from(bytes.slice(argsOffset + 4)).toString("hex")}`,
    };
  } catch (reason) {
    if (reason instanceof HttpError) throw reason;
    throw new HttpError(502, "fiber_response", "The Fiber invoice has an invalid asset script.");
  }
}

function invoiceUdtScript(attrs: unknown): FiberUdtScript | null {
  if (!Array.isArray(attrs)) {
    throw new HttpError(502, "fiber_response", "The Fiber node returned invalid invoice attributes.");
  }
  const scripts = attrs.flatMap((attribute) => {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)) return [];
    const value = (attribute as Record<string, unknown>).udt_script;
    return value === undefined ? [] : [value];
  });
  if (scripts.length > 1) {
    throw new HttpError(502, "fiber_response", "The Fiber invoice contains conflicting asset scripts.");
  }
  return scripts.length === 1 ? decodePackedScript(scripts[0]) : null;
}

async function responseJson(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "upstream_response", message);
  }
}

export class HttpMintClient implements MintPort {
  constructor(private readonly apiUrl: string, private readonly timeoutMs: number) {}

  async getQuote(quoteId: string): Promise<MintQuoteView> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/mint/quote/fiber/${encodeURIComponent(quoteId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HttpError(502, "mint_unavailable", "The mint could not be reached. Try the same claim again.");
    }
    if (response.status === 404) throw new HttpError(404, "quote_not_found", "The mint quote was not found.");
    if (!response.ok) throw new HttpError(502, "mint_unavailable", "The mint could not check this quote.");

    const raw = record(await responseJson(response, "The mint returned an invalid quote."), "The mint returned an invalid quote.");
    const amount = integerLike(raw.amount, "The mint returned an invalid quote amount.");
    const amountPaid = raw.amount_paid === undefined ? 0 : integerLike(raw.amount_paid, "The mint returned an invalid paid amount.");
    const amountIssued = raw.amount_issued === undefined ? 0 : integerLike(raw.amount_issued, "The mint returned an invalid issued amount.");
    if (
      raw.quote !== quoteId || typeof raw.request !== "string" || raw.request.length < 16 || raw.request.length > 8192 ||
      typeof raw.unit !== "string" ||
      (raw.pubkey !== undefined && (typeof raw.pubkey !== "string" || !/^(02|03)[a-f0-9]{64}$/i.test(raw.pubkey))) ||
      !Number.isSafeInteger(raw.expiry) || (raw.expiry as number) <= 0
    ) {
      throw new HttpError(502, "upstream_response", "The mint returned an invalid quote.");
    }
    const state = typeof raw.state === "string" ? raw.state.toUpperCase() : "";
    const phase: QuotePhase = state === "ISSUED" || amountIssued >= amount
      ? "issued"
      : state === "PAID" || amountPaid >= amount
        ? "paid"
        : "unpaid";
    return {
      quoteId,
      invoice: raw.request,
      amount,
      unit: raw.unit.toLowerCase(),
      pubkey: typeof raw.pubkey === "string" ? raw.pubkey.toLowerCase() : null,
      expiry: raw.expiry as number,
      phase,
    };
  }
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class HttpFiberClient implements FiberPort {
  private nextId = 1;

  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs: number,
    private readonly maxFeeBaseUnits: number,
    private readonly maxFeeRate: number,
  ) {}

  async parseInvoice(invoice: string): Promise<ParsedFiberInvoice> {
    const result = record(await this.call("parse_invoice", { invoice }), "The Fiber node returned an invalid invoice.");
    const decoded = record(result.invoice, "The Fiber node returned an invalid invoice.");
    const data = record(decoded.data, "The Fiber node returned an invalid invoice.");
    if (typeof data.payment_hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(data.payment_hash) || typeof decoded.currency !== "string") {
      throw new HttpError(502, "fiber_response", "The Fiber node returned an invalid invoice.");
    }
    return {
      paymentHash: data.payment_hash.toLowerCase(),
      currency: decoded.currency,
      amount: hexInteger(decoded.amount, "The Fiber invoice has no valid amount."),
      udtScript: invoiceUdtScript(data.attrs),
    };
  }

  async getPayment(paymentHash: string): Promise<FiberPayment | null> {
    try {
      return this.payment(await this.call("get_payment", { payment_hash: paymentHash }));
    } catch (reason) {
      if (reason instanceof FiberRpcError && reason.rpcMessage.toLowerCase().includes("payment session not found")) return null;
      throw reason;
    }
  }

  async sendPayment(invoice: string): Promise<FiberPayment> {
    return this.payment(await this.call("send_payment", {
      invoice,
      max_fee_amount: `0x${this.maxFeeBaseUnits.toString(16)}`,
      max_fee_rate: `0x${this.maxFeeRate.toString(16)}`,
      dry_run: false,
    }));
  }

  private payment(value: unknown): FiberPayment {
    const result = record(value, "The Fiber node returned an invalid payment.");
    if (
      typeof result.payment_hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(result.payment_hash) ||
      !["Created", "Inflight", "Success", "Failed"].includes(String(result.status))
    ) {
      throw new HttpError(502, "fiber_response", "The Fiber node returned an invalid payment.");
    }
    const fee = hexInteger(result.fee, "The Fiber node returned an invalid payment fee.");
    if (fee > BigInt(this.maxFeeBaseUnits)) {
      throw new HttpError(502, "fee_exceeded", "The Fiber payment exceeded the configured fee limit.");
    }
    return {
      paymentHash: result.payment_hash.toLowerCase(),
      status: result.status as FiberPaymentStatus,
      fee,
    };
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params: [params] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HttpError(502, "fiber_unavailable", "The Fiber payment result is not final. Check the same claim again.");
    }
    if (!response.ok) throw new HttpError(502, "fiber_unavailable", "The Fiber node could not process the claim.");
    const envelope = record(await responseJson(response, "The Fiber node returned an invalid response."), "The Fiber node returned an invalid response.") as RpcEnvelope;
    if (envelope.error) {
      throw new FiberRpcError(
        typeof envelope.error.code === "number" ? envelope.error.code : -1,
        typeof envelope.error.message === "string" ? envelope.error.message : "Unknown Fiber RPC error",
      );
    }
    if (!("result" in envelope)) throw new HttpError(502, "fiber_response", "The Fiber node returned an invalid response.");
    return envelope.result;
  }
}

class FiberRpcError extends HttpError {
  constructor(readonly rpcCode: number, readonly rpcMessage: string) {
    super(502, "fiber_rpc", "The Fiber node could not complete the payment. Check the same claim again.");
    this.name = "FiberRpcError";
  }
}
