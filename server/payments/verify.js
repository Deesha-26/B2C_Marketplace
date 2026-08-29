/**
 * Verification of an externally captured payment. Pure — no I/O.
 *
 * Diagnostic B established that this sandbox returns responses which look
 * successful but are self-contradictory: a manual-capture request came back
 * `succeeded` with `amount_received` AND `amount_capturable` both equal to the
 * full amount. Status alone would have accepted it.
 *
 * So verification requires ALL of the conditions below, and deliberately does
 * NOT consult:
 *   amount_captured  — legacy field, observed reporting 0 on settled payments
 *   captures[]       — never returned by either dummy connector
 *   connector        — routing is Hyperswitch's business, not evidence of funds
 *   attempts[]       — an attempt succeeding is not the payment being captured
 */

export const REASONS = {
  MISSING: 'missing_payment',
  ID_MISMATCH: 'payment_id_mismatch',
  OWNERSHIP: 'ownership_mismatch',
  PURPOSE: 'purpose_mismatch',
  AMOUNT_SHAPE: 'invalid_amount_shape',
  NOT_SUCCEEDED: 'status_not_succeeded',
  RECEIVED_MISMATCH: 'amount_received_mismatch',
  STILL_CAPTURABLE: 'amount_capturable_not_zero',
  CURRENCY: 'currency_mismatch',
};

const isMinorUnits = v => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * @param retrieved  the payment as returned by a server-side Hyperswitch GET
 * @param expected   { paymentId, amount, currency, userId, purpose }
 * @param record     the local payments row, for ownership and purpose
 * @returns { ok: true } | { ok: false, reason, detail }
 */
export function verifyAutoCapture({ retrieved, expected, record }) {
  const no = (reason, detail) => ({ ok: false, reason, detail });

  if (!retrieved || typeof retrieved !== 'object') {
    return no(REASONS.MISSING, 'no payment returned from Hyperswitch');
  }

  // The approved total must itself be sane before it is compared to anything.
  if (!isMinorUnits(expected?.amount)) {
    return no(REASONS.AMOUNT_SHAPE, `expected amount ${expected?.amount} is not positive minor units`);
  }

  if (retrieved.payment_id !== expected.paymentId) {
    return no(REASONS.ID_MISMATCH,
      `retrieved ${retrieved.payment_id}, expected ${expected.paymentId}`);
  }

  // Ownership and purpose come from OUR record, never from the gateway.
  if (record && record.user_id !== expected.userId) {
    return no(REASONS.OWNERSHIP, `payment belongs to ${record.user_id}`);
  }
  if (record && expected.purpose && record.purpose !== expected.purpose) {
    return no(REASONS.PURPOSE, `payment purpose is ${record.purpose}, expected ${expected.purpose}`);
  }

  if (retrieved.status !== 'succeeded') {
    return no(REASONS.NOT_SUCCEEDED, `status is ${retrieved.status}`);
  }

  const received = retrieved.amount_received;
  if (!isMinorUnits(received)) {
    return no(REASONS.AMOUNT_SHAPE, `amount_received ${received} is not positive minor units`);
  }
  if (received !== expected.amount) {
    return no(REASONS.RECEIVED_MISMATCH, `received ${received}, approved ${expected.amount}`);
  }

  // The condition that catches the contradictory sandbox response: money cannot
  // have been received in full while the same amount remains capturable.
  const capturable = retrieved.amount_capturable;
  if (capturable !== 0) {
    return no(REASONS.STILL_CAPTURABLE,
      `amount_capturable is ${capturable} while amount_received is ${received} — ` +
      'the response contradicts itself; no funds can be recognised');
  }

  const currency = String(retrieved.currency ?? '').toUpperCase();
  if (currency !== String(expected.currency ?? '').toUpperCase()) {
    return no(REASONS.CURRENCY, `currency ${retrieved.currency}, expected ${expected.currency}`);
  }

  return { ok: true };
}

/** Fields verification must never read. Asserted by a test using a trap proxy. */
export const FORBIDDEN_FIELDS = ['amount_captured', 'captures', 'connector', 'attempts'];
