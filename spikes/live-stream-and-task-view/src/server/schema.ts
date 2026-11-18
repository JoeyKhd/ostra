// The spike's schema, in raw SQL. ADR 0035 notes Prisma cannot declare UNLOGGED, so the
// live-text table lives in a raw migration; this spike creates it with plain SQL to prove the shape.
export const schemaSql = `
CREATE TABLE IF NOT EXISTS members (
  member_id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('member', 'viewer'))
);

-- A session is a token the browser holds in a cookie. Only its SHA-256 is stored, so a read of the
-- table does not hand anyone a working cookie (a stand-in for better-auth, ADR 0003).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members (member_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id text PRIMARY KEY,
  driver_member_id text,
  driver_version integer NOT NULL DEFAULT 1
);

-- The per-task counter row. Writers to one task serialize on it, numbers commit in order,
-- and a reader never sees a gap (ADR 0035).
CREATE TABLE IF NOT EXISTS task_counters (
  task_id text PRIMARY KEY REFERENCES tasks (task_id),
  next_seq bigint NOT NULL DEFAULT 1,
  last_runner_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  task_id text NOT NULL,
  seq bigint NOT NULL,
  runner_seq bigint,
  at_ms bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (task_id, seq)
);
-- The runner's own number makes saving idempotent (ADR 0034).
CREATE UNIQUE INDEX IF NOT EXISTS events_runner_seq ON events (task_id, runner_seq) WHERE runner_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_turn_boundary ON events (task_id, seq)
  WHERE kind IN ('turn.started', 'turn.ended', 'turn.failed');

-- Partial text: the latest accumulated text of each open segment. Never in the log.
CREATE UNLOGGED TABLE IF NOT EXISTS task_live_text (
  task_id text NOT NULL,
  segment_id text NOT NULL,
  turn_id text NOT NULL,
  part text NOT NULL,
  text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, segment_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id text PRIMARY KEY,
  task_id text NOT NULL,
  tool_call_id text NOT NULL,
  options jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'closed')),
  decision text,
  option_id text,
  answered_by text
);

-- The durable runner command queue (ADR 0011: committed before anything reaches the agent).
CREATE TABLE IF NOT EXISTS commands (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (task_id, idempotency_key)
);
`;
