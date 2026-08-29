/**
 * SUPABASE INTEGRATION TESTS — require a real PostgreSQL database.
 *
 *   DATABASE_URL='postgresql://...pooler.supabase.com:6543/postgres' npm run test:supabase
 *
 * Covers what cannot be proven without Postgres: concurrent claims, atomicity of
 * completion with its ledger posting, the real 23505 path, and PaymentFlow end
 * to end against a fake Hyperswitch.
 *
 * Runs in a disposable schema. Transaction pooling means a session-level
 * `SET search_path` would not survive, so the driver issues `SET LOCAL` inside
 * every transaction and routes single statements through one.
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
  admin = await createPostgres(URL_, { migrate: false });
  await admin.none(`CREATE SCHEMA ${SCHEMA}`);
  const ddl = fs.readFileSync(path.join(dir, '..', 'server', 'db', 'schema.sql'), 'utf8');
  await admin.transaction(async t => {
    await t.none(`SET LOCAL search_path TO ${SCHEMA}`);
    await t.none(ddl);
  });
  db = await createPostgres(URL_, { migrate: false, searchPath: SCHEMA });
  ledger = new Ledger(db);
  for (const id of [USER, OTHER]) {
    await db.none('INSERT INTO users (id, display_email) VALUES ($1,$2)', [id, `${id}@x.test`]);
  }
});

after(async () => {
  await db?.close();
  await admin?.none(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await admin?.close();
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

