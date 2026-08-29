import crypto from 'node:crypto';

/**
 * Deterministic identifiers for external payment operations.
 *
 * Two separate things must be deterministic for crash recovery to work:
 *
 *   1. The Swoop operation key — so concurrent or repeated requests for the same
 *      logical customer action resolve to one owner.
 *   2. The Hyperswitch payment_id — so that if Swoop crashes after Hyperswitch
 *      created the payment but before the response was recorded, restart
 *      RETRIEVES the same payment rather than creating a second one.
 *
 * Hyperswitch accepts a merchant-provided payment_id of up to 30 characters and
 * treats it as the idempotency key for payment creation, so deriving it from the
 * operation key gives recovery without depending on header semantics.
 */

/** Hyperswitch limit. Exceeding it is rejected, so the derivation is sized to fit. */
export const MAX_PAYMENT_ID_LENGTH = 30;

/**
 * A job is paid once per approval. Re-approving after a price change yields a
 * new approval id and therefore a new operation — which is correct, because it
 * is a different amount the customer consented to.
 */
export const jobPaymentKey = (jobId, approvalId) => `job:${jobId}:payment:${approvalId}`;

/**
 * Keyed on a per-request id, NOT on the user alone: a customer must be able to
 * top up more than once, and `wallet:{user}:topup` would collapse every
 * intentional top-up into a single operation.
 */
export const walletTopUpKey = (userId, topUpRequestId) =>
  `wallet:${userId}:topup:${topUpRequestId}`;

/**
 * Derives a stable Hyperswitch payment_id from an operation key.
 *
 * `swoop_` plus 24 hex characters of a SHA-256 digest = exactly 30 characters.
 * The same operation key always produces the same id; different keys collide
 * with probability far below anything this prototype will encounter.
 */
export function derivePaymentId(operationKey) {
  if (typeof operationKey !== 'string' || operationKey.length === 0) {
    throw new Error('operationKey must be a non-empty string');
  }
  const digest = crypto.createHash('sha256').update(operationKey).digest('hex');
  const id = `swoop_${digest.slice(0, 24)}`;
  if (id.length > MAX_PAYMENT_ID_LENGTH) {
    throw new Error(`derived payment_id ${id} exceeds ${MAX_PAYMENT_ID_LENGTH} characters`);
  }
  return id;
}

/** Ledger idempotency keys. Separate namespace from operation keys by design. */
export const topUpCreditKey = paymentId => `${paymentId}:credit`;
export const jobReserveKey  = jobId => `${jobId}:reserve`;
