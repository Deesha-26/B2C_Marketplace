import { now, uid } from './db.js';

/**
 * Double-entry ledger over the append-only `ledger` table.
 *
 * Hyperswitch is a funding rail; this is the accounting system. Every wallet
 * balance and revenue figure is a SUM over these rows, so the books can always
 * be rebuilt and reconciled against the gateway.
 */
export const GATEWAY_SETTLED  = 'GATEWAY_SETTLED';
export const AUTH_RECEIVABLE  = 'AUTH_RECEIVABLE';
export const ESCROW           = 'ESCROW';
export const PLATFORM_REVENUE = 'PLATFORM_REVENUE';
export const REFUND_IN_TRANSIT= 'REFUND_IN_TRANSIT';
export const DISPUTE_HOLD     = 'DISPUTE_HOLD';
export const DISPUTE_LOSSES   = 'DISPUTE_LOSSES';
export const PROVIDER_CLAWBACK= 'PROVIDER_CLAWBACK';
export const customerWallet = id => `WALLET:CUSTOMER:${id}`;
export const providerWallet = id => `WALLET:PROVIDER:${id}`;

export const debit  = (account, amount) => ({ account, amount });
export const credit = (account, amount) => ({ account, amount: -amount });

export class Ledger {
  constructor(db) { this.db = db; }

  /**
   * Posts atomically. Rejects anything that does not sum to zero, which makes
   * it structurally impossible to create or destroy money by mistake.
   */
  post({ jobId = null, userId = null, reason, entries, gatewayRef = null, inTransaction = false }) {
    if (!entries?.length) throw new Error(`'${reason}' has no entries`);
    const delta = entries.reduce((s, e) => s + e.amount, 0);
    if (delta !== 0) throw new Error(`'${reason}' does not balance: off by ${delta} cents`);

    const txId = uid('tx'), at = now();
    const ins = this.db.prepare(
      `INSERT INTO ledger (tx_id, job_id, user_id, account, amount, reason, gateway_ref, at)
       VALUES (?,?,?,?,?,?,?,?)`);
    // Callers already inside a transaction (the webhook route) pass
    // inTransaction so we do not attempt to nest BEGIN, which SQLite rejects.
    if (inTransaction) {
      for (const e of entries) ins.run(txId, jobId, userId, e.account, e.amount, reason, gatewayRef, at);
      return txId;
    }
    this.db.exec('BEGIN');
    try {
      for (const e of entries) ins.run(txId, jobId, userId, e.account, e.amount, reason, gatewayRef, at);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return txId;
  }

  /** Debit-positive raw balance. */
  raw(account) {
    const r = this.db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE account = ?').get(account);
    return Number(r.b);
  }

  /**
   * Wallets are liabilities, so they carry credit balances internally. `0 - x`
   * rather than `-x`: negating zero yields -0, and -0 !== 0 under strict
   * equality, which silently breaks empty-balance checks.
   */
  balance(account) { return 0 - this.raw(account); }

  walletOf(userId)   { return this.balance(customerWallet(userId)); }
  providerBalance(id){ return this.balance(providerWallet(id)); }

  history(userId, limit = 100) {
    return this.db.prepare(
      `SELECT tx_id, job_id, reason, gateway_ref, at,
              SUM(CASE WHEN account LIKE 'WALLET:CUSTOMER:%' THEN -amount ELSE 0 END) AS delta
       FROM ledger WHERE user_id = ? GROUP BY tx_id ORDER BY id DESC LIMIT ?`).all(userId, limit);
  }

  /** Global invariant. If this fails the books are corrupt; stop serving money ops. */
  assertBalanced() {
    const r = this.db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM ledger').get();
    if (Number(r.t) !== 0) throw new Error(`Ledger unbalanced by ${r.t} cents`);
  }
}
