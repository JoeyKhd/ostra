import type { Db } from "@ostra/db";
import { automaticRoundOfSessionInTx, ciLogFileName, REVIEW_TASK_TOOLS, reviewHeadsSchema } from "@ostra/domain";
import { blobIdSchema, runnerLimits, taskIdSchema } from "@ostra/protocol";
import type { OstraToolSet, TaskSpecContextFile, TaskSpecReview } from "@ostra/protocol";

// Milestone 6's parts of a task spec (F-035, F-100, F-101; tickets 17 and 18): a review task's
// checkout (each repo at its PR's head, read-only) with the review and memory tools, and an
// automatic round's flag with a CI round's log tails as `ci` files. A log's text never leaves the
// blob store here: the spec names the blobs, and the runner fetches them like a ticket's images.

export type ReviewLoopSpecParts = {
  readonly review?: TaskSpecReview;
  readonly tools?: readonly OstraToolSet[];
  readonly automatic?: true;
  /** The CI round's log tails, as `ci` files. */
  readonly ciFiles: readonly TaskSpecContextFile[];
};

/** A log tail's content type. */
const CI_LOG_CONTENT_TYPE = "text/plain";

export const specReviewLoopParts = async (
  db: Db,
  task: { readonly id: string; readonly organizationId: string; readonly kind: "code" | "refine" | "review" },
  session: { readonly id: string },
): Promise<ReviewLoopSpecParts> => {
  if (task.kind === "review") {
    // The review run this session reads: the newest one still running, made with the session.
    const run = await db.reviewRun.findFirst({ where: { reviewTaskId: task.id, state: "running" }, orderBy: { round: "desc" }, select: { codeTaskId: true, round: true, heads: true } });
    const heads = reviewHeadsSchema.safeParse(run?.heads);
    if (run === null || !heads.success || heads.data.length === 0) {
      return { tools: [...REVIEW_TASK_TOOLS], ciFiles: [] };
    }
    return {
      review: { codeTaskId: taskIdSchema.parse(run.codeTaskId), round: run.round, repos: heads.data.map((head) => ({ repoId: head.repoId, prNumber: head.prNumber, baseSha: head.baseSha, headSha: head.headSha })) },
      tools: [...REVIEW_TASK_TOOLS],
      ciFiles: [],
    };
  }
  const round = await automaticRoundOfSessionInTx(db, { taskId: task.id, sessionId: session.id });
  if (round === null) {
    return { ciFiles: [] };
  }
  const blobs = round.logFiles.length === 0 ? [] : await db.blob.findMany({ where: { id: { in: round.logFiles.map((entry) => entry.blobId) }, organizationId: task.organizationId, taskId: task.id }, select: { id: true, size: true } });
  const ciFiles = round.logFiles
    .slice(0, runnerLimits.ciLogChecksMax)
    .flatMap((entry): TaskSpecContextFile[] => {
      const blob = blobs.find((row) => row.id === entry.blobId);
      return blob === undefined || blob.size > runnerLimits.ciLogTailMaxBytes
        ? []
        : [{ blobId: blobIdSchema.parse(blob.id), path: ciLogFileName(entry.blobId), contentType: CI_LOG_CONTENT_TYPE, size: blob.size, folder: "ci" }];
    });
  return { automatic: true, ciFiles };
};
