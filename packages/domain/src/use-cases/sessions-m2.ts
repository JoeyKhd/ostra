import type { Tx } from "@ostra/db";
import type { OrganizationId, SessionId, SessionLimit, TaskEventOf, TaskId, TaskSeq } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// A session that lives across turns (F-096, F-068; spec section 4, "After every turn" and "The idle
// timer"). Both run in the ingest transaction of the event that caused them.

// ---------- after every turn (ticket 17) ----------

export type RecordWorkSavedInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  /** The stored `session.saved` and its task seq, which keys the PR job. */
  readonly event: TaskEventOf<"session.saved">;
  readonly eventSeq: TaskSeq;
};

export type RecordWorkSavedResult = UseCaseResult<
  {
    /** What the task did: to review (the first PR, or the same ones updated), needs you, or nothing new. */
    readonly outcome: "in-review" | "needs-you" | "unchanged";
  },
  "not-found" | "stale"
>;

export type RecordWorkSavedDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly tx: Tx };

/**
 * Saves each repo's head and hidden ref, and the session's archive; moves the task by `work_saved`;
 * enqueues `task.open-pull-requests` (idempotent per task repo) when a branch is ahead, or raises
 * F-065's needs-you item when nothing changed and no PR is open. The session goes idle.
 */
export type RecordWorkSaved = (deps: RecordWorkSavedDeps, input: RecordWorkSavedInput) => Promise<RecordWorkSavedResult>;

export const recordWorkSaved: RecordWorkSaved = () => notYet("17");

// ---------- runaway protection (ticket 19) ----------

export type RecordLimitReachedInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly limit: SessionLimit;
  /** Minutes, micro-USD or tokens. */
  readonly observed: number;
  /** The runner sent it (the spend cap) or core times it (the maximum duration, the stall). */
  readonly by: "runner" | "core";
};

export type RecordLimitReachedResult = UseCaseResult<
  { readonly stopped: boolean },
  "not-found" | "not-running"
>;

export type RecordLimitReachedDeps = Pick<Ports, "outbox" | "jobs" | "notices" | "clock"> & { readonly tx: Tx };

/**
 * Stops the session (`limitReached` on its row; a core-timed limit also records its own
 * `session.limit_reached` event and sends `stop` with the reason), moves the task by
 * `limit_reached`, and raises its needs-you item for the driver (`stalled` or `spend_cap`).
 */
export type RecordLimitReached = (deps: RecordLimitReachedDeps, input: RecordLimitReachedInput) => Promise<RecordLimitReachedResult>;

export const recordLimitReached: RecordLimitReached = () => notYet("19");
