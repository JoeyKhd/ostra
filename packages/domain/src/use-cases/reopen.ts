import type { Tx } from "@ostra/db";
import { clientMessageIdSchema, needsYouItemIdSchema, runnerLimits, taskIdSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, NeedsYouItemId, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// Reopening (F-032, F-033, F-047; ADR 0039's three steps; spec section 4, "Reopen", and the
// decisions of ticket 40). `reopenTask` is the member's action; `chooseReopenStep` is the
// dispatch's choice of the same box, a fresh box from the archive, or the rebuild template.

// ---------- the member's reopen (ticket 18, router ticket 30) ----------

export const reopenTaskInputSchema = z.strictObject({
  taskId: taskIdSchema,
  clientMessageId: clientMessageIdSchema,
  /**
   * The member's message. Optional only for the one-click reopen from a limit or a crash: the
   * server then writes `reopenCarryOnText`, unless a lost box's unanswered message is replayed.
   * Never logged.
   */
  text: z.string().trim().min(1).max(runnerLimits.steerTextMaxChars).optional(),
});
export type ReopenTaskInput = z.infer<typeof reopenTaskInputSchema>;

export type ReopenTaskResult = UseCaseResult<
  { readonly sessionId: SessionId },
  | "not-found"
  | "forbidden"
  /** In milestone 2 a merged task isn't reopened: its fresh branch is F-066, milestone 3. */
  | "merged_reopen_later"
  /** Another active task holds the ticket (spec section 11, item 12). */
  | "ticket-has-task"
  /** The task is running, queued or preparing: there's nothing to reopen. */
  | "not-reopenable"
  /** A reopen that isn't from a limit or a crash needs the member's message. */
  | "text-required"
>;

export type ReopenTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

/**
 * Writes the member's message (`user.message` with `reopen: true`), makes the member the driver, a
 * new session, and enqueues `task.dispatch`, which picks the step and raises the lease epoch.
 */
export type ReopenTask = (deps: ReopenTaskDeps, input: ReopenTaskInput) => Promise<ReopenTaskResult>;

export const reopenTask: ReopenTask = () => notYet("18");

// ---------- "Carry on without it" (ticket 18, router ticket 30) ----------

export const dismissNeedsYouInputSchema = z.strictObject({ taskId: taskIdSchema, itemId: needsYouItemIdSchema });
export type DismissNeedsYouInput = z.infer<typeof dismissNeedsYouInputSchema>;

export type DismissNeedsYouResult = UseCaseResult<{ readonly itemId: NeedsYouItemId }, "not-found" | "forbidden" | "not-open">;

/** Dismisses a needs-you item that doesn't hold the task, such as a restore conflict, as its audience. */
export type DismissNeedsYou = (deps: ReopenTaskDeps, input: DismissNeedsYouInput) => Promise<DismissNeedsYouResult>;

export const dismissNeedsYou: DismissNeedsYou = () => notYet("18");

// ---------- the dispatch's choice (ADR 0039) ----------

export type ReopenStepInput = {
  /** The task's last box, while it's kept: its runner, if online and at protocol minor 1 or above, still holds it. */
  readonly keptBox: { readonly boxId: BoxId; readonly runnerOnline: boolean; readonly runnerMinor: number } | null;
  /** The last session's archive, while the blob store still holds it. */
  readonly archive: BlobRef | null;
  /** The profile's agent adapter can import an archive (its `sessionArchive` capability). */
  readonly agentImportsArchives: boolean;
  /** The archive was made by the agent the task runs now: another agent can't load it (F-018). */
  readonly sameAgent: boolean;
};

export type ReopenStep =
  | { readonly step: "resumed"; readonly boxId: BoxId }
  | { readonly step: "restored"; readonly archive: BlobRef }
  | { readonly step: "rebuilt"; readonly reason: "no-archive" | "other-agent" | "archive-unsupported" };

/**
 * ADR 0039's three steps, in order: the same box while it's kept, a fresh box from the archive and
 * the hidden ref (the normal path), the rebuild template. Pure.
 */
export const chooseReopenStep = (input: ReopenStepInput): ReopenStep => {
  if (input.keptBox !== null && input.keptBox.runnerOnline && input.keptBox.runnerMinor >= 1) {
    return { step: "resumed", boxId: input.keptBox.boxId };
  }
  if (input.archive === null) {
    return { step: "rebuilt", reason: "no-archive" };
  }
  if (!input.sameAgent) {
    return { step: "rebuilt", reason: "other-agent" };
  }
  if (!input.agentImportsArchives) {
    return { step: "rebuilt", reason: "archive-unsupported" };
  }
  return { step: "restored", archive: input.archive };
};

/** What a reopened task's thread says it came back from: the event's `origin`. */
export type ReopenedTask = { readonly taskId: TaskId; readonly step: ReopenStep };
