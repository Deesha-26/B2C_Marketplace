#!/usr/bin/env node
/**
 * DIAGNOSTIC A — routing and rerouting
 *
 *   npm run diagnose:routing
 *
 * Verifies, against OUR hosted sandbox:
 *   - both dummy processors active for the same method and currency
 *   - a payment created with NO connector specified
 *   - card 4000 0000 0000 9995 failing on the first processor
 *   - Hyperswitch rerouting to the second
 *   - the attempt trail being retrievable
 *
 * Prints raw response fields. Draws no conclusion the response does not support.
 */
import {
  C, call, retrieve, paymentBody, printPayment, printAttempts, listConnectors,
  requireConfig, REROUTE_CARD, PROFILE, step, pass, fail, warn, info, sanitize,
} from './lib/hs.mjs';

console.log(`${C.b}Swoop — Diagnostic A: routing and rerouting${C.off}`);
requireConfig();

let failures = 0;
const bad = m => { failures++; fail(m); };

/* ---------------------------------------------------------------- 1 ------- */
step('1. Configured connectors');
const connectors = await listConnectors();

if (!connectors) {
  warn('could not list connectors — set HYPERSWITCH_MERCHANT_ID to enable this check');
} else {
  const eligibleConnectors = connectors.filter(
    c => c.profileId === PROFILE && !c.disabled
  );
  for (const c of eligibleConnectors) {
    console.log(
      `  ${c.name.padEnd(22)} ${C.dim}${c.id}${C.off}` +
      (c.methods.length
        ? `  methods: ${[...new Set(c.methods)].join(', ')}`
        : '')
    );
  }

  const paypal = eligibleConnectors.find(c => /paypal/i.test(c.name));
  const stripe = eligibleConnectors.find(c => /stripe/i.test(c.name));

  paypal
    ? pass(`PayPal-family connector present in active profile: ${paypal.name}`)
    : bad('no active PayPal connector in the current profile — rerouting cannot be demonstrated');

  stripe
    ? pass(`Stripe-family connector present in active profile: ${stripe.name}`)
    : bad('no active Stripe connector in the current profile — rerouting cannot be demonstrated');

  const withCard = eligibleConnectors.filter(
    c => c.methods.includes('card')
  );

  withCard.length >= 2
    ? pass(`${withCard.length} active connectors enabled for card in the current profile`)
    : bad(
        `only ${withCard.length} active connector(s) enabled for card in the current profile — a fallback needs two`
      );
}

/* ---------------------------------------------------------------- 2 ------- */
step('2. Request body contains no connector directive');
const body = paymentBody(4200, {}, REROUTE_CARD);
const serialized = JSON.stringify(body);
const leaked = ['connector', 'merchant_connector_id', 'routing']
  .filter(k => new RegExp(`"${k}"`).test(serialized));
leaked.length === 0
  ? pass('no connector, merchant_connector_id or routing field is sent')
  : bad(`request names the processor: ${leaked.join(', ')} — routing must be dashboard-driven`);
info(`card 4000 0000 0000 9995, amount 4200 (\$42.00), no routing directive`);

/* ---------------------------------------------------------------- 3 ------- */
step('3. Create the payment');
const created = await call('POST', '/payments', body);
if (!created.ok) {
  bad(`payment creation failed (HTTP ${created.status})`);
  console.log(`  ${C.dim}${JSON.stringify(sanitize(created.json))}${C.off}`);
  console.log(`\n${C.bad}Cannot continue.${C.off}\n`);
  process.exit(1);
}
printPayment('create response', created.json);
const paymentId = created.json.payment_id;

/* ---------------------------------------------------------------- 4 ------- */
step('4. Retrieve with expanded attempts');
const got = await retrieve(paymentId);
if (!got.ok) {
  bad(`retrieve failed (HTTP ${got.status})`);
} else {
  printPayment('retrieved', got.json);
}

/* ---------------------------------------------------------------- 5 ------- */
step('5. Attempt trail');
const trail = got.ok ? printAttempts(got.json) : [];

if (trail.length === 0) {
  warn('no attempt trail available — rerouting cannot be evidenced from this response');
  warn('check Payment Operations in the dashboard for this payment id and report what it shows');
} else if (trail.length === 1) {
  const only = trail[0];
  warn(`single attempt via ${only.connector ?? only.merchant_connector_id}, status ${only.status}`);
  warn('No rerouting occurred. Possible causes, in order of likelihood:');
  warn('  a) routing sends this payment straight to the succeeding processor');
  warn('  b) Auto Retries is off, or Max Auto Retries is 0');
  warn('  c) the first processor did not fail — this card may not fail on it');
} else {
  const first = trail[0], last = trail[trail.length - 1];
  const names = trail.map(a => a.connector ?? a.merchant_connector_id);
  pass(`${trail.length} attempts recorded`);
  new Set(names).size > 1
    ? pass(`across different processors: ${[...new Set(names)].join(' → ')}`)
    : warn(`all attempts used the same processor (${names[0]}) — this is a retry, not a reroute`);
  /^(failure|failed|charge_failed)$/i.test(String(first.status))
    ? pass(`first attempt failed as intended (${first.error_code ?? 'no error code'})`)
    : warn(`first attempt status is "${first.status}" — expected a failure`);
  /^(charged|succeeded|authorized)$/i.test(String(last.status))
    ? pass(`final attempt succeeded via ${last.connector ?? last.merchant_connector_id}`)
    : warn(`final attempt status is "${last.status}"`);
}

/* ---------------------------------------------------------------- 6 ------- */
step('6. Final external result');
info(`payment_id       ${paymentId}`);
info(`status           ${got.ok ? got.json.status : 'unknown'}`);
info(`connector        ${got.ok ? (got.json.connector ?? '—') : 'unknown'}`);
info('Cross-check this payment id in Payment Operations and report any difference.');

/* ---------------------------------------------------------------- done ---- */
console.log(`\n${C.b}${failures === 0
  ? C.ok + 'Diagnostic A completed with no hard failures.'
  : C.bad + failures + ' hard failure(s).'}${C.off}`);
console.log(`${C.dim}NOTE lines describe observed behaviour, not defects. Paste this whole output.${C.off}\n`);
process.exit(failures ? 1 : 0);
