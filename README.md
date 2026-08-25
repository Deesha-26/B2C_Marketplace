# Swoop

A B2C home-services marketplace — post a job, compare bids from tradespeople, track them to your door, pay when the work is done.

It exists to demonstrate a **complete marketplace payment lifecycle on [Hyperswitch](https://hyperswitch.io)**: authorization, capture, partial capture, void, refund, extended authorization, webhooks and a double-entry ledger, wired together rather than shown off one API at a time.

```
Customer ──pay──▶ Swoop (merchant of record) ──settle──▶ Provider
                       │           │
              refund ◀─┘           └─▶ dispute
```

**135 tests.** No build step, no framework, two dependencies — Express, and Node 22's built-in SQLite.

---

## Quick start

```bash
git clone <your-repo-url> swoop && cd swoop
npm install
cp .env.example .env        # then paste your sandbox keys in
npm run verify              # checks your sandbox is configured correctly
npm start                   # http://localhost:3000
```

Node 22.5+ is required (`node:sqlite` ships with it, so there is no native module to compile).

`npm run verify` is the thing to run first — it exercises every operation the app depends on against **your** sandbox and prints exactly what came back. It answers, in about thirty seconds, whether manual capture, partial capture, extended authorization and retries behave on your account the way this app assumes.

Full dashboard walkthrough: [docs/HYPERSWITCH-SETUP.md](docs/HYPERSWITCH-SETUP.md).

---

## Architecture

```
        Job engine          Wallet
             └────────┬────────┘
                      ▼
            Payment intelligence
        risk → strategy → settlement
                      ▼
               Hyperswitch
        routing · retries · 3DS
                      ▼
             PSP → webhook → ledger
```

`server/hyperswitch.js` is the only module that calls the sandbox. Nothing above the intelligence layer knows what `capture_method` is; nothing below it knows what a job is.

| Module | Responsibility |
|---|---|
| `intelligence/risk.js` | Reads job, customer history and ledger; emits signals (hold duration, 3DS, value) |
| `intelligence/strategy.js` | Turns signals into the exact Hyperswitch request body |
| `intelligence/settlement.js` | Decides how a hold resolves. Pure — no I/O, fully testable |
| `ledger.js` | Double-entry over an append-only table. Refuses any posting that doesn't sum to zero |
| `watchdog.js` | Extends authorization holds before they expire |
| `webhooks.js` | HMAC verification, event deduplication, state regression guards |

---

## Payment model

| Event | Hyperswitch call | The customer's card |
|---|---|---|
| Wallet top-up | `POST /payments` · auto capture | Charged |
| Bid accepted | `POST /payments` · manual capture | **Held only** |
| Job completed | `capture` full | Charged |
| Cancel before en route | `POST /payments/{id}/cancel` | Nothing charged, hold released |
| Cancel en route | `capture` $30 | $30 charged, remainder voided |
| Cancel after arrival | `capture` full | Charged |
| Withdrawal | `POST /refunds` | Returned to card |

Jobs are charged to the card, not the wallet. The wallet holds a **$25 float** for tips and receives cancellation compensation.

Two consequences worth knowing:

**No refund is needed to cancel a job.** Every tier resolves against the original authorization — a void, a partial capture, or a full capture. Partial capture voids the remainder at the processor, which is why the $30 en-route tier works without partial-refund support.

**Wallet balance and withdrawable balance are different numbers.** A refund must reverse a real payment, so the $30 credited when a provider cancels has no payment behind it and cannot be returned to a card. `/api/me` returns both; the UI offers the smaller one. Withdrawal is all-or-nothing — capacity is checked before any refund is issued.

### Fees

Charged on top of the bid. On a $90 bid:

| | |
|---|---|
| Customer pays | $96.75 (bid + 7.5%) |
| Provider receives | $76.50 (bid − 15%) |
| Swoop keeps | $20.25 |

`platformTake` is computed as the residual, never as an independent rounding of 22.5% — otherwise a half-cent can appear or vanish and the ledger's zero-sum check fails. Verified across all 50,000 bid values up to $500.

---

## Extended authorization

```
requires_capture ──▶ job completes ──────────────▶ capture
        └─────────▶ hold nearing capture_by ──▶ extend ──▶ capture
```

`watchdog.js` sweeps open holds every five minutes, re-syncs `capture_by` from Hyperswitch rather than trusting the local copy, and calls `extend_authorization` when a deadline falls within six hours. This is what allows a job to be booked further ahead than a standard hold window. Expiries log as errors, because they mean a service was performed that cannot be charged.

---

## Routing

**No request ever names a connector** — a test asserts this by string-searching every generated request body. Which processor handles a payment, and whether a failure is retried elsewhere, is decided entirely by your dashboard routing rules.

The app reads `attempts[]` back and renders the trail, so rerouting is *shown* rather than claimed.

Whether a given decline is retried depends on the **GSM (Gateway Status Mapping)** table for your merchant account. `4000 0000 0000 9995` maps to `insufficient_funds`, which is a hard decline by default and is deliberately not retried — retrying a bank that says "no funds" only burns fees. If your GSM marks it retryable you'll see two attempts across two connectors; if not, one. No code changes between those cases. `npm run verify` step 7 tells you which you have.

---

## Tests

```bash
npm test              # all 135
npm run test:journey  # one customer, seven jobs, money reconciled at every step
```

| Suite | Covers |
|---|---|
| `core.test.js` | Money, ledger, risk, strategy, settlement, webhook safety |
| `api.test.js` | All 33 routes over real HTTP against a fake Hyperswitch |
| `client.test.js` | The real `public/app.js` run in a VM against the real server |
| `static.test.js` | CSS classes, element ids, screen reachability, no keys in the client |
| `journey.test.js` | One continuous session; asserts nothing is created or destroyed |

The suite never touches the real sandbox — only `npm run verify` does. CI runs on Node 22 and 24 and fails the build if a live-looking key is ever committed.

Webhooks can be exercised without waiting for real events:

```bash
npm run webhook:test -- payment_succeeded pay_abc123
```

It signs the payload exactly as Hyperswitch does, then sends it three times — once valid, once duplicated, once with a broken signature — so you can see acceptance, deduplication and rejection in one run.

---

## Security

- The secret key lives only in `.env`, server-side. The browser receives the publishable key and a per-payment `client_secret`.
- **Card data never enters this codebase.** The Hyperswitch SDK renders payment fields in its own iframe, which keeps the app out of PCI scope. A test asserts no card inputs exist in our DOM.
- Webhook HMACs are verified on the raw body before parsing, with a timing-safe comparison.
- Idempotency keys are derived (`{job_id}:{operation}`), never random, so a retry cannot become a second payment.

`x-swoop-user` is a demo stand-in for a session and must be replaced before any real deployment.

---

## Known gaps

- The Hyperswitch client is exercised against a fake in tests. Field names for `attempts[]`, `capture_by` and the extend-authorization response follow the docs; expect one round of adjustment on first contact with a live sandbox. `npm run verify` is how you find out.
- Job disputes have no endpoint yet — the evidence model exists but isn't wired up.
- Payouts are ledger-only. The sandbox has no payout connector, so provider settlement is simulated and flagged as such in the UI.
- Providers are seeded, not real. There is no provider-side app.

## Licence

MIT
