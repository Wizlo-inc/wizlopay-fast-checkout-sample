-- Checkout application schema

CREATE TABLE IF NOT EXISTS buyers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id    TEXT UNIQUE NOT NULL,
  gr4vy_buyer_id TEXT,
  email          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name               TEXT NOT NULL,
  last_name                TEXT NOT NULL,
  email                    TEXT NOT NULL,
  mobile                   TEXT NOT NULL,
  product_id               TEXT NOT NULL,
  product_name             TEXT NOT NULL,
  amount                   INTEGER NOT NULL,  -- cents
  currency                 TEXT NOT NULL DEFAULT 'USD',
  status                   TEXT NOT NULL DEFAULT 'pending',
  shipping_address         JSONB,
  gr4vy_transaction_id     TEXT,
  gr4vy_checkout_session_id TEXT,
  gr4vy_payment_method_id  TEXT,
  buyer_external_id        TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_transaction_id ON orders (gr4vy_transaction_id);
CREATE INDEX IF NOT EXISTS idx_orders_session_id     ON orders (gr4vy_checkout_session_id);

CREATE TABLE IF NOT EXISTS upsell_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID REFERENCES orders(id),
  product_id           TEXT NOT NULL,
  product_name         TEXT NOT NULL,
  amount               INTEGER NOT NULL,
  gr4vy_transaction_id TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency store for webhooks
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);
