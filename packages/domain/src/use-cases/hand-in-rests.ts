import type { Logger } from "@ostra/adapter-sdk";
import type { mapTask, Tx } from "@ostra/db";

import type { ChangeNotices, JobQueue } from "../ports.ts";
import { moveTaskInTx } from "./moves.ts";
import type { TaskMoveDeps } from "./moves.ts";
import { createNeedsYouItemInTx } from "./needs-you-items.ts";

// A refine or a review task hands in one thing through ostra's MCP tools, a draft or a review,
// never a branch, so no `work_saved` moves it: each turn's save and its session's end settle it
// instead (domain-model.md, "Refine and review tasks"; the stuck review and the stuck refine,
// 2026-11-23). It never stays running with nothing left to hand in:
//
// - what it owes is in, or nothing is left to hand in: it rests (done, or its draft in front of
//   its owner);
// - still owed after a turn: it runs on, its box warm, so a member's message still reaches its
//   agent;
// - still owed once its session ends: it needs its driver (`stalled`), one click from carrying on.
//
// A crash under a turn is the crash's own move (F-047): needs you, crashed.
//
// `settleReviewTaskInTx` (review-rests.ts) and `settleRefineTaskInTx` (refine-drafts.ts) each say
// what their kind owes; this module holds what they share.

export type SettleHandInDeps = { readonly jobs: JobQueue; readonly notices: ChangeNotices; readonly logger?: Logger | undefined };

/** The task row a settle reads, as `mapTask` gives it. */
export type HandInTaskRow = Pick<
  ReturnType<typeof mapTask>,
  "id" | "organizationId" | "projectId" | "kind" | "state" | "subState" | "needsYouReason" | "stoppedReason" | "driverMemberId"
>;

/** What ended: one of its turns (its save), or its session. */
export type HandInEnd = "turn" | "session";

/** Where the task is after it: still running, resting, or waiting for a person. */
export type HandInSettled = "running" | "done" | "needs-you";

/** The move deps of a settle, in the caller's transaction. */
export const handInMoveDeps = (deps: SettleHandInDeps, tx: Tx): TaskMoveDeps => ({
  tx,
  notices: deps.notices,
  jobs: deps.jobs,
  ...(deps.logger === undefined ? {} : { logger: deps.logger }),
});

/**
 * The task's session ended without what it owes: it needs its driver (the project's members when
 * it has none) as stalled, and one click carries it on. `summary` is ostra's words, never the
 * agent's. `true` when it moved.
 */
export const stallWithoutHandInInTx = async (deps: SettleHandInDeps, tx: Tx, task: HandInTaskRow, summary: string): Promise<boolean> => {
  const moved = await moveTaskInTx(handInMoveDeps(deps, tx), task, { type: "needs_you", reason: "stalled" });
  if (moved) {
    await createNeedsYouItemInTx(deps, tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      reason: "stalled",
      audience: task.driverMemberId === null ? "project_members" : "driver",
      summary,
    });
  }
  return moved;
};
