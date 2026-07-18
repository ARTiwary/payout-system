-- User Payout Management System — Reference RDBMS Schema (PostgreSQL)

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_key        VARCHAR(64) UNIQUE NOT NULL,      -- e.g. "john_doe"
    name            VARCHAR(128),
    email           VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE brands (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_key       VARCHAR(64) UNIQUE NOT NULL,       -- e.g. "brand_1"
    name            VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per affiliate sale.
CREATE TABLE sales (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    brand_id            UUID NOT NULL REFERENCES brands(id),
    earning             NUMERIC(14,2) NOT NULL CHECK (earning >= 0),
    status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected')),

    -- Advance payout tracking lives directly on the sale row so that
    -- "has this sale ever received an advance" is a single indexed
    -- lookup and can be checked/updated atomically (see partial index
    -- below), which is what makes the advance job idempotent even if
    -- it is triggered concurrently / re-run.
    advance_paid        NUMERIC(14,2) NOT NULL DEFAULT 0,
    advance_paid_at      TIMESTAMPTZ,

    reconciled_at        TIMESTAMPTZ,       -- set when status leaves 'pending'
    final_adjustment      NUMERIC(14,2),     -- computed once at reconciliation time, kept for audit

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarantees "a sale can never get a second advance payout" even under
-- concurrent job execution: the job's UPDATE is guarded by
-- `WHERE status = 'pending' AND advance_paid_at IS NULL`, which is
-- backed by this index.
CREATE INDEX idx_sales_pending_no_advance
    ON sales (user_id)
    WHERE status = 'pending' AND advance_paid_at IS NULL;

CREATE INDEX idx_sales_user ON sales(user_id);
CREATE INDEX idx_sales_status ON sales(status);

-- Immutable, append-only ledger. This is the single source of truth
-- for a user's withdrawable balance — the balance is always
-- SUM(amount) over a user's rows here, never a mutable counter, so it
-- can never drift from the audit trail.
CREATE TABLE wallet_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    sale_id         UUID REFERENCES sales(id),        -- nullable: withdrawals aren't tied to one sale
    withdrawal_id   UUID,                              -- set for WITHDRAWAL / WITHDRAWAL_REVERSAL rows
    type            VARCHAR(32) NOT NULL CHECK (type IN (
                        'ADVANCE_PAYOUT',               -- +10% of a pending sale (informational; paid out directly, see note in README)
                        'RECONCILIATION_ADJUSTMENT',    -- + (earning - advance) on approval, - advance on rejection
                        'WITHDRAWAL',                   -- - amount, user cashes out withdrawable balance
                        'WITHDRAWAL_REVERSAL'           -- + amount, failed/cancelled/rejected payout credited back
                     )),
    amount          NUMERIC(14,2) NOT NULL,             -- signed: credit positive, debit negative
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_tx_user ON wallet_transactions(user_id);

-- One row per withdrawal attempt/request.
CREATE TABLE withdrawals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    status          VARCHAR(16) NOT NULL DEFAULT 'initiated'
                        CHECK (status IN ('initiated','success','failed','cancelled','rejected')),
    requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at       TIMESTAMPTZ
);

-- Enforces "one withdrawal every 24h" via the query
-- `WHERE user_id = ? AND requested_at > now() - interval '24 hours'
--  AND status <> ... (see WithdrawalService for the exact rule)`.
CREATE INDEX idx_withdrawals_user_time ON withdrawals(user_id, requested_at DESC);

-- =====================================================================
-- Relationships
-- =====================================================================
-- users (1) ───< sales (N)
-- brands (1) ───< sales (N)
-- users (1) ───< wallet_transactions (N)
-- sales (1) ───< wallet_transactions (0..1)   (reconciliation adjustment row)
-- users (1) ───< withdrawals (N)
-- withdrawals (1) ───< wallet_transactions (1..2)  (the debit, and optionally a reversal credit)
-- =====================================================================
