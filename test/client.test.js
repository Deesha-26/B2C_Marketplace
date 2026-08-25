/**
 * Client tests. Runs public/app.js in a VM against a DOM stub, with fetch
 * pointed at the real server (itself talking to a fake Hyperswitch).
 *
 * This exercises the actual browser code — render paths, handlers, API wiring —
 * rather than a reimplementation of it.
 */
process.env.SWOOP_AUTOSTART = 'false';
process.env.DB_PATH = ':memory:';
process.env.HYPERSWITCH_SECRET_KEY = 'SECRET_snd_abc';
process.env.HYPERSWITCH_PUBLISHABLE_KEY = 'pk_snd_public';
process.env.HYPERSWITCH_PROFILE_ID = 'pro_test';
process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY = 'hash_key_test';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;

/* ---------------- fake Hyperswitch (server-side) ---------------- */
const gw = { payments: new Map(), calls: [], retryTrail: null };
globalThis.fetch = async (url, opts = {}) => {
  const s = String(url);
  if (s.startsWith('http://127.0.0.1')) return realFetch(url, opts);   // our own server
  const u = new URL(s);
  const body = opts.body ? JSON.parse(opts.body) : {};
  gw.calls.push({ method: opts.method, path: u.pathname, body });
  const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (u.pathname === '/payments' && opts.method === 'POST') {
    const id = 'pay_' + Math.random().toString(36).slice(2, 10);
    const p = { payment_id: id, amount: body.amount, capture_method: body.capture_method,
      status: body.capture_method === 'manual' ? 'requires_capture' : 'succeeded',
      client_secret: `${id}_secret`, connector: 'stripe',
      amount_captured: body.capture_method === 'manual' ? 0 : body.amount,
      attempts: gw.retryTrail ?? [{ connector: 'stripe', status: 'charged' }] };
    gw.payments.set(id, p);
    return ok(p);
  }
  const m = u.pathname.match(/^\/payments\/([^/]+)(\/(capture|cancel|extend_authorization))?$/);
  if (m) {
    const p = gw.payments.get(m[1]);
    if (!p) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 404 });
    if (m[3] === 'capture') { const a = body.amount_to_capture ?? p.amount; p.amount_captured = a;
      p.status = a < p.amount ? 'partially_captured' : 'succeeded'; }
    if (m[3] === 'cancel') p.status = 'cancelled';
    return ok(p);
  }
  if (u.pathname === '/refunds') return ok({ refund_id: 'ref_' + Math.random().toString(36).slice(2, 8), status: 'succeeded' });
  if (/payment_methods/.test(u.pathname)) return ok({ customer_payment_methods: [] });
  return new Response(JSON.stringify({ error: { message: 'unmapped ' + u.pathname } }), { status: 404 });
};

/* ---------------- DOM stub ---------------- */
const nodes = {};
const node = id => (nodes[id] ??= { id, innerHTML: '', textContent: '', hidden: false, value: '', scrollTop: 0, scrollHeight: 0, dataset: {} });
for (const id of ['strip', 'view', 'nav', 'modal', 'toast', 'live', 'who', 'wTotal', 'wBar', 'wLegend', 'wWarn'])
  node(id);

let server, base, ctx;

before(async () => {
  const mod = await import('../server/index.js');
  server = mod.app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const code = fs.readFileSync(path.join(dir, '..', 'public', 'app.js'), 'utf8');
  ctx = {
    document: {
      getElementById: id => nodes[id] ?? null,
      querySelector: () => null,
    },
    // The client uses relative paths; resolve them against the live server.
    fetch: (p, opts) => realFetch(p.startsWith('http') ? p : base + p, opts),
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms ?? 0, 1)),
    clearTimeout, setInterval: (f, ms) => setInterval(f, Math.min(ms ?? 0, 5)), clearInterval,
    console, Date, Math, JSON, Object, Array, String, Number, Promise, Error, URL, isNaN, parseInt, parseFloat,
    location: { pathname: '/', href: base },
    localStorage: (() => { const m = new Map(); return {
      getItem: k => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: k => m.delete(k), clear: () => m.clear(),
    }; })(),
    // Hyperswitch SDK deliberately absent — see the graceful-degradation test.
  };
  ctx.scrollTo = () => {};          // jsdom-less stub for go()'s scroll reset
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + `
    ;Object.defineProperty(globalThis,'S',{get:()=>S,configurable:true});
    ;Object.defineProperty(globalThis,'V',{get:()=>V,configurable:true});
  `, ctx);
});
after(() => { server?.close(); globalThis.fetch = realFetch; });

const settle = () => new Promise(r => setTimeout(r, 60));
const html = () => nodes.view.innerHTML;
// Inline handlers legitimately contain JS keywords (onkeydown="if(...)"), so
// those are not function references.
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch', 'function']);
const handlersIn = s => {
  const out = new Set();
  for (const m of s.matchAll(/on(?:click|input|change|keydown)="([^"]+)"/g))
    for (const f of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g))
      if (!KEYWORDS.has(f[1])) out.add(f[1]);
  return out;
};
// The client escapes output, so "Whitlock & Sons" renders as "Whitlock &amp; Sons".
const escd = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ================= tests ================= */

describe('sign-in', () => {
  test('a signed-out visitor lands on the login screen', async () => {
    ctx.signOut(); await settle();
    assert.match(nodes.view.innerHTML, /Continue/, 'no sign-in call to action');
    assert.equal(nodes.nav.hidden, true, 'tab bar must be hidden when signed out');
    assert.equal(nodes.strip.hidden, true, 'wallet strip must be hidden when signed out');
  });
  test('a bad email is rejected without a request', async () => {
    ctx.S.loginEmail = 'nope'; await ctx.signIn(); await settle();
    assert.equal(ctx.S.user, null, 'signed in with an invalid address');
  });
  test('signing in reveals the shell and loads the account', async () => {
    ctx.S.loginEmail = 'alex@example.com'; await ctx.signIn(); await settle();
    assert.ok(ctx.S.user, 'no account loaded');
    assert.equal(nodes.nav.hidden, false);
    assert.equal(ctx.S.screen, 'home');
  });
  test('the same email returns to the same account', async () => {
    const first = ctx.S.user.id;
    ctx.signOut(); ctx.S.loginEmail = 'alex@example.com';
    await ctx.signIn(); await settle();
    assert.equal(ctx.S.user.id, first, 'a returning customer must keep their wallet and history');
  });
});

describe('boot', () => {
  test('the app renders without throwing', async () => {
    await settle();
    assert.ok(html().length > 0, 'nothing rendered');
  });
  test('it fetches config and identity on start', async () => {
    await settle();
    assert.equal(ctx.S.config.publishableKey, 'pk_snd_public');
    assert.ok(ctx.S.user, 'no user loaded');
  });
  test('the secret key is never present in the client', () => {
    assert.ok(!JSON.stringify(ctx.S).includes('SECRET_'), 'secret key reached the browser');
  });
});

describe('every screen renders', () => {
  for (const name of ['home', 'wallet', 'post', 'jobs']) {
    test(`${name} renders and its handlers all exist`, async () => {
      ctx.go(name); await settle();
      const markup = html();
      assert.ok(markup.length > 40, `${name} rendered almost nothing`);
      assert.ok(!/undefined|NaN|\[object Object\]/.test(markup), `${name} leaked a placeholder value`);
      for (const h of handlersIn(markup)) {
        assert.equal(typeof ctx[h], 'function', `${name}: handler ${h}() is not defined`);
      }
    });
  }
});

describe('wallet floor', () => {
  test('a new user is told they cannot book yet', async () => {
    ctx.go('home'); await settle();
    assert.equal(ctx.S.canBook, false);
    assert.match(nodes.wWarn.textContent + html(), /25/, 'the $25 floor is never surfaced');
  });
});

describe('top-up through the real API', () => {
  test('a top-up creates a payment and returns a client secret', async () => {
    const r = await ctx.api('POST', '/api/wallet/topup', { amount: 5000 });
    assert.ok(r.clientSecret, 'no client_secret for the SDK');
    assert.ok(!JSON.stringify(r).includes('SECRET_'));
    const settled = await ctx.api('POST', `/api/wallet/topup/${r.paymentId}/settle`, {});
    assert.equal(settled.wallet, 5000);
  });
  test('below the minimum is refused with a readable message', async () => {
    await assert.rejects(() => ctx.api('POST', '/api/wallet/topup', { amount: 100 }), /Minimum/);
  });
  test('the routing trail comes back for display', async () => {
    gw.retryTrail = [
      { connector: 'paypal', status: 'failure', error_code: 'processing_error' },
      { connector: 'stripe', status: 'charged' },
    ];
    const r = await ctx.api('POST', '/api/wallet/topup', { amount: 2500 });
    const s = await ctx.api('POST', `/api/wallet/topup/${r.paymentId}/settle`, {});
    assert.equal(s.routing.length, 2, 'rerouting must be visible to the customer');
    assert.equal(s.routing[0].connector, 'paypal');
    gw.retryTrail = null;
  });
});

describe('booking flow', () => {
  let jobId, bids;
  test('a job can be posted once the wallet is funded', async () => {
    await ctx.refresh?.();
    const j = await ctx.api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Kitchen tap dripping steadily',
      address: '118 Mathilda Pl', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString(),
      isEmergency: false,
    });
    jobId = j.id;
    assert.ok(jobId);
  });
  test('bids arrive priced with the fee already applied', async () => {
    const d = await ctx.api('GET', `/api/jobs/${jobId}`);
    bids = d.bids;
    assert.equal(bids.length, 3);
    for (const b of bids) assert.ok(b.charge > b.amount, 'the customer fee is missing');
  });
  test('the bids screen renders every provider with trust signals', async () => {
    ctx.S.job = { id: jobId, state: 'OPEN_FOR_BIDS', service: 'Plumbing' };
    ctx.S.bids = bids; ctx.go('bids'); await settle();
    const markup = html();
    for (const b of bids) assert.ok(markup.includes(escd(b.trade)), `${b.trade} missing from the list`);
    assert.match(markup, /★|rating|jobs/i, 'no rating or job count shown');
  });
  test('accepting a bid authorizes and hands back a client secret', async () => {
    const a = await ctx.api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id });
    assert.ok(a.clientSecret);
    assert.equal(a.economics.charge, bids[0].charge);
    const done = await ctx.api('POST', `/api/jobs/${jobId}/authorized`, { bidId: bids[0].id });
    assert.equal(done.status, 'SCHEDULED');
  });
  test('the wallet is untouched by booking', async () => {
    const me = await ctx.api('GET', '/api/me');
    assert.equal(me.wallet, 7500, 'jobs charge the card, not the wallet');
  });
});

describe('tracking and cancellation', () => {
  let jobId, bids;
  before(async () => {
    const j = await ctx.api('POST', '/api/jobs', {
      service: 'Electrical', description: 'Sockets dead in the back bedroom',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString(), isEmergency: false });
    jobId = j.id;
    bids = (await ctx.api('GET', `/api/jobs/${jobId}`)).bids;
    await ctx.api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id });
    await ctx.api('POST', `/api/jobs/${jobId}/authorized`, { bidId: bids[0].id });
  });

  test('the track screen shows the cancellation cost before you tap', async () => {
    const d = await ctx.api('GET', `/api/jobs/${jobId}`);
    ctx.S.job = d.job; ctx.S.bids = d.bids; ctx.go('track'); await settle();
    const markup = html();
    assert.match(markup, /cancel/i, 'no way to cancel from the tracking screen');
    for (const h of handlersIn(markup)) assert.equal(typeof ctx[h], 'function', `handler ${h}() missing`);
  });
  test('cancelling before en route charges nothing', async () => {
    const c = await ctx.api('POST', `/api/jobs/${jobId}/cancel`, {});
    assert.equal(c.tier, 'VOID');
    assert.equal(c.charged, 0);
  });
});

describe('completion, review and tip', () => {
  let jobId, bids;
  before(async () => {
    const j = await ctx.api('POST', '/api/jobs', {
      service: 'Plumbing', description: 'Shower mixer is stuck on cold',
      address: 'x', scheduledFor: new Date(Date.now() + 2 * 3.6e6).toISOString(), isEmergency: false });
    jobId = j.id;
    bids = (await ctx.api('GET', `/api/jobs/${jobId}`)).bids;
    await ctx.api('POST', `/api/jobs/${jobId}/accept`, { bidId: bids[0].id });
    await ctx.api('POST', `/api/jobs/${jobId}/authorized`, { bidId: bids[0].id });
    for (let i = 0; i < 4; i++) await ctx.api('POST', `/api/jobs/${jobId}/advance`, {});
  });
  test('the review screen offers a rating and tips', async () => {
    const d = await ctx.api('GET', `/api/jobs/${jobId}`);
    ctx.S.job = d.job; ctx.S.bids = d.bids; ctx.go('review'); await settle();
    const markup = html();
    assert.match(markup, /tip/i, 'no tipping on the review screen');
    assert.match(markup, /★/, 'no star rating');
    for (const h of handlersIn(markup)) assert.equal(typeof ctx[h], 'function', `handler ${h}() missing`);
  });
  test('a tip moves wallet money and is refused when unaffordable', async () => {
    const before = (await ctx.api('GET', '/api/me')).wallet;
    const t = await ctx.api('POST', `/api/jobs/${jobId}/tip`, { amount: 500 });
    assert.equal(t.wallet, before - 500);
    await assert.rejects(() => ctx.api('POST', `/api/jobs/${jobId}/tip`, { amount: 99999999 }));
  });
});

describe('job history', () => {
  test('past jobs are listed with their outcome', async () => {
    const jobs = await ctx.api('GET', '/api/jobs');
    assert.ok(jobs.length >= 3, 'a marketplace needs a history');
    ctx.S.jobs = jobs; ctx.go('jobs'); await settle();
    const markup = html();
    assert.ok(markup.includes('Plumbing') || markup.includes('Electrical'), 'no past jobs rendered');
    assert.match(markup, /COMPLETED|Completed|Cancelled|CANCELLED/, 'outcomes are not shown');
  });
});

describe('graceful degradation', () => {
  test('a missing Hyperswitch SDK surfaces an error instead of a blank screen', async () => {
    assert.equal(typeof ctx.Hyper, 'undefined', 'SDK should be absent in this harness');
    let threw = null;
    try { await ctx.mountPayment?.('cs_test', 'payslot', () => {}); }
    catch (e) { threw = e; }
    assert.ok(threw, 'mountPayment must fail loudly when the SDK is unavailable');
  });
  test('an API error reaches the user as a message, not a crash', async () => {
    await assert.rejects(() => ctx.api('POST', '/api/jobs/job_nope/advance', {}), /.+/);
  });
});
