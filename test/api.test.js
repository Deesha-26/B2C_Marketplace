/**
 * End-to-end API tests. Boots the real server against a fake Hyperswitch by
 * intercepting global fetch, then drives every customer flow over real HTTP.
 */
process.env.SWOOP_AUTOSTART = 'false';
process.env.DB_PATH = ':memory:';
process.env.HYPERSWITCH_SECRET_KEY = 'SECRET_snd_abc123';
process.env.HYPERSWITCH_PUBLISHABLE_KEY = 'pk_snd_public999';
process.env.HYPERSWITCH_PROFILE_ID = 'pro_test';
process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY = 'hash_key_test';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/* ---------------- fake Hyperswitch ---------------- */
const gw = {
  payments: new Map(), refunds: new Map(),
  calls: [], failNextAuth: null, retryTrail: null, captureBy: null,
  reset() { this.payments.clear(); this.refunds.clear(); this.calls = [];
            this.failNextAuth = null; this.retryTrail = null; this.captureBy = null; },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const path = u.pathname;
  const body = opts.body ? JSON.parse(opts.body) : {};
  gw.calls.push({ method: opts.method, path, body, idem: opts.headers?.['x-idempotency-key'] });
  const ok = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const err = (status, code, message) => new Response(
    JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } });

  if (path === '/payments' && opts.method === 'POST') {
    if (gw.failNextAuth) { const e = gw.failNextAuth; gw.failNextAuth = null; return err(402, e.code, e.message); }
    const id = 'pay_' + Math.random().toString(36).slice(2, 10);
    const p = {
      payment_id: id, amount: body.amount, currency: body.currency,
      status: body.capture_method === 'manual' ? 'requires_capture' : 'succeeded',
      capture_method: body.capture_method, connector: 'stripe',
      client_secret: `${id}_secret`, amount_captured: body.capture_method === 'manual' ? 0 : body.amount,
      capture_by: gw.captureBy, attempts: gw.retryTrail ?? [{ connector: 'stripe', status: 'charged' }],
      request_extended_authorization: body.request_extended_authorization ?? false,
      _request: body,
    };
    gw.payments.set(id, p);
    return ok(p);
  }
  const pm = path.match(/^\/payments\/([^/]+)(\/(capture|cancel|extend_authorization))?$/);
  if (pm) {
    const p = gw.payments.get(pm[1]);
    if (!p) return err(404, 'not_found', 'no such payment');
    const action = pm[3];
    if (!action) return ok(p);
    if (action === 'capture') {
      const amt = body.amount_to_capture ?? p.amount;
      p.amount_captured = amt;
      p.status = amt < p.amount ? 'partially_captured' : 'succeeded';
      return ok(p);
    }
    if (action === 'cancel') { p.status = 'cancelled'; return ok(p); }
    if (action === 'extend_authorization') {
      p.capture_by = new Date(Date.now() + 7 * 864e5).toISOString();
      p.extended_authorization_applied = true;
      p.extended_authorization_last_applied_at = new Date().toISOString();
      return ok(p);
    }
  }
  if (path === '/refunds' && opts.method === 'POST') {
    const id = 'ref_' + Math.random().toString(36).slice(2, 10);
    const r = { refund_id: id, payment_id: body.payment_id, amount: body.amount, status: 'succeeded' };
    gw.refunds.set(id, r);
    return ok(r);
  }
  if (/^\/customers\/.+\/payment_methods$/.test(path)) return ok({ customer_payment_methods: [] });
  return err(404, 'not_found', path);
};

/* ---------------- boot ---------------- */
let server, base, db, ledger;
before(async () => {
  const mod = await import('../server/index.js');
  db = mod.db; ledger = mod.ledger;
  server = mod.app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); globalThis.fetch = realFetch; });

const api = async (method, path, body, user = 'usr_test') => {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-swoop-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const seedWallet = async (user, cents) => {
  const t = await api('POST', '/api/wallet/topup', { amount: cents }, user);
  await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, user);
};
const bookJob = async (user, opts = {}) => {
  const j = await api('POST', '/api/jobs', {
    service: 'Plumbing', description: 'Kitchen tap dripping steadily',
    address: '118 Mathilda Pl', isEmergency: !!opts.emergency,
    scheduledFor: opts.scheduledFor ?? new Date(Date.now() + 2 * 3.6e6).toISOString(),
  }, user);
  const detail = await api('GET', `/api/jobs/${j.body.id}`, null, user);
  return { jobId: j.body.id, bids: detail.body.bids };
};
const acceptFirstBid = async (user, jobId, bids) => {
  const a = await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, user);
  const b = await api('POST', `/api/jobs/${jobId}/authorized`, { bidId: bids[0].id }, user);
  return { accept: a, authorized: b, bid: bids[0] };
};

/* ================= tests ================= */

describe('config and identity', () => {
  test('config exposes the publishable key and never the secret', async () => {
    const r = await api('GET', '/api/config');
    assert.equal(r.body.publishableKey, 'pk_snd_public999');
    assert.ok(!JSON.stringify(r.body).includes('SECRET_'), 'secret key must never be served');
    assert.equal(r.body.walletFloor, 2500);
  });
  test('a new user starts with an empty wallet and cannot book', async () => {
    const r = await api('GET', '/api/me', null, 'usr_new');
    assert.equal(r.body.wallet, 0);
    assert.equal(r.body.canBook, false);
  });
});

describe('wallet top-up', () => {
  test('below the minimum is rejected', async () => {
    const r = await api('POST', '/api/wallet/topup', { amount: 500 }, 'usr_min');
    assert.equal(r.status, 400);
  });
  test('top-up is auto-capture and credits the wallet once settled', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_a');
    assert.ok(t.body.clientSecret, 'client gets a client_secret');
    assert.ok(!JSON.stringify(t.body).includes('SECRET_'), 'never leaks the secret key');
    const req = gw.calls.at(-1).body;
    assert.equal(req.capture_method, 'automatic');
    const s = await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_a');
    assert.equal(s.body.wallet, 5000);
  });
  test('settling twice does not double-credit', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_b');
    await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_b');
    const again = await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_b');
    assert.equal(again.body.wallet, 5000, 'idempotent settle');
  });
  test('save-card only vaults when asked', async () => {
    await api('POST', '/api/wallet/topup', { amount: 5000, saveCard: true }, 'usr_c');
    assert.equal(gw.calls.at(-1).body.setup_future_usage, 'off_session');
    await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_c');
    assert.equal(gw.calls.at(-1).body.setup_future_usage, undefined);
  });
  test('a top-up for another user cannot be settled', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_d');
    const s = await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_thief');
    assert.equal(s.status, 404, 'must not settle a payment you do not own');
  });
});

describe('booking and authorization', () => {
  test('booking is blocked under the wallet floor', async () => {
    const r = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Tap is dripping badly',
      address: 'x', scheduledFor: new Date().toISOString() }, 'usr_poor');
    assert.equal(r.status, 402);
  });
  test('a too-short description is rejected', async () => {
    await seedWallet('usr_e', 5000);
    const r = await api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'leak', address: 'x',
      scheduledFor: new Date().toISOString() }, 'usr_e');
    assert.equal(r.status, 400);
  });
  test('bids arrive with fees computed and no authorization yet', async () => {
    await seedWallet('usr_f', 5000);
    const { bids } = await bookJob('usr_f');
    assert.equal(bids.length, 3);
    assert.equal(bids.find(b => b.amount === 9000).charge, 9675);
    assert.equal(gw.calls.filter(c => c.body?.capture_method === 'manual').length, 0);
  });
  test('emergency jobs are priced higher', async () => {
    await seedWallet('usr_g', 5000);
    const normal = await bookJob('usr_g');
    const urgent = await bookJob('usr_g', { emergency: true });
    assert.ok(Math.min(...urgent.bids.map(b => b.amount)) > Math.min(...normal.bids.map(b => b.amount)));
  });
  test('accepting authorizes exactly bid + fee with manual capture', async () => {
    await seedWallet('usr_h', 5000);
    const { jobId, bids } = await bookJob('usr_h');
    const { accept } = await acceptFirstBid('usr_h', jobId, bids);
    const req = gw.calls.find(c => c.path === '/payments' && c.body.capture_method === 'manual').body;
    assert.equal(req.amount, accept.body.economics.charge);
    assert.equal(req.capture_method, 'manual');
    const detail = await api('GET', `/api/jobs/${jobId}`, null, 'usr_h');
    assert.equal(detail.body.job.state, 'SCHEDULED');
  });
  test('no request ever names a connector', () => {
    for (const c of gw.calls) {
      const s = JSON.stringify(c.body ?? {});
      assert.ok(!/"connector"|merchant_connector_id|"routing"/.test(s),
        `routing must be left to Hyperswitch: ${s}`);
    }
  });
  test('the wallet is untouched by a job authorization', async () => {
    await seedWallet('usr_i', 5000);
    const { jobId, bids } = await bookJob('usr_i');
    await acceptFirstBid('usr_i', jobId, bids);
    const me = await api('GET', '/api/me', null, 'usr_i');
    assert.equal(me.body.wallet, 5000, 'jobs charge the card, not the wallet');
  });
  test('a declined authorization surfaces the error and leaves the job open', async () => {
    await seedWallet('usr_j', 5000);
    const { jobId, bids } = await bookJob('usr_j');
    gw.failNextAuth = { code: 'insufficient_funds', message: 'Declined for insufficient funds.' };
    const a = await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, 'usr_j');
    assert.equal(a.status, 402);
    assert.match(a.body.error, /insufficient funds/i);
    const detail = await api('GET', `/api/jobs/${jobId}`, null, 'usr_j');
    assert.equal(detail.body.job.state, 'OPEN_FOR_BIDS', 'a decline must not book the job');
  });
  test('a bid cannot be accepted twice', async () => {
    await seedWallet('usr_k', 5000);
    const { jobId, bids } = await bookJob('usr_k');
    await acceptFirstBid('usr_k', jobId, bids);
    const again = await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, 'usr_k');
    assert.equal(again.status, 409);
  });
  test('another user cannot see or accept your job', async () => {
    await seedWallet('usr_l', 5000);
    const { jobId, bids } = await bookJob('usr_l');
    assert.equal((await api('GET', `/api/jobs/${jobId}`, null, 'usr_x')).status, 404);
    assert.equal((await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, 'usr_x')).status, 404);
  });
});

describe('completion', () => {
  test('completing captures in full and pays provider and platform', async () => {
    await seedWallet('usr_m', 5000);
    const { jobId, bids } = await bookJob('usr_m');
    const { bid } = await acceptFirstBid('usr_m', jobId, bids);
    for (const _ of ['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_m');
    const done = await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_m');
    assert.equal(done.body.state, 'COMPLETED');
    assert.equal(done.body.charged, bid.charge);
    assert.equal(ledger.providerBalance(bid.provider_id), bid.payout);
    ledger.assertBalanced();
  });
  test('a job cannot be completed out of order', async () => {
    await seedWallet('usr_n', 5000);
    const { jobId, bids } = await bookJob('usr_n');
    await acceptFirstBid('usr_n', jobId, bids);
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_n');  // EN_ROUTE
    const detail = await api('GET', `/api/jobs/${jobId}`, null, 'usr_n');
    assert.equal(detail.body.job.state, 'EN_ROUTE');
  });
  test('advancing a finished job is refused', async () => {
    await seedWallet('usr_o', 5000);
    const { jobId, bids } = await bookJob('usr_o');
    await acceptFirstBid('usr_o', jobId, bids);
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_o');
    const extra = await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_o');
    assert.equal(extra.status, 409);
  });
});

describe('cancellation tiers', () => {
  const setup = async user => {
    await seedWallet(user, 5000);
    const { jobId, bids } = await bookJob(user);
    const { bid } = await acceptFirstBid(user, jobId, bids);
    return { jobId, bid };
  };
  test('before en route voids and charges nothing', async () => {
    const { jobId } = await setup('usr_p');
    const c = await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_p');
    assert.equal(c.body.tier, 'VOID');
    assert.equal(c.body.charged, 0);
    assert.ok(gw.calls.some(x => x.path.endsWith('/cancel')), 'must call the void endpoint');
    ledger.assertBalanced();
  });
  test('en route captures exactly $30 and releases the rest', async () => {
    const { jobId, bid } = await setup('usr_q');
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_q');
    const c = await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_q');
    assert.equal(c.body.tier, 'PARTIAL_CAPTURE');
    assert.equal(c.body.charged, 3000);
    assert.equal(c.body.released, bid.charge - 3000);
    const cap = gw.calls.filter(x => x.path.endsWith('/capture')).at(-1);
    assert.equal(cap.body.amount_to_capture, 3000, 'partial capture, not a refund');
    ledger.assertBalanced();
  });
  test('arrived is charged in full, not treated as en route', async () => {
    const { jobId, bid } = await setup('usr_r');
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_r');
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_r');
    const c = await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_r');
    assert.equal(c.body.charged, bid.charge);
    ledger.assertBalanced();
  });
  test('a completed job cannot be cancelled', async () => {
    const { jobId } = await setup('usr_s');
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_s');
    const c = await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_s');
    assert.equal(c.status, 409);
  });
  test('provider cancellation refunds the hold and pays $30 compensation', async () => {
    const { jobId, bid } = await setup('usr_t');
    const providerBefore = ledger.providerBalance(bid.provider_id) - ledger.raw('PROVIDER_CLAWBACK');
    const c = await api('POST', `/api/jobs/${jobId}/provider-cancel`, {}, 'usr_t');
    const providerAfter = ledger.providerBalance(bid.provider_id) - ledger.raw('PROVIDER_CLAWBACK');
    assert.equal(c.body.compensation, 3000);
    assert.equal(c.body.wallet, 5000 + 3000);
    assert.equal(providerAfter, providerBefore - 3000, 'the $30 comes out of the provider either way');
    ledger.assertBalanced();
  });
  test('a provider cannot cancel once en route', async () => {
    const { jobId } = await setup('usr_u');
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_u');
    const c = await api('POST', `/api/jobs/${jobId}/provider-cancel`, {}, 'usr_u');
    assert.equal(c.status, 409);
  });
});

describe('tips', () => {
  test('a tip moves wallet money to the provider in full', async () => {
    await seedWallet('usr_v', 5000);
    const { jobId, bids } = await bookJob('usr_v');
    const { bid } = await acceptFirstBid('usr_v', jobId, bids);
    const before = ledger.providerBalance(bid.provider_id);
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_v');
    const t = await api('POST', `/api/jobs/${jobId}/tip`, { amount: 1000 }, 'usr_v');
    assert.equal(t.body.wallet, 4000);
    assert.equal(ledger.providerBalance(bid.provider_id), before + bid.payout + 1000);
    ledger.assertBalanced();
  });
  test('a tip larger than the wallet is refused', async () => {
    await seedWallet('usr_w', 5000);
    const { jobId, bids } = await bookJob('usr_w');
    await acceptFirstBid('usr_w', jobId, bids);
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_w');
    assert.equal((await api('POST', `/api/jobs/${jobId}/tip`, { amount: 999999 }, 'usr_w')).status, 402);
  });
  test('an incomplete job cannot be tipped', async () => {
    await seedWallet('usr_y', 5000);
    const { jobId, bids } = await bookJob('usr_y');
    await acceptFirstBid('usr_y', jobId, bids);
    assert.equal((await api('POST', `/api/jobs/${jobId}/tip`, { amount: 500 }, 'usr_y')).status, 409);
  });
});

describe('withdrawal via refund', () => {
  test('withdrawing issues a real refund against the top-up payment', async () => {
    await seedWallet('usr_z', 5000);
    const w = await api('POST', '/api/wallet/withdraw', { amount: 3000 }, 'usr_z');
    assert.equal(w.body.wallet, 2000);
    assert.equal(w.body.refunds.length, 1);
    assert.ok(w.body.refunds[0].refundId.startsWith('ref_'));
    assert.ok(gw.calls.some(c => c.path === '/refunds' && c.body.amount === 3000));
    ledger.assertBalanced();
  });
  test('withdrawing more than the balance is refused', async () => {
    await seedWallet('usr_aa', 5000);
    assert.equal((await api('POST', '/api/wallet/withdraw', { amount: 99999 }, 'usr_aa')).status, 402);
  });
  test('a withdrawal spanning two top-ups issues two refunds', async () => {
    await seedWallet('usr_bb', 2500);
    await seedWallet('usr_bb', 2500);
    const w = await api('POST', '/api/wallet/withdraw', { amount: 4000 }, 'usr_bb');
    assert.equal(w.body.refunds.length, 2, 'a refund must name the payment it reverses');
    assert.equal(w.body.refunds.reduce((s, r) => s + r.amount, 0), 4000);
    ledger.assertBalanced();
  });
});

describe('webhooks', () => {
  const send = async (event, sig) => {
    const raw = JSON.stringify(event);
    const signature = sig ?? crypto.createHmac('sha512', 'hash_key_test').update(raw).digest('hex');
    const res = await realFetch(`${base}/api/webhooks/hyperswitch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature-512': signature },
      body: raw,
    });
    return { status: res.status, body: await res.json() };
  };
  test('an unsigned webhook is rejected', async () => {
    const r = await send({ event_id: 'e1', event_type: 'payment_succeeded' }, 'deadbeef');
    assert.equal(r.status, 401);
  });
  test('a valid webhook is accepted', async () => {
    const r = await send({ event_id: 'e2', event_type: 'payment_succeeded', content: { object: { payment_id: 'pay_x', status: 'succeeded' } } });
    assert.equal(r.status, 200);
  });
  test('a duplicate delivery is ignored', async () => {
    const ev = { event_id: 'e3', event_type: 'payment_succeeded', content: { object: { payment_id: 'pay_y', status: 'succeeded' } } };
    await send(ev);
    const again = await send(ev);
    assert.match(JSON.stringify(again.body), /duplicate/);
  });
  test('a webhook without an event_id is rejected', async () => {
    const r = await send({ event_type: 'payment_succeeded' });
    assert.equal(r.status, 400);
  });
});

describe('extended authorization watchdog', () => {
  test('a hold near its deadline is extended', async () => {
    gw.captureBy = new Date(Date.now() + 2 * 3.6e6).toISOString();  // 2h left
    await seedWallet('usr_cc', 5000);
    const { jobId, bids } = await bookJob('usr_cc', { scheduledFor: new Date(Date.now() + 48 * 3.6e6).toISOString() });
    await acceptFirstBid('usr_cc', jobId, bids);
    const { AuthWatchdog } = await import('../server/watchdog.js');
    const r = await new AuthWatchdog(db, { log: { error() {}, info() {} } }).sweep();
    assert.equal(r.extended, 1, 'a hold two hours from expiry must be extended');
    assert.ok(gw.calls.some(c => c.path.endsWith('/extend_authorization')));
    gw.captureBy = null;
  });
  test('a hold far from its deadline is left alone', async () => {
    gw.captureBy = new Date(Date.now() + 30 * 24 * 3.6e6).toISOString();
    await seedWallet('usr_dd', 5000);
    const { jobId, bids } = await bookJob('usr_dd', { scheduledFor: new Date(Date.now() + 48 * 3.6e6).toISOString() });
    await acceptFirstBid('usr_dd', jobId, bids);
    const before = gw.calls.filter(c => c.path.endsWith('/extend_authorization')).length;
    const { AuthWatchdog } = await import('../server/watchdog.js');
    await new AuthWatchdog(db, { log: { error() {}, info() {} } }).sweep();
    assert.equal(gw.calls.filter(c => c.path.endsWith('/extend_authorization')).length, before);
    gw.captureBy = null;
  });
  test('the watchdog ignores completed and cancelled jobs', async () => {
    gw.captureBy = new Date(Date.now() + 1 * 3.6e6).toISOString();
    await seedWallet('usr_ee', 5000);
    const { jobId, bids } = await bookJob('usr_ee');
    await acceptFirstBid('usr_ee', jobId, bids);
    await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_ee');
    const { AuthWatchdog } = await import('../server/watchdog.js');
    const held = new AuthWatchdog(db, { log: { error() {}, info() {} } }).openHolds();
    assert.ok(!held.some(h => h.job_id === jobId), 'a cancelled job must not be swept');
    gw.captureBy = null;
  });
});

describe('routing visibility', () => {
  test('the retry trail is surfaced to the client', async () => {
    gw.retryTrail = [
      { connector: 'paypal', status: 'failure', error_code: 'processing_error' },
      { connector: 'stripe', status: 'charged' },
    ];
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_ff');
    const s = await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_ff');
    assert.equal(s.body.routing.length, 2, 'both attempts must be visible');
    assert.equal(s.body.routing[0].connector, 'paypal');
    assert.equal(s.body.routing[1].connector, 'stripe');
    gw.retryTrail = null;
  });
});

describe('global invariants', () => {
  test('the ledger balances after every flow in this suite', () => {
    ledger.assertBalanced();
    // Open jobs legitimately hold escrow. What must ALWAYS hold is that escrow
    // exactly mirrors the authorizations still outstanding — every held dollar
    // is backed by a live hold, and vice versa.
    assert.equal(ledger.raw('ESCROW') + ledger.raw('AUTH_RECEIVABLE'), 0,
      'escrow and outstanding authorizations must mirror each other');
    const openHolds = db.prepare(
      "SELECT COALESCE(SUM(amount),0) t FROM payments WHERE purpose='job_authorization' AND status='requires_capture'").get().t;
    assert.equal(ledger.balance('ESCROW'), Number(openHolds),
      'escrow must equal the sum of live holds');
  });
});

/* ================= adversarial ================= */
describe('hostile input', () => {
  test('acting on an unknown job returns 404, not a crash', async () => {
    for (const ep of ['advance', 'cancel', 'provider-cancel', 'tip']) {
      const r = await api('POST', `/api/jobs/job_nope/${ep}`, { amount: 100 }, 'usr_h1');
      assert.ok(r.status === 404 || r.status === 409,
        `${ep} returned ${r.status} (${r.body.error}) — expected a clean 4xx`);
    }
  });
  test('confirming an authorization without a bidId does not orphan the job', async () => {
    await seedWallet('usr_h2', 5000);
    const { jobId, bids } = await bookJob('usr_h2');
    await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, 'usr_h2');
    await api('POST', `/api/jobs/${jobId}/authorized`, {}, 'usr_h2');   // bidId omitted
    const adv = await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_h2');
    assert.ok(adv.status < 500, `advance crashed with ${adv.status}: ${adv.body.error}`);
  });
  test('accepting a bid belonging to a different job is refused', async () => {
    await seedWallet('usr_h3', 5000);
    const a = await bookJob('usr_h3');
    const b = await bookJob('usr_h3');
    const r = await api('POST', `/api/jobs/${a.jobId}/accept`, { bidId: b.bids[0].id }, 'usr_h3');
    assert.equal(r.status, 404);
  });
  test('a negative or fractional tip is refused', async () => {
    await seedWallet('usr_h4', 5000);
    const { jobId, bids } = await bookJob('usr_h4');
    await acceptFirstBid('usr_h4', jobId, bids);
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_h4');
    for (const amount of [-500, 0, 10.5, 'abc']) {
      const r = await api('POST', `/api/jobs/${jobId}/tip`, { amount }, 'usr_h4');
      assert.equal(r.status, 400, `tip of ${amount} was accepted`);
    }
  });
  test('a negative withdrawal cannot mint wallet balance', async () => {
    await seedWallet('usr_h5', 5000);
    const r = await api('POST', '/api/wallet/withdraw', { amount: -1000 }, 'usr_h5');
    const me = await api('GET', '/api/me', null, 'usr_h5');
    assert.ok(r.status >= 400, 'negative withdrawal must be refused');
    assert.equal(me.body.wallet, 5000);
  });
  test('an expired bid cannot be accepted', async () => {
    await seedWallet('usr_h6', 5000);
    const { jobId, bids } = await bookJob('usr_h6');
    db.prepare('UPDATE bids SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), bids[0].id);
    const r = await api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id }, 'usr_h6');
    assert.equal(r.status, 410);
  });
});

describe('local state tracks the gateway', () => {
  test('a captured hold is no longer recorded as outstanding', async () => {
    await seedWallet('usr_s1', 5000);
    const { jobId, bids } = await bookJob('usr_s1');
    await acceptFirstBid('usr_s1', jobId, bids);
    for (let i = 0; i < 4; i++) await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_s1');
    const p = db.prepare("SELECT * FROM payments WHERE job_id=? AND purpose='job_authorization'").get(jobId);
    assert.notEqual(p.status, 'requires_capture', 'a captured payment must not still read as a live hold');
    assert.equal(p.amount_captured, p.amount);
  });
  test('a voided hold is no longer recorded as outstanding', async () => {
    await seedWallet('usr_s2', 5000);
    const { jobId, bids } = await bookJob('usr_s2');
    await acceptFirstBid('usr_s2', jobId, bids);
    await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_s2');
    const p = db.prepare("SELECT * FROM payments WHERE job_id=? AND purpose='job_authorization'").get(jobId);
    assert.equal(p.status, 'cancelled');
  });
  test('a partial capture is recorded with the amount actually taken', async () => {
    await seedWallet('usr_s3', 5000);
    const { jobId, bids } = await bookJob('usr_s3');
    await acceptFirstBid('usr_s3', jobId, bids);
    await api('POST', `/api/jobs/${jobId}/advance`, {}, 'usr_s3');
    await api('POST', `/api/jobs/${jobId}/cancel`, {}, 'usr_s3');
    const p = db.prepare("SELECT * FROM payments WHERE job_id=? AND purpose='job_authorization'").get(jobId);
    assert.equal(p.amount_captured, 3000);
    assert.equal(p.status, 'partially_captured');
  });
});

describe('webhooks settle money, not just status', () => {
  const send = async event => {
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha512', 'hash_key_test').update(raw).digest('hex');
    const res = await realFetch(`${base}/api/webhooks/hyperswitch`, {
      method: 'POST', headers: { 'x-webhook-signature-512': sig }, body: raw });
    return { status: res.status, body: await res.json() };
  };

  test('a top-up credits the wallet even if the browser never returns', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_wh1');
    // No /settle call — the customer closed the tab.
    assert.equal((await api('GET', '/api/me', null, 'usr_wh1')).body.wallet, 0);
    const r = await send({ event_id: 'wh_1', event_type: 'payment_succeeded',
      content: { object: { payment_id: t.body.paymentId, status: 'succeeded' } } });
    assert.equal(r.status, 200);
    assert.equal((await api('GET', '/api/me', null, 'usr_wh1')).body.wallet, 5000);
    ledger.assertBalanced();
  });

  test('webhook and settle together never double-credit', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_wh2');
    await send({ event_id: 'wh_2', event_type: 'payment_succeeded',
      content: { object: { payment_id: t.body.paymentId, status: 'succeeded' } } });
    await api('POST', `/api/wallet/topup/${t.body.paymentId}/settle`, {}, 'usr_wh2');
    assert.equal((await api('GET', '/api/me', null, 'usr_wh2')).body.wallet, 5000);
  });

  test('a redelivered webhook does not credit twice', async () => {
    const t = await api('POST', '/api/wallet/topup', { amount: 5000 }, 'usr_wh3');
    const ev = { event_id: 'wh_3', event_type: 'payment_succeeded',
      content: { object: { payment_id: t.body.paymentId, status: 'succeeded' } } };
    await send(ev); await send(ev); await send(ev);
    assert.equal((await api('GET', '/api/me', null, 'usr_wh3')).body.wallet, 5000);
    ledger.assertBalanced();
  });

  test('a refund webhook clears REFUND_IN_TRANSIT', async () => {
    await seedWallet('usr_wh4', 5000);
    const w = await api('POST', '/api/wallet/withdraw', { amount: 2500 }, 'usr_wh4');
    const inTransit = ledger.balance('REFUND_IN_TRANSIT');
    assert.ok(inTransit > 0, 'withdrawal must open a transit balance');
    await send({ event_id: 'wh_4', event_type: 'refund_succeeded',
      content: { object: { refund_id: w.body.refunds[0].refundId, status: 'succeeded' } } });
    assert.equal(ledger.balance('REFUND_IN_TRANSIT'), inTransit - 2500);
    ledger.assertBalanced();
  });
});
