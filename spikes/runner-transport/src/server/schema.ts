// The spike's tables. A sketch of ADR 0034's design, not a migration.
// They're created in SPIKE_SCHEMA (src/shared/db.ts): every connection puts it
// first on its search path, so the names below never touch another schema.
export const schemaSql = `
CREATE TABLE IF NOT EXISTS runner (
  id               text PRIMARY KEY,
  last_command_seq bigint NOT NULL DEFAULT 0,
  status           jsonb
);

CREATE TABLE IF NOT EXISTS core_replica (
  id           text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Which replica holds which peer, with a connection epoch.
CREATE TABLE IF NOT EXISTS runner_presence (
  runner_id       text PRIMARY KEY REFERENCES runner(id),
  replica_id      text NOT NULL,
  conn_epoch      bigint NOT NULL,
  carrier         text NOT NULL,
  minor           int NOT NULL,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);

CREATE TABLE IF NOT EXISTS task (
  id             text PRIMARY KEY,
  runner_id      text NOT NULL REFERENCES runner(id),
  lease_epoch    bigint NOT NULL DEFAULT 1,
  state          text NOT NULL CHECK (state IN ('offered', 'running', 'stopped')),
  stopped_reason text,
  stopped_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id            text PRIMARY KEY,
  task_id       text NOT NULL REFERENCES task(id),
  ingest_cursor bigint NOT NULL DEFAULT 0
);

-- Idempotent on (session_id, seq): ADR 0011's "saved before ostra acts on it".
CREATE TABLE IF NOT EXISTS agent_event (
  session_id  text NOT NULL,
  seq         bigint NOT NULL,
  lease_epoch bigint NOT NULL,
  kind        text NOT NULL,
  body        jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_id, seq)
);

-- The outbox: numbered per runner, gap-free, in commit order.
CREATE TABLE IF NOT EXISTS runner_command (
  runner_id  text NOT NULL REFERENCES runner(id),
  seq        bigint NOT NULL,
  id         uuid NOT NULL UNIQUE,
  kind       text NOT NULL,
  body       jsonb NOT NULL,
  not_after  timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acked_at   timestamptz,
  result     text,
  reason     text,
  PRIMARY KEY (runner_id, seq)
);
CREATE INDEX IF NOT EXISTS runner_command_unacked ON runner_command (runner_id, seq) WHERE acked_at IS NULL;

-- Every refused stale write, so the harness can see the fence work.
CREATE TABLE IF NOT EXISTS stale_refusal (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL,
  lease_epoch bigint NOT NULL,
  from_seq    bigint NOT NULL,
  count       int NOT NULL,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Write a command and, if asked, notify every replica, in the caller's transaction.
-- The counter on the runner's row, taken under its lock, makes seq gap-free and in commit order.
CREATE OR REPLACE FUNCTION enqueue_command(
  p_runner text, p_kind text, p_body jsonb, p_not_after timestamptz, p_notify boolean
) RETURNS TABLE (seq bigint, id uuid) LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE s bigint; i uuid := gen_random_uuid();
BEGIN
  UPDATE runner SET last_command_seq = last_command_seq + 1 WHERE runner.id = p_runner
    RETURNING last_command_seq INTO s;
  IF s IS NULL THEN RAISE EXCEPTION 'unknown runner'; END IF;
  INSERT INTO runner_command (runner_id, seq, id, kind, body, not_after)
    VALUES (p_runner, s, i, p_kind, p_body, p_not_after);
  IF p_notify THEN
    PERFORM pg_notify('ostra_runner', json_build_object('k', 'cmd', 'r', p_runner)::text);
  END IF;
  RETURN QUERY SELECT s, i;
END $$;
`;
