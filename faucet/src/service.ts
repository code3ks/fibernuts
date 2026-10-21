import type { FaucetConfig } from "./config.js";
import { FaucetStore, type ClaimRecord, type ClaimState, type FaucetStats } from "./database.js";
import { HttpError, identifierHash } from "./protocol.js";
import type { FiberPayment, FiberPort, FiberUdtScript, MintPort, MintQuoteView } from "./upstream.js";

export type PublicClaimStatus = "paying" | "paid" | "issued" | "failed" | "recoverable";

export interface ClaimResult {
  status: PublicClaimStatus;
  amount: number;
  unit: "rusd";
  message: string;
  retryAfterSeconds?: number;
}

export interface PublicFaucetConfig {
  enabled: boolean;
  amount: number;
  unit: "rusd";
  network: "testnet";
  mint: string;
  cooldownSeconds: number;
  remainingToday: number;
}

export interface PublicFaucetStats {
  claimsTotal: number;
  claimsToday: number;
  paidTotal: number;
  issuedTotal: number;
}

function result(record: ClaimRecord, retryAfterSeconds?: number): ClaimResult {
  const messages: Record<PublicClaimStatus, string> = {
    paying: "The faucet is settling this mint quote through Fiber.",
    paid: "The Fiber payment settled. The mint is ready to issue ecash.",
    issued: "The mint issued the test RUSD for this claim.",
    failed: "The faucet payment did not settle. You can still pay the stored invoice from another Fiber wallet before it expires.",
    recoverable: "The payment result is not final. Check this same claim again.",
  };
  const status: PublicClaimStatus = record.state === "dispatching" || record.state === "pending"
    ? "paying"
    : record.state;
  return { status, amount: record.amount, unit: "rusd", message: messages[status], retryAfterSeconds };
}

function sameUdtScript(
  actual: FiberUdtScript | null,
  expected: FaucetConfig["udtScript"],
): boolean {
  return actual !== null && actual.codeHash === expected.codeHash &&
    actual.hashType === expected.hashType && actual.args === expected.args;
}

export class FaucetService {
  private readonly inFlight = new Map<string, { clientHash: string; task: Promise<ClaimResult> }>();

  constructor(
    private readonly config: FaucetConfig,
    private readonly store: FaucetStore,
    private readonly mint: MintPort,
    private readonly fiber: FiberPort,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  publicConfig(): PublicFaucetConfig {
    const stats = this.store.stats();
    return {
      enabled: this.config.enabled && stats.claimsToday < this.config.dailyClaimLimit,
      amount: this.config.amount,
      unit: this.config.unit,
      network: this.config.network,
      mint: this.config.mintUrl,
      cooldownSeconds: this.config.clientCooldownSeconds,
      remainingToday: Math.max(0, this.config.dailyClaimLimit - stats.claimsToday),
    };
  }

  publicStats(): PublicFaucetStats {
    const stats: FaucetStats = this.store.stats();
    return stats;
  }

  claim(quoteId: string, clientId: string, networkId = "unknown"): Promise<ClaimResult> {
    const quoteHash = identifierHash(this.config.identifierSecret, "quote", quoteId);
    const clientHash = identifierHash(this.config.identifierSecret, "client", clientId);
    const networkHash = identifierHash(this.config.identifierSecret, "network", networkId);
    const active = this.inFlight.get(quoteHash);
    if (active) {
      if (active.clientHash !== clientHash) {
        return Promise.reject(new HttpError(404, "claim_not_found", "The claim was not found for this browser."));
      }
      return active.task;
    }
    const task = this.claimExclusive(quoteHash, quoteId, clientHash, networkHash)
      .finally(() => this.inFlight.delete(quoteHash));
    this.inFlight.set(quoteHash, { clientHash, task });
    return task;
  }

  async reconcileOpenClaims(): Promise<void> {
    for (const record of this.store.open()) {
      if (!record.quoteId || this.inFlight.has(record.quoteHash)) continue;
      const task = this.reconcileStored(record).finally(() => this.inFlight.delete(record.quoteHash));
      this.inFlight.set(record.quoteHash, { clientHash: record.clientHash ?? "", task });
      await task.catch(() => undefined);
    }
  }

  private async claimExclusive(quoteHash: string, quoteId: string, clientHash: string, networkHash: string): Promise<ClaimResult> {
    const existing = this.store.find(quoteHash);
    if (existing) {
      this.assertOwner(existing, clientHash);
      if (existing.state === "issued" || !existing.quoteId) return result(existing);
      return this.reconcileStored(existing);
    }
    if (!this.config.enabled) throw new HttpError(503, "faucet_paused", "Testnet claims are temporarily paused.");

    const quote = await this.mint.getQuote(quoteId);
    this.validateQuote(quote);
    if (!quote.pubkey) {
      throw new HttpError(422, "quote_unlocked", "Create this claim from the FiberNuts wallet so the quote is locked to your browser.");
    }
    if (quote.phase !== "unpaid") {
      throw new HttpError(409, "quote_already_funded", "Use a new unpaid mint quote for a testnet claim.");
    }
    if (quote.expiry <= this.now() + 15) {
      throw new HttpError(410, "quote_expired", "The mint quote has expired. Create a new claim.");
    }
    const decoded = await this.fiber.parseInvoice(quote.invoice);
    if (
      decoded.currency !== this.config.invoiceCurrency ||
      decoded.amount !== BigInt(this.config.amount) * BigInt(this.config.unitScale) ||
      !sameUdtScript(decoded.udtScript, this.config.udtScript)
    ) {
      throw new HttpError(422, "invoice_mismatch", "The mint quote does not match the configured testnet asset and amount.");
    }

    const reserved = this.store.reserve({
      quoteHash,
      quoteId,
      invoice: quote.invoice,
      paymentHash: decoded.paymentHash,
      quotePubkey: quote.pubkey,
      clientHash,
      networkHash,
      amount: quote.amount,
      unit: quote.unit,
      expiry: quote.expiry,
      cooldownSeconds: this.config.clientCooldownSeconds,
      networkDailyLimit: this.config.networkDailyClaimLimit,
      dailyLimit: this.config.dailyClaimLimit,
    });
    this.assertOwner(reserved.record, clientHash);
    return reserved.created ? this.dispatch(reserved.record) : this.reconcile(reserved.record, quote);
  }

  private async reconcileStored(record: ClaimRecord): Promise<ClaimResult> {
    if (!record.quoteId) return result(record);
    const quote = await this.mint.getQuote(record.quoteId);
    return this.reconcile(record, quote);
  }

  private async reconcile(record: ClaimRecord, quote: MintQuoteView): Promise<ClaimResult> {
    this.validateQuote(quote, record.quoteId ?? undefined);
    if (
      (record.invoice !== null && quote.invoice !== record.invoice) ||
      (record.quotePubkey !== null && quote.pubkey !== record.quotePubkey) ||
      quote.expiry !== record.expiry
    ) {
      return result(this.store.transition(record.quoteHash, "recoverable", "quote_changed"), 30);
    }
    if (quote.phase === "issued") return result(this.store.transition(record.quoteHash, "issued"));
    if (quote.phase === "paid") return result(this.store.transition(record.quoteHash, "paid"), 2);
    if (record.state === "failed") return result(record);
    if (!record.paymentHash) return result(this.store.transition(record.quoteHash, "recoverable", "missing_payment_hash"), 10);

    let payment: FiberPayment | null;
    try {
      payment = await this.fiber.getPayment(record.paymentHash);
    } catch {
      return result(this.store.transition(record.quoteHash, "recoverable", "payment_check_unknown"), 10);
    }
    if (payment) {
      if (payment.paymentHash !== record.paymentHash) {
        return result(this.store.transition(record.quoteHash, "recoverable", "payment_hash_mismatch"), 30);
      }
      return this.applyPayment(record, payment);
    }

    if (record.failureCode === "payment_hash_mismatch") {
      return result(record, 30);
    }
    const attemptedRecently = record.attemptedAt !== null && this.now() - record.attemptedAt < this.config.recoveryDelaySeconds;
    if (attemptedRecently) return result(this.store.transition(record.quoteHash, "recoverable", "dispatch_unconfirmed"), this.config.recoveryDelaySeconds);
    if (quote.expiry <= this.now()) return result(this.store.transition(record.quoteHash, "failed", "quote_expired"));
    if (record.attemptCount >= 2 || !record.invoice) {
      return result(this.store.transition(record.quoteHash, "recoverable", "manual_review_required"), 30);
    }
    return this.dispatch(record);
  }

  private async dispatch(input: ClaimRecord): Promise<ClaimResult> {
    if (!input.invoice || !input.paymentHash) {
      return result(this.store.transition(input.quoteHash, "recoverable", "missing_dispatch_data"), 30);
    }
    const record = this.store.markAttempt(input.quoteHash);
    try {
      const payment = await this.fiber.sendPayment(input.invoice);
      if (payment.paymentHash !== input.paymentHash) {
        return result(this.store.transition(input.quoteHash, "recoverable", "payment_hash_mismatch"), 30);
      }
      return this.applyPayment(record, payment);
    } catch {
      return result(this.store.transition(input.quoteHash, "recoverable", "dispatch_unknown"), this.config.recoveryDelaySeconds);
    }
  }

  private applyPayment(record: ClaimRecord, payment: FiberPayment): ClaimResult {
    const state: ClaimState = payment.status === "Success"
      ? "paid"
      : payment.status === "Failed"
        ? "failed"
        : "pending";
    return result(this.store.transition(record.quoteHash, state, state === "failed" ? "fiber_failed" : undefined), state === "pending" ? 5 : 2);
  }

  private validateQuote(quote: MintQuoteView, expectedId?: string): void {
    if (
      (expectedId !== undefined && quote.quoteId !== expectedId) ||
      quote.amount !== this.config.amount ||
      quote.unit !== this.config.unit
    ) {
      throw new HttpError(422, "quote_mismatch", "The mint quote does not match this testnet claim.");
    }
    if (!quote.invoice.toLowerCase().startsWith("fibt1")) {
      throw new HttpError(422, "wrong_network", "The mint quote is not a CKB testnet Fiber invoice.");
    }
  }

  private assertOwner(record: ClaimRecord, clientHash: string): void {
    if (record.clientHash && record.clientHash !== clientHash) {
      throw new HttpError(404, "claim_not_found", "The claim was not found for this browser.");
    }
  }
}
