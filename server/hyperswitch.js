/**
 * The ONLY module that talks to Hyperswitch.
 *
 * The secret key is read from the environment and never leaves this process. The
 * browser receives the publishable key and a per-payment client_secret.
 *
 * NO REQUEST NAMES A CONNECTOR. Routing, retries and rerouting are decided by
 * dashboard configuration; Diagnostic A asserts the request body is clean.
 *
 * Round 1 surface only. Capture, void, extend_authorization and refunds are
 * deliberately absent: Diagnostic B could not establish manual capture on either
 * dummy processor, so the operations that depend on a hold are deferred rather
 * than shipped untested.
 */
const BASE = process.env.HYPERSWITCH_BASE_URL || 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_SECRET_KEY;
const PROFILE = process.env.HYPERSWITCH_PROFILE_ID;

/**
 * Validate configuration before attempting a network request.  Node's fetch
 * otherwise leaks the unhelpful "Invalid URL" error when a deployment has a
 * bare hostname (or other malformed value) in HYPERSWITCH_BASE_URL.
 */
export function configurationError() {
  if (!KEY) return 'HYPERSWITCH_SECRET_KEY is not configured.';
  if (!PROFILE) return 'HYPERSWITCH_PROFILE_ID is not configured.';
  if (!process.env.HYPERSWITCH_PUBLISHABLE_KEY) {
    return 'HYPERSWITCH_PUBLISHABLE_KEY is not configured.';
  }
  try {
    const url = new URL(BASE);
    if (url.protocol !== 'https:') return 'HYPERSWITCH_BASE_URL must use https.';
  } catch {
    return 'HYPERSWITCH_BASE_URL must be a full https URL, for example https://sandbox.hyperswitch.io.';
  }
  return null;
}

export const isConfigured = () => configurationError() === null;

export class HyperswitchError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message || `Hyperswitch returned ${status}`);
    this.name = 'HyperswitchError';
    this.status = status;      // 404 means definitely absent; see PaymentFlow
    this.code = e.code;
    this.type = e.type;
  }
}

async function call(method, path, body) {
  const configError = configurationError();
  if (configError) throw new Error(`Payment configuration error: ${configError}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { unparsed: text }; }
  if (!res.ok) throw new HyperswitchError(res.status, json);
  return json;
}

/**
 * Creates a payment. `body.payment_id` must be the deterministic id derived from
 * the operation key — Hyperswitch treats a merchant-provided payment_id as the
 * idempotency key for creation, which is what makes crash recovery safe.
 */
export const createPayment = body =>
  call('POST', '/payments', { ...body, profile_id: PROFILE });

/** Server-side retrieval. The only basis for recognising captured funds. */
export const retrievePayment = id =>
  call('GET', `/payments/${id}?force_sync=true&expand_attempts=true`);

/**
 * Normalises the attempt trail for display. Read live on every request and never
 * stored: a stored copy could disagree with the source it exists to evidence.
 */
export function routingTrail(payment) {
  const attempts = Array.isArray(payment?.attempts) ? payment.attempts : [];
  return attempts.map((a, i) => ({
    n: i + 1,
    attemptId: a.attempt_id ?? null,
    processor: a.connector ?? a.merchant_connector_id ?? null,
    status: a.status ?? null,
    errorCode: a.error_code ?? null,
    errorMessage: a.error_message ?? null,
  }));
}

export const publishableKey = () => process.env.HYPERSWITCH_PUBLISHABLE_KEY || '';
