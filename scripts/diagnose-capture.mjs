#!/usr/bin/env node
/**
 * Isolates WHY manual capture came back as `succeeded`.
 *
 *   node scripts/diagnose-capture.mjs
 *
 * `npm run verify` sends capture_method:manual together with
 * request_extended_authorization:true. If the connector rejects the second
 * field it may be discarding the first with it. This sends the same payment
 * four ways, changing one variable at a time, so the cause is unambiguous.
 */
import fs from 'node:fs';
import path from 'node:path';

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
const MERCHANT = process.env.HYPERSWITCH_MERCHANT_ID;

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m' };

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { ok: res.ok, status: res.status, json: j };
}

const CARD = { card_number: '4242424242424242', card_exp_month: '12', card_exp_year: '2030', card_cvc: '123' };

/** Same payment every time; only `extra` changes. */
const body = extra => ({
  amount: 1000, currency: 'USD', confirm: true, profile_id: PROFILE,
  customer_id: 'swoop_diagnose', payment_method: 'card', payment_method_type: 'credit',
  payment_method_data: { card: CARD }, description: 'capture diagnosis', ...extra,
});

console.log(`\n${C.b}Why did manual capture return "succeeded"?${C.off}\n`);

/* ---- which connectors are configured, and what do they support? ---- */
if (MERCHANT) {
  const acct = await call('GET', `/accounts/${MERCHANT}/connectors`);
  if (acct.ok && Array.isArray(acct.json)) {
    console.log(`${C.b}Connectors on this merchant${C.off}`);
    for (const c of acct.json) {
      console.log(`  ${c.connector_name}  ${C.dim}(${c.merchant_connector_id})${C.off}`);
    }
    const dummy = acct.json.filter(c => /_test$|dummy|fauxpay|phonypay/i.test(c.connector_name || ''));
    if (dummy.length) {
      console.log(`  ${C.warn}NOTE${C.off}  ${dummy.map(d => d.connector_name).join(', ')} are Hyperswitch's built-in`);
      console.log(`        simulators. They accept the API surface but do not emulate`);
      console.log(`        issuer behaviour — no manual capture, no declines.`);
    }
  } else {
    console.log(`${C.dim}Could not list connectors (${acct.status}) — set HYPERSWITCH_MERCHANT_ID to enable this.${C.off}`);
  }
  console.log();
}

/* ---- four variants, one variable at a time ---- */
const variants = [
  ['manual capture alone',
    { capture_method: 'manual' }],
  ['manual capture + extended authorization',
    { capture_method: 'manual', request_extended_authorization: true }],
  ['manual capture, authorize without confirming',
    { capture_method: 'manual', confirm: false }],
  ['automatic capture (control)',
    { capture_method: 'automatic' }],
];

const results = [];
for (const [label, extra] of variants) {
  const r = await call('POST', '/payments', body(extra));
  const st = r.ok ? r.json.status : `HTTP ${r.status}`;
  const sent = r.ok ? (r.json.capture_method ?? '—') : '—';
  const held = st === 'requires_capture';
  const colour = held ? C.ok : st === 'succeeded' && extra.capture_method === 'automatic' ? C.ok : C.bad;
  console.log(`  ${colour}${String(st).padEnd(24)}${C.off} ${label}`);
  console.log(`  ${C.dim}capture_method echoed back: ${sent}${r.ok ? '' : ' · ' + JSON.stringify(r.json.error ?? r.json)}${C.off}`);
  results.push({ label, status: st, held, extra });
}

/* ---- does the connector report amount_captured honestly? ---- */
console.log(`\n${C.b}Is amount_captured trustworthy?${C.off}`);
const auto = await call('POST', '/payments', body({ capture_method: 'automatic' }));
if (auto.ok) {
  const id = auto.json.payment_id;
  const back = await call('GET', `/payments/${id}?force_sync=true&expand_attempts=true`);
  const captured = back.json.amount_captured;
  const status = back.json.status;
  console.log(`  status ${status} · amount ${back.json.amount} · amount_captured ${captured}`);
  if (status === 'succeeded' && (captured === 0 || captured == null)) {
    console.log(`  ${C.bad}The connector reports 0 captured on a succeeded payment.${C.off}`);
    console.log(`  ${C.dim}Do not store this field verbatim — derive it from status instead.${C.off}`);
  } else {
    console.log(`  ${C.ok}amount_captured agrees with status.${C.off}`);
  }
}

/* ---- does it honour decline cards? ---- */
console.log(`\n${C.b}Does the connector emulate a decline?${C.off}`);
const declined = await call('POST', '/payments', {
  ...body({ capture_method: 'automatic' }),
  payment_method_data: { card: { ...CARD, card_number: '4000000000009995' } },
});
const dStatus = declined.ok ? declined.json.status : `HTTP ${declined.status}`;
if (dStatus === 'failed') {
  console.log(`  ${C.ok}Declined as expected: ${declined.json.error_code ?? 'no code'}${C.off}`);
} else {
  console.log(`  ${C.bad}Returned "${dStatus}" for a decline card — declines are not emulated.${C.off}`);
  console.log(`  ${C.dim}No failure, retry or rerouting scenario can be demonstrated on this connector.${C.off}`);
}

/* ---- verdict ---- */
const manualAlone = results.find(r => r.label === 'manual capture alone');
const manualExt = results.find(r => r.label === 'manual capture + extended authorization');

console.log(`\n${C.b}Verdict${C.off}`);
if (manualAlone?.held && !manualExt?.held) {
  console.log(`  ${C.ok}request_extended_authorization is the culprit.${C.off}`);
  console.log(`  Manual capture works on its own. Set risk.needsExtendedAuth to false`);
  console.log(`  (server/intelligence/risk.js) and the escrow model works unchanged.`);
} else if (manualAlone?.held) {
  console.log(`  ${C.ok}Manual capture works. Re-run npm run verify.${C.off}`);
} else {
  console.log(`  ${C.bad}This connector does not support manual capture at all.${C.off}`);
  console.log(`  Two options:`);
  console.log(`    1. Add a real Stripe connector using your own Stripe TEST keys`);
  console.log(`       (sk_test_… from dashboard.stripe.com). Stripe genuinely supports`);
  console.log(`       manual capture, partial capture, void and decline cards.`);
  console.log(`    2. Run Swoop in escrow-ledger mode: charge at booking, model the`);
  console.log(`       hold in the ledger, and settle cancellations with refunds.`);
  console.log(`       Set PAYMENT_MODE=escrow_ledger in .env.`);
}
console.log();