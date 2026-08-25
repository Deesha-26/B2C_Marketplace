import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { open } from '../server/db.js';
import { economics, PENALTY } from '../server/money.js';
import {
  Ledger, debit, credit, GATEWAY_SETTLED, AUTH_RECEIVABLE, ESCROW,
  PLATFORM_REVENUE, PROVIDER_CLAWBACK, customerWallet, providerWallet,
} from '../server/ledger.js';
import { assess, LEVELS } from '../server/intelligence/risk.js';
import { authorizeRequest, topupRequest, needsExtension } from '../server/intelligence/strategy.js';
import { planCancellation, planCompletion, cancelTier } from '../server/intelligence/settlement.js';
import { verifySignature, claimEvent, isRegression, apply } from '../server/webhooks.js';
import crypto from 'node:crypto';

const U = 'usr_1', P = 'prov_1';
const fresh = () => { const db = open(':memory:'); return { db, l: new Ledger(db) }; };
const seedUser = db => db.prepare(
  'INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)')
  .run(U, 'a@b.com', 'Alex', new Date().toISOString());

describe('fee model', () => {
  test('fees sit on top of the bid', () => {
    const e = economics(9000);
    assert.equal(e.charge, 9675);
    assert.equal(e.fee, 675);
    assert.equal(e.payout, 7650);
    assert.equal(e.take, 2025);
  });
  test('platform take absorbs rounding for every bid up to $500', () => {
    for (let b = 1; b <= 50000; b++) {
      const e = economics(b);
      assert.equal(e.payout + e.take, e.charge, `imbalance at ${b}`);
    }
  });
});

describe('ledger', () => {
  test('balances persist and reconcile', () => {
    const { db, l } = fresh(); seedUser(db);
    l.post({ userId: U, reason: 'TOPUP', gatewayRef: 'pay_1',
      entries: [debit(GATEWAY_SETTLED, 5000), credit(customerWallet(U), 5000)] });
    assert.equal(l.walletOf(U), 5000);
    l.assertBalanced();
  });
  test('unbalanced postings are refused', () => {
    const { l } = fresh();
    assert.throws(() => l.post({ reason: 'BAD', entries: [debit(ESCROW, 100)] }), /does not balance/);
  });
  test('empty wallet reads as 0, never -0', () => {
    const { l } = fresh();
    assert.equal(Object.is(l.walletOf('nobody'), 0), true, 'negative zero breaks equality checks');
  });
  test('a clawback can drive a provider wallet negative', () => {
    const { db, l } = fresh(); seedUser(db);
    l.post({ userId: U, reason: 'PENALTY',
      entries: [debit(providerWallet(P), PENALTY), credit(customerWallet(U), PENALTY)] });
    assert.equal(l.providerBalance(P), -PENALTY);
    l.assertBalanced();
  });
});

describe('risk', () => {
  const soon = () => ({ scheduled_for: new Date(Date.now() + 2 * 3.6e6).toISOString() });
  const later = () => ({ scheduled_for: new Date(Date.now() + 48 * 3.6e6).toISOString() });

  test('a small job today for a repeat customer is low risk', () => {
    const r = assess({ job: soon(), amount: 9675, history: { completedJobs: 5 } });
    assert.equal(r.level, LEVELS.LOW);
    assert.equal(r.needsExtendedAuth, false, 'no point extending a hold for today');
    assert.equal(r.require3ds, false);
  });
  test('a job two days out asks for extended authorization', () => {
    const r = assess({ job: later(), amount: 9675, history: { completedJobs: 5 } });
    assert.equal(r.needsExtendedAuth, true);
  });
  test('a prior dispute pushes a customer to high risk', () => {
    const r = assess({ job: later(), amount: 60000, history: { disputesRaised: 1 } });
    assert.equal(r.level, LEVELS.HIGH);
    assert.equal(r.require3ds, true);
  });
});

describe('payment strategy', () => {
  const user = { id: U };
  const job = { id: 'job_1', service: 'Plumbing', scheduled_for: new Date(Date.now() + 48 * 3.6e6).toISOString() };
  const bid = { amount: 9000, trade: 'Ganesan Plumbing' };

  test('job authorization is manual capture for the exact bid plus fee', () => {
    const risk = assess({ job, amount: 9675, history: {} });
    const { request, economics: e } = authorizeRequest({ user, job, bid, risk });
    assert.equal(request.capture_method, 'manual');
    assert.equal(request.amount, 9675);
    assert.equal(e.bid, 9000);
    assert.equal(request.customer_id, U);
  });
  test('extended authorization rides on the risk signal, not a constant', () => {
    const far = assess({ job, amount: 9675, history: {} });
    const near = assess({ job: { scheduled_for: new Date(Date.now() + 3.6e6).toISOString() }, amount: 9675, history: {} });
    assert.equal(authorizeRequest({ user, job, bid, risk: far }).request.request_extended_authorization, true);
    assert.equal(authorizeRequest({ user, job, bid, risk: near }).request.request_extended_authorization, false);
  });
  test('no request ever names a connector', () => {
    const risk = assess({ job, amount: 9675, history: {} });
    const bodies = [
      JSON.stringify(authorizeRequest({ user, job, bid, risk }).request),
      JSON.stringify(topupRequest({ user, amount: 5000, saveCard: true })),
    ];
    for (const b of bodies) {
      assert.ok(!/connector|routing|merchant_connector_id/i.test(b), 'routing is Hyperswitch\u2019s job');
    }
  });
  test('save-card only vaults when the box is ticked', () => {
    assert.equal(topupRequest({ user, amount: 5000, saveCard: false }).setup_future_usage, undefined);
    assert.equal(topupRequest({ user, amount: 5000, saveCard: true }).setup_future_usage, 'off_session');
  });
  test('top-up takes the money immediately', () => {
    assert.equal(topupRequest({ user, amount: 5000 }).capture_method, 'automatic');
  });
});

describe('extended authorization watchdog', () => {
  const p = (status, hoursLeft) => ({
    status, capture_by: new Date(Date.now() + hoursLeft * 3.6e6).toISOString(),
  });
  test('extends only when the deadline is close', () => {
    assert.equal(needsExtension(p('requires_capture', 2)), true);
    assert.equal(needsExtension(p('requires_capture', 40)), false);
  });
  test('never extends a payment that is already captured', () => {
    assert.equal(needsExtension(p('succeeded', 1)), false);
  });
  test('a payment with no deadline is left alone', () => {
    assert.equal(needsExtension({ status: 'requires_capture', capture_by: null }), false);
  });
});

describe('settlement tiers', () => {
  test('arrived settles like in progress, not like en route', () => {
    assert.equal(cancelTier('ARRIVED'), 'FULL_CAPTURE');
    assert.equal(cancelTier('IN_PROGRESS'), 'FULL_CAPTURE');
    assert.equal(cancelTier('EN_ROUTE'), 'PARTIAL_CAPTURE');
    assert.equal(cancelTier('SCHEDULED'), 'VOID');
  });
  test('pre-en-route voids and charges nothing', () => {
    const p = planCancellation('SCHEDULED', 9000);
    assert.equal(p.operation, 'void');
    assert.equal(p.charged, 0);
    assert.equal(p.released, 9675);
  });
  test('en route captures exactly $30 with no platform fee', () => {
    const p = planCancellation('EN_ROUTE', 9000);
    assert.equal(p.captureAmount, 3000);
    assert.equal(p.toProvider, 3000);
    assert.equal(p.toPlatform, 0, 'travel compensation is not a payout');
    assert.equal(p.released, 6675);
  });
  test('in progress captures in full and splits normally', () => {
    const p = planCancellation('IN_PROGRESS', 9000);
    assert.equal(p.charged, 9675);
    assert.equal(p.toProvider + p.toPlatform, 9675);
  });
  test('completion and in-progress cancellation settle identically', () => {
    const a = planCompletion(9000), b = planCancellation('IN_PROGRESS', 9000);
    assert.equal(a.toProvider, b.toProvider);
    assert.equal(a.toPlatform, b.toPlatform);
  });
  test('a completed job cannot be cancelled', () => {
    assert.equal(planCancellation('COMPLETED', 9000), null);
  });
});

describe('webhook safety', () => {
  const secret = 'hash_key_abc';
  const body = JSON.stringify({ event_type: 'payment_succeeded' });
  const sign = b => crypto.createHmac('sha512', secret).update(b).digest('hex');

  test('a valid signature passes', () => {
    assert.equal(verifySignature(body, sign(body), secret), true);
  });
  test('a tampered body fails', () => {
    assert.equal(verifySignature(body + ' ', sign(body), secret), false);
  });
  test('a missing signature fails rather than throwing', () => {
    assert.equal(verifySignature(body, null, secret), false);
  });
  test('an unset hash key is a hard error, not a silent pass', () => {
    assert.throws(() => verifySignature(body, sign(body), ''), /HASH_KEY/);
  });
  test('a duplicate event is claimed once', () => {
    const { db } = fresh();
    assert.equal(claimEvent(db, 'evt_1', 'payment_succeeded', 'pay_1'), true);
    assert.equal(claimEvent(db, 'evt_1', 'payment_succeeded', 'pay_1'), false);
  });
  test('a late event cannot resurrect a terminal payment', () => {
    assert.equal(isRegression('cancelled', 'succeeded'), true);
    assert.equal(isRegression('requires_capture', 'succeeded'), false);
  });
  test('replayed deliveries post to the ledger exactly once', () => {
    const { db, l } = fresh(); seedUser(db);
    for (let i = 0; i < 5; i++) {
      if (claimEvent(db, 'evt_topup', 'payment_succeeded', 'pay_1')) {
        l.post({ userId: U, reason: 'TOPUP', gatewayRef: 'pay_1',
          entries: [debit(GATEWAY_SETTLED, 5000), credit(customerWallet(U), 5000)] });
      }
    }
    assert.equal(l.walletOf(U), 5000);
    l.assertBalanced();
  });
  test('an unhandled event type is ignored', () => {
    const { db } = fresh();
    assert.equal(apply(db, { event_type: 'mandate_active', content: { object: {} } }), null);
  });
});

describe('end-to-end money movement', () => {
  test('a full job lifecycle leaves the books balanced and escrow empty', () => {
    const { db, l } = fresh(); seedUser(db);
    const e = economics(9733);   // awkward amount, forces rounding both ways

    l.post({ userId: U, jobId: 'job_1', reason: 'AUTHORIZED', gatewayRef: 'pay_2',
      entries: [debit(AUTH_RECEIVABLE, e.charge), credit(ESCROW, e.charge)] });
    l.post({ userId: U, jobId: 'job_1', reason: 'CAPTURED', gatewayRef: 'pay_2',
      entries: [debit(GATEWAY_SETTLED, e.charge), credit(AUTH_RECEIVABLE, e.charge)] });
    l.post({ userId: U, jobId: 'job_1', reason: 'RELEASED', gatewayRef: 'pay_2',
      entries: [debit(ESCROW, e.charge), credit(providerWallet(P), e.payout),
                credit(PLATFORM_REVENUE, e.take)] });

    assert.equal(l.raw(ESCROW), 0);
    assert.equal(l.raw(AUTH_RECEIVABLE), 0);
    assert.equal(l.providerBalance(P), e.payout);
    assert.equal(l.balance(PLATFORM_REVENUE), e.take);
    assert.equal(l.providerBalance(P) + l.balance(PLATFORM_REVENUE), l.raw(GATEWAY_SETTLED));
    l.assertBalanced();
  });

  test('an en-route cancellation settles $30 and releases the rest', () => {
    const { db, l } = fresh(); seedUser(db);
    const plan = planCancellation('EN_ROUTE', 9000);
    const e = plan.economics;

    l.post({ userId: U, jobId: 'job_1', reason: 'AUTHORIZED',
      entries: [debit(AUTH_RECEIVABLE, e.charge), credit(ESCROW, e.charge)] });
    l.post({ userId: U, jobId: 'job_1', reason: 'PARTIAL_CAPTURE',
      entries: [debit(GATEWAY_SETTLED, plan.charged), credit(AUTH_RECEIVABLE, plan.charged)] });
    l.post({ userId: U, jobId: 'job_1', reason: 'VOID_REMAINDER',
      entries: [debit(ESCROW, plan.released), credit(AUTH_RECEIVABLE, plan.released)] });
    l.post({ userId: U, jobId: 'job_1', reason: 'COMPENSATE',
      entries: [debit(ESCROW, plan.charged), credit(providerWallet(P), plan.toProvider)] });

    assert.equal(l.raw(ESCROW), 0);
    assert.equal(l.raw(AUTH_RECEIVABLE), 0);
    assert.equal(l.providerBalance(P), 3000);
    assert.equal(l.raw(GATEWAY_SETTLED), 3000, 'only the trip fee ever became money');
    l.assertBalanced();
  });
});
