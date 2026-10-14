-- All money is stored as BIGINT micro-rupees (1 INR = 1,000,000) to avoid float drift.

CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  budget_micros   BIGINT NOT NULL CHECK (budget_micros >= 0),
  spent_micros    BIGINT NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  reserved_micros BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per gateway request. Inserted as 'pending' together with the budget
-- reservation, then settled to 'ok' / 'error' (or 'expired' by the sweeper).
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  key_id          TEXT NOT NULL REFERENCES api_keys(id),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'error', 'expired')),
  requested_model TEXT NOT NULL,
  route_reason    TEXT,
  provider        TEXT,
  model           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  reserved_micros BIGINT NOT NULL,
  cost_micros     BIGINT NOT NULL DEFAULT 0,
  latency_ms      INT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS usage_events_key_time ON usage_events (key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_pending ON usage_events (created_at) WHERE status = 'pending';
