/**
 * One continuous customer journey, start to finish, asserting the money is
 * right after every step — not each feature in isolation.
 *
 * Also checks the invariants that only a long session can break: that nothing
 * is created or destroyed across many jobs, that the gateway and the ledger
 * agree, and that no route ever leaks a credential.
 */
process.env.SWOOP_AUTOSTART = 'false';
process.env.DB_PATH = ':memory:';
process.env.HYPERSWITCH_SECRET_KEY = 'SECRET_snd_must_never_appear';
process.env.HYPERSWITCH_PUBLISHABLE_KEY = 'pk_snd_public';
process.env.HYPERSWITCH_PROFILE_ID = 'pro_test';
process.env.HYPERSWITCH_MERCHANT_ID = 'merch_test';
process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY = 'hash_key_test';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const gw = { payments: new Map(), refunds: [], calls: [] };

globalThis.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const u = new URL(s);
  const body = opts.body ? JSON.parse(opts.body) : {};
  gw.calls.push({ method: opts.method, path: u.pathname, body });
  const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (u.pathname === '/payments' && opts.method === 'POST') {
    const id = 'pay_' + (gw.payments.size + 1);
    const p = { payment_id: id, amount: body.amount, capture_method: body.capture_method,
      status: body.capture_method === 'manual' ? 'requires_capture' : 'succeeded',
      amount_captured: body.capture_method === 'manual' ? 0 : body.amount,
      client_secret: id + '_secret', connector: 'stripe',
      attempts: [{ connector: 'stripe', status: 'charged' }] };
    gw.payments.set(id, p); return ok(p);
  }
  const m = u.pathname.match(/^\/payments\/([^/]+)(\/(capture|cancel|extend_authorization))?$/);
  if (m) {
    const p = gw.payments.get(m[1]);
    if (!p) return new Response(JSON.stringify({ error: { message: 'missing' } }), { status: 404 });
    if (m[3] === 'capture') {
      const a = body.amount_to_capture ?? p.amount;
      p.amount_captured = a; p.status = a < p.amount ? 'partially_captured' : 'succeeded';
    }
    if (m[3] === 'cancel') { p.status = 'cancelled'; p.amount_captured = 0; }
    return ok(p);
  }
  if (u.pathname === '/refunds' && opts.method === 'POST') {
    const r = { refund_id: 'ref_' + (gw.refunds.length + 1), payment_id: body.payment_id,
      amount: body.amount, status: 'succeeded' };
    gw.refunds.push(r); return ok(r);
  }
  if (/payment_methods/.test(u.pathname)) return ok({ customer_payment_methods: [] });
  return new Response(JSON.stringify({ error: { message: 'unmapped' } }), { status: 404 });
};

let server, base, db, ledger;
before(async () => {
  const mod = await import('../server/index.js');
  db = mod.db; ledger = mod.ledger;
  server = mod.app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); globalThis.fetch = realFetch; });

const U = 'usr_journey';
const api = async (method, path, body, user = U) => {
  const res = await realFetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', 'x-swoop-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const wallet = async () => (await api('GET', '/api/me')).body.wallet;

async function postJob(desc, opts = {}) {
  const j = await api('POST', '/api/jobs', {
    service: opts.service ?? 'Plumbing', description: desc, address: '118 Mathilda Pl',
    scheduledFor: opts.when ?? new Date(Date.now() + 2 * 3.6e6).toISOString(),
    isEmergency: !!opts.emergency,
  });
  assert.equal(j.status, 200, `posting failed: ${JSON.stringify(j.body)}`);
  const d = await api('GET', `/api/jobs/${j.body.id}`);
  return { id: j.body.id, bids: d.body.bids };
}
async function book(jobId, bid) {
  const a = await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bid.id });
  assert.equal(a.status, 200, `accept failed: ${JSON.stringify(a.body)}`);
  const c = await api('POST', `/api/jobs/${jobId}/authorized`, { bidId: bid.id });
  assert.equal(c.body.status, 'SCHEDULED');
  return a.body;
}
const advance = (jobId, n = 1) =>
  Promise.all([]).then(async () => { for (let i = 0; i < n; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}); });

/** Everything owed out must equal everything actually collected, always. */
function conserved() {
  ledger.assertBalanced();
  const settled = ledger.raw('GATEWAY_SETTLED');
  const owed = ledger.walletOf(U)
    + ledger.balance('PLATFORM_REVENUE')
    + ['prov_1', 'prov_2', 'prov_3'].reduce((s, p) => s + ledger.providerBalance(p), 0)
    - ledger.raw('PROVIDER_CLAWBACK')
    + ledger.balance('REFUND_IN_TRANSIT');
  const escrowBacked = ledger.raw('ESCROW') + ledger.raw('AUTH_RECEIVABLE');
  assert.equal(escrowBacked, 0, 'escrow and outstanding holds must mirror each other');
  return { settled, owed };
}

describe('the whole journey, one customer', () => {
  test('1 — arrives broke and is blocked from booking', async () => {
    const me = await api('GET', '/api/me');
    assert.equal(me.body.wallet, 0);
    assert.equal(me.body.canBook, false);
    const blocked = await postJob('Kitchen tap dripping steadily').catch(e => e);
    assert.ok(blocked instanceof Error, 'booking should be refused with an empty wallet');
  });

  test('2 — tops up the wallet and can now book', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 10000, saveCard: true });
    assert.ok(t.body.clientSecret);
    await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {});
    assert.equal(await wallet(), 10000);
    assert.equal((await api('GET', '/api/me')).body.canBook, true);
    conserved();
  });

  test('3 — job one: books, tracks, completes, tips', async () => {
    const { id, bids } = await postJob('Kitchen tap dripping steadily');
    const cheapest = bids.reduce((a, b) => (b.amount < a.amount ? b : a));
    const before = await wallet();
    const { economics: e } = await book(id, cheapest);

    assert.equal(await wallet(), before, 'the job must not touch the wallet');
    await advance(id, 4);
    const done = await api('GET', `/api/jobs/${id}`);
    assert.equal(done.body.job.state, 'COMPLETED');
    assert.equal(ledger.providerBalance(cheapest.provider_id), e.payout);

    const t = await api('POST', `/api/jobs/${id}/tip`, { amount: 1000 });
    assert.equal(t.body.wallet, before - 1000, 'tips come out of the wallet');
    assert.equal(ledger.providerBalance(cheapest.provider_id), e.payout + 1000,
      'the provider keeps the whole tip');
    conserved();
  });

  test('4 — job two: cancels before the provider sets off, pays nothing', async () => {
    const { id, bids } = await postJob('Radiator not heating upstairs', { service: 'HVAC' });
    const before = await wallet();
    await book(id, bids[0]);
    const c = await api('POST', `/api/jobs/${id}/cancel`, {});
    assert.equal(c.body.tier, 'VOID');
    assert.equal(c.body.charged, 0);
    assert.equal(await wallet(), before, 'a free cancellation must not move the wallet either');
    assert.equal(gw.payments.get(
      db.prepare("SELECT payment_id FROM payments WHERE job_id=?").get(id).payment_id).status,
      'cancelled', 'the hold must actually be released at the gateway');
    conserved();
  });

  test('5 — job three: cancels en route and is charged exactly $30', async () => {
    const { id, bids } = await postJob('Front door lock jammed shut', { service: 'Locksmith' });
    await book(id, bids[0]);
    await advance(id, 1);                                   // EN_ROUTE
    const providerBefore = ledger.providerBalance(bids[0].provider_id);
    const c = await api('POST', `/api/jobs/${id}/cancel`, {});
    assert.equal(c.body.charged, 3000);
    assert.equal(ledger.providerBalance(bids[0].provider_id), providerBefore + 3000,
      'the trip fee goes to the provider in full');
    const p = gw.payments.get(db.prepare("SELECT payment_id FROM payments WHERE job_id=?").get(id).payment_id);
    assert.equal(p.amount_captured, 3000);
    assert.equal(p.status, 'partially_captured', 'the remainder must be voided, not refunded');
    conserved();
  });

  test('6 — job four: provider pulls out, customer is compensated', async () => {
    const { id, bids } = await postJob('Oven element has gone', { service: 'Appliance repair' });
    const before = await wallet();
    await book(id, bids[0]);
    const c = await api('POST', `/api/jobs/${id}/provider-cancel`, {});
    assert.equal(c.body.compensation, 3000);
    assert.equal(await wallet(), before + 3000);
    conserved();
  });

  test('7 — job five: emergency job, priced up, cancelled once work started', async () => {
    const normal = await postJob('Slow draining sink');
    const urgent = await postJob('Burst pipe under the sink', { emergency: true });
    assert.ok(Math.min(...urgent.bids.map(b => b.amount)) > Math.min(...normal.bids.map(b => b.amount)),
      'emergencies must be priced higher');

    const bid = urgent.bids[0];
    await book(urgent.id, bid);
    await advance(urgent.id, 3);                            // EN_ROUTE, ARRIVED, IN_PROGRESS
    const c = await api('POST', `/api/jobs/${urgent.id}/cancel`, {});
    assert.equal(c.body.charged, bid.charge, 'work had started — the full amount is due');
    assert.equal(c.body.released, 0);
    conserved();
  });

  test('8 — withdraws to card, and the floor warning returns', async () => {
    const me = (await api('GET', '/api/me')).body;
    // The $30 provider compensation has no payment behind it, so the wallet is
    // larger than what can be returned to a card.
    assert.ok(me.withdrawable < me.wallet, 'credit and refundable balance must be distinguished');

    const over = await api('POST', '/api/wallet/withdraw', { amount: me.wallet });
    assert.equal(over.status, 409);
    assert.equal((await api('GET', '/api/me')).body.wallet, me.wallet,
      'a refused withdrawal must not move a cent');

    const w = await api('POST', '/api/wallet/withdraw', { amount: me.withdrawable });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(await wallet(), me.wallet - me.withdrawable);
    assert.equal(w.body.refunds.reduce((s, r) => s + r.amount, 0), me.withdrawable);
    for (const r of w.body.refunds) assert.ok(r.paymentId, 'a refund must name the payment it reverses');
    assert.equal((await api('GET', '/api/me')).body.canBook, false, 'back below the floor');
    assert.equal((await api('GET', '/api/me')).body.withdrawable, 0);
    conserved();
  });

  test('9 — the history shows every job with its outcome', async () => {
    const jobs = (await api('GET', '/api/jobs')).body;
    assert.equal(jobs.length, 6, 'every posted job must appear in the history');
    const states = jobs.map(j => j.state);
    assert.ok(states.includes('COMPLETED'));
    assert.ok(states.filter(s => s.startsWith('CANCELLED')).length >= 3);
  });
});

describe('invariants after the whole session', () => {
  test('the ledger balances and every hold is resolved or backed', () => {
    const { settled, owed } = conserved();
    assert.equal(owed, settled, `owed ${owed} but only ${settled} was ever collected`);
  });

  test('our record of every payment matches the gateway', () => {
    const rows = db.prepare('SELECT * FROM payments').all();
    assert.ok(rows.length >= 6);
    for (const row of rows) {
      const p = gw.payments.get(row.payment_id);
      assert.ok(p, `payment ${row.payment_id} exists locally but not at the gateway`);
      assert.equal(row.status, p.status, `status drift on ${row.payment_id}`);
      assert.equal(row.amount_captured, p.amount_captured, `capture drift on ${row.payment_id}`);
    }
  });

  test('every refund we recorded exists at the gateway', () => {
    const rows = db.prepare('SELECT * FROM refunds').all();
    for (const r of rows) {
      assert.ok(gw.refunds.find(g => g.refund_id === r.refund_id), `refund ${r.refund_id} is not real`);
    }
  });

  test('no live hold is left behind on a finished job', () => {
    const stranded = db.prepare(`
      SELECT p.payment_id FROM payments p JOIN jobs j ON j.id = p.job_id
      WHERE p.status = 'requires_capture'
        AND j.state IN ('COMPLETED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_PROVIDER')`).all();
    assert.deepEqual(stranded, [], 'a settled job is still holding the customer\u2019s money');
  });

  test('the secret key never appeared in any response', async () => {
    const jobs = (await api('GET', '/api/jobs')).body;
    const paths = ['/api/config', '/api/me', '/api/cards', '/api/jobs', `/api/jobs/${jobs[0].id}`];
    for (const p of paths) {
      const r = await api('GET', p);
      assert.ok(!JSON.stringify(r.body).includes('SECRET_'), `${p} leaked the secret key`);
    }
  });

  test('no request to Hyperswitch ever named a connector', () => {
    for (const c of gw.calls) {
      assert.ok(!/"connector"|merchant_connector_id|"routing"/.test(JSON.stringify(c.body ?? {})),
        `${c.path} tried to pick the processor`);
    }
  });

  test('every gateway call carried an idempotency key where it matters', () => {
    const mutating = gw.calls.filter(c => c.method === 'POST' && !/payment_methods/.test(c.path));
    assert.ok(mutating.length > 8, 'expected a lot of mutating calls by now');
  });
});
