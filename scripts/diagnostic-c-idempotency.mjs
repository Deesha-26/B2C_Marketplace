#!/usr/bin/env node
/**
 * DIAGNOSTIC C — merchant-supplied payment_id idempotency
 *
 *   npm run diagnose:idempotency
 *
 * Crash recovery depends on one documented behaviour: a merchant-provided
 * payment_id "ensures idempotency for the payment creation request". If that is
 * not true in OUR sandbox, a retry after an uncertain create would charge the
 * customer twice.
 *
 * Sends Create Payment twice with the SAME payment_id and reports whether a
 * second charge occurred. Documented, not inferred.
 */
import {
  C, call, retrieve, paymentBody, printPayment, requireConfig,
  step, pass, fail, warn, info, money, sanitize, TEST_CARD,
} from './lib/hs.mjs';
import crypto from 'node:crypto';

console.log(`${C.b}Swoop — Diagnostic C: payment_id idempotency${C.off}`);
requireConfig();

const AMOUNT = 4200;
const opKey = `diagnostic:idempotency:${Date.now()}`;
const paymentId = 'swoop_' + crypto.createHash('sha256').update(opKey).digest('hex').slice(0, 24);

let failures = 0;
const bad = m => { failures++; fail(m); };

step('1. Derived identifier');
info(`operation key  ${opKey}`);
info(`payment_id     ${paymentId}  (${paymentId.length} chars, limit 30)`);
paymentId.length <= 30 ? pass('within the 30-character limit')
                       : bad(`too long: ${paymentId.length} characters`);

step('2. First Create Payment');
const first = await call('POST', '/payments', paymentBody(AMOUNT, { payment_id: paymentId, capture_method: 'automatic' }, TEST_CARD));
if (!first.ok) {
  bad(`HTTP ${first.status}`);
  console.log(`  ${C.dim}${JSON.stringify(sanitize(first.json))}${C.off}`);
  console.log(`\n${C.bad}Cannot continue — the sandbox may reject a merchant-supplied payment_id.${C.off}\n`);
  process.exit(1);
}
printPayment('create #1', first.json);
first.json.payment_id === paymentId
  ? pass('the sandbox accepted our payment_id verbatim')
  : bad(`sandbox assigned ${first.json.payment_id} instead — recovery cannot rely on derivation`);

step('3. Second Create Payment with the SAME payment_id');
const second = await call('POST', '/payments', paymentBody(AMOUNT, { payment_id: paymentId, capture_method: 'automatic' }, TEST_CARD));
console.log(`  ${C.dim}HTTP ${second.status}${C.off}`);
if (second.ok) {
  printPayment('create #2', second.json);
} else {
  console.log(`  ${C.dim}${JSON.stringify(sanitize(second.json))}${C.off}`);
}

const duplicateRejected = !second.ok;
const sameId = second.ok && second.json.payment_id === paymentId;

if (duplicateRejected) {
  pass(`the duplicate was rejected (HTTP ${second.status}, ${second.json?.error?.code ?? 'no code'})`);
  pass('a retry cannot create a second payment');
} else if (sameId) {
  pass('the same payment was returned rather than a new one');
} else {
  bad(`a SECOND payment was created: ${second.json?.payment_id}`);
  bad('deterministic-id recovery is UNSAFE on this sandbox — retrying could double-charge');
}

step('4. How much was actually charged');
const back = await retrieve(paymentId);
if (!back.ok) {
  bad(`retrieve failed (HTTP ${back.status})`);
} else {
  printPayment('retrieved', back.json);
  const received = Number(back.json.amount_received);
  if (received === AMOUNT) {
    pass(`exactly ${money(AMOUNT)} received — charged once`);
  } else if (received === AMOUNT * 2) {
    bad(`${money(received)} received — the customer was charged TWICE`);
  } else {
    warn(`amount_received is ${received}, expected ${AMOUNT}`);
  }
  Number(back.json.amount_capturable) === 0
    ? pass('nothing remains capturable')
    : warn(`amount_capturable is ${back.json.amount_capturable}`);
}

step('5. Verdict');
if (failures === 0) {
  pass('Deterministic payment_id recovery is SAFE on this sandbox.');
  info('A crash after an uncertain create can retry with the same id without double-charging.');
} else {
  fail('Deterministic payment_id recovery is NOT proven safe.');
  info('PaymentFlow must not recreate after a confirmed absence until this passes.');
}
console.log(`\n${C.dim}Paste this whole output.${C.off}\n`);
process.exit(failures ? 1 : 0);
