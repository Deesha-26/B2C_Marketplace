-- Swoop Round 1 — Supabase (PostgreSQL) schema.
--
-- Ten tables. Only minimal reconciliation state is stored locally: Hyperswitch
-- remains authoritative for external payment execution, so this schema
-- deliberately does NOT store attempts[], connector names, connector error
-- codes, retry history or raw responses. Those are retrieved live.

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY,          -- generated client-side, unguessable
  display_email     TEXT,                      -- metadata only, never an identity key
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id),
  service           TEXT NOT NULL,
  description       TEXT NOT NULL,
  address           TEXT NOT NULL,
  scheduled_for     TIMESTAMPTZ NOT NULL,
  is_emergency      BOOLEAN NOT NULL DEFAULT FALSE,
  state             TEXT NOT NULL,             -- OPEN_FOR_BIDS → RESERVED → EN_ROUTE → …
  accepted_bid_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id);

-- Seeded, not real providers. No provider application exists in Round 1.
CREATE TABLE IF NOT EXISTS bids (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  provider_id       TEXT NOT NULL,
  provider_name     TEXT NOT NULL,
  trade             TEXT NOT NULL,
  rating            NUMERIC(2,1) NOT NULL,
  eta_minutes       INTEGER NOT NULL,
  amount            INTEGER NOT NULL,          -- cents
  note              TEXT
);
CREATE INDEX IF NOT EXISTS bids_job ON bids(job_id);

-- Simulated provider progress. `simulated` is TRUE for every Round 1 row.
CREATE TABLE IF NOT EXISTS job_events (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  kind              TEXT NOT NULL,
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  simulated         BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id);

-- Customer consent to a specific total. NOT a processor authorization.
-- A price change requires a new row; the old approval is never mutated.
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id),
  bid_id            TEXT NOT NULL REFERENCES bids(id),
  bid_amount        INTEGER NOT NULL,
  fee_amount        INTEGER NOT NULL,
  total_amount      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  approved_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_job ON approvals(job_id);

-- Minimal linkage to Hyperswitch. Not a mirror of the payment object.
CREATE TABLE IF NOT EXISTS payments (
  payment_id                    TEXT PRIMARY KEY,   -- Hyperswitch id
  user_id                       UUID NOT NULL REFERENCES users(id),
  job_id                        TEXT REFERENCES jobs(id),
  approval_id                   TEXT REFERENCES approvals(id),
  purpose                       TEXT NOT NULL,      -- wallet_topup | job_payment
  approved_amount               INTEGER NOT NULL,
  currency                      TEXT NOT NULL,
  last_observed_external_status TEXT,
  reconciliation_state          TEXT NOT NULL DEFAULT 'pending',
                                                    -- pending | verified | discrepancy
  discrepancy_reason            TEXT,
  last_reconciled_at            TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS payments_job  ON payments(job_id);

-- Prevents duplicate OUTBOUND Hyperswitch calls, which ledger idempotency
-- cannot. expected_amount/currency let a crash after the external call be
-- reconciled against what was actually intended.
CREATE TABLE IF NOT EXISTS payment_operations (
  operation_key     TEXT PRIMARY KEY,
  payment_id        TEXT NOT NULL,             -- deterministic, derived from the key
  kind              TEXT NOT NULL,             -- wallet_topup | job_payment
  -- Full intent. Reconciliation derives EVERY expectation from this row, never
  -- from caller-supplied arguments: on first reconciliation no payments row
  -- exists yet, so the operation is the only trustworthy record of what was
  -- meant to happen and for whom.
  user_id           UUID NOT NULL REFERENCES users(id),
  purpose           TEXT NOT NULL,
  job_id            TEXT REFERENCES jobs(id),
  approval_id       TEXT REFERENCES approvals(id),
  expected_amount   INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  state             TEXT NOT NULL,
  create_attempts   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);

-- Journal header. The idempotency key lives here, NOT on the entries: a
-- balanced posting writes several rows sharing a reason and payment reference.
CREATE TABLE IF NOT EXISTS ledger_transactions (
  id                TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL
    CONSTRAINT ledger_transactions_idempotency_key_uniq UNIQUE,
  payment_id        TEXT REFERENCES payments(payment_id),
  user_id           UUID REFERENCES users(id),
  job_id            TEXT REFERENCES jobs(id),
  reason            TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_tx_user ON ledger_transactions(user_id);

-- Append-only journal lines. `direction` carries the sign; `amount` is always
-- positive. Entries in one transaction must sum to zero.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id    TEXT NOT NULL REFERENCES ledger_transactions(id),
  account           TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount            INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS ledger_entries_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS ledger_entries_tx ON ledger_entries(transaction_id);

-- The primary key IS the webhook deduplication.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id          TEXT PRIMARY KEY,
  event_type        TEXT,
  payment_id        TEXT,
  result            TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
