import { isUniqueViolation, now } from '../db/index.js';

/**
 * Operation state machine for EXTERNAL Hyperswitch calls.
 *
 *   claimed                one request owns this operation
 *      ↓
 *   external_pending       the Hyperswitch call is in flight
 *      ↓
 *   reconciliation_pending the call returned, or its outcome is unknown
 *      ↓
 *   completed              verified and applied locally, exactly once
 *      ↘
 *       discrepancy        the response contradicted the expectation
 *
 * `external_pending` and `reconciliation_pending` are BOTH recoverable. An
 * uncertain network result never becomes `failed`, because a failed operation
 * invites a second payment for money that may already have been taken. Recovery
 * retrieves the deterministic payment_id instead.
 *
 * This table coordinates external calls only. Internal allocations — completion,
 * cancellation, tips, simulated withdrawal and settlement — are ordinary ledger
 * transactions with their own idempotency keys and do not appear here.
 */
export const STATES = {
  CLAIMED: 'claimed',
  EXTERNAL_PENDING: 'external_pending',
  RECONCILIATION_PENDING: 'reconciliation_pending',
  COMPLETED: 'completed',
  DISCREPANCY: 'discrepancy',
};

/** Terminal states never transition again. */
export const TERMINAL = new Set([STATES.COMPLETED, STATES.DISCREPANCY]);
/** States from which recovery must retrieve rather than re-create. */
export const RECOVERABLE = new Set([
  STATES.CLAIMED, STATES.EXTERNAL_PENDING, STATES.RECONCILIATION_PENDING,
]);

const ALLOWED = {
  [STATES.CLAIMED]:                [STATES.EXTERNAL_PENDING, STATES.DISCREPANCY],
  [STATES.EXTERNAL_PENDING]:       [STATES.RECONCILIATION_PENDING, STATES.DISCREPANCY],
  // reconciliation_pending → external_pending is the CONFIRMED-ABSENCE path:
  // Hyperswitch returned 404 for the deterministic id, so no charge exists and
  // recreating with the same id is safe. Bounded by create_attempts.
  [STATES.RECONCILIATION_PENDING]: [STATES.COMPLETED, STATES.DISCREPANCY,
                                    STATES.RECONCILIATION_PENDING,
                                    STATES.EXTERNAL_PENDING],
  [STATES.COMPLETED]:              [],
  [STATES.DISCREPANCY]:            [],
};

export const canTransition = (from, to) => (ALLOWED[from] ?? []).includes(to);

export class IllegalOperationTransition extends Error {
  constructor(from, to) {
    super(`cannot move operation from ${from} to ${to}`);
    this.name = 'IllegalOperationTransition';
  }
}

/**
 * Claims an operation. Returns { owner: true } for the caller that created it,
 * or { owner: false, operation } for anyone arriving second.
 *
 * The INSERT is the mutual exclusion: two concurrent requests race on the
 * primary key and exactly one wins. A SELECT-then-INSERT would let both through.
 */
export async function claim(db, {
  operationKey, kind, paymentId, userId, purpose,
  jobId = null, approvalId = null, expectedAmount, currency,
}) {
  try {
    await db.none(
      `INSERT INTO payment_operations
         (operation_key, payment_id, kind, user_id, purpose, job_id, approval_id,
          expected_amount, currency, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [operationKey, paymentId, kind, userId, purpose, jobId, approvalId,
       expectedAmount, currency, STATES.CLAIMED]);
    return { owner: true, operation: await get(db, operationKey) };
  } catch (err) {
    if (!isUniqueViolation(err, 'payment_operations_pkey')) throw err;
    return { owner: false, operation: await get(db, operationKey) };
  }
}

export const get = (db, operationKey) =>
  db.one('SELECT * FROM payment_operations WHERE operation_key = $1', [operationKey]);

/** Locks the row for the short local transaction that applies effects. */
export const lock = (t, operationKey) =>
  t.one('SELECT * FROM payment_operations WHERE operation_key = $1 FOR UPDATE', [operationKey]);

/**
 * Moves an operation forward, refusing illegal transitions. Reaching a terminal
 * state twice is a no-op rather than an error, so a retry is safe.
 */
export async function transition(conn, operationKey, to, extra = {}) {
  const current = await conn.one(
    'SELECT state FROM payment_operations WHERE operation_key = $1', [operationKey]);
  if (!current) throw new Error(`unknown operation ${operationKey}`);
  if (current.state === to) return { changed: false, state: to };
  if (!canTransition(current.state, to)) {
    throw new IllegalOperationTransition(current.state, to);
  }
  await conn.none(
    `UPDATE payment_operations
     SET state = $2, payment_id = COALESCE($3, payment_id),
         completed_at = CASE WHEN $2 IN ('completed','discrepancy') THEN $4 ELSE completed_at END
     WHERE operation_key = $1`,
    [operationKey, to, extra.paymentId ?? null, now()]);
  return { changed: true, state: to };
}

/** How many times a confirmed-absent payment may be recreated before giving up. */
export const MAX_CREATE_ATTEMPTS = 3;

export const recordCreateAttempt = (conn, operationKey, error = null) =>
  conn.none(`UPDATE payment_operations
             SET create_attempts = create_attempts + 1, last_error = $2
             WHERE operation_key = $1`, [operationKey, error]);

/** Operations left mid-flight by a crash, for the reconciliation sweep. */
export const findRecoverable = db =>
  db.all(`SELECT * FROM payment_operations
          WHERE state IN ($1,$2,$3) ORDER BY created_at`,
    [STATES.CLAIMED, STATES.EXTERNAL_PENDING, STATES.RECONCILIATION_PENDING]);
