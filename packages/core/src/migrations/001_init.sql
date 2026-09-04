CREATE TABLE IF NOT EXISTS batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('running', 'completed', 'cancelled')),
  idempotency_key  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE TABLE IF NOT EXISTS url_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  position         int  NOT NULL,
  url              text NOT NULL,
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  run              int  NOT NULL DEFAULT 1,
  attempts         int  NOT NULL DEFAULT 0,
  http_status      int,
  response_time_ms int,
  page_title       text,
  final_url        text,
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS url_checks_batch_position_idx ON url_checks (batch_id, position);
CREATE INDEX IF NOT EXISTS url_checks_batch_status_idx   ON url_checks (batch_id, status);
CREATE INDEX IF NOT EXISTS url_checks_queued_idx         ON url_checks (updated_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS batches_created_at_idx        ON batches (created_at DESC);
