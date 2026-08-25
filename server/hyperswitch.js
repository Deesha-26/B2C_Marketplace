/**
 * The ONLY module that talks to Hyperswitch.
 *
 * The secret key is read from the environment and never leaves this process.
 * The browser receives a client_secret per payment plus the publishable key,
 * which is all the Web SDK needs.
 *
 * No connector is ever named in a request. Routing, retries and 3DS are
 * Hyperswitch's job — that is the whole point of putting it in the path.
 */
const BASE = process.env.HYPERSWITCH_BASE_URL || 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_SECRET_KEY;
const PROFILE = process.env.HYPERSWITCH_PROFILE_ID;

export class HyperswitchError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.message || `Hyperswitch returned ${status}`);
    this.name = 'HyperswitchError';
    this.status = status;
    this.code = e.code;
    this.type = e.type;
    this.body = body;
  }
}

async function call(method, path, body, idempotencyKey) {
  if (!KEY) throw new Error('HYPERSWITCH_SECRET_KEY is not set — copy .env.example to .env');
  const headers = { 'api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
  // Derived, never random: a retry of the same logical operation must produce
  // the same key, or the retry becomes a second payment.
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new HyperswitchError(res.status, json);
  return json;
}

/**
 * Normalises the routing trail so the UI can show what Hyperswitch actually
 * did — which connector handled it, and whether it was retried elsewhere.
 * This is how rerouting gets demonstrated rather than asserted.
 */
export function routingTrail(payment) {
  const attempts = payment.attempts || [];
  return attempts.map((a, i) => ({
    n: i + 1,
    connector: a.connector,
    status: a.status,
    errorCode: a.error_code || null,
    errorMessage: a.error_message || null,
    at: a.created_at,
  }));
}

export const createPayment = (body, idem) =>
  call('POST', '/payments', { ...body, profile_id: PROFILE }, idem);

export const retrievePayment = id =>
  call('GET', `/payments/${id}?force_sync=true&expand_attempts=true`);

/**
 * Capturing less than the authorized amount performs a PARTIAL capture: the
 * remainder is voided at the processor. That is how the $30 en-route
 * cancellation settles without needing a partial refund.
 */
export const capturePayment = (id, amountToCapture, idem) =>
  call('POST', `/payments/${id}/capture`,
    amountToCapture != null ? { amount_to_capture: amountToCapture } : {}, idem);

/** Releases the hold without charging anything. Only valid pre-capture. */
export const voidPayment = (id, idem) =>
  call('POST', `/payments/${id}/cancel`, { cancellation_reason: 'requested_by_customer' }, idem);

/**
 * Pushes the capture deadline out. Valid only for manual-capture payments.
 * Some connectors apply it automatically at authorization; others need this
 * explicit call.
 */
export const extendAuthorization = (id, idem) =>
  call('POST', `/payments/${id}/extend_authorization`, {}, idem);

export const createRefund = ({ paymentId, amount, reason }, idem) =>
  call('POST', '/refunds', { payment_id: paymentId, amount, reason }, idem);

export const retrieveRefund = id => call('GET', `/refunds/${id}`);

/** Cards the customer chose to save, held in the Hyperswitch vault. */
export const listSavedCards = customerId =>
  call('GET', `/customers/${customerId}/payment_methods`);

export const deleteSavedCard = paymentMethodId =>
  call('DELETE', `/payment_methods/${paymentMethodId}`);

export const publishableKey = () => process.env.HYPERSWITCH_PUBLISHABLE_KEY || '';

/**
 * The authorization deadline. Hyperswitch returns `capture_by` when the
 * connector supplies it; when it doesn't, fall back to computing from when
 * extended authorization was last applied.
 */
export function captureDeadline(payment) {
  if (payment.capture_by) return payment.capture_by;
  if (payment.extended_authorization_last_applied_at) {
    const base = new Date(payment.extended_authorization_last_applied_at).getTime();
    return new Date(base + 7 * 24 * 3600 * 1000).toISOString();
  }
  return null;
}
