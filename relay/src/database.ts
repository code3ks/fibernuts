import { DatabaseSync } from "node:sqlite";

import {
  HttpError,
  digestPayload,
  hashSecret,
  payloadAmount,
  type PaymentPayload,
  type RegisterOrderInput,
} from "./protocol.js";

interface OrderRow {
  order_id_hash: string;
  write_hash: string;
  read_hash: string;
  amount: number;
  unit: string;
  mint: string;
  request_digest: string;
  expires_at: number;
  state: "open" | "delivered" | "acknowledged" | "cancelled" | "expired";
  payload_json: string | null;
  payload_digest: string | null;
}

export type DeliveryResult = "stored" | "duplicate";

export class RelayStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS relay_orders (
        order_id_hash TEXT PRIMARY KEY,
        write_hash TEXT NOT NULL UNIQUE,
        read_hash TEXT NOT NULL UNIQUE,
        amount INTEGER NOT NULL CHECK (amount > 0),
        unit TEXT NOT NULL,
        mint TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'delivered', 'acknowledged', 'cancelled', 'expired')),
        payload_json TEXT,
        payload_digest TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acknowledged_at INTEGER,
        cancelled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS relay_orders_expiry ON relay_orders(expires_at, state);
    `);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  register(input: RegisterOrderInput): "created" | "existing" {
    const values = {
      orderIdHash: hashSecret(input.orderId),
      writeHash: hashSecret(input.writeCapability),
      readHash: hashSecret(input.readCapability),
    };
    const existing = this.database.prepare("SELECT * FROM relay_orders WHERE order_id_hash = ?").get(values.orderIdHash) as OrderRow | undefined;
    if (existing) {
      const matches =
        existing.write_hash === values.writeHash &&
        existing.read_hash === values.readHash &&
        existing.amount === input.amount &&
        existing.unit === input.unit &&
        existing.mint === input.mint &&
        existing.request_digest === input.requestDigest &&
        existing.expires_at === input.expiresAt;
      if (!matches) throw new HttpError(409, "order_conflict", "This order is already registered differently.");
      return "existing";
    }
    try {
      this.database.prepare(`
        INSERT INTO relay_orders (
          order_id_hash, write_hash, read_hash, amount, unit, mint, request_digest,
          expires_at, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        values.orderIdHash,
        values.writeHash,
        values.readHash,
        input.amount,
        input.unit,
        input.mint,
        input.requestDigest,
        input.expiresAt,
        this.now(),
      );
    } catch {
      throw new HttpError(409, "capability_conflict", "A capability is already registered.");
    }
    return "created";
  }

  deliver(writeCapability: string, payload: PaymentPayload): DeliveryResult {
    const writeHash = hashSecret(writeCapability);
    const payloadDigest = digestPayload(payload);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM relay_orders WHERE write_hash = ?").get(writeHash) as OrderRow | undefined;
      if (!row) throw new HttpError(404, "not_found", "The delivery slot was not found.");
      this.expireRow(row);
      if (row.state === "expired" || row.state === "cancelled") {
        throw new HttpError(410, "slot_closed", "The delivery slot is closed.");
      }
      if (row.payload_digest) {
        if (row.payload_digest === payloadDigest) {
          this.database.exec("COMMIT");
          return "duplicate";
        }
        throw new HttpError(409, "payload_conflict", "A different payment payload already exists.");
      }
      if (
        hashSecret(payload.id) !== row.order_id_hash ||
        payload.unit !== row.unit ||
        payload.mint !== row.mint ||
        payloadAmount(payload) !== row.amount
      ) {
        throw new HttpError(422, "payload_mismatch", "The payment payload does not match the order.");
      }
      this.database.prepare(`
        UPDATE relay_orders
        SET state = 'delivered', payload_json = ?, payload_digest = ?, delivered_at = ?
        WHERE write_hash = ? AND state = 'open' AND payload_digest IS NULL
      `).run(JSON.stringify(payload), payloadDigest, this.now(), writeHash);
      this.database.exec("COMMIT");
      return "stored";
    } catch (reason) {
      this.database.exec("ROLLBACK");
      throw reason;
    }
  }

  read(readCapability: string): PaymentPayload | null {
    const row = this.rowForRead(readCapability);
    this.expireRow(row);
    if (row.state === "open") return null;
    if (row.state !== "delivered" || !row.payload_json) {
      throw new HttpError(410, "slot_closed", "The delivery slot is closed.");
    }
    return JSON.parse(row.payload_json) as PaymentPayload;
  }

  acknowledge(readCapability: string): "acknowledged" | "duplicate" {
    const row = this.rowForRead(readCapability);
    this.expireRow(row);
    if (row.state === "acknowledged") return "duplicate";
    if (row.state !== "delivered") {
      throw new HttpError(409, "not_delivered", "No delivered payload can be acknowledged.");
    }
    this.database.prepare(`
      UPDATE relay_orders
      SET state = 'acknowledged', payload_json = NULL, acknowledged_at = ?
      WHERE read_hash = ? AND state = 'delivered'
    `).run(this.now(), hashSecret(readCapability));
    return "acknowledged";
  }

  cancel(readCapability: string): "cancelled" | "duplicate" {
    const row = this.rowForRead(readCapability);
    this.expireRow(row);
    if (row.state === "cancelled") return "duplicate";
    if (row.state !== "open") {
      throw new HttpError(409, "delivery_won", "The slot cannot be cancelled after delivery.");
    }
    this.database.prepare(`
      UPDATE relay_orders SET state = 'cancelled', cancelled_at = ?
      WHERE read_hash = ? AND state = 'open'
    `).run(this.now(), hashSecret(readCapability));
    return "cancelled";
  }

  cleanup(retentionSeconds: number): number {
    const cutoff = this.now() - retentionSeconds;
    this.database.prepare(`
      UPDATE relay_orders
      SET state = 'expired', payload_json = NULL
      WHERE expires_at <= ? AND state = 'open'
    `).run(this.now());
    this.database.prepare(`
      UPDATE relay_orders
      SET state = 'expired', payload_json = NULL
      WHERE delivered_at IS NOT NULL AND delivered_at <= ? AND state = 'delivered'
    `).run(cutoff);
    const result = this.database.prepare(`
      DELETE FROM relay_orders
      WHERE expires_at <= ? AND state IN ('expired', 'acknowledged', 'cancelled')
    `).run(cutoff);
    return Number(result.changes);
  }

  private rowForRead(readCapability: string): OrderRow {
    const row = this.database.prepare("SELECT * FROM relay_orders WHERE read_hash = ?").get(hashSecret(readCapability)) as OrderRow | undefined;
    if (!row) throw new HttpError(404, "not_found", "The delivery slot was not found.");
    return row;
  }

  private expireRow(row: OrderRow): void {
    if (row.expires_at > this.now() || row.state !== "open") return;
    this.database.prepare(`
      UPDATE relay_orders SET state = 'expired', payload_json = NULL
      WHERE order_id_hash = ? AND state = 'open'
    `).run(row.order_id_hash);
    row.state = "expired";
    row.payload_json = null;
  }
}
