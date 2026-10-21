import { DatabaseSync } from "node:sqlite";

import { HttpError, nextUtcDay, startOfUtcDay } from "./protocol.js";

export type ClaimState = "dispatching" | "pending" | "paid" | "issued" | "failed" | "recoverable";

interface ClaimRow {
  quote_hash: string;
  quote_id: string | null;
  invoice: string | null;
  payment_hash: string | null;
  quote_pubkey: string | null;
  client_hash: string | null;
  network_hash: string | null;
  state: ClaimState;
  amount: number;
  unit: string;
  expiry: number;
  attempt_count: number;
  attempted_at: number | null;
  created_at: number;
  updated_at: number;
  failure_code: string | null;
}

export interface ClaimRecord {
  quoteHash: string;
  quoteId: string | null;
  invoice: string | null;
  paymentHash: string | null;
  quotePubkey: string | null;
  clientHash: string | null;
  networkHash: string | null;
  state: ClaimState;
  amount: number;
  unit: string;
  expiry: number;
  attemptCount: number;
  attemptedAt: number | null;
  createdAt: number;
  updatedAt: number;
  failureCode: string | null;
}

export interface ReserveClaim {
  quoteHash: string;
  quoteId: string;
  invoice: string;
  paymentHash: string;
  quotePubkey: string;
  clientHash: string;
  networkHash: string;
  amount: number;
  unit: string;
  expiry: number;
  cooldownSeconds: number;
  networkDailyLimit: number;
  dailyLimit: number;
}

export interface FaucetStats {
  claimsTotal: number;
  claimsToday: number;
  paidTotal: number;
  issuedTotal: number;
}

function mapRow(row: ClaimRow): ClaimRecord {
  return {
    quoteHash: row.quote_hash,
    quoteId: row.quote_id,
    invoice: row.invoice,
    paymentHash: row.payment_hash,
    quotePubkey: row.quote_pubkey,
    clientHash: row.client_hash,
    networkHash: row.network_hash,
    state: row.state,
    amount: row.amount,
    unit: row.unit,
    expiry: row.expiry,
    attemptCount: row.attempt_count,
    attemptedAt: row.attempted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureCode: row.failure_code,
  };
}

export class FaucetStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS faucet_claims (
        quote_hash TEXT PRIMARY KEY,
        quote_id TEXT,
        invoice TEXT,
        payment_hash TEXT UNIQUE,
        quote_pubkey TEXT,
        client_hash TEXT,
        network_hash TEXT,
        state TEXT NOT NULL CHECK (state IN ('dispatching', 'pending', 'paid', 'issued', 'failed', 'recoverable')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        unit TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        attempted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure_code TEXT
      );
      CREATE INDEX IF NOT EXISTS faucet_claims_client ON faucet_claims(client_hash, created_at);
      CREATE INDEX IF NOT EXISTS faucet_claims_network ON faucet_claims(network_hash, created_at);
      CREATE INDEX IF NOT EXISTS faucet_claims_state ON faucet_claims(state, updated_at);
      CREATE INDEX IF NOT EXISTS faucet_claims_created ON faucet_claims(created_at);
    `);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  find(quoteHash: string): ClaimRecord | null {
    const row = this.database.prepare("SELECT * FROM faucet_claims WHERE quote_hash = ?").get(quoteHash) as ClaimRow | undefined;
    return row ? mapRow(row) : null;
  }

  reserve(input: ReserveClaim): { record: ClaimRecord; created: boolean } {
    const now = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT * FROM faucet_claims WHERE quote_hash = ?").get(input.quoteHash) as ClaimRow | undefined;
      if (existing) {
        this.database.exec("COMMIT");
        return { record: mapRow(existing), created: false };
      }
      const recent = this.database.prepare(`
        SELECT created_at FROM faucet_claims
        WHERE client_hash = ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(input.clientHash, now - input.cooldownSeconds) as { created_at: number } | undefined;
      if (recent) {
        const retryAfter = Math.max(1, recent.created_at + input.cooldownSeconds - now);
        throw new HttpError(429, "claim_cooldown", "This browser has already received its current testnet claim.", retryAfter);
      }
      const networkCount = this.database.prepare(`
        SELECT COUNT(*) AS count FROM faucet_claims
        WHERE network_hash = ? AND created_at >= ?
      `).get(input.networkHash, startOfUtcDay(now)) as { count: number };
      if (networkCount.count >= input.networkDailyLimit) {
        throw new HttpError(429, "network_limit", "This network address has reached today's testnet claim limit.", nextUtcDay(now) - now);
      }
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM faucet_claims WHERE created_at >= ?")
        .get(startOfUtcDay(now)) as { count: number };
      if (count.count >= input.dailyLimit) {
        throw new HttpError(429, "daily_limit", "Today's testnet claim budget has been used.", nextUtcDay(now) - now);
      }
      this.database.prepare(`
        INSERT INTO faucet_claims (
          quote_hash, quote_id, invoice, payment_hash, quote_pubkey, client_hash, network_hash, state,
          amount, unit, expiry, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?)
      `).run(
        input.quoteHash,
        input.quoteId,
        input.invoice,
        input.paymentHash,
        input.quotePubkey,
        input.clientHash,
        input.networkHash,
        input.amount,
        input.unit,
        input.expiry,
        now,
        now,
      );
      const created = this.find(input.quoteHash);
      if (!created) throw new Error("Claim insert did not persist.");
      this.database.exec("COMMIT");
      return { record: created, created: true };
    } catch (reason) {
      this.database.exec("ROLLBACK");
      if (reason instanceof HttpError) throw reason;
      throw new HttpError(409, "claim_conflict", "This mint quote is already associated with another claim.");
    }
  }

  markAttempt(quoteHash: string): ClaimRecord {
    const now = this.now();
    this.database.prepare(`
      UPDATE faucet_claims
      SET state = 'dispatching', attempt_count = attempt_count + 1, attempted_at = ?, updated_at = ?, failure_code = NULL
      WHERE quote_hash = ?
    `).run(now, now, quoteHash);
    return this.require(quoteHash);
  }

  transition(quoteHash: string, state: ClaimState, failureCode?: string): ClaimRecord {
    const now = this.now();
    this.database.prepare(`
      UPDATE faucet_claims SET state = ?, updated_at = ?, failure_code = ? WHERE quote_hash = ?
    `).run(state, now, failureCode ?? null, quoteHash);
    return this.require(quoteHash);
  }

  open(limit = 100): ClaimRecord[] {
    return (this.database.prepare(`
      SELECT * FROM faucet_claims
      WHERE state IN ('dispatching', 'pending', 'recoverable') AND quote_id IS NOT NULL
        AND COALESCE(failure_code, '') NOT IN (
          'manual_review_required', 'payment_hash_mismatch', 'missing_dispatch_data',
          'missing_payment_hash', 'quote_changed'
        )
      ORDER BY updated_at ASC LIMIT ?
    `).all(limit) as unknown as ClaimRow[]).map(mapRow);
  }

  stats(): FaucetStats {
    const now = this.now();
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS claims_total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS claims_today,
        SUM(CASE WHEN state IN ('paid', 'issued') THEN 1 ELSE 0 END) AS paid_total,
        SUM(CASE WHEN state = 'issued' THEN 1 ELSE 0 END) AS issued_total
      FROM faucet_claims
    `).get(startOfUtcDay(now)) as {
      claims_total: number;
      claims_today: number | null;
      paid_total: number | null;
      issued_total: number | null;
    };
    return {
      claimsTotal: row.claims_total,
      claimsToday: row.claims_today ?? 0,
      paidTotal: row.paid_total ?? 0,
      issuedTotal: row.issued_total ?? 0,
    };
  }

  scrub(retentionSeconds: number): number {
    const cutoff = this.now() - retentionSeconds;
    const result = this.database.prepare(`
      UPDATE faucet_claims
      SET quote_id = NULL, invoice = NULL, payment_hash = NULL, quote_pubkey = NULL,
          client_hash = NULL, network_hash = NULL,
          state = CASE WHEN state IN ('dispatching', 'pending') THEN 'recoverable' ELSE state END
      WHERE updated_at <= ?
        AND (
          quote_id IS NOT NULL OR invoice IS NOT NULL OR payment_hash IS NOT NULL OR quote_pubkey IS NOT NULL OR
          client_hash IS NOT NULL OR network_hash IS NOT NULL
        )
    `).run(cutoff);
    return Number(result.changes);
  }

  private require(quoteHash: string): ClaimRecord {
    const record = this.find(quoteHash);
    if (!record) throw new Error("Claim record disappeared.");
    return record;
  }
}
