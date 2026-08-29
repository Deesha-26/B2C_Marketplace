/**
 * Shared helpers for Diagnostics A and B.
 *
 * Both diagnostics print RAW response fields. Nothing here converts a response
 * into assumed behaviour — that is the entire point of running them.
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---- .env without a dependency ---- */
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const BASE     = process.env.HYPERSWITCH_BASE_URL || 'https://sandbox.hyperswitch.io';
export const KEY      = process.env.HYPERSWITCH_SECRET_KEY;
export const PROFILE  = process.env.HYPERSWITCH_PROFILE_ID;
export const MERCHANT = process.env.HYPERSWITCH_MERCHANT_ID;

export const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m',
  dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m', cyan: '\x1b[36m',
};

export const money = c => (c == null ? '—' : '$' + (Number(c) / 100).toFixed(2));
export const step = m => console.log(`\n${C.b}${m}${C.off}`);
export const pass = m => console.log(`  ${C.ok}PASS${C.off}  ${m}`);
export const fail = m => console.log(`  ${C.bad}FAIL${C.off}  ${m}`);
export const warn = m => console.log(`  ${C.warn}NOTE${C.off}  ${m}`);
export const info = m => console.log(`  ${C.dim}${m}${C.off}`);

/** Redacts anything that looks like a credential before printing. */
export function sanitize(obj) {
  const SECRET = /(api[_-]?key|secret|hash[_-]?key|authorization|client_secret)/i;
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) =>
        [k, SECRET.test(k) ? '[redacted]' : walk(val)]));
    }
    return v;
  };
  return walk(obj);
}

export async function call(method, p, body) {
  if (!KEY) throw new Error('HYPERSWITCH_SECRET_KEY is not set — copy .env.example to .env');
  const res = await fetch(BASE + p, {
    method,
    headers: { 'api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { unparsed: text }; }
  return { ok: res.ok, status: res.status, json };
}

/**
 * The response fields that actually matter for settlement, per the current API.
 * `amount_captured` is deliberately absent — it is not the field to reconcile
 * against. Anything unexpected is surfaced rather than dropped.
 */
export const FIELDS = [
  'payment_id', 'status', 'amount', 'amount_received', 'amount_capturable',
  'currency', 'capture_method', 'connector', 'error_code', 'error_message',
  'authentication_type', 'next_action',
];

export function printPayment(label, json) {
  console.log(`  ${C.cyan}${label}${C.off}`);
  for (const f of FIELDS) {
    if (json[f] !== undefined) {
      const v = f.startsWith('amount') && f !== 'amount_to_capture'
        ? `${json[f]}  ${C.dim}(${money(json[f])})${C.off}`
        : JSON.stringify(json[f]);
      console.log(`      ${f.padEnd(22)} ${v}`);
    }
  }
  const caps = json.captures;
  if (Array.isArray(caps)) {
    console.log(`      ${'captures[]'.padEnd(22)} ${caps.length} record(s)`);
    caps.forEach((c, i) => console.log(
      `        ${i + 1}. status=${c.status} amount=${c.amount} (${money(c.amount)})`));
  } else if ('captures' in json) {
    console.log(`      ${'captures[]'.padEnd(22)} ${JSON.stringify(caps)}`);
  } else {
    console.log(`      ${C.dim}captures[]             not present in response${C.off}`);
  }
  // Anything the API returned that we did not expect is worth seeing.
  const known = new Set([...FIELDS, 'captures', 'attempts', 'client_secret', 'created',
    'profile_id', 'merchant_id', 'customer_id', 'amount_captured']);
  const extra = Object.keys(json).filter(k => !known.has(k) && /amount|captur|author/i.test(k));
  if (extra.length) console.log(`      ${C.warn}other amount/capture fields: ${extra.join(', ')}${C.off}`);
  if ('amount_captured' in json) {
    console.log(`      ${C.warn}amount_captured        ${json.amount_captured} ` +
                `(legacy field, present — not used for reconciliation)${C.off}`);
  }
}

export function printAttempts(json) {
  const trail = json.attempts;
  if (!Array.isArray(trail)) {
    warn(`no attempts[] in the response (key ${'attempts' in json ? 'present but not an array' : 'absent'})`);
    return [];
  }
  console.log(`  ${C.cyan}attempts[] — ${trail.length} attempt(s)${C.off}`);
  trail.forEach((a, i) => {
    const who = a.connector ?? a.merchant_connector_id ?? '(no connector field)';
    const err = a.error_code || a.error_message
      ? ` ${C.dim}error=${a.error_code ?? ''} ${a.error_message ?? ''}${C.off}` : '';
    console.log(`      ${i + 1}. ${String(who).padEnd(20)} status=${a.status}` +
                `${a.attempt_id ? ` id=${a.attempt_id}` : ''}${err}`);
  });
  return trail;
}

export const TEST_CARD = {
  card_number: '4242424242424242', card_exp_month: '12',
  card_exp_year: '2030', card_cvc: '123', card_holder_name: 'Swoop Diagnostic',
};
export const REROUTE_CARD = { ...TEST_CARD, card_number: '4000000000009995' };

/**
 * Builds a payment body. `extra` is spread last so a probe can override, but
 * NOTHING here ever sets a connector — Diagnostic A asserts that.
 */
export const paymentBody = (amount, extra = {}, card = TEST_CARD) => ({
  amount, currency: 'USD', confirm: true, profile_id: PROFILE,
  customer_id: 'swoop_diagnostic',
  payment_method: 'card', payment_method_type: 'credit',
  payment_method_data: { card },
  description: 'Swoop capability diagnostic',
  ...extra,
});

export const retrieve = id =>
  call('GET', `/payments/${id}?force_sync=true&expand_attempts=true&expand_captures=true`);

/** Lists configured connectors so probes can target one without guessing names. */
export async function listConnectors() {
  if (!MERCHANT) return null;
  const r = await call('GET', `/account/${MERCHANT}/connectors`);
  if (!r.ok || !Array.isArray(r.json)) return null;
  return r.json.map(c => ({
    name: c.connector_name,
    label: c.connector_label,
    id: c.merchant_connector_id,
    profileId: c.profile_id,
    disabled: c.disabled === true || c.status === 'inactive',
    methods: (c.payment_methods_enabled ?? []).map(m => m.payment_method).filter(Boolean),
  }));
}

export function requireConfig() {
  const missing = [];
  if (!KEY) missing.push('HYPERSWITCH_SECRET_KEY');
  if (!PROFILE) missing.push('HYPERSWITCH_PROFILE_ID');
  if (missing.length) {
    console.log(`\n${C.bad}Missing: ${missing.join(', ')}${C.off}`);
    console.log('Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  if (!MERCHANT) {
    warn('HYPERSWITCH_MERCHANT_ID is not set — connector listing will be skipped');
  }
}
