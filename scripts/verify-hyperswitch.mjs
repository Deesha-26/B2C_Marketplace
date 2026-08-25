#!/usr/bin/env node
/**
 * Live smoke test against YOUR Hyperswitch sandbox.
 *
 *   npm run verify
 *
 * Exercises every operation Swoop depends on, in order, and prints exactly what
 * the sandbox returned. Run this before wiring the app up — it tells you in
 * thirty seconds whether your keys, profile and connectors are configured, and
 * whether manual capture and extended authorization actually behave as the docs
 * describe on your account.
 *
 * Card data appears here ONLY because this is a server-side sandbox script.
 * The app itself never touches a card number — the SDK holds it in an iframe.
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---- load .env without a dependency ---- */
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = process.env.HYPERSWITCH_BASE_URL || 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_SECRET_KEY;
const PROFILE = process.env.HYPERSWITCH_PROFILE_ID;

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m' };
const money = c => '$' + (c / 100).toFixed(2);
let failures = 0;
const pass = m => console.log(`  ${C.ok}PASS${C.off}  ${m}`);
const fail = (m, d) => { failures++; console.log(`  ${C.bad}FAIL${C.off}  ${m}`); if (d) console.log(`        ${C.dim}${d}${C.off}`); };
const warn = m => console.log(`  ${C.warn}NOTE${C.off}  ${m}`);
const step = m => console.log(`\n${C.b}${m}${C.off}`);

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

const TEST_CARD = {
  card_number: '4242424242424242', card_exp_month: '12',
  card_exp_year: '2030', card_cvc: '123', card_holder_name: 'Alex Demo',
};
const DECLINE_CARD = { ...TEST_CARD, card_number: '4000000000009995' };

const paymentBody = (amount, extra = {}, card = TEST_CARD) => ({
  amount, currency: 'USD', confirm: true, profile_id: PROFILE,
  customer_id: 'swoop_verify_customer',
  payment_method: 'card', payment_method_type: 'credit',
  payment_method_data: { card },
  description: 'Swoop sandbox verification',
  ...extra,
});

/* ------------------------------------------------------------------ run ---- */
console.log(`${C.b}Swoop — Hyperswitch sandbox verification${C.off}`);
console.log(`${C.dim}${BASE}${C.off}`);

step('0. Configuration');
for (const [name, val] of [
  ['HYPERSWITCH_SECRET_KEY', KEY],
  ['HYPERSWITCH_PUBLISHABLE_KEY', process.env.HYPERSWITCH_PUBLISHABLE_KEY],
  ['HYPERSWITCH_PROFILE_ID', PROFILE],
]) val ? pass(`${name} is set`) : fail(`${name} is missing`, 'copy .env.example to .env and fill it in');
process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY
  ? pass('HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY is set')
  : warn('HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY is empty — webhooks will be refused');
if (!KEY) { console.log('\nCannot continue without a secret key.\n'); process.exit(1); }

/* --- 0b. what the business profile actually has switched on --- */
const MERCHANT = process.env.HYPERSWITCH_MERCHANT_ID;
if (MERCHANT && PROFILE) {
  step('0b. Business profile settings');
  const prof = await call('GET', `/account/${MERCHANT}/business_profile/${PROFILE}`);
  if (!prof.ok) {
    warn(`could not read the profile (${prof.status}) — check HYPERSWITCH_MERCHANT_ID`);
  } else {
    // Field names vary by version, so surface anything relevant rather than
    // guessing at exact keys.
    const interesting = Object.entries(prof.json)
      .filter(([k]) => /retr|extend|capture|block|overcapture/i.test(k));
    if (interesting.length === 0) {
      warn('the profile returned no retry/capture settings to report');
    }
    for (const [k, v] of interesting) {
      const val = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      console.log(`  ${C.dim}${k}: ${val}${C.off}`);
    }
    const retries = prof.json.is_auto_retries_enabled ?? prof.json.auto_retries_enabled;
    if (retries === true) pass('auto retries are enabled — rerouting is possible');
    else if (retries === false) warn('auto retries are OFF — step 7 cannot produce a second attempt');

    const blocked = prof.json.payment_method_blocking ?? prof.json.blocked_payment_methods;
    if (blocked && JSON.stringify(blocked) !== '{}') {
      warn(`payment method blocking is configured: ${JSON.stringify(blocked)}`);
      warn('Blocking feeds connector eligibility, which is the same machinery routing uses.');
    }
  }
}

/* --- 1. auto-capture (wallet top-up) --- */
step('1. Wallet top-up — auto capture');
const topup = await call('POST', '/payments', paymentBody(2500, { capture_method: 'automatic' }));
let topupId = null;
if (topup.ok && topup.json.status === 'succeeded') {
  topupId = topup.json.payment_id;
  pass(`charged ${money(topup.json.amount)} — ${topupId} via ${topup.json.connector}`);
} else if (topup.ok) {
  topupId = topup.json.payment_id;
  warn(`status is "${topup.json.status}" (expected succeeded) — ${topupId}`);
} else {
  fail('could not create an auto-capture payment', JSON.stringify(topup.json.error ?? topup.json));
}

/* --- 2. manual capture (job authorization) --- */
step('2. Job authorization — manual capture');
const auth = await call('POST', '/payments', paymentBody(9675, {
  capture_method: 'manual', request_extended_authorization: true,
}));
let authId = null;
if (!auth.ok) {
  fail('authorization failed', JSON.stringify(auth.json.error ?? auth.json));
} else {
  authId = auth.json.payment_id;
  if (auth.json.status === 'requires_capture') {
    pass(`held ${money(auth.json.amount)} without charging — ${authId}`);
  } else {
    fail(`status is "${auth.json.status}", expected requires_capture`,
      'this connector may not honour manual capture — the escrow model depends on it');
  }
  auth.json.capture_by
    ? pass(`capture deadline: ${auth.json.capture_by}`)
    : warn('no capture_by returned — the watchdog will fall back to extended_authorization_last_applied_at');
  auth.json.extended_authorization_applied
    ? pass('extended authorization was applied at authorization')
    : warn('extended authorization not applied automatically — the watchdog will request it explicitly');
}

/* --- 3. extend authorization --- */
step('3. Extend authorization');
if (authId) {
  const ext = await call('POST', `/payments/${authId}/extend_authorization`, {});
  if (ext.ok) pass(`extended — capture_by now ${ext.json.capture_by ?? 'unchanged'}`);
  else warn(`not supported on this connector (${ext.status}) — jobs must be captured inside the standard window`);
}

/* --- 4. partial capture (en-route cancellation) --- */
step('4. Partial capture — the $30 en-route cancellation');
if (authId) {
  const cap = await call('POST', `/payments/${authId}/capture`, { amount_to_capture: 3000 });
  if (!cap.ok) {
    fail('partial capture failed', JSON.stringify(cap.json.error ?? cap.json));
  } else if (cap.json.status === 'partially_captured' || cap.json.amount_captured === 3000) {
    pass(`captured ${money(cap.json.amount_captured)} of ${money(cap.json.amount)}; remainder voided — status ${cap.json.status}`);
  } else {
    fail(`captured ${money(cap.json.amount_captured ?? 0)}, status "${cap.json.status}"`,
      'the en-route cancellation tier depends on partial capture');
  }
}

/* --- 5. void --- */
step('5. Void — the free cancellation');
const toVoid = await call('POST', '/payments', paymentBody(5000, { capture_method: 'manual' }));
if (toVoid.ok) {
  const v = await call('POST', `/payments/${toVoid.json.payment_id}/cancel`, { cancellation_reason: 'requested_by_customer' });
  if (v.ok && v.json.status === 'cancelled') pass('hold released, nothing charged');
  else fail(`void returned "${v.json.status ?? v.status}"`, JSON.stringify(v.json.error ?? {}));
} else fail('could not create a payment to void');

/* --- 6. refund --- */
step('6. Refund — withdrawal and upheld disputes');
if (topupId) {
  const r = await call('POST', '/refunds', { payment_id: topupId, amount: 1000, reason: 'Swoop verification' });
  if (r.ok) pass(`refund ${r.json.refund_id} for ${money(r.json.amount)} — status ${r.json.status}`);
  else fail('refund failed', JSON.stringify(r.json.error ?? r.json));
}

/* --- 7. routing and retries --- */
step('7. Routing and retries');

/**
 * Hyperswitch's own onboarding demonstrates this by routing to PayPal first:
 * PayPal cannot process a raw card number, that connector-level failure is
 * retryable, and Hyperswitch falls through to Stripe.
 *
 * The app never names a connector — routing is a dashboard concern. This
 * diagnostic names one deliberately, purely to prove the retry path works.
 */
const routed = await call('POST', '/payments', {
  ...paymentBody(4200, { capture_method: 'automatic' }, DECLINE_CARD),
  routing: { type: 'priority', data: [{ connector: 'paypal' }, { connector: 'stripe' }] },
});

let trail = routed.ok ? (routed.json.attempts ?? []) : [];
if (routed.ok && trail.length < 2) {
  const full = await call('GET', `/payments/${routed.json.payment_id}?force_sync=true&expand_attempts=true`);
  if (full.ok && Array.isArray(full.json.attempts)) trail = full.json.attempts;
}

console.log(`  ${C.dim}status: ${routed.ok ? routed.json.status : 'HTTP ' + routed.status}${C.off}`);
if (trail.length > 1) {
  pass(`Hyperswitch retried across ${trail.length} attempts:`);
  trail.forEach((a, i) => console.log(`        ${i + 1}. ${a.connector} → ${a.status}${a.error_code ? ` (${a.error_code})` : ''}`));
} else if (trail.length === 1) {
  warn(`single attempt via ${trail[0].connector} — no retry happened`);
  warn('For the two-attempt trail, PayPal must sit ahead of Stripe in your routing');
  warn('order, and smart retry must be enabled on the merchant account.');
} else {
  warn('no attempts array returned — check Payment Operations in the dashboard');
}

/* An unrouted control, so a single attempt above is distinguishable from a
   connector that simply ignores routing. */
const unrouted = await call('POST', '/payments', paymentBody(4200, { capture_method: 'automatic' }, DECLINE_CARD));
if (unrouted.ok) {
  const n = (unrouted.json.attempts ?? []).length;
  console.log(`  ${C.dim}control, no routing directive: ${unrouted.json.status} in ${n} attempt(s)${C.off}`);
  if (unrouted.json.status === 'succeeded') {
    warn('The decline card succeeded — this connector does not emulate issuer declines.');
  }
}

/* --- 8. retrieve with attempts --- */
step('8. Retrieve — what the app reads back');
if (topupId) {
  const g = await call('GET', `/payments/${topupId}?force_sync=true&expand_attempts=true`);
  if (g.ok) {
    pass(`retrieved ${topupId}: status ${g.json.status}, captured ${money(g.json.amount_captured ?? 0)}`);
    Array.isArray(g.json.attempts)
      ? pass(`attempts array present (${g.json.attempts.length}) — the routing trail will render`)
      : warn('no attempts array — the routing trail will be empty in the UI');
  } else fail('retrieve failed', JSON.stringify(g.json.error ?? g.json));
}

/* ---- summary ---- */
console.log(`\n${C.b}${failures === 0 ? C.ok + 'All checks passed.' : C.bad + failures + ' check(s) failed.'}${C.off}`);
console.log(`${C.dim}Anything marked NOTE is a configuration difference, not a bug — read it before demoing.${C.off}\n`);
process.exit(failures ? 1 : 0);