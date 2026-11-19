// The runner protocol's limits and timers. Every one is a working value, to tune, and the runner
// and the server read them from here so they agree. Ported from
// spikes/runner-transport/src/protocol/timers.ts.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const runnerLimits = {
  /** ADR 0034: the largest frame either side sends or accepts, in UTF-8 bytes. */
  frameMaxBytes: 1 * MiB,
  /** ADR 0034: the credit window in frames. The runner counts frames and bytes, and stops at either. */
  creditFrames: 256,
  /** ADR 0034: the credit window in bytes. */
  creditBytes: 4 * MiB,
  /** ADR 0034: the most events in one `events` frame. */
  eventsPerFrameMax: 1000,
  /** ADR 0035: the most live-text frames in one `live-text` frame. */
  liveTextPerFrameMax: 200,
  /** ADR 0034: the most results in one `command-ack`. */
  ackResultsMax: 512,
  /** ADR 0034: the most sessions a `hello` can report. */
  helloSessionsMax: 1000,
  /** ADR 0034: the spool quota per runner. When full, the peer stops reading the agent's output. */
  spoolQuotaBytes: 1 * GiB,
  /** ADR 0036: the longest steer a member can send, in characters. */
  steerTextMaxChars: 65_536,

  /** ADR 0034: the server pings this often, under nginx's 60 s idle close. */
  pingMs: 20 * SECOND,
  /** ADR 0034: no frame for this long, and either side closes the connection. */
  deadMs: 45 * SECOND,
  /** ADR 0034: the upgrade and `hello` must finish in this time, or the runner falls back. */
  handshakeTimeoutMs: 10 * SECOND,
  /** ADR 0034: a socket that dies this soon after opening, three times in a row, means HTTP. */
  quickDeathMs: 10 * SECOND,
  /** ADR 0034: one presence write per replica this often. */
  presenceMs: 10 * SECOND,
  /** ADR 0034: the panel shows a runner offline after this long without presence. */
  offlineMs: 45 * SECOND,
  /** ADR 0034: the sweep that catches a missed `NOTIFY`. */
  sweepMs: 2 * SECOND,
  /** ADR 0034: how often a replica looks for tasks past their grace. */
  graceSweepMs: 2 * SECOND,
  /** ADR 0034, F-045: this long without the peer, and the server stops the task cleanly. */
  graceMs: 10 * MINUTE,
  /** ADR 0034, F-045: this long without the server, and the peer stops its agents. */
  selfFenceMs: 9.5 * MINUTE,
  /** ADR 0034: a dispatch offer not accepted in this time goes back to the queue. */
  offerTimeoutMs: 2 * MINUTE,
  /** ADR 0034: a connection older than this is asked to reconnect (`goaway`, reason `max-age`). */
  maxConnectionAgeMs: 60 * MINUTE,
  /** ADR 0034: the lifetime of a runner's access token. */
  accessTokenTtlMs: 10 * MINUTE,
  /** ADR 0034: how far a signed assertion's `issuedAt` may be from the server's clock. */
  assertionSkewMs: 2 * MINUTE,
  /** ADR 0034: reconnects use full jitter from this... */
  backoffMinMs: 1 * SECOND,
  /** ...to this. */
  backoffMaxMs: 60 * SECOND,
  /** ADR 0034: a refused (outdated) runner retries this often. */
  versionRetryMs: 5 * MINUTE,
  /** ADR 0034: in HTTP mode, the runner tries the WebSocket again this often (milestone 5). */
  wsRetryMs: 10 * MINUTE,
  /** ADR 0034: the HTTP fallback's long poll holds this long (milestone 5). */
  longPollMs: 25 * SECOND,
  /** ADR 0035: partial text goes out at most this often per segment. */
  liveTextIntervalMs: 250,

  // ---- milestone 2, protocol minor 1 ----
  /** ADR 0039, F-096: a box with no turn for this long stops its agent (`OSTRA_BOX_IDLE_MINUTES`). */
  idleMinutes: 15,
  /** ADR 0037, F-068: a session's longest life, timed by core (`OSTRA_SESSION_MAX_MINUTES`). */
  sessionMaxMinutes: 120,
  /** ADR 0037, F-068: this long with no agent event, and core stops the session (`OSTRA_SESSION_STALL_MINUTES`). */
  stallMinutes: 10,
  /** ADR 0043: the largest chunk of one `PUT` on the bulk path. */
  uploadChunkMaxBytes: 1 * MiB,
  /** ADR 0043, ADR 0039: the blob cap, and so the session archive's. Over it, the next reopen uses the template. */
  archiveMaxBytes: 64 * MiB,
  /** Spec section 11, item 9: the most ticket images copied into one task's workspace. */
  ticketFilesMax: 20,
  /** Spec section 11, item 9: the largest ticket image copied into the workspace. */
  ticketFileMaxBytes: 10 * MiB,

  // ---- milestone 3, protocol minor 2 ----
  /** ADR 0052, F-054: one check's timeout, unless the check sets its own (`OSTRA_CHECK_TIMEOUT_SECONDS`). */
  checkTimeoutSeconds: 600,
  /** ADR 0052, F-054: the longest one check's timeout may be set to. */
  checkTimeoutMaxSeconds: 3600,
  /** ADR 0052, F-054: all of a turn's checks together (`OSTRA_CHECKS_TOTAL_MINUTES`). */
  checksTotalMinutes: 30,
  /** ADR 0052: the end of a check's output carried in `check.finished`. */
  checkOutputTailMaxBytes: 16 * KiB,
  /** ADR 0052: a check's full output, uploaded as a blob; past it the blob is cut. */
  checkOutputBlobMaxBytes: 4 * MiB,
  /** The most checks one environment runs after a turn. */
  checksMax: 50,
  /** ADR 0036, F-026: an approval or a question waits this long, then the turn is cancelled. */
  approvalWaitMinutes: 15,
  /** ADR 0049, F-063: the plan turn's last message, in `plan.proposed`, and an approved plan's text. */
  planMessageMaxBytes: 64 * KiB,
  /** ADR 0049, F-063: the most entries a plan carries. */
  planEntriesMax: 200,
  /** ADR 0051, F-072: one diff comment's text, in characters. */
  diffCommentMaxChars: 4000,
  /** ADR 0051, F-072: the most comments one send carries. */
  diffCommentsPerSendMax: 50,
  /** ADR 0049, F-026: a deny's reason, in characters. */
  denyReasonMaxChars: 2000,
  /** ADR 0049, F-021: a skill's files (working value). */
  skillFilesMax: 20,
  /** ADR 0049, F-021: one skill file (working value). */
  skillFileMaxBytes: 1 * MiB,
  /** ADR 0049, F-021: the most skills a profile hands one task. */
  skillsMax: 50,
  /** ADR 0049, F-021: the most MCP servers a profile hands one task. */
  mcpServersMax: 20,
  /** ADR 0049, F-026: the most rules a profile or a task carries. */
  approvalRulesMax: 200,
  /** F-094: the most services one environment starts. */
  servicesMax: 20,
} as const;

export type RunnerLimits = typeof runnerLimits;
