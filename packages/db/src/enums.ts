import type {
  ApiFormat,
  ApprovalSubjectKind,
  ApprovalTool,
  AuthScheme,
  BoxReleaseReason,
  CheckStatus,
  CommandKind,
  CommandResult,
  EffortLevel,
  MemoryKind,
  MemoryScope,
  MemoryUseVia,
  ProcessContainment,
  ProposalRelation,
  ReviewCheckStatus,
  SessionLimit,
  SessionOutcome,
  TurnOrigin,
} from "@ostra/protocol";

import type {
  ApiFormat as DbApiFormat,
  ApprovalRuleSource as DbApprovalRuleSource,
  ApprovalSubjectKind as DbApprovalSubjectKind,
  ApprovalTool as DbApprovalTool,
  AuthScheme as DbAuthScheme,
  CheckRunStatus as DbCheckRunStatus,
  BoxReleaseReason as DbBoxReleaseReason,
  CommandKind as DbCommandKind,
  CommandResult as DbCommandResult,
  EffortLevel as DbEffortLevel,
  HeldTurnOrigin as DbHeldTurnOrigin,
  MemoryKind as DbMemoryKind,
  MemoryScope as DbMemoryScope,
  MemoryUseVia as DbMemoryUseVia,
  ProposalRelation as DbProposalRelation,
  ReviewCheckStatus as DbReviewCheckStatus,
  ProcessContainment as DbProcessContainment,
  SessionLimit as DbSessionLimit,
  SessionOutcome as DbSessionOutcome,
} from "./generated/prisma/enums.ts";

// The enums whose protocol values have a hyphen, which a Prisma enum value can't. Each map is
// checked both ways by its type, so adding a value on one side without the other is a type error.

export const apiFormatToDb = {
  "openai-compatible": "openai_compatible",
  "anthropic-messages": "anthropic_messages",
} as const satisfies Record<ApiFormat, DbApiFormat>;
export const apiFormatFromDb = {
  openai_compatible: "openai-compatible",
  anthropic_messages: "anthropic-messages",
} as const satisfies Record<DbApiFormat, ApiFormat>;

export const authSchemeToDb = {
  bearer: "bearer",
  "x-api-key": "x_api_key",
} as const satisfies Record<AuthScheme, DbAuthScheme>;
export const authSchemeFromDb = {
  bearer: "bearer",
  x_api_key: "x-api-key",
} as const satisfies Record<DbAuthScheme, AuthScheme>;

export const commandKindToDb = {
  dispatch: "dispatch",
  steer: "steer",
  interrupt: "interrupt",
  stop: "stop",
  "approval-answer": "approval_answer",
  drain: "drain",
  "update-hint": "update_hint",
  release: "release",
  "question-answer": "question_answer",
  "plan-answer": "plan_answer",
  "snapshot-build": "snapshot_build",
  "set-effort": "set_effort",
  resume: "resume",
} as const satisfies Record<CommandKind, DbCommandKind>;
export const commandKindFromDb = {
  dispatch: "dispatch",
  steer: "steer",
  interrupt: "interrupt",
  stop: "stop",
  approval_answer: "approval-answer",
  drain: "drain",
  update_hint: "update-hint",
  release: "release",
  question_answer: "question-answer",
  plan_answer: "plan-answer",
  snapshot_build: "snapshot-build",
  set_effort: "set-effort",
  resume: "resume",
} as const satisfies Record<DbCommandKind, CommandKind>;

export const commandResultToDb = {
  accepted: "accepted",
  rejected: "rejected",
  done: "done",
  "outcome-unknown": "outcome_unknown",
} as const satisfies Record<CommandResult, DbCommandResult>;
export const commandResultFromDb = {
  accepted: "accepted",
  rejected: "rejected",
  done: "done",
  outcome_unknown: "outcome-unknown",
} as const satisfies Record<DbCommandResult, CommandResult>;

export const sessionOutcomeToDb = {
  "with-changes": "with_changes",
  "without-changes": "without_changes",
} as const satisfies Record<SessionOutcome, DbSessionOutcome>;
export const sessionOutcomeFromDb = {
  with_changes: "with-changes",
  without_changes: "without-changes",
} as const satisfies Record<DbSessionOutcome, SessionOutcome>;

// ---- milestone 2 ----

export const sessionLimitToDb = {
  "max-duration": "max_duration",
  stall: "stall",
  "spend-cap": "spend_cap",
} as const satisfies Record<SessionLimit, DbSessionLimit>;
export const sessionLimitFromDb = {
  max_duration: "max-duration",
  stall: "stall",
  spend_cap: "spend-cap",
} as const satisfies Record<DbSessionLimit, SessionLimit>;

export const boxReleaseReasonToDb = {
  "prs-closed": "prs_closed",
  "idle-expired": "idle_expired",
  "task-deleted": "task_deleted",
  requested: "requested",
} as const satisfies Record<BoxReleaseReason, DbBoxReleaseReason>;
export const boxReleaseReasonFromDb = {
  prs_closed: "prs-closed",
  idle_expired: "idle-expired",
  task_deleted: "task-deleted",
  requested: "requested",
} as const satisfies Record<DbBoxReleaseReason, BoxReleaseReason>;

export const processContainmentToDb = {
  container: "container",
  "job-object": "job_object",
  cgroup: "cgroup",
  "process-tree": "process_tree",
} as const satisfies Record<ProcessContainment, DbProcessContainment>;
export const processContainmentFromDb = {
  container: "container",
  job_object: "job-object",
  cgroup: "cgroup",
  process_tree: "process-tree",
} as const satisfies Record<DbProcessContainment, ProcessContainment>;

// ---- milestone 3 ----

/** A check run's status: the protocol's results, and `running` between `check.started` and `check.finished`. */
export type CheckRunStatus = CheckStatus | "running";

export const checkRunStatusToDb = {
  running: "running",
  passed: "passed",
  failed: "failed",
  "timed-out": "timed_out",
  error: "error",
} as const satisfies Record<CheckRunStatus, DbCheckRunStatus>;
export const checkRunStatusFromDb = {
  running: "running",
  passed: "passed",
  failed: "failed",
  timed_out: "timed-out",
  error: "error",
} as const satisfies Record<DbCheckRunStatus, CheckRunStatus>;

// The protocol's rule vocabularies, spelled the same in the database. The maps hold the two in
// step: a value added on one side only is a type error.
export const approvalToolToDb = {
  edit: "edit",
  execute: "execute",
  fetch: "fetch",
  mcp: "mcp",
} as const satisfies Record<ApprovalTool, DbApprovalTool>;
export const approvalToolFromDb = {
  edit: "edit",
  execute: "execute",
  fetch: "fetch",
  mcp: "mcp",
} as const satisfies Record<DbApprovalTool, ApprovalTool>;

export const approvalSubjectKindToDb = {
  path: "path",
  command: "command",
  url: "url",
  tool: "tool",
} as const satisfies Record<ApprovalSubjectKind, DbApprovalSubjectKind>;
export const approvalSubjectKindFromDb = {
  path: "path",
  command: "command",
  url: "url",
  tool: "tool",
} as const satisfies Record<DbApprovalSubjectKind, ApprovalSubjectKind>;

export const approvalRuleSourceFromDb = {
  profile: "profile",
  task: "task",
} as const satisfies Record<DbApprovalRuleSource, "profile" | "task">;

// ---------- milestone 4 ----------

/** What wanted a held turn (F-037, ADR 0055): the protocol's origins, hyphens as underscores. */
export const turnOriginToDb = {
  dispatch: "dispatch",
  reopen: "reopen",
  message: "message",
  "diff-comments": "diff_comments",
  "update-branch": "update_branch",
  "pr-comment": "pr_comment",
  "keep-working": "keep_working",
  "closing-turn": "closing_turn",
  "automatic-round": "automatic_round",
} as const satisfies Record<TurnOrigin, DbHeldTurnOrigin>;
export const turnOriginFromDb = {
  dispatch: "dispatch",
  reopen: "reopen",
  message: "message",
  diff_comments: "diff-comments",
  update_branch: "update-branch",
  pr_comment: "pr-comment",
  keep_working: "keep-working",
  closing_turn: "closing-turn",
  automatic_round: "automatic-round",
} as const satisfies Record<DbHeldTurnOrigin, TurnOrigin>;

/** A reasoning level (F-137, ADR 0066), spelled the same in the database and the protocol. Checked both ways. */
export const effortLevelFromDb = {
  default: "default",
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  on: "on",
} as const satisfies Record<DbEffortLevel, EffortLevel>;
export const effortLevelToDb = effortLevelFromDb satisfies Record<EffortLevel, DbEffortLevel>;

// The memory and review vocabularies (F-104, F-109, F-110, F-111), spelled the same in the
// database and the protocol. Each map is checked both ways.
export const memoryKindFromDb = {
  convention: "convention",
  command: "command",
  gotcha: "gotcha",
  decision: "decision",
  preference: "preference",
  term: "term",
} as const satisfies Record<DbMemoryKind, MemoryKind> & Record<MemoryKind, DbMemoryKind>;
export const memoryScopeFromDb = {
  organization: "organization",
  project: "project",
} as const satisfies Record<DbMemoryScope, MemoryScope> & Record<MemoryScope, DbMemoryScope>;
export const memoryUseViaFromDb = {
  index: "index",
  always: "always",
  search: "search",
  read: "read",
} as const satisfies Record<DbMemoryUseVia, MemoryUseVia> & Record<MemoryUseVia, DbMemoryUseVia>;
export const proposalRelationFromDb = {
  contradicts: "contradicts",
  refines: "refines",
} as const satisfies Record<DbProposalRelation, ProposalRelation> & Record<ProposalRelation, DbProposalRelation>;
export const reviewCheckStatusFromDb = {
  pending: "pending",
  passed: "passed",
} as const satisfies Record<DbReviewCheckStatus, ReviewCheckStatus> & Record<ReviewCheckStatus, DbReviewCheckStatus>;
