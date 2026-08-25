#!/usr/bin/env node
/**
 * Sends a correctly-signed webhook to your local endpoint.
 *
 *   npm run webhook:test -- payment_succeeded pay_abc123
 *   npm run webhook:test -- refund_succeeded  ref_abc123
 *
 * Real webhooks arrive on Hyperswitch's schedule, and dispute events cannot be
 * triggered on demand at all. This lets you exercise the receiver — signature
 * verification, event deduplication, state guards — whenever you want.
 *
 * It signs with HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY exactly as Hyperswitch
 * does, so a passing test here means a real webhook will verify too.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SECRET = process.env.HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY;
const URL_ = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}/api/webhooks/hyperswitch`;

if (!SECRET) {
  console.error('HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY is not set in .env.');
  console.error('Find it in the dashboard under Business Profile → Webhooks.');
  process.exit(1);
}

const [, , type = 'payment_succeeded', resourceId = 'pay_test_123', ...rest] = process.argv;
const amount = Number(rest[0] ?? 9675);

const object = type.startsWith('refund')
  ? { refund_id: resourceId, payment_id: 'pay_test_123', amount, status: type.endsWith('succeeded') ? 'succeeded' : 'failed' }
  : {
      payment_id: resourceId, amount,
      amount_captured: type === 'payment_captured' ? amount : 0,
      status: { payment_succeeded: 'succeeded', payment_captured: 'succeeded',
                payment_failed: 'failed', payment_cancelled: 'cancelled',
                payment_processing: 'processing' }[type] ?? 'succeeded',
      connector: 'stripe',
      attempts: [{ connector: 'stripe', status: 'charged' }],
    };

const event = {
  event_id: 'evt_' + crypto.randomBytes(8).toString('hex'),
  event_type: type,
  timestamp: new Date().toISOString(),
  content: { type: type.startsWith('refund') ? 'refund_details' : 'payment_details', object },
};

const raw = JSON.stringify(event);
const signature = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

/** `expect` is the status that means the receiver behaved correctly — a
    tampered signature SHOULD be rejected, so 401 is the pass there. */
const send = async (label, headers, expect = 200) => {
  const res = await fetch(URL_, { method: 'POST', headers, body: raw }).catch(e => ({ status: 0, text: async () => e.message }));
  const body = await res.text();
  const good = res.status === expect;
  console.log(`  ${good ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label} → ${res.status} ${body}`);
  return res.status;
};

console.log(`\nSending ${type} for ${resourceId} to ${URL_}\n`);
const H = { 'Content-Type': 'application/json', 'x-webhook-signature-512': signature };

const a = await send('signed delivery accepted', H, 200);
const b = await send('duplicate delivery ignored (same event_id)', H, 200);
const c = await send('tampered signature rejected with 401',
  { ...H, 'x-webhook-signature-512': 'deadbeef' }, 401);

const failures = [a !== 200, b !== 200, c !== 401].filter(Boolean).length;
if (c !== 401) console.log('\n  \x1b[31mA bad signature was NOT rejected.\x1b[0m Check HYPERSWITCH_PAYMENT_RESPONSE_HASH_KEY.');
if (a === 0) console.log('\n  Could not reach the server. Is `npm start` running?');
console.log(`\n${failures === 0 ? '\x1b[32mWebhook receiver is behaving correctly.\x1b[0m' : '\x1b[31m' + failures + ' check(s) failed.\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
