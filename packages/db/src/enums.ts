import type {
  ApiFormat,
  AuthScheme,
  BoxReleaseReason,
  CommandKind,
  CommandResult,
  SessionLimit,
  SessionOutcome,
} from "@ostra/protocol";

import type {
  ApiFormat as DbApiFormat,
  AuthScheme as DbAuthScheme,
  BoxReleaseReason as DbBoxReleaseReason,
  CommandKind as DbCommandKind,
  CommandResult as DbCommandResult,
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
