/**
 * Step 3 — pure tests for deterministic ids, verification rules and the
 * operation state machine. No database required.
 *
 * Concurrency, atomicity and the 23505 path need real Postgres and live in
 * test/supabase.smoke.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  derivePaymentId, jobPaymentKey, walletTopUpKey, MAX_PAYMENT_ID_LENGTH,
} from '../server/payments/ids.js';
import { verifyAutoCapture, REASONS, FORBIDDEN_FIELDS } from '../server/payments/verify.js';
import { STATES, canTransition, TERMINAL, RECOVERABLE } from '../server/payments/operations.js';
import { isUniqueViolation } from '../server/db/index.js';

const AMOUNT = 9675, CURRENCY = 'USD';
const USER = '11111111-1111-1111-1111-111111111111';
const PID = derivePaymentId(jobPaymentKey('job_1', 'appr_1'));

const good = (over = {}) => ({
  payment_id: PID, status: 'succeeded',
  amount: AMOUNT, amount_received: AMOUNT, amount_capturable: 0,
  currency: CURRENCY, ...over,
});
const expected = (over = {}) => ({
  paymentId: PID, amount: AMOUNT, currency: CURRENCY,
  userId: USER, purpose: 'job_payment', ...over,
});
const record = (over = {}) => ({ user_id: USER, purpose: 'job_payment', ...over });

/* ------------------------------------------------------------- ids ------- */
describe('deterministic identifiers', () => {
  test('the same operation always derives the same payment id', () => {
    assert.equal(derivePaymentId('job:j1:payment:a1'), derivePaymentId('job:j1:payment:a1'));
  });

  test('different operations derive different ids', () => {
    assert.notEqual(derivePaymentId('job:j1:payment:a1'), derivePaymentId('job:j1:payment:a2'));
  });

  test('ids fit the 30-character Hyperswitch limit', () => {
    for (const k of ['a', 'job:'.repeat(50), walletTopUpKey(USER, 'req_abcdefghijklmnop')]) {
      assert.ok(derivePaymentId(k).length <= MAX_PAYMENT_ID_LENGTH, k);
    }
  });

  test('a job is paid once per approval, but re-approval is a new operation', () => {
    assert.equal(jobPaymentKey('job_1', 'appr_1'), jobPaymentKey('job_1', 'appr_1'));
    assert.notEqual(jobPaymentKey('job_1', 'appr_1'), jobPaymentKey('job_1', 'appr_2'));
  });

  test('two intentional top-ups by one customer are separate operations', () => {
    assert.notEqual(walletTopUpKey(USER, 'req_1'), walletTopUpKey(USER, 'req_2'));
    assert.notEqual(derivePaymentId(walletTopUpKey(USER, 'req_1')),
                    derivePaymentId(walletTopUpKey(USER, 'req_2')));
  });

  test('an empty operation key is refused', () => {
    assert.throws(() => derivePaymentId(''), /non-empty/);
    assert.throws(() => derivePaymentId(null), /non-empty/);
  });
});

/* ---------------------------------------------------------- verify ------- */
describe('automatic-capture verification', () => {
  test('a clean response verifies', () => {
    assert.equal(verifyAutoCapture({ retrieved: good(), expected: expected(), record: record() }).ok, true);
  });

  test('the observed sandbox contradiction is refused', () => {
    // Diagnostic B: succeeded, full amount received AND full amount capturable.
    const v = verifyAutoCapture({
      retrieved: good({ amount_capturable: AMOUNT }), expected: expected(), record: record() });
    assert.equal(v.ok, false);
    assert.equal(v.reason, REASONS.STILL_CAPTURABLE);
  });

  test('succeeded with the wrong amount_received is refused', () => {
    const v = verifyAutoCapture({
      retrieved: good({ amount_received: 5000 }), expected: expected(), record: record() });
    assert.equal(v.reason, REASONS.RECEIVED_MISMATCH);
  });

  test('a non-succeeded status is refused', () => {
    for (const status of ['requires_capture', 'processing', 'failed', 'cancelled']) {
      const v = verifyAutoCapture({ retrieved: good({ status }), expected: expected(), record: record() });
      assert.equal(v.ok, false, status);
      assert.equal(v.reason, REASONS.NOT_SUCCEEDED);
    }
  });

  test('a currency mismatch is refused', () => {
    const v = verifyAutoCapture({
      retrieved: good({ currency: 'EUR' }), expected: expected(), record: record() });
    assert.equal(v.reason, REASONS.CURRENCY);
  });

  test('currency comparison is case-insensitive', () => {
    assert.equal(verifyAutoCapture({
      retrieved: good({ currency: 'usd' }), expected: expected(), record: record() }).ok, true);
  });

  test('another user\u2019s payment is refused', () => {
    const v = verifyAutoCapture({
      retrieved: good(), expected: expected(), record: record({ user_id: 'someone-else' }) });
    assert.equal(v.reason, REASONS.OWNERSHIP);
  });

  test('a mismatched purpose is refused', () => {
    const v = verifyAutoCapture({
      retrieved: good(), expected: expected(), record: record({ purpose: 'wallet_topup' }) });
    assert.equal(v.reason, REASONS.PURPOSE);
  });

  test('a payment id mismatch is refused', () => {
    const v = verifyAutoCapture({
      retrieved: good({ payment_id: 'pay_other' }), expected: expected(), record: record() });
    assert.equal(v.reason, REASONS.ID_MISMATCH);
  });

  test('non-integer or non-positive amounts are refused', () => {
    for (const bad of [0, -1, 96.75, '9675', null, undefined, NaN]) {
      assert.equal(verifyAutoCapture({
        retrieved: good({ amount_received: bad }), expected: expected(), record: record() }).ok,
        false, `amount_received=${bad}`);
      assert.equal(verifyAutoCapture({
        retrieved: good(), expected: expected({ amount: bad }), record: record() }).ok,
        false, `expected.amount=${bad}`);
    }
  });

  test('a missing payment is refused', () => {
    assert.equal(verifyAutoCapture({ retrieved: null, expected: expected(), record: record() }).reason,
      REASONS.MISSING);
  });

  test('verification never reads amount_captured, captures[], connector or attempts', () => {
    const touched = [];
    const trap = new Proxy(good(), {
      get(target, prop) {
        if (FORBIDDEN_FIELDS.includes(prop)) touched.push(prop);
        return target[prop];
      },
    });
    verifyAutoCapture({ retrieved: trap, expected: expected(), record: record() });
    assert.deepEqual(touched, [],
      `verification consulted forbidden fields: ${touched.join(', ')}`);
  });

  test('a response carrying misleading legacy fields still verifies on the real ones', () => {
    const v = verifyAutoCapture({
      retrieved: good({ amount_captured: 0, captures: [], connector: 'paypal_test',
                        attempts: [{ status: 'failure' }] }),
      expected: expected(), record: record() });
    assert.equal(v.ok, true, 'amount_captured=0 and a failed attempt must not veto real evidence');
  });
});

/* ------------------------------------------------- state machine --------- */
describe('operation state machine', () => {
  test('the happy path is claimed → external → reconciliation → completed', () => {
    assert.ok(canTransition(STATES.CLAIMED, STATES.EXTERNAL_PENDING));
    assert.ok(canTransition(STATES.EXTERNAL_PENDING, STATES.RECONCILIATION_PENDING));
    assert.ok(canTransition(STATES.RECONCILIATION_PENDING, STATES.COMPLETED));
  });

  test('any pre-terminal state can end in discrepancy', () => {
    for (const s of [STATES.CLAIMED, STATES.EXTERNAL_PENDING, STATES.RECONCILIATION_PENDING]) {
      assert.ok(canTransition(s, STATES.DISCREPANCY), s);
    }
  });

  test('terminal states never transition again', () => {
    for (const from of TERMINAL) {
      for (const to of Object.values(STATES)) {
        assert.equal(canTransition(from, to), false, `${from} → ${to}`);
      }
    }
  });

  test('reconciliation can repeat without leaving its state', () => {
    assert.ok(canTransition(STATES.RECONCILIATION_PENDING, STATES.RECONCILIATION_PENDING));
  });

  test('an operation cannot skip straight from claimed to completed', () => {
    assert.equal(canTransition(STATES.CLAIMED, STATES.COMPLETED), false);
  });

  test('there is no failed state — uncertainty stays recoverable', () => {
    assert.ok(!Object.values(STATES).includes('failed'),
      'a failed operation would invite a second payment for money already taken');
    for (const s of [STATES.CLAIMED, STATES.EXTERNAL_PENDING, STATES.RECONCILIATION_PENDING]) {
      assert.ok(RECOVERABLE.has(s), s);
    }
  });
});

/* --------------------------------------------------- 23505 scoping ------- */
describe('unique-violation handling is scoped', () => {
  const err = (code, constraint) => Object.assign(new Error('boom'), { code, constraint });

  test('the intended constraint is recognised', () => {
    assert.equal(isUniqueViolation(err('23505', 'ledger_transactions_idempotency_key_uniq'),
      'ledger_transactions_idempotency_key_uniq'), true);
  });

  test('a different constraint is NOT treated as a duplicate', () => {
    assert.equal(isUniqueViolation(err('23505', 'users_pkey'),
      'ledger_transactions_idempotency_key_uniq'), false,
      'an unrelated unique failure must propagate, not report success');
  });

  test('a non-unique error is never a duplicate', () => {
    for (const code of ['23503', '23502', '40001', '57014', undefined]) {
      assert.equal(isUniqueViolation(err(code, 'anything'), 'anything'), false, String(code));
    }
  });

  test('a null error does not throw', () => {
    assert.equal(isUniqueViolation(null, 'x'), false);
    assert.equal(isUniqueViolation(undefined), false);
  });
});

/* ============================ Step 4 — pure route-layer guarantees ======== */
// `STATES` is already taken by the operation state machine above; the job
// lifecycle is a different vocabulary and is aliased to keep both readable.
import { cancellationTier, cancellationPreview, nextState, bidAmountFor,
         SEED_PROVIDERS, STATES as JOB } from '../server/jobs.js';
import { economics, PENALTY } from '../server/money.js';
import * as hsClient from '../server/hyperswitch.js';
import fs from 'node:fs';

describe('job lifecycle', () => {
  test('progress runs reserved → en route → arrived → in progress', () => {
    assert.equal(nextState(JOB.RESERVED), JOB.EN_ROUTE);
    assert.equal(nextState(JOB.EN_ROUTE), JOB.ARRIVED);
    assert.equal(nextState(JOB.ARRIVED), JOB.IN_PROGRESS);
    assert.equal(nextState(JOB.IN_PROGRESS), null, 'completion is its own route');
  });

  test('an unpaid job cannot advance', () => {
    for (const s of [JOB.OPEN_FOR_BIDS, JOB.APPROVED]) {
      assert.equal(nextState(s), null, `${s} must not advance before capture is verified`);
    }
  });

  test('cancellation before travel returns everything', () => {
    const p = cancellationPreview(JOB.RESERVED, 9000);
    assert.equal(p.tier, 'PRE_TRAVEL');
    assert.equal(p.retainedByProvider, 0);
    assert.equal(p.returnedToWallet, economics(9000).charge);
  });

  test('en-route and arrived cancellations retain exactly $30', () => {
  for (const state of [JOB.EN_ROUTE, JOB.ARRIVED]) {
    const p = cancellationPreview(state, 9000);

    assert.equal(p.tier, 'EN_ROUTE', state);
    assert.equal(p.retainedAmount, PENALTY, state);
    assert.equal(p.retainedByProvider, PENALTY, state);
    assert.equal(p.platformRevenue, 0, state);
    assert.equal(
      p.returnedToWallet,
      economics(9000).charge - PENALTY,
      state
    );
  }
});

test('in-progress cancellation retains the full charge', () => {
  const e = economics(9000);
  const p = cancellationPreview(JOB.IN_PROGRESS, 9000);

  assert.equal(p.tier, 'IN_PROGRESS');
  assert.equal(p.retainedAmount, e.charge);
  assert.equal(p.retainedByProvider, e.payout);
  assert.equal(p.platformRevenue, e.take);
  assert.equal(p.returnedToWallet, 0);
});

  test('terminal and pre-payment states cannot be cancelled', () => {
    for (const s of [JOB.OPEN_FOR_BIDS, JOB.APPROVED, JOB.COMPLETED,
                     JOB.CANCELLED_PRE_TRAVEL, JOB.CANCELLED_EN_ROUTE, JOB.CANCELLED_IN_PROGRESS]) {
      assert.equal(cancellationTier(s), null, s);
    }
  });

  test('emergency jobs are priced higher', () => {
    for (const p of SEED_PROVIDERS) {
      assert.ok(bidAmountFor(p.base, true) > bidAmountFor(p.base, false), p.trade);
    }
  });
});

describe('Hyperswitch client surface', () => {
  const src = fs.readFileSync(new URL('../server/hyperswitch.js', import.meta.url), 'utf8');

  test('no deferred operation is exposed', () => {
    for (const gone of ['capturePayment', 'voidPayment', 'extendAuthorization',
                        'createRefund', 'capturedAmount']) {
      assert.equal(hsClient[gone], undefined,
        `${gone} depends on a capability Diagnostic B could not establish`);
    }
  });

  test('the client never names a connector', () => {
    assert.ok(!/"connector"|merchant_connector_id\s*:|routing\s*:/.test(src),
      'routing must be decided by dashboard configuration');
  });

  test('amount_captured is never referenced', () => {
    assert.ok(!/amount_captured/.test(src));
  });

  test('the attempt trail is normalised without inventing fields', () => {
    const trail = hsClient.routingTrail({ attempts: [
      { connector: 'paypal_test', status: 'failure', error_code: 'DC_08', attempt_id: 'a_1' },
      { merchant_connector_id: 'mca_x', status: 'charged' },
    ] });
    assert.equal(trail.length, 2);
    assert.equal(trail[0].processor, 'paypal_test');
    assert.equal(trail[0].errorCode, 'DC_08');
    assert.equal(trail[1].processor, 'mca_x', 'falls back to the id when no name is given');
    assert.equal(trail[1].errorCode, null);
  });

  test('a missing attempts array yields an empty trail, not a crash', () => {
    assert.deepEqual(hsClient.routingTrail({}), []);
    assert.deepEqual(hsClient.routingTrail(null), []);
  });
});

describe('route-layer invariants', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

  test('every payment request asks for automatic capture and no 3DS', () => {
    const captures = src.match(/capture_method: '(\w+)'/g) ?? [];
    assert.ok(captures.length >= 2, 'both top-up and job payment must set it');
    for (const c of captures) assert.match(c, /automatic/);
    const auth = src.match(/authentication_type: '(\w+)'/g) ?? [];
    for (const a of auth) assert.match(a, /no_three_ds/);
  });

  test('the webhook route is registered before the JSON parser', () => {
    assert.ok(src.indexOf('/api/webhooks/hyperswitch') < src.indexOf('express.json()'),
      'signature verification needs the raw bytes');
  });

  test('completion and cancellation make no Hyperswitch call', () => {
    const section = src.slice(src.indexOf('12. complete'), src.indexOf('14. tip'));
    assert.ok(!/hs\.(createPayment|retrievePayment)/.test(section),
      'internal reallocation must not re-charge or re-retrieve');
  });

  test('the server never stores an attempt trail or connector name', () => {
    assert.ok(!/INSERT INTO payments[\s\S]{0,400}attempts/.test(src));
    assert.ok(!/INSERT INTO payments[\s\S]{0,400}connector/.test(src));
  });
});
