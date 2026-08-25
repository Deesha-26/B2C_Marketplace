import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { open, now, uid } from './db.js';
import { economics, WALLET_FLOOR, MIN_TOPUP, PENALTY, fmt } from './money.js';
import {
  Ledger, debit, credit, GATEWAY_SETTLED, AUTH_RECEIVABLE, ESCROW,
  PLATFORM_REVENUE, REFUND_IN_TRANSIT, PROVIDER_CLAWBACK,
  customerWallet, providerWallet,
} from './ledger.js';
import * as hs from './hyperswitch.js';
import { assess } from './intelligence/risk.js';
import { topupRequest, authorizeRequest } from './intelligence/strategy.js';
import { planCancellation, planCompletion, planProviderCancellation } from './intelligence/settlement.js';
import { verifySignature, claimEvent, apply } from './webhooks.js';
import { AuthWatchdog } from './watchdog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = open(process.env.DB_PATH || 'swoop.db');
const ledger = new Ledger(db);
const app = express();

/* The webhook route needs the RAW body to verify the HMAC, so it is registered
   before the JSON parser and given its own raw parser. */
app.post('/api/webhooks/hyperswitch', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body.toString('utf8');
  const ok = verifySignature(raw, req.get('x-webhook-signature-512'), process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY);
  if (!ok) return res.status(401).json({ error: 'bad signature' });

  const event = JSON.parse(raw);
  const eventId = event.event_id || event.id;
  if (!eventId) return res.status(400).json({ error: 'missing event_id' });

  // Claim and apply in one transaction: a duplicate delivery collides on the
  // primary key and rolls back without touching the ledger.
  db.exec('BEGIN');
  try {
    if (!claimEvent(db, eventId, event.event_type, event.content?.object?.payment_id)) {
      db.exec('ROLLBACK');
      return res.status(200).json({ status: 'duplicate ignored' });
    }
    const result = apply(db, event);
    settleFromWebhook(event, result);
    db.exec('COMMIT');
    // 2xx as soon as it is durably stored. Slow handlers get retried.
    res.status(200).json({ status: 'ok', result });
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('webhook', err);
    res.status(500).json({ error: 'processing failed' });
  }
});

/**
 * Webhooks are the durable path for money, not just a status feed. If the
 * browser is closed after paying, this is the only thing that credits the
 * wallet — so the ledger posting happens here, inside the same transaction that
 * claimed the event id.
 */
function settleFromWebhook(event, result) {
  const type = event.event_type || event.type;
  const data = event.content?.object || event.data?.object || {};

  if (type === 'payment_succeeded' || type === 'payment_captured') {
    const row = db.prepare('SELECT * FROM payments WHERE payment_id = ?').get(data.payment_id);
    if (!row || row.purpose !== 'wallet_topup') return;
    const key = `topup:${row.payment_id}:credit`;
    if (db.prepare('SELECT 1 FROM idempotency WHERE key = ?').get(key)) return;
    ledger.post({ userId: row.user_id, reason: 'WALLET_TOPUP', gatewayRef: row.payment_id,
      inTransaction: true,
      entries: [debit(GATEWAY_SETTLED, row.amount), credit(customerWallet(row.user_id), row.amount)] });
    db.prepare('INSERT INTO idempotency (key,result,created_at) VALUES (?,?,?)')
      .run(key, JSON.stringify({ credited: row.amount }), now());
  }

  if (type === 'refund_succeeded') {
    const r = db.prepare('SELECT * FROM refunds WHERE refund_id = ?').get(data.refund_id);
    if (!r) return;
    const key = `refund:${r.refund_id}:settle`;
    if (db.prepare('SELECT 1 FROM idempotency WHERE key = ?').get(key)) return;
    // Clears REFUND_IN_TRANSIT, which withdrawal opens and nothing else closed.
    ledger.post({ reason: 'REFUND_SETTLED', gatewayRef: r.refund_id, inTransaction: true,
      entries: [debit(REFUND_IN_TRANSIT, r.amount), credit(GATEWAY_SETTLED, r.amount)] });
    db.prepare('INSERT INTO idempotency (key,result,created_at) VALUES (?,?,?)')
      .run(key, JSON.stringify({ settled: r.amount }), now());
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---- demo auth: a header, not a real session. Replace before production. ---- */
const userOf = req => {
  const id = req.get('x-swoop-user') || 'usr_demo';
  let u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) {
    db.prepare('INSERT INTO users (id,email,name,created_at) VALUES (?,?,?,?)')
      .run(id, `${id}@example.com`, 'Alex', now());
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return u;
};
/** 404s cleanly instead of letting undefined propagate into a 500. */
class NotFound extends Error { constructor(m='not found'){ super(m); this.status = 404; } }
class Conflict extends Error { constructor(m){ super(m); this.status = 409; } }

function mustJob(req) {
  const u = userOf(req);
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, u.id);
  if (!job) throw new NotFound('Job not found.');
  return { u, job };
}
function mustAcceptedBid(job) {
  if (!job.accepted_bid_id) throw new Conflict('That job has no accepted bid.');
  const bid = db.prepare('SELECT * FROM bids WHERE id=?').get(job.accepted_bid_id);
  if (!bid) throw new NotFound('Accepted bid not found.');
  return bid;
}
function mustHold(job) {
  const row = db.prepare("SELECT * FROM payments WHERE job_id=? AND purpose='job_authorization'").get(job.id);
  if (!row) throw new Conflict('That job has no authorization.');
  return row;
}

/**
 * Keeps the local payments row in step with the gateway after every capture or
 * void. Without this the table keeps reporting a settled hold as outstanding
 * and reconciliation silently drifts.
 */
function syncPayment(paymentId, gatewayResponse) {
  db.prepare(`UPDATE payments SET status=?, amount_captured=?, connector=?, attempts=?,
                capture_by=?, updated_at=? WHERE payment_id=?`)
    .run(gatewayResponse.status,
         gatewayResponse.amount_captured ?? 0,
         gatewayResponse.connector ?? null,
         JSON.stringify(gatewayResponse.attempts ?? []),
         hs.captureDeadline(gatewayResponse),
         now(), paymentId);
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message, code: err.code });
});

/* Derived idempotency: a retry of the same logical operation reuses the key,
   so a double-tap cannot create a second authorization. */
function onceOnly(key, fn) {
  const hit = db.prepare('SELECT result FROM idempotency WHERE key = ?').get(key);
  if (hit) return JSON.parse(hit.result);
  const result = fn();
  db.prepare('INSERT INTO idempotency (key,result,created_at) VALUES (?,?,?)')
    .run(key, JSON.stringify(result), now());
  return result;
}

/* ---------------------------------------------------------------- config ---- */
app.get('/api/config', (req, res) => res.json({
  publishableKey: hs.publishableKey(),
  walletFloor: WALLET_FLOOR, minTopup: MIN_TOPUP, penalty: PENALTY,
}));

/* ------------------------------------------------------------------ me ------ */
/**
 * How much of the wallet can actually be returned to a card.
 *
 * A refund must reverse a real payment, so compensation credited by a provider
 * cancellation has no payment behind it and cannot be withdrawn. Wallet balance
 * and withdrawable capacity are therefore different numbers, and the UI has to
 * show the smaller one.
 */
function withdrawable(userId) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount - amount_refunded),0) AS t FROM payments
                        WHERE user_id=? AND purpose='wallet_topup' AND status='succeeded'`).get(userId);
  return Math.max(0, Math.min(ledger.walletOf(userId), Number(r.t)));
}

app.get('/api/me', wrap(async (req, res) => {
  const u = userOf(req);
  const bal = ledger.walletOf(u.id);
  res.json({
    user: { id: u.id, name: u.name, email: u.email },
    wallet: bal,
    withdrawable: withdrawable(u.id),
    canBook: bal >= WALLET_FLOOR,
    activity: ledger.history(u.id, 50),
  });
}));

app.get('/api/cards', wrap(async (req, res) => {
  const u = userOf(req);
  try {
    const list = await hs.listSavedCards(u.id);
    res.json(list.customer_payment_methods ?? []);
  } catch {
    res.json([]);   // no vaulted cards yet is not an error
  }
}));

/* ------------------------------------------------------- wallet top-up ------ */
app.post('/api/wallet/topup', wrap(async (req, res) => {
  const u = userOf(req);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < MIN_TOPUP) {
    return res.status(400).json({ error: `Minimum top-up is ${fmt(MIN_TOPUP)}.` });
  }
  const body = topupRequest({
    user: u, amount,
    saveCard: !!req.body.saveCard,
    savedPaymentMethodId: req.body.paymentMethodId,
  });
  const payment = await hs.createPayment(body, `topup:${u.id}:${Date.now()}`);
  db.prepare(`INSERT INTO payments (payment_id,user_id,purpose,amount,status,capture_method,
                client_secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(payment.payment_id, u.id, 'wallet_topup', amount, payment.status, 'automatic',
         payment.client_secret, now(), now());
  // The browser gets the client_secret only — never the secret key.
  res.json({ paymentId: payment.payment_id, clientSecret: payment.client_secret });
}));

/* Called by the client after the SDK reports success. The ledger credit is
   idempotent, so a webhook arriving first or second is harmless. */
app.post('/api/wallet/topup/:id/settle', wrap(async (req, res) => {
  const u = userOf(req);
  const payment = await hs.retrievePayment(req.params.id);
  const row = db.prepare('SELECT * FROM payments WHERE payment_id = ? AND user_id = ?')
    .get(req.params.id, u.id);
  if (!row) return res.status(404).json({ error: 'unknown payment' });

  const trail = hs.routingTrail(payment);
  syncPayment(row.payment_id, payment);

  if (payment.status === 'succeeded') {
    onceOnly(`topup:${row.payment_id}:credit`, () => {
      ledger.post({ userId: u.id, reason: 'WALLET_TOPUP', gatewayRef: row.payment_id,
        entries: [debit(GATEWAY_SETTLED, row.amount), credit(customerWallet(u.id), row.amount)] });
      return { credited: row.amount };
    });
  }
  res.json({ status: payment.status, wallet: ledger.walletOf(u.id), routing: trail });
}));

/* -------------------------------------------------------------- jobs -------- */
const PROVIDERS = [
  { id: 'prov_1', name: 'Ravi Ganesan', trade: 'Ganesan Plumbing', rating: 4.9, jobs: 412, mins: 22, base: 9000,
    note: 'Includes replacing the cartridge and testing for further leaks.' },
  { id: 'prov_2', name: 'Dana Whitlock', trade: 'Whitlock & Sons', rating: 4.7, jobs: 188, mins: 35, base: 7500,
    note: 'Callout plus one hour of labour. Parts billed separately if needed.' },
  { id: 'prov_3', name: 'Marcus Oyelaran', trade: 'Bayline Mechanical', rating: 5.0, jobs: 96, mins: 14, base: 12500,
    note: 'Same-day, fully insured, 12-month workmanship guarantee.' },
];

app.post('/api/jobs', wrap(async (req, res) => {
  const u = userOf(req);
  if (ledger.walletOf(u.id) < WALLET_FLOOR) {
    return res.status(402).json({ error: `Keep at least ${fmt(WALLET_FLOOR)} in your wallet to book.` });
  }
  const { service, description, address, scheduledFor, isEmergency } = req.body;
  if (!description || description.length < 8) return res.status(400).json({ error: 'Describe the job in a sentence or two.' });

  const id = uid('job');
  db.prepare(`INSERT INTO jobs (id,user_id,service,description,address,scheduled_for,is_emergency,state,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, u.id, service, description, address, scheduledFor, isEmergency ? 1 : 0, 'OPEN_FOR_BIDS', now());

  // Stand-in for real providers bidding.
  const expires = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  for (const p of PROVIDERS) {
    db.prepare(`INSERT INTO bids (id,job_id,provider_id,provider_name,trade,rating,jobs_done,
                  eta_minutes,amount,note,placed_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid('bid'), id, p.id, p.name, p.trade, p.rating, p.jobs, p.mins,
           isEmergency ? Math.round(p.base * 1.2) : p.base, p.note, now(), expires);
  }
  res.json({ id });
}));

app.get('/api/jobs', wrap(async (req, res) => {
  const u = userOf(req);
  res.json(db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC').all(u.id));
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  const u = userOf(req);
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, u.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const live = db.prepare('SELECT * FROM bids WHERE job_id=? AND expires_at > ? ORDER BY amount')
    .all(job.id, now());
  const payment = db.prepare("SELECT * FROM payments WHERE job_id=? AND purpose='job_authorization'").get(job.id);
  res.json({
    job,
    bids: live.map(b => ({ ...b, ...economics(b.amount) })),
    events: db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY id').all(job.id),
    payment: payment ? {
      id: payment.payment_id, status: payment.status, amount: payment.amount,
      captureBy: payment.capture_by, extendedAt: payment.extended_at,
      routing: JSON.parse(payment.attempts || '[]'),
    } : null,
  });
}));

/* ---- accept a bid: authorize the exact bid + fee, no connector named ------- */
app.post('/api/jobs/:id/accept', wrap(async (req, res) => {
  const u = userOf(req);
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, u.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.state !== 'OPEN_FOR_BIDS') return res.status(409).json({ error: `Job is already ${job.state}.` });

  const bid = db.prepare('SELECT * FROM bids WHERE id=? AND job_id=?').get(req.body.bidId, job.id);
  if (!bid) return res.status(404).json({ error: 'bid not found' });
  if (new Date(bid.expires_at) < new Date()) return res.status(410).json({ error: 'That bid has expired.' });

  const history = {
    completedJobs: db.prepare("SELECT COUNT(*) c FROM jobs WHERE user_id=? AND state='COMPLETED'").get(u.id).c,
    providerClawback: ledger.raw(PROVIDER_CLAWBACK),
  };
  const risk = assess({ job, amount: economics(bid.amount).charge, history });
  const { request, economics: e } = authorizeRequest({ user: u, job, bid, risk });

  const payment = await hs.createPayment(request, `${job.id}:authorize`);
  // Record the chosen bid now. Taking it from the client on the follow-up call
  // let a missing field orphan the job with no accepted bid.
  db.prepare('UPDATE jobs SET accepted_bid_id=? WHERE id=?').run(bid.id, job.id);
  db.prepare(`INSERT INTO payments (payment_id,user_id,job_id,purpose,amount,status,capture_method,
                capture_by,client_secret,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(payment.payment_id, u.id, job.id, 'job_authorization', e.charge, payment.status,
         'manual', hs.captureDeadline(payment), payment.client_secret, now(), now());

  res.json({
    paymentId: payment.payment_id, clientSecret: payment.client_secret,
    economics: e, risk: { level: risk.level, signals: risk.signals, extendedAuth: risk.needsExtendedAuth },
  });
}));

/* Confirmed by the SDK — record the hold and move the job to SCHEDULED. */
app.post('/api/jobs/:id/authorized', wrap(async (req, res) => {
  const u = userOf(req);
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, u.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const row = mustHold(job);
  const payment = await hs.retrievePayment(row.payment_id);

  db.prepare('UPDATE payments SET status=?,connector=?,attempts=?,capture_by=?,updated_at=? WHERE payment_id=?')
    .run(payment.status, payment.connector ?? null, JSON.stringify(payment.attempts ?? []),
         hs.captureDeadline(payment), now(), row.payment_id);

  if (payment.status !== 'requires_capture') {
    return res.status(402).json({ status: payment.status, routing: hs.routingTrail(payment) });
  }
  onceOnly(`${job.id}:hold`, () => {
    ledger.post({ userId: u.id, jobId: job.id, reason: 'JOB_AUTHORIZED', gatewayRef: row.payment_id,
      entries: [debit(AUTH_RECEIVABLE, row.amount), credit(ESCROW, row.amount)] });
    db.prepare('UPDATE jobs SET state=? WHERE id=?').run('SCHEDULED', job.id);
    return { held: row.amount };
  });
  res.json({ status: 'SCHEDULED', routing: hs.routingTrail(payment), captureBy: hs.captureDeadline(payment) });
}));

/* ---- provider progress (stands in for the provider app) ------------------- */
const NEXT = { SCHEDULED: 'EN_ROUTE', EN_ROUTE: 'ARRIVED', ARRIVED: 'IN_PROGRESS', IN_PROGRESS: 'COMPLETED' };

app.post('/api/jobs/:id/advance', wrap(async (req, res) => {
  const { u, job } = mustJob(req);
  const next = NEXT[job.state];
  if (!next) return res.status(409).json({ error: `Cannot advance from ${job.state}.` });

  db.prepare('INSERT INTO job_events (job_id,kind,lat,lng,at) VALUES (?,?,?,?,?)')
    .run(job.id, next, req.body.lat ?? null, req.body.lng ?? null, now());

  if (next !== 'COMPLETED') {
    db.prepare('UPDATE jobs SET state=? WHERE id=?').run(next, job.id);
    return res.json({ state: next });
  }
  const bid = mustAcceptedBid(job);
  const row = mustHold(job);
  const plan = planCompletion(bid.amount);

  syncPayment(row.payment_id, await hs.capturePayment(row.payment_id, plan.captureAmount, `${job.id}:capture`));
  ledger.post({ userId: u.id, jobId: job.id, reason: 'JOB_CAPTURED', gatewayRef: row.payment_id,
    entries: [debit(GATEWAY_SETTLED, plan.charged), credit(AUTH_RECEIVABLE, plan.charged)] });
  ledger.post({ userId: u.id, jobId: job.id, reason: 'JOB_SETTLED', gatewayRef: row.payment_id,
    entries: [debit(ESCROW, plan.charged), credit(providerWallet(bid.provider_id), plan.toProvider),
              credit(PLATFORM_REVENUE, plan.toPlatform)] });
  db.prepare('UPDATE jobs SET state=? WHERE id=?').run('COMPLETED', job.id);
  res.json({ state: 'COMPLETED', charged: plan.charged, economics: plan.economics });
}));

/* ---- cancellation: void, partial capture, or full capture ----------------- */
app.post('/api/jobs/:id/cancel', wrap(async (req, res) => {
  const { u, job } = mustJob(req);
  if (!planCancellation(job.state, 1)) return res.status(409).json({ error: `Cannot cancel a job that is ${job.state}.` });
  const bid = mustAcceptedBid(job);
  const row = mustHold(job);
  const plan = planCancellation(job.state, bid.amount);

  const e = plan.economics;
  if (plan.operation === 'void') {
    syncPayment(row.payment_id, await hs.voidPayment(row.payment_id, `${job.id}:void`));
    ledger.post({ userId: u.id, jobId: job.id, reason: 'CANCELLED_PRE_ENROUTE', gatewayRef: row.payment_id,
      entries: [debit(ESCROW, e.charge), credit(AUTH_RECEIVABLE, e.charge)] });
  } else {
    syncPayment(row.payment_id, await hs.capturePayment(row.payment_id, plan.captureAmount, `${job.id}:capture`));
    ledger.post({ userId: u.id, jobId: job.id, reason: 'CANCEL_CAPTURE', gatewayRef: row.payment_id,
      entries: [debit(GATEWAY_SETTLED, plan.charged), credit(AUTH_RECEIVABLE, plan.charged)] });
    if (plan.released > 0) {
      ledger.post({ userId: u.id, jobId: job.id, reason: 'CANCEL_VOID_REMAINDER', gatewayRef: row.payment_id,
        entries: [debit(ESCROW, plan.released), credit(AUTH_RECEIVABLE, plan.released)] });
    }
    const out = [debit(ESCROW, plan.charged), credit(providerWallet(bid.provider_id), plan.toProvider)];
    if (plan.toPlatform > 0) out.push(credit(PLATFORM_REVENUE, plan.toPlatform));
    ledger.post({ userId: u.id, jobId: job.id, reason: 'CANCEL_SETTLE', gatewayRef: row.payment_id, entries: out });
  }
  db.prepare('UPDATE jobs SET state=? WHERE id=?').run('CANCELLED_BY_CUSTOMER', job.id);
  res.json({ tier: plan.tier, charged: plan.charged, released: plan.released, summary: plan.summary });
}));

/* ---- provider pulls out: void the hold, pay the customer $30 -------------- */
app.post('/api/jobs/:id/provider-cancel', wrap(async (req, res) => {
  const { u, job } = mustJob(req);
  if (job.state !== 'SCHEDULED') return res.status(409).json({ error: 'A provider cannot cancel once en route.' });
  const bid = mustAcceptedBid(job);
  const row = mustHold(job);
  const plan = planProviderCancellation(bid.amount);

  syncPayment(row.payment_id, await hs.voidPayment(row.payment_id, `${job.id}:void`));
  ledger.post({ userId: u.id, jobId: job.id, reason: 'PROVIDER_CANCELLED', gatewayRef: row.payment_id,
    entries: [debit(ESCROW, plan.economics.charge), credit(AUTH_RECEIVABLE, plan.economics.charge)] });

  // Wallet-to-wallet. The provider's balance may go negative; that becomes a
  // clawback that blocks their future withdrawals.
  const bal = ledger.providerBalance(bid.provider_id);
  const fromWallet = Math.max(0, Math.min(plan.compensation, bal));
  const toClawback = plan.compensation - fromWallet;
  const entries = [];
  if (fromWallet > 0) entries.push(debit(providerWallet(bid.provider_id), fromWallet));
  if (toClawback > 0) entries.push(debit(PROVIDER_CLAWBACK, toClawback));
  entries.push(credit(customerWallet(u.id), plan.compensation));
  ledger.post({ userId: u.id, jobId: job.id, reason: 'PROVIDER_PENALTY', entries });

  db.prepare('UPDATE jobs SET state=? WHERE id=?').run('CANCELLED_BY_PROVIDER', job.id);
  res.json({ compensation: plan.compensation, wallet: ledger.walletOf(u.id) });
}));

/* ---- tips: paid from the wallet, 100% to the provider --------------------- */
app.post('/api/jobs/:id/tip', wrap(async (req, res) => {
  const { u, job } = mustJob(req);
  if (job.state !== 'COMPLETED') return res.status(409).json({ error: 'Tips are for completed jobs.' });
  const bid = mustAcceptedBid(job);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid tip.' });
  if (amount > ledger.walletOf(u.id)) return res.status(402).json({ error: 'That is more than your wallet holds.' });

  onceOnly(`${job.id}:tip`, () => {
    ledger.post({ userId: u.id, jobId: job.id, reason: 'TIP',
      entries: [debit(customerWallet(u.id), amount), credit(providerWallet(bid.provider_id), amount)] });
    return { amount };
  });
  res.json({ wallet: ledger.walletOf(u.id) });
}));

/* ---- refunds: withdrawal, and job disputes upheld ------------------------- */
app.post('/api/wallet/withdraw', wrap(async (req, res) => {
  const u = userOf(req);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter a whole amount greater than zero.' });
  }
  if (amount > ledger.walletOf(u.id)) return res.status(402).json({ error: 'More than your balance.' });

  // Check capacity BEFORE moving anything. Issuing refunds lot by lot and then
  // failing part-way left the customer with an error and a debited wallet.
  const capacity = withdrawable(u.id);
  if (amount > capacity) {
    return res.status(409).json({
      error: capacity === 0
        ? 'None of your balance came from a card payment, so there is nothing to return.'
        : `Only ${fmt(capacity)} can be returned to your card. The rest came from Swoop credit.`,
      withdrawable: capacity,
    });
  }

  // A refund must name the payment it reverses, so draw down top-up lots in order.
  const lots = db.prepare(`SELECT * FROM payments WHERE user_id=? AND purpose='wallet_topup'
                           AND status='succeeded' ORDER BY created_at`).all(u.id);
  let left = amount; const issued = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const available = lot.amount - lot.amount_refunded;
    if (available <= 0) continue;
    const take = Math.min(available, left);
    const r = await hs.createRefund({ paymentId: lot.payment_id, amount: take, reason: 'wallet withdrawal' },
      `${lot.payment_id}:withdraw:${Date.now()}`);
    db.prepare('INSERT INTO refunds (refund_id,payment_id,amount,status,reason,created_at) VALUES (?,?,?,?,?,?)')
      .run(r.refund_id, lot.payment_id, take, r.status, 'withdrawal', now());
    db.prepare('UPDATE payments SET amount_refunded = amount_refunded + ? WHERE payment_id=?')
      .run(take, lot.payment_id);
    ledger.post({ userId: u.id, reason: 'WITHDRAWAL', gatewayRef: r.refund_id,
      entries: [debit(customerWallet(u.id), take), credit(REFUND_IN_TRANSIT, take)] });
    issued.push({ refundId: r.refund_id, amount: take, paymentId: lot.payment_id });
    left -= take;
  }
  // Capacity was verified up front, so this should be unreachable.
  if (left > 0) console.error(`withdrawal shortfall of ${left} for ${u.id} — capacity check is wrong`);
  res.json({ refunds: issued, wallet: ledger.walletOf(u.id), withdrawable: withdrawable(u.id) });
}));

/* ---------------------------------------------------------------- boot ----- */
/* Importing this module must not start a server or a background sweep — tests
   import it to drive routes directly. */
export function start(port = process.env.PORT || 3000) {
  new AuthWatchdog(db).start();
  return app.listen(port, () => console.log(`Swoop on http://localhost:${port}`));
}
if (process.env.SWOOP_AUTOSTART !== 'false') start();

export { app, db, ledger };
