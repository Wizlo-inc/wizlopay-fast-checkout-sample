-- Migration: add checkout app columns to existing orders table

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS first_name              TEXT,
  ADD COLUMN IF NOT EXISTS last_name               TEXT,
  ADD COLUMN IF NOT EXISTS email                   TEXT,
  ADD COLUMN IF NOT EXISTS mobile                  TEXT,
  ADD COLUMN IF NOT EXISTS product_id              TEXT,
  ADD COLUMN IF NOT EXISTS product_name            TEXT,
  ADD COLUMN IF NOT EXISTS status                  TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS shipping_address        JSONB,
  ADD COLUMN IF NOT EXISTS gr4vy_transaction_id    TEXT,
  ADD COLUMN IF NOT EXISTS gr4vy_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS gr4vy_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS buyer_external_id       TEXT,
  ADD COLUMN IF NOT EXISTS created_at              TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at              TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_orders_gr4vy_txn_id  ON orders (gr4vy_transaction_id);
CREATE INDEX IF NOT EXISTS idx_orders_gr4vy_sess_id ON orders (gr4vy_checkout_session_id);

-- Buyers table
CREATE TABLE IF NOT EXISTS buyers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id    TEXT UNIQUE NOT NULL,
  gr4vy_buyer_id TEXT,
  email          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency store for webhooks
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- upsell_transactions was already created by schema.sql
-- update its FK reference to confirm it points to our orders table
-- (already exists from schema.sql run above)
