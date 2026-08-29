import { now } from '../db/index.js';
import { derivePaymentId } from './ids.js';
import { verifyAutoCapture } from './verify.js';
import * as ops from './operations.js';
import { Ledger, walletTopUp, jobReservation } from '../ledger/index.js';

/**
 * Claim → external call → reconcile.
 *
 * A Hyperswitch call is NEVER made with a Postgres transaction or row lock open:
 * a slow connector would hold a pooled connection and block other writers for a
 * network round trip. Local effects are applied afterwards in one short
 * transaction.
 *
 * Every expectation used during reconciliation is read from the LOCKED operation
 * row. Callers cannot supply an amount, currency or owner — on first
 * reconciliation there is no payments row yet, so the operation is the only
 * trustworthy record of what was intended and for whom.
 */

/** Outcome of retrieving a payment: it exists, it definitely does not, or unknown. */
const PRESENT = 'present', ABSENT = 'absent', UNKNOWN = 'unknown';

/**
 * Statuses meaning "not finished yet", as opposed to "finished wrongly".
 *
 * With the SDK the customer confirms after the payment is created, so an early
 * reconcile sees one of these. Treating them as a discrepancy would move the
 * operation to a TERMINAL state for a payment that is merely in progress, and no
 * later webhook could rescue it.
 */
const NOT_YET_TERMINAL = new Set([
  'requires_payment_method', 'requires_confirmation', 'requires_customer_action',
  'requires_capture', 'processing',
]);

export class PaymentFlow {
  constructor(db, hyperswitch, { log = console } = {}) {
    this.db = db;
    this.hs = hyperswitch;
    this.ledger = new Ledger(db);
    this.log = log;
  }

  /**
   * Runs an externally-funded operation to completion.
   *
   * @param intent { operationKey, kind, userId, purpose, jobId?, approvalId?,
   *                 amount, currency }
   * @param buildRequest (paymentId) => Hyperswitch create body
   */
  async run(intent, buildRequest) {
    const paymentId = derivePaymentId(intent.operationKey);

    const { owner, operation } = await ops.claim(this.db, {
      operationKey: intent.operationKey, kind: intent.kind, paymentId,
      userId: intent.userId, purpose: intent.purpose,
      jobId: intent.jobId ?? null, approvalId: intent.approvalId ?? null,
      expectedAmount: intent.amount, currency: intent.currency,
    });

    if (!owner) {
      // Someone else owns this action. Terminal outcomes are returned as-is;
      // anything mid-flight is resumed rather than duplicated.
      if (operation.state === ops.STATES.COMPLETED) {
        return { status: 'already_completed', paymentId, operation };
      }
      if (operation.state === ops.STATES.DISCREPANCY) {
        return { status: 'discrepancy', paymentId, operation };
      }
      return this.reconcile({ operationKey: intent.operationKey,
                              requestingUserId: intent.userId, buildRequest });
    }

    await ops.transition(this.db, intent.operationKey, ops.STATES.EXTERNAL_PENDING);
    await this.attemptCreate(intent.operationKey, paymentId, buildRequest);
    return this.reconcile({ operationKey: intent.operationKey,
                            requestingUserId: intent.userId, buildRequest });
  }

  /**
   * Claims and creates, without reconciling.
   *
   * The SDK confirms the payment in the browser, so settlement is not knowable
   * at creation time. Routes use start() and reconcile separately; run() exists
   * for server-confirmed flows such as the diagnostics.
   */
  async start(intent, buildRequest) {
    const paymentId = derivePaymentId(intent.operationKey);
    const { owner, operation } = await ops.claim(this.db, {
      operationKey: intent.operationKey, kind: intent.kind, paymentId,
      userId: intent.userId, purpose: intent.purpose,
      jobId: intent.jobId ?? null, approvalId: intent.approvalId ?? null,
      expectedAmount: intent.amount, currency: intent.currency,
    });

    if (!owner) {
      // A second click on the same action: never a second payment.
      const existing = await this.retrieveOutcome(paymentId);
      return { status: 'existing', paymentId, operation,
               payment: existing.kind === PRESENT ? existing.payment : null };
    }

    await ops.transition(this.db, intent.operationKey, ops.STATES.EXTERNAL_PENDING);
    await ops.recordCreateAttempt(this.db, intent.operationKey);
    let created = null;
    try {
      created = await this.hs.createPayment(buildRequest(paymentId));
    } catch (err) {
      await ops.recordCreateAttempt(this.db, intent.operationKey, err.message).catch(() => {});
      await ops.transition(this.db, intent.operationKey, ops.STATES.RECONCILIATION_PENDING);
      throw err;
    }
    await ops.transition(this.db, intent.operationKey, ops.STATES.RECONCILIATION_PENDING);
    return { status: 'created', paymentId, payment: created, operation };
  }

  /**
   * Creates the payment. A thrown error is NOT treated as failure: the payment
   * may exist. The operation moves to reconciliation so retrieval decides.
   */
  async attemptCreate(operationKey, paymentId, buildRequest) {
    await ops.recordCreateAttempt(this.db, operationKey);
    try {
      await this.hs.createPayment(buildRequest(paymentId));
    } catch (err) {
      this.log.error?.(`create uncertain for ${operationKey}: ${err.message}`);
      await ops.recordCreateAttempt(this.db, operationKey, err.message).catch(() => {});
    }
    await ops.transition(this.db, operationKey, ops.STATES.RECONCILIATION_PENDING);
  }

  /**
   * Distinguishes a definite 404 from an uncertain failure.
   *
   * A 404 means Hyperswitch has no payment under the deterministic id, so no
   * charge exists and recreation is safe. Anything else — timeout, 5xx, network
   * reset — is UNKNOWN, and recreating on unknown risks charging twice.
   */
  async retrieveOutcome(paymentId) {
    try {
      return { kind: PRESENT, payment: await this.hs.retrievePayment(paymentId) };
    } catch (err) {
      if (err?.status === 404) return { kind: ABSENT, error: err };
      return { kind: UNKNOWN, error: err };
    }
  }

  /**
   * Retrieves server-side, verifies against the locked operation, and applies
   * local effects atomically. Safe to call repeatedly.
   */
  async reconcile({ operationKey, requestingUserId, buildRequest }) {
    const op = await ops.get(this.db, operationKey);
    if (!op) throw new Error(`unknown operation ${operationKey}`);

    // Ownership is settled before any external call, from the operation itself.
    if (requestingUserId && op.user_id !== requestingUserId) {
      return { status: 'forbidden', reason: 'operation belongs to another user' };
    }
    if (op.state === ops.STATES.COMPLETED) {
      return { status: 'already_completed', paymentId: op.payment_id, operation: op };
    }
    if (op.state === ops.STATES.DISCREPANCY) {
      return { status: 'discrepancy', paymentId: op.payment_id, operation: op };
    }

    const outcome = await this.retrieveOutcome(op.payment_id);   // no txn open

    if (outcome.kind === UNKNOWN) {
      // Cannot tell whether a charge exists. Stay recoverable; never recreate.
      return { status: 'pending', paymentId: op.payment_id,
               reason: 'retrieval uncertain', error: outcome.error?.message };
    }

    if (outcome.kind === ABSENT) {
      return this.recreateAfterConfirmedAbsence(op, buildRequest, requestingUserId);
    }

    return this.applyVerified(op, outcome.payment);
  }

  /**
   * Hyperswitch confirmed no payment exists under this id. Recreating with the
   * SAME deterministic id and the SAME stored intent cannot double-charge, so
   * this is the one safe recreation path. Bounded, so a permanently failing
   * create cannot loop forever.
   */
  async recreateAfterConfirmedAbsence(op, buildRequest, requestingUserId) {
    if (!buildRequest) {
      return { status: 'absent', paymentId: op.payment_id,
               reason: 'no external payment exists; retry the operation to recreate it' };
    }
    if (op.create_attempts >= ops.MAX_CREATE_ATTEMPTS) {
      await this.db.transaction(async t => {
        await ops.lock(t, op.operation_key);
        await ops.transition(t, op.operation_key, ops.STATES.DISCREPANCY);
        await this.recordPayment(t, { operation: op, retrieved: null,
          state: 'discrepancy',
          reason: `create failed ${op.create_attempts} times and no payment exists` });
      });
      return { status: 'discrepancy', paymentId: op.payment_id,
               reason: 'exhausted create attempts' };
    }

    await ops.transition(this.db, op.operation_key, ops.STATES.EXTERNAL_PENDING);
    await this.attemptCreate(op.operation_key, op.payment_id, buildRequest);
    // buildRequest must survive the recursion: without it a repeatedly absent
    // payment returns 'absent' on the second pass instead of reaching the
    // bounded retry limit.
    return this.reconcile({ operationKey: op.operation_key, requestingUserId, buildRequest });
  }

  /**
   * Verifies against the operation's stored intent and commits both effects.
   *
   * `conn` lets a caller supply an open transaction — the webhook handler claims
   * the event id and applies the effects together, so a failure rolls back both
   * and Hyperswitch's retry is processed rather than dropped as a duplicate.
   */
  async applyVerified(op, retrieved, conn = this.db) {
    if (NOT_YET_TERMINAL.has(retrieved?.status)) {
      // In progress, not wrong. Stay recoverable.
      return { status: 'pending', paymentId: op.payment_id,
               externalStatus: retrieved.status, reason: 'payment not yet settled' };
    }
    return conn.transaction(async t => {
      const locked = await ops.lock(t, op.operation_key);
      if (locked.state === ops.STATES.COMPLETED) {
        return { status: 'already_completed', paymentId: locked.payment_id };
      }
      if (locked.state === ops.STATES.DISCREPANCY) {
        return { status: 'discrepancy', paymentId: locked.payment_id };
      }

      // Every expectation comes from the locked row. Nothing from the caller.
      const expected = {
        paymentId: locked.payment_id,
        amount: Number(locked.expected_amount),
        currency: locked.currency,
        userId: locked.user_id,
        purpose: locked.purpose,
      };
      const record = await t.one(
        'SELECT * FROM payments WHERE payment_id = $1', [locked.payment_id]);

      const verdict = verifyAutoCapture({ retrieved, expected, record });

      if (!verdict.ok) {
        await this.recordPayment(t, { operation: locked, retrieved,
          state: 'discrepancy', reason: `${verdict.reason}: ${verdict.detail}` });
        await ops.transition(t, locked.operation_key, ops.STATES.DISCREPANCY);
        return { status: 'discrepancy', paymentId: locked.payment_id,
                 reason: verdict.reason, detail: verdict.detail };
      }

      await this.recordPayment(t, { operation: locked, retrieved, state: 'verified' });

      const posting = locked.purpose === 'job_payment'
        ? jobReservation({ userId: locked.user_id, jobId: locked.job_id,
                           paymentId: locked.payment_id, total: expected.amount })
        : walletTopUp({ userId: locked.user_id, amount: expected.amount,
                        paymentId: locked.payment_id });

      const { transactionId, duplicate } = await this.ledger.post(posting, t);
      await ops.transition(t, locked.operation_key, ops.STATES.COMPLETED);

      return { status: 'verified', paymentId: locked.payment_id,
               transactionId, duplicatePosting: duplicate };
    });
  }

  /** Upserts the minimal local payment record. Stores no operational data. */
  async recordPayment(t, { operation, retrieved, state, reason = null }) {
    await t.none(
      `INSERT INTO payments
         (payment_id, user_id, job_id, approval_id, purpose, approved_amount, currency,
          last_observed_external_status, reconciliation_state, discrepancy_reason,
          last_reconciled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (payment_id) DO UPDATE SET
         last_observed_external_status = EXCLUDED.last_observed_external_status,
         reconciliation_state          = EXCLUDED.reconciliation_state,
         discrepancy_reason            = EXCLUDED.discrepancy_reason,
         last_reconciled_at            = EXCLUDED.last_reconciled_at`,
      [operation.payment_id, operation.user_id, operation.job_id, operation.approval_id,
       operation.purpose, Number(operation.expected_amount), operation.currency,
       retrieved?.status ?? null, state, reason, now()]);
  }
}
