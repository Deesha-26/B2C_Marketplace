import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { open, now, uid } from './db/index.js';
import { economics, PENALTY, WALLET_FLOOR, MIN_TOPUP, CUSTOMER_FEE, LEAD_FEE, fmt } from './money.js';
import {
  Ledger, jobCompleted, cancelledPreTravel, cancelledEnRoute, cancelledInProgress, tip as tipPosting,
  simulatedWithdrawal, customerWallet, isSimulated,
} from './ledger/index.js';
import * as hs from './hyperswitch.js';
import { PaymentFlow } from './payments/flow.js';
import * as ops from './payments/operations.js';
import { jobPaymentKey, walletTopUpKey } from './payments/ids.js';
import { verifySignature, claimEvent, isRegression } from './webhooks.js';
import { STATES, nextState, cancellationTier, cancellationPreview,
         SEED_PROVIDERS, bidAmountFor } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = await open();
const ledger = new Ledger(db);
const flow = new PaymentFlow(db, hs);
const app = express();

/* ===========================================================================
   Webhook — registered BEFORE the JSON parser.
   Signature verification needs the exact bytes; a parsed-and-reserialised body
   produces a different HMAC and every webhook would 401.
   =========================================================================== */
app.post('/api/webhooks/hyperswitch', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  let ok;
  try {
    ok = verifySignature(raw, req.get('x-webhook-signature-512'),
      process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!ok) return res.status(401).json({ error: 'bad signature' });

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'unparsable body' }); }
  const eventId = event.event_id ?? event.id;
  if (!eventId) return res.status(400).json({ error: 'missing event_id' });

  const paymentId = event.content?.object?.payment_id ?? event.data?.object?.payment_id;

  try {
    // Retrieve BEFORE opening a transaction — never hold a pooled connection
    // across a network call.
    const operation = paymentId ? await ops.getByPaymentId(db, paymentId) : null;
    let retrieved = null;
    if (operation) {
      const outcome = await flow.retrieveOutcome(paymentId);
      if (outcome.kind === 'unknown') {
        // Cannot verify. Do not claim the event, so Hyperswitch retries.
        return res.status(503).json({ status: 'retry', reason: 'retrieval failed' });
      }
      retrieved = outcome.payment ?? null;
    }

    const result = await db.transaction(async t => {
      if (!await claimEvent(t, eventId, event.event_type, paymentId)) {
        return { duplicate: true };
      }
      if (!operation || !retrieved) return { ignored: 'no matching operation' };

      const locked = await t.one(
        'SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE', [paymentId]);
      if (locked && isRegression(locked.last_observed_external_status, retrieved.status)) {
        return { ignored: `late ${event.event_type} after ${locked.last_observed_external_status}` };
      }
      // Claim and effects commit together; a failure rolls back both.
      return flow.applyVerified(operation, retrieved, t);
    });

    if (result.duplicate) return res.status(200).json({ status: 'duplicate ignored' });
    return res.status(200).json({ status: 'ok', result });
  } catch (err) {
    console.error('webhook', err);
    // Rolled back, including the event claim, so the retry is processed.
    return res.status(500).json({ error: 'processing failed' });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ---------------------------------------------------------------- identity */
/**
 * Round 1 identity: an unguessable UUID generated in the browser on first visit.
 * Not authentication — there is no session, token or password. Deferred.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function userOf(req) {
  const id = req.get('x-swoop-user');
  if (!id || !UUID_RE.test(id)) {
    const e = new Error('A valid x-swoop-user UUID is required.');
    e.status = 401; throw e;
  }
  let u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) {
    await db.none('INSERT INTO users (id, display_email) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, req.get('x-swoop-email') ?? null]);
    u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  }
  return u;
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message, code: err.code });
});
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };

async function mustJob(req, user) {
  const job = await db.one('SELECT * FROM jobs WHERE id = $1 AND user_id = $2',
    [req.params.id, user.id]);
  if (!job) fail(404, 'Job not found.');
  return job;
}
const acceptedBid = job => job.accepted_bid_id
  ? db.one('SELECT * FROM bids WHERE id = $1', [job.accepted_bid_id])
  : null;

const walletOf = userId => ledger.balance(customerWallet(userId));

/* ============================================================ 1. config === */
app.get('/api/config', (req, res) => res.json({
  publishableKey: hs.publishableKey(),
  paymentReady: Boolean(hs.publishableKey()),
  walletFloor: WALLET_FLOOR,
  minTopUp: MIN_TOPUP,
  travelCompensation: PENALTY,
  customerFeeRate: CUSTOMER_FEE,
  providerLeadFeeRate: LEAD_FEE,
  // Round 1 captures at approval and reserves internally. The UI must say so.
  settlement: 'captured_and_reserved',
}));

/* ================================================================ 2. me === */
app.get('/api/me', wrap(async (req, res) => {
  const u = await userOf(req);
  const balance = await walletOf(u.id);
  const activity = await ledger.activity(u.id, 50);
  res.json({
    user: { id: u.id, email: u.display_email },
    wallet: balance,
    // Every Round 1 wallet cent traces to a captured payment, so the whole
    // balance is withdrawable. Withdrawal itself is simulated.
    withdrawable: balance,
    canBook: balance >= WALLET_FLOOR,
    activity: activity.map(a => ({
      id: a.id, reason: a.reason, jobId: a.job_id, paymentId: a.payment_id,
      walletDelta: Number(a.wallet_delta), at: a.created_at,
      simulated: isSimulated({ metadata: a.metadata }),
    })),
  });
}));

/* ====================================================== 3. wallet top-up == */
app.post('/api/wallet/topup', wrap(async (req, res) => {
  const u = await userOf(req);
  const amount = Number(req.body.amount);
  const requestId = String(req.body.requestId ?? '').trim();
  if (!Number.isInteger(amount) || amount < MIN_TOPUP) {
    fail(400, `Minimum top-up is ${fmt(MIN_TOPUP)}.`);
  }
  // Keyed per request, not per user: a customer may top up more than once.
  if (!requestId) fail(400, 'requestId is required so repeated taps cannot create two payments.');

  const started = await flow.start({
    operationKey: walletTopUpKey(u.id, requestId),
    kind: 'wallet_topup', userId: u.id, purpose: 'wallet_topup',
    amount, currency: 'USD',
  }, paymentId => ({
    payment_id: paymentId, amount, currency: 'USD',
    capture_method: 'automatic',          // the only path Diagnostic B verified
    authentication_type: 'no_three_ds',   // 3DS completion is unverified
    confirm: false,                       // the SDK confirms in the browser
    customer_id: u.id,
    description: 'Swoop wallet top-up',
    metadata: { swoop_user_id: u.id, purpose: 'wallet_topup' },
  }));

  res.json({
    paymentId: started.paymentId,
    clientSecret: started.payment?.client_secret ?? null,
    alreadyStarted: started.status === 'existing',
  });
}));

/* ============================================ 4. wallet top-up reconcile == */
app.post('/api/wallet/topup/:requestId/reconcile', wrap(async (req, res) => {
  const u = await userOf(req);
  const operationKey = walletTopUpKey(u.id, req.params.requestId);
  const operation = await ops.get(db, operationKey);

  if (!operation) {
  fail(404, 'Payment operation not found.');
  }
  const result = await flow.reconcile({
    operationKey: walletTopUpKey(u.id, req.params.requestId),
    requestingUserId: u.id,
  });
  if (result.status === 'forbidden') fail(403, 'That operation belongs to another account.');
  res.json({ ...result, wallet: await walletOf(u.id) });
}));

/* ============================================================== 5. jobs === */
app.post('/api/jobs', wrap(async (req, res) => {
  const u = await userOf(req);
  if (await walletOf(u.id) < WALLET_FLOOR) {
    fail(402, `Keep at least ${fmt(WALLET_FLOOR)} in your Swoop wallet to book.`);
  }
  const { service, description, address, scheduledFor, isEmergency } = req.body;
  if (!service) fail(400, 'Choose a service.');
  if (!description || description.trim().length < 8) fail(400, 'Describe the job in a sentence or two.');
  if (!address) fail(400, 'Enter the job location.');
  const scheduledAt = Date.parse(scheduledFor);
  if (!scheduledFor || Number.isNaN(scheduledAt)) fail(400, 'Choose a date and time.');
  if (scheduledAt <= Date.now()) fail(400, 'Choose a future date and time.');

  const jobId = uid('job');
  await db.transaction(async t => {
    await t.none(
      `INSERT INTO jobs (id,user_id,service,description,address,scheduled_for,is_emergency,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [jobId, u.id, service, description.trim(), address, scheduledFor,
       !!isEmergency, STATES.OPEN_FOR_BIDS]);
    for (const p of SEED_PROVIDERS) {
      await t.none(
        `INSERT INTO bids (id,job_id,provider_id,provider_name,trade,rating,eta_minutes,amount,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uid('bid'), jobId, p.providerId, p.name, p.trade, p.rating, p.etaMinutes,
         bidAmountFor(p.base, isEmergency), p.note]);
    }
  });
  res.json({ id: jobId });
}));

app.get('/api/jobs', wrap(async (req, res) => {
  const u = await userOf(req);

  const jobs = await db.all(
    `SELECT id, service, description, address, scheduled_for,
            is_emergency, state, accepted_bid_id, created_at
       FROM jobs
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [u.id]
  );

  res.json(jobs);
}));

/* ========================================================== 6. job read === */
app.get('/api/jobs/:id', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  const bids = await db.all('SELECT * FROM bids WHERE job_id = $1 ORDER BY amount', [job.id]);
  const events = await db.all('SELECT * FROM job_events WHERE job_id = $1 ORDER BY id', [job.id]);
  const approval = await db.one(
    'SELECT * FROM approvals WHERE job_id = $1 ORDER BY approved_at DESC LIMIT 1', [job.id]);
  const payment = await db.one(
    "SELECT * FROM payments WHERE job_id = $1 AND purpose = 'job_payment'", [job.id]);
  const bid = await acceptedBid(job);

  res.json({
    job: { ...job, cancellation: bid ? cancellationPreview(job.state, bid.amount) : null },
    // Every bid carries the full breakdown the customer must approve.
    bids: bids.map(b => {
      const e = economics(b.amount);
      return { ...b, bidAmount: e.bid, feeAmount: e.fee, totalAmount: e.charge };
    }),
    events,
    approval,
    payment: payment && {
      paymentId: payment.payment_id,
      amount: approval ? Number(approval.total_amount) : 0,
      reconciliationState: payment.reconciliation_state,
      lastObservedExternalStatus: payment.last_observed_external_status,
      discrepancyReason: payment.discrepancy_reason,
    },
  });
}));

/* ====================================================== 7. approve ======== */
/**
 * Customer consent to a specific total. NOT a processor authorization — nothing
 * has been sent to Hyperswitch at this point. A price change creates a new
 * approval row; the old one is never mutated.
 */
app.post('/api/jobs/:id/approve', wrap(async (req, res) => {
  const u = await userOf(req);
  const outcome = await db.transaction(async t => {
    const job = await t.one('SELECT * FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, u.id]);
    if (!job) fail(404, 'Job not found.');
    const bid = await t.one('SELECT * FROM bids WHERE id = $1 AND job_id = $2',
      [req.body.bidId, job.id]);
    if (!bid) fail(404, 'That bid is not on this job.');

    // Approval is the chargeable consent.  Reusing the same bid is idempotent;
    // choosing another one requires cancelling/reposting instead of leaving two
    // independently chargeable approvals on the same job.
    if (job.state === STATES.APPROVED) {
      if (job.accepted_bid_id !== bid.id) {
        fail(409, 'A bid is already approved for this job.');
      }
      const existing = await t.one(
        'SELECT * FROM approvals WHERE job_id = $1 AND bid_id = $2 ORDER BY approved_at DESC LIMIT 1',
        [job.id, bid.id]);
      if (!existing) throw new Error('Approved job has no approval record.');
      return { approval: existing, bid, existing: true };
    }
    if (job.state !== STATES.OPEN_FOR_BIDS) fail(409, `This job is already ${job.state}.`);

    const e = economics(bid.amount);
    const approval = {
      id: uid('appr'), job_id: job.id, bid_id: bid.id,
      bid_amount: e.bid, fee_amount: e.fee, total_amount: e.charge, currency: 'USD',
    };
    await t.none(
      `INSERT INTO approvals (id,job_id,bid_id,bid_amount,fee_amount,total_amount,currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [approval.id, approval.job_id, approval.bid_id, approval.bid_amount,
       approval.fee_amount, approval.total_amount, approval.currency]);
    await t.none('UPDATE jobs SET state = $2, accepted_bid_id = $3 WHERE id = $1',
      [job.id, STATES.APPROVED, bid.id]);
    return { approval, bid, existing: false };
  });

  res.json({
    approvalId: outcome.approval.id,
    alreadyApproved: outcome.existing,
    breakdown: { bidAmount: Number(outcome.approval.bid_amount), feeAmount: Number(outcome.approval.fee_amount),
                 totalAmount: Number(outcome.approval.total_amount), currency: outcome.approval.currency },
    provider: { id: outcome.bid.provider_id, name: outcome.bid.provider_name, trade: outcome.bid.trade },
  });
}));

/* =========================================================== 8. pay ======= */
app.post('/api/jobs/:id/pay', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  if (job.state !== STATES.APPROVED) fail(409, `Approve a bid before paying (job is ${job.state}).`);

  const approval = await db.one('SELECT * FROM approvals WHERE id = $1 AND job_id = $2',
    [req.body.approvalId, job.id]);
  if (!approval) fail(404, 'That approval does not belong to this job.');
  if (approval.bid_id !== job.accepted_bid_id) fail(409, 'That approval is no longer active.');

  const started = await flow.start({
    operationKey: jobPaymentKey(job.id, approval.id),
    kind: 'job_payment', userId: u.id, purpose: 'job_payment',
    jobId: job.id, approvalId: approval.id,
    amount: Number(approval.total_amount), currency: approval.currency,
  }, paymentId => ({
    payment_id: paymentId,
    amount: Number(approval.total_amount), currency: approval.currency,
    capture_method: 'automatic',
    authentication_type: 'no_three_ds',
    confirm: false,
    customer_id: u.id,
    description: `${job.service} — approved total`,
    metadata: { swoop_user_id: u.id, swoop_job_id: job.id, swoop_approval_id: approval.id },
  }));

  res.json({
    paymentId: started.paymentId,
    clientSecret: started.payment?.client_secret ?? null,
    alreadyStarted: started.status === 'existing',
    approvedTotal: Number(approval.total_amount),
  });
}));

/* ==================================================== 9. job reconcile ==== */
app.post('/api/jobs/:id/reconcile', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  const approval = await db.one(
    'SELECT * FROM approvals WHERE job_id = $1 AND bid_id = $2 ORDER BY approved_at DESC LIMIT 1',
    [job.id, job.accepted_bid_id]);
  if (!approval) fail(409, 'This job has no approval to reconcile.');

  const result = await flow.reconcile({
    operationKey: jobPaymentKey(job.id, approval.id),
    requestingUserId: u.id,
  });
  if (result.status === 'forbidden') fail(403, 'That operation belongs to another account.');

  // Only verified external capture moves the job forward.
  if (['verified', 'already_completed'].includes(result.status) && job.state === STATES.APPROVED) {
    await db.none('UPDATE jobs SET state = $2 WHERE id = $1 AND state = $3',
      [job.id, STATES.RESERVED, STATES.APPROVED]);
  }
  const after = await db.one('SELECT state FROM jobs WHERE id = $1', [job.id]);
  res.json({ ...result, jobState: after.state });
}));

/* ================================================ 10. attempts (live) ==== */
/**
 * Live passthrough. The attempt trail belongs to Hyperswitch and is deliberately
 * not stored: a copy could disagree with the source it is meant to evidence.
 */
app.get('/api/jobs/:id/attempts', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  const payment = await db.one(
    "SELECT payment_id FROM payments WHERE job_id = $1 AND purpose = 'job_payment'", [job.id]);
  if (!payment) fail(404, 'No payment on this job yet.');

  const retrieved =
  await flow.hs.retrievePayment(payment.payment_id);
  res.json({
    paymentId: payment.payment_id,
    finalStatus: retrieved.status,
    attempts: hs.routingTrail(retrieved),
  });
}));

/* ========================================================= 11. advance === */
app.post('/api/jobs/:id/advance', wrap(async (req, res) => {
  const u = await userOf(req);
  const result = await db.transaction(async t => {
    const job = await t.one('SELECT * FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, u.id]);
    if (!job) fail(404, 'Job not found.');
    const next = nextState(job.state);
    if (!next) fail(409, `Cannot advance a job that is ${job.state}.`);
    await t.none('UPDATE jobs SET state = $2 WHERE id = $1', [job.id, next]);
    await t.none('INSERT INTO job_events (job_id, kind, simulated) VALUES ($1,$2,TRUE)',
      [job.id, next]);
    const bid = job.accepted_bid_id
      ? await t.one('SELECT * FROM bids WHERE id = $1', [job.accepted_bid_id]) : null;
    return { next, bid };
  });
  res.json({ state: result.next, simulated: true,
             cancellation: result.bid ? cancellationPreview(result.next, result.bid.amount) : null });
}));

/* ======================================================== 12. complete === */
app.post('/api/jobs/:id/complete', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  if (job.state !== STATES.IN_PROGRESS) fail(409, `Cannot complete a job that is ${job.state}.`);
  const bid = await acceptedBid(job);
  if (!bid) fail(409, 'This job has no accepted bid.');
  const payment = await db.one(
    "SELECT * FROM payments WHERE job_id = $1 AND purpose = 'job_payment'", [job.id]);
  if (!payment || payment.reconciliation_state !== 'verified') {
    fail(409, 'The job payment has not been verified.');
  }

  // No Hyperswitch call: the money was captured at approval. This reallocates
  // the internal reservation.
  const e = economics(bid.amount);
  const out = await db.transaction(async t => {
    const locked = await t.one('SELECT state FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [job.id, u.id]);
    if (!locked || locked.state !== STATES.IN_PROGRESS) {
      fail(409, 'This job changed before completion could be recorded.');
    }
    await t.none('UPDATE jobs SET state = $2 WHERE id = $1', [job.id, STATES.COMPLETED]);
    await t.none('INSERT INTO job_events (job_id, kind, simulated) VALUES ($1,$2,TRUE)',
      [job.id, STATES.COMPLETED]);
    return new Ledger(t).post(jobCompleted({
      userId: u.id, jobId: job.id, providerId: bid.provider_id,
      paymentId: payment.payment_id, bidAmount: bid.amount,
    }), t);
  });

  res.json({
    state: STATES.COMPLETED,
    allocation: { providerPayable: e.payout, platformRevenue: e.take, total: e.charge },
    externalPayout: 'simulated',
    note: 'Credited to the provider payable balance in Swoop\u2019s ledger. External payout is simulated because the sandbox provides no payout connector.',
    duplicate: out.duplicate,
  });
}));

/* ========================================================== 13. cancel === */
app.post('/api/jobs/:id/cancel', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  const tier = cancellationTier(job.state);

  if (!tier) {
    fail(409, `Cannot cancel a job that is ${job.state}.`);
  }

  const bid = await acceptedBid(job);

  if (!bid) {
    fail(409, 'This job has no accepted bid.');
  }

  const payment = await db.one(
    `SELECT *
       FROM payments
      WHERE job_id = $1
        AND purpose = 'job_payment'`,
    [job.id]
  );

  if (!payment || payment.reconciliation_state !== 'verified') {
    fail(409, 'The job payment has not been verified.');
  }

  const e = economics(bid.amount);

  let posting;
  let state;
  let retainedAmount;
  let retainedByProvider;
  let creditedToWallet;
  let platformRevenue;

  if (tier === 'PRE_TRAVEL') {
    posting = cancelledPreTravel({
      userId: u.id,
      jobId: job.id,
      paymentId: payment.payment_id,
      bidAmount: bid.amount,
    });

    state = STATES.CANCELLED_PRE_TRAVEL;
    retainedAmount = 0;
    retainedByProvider = 0;
    creditedToWallet = e.charge;
    platformRevenue = 0;
  } else if (tier === 'EN_ROUTE') {
    posting = cancelledEnRoute({
      userId: u.id,
      jobId: job.id,
      providerId: bid.provider_id,
      paymentId: payment.payment_id,
      bidAmount: bid.amount,
    });

    state = STATES.CANCELLED_EN_ROUTE;
    retainedAmount = PENALTY;
    retainedByProvider = PENALTY;
    creditedToWallet = e.charge - PENALTY;
    platformRevenue = 0;
  } else {
    posting = cancelledInProgress({
      userId: u.id,
      jobId: job.id,
      providerId: bid.provider_id,
      paymentId: payment.payment_id,
      bidAmount: bid.amount,
    });

    state = STATES.CANCELLED_IN_PROGRESS;
    retainedAmount = e.charge;
    retainedByProvider = e.payout;
    creditedToWallet = 0;
    platformRevenue = e.take;
  }

  const out = await db.transaction(async t => {
    const locked = await t.one('SELECT state FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [job.id, u.id]);
    if (!locked || cancellationTier(locked.state) !== tier) {
      fail(409, 'This job changed before cancellation could be recorded.');
    }
    await t.none(
      'UPDATE jobs SET state = $2 WHERE id = $1',
      [job.id, state]
    );

    await t.none(
      `INSERT INTO job_events (job_id, kind, simulated)
       VALUES ($1,$2,TRUE)`,
      [job.id, state]
    );

    return new Ledger(t).post(posting, t);
  });

  res.json({
    state,
    tier,
    retainedAmount,
    retainedByProvider,
    creditedToWallet,
    platformRevenue,
    wallet: await walletOf(u.id),
    note:
      'No further Hyperswitch charge. This reallocates funds already captured for the job.',
    duplicate: out.duplicate,
  });
}));

/* ============================================================= 14. tip === */
app.post('/api/jobs/:id/tip', wrap(async (req, res) => {
  const u = await userOf(req);
  const job = await mustJob(req, u);
  if (job.state !== STATES.COMPLETED) fail(409, 'Tips are for completed jobs.');
  const bid = await acceptedBid(job);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0) fail(400, 'Enter a whole tip amount.');
  if (amount > await walletOf(u.id)) fail(402, 'That is more than your Swoop wallet holds.');

  const out = await ledger.post(tipPosting({
    userId: u.id, jobId: job.id, providerId: bid.provider_id,
    tipId: String(req.body.tipId ?? 'tip'), amount,
  }));
  res.json({ wallet: await walletOf(u.id), duplicate: out.duplicate,
             note: 'The provider keeps the whole tip. Swoop takes no fee.' });
}));

/* ================================================ 15. simulated withdraw = */
app.post('/api/wallet/withdraw', wrap(async (req, res) => {
  const u = await userOf(req);
  const amount = Number(req.body.amount);
  const withdrawalId = String(req.body.withdrawalId ?? '').trim();
  if (!Number.isInteger(amount) || amount <= 0) fail(400, 'Enter a whole amount greater than zero.');
  if (!withdrawalId) fail(400, 'withdrawalId is required.');
  if (amount > await walletOf(u.id)) fail(402, 'That is more than your Swoop wallet holds.');

  const out = await ledger.post(simulatedWithdrawal({ userId: u.id, withdrawalId, amount }));
  res.json({
    wallet: await walletOf(u.id),
    simulated: true,
    duplicate: out.duplicate,
    note: 'Simulated withdrawal recorded in Swoop\u2019s ledger. No external card refund, payout or bank transfer was initiated through Hyperswitch.',
  });
}));

/* ================================================================ boot === */
export function start(port = process.env.PORT || 3000) {
  return app.listen(port, () => console.log(`Swoop on http://localhost:${port}`));
}
if (
  process.env.VERCEL !== '1' &&
  process.env.SWOOP_AUTOSTART !== 'false'
) {
  start();
}

export { app, db, ledger, flow };
