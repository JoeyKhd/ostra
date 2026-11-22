import type { Tx } from "@ostra/db";

import { handInMoveDeps, stallWithoutHandInInTx } from "../use-cases/hand-in-rests.ts";
import type { HandInEnd, HandInSettled, HandInTaskRow, SettleHandInDeps } from "../use-cases/hand-in-rests.ts";
import { moveTaskInTx } from "../use-cases/moves.ts";

// The stuck AI review (the maintainer, 2026-11-22: "this ai review never stops btw"). A review task
// left `running` only by posting its round's findings (`findings_posted`), so a turn that ended with
// nothing new to hand in kept it running for good: a member's message after its review posted (the
// agent's repeat hand-in answered `already`, or refused once the round was over), or a round a moved
// head voided. Its session then idled out and its lease ended, and its code task said "AI review:
// running" with nothing running. Each turn's save and the session's end now settle it, by the rule
// every refine and review task follows (hand-in-rests.ts):
//
// - its round's review handed in and not yet posted: it runs on, and the post makes it done;
// - nothing left to hand in (the round posted, voided, or its code task no longer waits for it):
//   it rests as done, the round's review standing as posted;
// - its round still waiting for its review: after a turn it runs on, its box warm, so a member's
//   message still reaches its agent; once its session ends without the review, it needs its driver
//   (`stalled`), and one click carries it on to a hand-in that counts.
//
// A session that crashes under its turn is the crash's own move: needs you, crashed.

/** The words of the item a round's review that never came raises. Never the agent's own words. */
export const REVIEW_NOT_HANDED_IN = "The review's session ended before it handed in its review. Carry on to finish it.";

/**
 * Settles a running review task after its turn's save or its session's end, in the caller's
 * transaction and the task's lock. `null` for any other task, or one not running.
 */
export const settleReviewTaskInTx = async (deps: SettleHandInDeps, tx: Tx, task: HandInTaskRow, ended: HandInEnd): Promise<HandInSettled | null> => {
  if (task.kind !== "review" || task.state !== "running") {
    return null;
  }
  const run = await tx.reviewRun.findFirst({ where: { reviewTaskId: task.id }, orderBy: { round: "desc" }, select: { id: true, state: true, codeTaskId: true } });
  if (run?.state === "submitted") {
    return "running";
  }
  const code = run === null ? null : await tx.task.findUnique({ where: { id: run.codeTaskId }, select: { state: true, subState: true } });
  const roundWaits = run?.state === "running" && code?.state === "in_review" && code.subState === "ai_review";
  if (!roundWaits) {
    const moved = await moveTaskInTx(handInMoveDeps(deps, tx), task, { type: "nothing_to_hand_in" });
    deps.logger?.info("review.rests", { reviewTaskId: task.id, reviewRunId: run?.id ?? null, runState: run?.state ?? null, ended, moved });
    return "done";
  }
  if (ended === "turn") {
    return "running";
  }
  const moved = await stallWithoutHandInInTx(deps, tx, task, REVIEW_NOT_HANDED_IN);
  deps.logger?.info("review.not-handed-in", { reviewTaskId: task.id, reviewRunId: run.id, moved });
  return "needs-you";
};
