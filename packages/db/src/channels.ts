// The Postgres `NOTIFY` channels (ADR 0034, ADR 0035). A notification carries IDs only, never
// content, and never an agent event: events are read from the log after a wake-up.

export const notifyChannels = {
  /** A command for a runner was committed (payload: `{ runnerId }`), or a runner was evicted or revoked. */
  runner: "ostra_runner",
  /** Events of a task were committed: one wake-up per batch window (payload: `{ taskId, seq }`). */
  taskEvents: "ostra_task_events",
  /** A change notice was committed (payload: `{ seq }`): the panel's live views refetch. */
  changes: "ostra_changes",
} as const;

export type NotifyChannel = (typeof notifyChannels)[keyof typeof notifyChannels];

/** Postgres caps a notification payload at under 8,000 bytes by default. */
export const NOTIFY_PAYLOAD_MAX_BYTES = 7_999;

/** The live-text table's qualified name (ADR 0035): UNLOGGED, in its own schema. */
export const LIVE_TEXT_TABLE = `"ostra_live"."live_text"`;
