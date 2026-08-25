import { DatabaseSync } from 'node:sqlite';

/**
 * Persistence. Uses Node's built-in node:sqlite so the only npm dependency in
 * the whole server is Express.
 *
 * The ledger table is append-only: rows are never updated or deleted. Every
 * balance in the app is a SUM over it. That is what makes reconciliation
 * against Hyperswitch possible after the fact.
 */
export function open(path = 'swoop.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Cards saved in the Hyperswitch vault. We store the identifier only,
    -- never card data.
    CREATE TABLE IF NOT EXISTS saved_cards (
      payment_method_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      brand TEXT, last4 TEXT, exp_month TEXT, exp_year TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      service TEXT NOT NULL,
      description TEXT NOT NULL,
      address TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      is_emergency INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      accepted_bid_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bids (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      trade TEXT NOT NULL,
      rating REAL NOT NULL,
      jobs_done INTEGER NOT NULL,
      eta_minutes INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      placed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Timestamped provider activity. Doubles as dispute evidence.
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      kind TEXT NOT NULL,
      lat REAL, lng REAL,
      at TEXT NOT NULL
    );

    -- One row per Hyperswitch payment object.
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      job_id TEXT REFERENCES jobs(id),
      purpose TEXT NOT NULL,              -- wallet_topup | job_authorization
      amount INTEGER NOT NULL,
      amount_captured INTEGER NOT NULL DEFAULT 0,
      amount_refunded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      capture_method TEXT NOT NULL,
      connector TEXT,
      attempts TEXT,                      -- JSON: routing/retry trail
      capture_by TEXT,                    -- authorization deadline
      extended_at TEXT,
      client_secret TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      refund_id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(payment_id),
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    -- Append-only double-entry ledger.
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL,
      job_id TEXT,
      user_id TEXT,
      account TEXT NOT NULL,
      amount INTEGER NOT NULL,            -- debit positive, credit negative
      reason TEXT NOT NULL,
      gateway_ref TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account);
    CREATE INDEX IF NOT EXISTS ledger_tx ON ledger(tx_id);

    -- Webhook dedupe. The primary key IS the idempotency mechanism.
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      received_at TEXT NOT NULL
    );

    -- Guards against a double-tap creating two authorizations.
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export const now = () => new Date().toISOString();
export const uid = p => `${p}_${Math.random().toString(36).slice(2, 12)}`;
