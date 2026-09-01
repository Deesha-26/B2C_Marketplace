/**
 * SUPABASE INTEGRATION TESTS — require a real PostgreSQL database.
 *
 *   DATABASE_URL='postgresql://...pooler.supabase.com:6543/postgres' npm run test:supabase
 *
 * Covers what cannot be proven without Postgres: concurrent claims, atomicity of
 * completion with its ledger posting, the real 23505 path, and PaymentFlow end
 * to end against a fake Hyperswitch.
 *
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { createPostgres } from '../server/db/postgres.js';
import { isUniqueViolation } from '../server/db/index.js';
import { Ledger, walletTopUp } from '../server/ledger/index.js';
import * as ops from '../server/payments/operations.js';
import { PaymentFlow } from '../server/payments/flow.js';
import { derivePaymentId, walletTopUpKey, jobPaymentKey } from '../server/payments/ids.js';
import { STATES as JOB } from '../server/jobs.js';
import {
  economics,
  PENALTY,
  WALLET_FLOOR,
  MIN_TOPUP,
} from '../server/money.js';

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error('\nDATABASE_URL is not set. These tests require a live database.\n');
  process.exit(1);
}

const SCHEMA = `swoop_test_${crypto.randomBytes(4).toString('hex')}`;
const dir = path.dirname(fileURLToPath(import.meta.url));
const AMOUNT = 9675, CURRENCY = 'USD';
const USER = crypto.randomUUID(), OTHER = crypto.randomUUID();

let admin, db, ledger;

/* ---------------- fake Hyperswitch ---------------- */
class FakeHyperswitch {
  constructor() { this.payments = new Map(); this.creates = 0; this.mode = 'ok'; }
  async createPayment(body) {
    this.creates++;
    if (this.mode === 'throw') throw new Error('network reset');
    if (this.mode === 'silent') return { payment_id: body.payment_id };  // created, no record kept
    const p = { payment_id: body.payment_id, status: 'succeeded',
      amount: body.amount, amount_received: body.amount, amount_capturable: 0,
      currency: body.currency };
    if (this.mode === 'contradictory') p.amount_capturable = body.amount;
    this.payments.set(body.payment_id, p);
    return p;
  }
  async retrievePayment(id) {
    const p = this.payments.get(id);
    if (!p) { const e = new Error('not found'); e.status = 404; throw e; }
    return p;
  }
}
const buildRequest = (amount, currency = CURRENCY) => paymentId =>
  ({ payment_id: paymentId, amount, currency, capture_method: 'automatic' });

before(async () => {
  // Create the disposable schema used by both direct persistence tests and
  // HTTP route tests.
  admin = await createPostgres(URL_, { migrate: false });

  await admin.none(`CREATE SCHEMA ${SCHEMA}`);

  const ddl = fs.readFileSync(
    path.join(dir, '..', 'server', 'db', 'schema.sql'),
    'utf8'
  );

  await admin.transaction(async t => {
    await t.none(`SET LOCAL search_path TO ${SCHEMA}`);
    await t.none(ddl);
  });

  db = await createPostgres(URL_, {
    migrate: false,
    searchPath: SCHEMA,
  });

  ledger = new Ledger(db);

  for (const id of [USER, OTHER]) {
    await db.none(
      `INSERT INTO users (id, display_email)
       VALUES ($1,$2)`,
      [id, `${id}@x.test`]
    );
  }

  // Configure the real Express application to use the same disposable schema
  // before importing it. server/index.js opens its database at import time.
  process.env.SWOOP_AUTOSTART = 'false';
  process.env.DB_MIGRATE = 'false';
  process.env.DB_SEARCH_PATH = SCHEMA;
  process.env.HYPERSWITCH_SECRET_KEY ||= 'test_secret';
  process.env.HYPERSWITCH_PUBLISHABLE_KEY ||= 'pk_test_public';
  process.env.HYPERSWITCH_PROFILE_ID ||= 'pro_test';
  process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY ||= 'hash_key_test';

  const mod = await import('../server/index.js');

  appDb = mod.db;
  appFlow = mod.flow;

  const fake = new FakeHyperswitch();
  appFlow.hs = fake;
  globalThis.__routeFake = fake;

  server = mod.app.listen(0);

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  base = `http://127.0.0.1:${server.address().port}`;

  for (const id of [routeUser, routeOther]) {
    await appDb.none(
      `INSERT INTO users (id, display_email)
       VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [id, `${id}@route.test`]
    );
  }
});

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  await appDb?.close();
  await db?.close();

  await admin
    ?.none(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    .catch(() => {});

  await admin?.close();

  delete process.env.DB_SEARCH_PATH;
  delete process.env.DB_MIGRATE;
});

const key = n => walletTopUpKey(USER, `req_${n}`);
const intentFor = (k, over = {}) => ({
  operationKey: k, kind: 'wallet_topup', userId: USER, purpose: 'wallet_topup',
  amount: AMOUNT, currency: CURRENCY, ...over,
});
const claimArgs = (k, over = {}) => ({
  operationKey: k, kind: 'wallet_topup', paymentId: derivePaymentId(k),
  userId: USER, purpose: 'wallet_topup', expectedAmount: AMOUNT, currency: CURRENCY, ...over,
});

const seedVerifiedPayment = (paymentId, amount) =>
  db.none(
    `INSERT INTO payments
       (payment_id, user_id, job_id, approval_id, purpose,
        approved_amount, currency, last_observed_external_status,
        reconciliation_state, last_reconciled_at)
     VALUES ($1, $2, NULL, NULL, 'wallet_topup',
             $3, $4, 'succeeded', 'verified', now())`,
    [paymentId, USER, amount, CURRENCY]
  );

/* ================= claiming ================= */
describe('operation claiming', () => {
  test('five concurrent claims produce exactly one owner', async () => {
    const k = key('concurrent');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ops.claim(db, claimArgs(k))));
    assert.equal(results.filter(r => r.owner).length, 1,
      'exactly one request may call Hyperswitch');
    for (const r of results) assert.ok(r.operation);
  });

  test('a retry reuses the same deterministic payment id', async () => {
    const k = key('retry');
    const a = await ops.claim(db, claimArgs(k));
    const b = await ops.claim(db, claimArgs(k));
    assert.equal(a.owner, true);
    assert.equal(b.owner, false);
    assert.equal(b.operation.payment_id, derivePaymentId(k));
  });

  test('two intentional top-ups are separate operations', async () => {
    const a = await ops.claim(db, claimArgs(key('t1')));
    const b = await ops.claim(db, claimArgs(key('t2')));
    assert.ok(a.owner && b.owner);
    assert.notEqual(a.operation.payment_id, b.operation.payment_id);
  });

  test('the operation persists the full intent, not just the amount', async () => {
    const k = jobPaymentKey('job_x', 'appr_x');
    await db.none(`INSERT INTO jobs (id,user_id,service,description,address,scheduled_for,state)
                   VALUES ($1,$2,'Plumbing','tap','addr',now(),'OPEN_FOR_BIDS')`, ['job_x', USER]);
    await ops.claim(db, claimArgs(k, {
      kind: 'job_payment', purpose: 'job_payment', jobId: 'job_x', expectedAmount: 3000 }));
    const row = await ops.get(db, k);
    assert.equal(row.user_id, USER);
    assert.equal(row.purpose, 'job_payment');
    assert.equal(row.job_id, 'job_x');
    assert.equal(Number(row.expected_amount), 3000);
  });
});

/* ================= PaymentFlow ================= */
describe('PaymentFlow end to end', () => {
  test('a clean capture verifies and posts exactly once', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_clean');
    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);

    const r = await flow.run(intentFor(k), buildRequest(AMOUNT));
    assert.equal(r.status, 'verified');
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before + AMOUNT);
    const op = await ops.get(db, k);
    assert.equal(op.state, ops.STATES.COMPLETED);
    const pay = await db.one('SELECT * FROM payments WHERE payment_id = $1', [r.paymentId]);
    assert.equal(pay.reconciliation_state, 'verified');
  });

  test('a duplicate reconciliation posts nothing twice', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_dup');
    await flow.run(intentFor(k), buildRequest(AMOUNT));
    const after = await ledger.balance(`CUSTOMER_WALLET:${USER}`);

    const again = await flow.run(intentFor(k), buildRequest(AMOUNT));
    assert.equal(again.status, 'already_completed');
    const rec = await flow.reconcile({ operationKey: k, requestingUserId: USER });
    assert.equal(rec.status, 'already_completed');
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), after);
    assert.equal(hs.creates, 1, 'no second external payment');
  });

  test('the contradictory sandbox response becomes a discrepancy with no posting', async () => {
    const hs = new FakeHyperswitch(); hs.mode = 'contradictory';
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_bad');
    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);

    const r = await flow.run(intentFor(k), buildRequest(AMOUNT));
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.reason, 'amount_capturable_not_zero');
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before,
      'a contradictory response must move no money');
    const pay = await db.one('SELECT * FROM payments WHERE payment_id = $1', [r.paymentId]);
    assert.equal(pay.reconciliation_state, 'discrepancy');
    assert.ok(pay.discrepancy_reason);
  });

  test('a wrong amount is refused even though the status says succeeded', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_amount');
    // Operation intends AMOUNT; the gateway is asked for less.
    const r = await flow.run(intentFor(k), buildRequest(5000));
    assert.equal(r.status, 'discrepancy');
    assert.equal(r.reason, 'amount_received_mismatch');
  });

  test('crash after external success recovers without a second charge', async () => {
    const hs = new FakeHyperswitch();
    const k = key('flow_crash');
    const pid = derivePaymentId(k);

    // Simulate: claimed, called, payment created — then the process died.
    await ops.claim(db, claimArgs(k));
    await ops.transition(db, k, ops.STATES.EXTERNAL_PENDING);
    await hs.createPayment(buildRequest(AMOUNT)(pid));
    await ops.transition(db, k, ops.STATES.RECONCILIATION_PENDING);
    assert.equal(hs.creates, 1);

    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);
    const r = await flow.reconcile({ operationKey: k, requestingUserId: USER,
                                     buildRequest: buildRequest(AMOUNT) });
    assert.equal(r.status, 'verified');
    assert.equal(hs.creates, 1, 'recovery must retrieve, never re-create');
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before + AMOUNT);
  });

  test('an uncertain retrieval stays pending and never re-creates', async () => {
    const hs = new FakeHyperswitch();
    hs.retrievePayment = async () => { const e = new Error('gateway timeout'); e.status = 504; throw e; };
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_uncertain');

    const r = await flow.run(intentFor(k), buildRequest(AMOUNT));
    assert.equal(r.status, 'pending');
    const op = await ops.get(db, k);
    assert.ok(ops.RECOVERABLE.has(op.state), 'must remain recoverable, never failed');
    assert.equal(hs.creates, 1, 'uncertainty must not trigger another create');
  });

  test('repeated confirmed absence exhausts bounded retries', async () => {
    const hs = new FakeHyperswitch();
    hs.mode = 'silent';                       // create returns but stores nothing → 404
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_absent');
    const pid = derivePaymentId(k);

    const first = await flow.run(intentFor(k), buildRequest(AMOUNT));
    assert.equal(first.status, 'discrepancy', 'bounded retries end deterministically');
    assert.equal(first.reason, 'exhausted create attempts');
    const op = await ops.get(db, k);
    assert.equal(op.payment_id, pid, 'every attempt reused one deterministic id');
    assert.ok(op.create_attempts >= ops.MAX_CREATE_ATTEMPTS);
  });

  test('a confirmed-absent payment that then succeeds completes normally', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_absent_ok');

    // Claimed and moved past create, but nothing exists at the gateway yet.
    await ops.claim(db, claimArgs(k));
    await ops.transition(db, k, ops.STATES.EXTERNAL_PENDING);
    await ops.transition(db, k, ops.STATES.RECONCILIATION_PENDING);

    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);
    const r = await flow.reconcile({ operationKey: k, requestingUserId: USER,
                                     buildRequest: buildRequest(AMOUNT) });
    assert.equal(r.status, 'verified', 'confirmed absence permits one safe recreation');
    assert.equal(hs.creates, 1);
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before + AMOUNT);
  });

  test('another user cannot reconcile someone else\u2019s operation', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_owner');
    await flow.run(intentFor(k), buildRequest(AMOUNT));

    const r = await flow.reconcile({ operationKey: k, requestingUserId: OTHER });
    assert.equal(r.status, 'forbidden');
  });

  test('expectations come from the operation, not the caller', async () => {
    const hs = new FakeHyperswitch();
    const flow = new PaymentFlow(db, hs, { log: { error() {} } });
    const k = key('flow_intent');
    await flow.run(intentFor(k), buildRequest(AMOUNT));
    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);

    // A later caller claiming a different amount must not change what was applied.
    const r = await flow.run(intentFor(k, { amount: 1 }), buildRequest(1));
    assert.equal(r.status, 'already_completed');
    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before);
  });
});

/* ================= ledger ================= */
describe('ledger idempotency against real Postgres', () => {
  test('a duplicate posting applies once', async () => {
    const pid = derivePaymentId(key('post_dup'));
    await seedVerifiedPayment(pid, 2500);

    const posting = () =>
      walletTopUp({ userId: USER, amount: 2500, paymentId: pid });

    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);
    const first = await ledger.post(posting());
    const second = await ledger.post(posting());

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(
      await ledger.balance(`CUSTOMER_WALLET:${USER}`),
      before + 2500
    );
  });

  test('concurrent identical postings apply once', async () => {
    const pid = derivePaymentId(key('post_conc'));
    await seedVerifiedPayment(pid, 1000);

    const posting = () =>
      walletTopUp({ userId: USER, amount: 1000, paymentId: pid });

    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);

    const results = await Promise.all([
      ledger.post(posting()),
      ledger.post(posting()),
      ledger.post(posting()),
    ]);

    assert.equal(results.filter(r => r.duplicate === false).length, 1);
    assert.equal(results.filter(r => r.duplicate === true).length, 2);
    assert.equal(
      await ledger.balance(`CUSTOMER_WALLET:${USER}`),
      before + 1000
    );
  });

  test('an unrelated constraint failure is not swallowed as a duplicate', async () => {
    await assert.rejects(
      () => ledger.post({
        reason: 'BAD_FK', idempotencyKey: `fk_${Date.now()}`,
        userId: crypto.randomUUID(),                 // no such user
        entries: [{ account: 'A', direction: 'debit', amount: 100 },
                  { account: 'B', direction: 'credit', amount: 100 }],
      }),
      err => !isUniqueViolation(err, 'ledger_transactions_idempotency_key_uniq'));
  });

  test('every transaction balances and the books are globally balanced', async () => {
    assert.deepEqual(await ledger.findUnbalancedTransactions(), []);
    await ledger.assertGloballyBalanced();
  });
});

/* ================= atomicity ================= */
describe('atomicity', () => {
  test('a failure inside the transaction leaves neither effect', async () => {
    const k = key('atomic');
    const pid = derivePaymentId(k);
    await seedVerifiedPayment(pid, 4444);
    await ops.claim(db, claimArgs(k));
    await ops.transition(db, k, ops.STATES.EXTERNAL_PENDING);
    await ops.transition(db, k, ops.STATES.RECONCILIATION_PENDING);

    const before = await ledger.balance(`CUSTOMER_WALLET:${USER}`);
    await assert.rejects(
      () =>
        db.transaction(async t => {
          await new Ledger(t).post(
            walletTopUp({ userId: USER, amount: 4444, paymentId: pid }),
            t
          );

          await ops.transition(t, k, ops.STATES.COMPLETED);
          throw new Error('simulated crash before commit');
        }),
      /simulated crash before commit/
    );

    assert.equal(await ledger.balance(`CUSTOMER_WALLET:${USER}`), before);
    const op = await ops.get(db, k);
    assert.notEqual(op.state, ops.STATES.COMPLETED);
    assert.ok(ops.RECOVERABLE.has(op.state));
  });
});

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

  test('another account cannot access the operation', async () => {
    const requestId = crypto.randomUUID();
    await api('POST', '/api/wallet/topup', { amount: 5000, requestId });
    const r = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {}, routeOther);
    assert.equal(r.status, 404);
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

  test('repeating the same approval is idempotent and a different bid is refused', async () => {
    await fundWallet();
    const created = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString() });
    const jobId = created.body.id;
    const d = await api('GET', `/api/jobs/${jobId}`);
    const first = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: d.body.bids[0].id });
    const repeat = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: d.body.bids[0].id });
    const second = await api('POST', `/api/jobs/${jobId}/approve`, { bidId: d.body.bids[1].id });
    assert.equal(repeat.body.approvalId, first.body.approvalId);
    assert.equal(repeat.body.alreadyApproved, true);
    assert.equal(second.status, 409);
    const rows = await db.all('SELECT id FROM approvals WHERE job_id = $1', [jobId]);
    assert.equal(rows.length, 1, 'a job has exactly one chargeable approval');
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
