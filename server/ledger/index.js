import { uid } from '../db/index.js';
import { assertBalanced, signed } from './postings.js';

export * from './postings.js';

/**
 * Persistence for the double-entry ledger.
 *
 * Journal header plus entries. The idempotency key lives on the HEADER: a
 * balanced posting writes several rows sharing a reason and payment reference,
 * so a uniqueness constraint on the entries could never express "this operation
 * happened once".
 *
 * Retrying the same operation is a no-op, not a second transaction.
 */
export class Ledger {
  constructor(db) { this.db = db; }

  /**
   * Posts a transaction built by one of the posting functions.
   * Returns { transactionId, duplicate } — `duplicate: true` means the
   * idempotency key already existed and nothing was written.
   */
  async post(transaction, conn = this.db) {
    const { reason, entries, idempotencyKey, paymentId = null,
            userId = null, jobId = null, metadata = {} } = transaction;
    if (!idempotencyKey) throw new Error(`'${reason}' has no idempotency key`);
    assertBalanced(reason, entries);

    const id = uid('ltx');
    return conn.transaction(async t => {
      // ON CONFLICT rather than catching 23505: PostgreSQL aborts the whole
      // transaction on a constraint violation, so the follow-up SELECT would
      // fail with 25P02. DO NOTHING keeps the transaction usable.
      const inserted = await t.one(
        `INSERT INTO ledger_transactions
           (id, idempotency_key, payment_id, user_id, job_id, reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [id, idempotencyKey, paymentId, userId, jobId, reason, JSON.stringify(metadata)]);

      if (!inserted) {
        const existing = await t.one(
          'SELECT id FROM ledger_transactions WHERE idempotency_key = $1', [idempotencyKey]);
        return { transactionId: existing?.id ?? null, duplicate: true };
      }
      for (const e of entries) {
        await t.none(
          `INSERT INTO ledger_entries (transaction_id, account, direction, amount)
           VALUES ($1,$2,$3,$4)`, [id, e.account, e.direction, e.amount]);
      }
      return { transactionId: id, duplicate: false };
    });
  }

  /** Debit-positive balance for one account. */
  async raw(account, conn = this.db) {
    const r = await conn.one(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS b
       FROM ledger_entries WHERE account = $1`, [account]);
    return Number(r?.b ?? 0);
  }

  /**
   * Liability accounts carry credit balances internally, so this flips the sign
   * for the intuitive "how much is owed" figure.
   *
   * `0 - x` rather than `-x`: negating zero yields -0, and -0 !== 0 under strict
   * equality, which silently breaks empty-balance checks.
   */
  async balance(account, conn = this.db) { return 0 - (await this.raw(account, conn)); }

  async activity(userId, limit = 50) {
    return this.db.all(
      `SELECT t.id, t.reason, t.payment_id, t.job_id, t.metadata, t.created_at,
              COALESCE(SUM(CASE WHEN e.account = $2
                                THEN (CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END)
                                ELSE 0 END), 0) AS wallet_delta
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       WHERE t.user_id = $1
       GROUP BY t.id, t.reason, t.payment_id, t.job_id, t.metadata, t.created_at
       ORDER BY t.created_at DESC LIMIT $3`,
      [userId, `CUSTOMER_WALLET:${userId}`, limit]);
  }

  /**
   * Global invariant: every entry ever written sums to zero. If this fails the
   * books are corrupt and money operations should stop rather than continue.
   */
  async assertGloballyBalanced() {
    const r = await this.db.one(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS t
       FROM ledger_entries`);
    const total = Number(r?.t ?? 0);
    if (total !== 0) throw new Error(`Ledger unbalanced by ${total} cents`);
  }

  /** Per-transaction check, for reconciliation reporting. */
  async findUnbalancedTransactions() {
    return this.db.all(
      `SELECT transaction_id,
              SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS delta
       FROM ledger_entries GROUP BY transaction_id HAVING
       SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`);
  }
}
