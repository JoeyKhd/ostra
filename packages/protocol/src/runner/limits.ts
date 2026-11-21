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
  /** Q133, ticket 44: the most names a `workspace.files_outside_repos` lists *(working value)*. */
  filesOutsideReposMax: 50,
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

  // ---- milestone 4, protocol minor 3 (working values) ----
  /** ADR 0044, F-109: a memory note's title, in characters. */
  memoryNoteTitleMaxChars: 120,
  /** ADR 0044, F-109: a memory note's body, in UTF-8 bytes. */
  memoryNoteBodyMaxBytes: 4 * KiB,
  /** ADR 0044, F-110: the most notes the index lists (`OSTRA_MEMORY_INDEX_MAX_NOTES`). */
  memoryIndexMaxNotes: 100,
  /** ADR 0044, F-110: the index's size (`OSTRA_MEMORY_INDEX_MAX_KIB`). */
  memoryIndexMaxBytes: 8 * KiB,
  /** ADR 0044, F-110: the "always" notes' size together (`OSTRA_MEMORY_ALWAYS_MAX_KIB`). */
  memoryAlwaysMaxBytes: 8 * KiB,
  /** ADR 0044, F-110: the memory block a spec carries: the "always" notes, the index and the instruction. */
  memoryBlockMaxBytes: 24 * KiB,
  /** ADR 0044, F-110: a memory search's query, in characters. */
  memoryQueryMaxChars: 500,
  /** ADR 0044, F-110: the most results one memory search returns. */
  memorySearchResultsMax: 20,
  /** ADR 0044 (2026-11-21), F-110: the most notes one `memory_read` reads, each from core's endpoint. */
  memoryReadNotesMax: 10,
  /** ADR 0044, F-111: the most proposals one task makes (`OSTRA_MEMORY_PROPOSALS_PER_TASK`). */
  memoryProposalsPerTask: 20,
  /** ADR 0054, F-080: one search entry's text, in UTF-8 bytes (`OSTRA_SEARCH_ENTRY_MAX_KIB`). */
  searchEntryMaxBytes: 8 * KiB,
  /** ADR 0027, F-098: the most repos a project holds (`OSTRA_PROJECT_MAX_REPOS`), and so a PR's "Related" list. */
  projectReposMax: 10,

  // ---- milestone 6, protocol minor 5 (working values, spec section 5.1) ----
  /** ADR 0028, F-099: a refine draft's description, in UTF-8 bytes. */
  draftDescriptionMaxBytes: 32 * KiB,
  /** ADR 0028, F-099: the most acceptance criteria a draft holds. */
  draftAcceptanceCriteriaMax: 30,
  /** ADR 0028, F-099: the most edge cases a draft holds. */
  draftEdgeCasesMax: 30,
  /** ADR 0028, F-099: the most open questions a draft holds. */
  draftOpenQuestionsMax: 30,
  /** ADR 0028, F-099: one acceptance criterion, edge case or open question, in characters. */
  draftItemMaxChars: 2000,
  /** ADR 0028, F-099: the most sub-tickets a draft proposes. */
  draftSubTicketsMax: 20,
  /** ADR 0028, F-099: a sub-ticket's description, in UTF-8 bytes. */
  draftSubTicketMaxBytes: 8 * KiB,
  /** ADR 0028, F-099: a sub-ticket's title, in characters. */
  draftSubTicketTitleMaxChars: 256,
  /** ADR 0058, F-100: the most findings one review hands in (`OSTRA_REVIEW_FINDINGS_MAX`). */
  reviewFindingsMax: 30,
  /** ADR 0058, F-100: a finding's body, in UTF-8 bytes. */
  findingBodyMaxBytes: 4 * KiB,
  /** ADR 0058, F-100: a finding's title, in characters. */
  findingTitleMaxChars: 200,
  /** ADR 0058, F-100: a finding's suggested replacement, in UTF-8 bytes. */
  findingSuggestionMaxBytes: 4 * KiB,
  /** ADR 0058, F-100: a review's summary, in UTF-8 bytes. */
  reviewSummaryMaxBytes: 8 * KiB,
  /** ADR 0058, F-035: a CI log tail handed to the agent, in bytes (`OSTRA_CI_LOG_TAIL_KIB`). */
  ciLogTailMaxBytes: 64 * KiB,
  /** ADR 0058, F-035: the most failing checks one CI round carries (`OSTRA_CI_LOG_CHECKS`). */
  ciLogChecksMax: 5,
  /** ADR 0038, F-113: an environment proposal, in UTF-8 bytes of its JSON. */
  environmentProposalMaxBytes: 256 * KiB,
  /** ADR 0038, F-113: an environment proposal's notes, in UTF-8 bytes. */
  environmentProposalNotesMaxBytes: 16 * KiB,
  /** ADR 0038, F-113: the most paths `commit.filtered` lists; the rest are counted. */
  commitFilteredPathsMax: 50,
  /** ADR 0038, F-113: the most paths or globs a task may commit (`commitPaths`). */
  commitPathsMax: 50,
  /** F-138 (minor 6): what a subagent was asked, in `subagent.started`, in characters; longer is cut. */
  subagentPromptMaxChars: 32_768,
  /** F-138 (minor 6): a subagent's description, OpenCode's 3-to-5-word label, in characters. */
  subagentDescriptionMaxChars: 500,

  // ---- milestone 8, protocol minor 7 (working values, spec section 5.1, ADR 0068) ----
  /** F-140: the most app processes one environment declares. */
  appProcessesMax: 10,
  /** F-140: the lowest port an app process, an announced preview or a view may use. Below it is refused. */
  appPortMin: 1024,
  /** F-140: the longest a process's ready check is tried, in seconds. */
  appReadyTimeoutSeconds: 120,
  /** F-140: how often a ready check is tried, in ms. */
  appReadyIntervalMs: 2 * SECOND,
  /** F-140: the end of a process's log that `app.process` names when it fails, as a blob. */
  appLogTailMaxBytes: 64 * KiB,
  /** F-121: the most routes the after-turn screenshots take. */
  screenshotRoutesMax: 5,
  /** F-121: the most widths the after-turn screenshots take. */
  screenshotWidthsMax: 2,
  /** F-121: a screenshot's PNG, in bytes. */
  screenshotMaxBytes: 8 * MiB,
  /** F-121: a screenshot's height, in pixels, full page included. */
  screenshotMaxHeightPx: 10_000,
  /** F-121: a screenshot's width when the agent gives a size, in pixels. */
  screenshotMaxWidthPx: 3840,
  /** F-121: the longest a page may take to go quiet before a screenshot, in ms. */
  screenshotSettleMaxMs: 15 * SECOND,
  /** F-121: a recording's length, in seconds. */
  recordingMaxSeconds: 30,
  /** F-121: a recording's frames a second. */
  recordingFramesPerSecond: 10,
  /** F-121: a recording's frame reel, in bytes. */
  recordingMaxBytes: 32 * MiB,
  /** F-121: the most steps one recording runs. */
  recordingStepsMax: 20,
  /** F-121: the most attachments one turn adds; past it the tools say so. */
  attachmentsPerTurnMax: 20,
  /** F-121: a caption, in UTF-8 bytes. */
  captionMaxBytes: 1 * KiB,
  /** F-121: the most attachments one finding names. */
  findingAttachmentsMax: 5,
  /** F-141: the most ports the agent announces in one task. */
  announcedPreviewsMax: 10,
  /** F-141: the most pages one box's browser holds open: the shared ones and the tools'. */
  boxPagesMax: 4,
  /** F-141: the browser view's frames a second on the WebSocket. */
  browserViewFramesPerSecond: 15,
  /**
   * F-141, Q326: the browser view's largest page, in pixels (width × height): the desktop preset's
   * 1440×900, whose frames spike 07 measured (about 74 KB each at quality 60). The tablet's 834×1112
   * and the phone's 390×844 fit, and a frame stays within the same count of pixels, so its bytes do.
   */
  browserViewMaxPixels: 1440 * 900,
  /** F-141, Q326: the browser view's longest side, either way, in pixels. */
  browserViewMaxSide: 1920,
  /** F-141: the browser view's shortest side, in pixels. */
  browserViewMinSide: 200,
  /** F-141: the browser view's JPEG quality. */
  browserViewQuality: 60,
  /** F-141, Q306: the browser view's frames a second on the HTTP carrier. */
  httpCarrierFramesPerSecond: 2,
  /**
   * F-141: the most frames the screencast has in flight before the box acks one. Spike 07: one,
   * with each ack held to the rate's cap and `sendLastFrame` on, so the last change still arrives.
   */
  browserViewFramesInFlight: 1,
  /** F-141: one frame's JPEG on the preview connection or the HTTP carrier, in bytes. */
  previewFrameMaxBytes: 2 * MiB,
  /** F-141: one JSON part of a preview message (a frame's header, a control), in UTF-8 bytes. */
  previewJsonMaxBytes: 64 * KiB,
  /** F-141: the most input events one batch carries. */
  previewInputEventsMax: 100,
  /** F-141: one `text` input event, in characters. */
  previewInputTextMaxChars: 4096,
  /** F-141: a path a preview opens or a screenshot takes, in characters. */
  appPathMaxChars: 2048,
} as const;

export type RunnerLimits = typeof runnerLimits;

/**
 * The ports in a box that are never a preview (ADR 0068, "What a preview may reach"): the
 * sidecar's key proxy, git proxy, MCP proxy and control API, the agent's own loopback port and the
 * box's browser's. The sidecar and the runner pick most of them when the box starts, so they are
 * named here and given numbers at run time (`ReservedPorts`).
 */
export const reservedPortNames = ["key-proxy", "git-proxy", "mcp-proxy", "sidecar-control", "agent-loopback", "browser"] as const;
export type ReservedPortName = (typeof reservedPortNames)[number];

/** The reserved ports of one box, by name: `null` for one this box doesn't run. */
export type ReservedPorts = Readonly<Record<ReservedPortName, number | null>>;

/** Why a port may not be a preview or a tool's target: below `appPortMin`, or one of the box's reserved ports. */
export type PortRefusal =
  | { readonly reason: "below-min" }
  | { readonly reason: "reserved"; readonly name: ReservedPortName };

/** Whether a port may be a preview or an app tool's target (ADR 0068). `null`: it may. */
export const portRefusal = (port: number, reserved: ReservedPorts): PortRefusal | null => {
  if (!Number.isInteger(port) || port < runnerLimits.appPortMin || port > 65_535) {
    return { reason: "below-min" };
  }
  for (const name of reservedPortNames) {
    if (reserved[name] === port) {
      return { reason: "reserved", name };
    }
  }
  return null;
};
