import crypto from 'node:crypto';


/**
 * Webhooks are the source of truth for asynchronous transitions. The
 * synchronous response to POST /refunds says "pending"; the webhook says what
 * actually happened.
 */

/**
 * Verifies the HMAC in x-webhook-signature-512 against the profile's
 * payment_response_hash_key.
 *
 * An unverified webhook is an unauthenticated instruction to credit a wallet,
 * so this runs on the RAW body before any parsing. Comparison is timing-safe.
 */
export function verifySignature(rawBody, signature, secret) {
  if (!secret) throw new Error('HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY is not set');
  if (!signature) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Claims an event id. Returns false if it was already processed.
 *
 * The INSERT is the deduplication: a duplicate delivery collides on the primary
 * key and is dropped. A SELECT-then-INSERT would race under concurrent
 * redelivery, which is exactly when duplicates arrive.
 *
 * Detecting that collision is dialect-specific — Postgres raises 23505 while
 * SQLite puts UNIQUE in the message — so it goes through isUniqueViolation
 * rather than a string match that would silently stop matching on Postgres.
 */
export async function claimEvent(conn, eventId, eventType, paymentId) {
  // ON CONFLICT rather than catching 23505: PostgreSQL aborts the transaction on
  // a constraint error, so a caught violation would poison every later statement
  // in the same transaction (25P02) — including the ledger posting.
  const row = await conn.one(
    `INSERT INTO processed_events (event_id, event_type, payment_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, eventType ?? null, paymentId ?? null]);
  return !!row;
}

/** Terminal states never move backwards, whatever arrives late. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partially_captured']);

export function isRegression(currentStatus, incomingStatus) {
  return TERMINAL.has(currentStatus) && currentStatus !== incomingStatus &&
         !(currentStatus === 'requires_capture');
}

export const HANDLED = new Set([
  'payment_succeeded', 'payment_failed', 'payment_processing',
  'payment_cancelled', 'payment_captured',
]);
