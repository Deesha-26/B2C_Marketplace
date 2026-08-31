/* ===========================================================================
   APPEND TO test/supabase.smoke.js
   Route-layer integration tests. Requires DATABASE_URL and express installed.
   =========================================================================== */

import { STATES as JOB } from '../server/jobs.js';
import { economics, PENALTY, WALLET_FLOOR, MIN_TOPUP } from '../server/money.js';
import { jobPaymentKey } from '../server/payments/ids.js';

/* ---- boot the real app against the disposable schema ---- */
let server, base, appDb, appFlow;

const routeUser = crypto.randomUUID();
const routeOther = crypto.randomUUID();

const api = async (method, path, body, user = routeUser) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-swoop-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
};

/**
 * Replaces the module's Hyperswitch client with the in-process fake and points
 * the app at the disposable schema. Import order matters: server/index.js opens
 * its own pool at import time, so DATABASE_URL and the search path must already
 * be set.
 */
before(async () => {
  process.env.SWOOP_AUTOSTART = 'false';
  process.env.HYPERSWITCH_SECRET_KEY ||= 'test_secret';
  process.env.HYPERSWITCH_PUBLISHABLE_KEY ||= 'pk_test_public';
  process.env.HYPERSWITCH_PROFILE_ID ||= 'pro_test';
  process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY ||= 'hash_key_test';

  const mod = await import('../server/index.js');
  appDb = mod.db;
  appFlow = mod.flow;

  // The app's own pool has no search_path, so create the objects it will use in
  // the default schema of a throwaway database, or set it here explicitly.
  await appDb.none(`SET search_path TO ${SCHEMA}`).catch(() => {});

  const fake = new FakeHyperswitch();
  appFlow.hs = fake;
  globalThis.__routeFake = fake;

  server = mod.app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const id of [routeUser, routeOther]) {
    await db.none('INSERT INTO users (id, display_email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, `${id}@route.test`]);
  }
});

after(async () => { server?.close(); });

/** Funds a wallet through the real routes. */
async function fundWallet(user = routeUser, amount = 5000, requestId = crypto.randomUUID()) {
  const start = await api('POST', '/api/wallet/topup', { amount, requestId }, user);
  const fake = globalThis.__routeFake;
  const pid = start.body.paymentId;
  // Simulate the SDK confirming in the browser.
  fake.payments.set(pid, { payment_id: pid, status: 'succeeded', amount,
    amount_received: amount, amount_capturable: 0, currency: 'USD' });
  return api('POST', `/api/wallet/topup/${requestId}/reconcile`, {}, user);
}

/** Books a job through approve → pay → reconcile, leaving it RESERVED. */
async function bookJob(user = routeUser, { emergency = false } = {}) {
  const created = await api('POST', '/api/jobs', {
    service: 'Plumbing', description: 'Kitchen tap dripping steadily',
    address: '118 Mathilda Pl', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString(),
    isEmergency: emergency,
  }, user);
  const jobId = created.body.id;
  const detail = await api('GET', `/api/jobs/${jobId}`, null, user);
  const bid = detail.body.bids[0];
  const approved = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: bid.id }, user);
  const paid = await api('POST', `/api/jobs/${jobId}/pay`,
    { approvalId: approved.body.approvalId }, user);

  const fake = globalThis.__routeFake;
  const pid = paid.body.paymentId;
  fake.payments.set(pid, { payment_id: pid, status: 'succeeded',
    amount: approved.body.breakdown.totalAmount,
    amount_received: approved.body.breakdown.totalAmount,
    amount_capturable: 0, currency: 'USD' });

  const rec = await api('POST', `/api/jobs/${jobId}/reconcile`, {}, user);
  return { jobId, bid, approval: approved.body, paymentId: pid, reconcile: rec };
}

const advanceTo = async (jobId, target, user = routeUser) => {
  for (let i = 0; i < 4; i++) {
    const d = await api('GET', `/api/jobs/${jobId}`, null, user);
    if (d.body.job.state === target) return;
    const r = await api('POST', `/api/jobs/${jobId}/advance`, {}, user);
    if (r.status !== 200) return;
  }
};

/* ========================================================== identity ===== */
describe('routes — identity', () => {
  test('a missing or malformed user header is rejected', async () => {
    for (const bad of [undefined, 'not-a-uuid', '12345']) {
      const res = await fetch(base + '/api/me', {
        headers: bad ? { 'x-swoop-user': bad } : {} });
      assert.equal(res.status, 401, String(bad));
    }
  });

  test('config exposes the publishable key and never the secret', async () => {
    const r = await api('GET', '/api/config');
    assert.equal(r.body.publishableKey, process.env.HYPERSWITCH_PUBLISHABLE_KEY);
    assert.ok(!JSON.stringify(r.body).includes(process.env.HYPERSWITCH_SECRET_KEY));
    assert.equal(r.body.settlement, 'captured_and_reserved');
  });
});

/* =========================================================== wallet ====== */
describe('routes — wallet top-up', () => {
  test('below the minimum is rejected', async () => {
    const r = await api('POST', '/api/wallet/topup',
      { amount: MIN_TOPUP - 1, requestId: crypto.randomUUID() });
    assert.equal(r.status, 400);
  });

  test('a missing requestId is rejected', async () => {
    const r = await api('POST', '/api/wallet/topup', { amount: 5000 });
    assert.equal(r.status, 400);
  });

  test('a verified top-up credits the wallet exactly once', async () => {
    const before = (await api('GET', '/api/me')).body.wallet;
    const requestId = crypto.randomUUID();
    await fundWallet(routeUser, 5000, requestId);
    const after = (await api('GET', '/api/me')).body.wallet;
    assert.equal(after, before + 5000);

    const again = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {});
    assert.equal(again.body.status, 'already_completed');
    assert.equal((await api('GET', '/api/me')).body.wallet, after);
  });

  test('repeating the same requestId never creates a second payment', async () => {
    const fake = globalThis.__routeFake;
    const requestId = crypto.randomUUID();
    const before = fake.creates;
    await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    assert.equal(fake.creates, before + 1);
  });

  test('an unconfirmed payment reconciles as pending, not discrepancy', async () => {
    const fake = globalThis.__routeFake;
    const requestId = crypto.randomUUID();
    const start = await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    fake.payments.set(start.body.paymentId, {
      payment_id: start.body.paymentId, status: 'requires_payment_method',
      amount: 5000, amount_capturable: 5000, currency: 'USD' });
    const r = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {});
    assert.equal(r.body.status, 'pending');
  });

  test('the contradictory sandbox response credits nothing', async () => {
    const fake = globalThis.__routeFake;
    const requestId = crypto.randomUUID();
    const before = (await api('GET', '/api/me')).body.wallet;
    const start = await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    fake.payments.set(start.body.paymentId, {
      payment_id: start.body.paymentId, status: 'succeeded',
      amount: 5000, amount_received: 5000, amount_capturable: 5000, currency: 'USD' });
    const r = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {});
    assert.equal(r.body.status, 'discrepancy');
    assert.equal(r.body.reason, 'amount_capturable_not_zero');
    assert.equal((await api('GET', '/api/me')).body.wallet, before);
  });

  test('another account cannot reconcile the operation', async () => {
    const requestId = crypto.randomUUID();
    await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    const r = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {}, routeOther);
    assert.equal(r.status, 403);
  });
});

/* ============================================================= jobs ====== */
describe('routes — booking', () => {
  test('booking is blocked below the wallet floor', async () => {
    const poor = crypto.randomUUID();
    await db.none('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [poor]);
    const r = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Tap is dripping badly',
      address: 'x', scheduledFor: new Date().toISOString() }, poor);
    assert.equal(r.status, 402);
  });

  test('incomplete job details are rejected', async () => {
    await fundWallet();
    const base_ = { service: 'Plumbing', description: 'Kitchen tap dripping',
      address: 'x', scheduledFor: new Date().toISOString() };
    for (const missing of ['service', 'description', 'address', 'scheduledFor']) {
      const body = { ...base_ }; delete body[missing];
      assert.equal((await api('POST', '/api/jobs', body)).status, 400, missing);
    }
  });

  test('bids arrive with bid, fee and total broken out', async () => {
    await fundWallet();
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const d = await api('GET', `/api/jobs/${created.body.id}`);
    assert.equal(d.body.bids.length, 3);
    for (const b of d.body.bids) {
      const e = economics(b.amount);
      assert.equal(b.bidAmount, e.bid);
      assert.equal(b.feeAmount, e.fee);
      assert.equal(b.totalAmount, e.charge);
      assert.equal(b.bidAmount + b.feeAmount, b.totalAmount);
    }
  });

  test('emergency jobs are priced higher', async () => {
    await fundWallet();
    const normal = await bookJob(routeUser);
    await fundWallet();
    const urgent = await bookJob(routeUser, { emergency: true });
    assert.ok(urgent.bid.amount > normal.bid.amount);
  });

  test('another account cannot read the job', async () => {
    await fundWallet();
    const { jobId } = await bookJob();
    assert.equal((await api('GET', `/api/jobs/${jobId}`, null, routeOther)).status, 404);
  });
});

/* ========================================================= approval ====== */
describe('routes — approval is not authorization', () => {
  test('approving stores the exact bid, fee and total and calls nothing external', async () => {
    await fundWallet();
    const fake = globalThis.__routeFake;
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const d = await api('GET', `/api/jobs/${created.body.id}`);
    const bid = d.body.bids[0];
    const before = fake.creates;

    const r = await api('POST', `/api/jobs/${created.body.id}/approve`, { bidId: bid.id });
    assert.equal(fake.creates, before, 'approval must not create a payment');
    const e = economics(bid.amount);
    assert.equal(r.body.breakdown.bidAmount, e.bid);
    assert.equal(r.body.breakdown.feeAmount, e.fee);
    assert.equal(r.body.breakdown.totalAmount, e.charge);

    const row = await db.one('SELECT * FROM approvals WHERE id = $1', [r.body.approvalId]);
    assert.equal(Number(row.total_amount), e.charge);
    assert.equal(Number(row.bid_amount), e.bid);
    assert.equal(Number(row.fee_amount), e.fee);
  });

  test('re-approving a different bid writes a new approval and a new operation', async () => {
    await fundWallet();
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const jobId = created.body.id;
    const d = await api('GET', `/api/jobs/${jobId}`);
    const first = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: d.body.bids[0].id });
    const second = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: d.body.bids[1].id });
    assert.notEqual(first.body.approvalId, second.body.approvalId);
    assert.notEqual(jobPaymentKey(jobId, first.body.approvalId),
                    jobPaymentKey(jobId, second.body.approvalId));
    const rows = await db.all('SELECT id FROM approvals WHERE job_id = $1', [jobId]);
    assert.equal(rows.length, 2, 'the earlier approval must not be mutated');
  });

  test('paying before approving is refused', async () => {
    await fundWallet();
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const r = await api('POST', `/api/jobs/${created.body.id}/pay`, { approvalId: 'appr_none' });
    assert.equal(r.status, 409);
  });
});

/* ========================================================= reserving ===== */
describe('routes — capture and reservation', () => {
  test('a verified capture reserves the funds and moves the job to RESERVED', async () => {
    await fundWallet();
    const walletBefore = (await api('GET', '/api/me')).body.wallet;
    const { jobId, approval, reconcile } = await bookJob();
    assert.equal(reconcile.body.status, 'verified');
    assert.equal(reconcile.body.jobState, JOB.RESERVED);
    assert.equal((await api('GET', '/api/me')).body.wallet, walletBefore,
      'a job payment charges the card, never the wallet');
    assert.equal(await ledger.balance(`JOB_RESERVED:${jobId}`), approval.breakdown.totalAmount);
  });

  test('an unverified job cannot advance, complete or cancel', async () => {
    await fundWallet();
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const jobId = created.body.id;
    for (const ep of ['advance', 'complete', 'cancel']) {
      assert.equal((await api('POST', `/api/jobs/${jobId}/${ep}`, {})).status, 409, ep);
    }
  });
});

/* ======================================================== settlement ===== */
describe('routes — completion', () => {
  test('completion allocates provider payable and platform revenue, once', async () => {
    await fundWallet();
    const { jobId, bid } = await bookJob();
    await advanceTo(jobId, JOB.IN_PROGRESS);

    const e = economics(bid.amount);
    const providerBefore = await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`);
    const platformBefore = await ledger.balance('PLATFORM_REVENUE');

    const r = await api('POST', `/api/jobs/${jobId}/complete`, {});
    assert.equal(r.body.allocation.providerPayable, e.payout);
    assert.equal(r.body.allocation.platformRevenue, e.take);
    assert.equal(r.body.externalPayout, 'simulated');
    assert.equal(await ledger.balance(`JOB_RESERVED:${jobId}`), 0);
    assert.equal(await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`),
      providerBefore + e.payout);
    assert.equal(await ledger.balance('PLATFORM_REVENUE'), platformBefore + e.take);

    const again = await api('POST', `/api/jobs/${jobId}/complete`, {});
    assert.equal(again.status, 409, 'a completed job cannot complete twice');
  });

  test('completion makes no Hyperswitch call', async () => {
    await fundWallet();
    const { jobId } = await bookJob();
    await advanceTo(jobId, JOB.IN_PROGRESS);
    const fake = globalThis.__routeFake;
    const creates = fake.creates;
    await api('POST', `/api/jobs/${jobId}/complete`, {});
    assert.equal(fake.creates, creates);
  });
});

describe('routes — cancellation', () => {
  test('pre-travel returns the full amount to the wallet', async () => {
    await fundWallet();
    const { jobId, approval, bid } = await bookJob();
    const walletBefore = (await api('GET', '/api/me')).body.wallet;

    const r = await api('POST', `/api/jobs/${jobId}/cancel`, {});
    assert.equal(r.body.tier, 'PRE_TRAVEL');
    assert.equal(r.body.retainedByProvider, 0);
    assert.equal(r.body.creditedToWallet, approval.breakdown.totalAmount);
    assert.equal((await api('GET', '/api/me')).body.wallet,
      walletBefore + approval.breakdown.totalAmount);
    assert.equal(await ledger.balance(`JOB_RESERVED:${jobId}`), 0);
  });

  test('en route or arrived: provider receives $30 and platform receives $0', async () => {
    for (const state of [JOB.EN_ROUTE, JOB.ARRIVED]) {
      await fundWallet();

      const { jobId, bid, approval } = await bookJob();
      await advanceTo(jobId, state);

      const providerBefore =
        await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`);

      const platformBefore =
        await ledger.balance('PLATFORM_REVENUE');

      const walletBefore =
        (await api('GET', '/api/me')).body.wallet;

      const r = await api(
      'POST',
      `/api/jobs/${jobId}/cancel`,
      {}
    );

    assert.equal(r.body.tier, 'EN_ROUTE', state);
    assert.equal(r.body.retainedAmount, PENALTY, state);
    assert.equal(r.body.retainedByProvider, PENALTY, state);
    assert.equal(r.body.platformRevenue, 0, state);

    assert.equal(
      await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`),
      providerBefore + PENALTY,
      state
    );

    assert.equal(
      await ledger.balance('PLATFORM_REVENUE'),
      platformBefore,
      state
    );

    assert.equal(
      (await api('GET', '/api/me')).body.wallet,
      walletBefore + approval.breakdown.totalAmount - PENALTY,
      state
    );

    assert.equal(
      await ledger.balance(`JOB_RESERVED:${jobId}`),
      0,
      state
    );
  }
});

  test('in progress: full charge is allocated with no wallet credit', async () => {
    await fundWallet();

    const { jobId, bid, approval } = await bookJob();
    await advanceTo(jobId, JOB.IN_PROGRESS);

    const e = economics(bid.amount);

    const providerBefore =
      await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`);

    const platformBefore =
      await ledger.balance('PLATFORM_REVENUE');

    const walletBefore =
      (await api('GET', '/api/me')).body.wallet;

    const r = await api(
    'POST',
    `/api/jobs/${jobId}/cancel`,
    {}
  );

  assert.equal(r.body.tier, 'IN_PROGRESS');
  assert.equal(r.body.retainedAmount, approval.breakdown.totalAmount);
  assert.equal(r.body.retainedByProvider, e.payout);
  assert.equal(r.body.creditedToWallet, 0);
  assert.equal(r.body.platformRevenue, e.take);

  assert.equal(
    await ledger.balance(`PROVIDER_PAYABLE:${bid.provider_id}`),
    providerBefore + e.payout
  );

  assert.equal(
    await ledger.balance('PLATFORM_REVENUE'),
    platformBefore + e.take
  );

  assert.equal(
    (await api('GET', '/api/me')).body.wallet,
    walletBefore
  );

  assert.equal(
    await ledger.balance(`JOB_RESERVED:${jobId}`),
    0
  );
});

  test('cancelling twice does not double-credit', async () => {
    await fundWallet();
    const { jobId } = await bookJob();
    await api('POST', `/api/jobs/${jobId}/cancel`, {});
    const wallet = (await api('GET', '/api/me')).body.wallet;
    assert.equal((await api('POST', `/api/jobs/${jobId}/cancel`, {})).status, 409);
    assert.equal((await api('GET', '/api/me')).body.wallet, wallet);
  });
});

/* ============================================================== tips ===== */
describe('routes — tips', () => {
  test('a tip moves wallet balance to provider tip payable in full', async () => {
    await fundWallet(routeUser, 10000);
    const { jobId, bid } = await bookJob();
    await advanceTo(jobId, JOB.IN_PROGRESS);
    await api('POST', `/api/jobs/${jobId}/complete`, {});

    const walletBefore = (await api('GET', '/api/me')).body.wallet;
    const tipsBefore = await ledger.balance(`PROVIDER_TIP_PAYABLE:${bid.provider_id}`);
    const platformBefore = await ledger.balance('PLATFORM_REVENUE');

    const r = await api('POST', `/api/jobs/${jobId}/tip`, { amount: 1000, tipId: 't1' });
    assert.equal(r.body.wallet, walletBefore - 1000);
    assert.equal(await ledger.balance(`PROVIDER_TIP_PAYABLE:${bid.provider_id}`), tipsBefore + 1000);
    assert.equal(await ledger.balance('PLATFORM_REVENUE'), platformBefore, 'no fee on tips');
  });

  test('the same tipId cannot be applied twice', async () => {
    await fundWallet(routeUser, 10000);
    const { jobId } = await bookJob();
    await advanceTo(jobId, JOB.IN_PROGRESS);
    await api('POST', `/api/jobs/${jobId}/complete`, {});
    await api('POST', `/api/jobs/${jobId}/tip`, { amount: 500, tipId: 'dup' });
    const wallet = (await api('GET', '/api/me')).body.wallet;
    const again = await api('POST', `/api/jobs/${jobId}/tip`, { amount: 500, tipId: 'dup' });
    assert.equal(again.body.duplicate, true);
    assert.equal((await api('GET', '/api/me')).body.wallet, wallet);
  });

  test('an incomplete job, a bad amount, or more than the wallet holds is refused', async () => {
    await fundWallet();
    const { jobId } = await bookJob();
    assert.equal((await api('POST', `/api/jobs/${jobId}/tip`,
      { amount: 100, tipId: 'x' })).status, 409);

    await advanceTo(jobId, JOB.IN_PROGRESS);
    await api('POST', `/api/jobs/${jobId}/complete`, {});
    for (const amount of [0, -100, 10.5, 'abc']) {
      assert.equal((await api('POST', `/api/jobs/${jobId}/tip`,
        { amount, tipId: crypto.randomUUID() })).status, 400, String(amount));
    }
    assert.equal((await api('POST', `/api/jobs/${jobId}/tip`,
      { amount: 99999999, tipId: 'big' })).status, 402);
  });
});

/* ====================================================== withdrawal ======= */
describe('routes — simulated withdrawal', () => {
  test('it debits the wallet, credits withdrawal payable and leaves PSP_CLEARING alone', async () => {
    await fundWallet(routeUser, 10000);
    const walletBefore = (await api('GET', '/api/me')).body.wallet;
    const pspBefore = await ledger.raw('PSP_CLEARING');
    const payableBefore = await ledger.balance(`WITHDRAWAL_PAYABLE:${routeUser}`);

    const r = await api('POST', '/api/wallet/withdraw',
      { amount: 1500, withdrawalId: 'w1' });
    assert.equal(r.body.simulated, true);
    assert.match(r.body.note, /No external card refund, payout or bank transfer/);
    assert.equal(r.body.wallet, walletBefore - 1500);
    assert.equal(await ledger.balance(`WITHDRAWAL_PAYABLE:${routeUser}`), payableBefore + 1500);
    assert.equal(await ledger.raw('PSP_CLEARING'), pspBefore, 'nothing left Swoop');
  });

  test('the same withdrawalId applies once', async () => {
    await fundWallet(routeUser, 10000);
    await api('POST', '/api/wallet/withdraw', { amount: 500, withdrawalId: 'dup' });
    const wallet = (await api('GET', '/api/me')).body.wallet;
    const again = await api('POST', '/api/wallet/withdraw', { amount: 500, withdrawalId: 'dup' });
    assert.equal(again.body.duplicate, true);
    assert.equal((await api('GET', '/api/me')).body.wallet, wallet);
  });

  test('more than the wallet holds, or a bad amount, is refused', async () => {
    assert.equal((await api('POST', '/api/wallet/withdraw',
      { amount: 99999999, withdrawalId: crypto.randomUUID() })).status, 402);
    for (const amount of [0, -1, 1.5]) {
      assert.equal((await api('POST', '/api/wallet/withdraw',
        { amount, withdrawalId: crypto.randomUUID() })).status, 400, String(amount));
    }
  });

  test('the activity feed labels simulated transactions', async () => {
    await fundWallet(routeUser, 10000);
    await api('POST', '/api/wallet/withdraw', { amount: 700, withdrawalId: crypto.randomUUID() });
    const me = await api('GET', '/api/me');
    const entry = me.body.activity.find(a => a.reason === 'WITHDRAWAL_SIMULATED');
    assert.ok(entry, 'the withdrawal must appear in wallet activity');
    assert.equal(entry.simulated, true);
    const topup = me.body.activity.find(a => a.reason === 'WALLET_TOPUP');
    assert.equal(topup.simulated, false, 'a real capture must not be labelled simulated');
  });
});

/* ========================================================= attempts ====== */
describe('routes — attempt trail', () => {
  test('the trail is served live and stored nowhere', async () => {
    await fundWallet();
    const { jobId, paymentId } = await bookJob();
    const fake = globalThis.__routeFake;
    fake.payments.set(paymentId, {
      ...fake.payments.get(paymentId),
      attempts: [
        { connector: 'paypal_test', status: 'failure', error_code: 'DC_08', attempt_id: 'a1' },
        { connector: 'stripe_test', status: 'charged', attempt_id: 'a2' },
      ],
    });

    const r = await api('GET', `/api/jobs/${jobId}/attempts`);
    assert.equal(r.body.attempts.length, 2);
    assert.equal(r.body.attempts[0].processor, 'paypal_test');
    assert.equal(r.body.attempts[0].errorCode, 'DC_08');
    assert.equal(r.body.attempts[1].processor, 'stripe_test');

    const row = await db.one('SELECT * FROM payments WHERE payment_id = $1', [paymentId]);
    assert.equal(row.attempts, undefined, 'no attempts column may exist');
    assert.ok(!JSON.stringify(row).includes('DC_08'), 'no connector error code is persisted');
    assert.ok(!JSON.stringify(row).includes('paypal_test'), 'no connector name is persisted');
  });
});

/* ========================================================= webhooks ====== */
describe('routes — webhooks', () => {
  const send = async (event, signature) => {
    const raw = JSON.stringify(event);
    const sig = signature ?? crypto
      .createHmac('sha512', process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY)
      .update(raw).digest('hex');
    const res = await fetch(base + '/api/webhooks/hyperswitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature-512': sig },
      body: raw,
    });
    let body = null; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  test('an invalid signature is rejected', async () => {
    const r = await send({ event_id: crypto.randomUUID(), event_type: 'payment_succeeded' }, 'deadbeef');
    assert.equal(r.status, 401);
  });

  test('a missing event_id is rejected', async () => {
    const r = await send({ event_type: 'payment_succeeded' });
    assert.equal(r.status, 400);
  });

  test('a webhook settles an unreconciled payment exactly once', async () => {
    await fundWallet();
    const fake = globalThis.__routeFake;
    const requestId = crypto.randomUUID();
    const start = await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    const pid = start.body.paymentId;
    fake.payments.set(pid, { payment_id: pid, status: 'succeeded', amount: 5000,
      amount_received: 5000, amount_capturable: 0, currency: 'USD' });

    const before = (await api('GET', '/api/me')).body.wallet;
    const eventId = crypto.randomUUID();
    const event = { event_id: eventId, event_type: 'payment_succeeded',
      content: { object: { payment_id: pid, status: 'succeeded' } } };

    const first = await send(event);
    assert.equal(first.status, 200);
    assert.equal((await api('GET', '/api/me')).body.wallet, before + 5000);

    const duplicate = await send(event);
    assert.match(JSON.stringify(duplicate.body), /duplicate/);
    assert.equal((await api('GET', '/api/me')).body.wallet, before + 5000);
  });

  test('a webhook and a client reconcile cannot both post', async () => {
    await fundWallet();
    const fake = globalThis.__routeFake;
    const requestId = crypto.randomUUID();
    const start = await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    const pid = start.body.paymentId;
    fake.payments.set(pid, { payment_id: pid, status: 'succeeded', amount: 5000,
      amount_received: 5000, amount_capturable: 0, currency: 'USD' });

    const before = (await api('GET', '/api/me')).body.wallet;
    await send({ event_id: crypto.randomUUID(), event_type: 'payment_succeeded',
      content: { object: { payment_id: pid, status: 'succeeded' } } });
    await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {});
    assert.equal((await api('GET', '/api/me')).body.wallet, before + 5000);
  });

  test('an unknown payment is acknowledged without effect', async () => {
    const r = await send({ event_id: crypto.randomUUID(), event_type: 'payment_succeeded',
      content: { object: { payment_id: 'pay_unknown_xyz' } } });
    assert.equal(r.status, 200);
  });
});

/* ======================================================== invariants ===== */
describe('routes — global invariants', () => {
  test('the books balance after every route exercised above', async () => {
    assert.deepEqual(await ledger.findUnbalancedTransactions(), []);
    await ledger.assertGloballyBalanced();
  });

  test('no reserved balance is left on a terminal job', async () => {
    const rows = await db.all(
      `SELECT j.id FROM jobs j
       WHERE j.state IN (
  'COMPLETED',
  'CANCELLED_PRE_TRAVEL',
  'CANCELLED_EN_ROUTE',
  'CANCELLED_IN_PROGRESS'
)`);
    for (const { id } of rows) {
      assert.equal(await ledger.balance(`JOB_RESERVED:${id}`), 0, id);
    }
  });

  test('no response ever contained the secret key', async () => {
    const paths = ['/api/config', '/api/me'];
    for (const p of paths) {
      const r = await api('GET', p);
      assert.ok(!JSON.stringify(r.body).includes(process.env.HYPERSWITCH_SECRET_KEY), p);
    }
  });
});
