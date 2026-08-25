# Connecting Swoop to your Hyperswitch sandbox

Roughly twenty minutes end to end. Everything here happens in the **sandbox** dashboard at <https://app.hyperswitch.io> — no real money moves.

---

## 1. Collect five values

Sign in and gather these. Four go straight into `.env`; the fifth is the one people forget.

| Value | Where |
|---|---|
| **Secret / API key** | Developers → API Keys → *Create API Key*. Shown **once** — copy it immediately |
| **Publishable key** | Developers → API Keys, listed as the publishable key |
| **Profile ID** | Settings → Business Profile (`pro_…`) |
| **Merchant ID** | Settings → Business Profile (`merchant_…`) |
| **Payment response hash key** | Business Profile → **Webhooks** section |

That last one is the HMAC secret Hyperswitch signs webhooks with. Without it the app refuses every webhook, because an unverified webhook is an unauthenticated instruction to credit a wallet.

```bash
cp .env.example .env
```

Paste the values in. `.env` is gitignored — **never commit it**, and if you ever do, rotate every key before pushing.

---

## 2. Connect processors

Payments → **Connectors** → *Connect a processor*.

Add **Stripe (test)** and **PayPal (sandbox)**. Hyperswitch supplies dummy credentials for sandbox connectors; you do not need your own Stripe account.

For each connector, enable the payment methods you want:

- **Stripe** — Cards (credit and debit)
- **PayPal** — Wallet

> PayPal is a redirect wallet method. It cannot process a raw card number, which is why the app never asks the customer to choose a processor.

---

## 3. Set up routing

Payments → **Routing** → *Create rule*.

The simplest useful configuration is a **default fallback list** with Stripe first and PayPal second. If Stripe is ineligible for a payment method, Hyperswitch falls to the next connector automatically.

To demonstrate rerouting visibly, set the primary rule to send 100% to PayPal and leave Stripe in the fallback list. A card payment will fail eligibility on PayPal and route through Stripe instead — visible in the app's routing trail and in the dashboard, with no code change.

### Smart retries (optional)

Retrying a *soft* decline on another connector needs retries enabled on your merchant account, which is a support request to Juspay rather than a dashboard toggle. Hard declines — `insufficient_funds`, `stolen_card`, `expired_card` — are deliberately never retried.

Whether a specific decline counts as retryable is governed by the **GSM (Gateway Status Mapping)** table on your account. If yours maps `insufficient_funds` as retryable, `4000 0000 0000 9995` will reroute. `npm run verify` step 7 reports which behaviour you have.

---

## 4. Verify

```bash
npm install
npm run verify
```

This runs eight checks against your sandbox:

| # | Check | Why it matters |
|---|---|---|
| 0 | Keys present | Fails fast on a mistyped `.env` |
| 1 | Auto-capture payment | Wallet top-ups |
| 2 | Manual capture → `requires_capture` | **The escrow model depends on this** |
| 3 | `extend_authorization` | Long-dated jobs |
| 4 | Partial capture of $30 | The en-route cancellation tier |
| 5 | Void | The free cancellation tier |
| 6 | Refund | Withdrawals and upheld disputes |
| 7 | Routing / retry trail | Whether your GSM reroutes |
| 8 | Retrieve with `attempts[]` | Whether the trail renders in the UI |

Read the `NOTE` lines. They are configuration differences, not bugs — but they change what the demo does. The one that matters most is step 2: **if manual capture returns `succeeded` instead of `requires_capture`, your connector is auto-capturing**, and the hold-then-charge model won't work as designed.

---

## 5. Webhooks

The server exposes `POST /api/webhooks/hyperswitch`. Hyperswitch needs a publicly reachable URL, so in development use a tunnel:

```bash
npx ngrok http 3000
```

Register the forwarding URL in Business Profile → Webhooks:

```
https://<your-subdomain>.ngrok-free.app/api/webhooks/hyperswitch
```

Subscribe to: `payment_succeeded`, `payment_failed`, `payment_captured`, `payment_cancelled`, `refund_succeeded`, `refund_failed`.

Test the receiver without waiting for a real event:

```bash
npm run webhook:test -- payment_succeeded pay_abc123
```

You should see three results: accepted, duplicate ignored, bad signature rejected with a 401. If the third one is accepted, your hash key is wrong.

---

## 6. Run it

```bash
npm start   # http://localhost:3000
```

Walk the flow:

1. **Sign in** with any email.
2. **Add money** — the Hyperswitch SDK renders the card form. Use `4242 4242 4242 4242`, any future expiry, any CVC. Tick *save card* to vault it.
3. **Book a job** — describe it, pick a bid. Your card is **held**, not charged. Check the dashboard: the payment sits in `requires_capture`.
4. **Advance the job** with the demo controls, or **cancel** at each stage to see void, partial capture and full capture in turn.
5. **Complete it** — the hold is captured. Rate and tip from your wallet balance.

Every payment, capture, void and refund appears in Payments → Payment Operations, and every one has a matching row in the app's activity list. They should always agree.

---

## Troubleshooting

**`HYPERSWITCH_SECRET_KEY is not set`** — `.env` is missing or in the wrong directory. It belongs in the repo root, beside `package.json`.

**Manual capture returns `succeeded`** — the connector auto-captured. Check the connector's capture settings; without manual capture the escrow model collapses to charge-then-refund.

**Every webhook returns 401** — the payment response hash key is wrong or empty. It is not the API key; it lives in Business Profile → Webhooks.

**The SDK doesn't render** — check the browser console for the publishable key. `/api/config` must return it, and it must be the publishable key, not the secret.

**No `attempts[]` in the response** — the app requests `expand_attempts=true` on retrieve. If it's still empty, the payment likely had a single attempt.

**`4000 0000 0000 9995` doesn't reroute** — expected on a default GSM configuration. It's a hard decline. See step 3.
