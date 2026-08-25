import crypto from 'node:crypto';
import { now } from './db.js';

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
 */
export function claimEvent(db, eventId, eventType, resourceId) {
  try {
    db.prepare(`INSERT INTO processed_events (event_id, event_type, resource_id, received_at)
                VALUES (?,?,?,?)`).run(eventId, eventType, resourceId ?? null, now());
    return true;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
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
  'refund_succeeded', 'refund_failed',
]);

/**
 * Applies an event. Returns a description of what changed, or null if ignored.
 * Callers run this inside the same transaction as claimEvent.
 */
export function apply(db, event) {
  const type = event.event_type || event.type;
  const data = event.content?.object || event.data?.object || event.content || {};

  if (!HANDLED.has(type)) return null;

  if (type.startsWith('payment_')) {
    const id = data.payment_id;
    if (!id) return null;
    const row = db.prepare('SELECT status FROM payments WHERE payment_id = ?').get(id);
    if (!row) return null;
    if (isRegression(row.status, data.status)) {
      return { ignored: true, reason: `late ${type} after terminal ${row.status}` };
    }
    db.prepare(`UPDATE payments SET status=?, amount_captured=?, connector=?,
                  attempts=?, capture_by=?, updated_at=? WHERE payment_id=?`)
      .run(data.status ?? row.status, data.amount_captured ?? 0, data.connector ?? null,
           JSON.stringify(data.attempts ?? []), data.capture_by ?? null, now(), id);
    return { payment_id: id, status: data.status };
  }

  if (type.startsWith('refund_')) {
    const id = data.refund_id;
    if (!id) return null;
    db.prepare('UPDATE refunds SET status=? WHERE refund_id=?').run(data.status, id);
    return { refund_id: id, status: data.status };
  }
  return null;
}
