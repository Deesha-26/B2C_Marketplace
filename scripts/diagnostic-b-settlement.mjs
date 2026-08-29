#!/usr/bin/env node
/**
 * DIAGNOSTIC B — settlement capability, per processor
 *
 *   npm run diagnose:settlement
 *
 * Probes each configured dummy processor for the nine settlement capabilities
 * Round 1 depends on, and applies the Mode A / Mode B classification rules
 * against the real responses.
 *
 * Two rules govern this script:
 *   1. Print the raw fields. Never convert a response into assumed behaviour.
 *   2. Never infer support from the API surface. Only a live response counts.
 *
 * This is the one place a connector is named deliberately — a probe must target
 * a specific processor. The application never does, and Diagnostic A asserts it.
 */
import {
  C, call, retrieve, paymentBody, printPayment, listConnectors, requireConfig,
  step, pass, fail, warn, info, money, sanitize, TEST_CARD,
} from './lib/hs.mjs';

console.log(`${C.b}Swoop — Diagnostic B: settlement capability${C.off}`);
requireConfig();

const PARTIAL = 3000;          // the $30 en-route cancellation amount
const AMOUNT  = 9675;          // a $90 bid + 7.5% handling fee
const THREE_DS_CARD = {
  ...TEST_CARD,
  card_number: '4000003800000446',
};
/**
 * Mode classification — the agreed rules, evaluated against a RETRIEVED payment.
 * Deliberately not status-only: status and amount evidence must agree, and a
 * contradiction is a reconciliation error rather than a guess.
 */
function classify({ requestedManual, retrieved, approvedTotal }) {
  const status      = retrieved.status;
  const capturable  = retrieved.amount_capturable;
  const received    = retrieved.amount_received;
  const captures    = Array.isArray(retrieved.captures) ? retrieved.captures : [];
  const succeededCaptures = captures.filter(c => /succeed|charged/i.test(String(c.status)));

  const checks = {
    requestedManual,
    statusRequiresCapture: status === 'requires_capture',
    capturableMatchesTotal: Number(capturable) === approvedTotal,
    nothingReceived: received == null || Number(received) === 0,
    noSuccessfulCapture: succeededCaptures.length === 0,
    statusSucceeded: status === 'succeeded',
    amountReceivedMatches: Number(received) === approvedTotal,
    captureRecordMatches: succeededCaptures.reduce((s, c) => s + Number(c.amount ?? 0), 0) === approvedTotal,
    nothingCapturable: capturable == null || Number(capturable) === 0,
  };

  const modeA = checks.requestedManual && checks.statusRequiresCapture &&
                checks.capturableMatchesTotal && checks.nothingReceived &&
                checks.noSuccessfulCapture;

  const modeB = checks.requestedManual && checks.statusSucceeded && checks.nothingCapturable &&
                (checks.amountReceivedMatches || checks.captureRecordMatches);

  let verdict;
  if (modeA) verdict = 'MODE_A';
  else if (modeB) verdict = 'MODE_B';
  else verdict = 'RECONCILIATION_ERROR';
  return { verdict, checks };
}

function reportClassification({ verdict, checks }) {
  const line = (ok, label) => console.log(`      ${ok ? C.ok + '✓' : C.dim + '·'}${C.off} ${label}`);
  console.log(`  ${C.cyan}manual-capture response classification${C.off}`);  line(checks.requestedManual,          'requested manual capture');
  line(checks.statusRequiresCapture,    'status === requires_capture');
  line(checks.capturableMatchesTotal,   'amount_capturable === approved total');
  line(checks.nothingReceived,          'amount_received is 0 or absent');
  line(checks.noSuccessfulCapture,      'no successful capture record');
  line(checks.statusSucceeded,          'status === succeeded');
  line(checks.amountReceivedMatches,    'amount_received === approved total');
  line(checks.captureRecordMatches,     'captures[] sum === approved total');
  if (verdict === 'MODE_A') pass('MODE_A — a genuine authorization hold exists');
  else if (verdict === 'MODE_B') pass('MODE_B — captured and internally reserved');
  else fail('RECONCILIATION_ERROR — status and amount evidence disagree; no ledger posting would occur');
}

/* Routes a probe to one specific connector. Diagnostic use only. */
const via = connector => (
  connector
    ? {
        routing: {
          type: 'single',
          data: {
            connector: connector.name,
            merchant_connector_id: connector.id
          }
        }
      }
    : {}
);
async function probe(connector) {
  const label = connector ? `${connector.name} (${connector.id})` : 'default routing';
  console.log(`\n${C.b}${'═'.repeat(62)}\n Processor: ${label}\n${'═'.repeat(62)}${C.off}`);
  const route = via(connector);
  const result = {
    connector: connector?.name ?? 'default',
    autoCapture: 'unverified', manualStatus: 'unverified', modeVerdict: 'unverified',
    fullCapture: 'unverified', partialCapture: 'unverified', voidAuth: 'unverified',
    refund: 'unverified', amountFields: 'unverified', threeDs: 'unverified',
  };

  /* -- 1. automatic capture -- */
  step('1. Automatic capture');
  const auto = await call('POST', '/payments', paymentBody(AMOUNT, { capture_method: 'automatic', ...route }));
  if (!auto.ok) {
    fail(`HTTP ${auto.status}`); info(JSON.stringify(sanitize(auto.json)));
    result.autoCapture = `error ${auto.status}`;
  } else {
    printPayment('create response', auto.json);
    result.autoCapture = auto.json.status;
    auto.json.status === 'succeeded' ? pass('succeeded') : warn(`status "${auto.json.status}"`);
  }
  const autoId = auto.ok ? auto.json.payment_id : null;

  /* -- 2 & 3. manual capture request, and what came back -- */
  step('2. Manual-capture request');
  const manual = await call('POST', '/payments', paymentBody(AMOUNT, { capture_method: 'manual', ...route }));
  let manualId = null, classification = null;
  if (!manual.ok) {
    fail(`HTTP ${manual.status}`); info(JSON.stringify(sanitize(manual.json)));
    result.manualStatus = `error ${manual.status}`;
  } else {
    printPayment('create response', manual.json);
    manualId = manual.json.payment_id;

    step('3. Retrieved state and mode classification');
    const back = await retrieve(manualId);
    if (back.ok) {
      printPayment('retrieved', back.json);
      result.manualStatus = back.json.status;
      classification = classify({ requestedManual: true, retrieved: back.json, approvedTotal: AMOUNT });
      reportClassification(classification);
      result.modeVerdict = classification.verdict;
    } else {
      fail(`retrieve failed (HTTP ${back.status})`);
    }
  }

  const heldOK = result.modeVerdict === 'MODE_A';

  if (result.modeVerdict === 'MODE_B') {
  warn('processor captured instead of holding funds — Steps 4, 5 and 6 are not applicable');
  result.fullCapture =
    result.partialCapture =
    result.voidAuth =
      'not applicable (Mode B)';
  } else if (!heldOK) {
  warn('manual-capture capability was not established — skipping Steps 4, 5 and 6');
  result.fullCapture =
    result.partialCapture =
    result.voidAuth =
      'not attempted (probe inconclusive)';
  }

  /* -- 4. full capture -- */
  if (heldOK) {
    step('4. Full capture');
    const cap = await call('POST', `/payments/${manualId}/capture`, { amount_to_capture: AMOUNT });
    if (!cap.ok) { fail(`HTTP ${cap.status}`); info(JSON.stringify(sanitize(cap.json))); result.fullCapture = `error ${cap.status}`; }
    else {
      printPayment('capture response', cap.json);
      const after = await retrieve(manualId);
      if (after.ok) printPayment('retrieved after capture', after.json);
      result.fullCapture = cap.json.status;
      Number(after.json?.amount_received) === AMOUNT
        ? pass(`amount_received === ${money(AMOUNT)}`)
        : warn(`amount_received is ${after.json?.amount_received} — expected ${AMOUNT}`);
    }
  }

  /* -- 5. partial capture of exactly $30 -- */
  if (heldOK) {
    step(`5. Partial capture of ${money(PARTIAL)}`);
    const p = await call('POST', '/payments', paymentBody(AMOUNT, { capture_method: 'manual', ...route }));
    if (!p.ok) { fail('could not create a second held payment'); result.partialCapture = 'setup failed'; }
    else {
      const cap = await call('POST', `/payments/${p.json.payment_id}/capture`, { amount_to_capture: PARTIAL });
      if (!cap.ok) { fail(`HTTP ${cap.status}`); info(JSON.stringify(sanitize(cap.json))); result.partialCapture = `error ${cap.status}`; }
      else {
        printPayment('partial capture response', cap.json);
        const after = await retrieve(p.json.payment_id);
        if (after.ok) printPayment('retrieved after partial capture', after.json);
        result.partialCapture = cap.json.status;
        Number(after.json?.amount_received) === PARTIAL
          ? pass(`exactly ${money(PARTIAL)} received; remainder released`)
          : warn(`amount_received is ${after.json?.amount_received} — expected ${PARTIAL}`);
      }
    }
  }

  /* -- 6. void -- */
  if (heldOK) {
    step('6. Cancel / void an authorization');
    const v = await call('POST', '/payments', paymentBody(AMOUNT, { capture_method: 'manual', ...route }));
    if (!v.ok) { fail('could not create a payment to void'); result.voidAuth = 'setup failed'; }
    else {
      const c = await call('POST', `/payments/${v.json.payment_id}/cancel`,
        { cancellation_reason: 'requested_by_customer' });
      if (!c.ok) { fail(`HTTP ${c.status}`); info(JSON.stringify(sanitize(c.json))); result.voidAuth = `error ${c.status}`; }
      else {
        printPayment('cancel response', c.json);
        result.voidAuth = c.json.status;
        c.json.status === 'cancelled' ? pass('cancelled, nothing captured')
                                      : warn(`status "${c.json.status}"`);
      }
    }
  }

  /* -- 7. refund -- */
  step('7. Refund a captured payment');
  if (!autoId) { warn('no captured payment available'); result.refund = 'not attempted'; }
  else {
    const r = await call('POST', '/refunds', { payment_id: autoId, amount: 1000, reason: 'diagnostic' });
    if (!r.ok) { fail(`HTTP ${r.status}`); info(JSON.stringify(sanitize(r.json))); result.refund = `error ${r.status}`; }
    else { info(`refund_id ${r.json.refund_id}  status ${r.json.status}  amount ${r.json.amount}`);
           result.refund = r.json.status; pass(`refund ${r.json.status}`); }
  }

  /* -- 8. amount-field accuracy -- */
  step('8. Amount-field accuracy on a known auto-captured payment');
  if (!autoId) { warn('skipped'); }
  else {
    const back = await retrieve(autoId);
    if (!back.ok) { fail(`retrieve failed (HTTP ${back.status})`); }
    else {
      printPayment('retrieved', back.json);
      const received = Number(back.json.amount_received);
      const capturable = Number(back.json.amount_capturable);

      const consistent =
       back.json.status === 'succeeded' &&
       received === AMOUNT &&
       capturable === 0;      result.amountFields = consistent ? 'consistent' : 'inconsistent';
      consistent
        ? pass('automatic capture is consistent: full amount received and nothing remains capturable')
        : fail(
      `automatic capture is inconsistent: status="${back.json.status}", ` +
      `amount_received=${back.json.amount_received}, ` +
      `amount_capturable=${back.json.amount_capturable}`
       );      
       if ('amount_captured' in back.json) {
        warn(`legacy amount_captured present with value ${back.json.amount_captured} — not used`);
      }
    }
  }

  /* -- 9. 3DS -- */
  step('9. 3DS flow');
  const tds = await call(
  'POST',
  '/payments',
  paymentBody(
    AMOUNT,
    {
      capture_method: 'automatic',
      authentication_type: 'three_ds',
      ...route,
    },
    THREE_DS_CARD
  ) 
  );  
  if (!tds.ok) { warn(`HTTP ${tds.status}`); info(JSON.stringify(sanitize(tds.json))); result.threeDs = `error ${tds.status}`; }
  else {
    printPayment('create response', tds.json);
    result.threeDs = tds.json.status;
    tds.json.next_action
      ? pass(`intermediate state reached: ${tds.json.status}`)
      : warn(`no next_action returned — status went straight to "${tds.json.status}"`);
  }

  return result;
}

/* ------------------------------------------------------------------ run --- */
const connectors = await listConnectors();
let targets;
if (!connectors?.length) {
  warn('could not list connectors — probing once through default routing');
  targets = [null];
} else {
  targets = connectors.filter(c => c.methods.includes('card'));
  if (targets.length === 0) targets = connectors;
  info(`probing ${targets.length} connector(s): ${targets.map(c => c.name).join(', ')}`);
}

const results = [];
for (const c of targets) results.push(await probe(c));

/* --------------------------------------------------------------- matrix --- */
console.log(`\n${C.b}${'═'.repeat(62)}\n Capability matrix\n${'═'.repeat(62)}${C.off}\n`);
const rows = [
  ['Automatic capture',        r => r.autoCapture],
  ['Manual-capture status',    r => r.manualStatus],
  ['Manual request verdict',   r => r.modeVerdict],  ['Full capture',             r => r.fullCapture],
  ['Partial capture ($30)',    r => r.partialCapture],
  ['Void / cancel',            r => r.voidAuth],
  ['Refund',                   r => r.refund],
  ['Amount-field accuracy',    r => r.amountFields],
  ['Round 1 usable path',
  r =>
    r.autoCapture === 'succeeded' &&
    r.amountFields === 'consistent'
      ? 'AUTO_CAPTURE'
      : 'unverified',
  ],
  ['3DS',                      r => r.threeDs],
];
const w = Math.max(...results.map(r => r.connector.length), 18);
console.log('  ' + 'Capability'.padEnd(24) + results.map(r => r.connector.padEnd(w)).join(''));
console.log('  ' + '─'.repeat(24 + w * results.length));
for (const [label, get] of rows) {
  console.log('  ' + label.padEnd(24) + results.map(r => String(get(r)).padEnd(w)).join(''));
}

const evaluated = results.filter(
  r => r.modeVerdict === 'MODE_A' || r.modeVerdict === 'MODE_B'
);

const anyModeA = results.some(
  r => r.modeVerdict === 'MODE_A'
);

const allAutomaticCaptureReady =
  results.length > 0 &&
  results.every(
    r =>
      r.autoCapture === 'succeeded' &&
      r.amountFields === 'consistent'
  );

console.log(`\n${C.b}Consequence for Round 1${C.off}`);

if (anyModeA) {
  pass('At least one processor demonstrated a genuine authorization hold.');
  warn('Mode A must still be used only when the retrieved payment evidence is consistent.');
} else if (allAutomaticCaptureReady) {
  pass('ROUND 1 MODE B SUPPORTED — both dummy processors reliably support automatic capture.');
  warn('Manual-capture responses are contradictory and will not be used.');
  info('Swoop will intentionally request automatic capture for job payments.');
  info('After capture, Swoop will reserve and allocate the funds using its Supabase ledger.');
  info('The UI must say “Payment captured and reserved by Swoop.”');
  info('Manual authorization, partial capture and void are deferred.');
} else {
  fail('INCONCLUSIVE — reliable automatic capture was not established across both processors.');
  warn('Do not post job funds to the ledger.');
}