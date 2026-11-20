import type { CheckRunInput, CheckRunState, Logger, PullRequestReview } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { gitShaSchema, memberIdSchema, organizationIdSchema, projectIdSchema, repoIdSchema, sessionIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { GitSha, MemberId, OrganizationId, TaskId, TaskRepoId } from "@ostra/protocol";

import { reviewEvaluateSingletonSeconds } from "../jobs.ts";
import type { ChangeNotices, Clock, JobQueue, ServerAdapters } from "../ports.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import type { EvaluateReviewCheck } from "../use-cases/m4-signatures.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { recordReviewerStatesInTx } from "../review-loop/reviewers.ts";
import { evaluateIndependentReview, INDEPENDENT_REVIEW_CHECK_NAME, pendingReasonWords } from "./independent-review.ts";
import type { IndependentReviewVerdict, ReviewLite } from "./independent-review.ts";

// The `ostra/independent-review` check (F-104, ADR 0040 amended, Q207; milestone 4's ticket 18).
// `review.evaluate` reads a task PR's reviews, maps each reviewer through the verified GitHub links
// (F-119) to the organization's active members, takes the drivers from the task's trailers, runs
// spike 4's evaluator, and keeps the result in `ReviewCheck` for the PR's head. Only when the result
// changed does it publish or update the check run and write `review.check_updated` in the thread:
// a replayed webhook writes nothing. Logs and events carry logins and IDs, never a review's text.

/**
 * What a waiting check reports: `in_progress` until ticket 41's live test on `test1` records that it
 * doesn't block a merge under branch protection; then this one switch becomes `action_required`, and
 * ADR 0040 records the answer. Not a setting.
 */
export const REVIEW_CHECK_WAITING: "in_progress" | "action_required" = "in_progress";

export const REVIEW_CHECK_WAITING_TITLE = "Waiting for an independent reviewer";

/** The check run's state for a verdict, given how a waiting check reports. */
export const checkRunStateOf = (verdict: IndependentReviewVerdict, waiting: "in_progress" | "action_required" = REVIEW_CHECK_WAITING): CheckRunState => {
  if (verdict.status === "passed") {
    return { status: "completed", conclusion: "success" };
  }
  return waiting === "in_progress" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: "action_required" };
};

/** A review as the evaluator reads it: a pending review isn't submitted and counts for nothing. */
const liteOf = (review: PullRequestReview): ReviewLite | null =>
  review.submittedAt === null || review.state === "pending"
    ? null
    : { userId: review.userId, login: review.login, isBot: review.isBot, state: review.state, commitId: review.commitId ?? "", submittedAt: review.submittedAt };

export type ReviewCheckDeps = {
  readonly db: Db;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly logger?: Logger | undefined;
  /** Tests only: the other answer to ADR 0040's open question. */
  readonly waiting?: "in_progress" | "action_required";
  /** Milestone 6 (F-102): with it, each reviewer's latest review is kept and clears their needs-you notification. */
  readonly jobs?: JobQueue;
};

export type EvaluateReviewCheckResult =
  | {
      readonly ok: true;
      readonly verdict: IndependentReviewVerdict;
      /** `unchanged` when the head's stored result was the same: nothing was written. */
      readonly outcome: "published" | "updated" | "unchanged" | "unsupported";
    }
  | { readonly ok: false; readonly error: "not-found" | "not-a-task-pr"; readonly message: string };

/**
 * Evaluates one task PR's check on one head. A code host failure throws, so the job retries; an
 * adapter without reviews or check runs evaluates nothing (an optional capability, ADR 0025).
 */
export const evaluateReviewCheck = (async (
  deps: ReviewCheckDeps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId; readonly prNumber: number; readonly headSha: GitSha },
): Promise<EvaluateReviewCheckResult> => {
  const { db } = deps;
  const taskRepo = await db.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, taskId: true, projectId: true, repoId: true },
  });
  if (taskRepo === null) {
    return { ok: false, error: "not-found", message: "no such task repo" };
  }
  const pull = await db.taskPullRequest.findFirst({ where: { taskRepoId: taskRepo.id, number: input.prNumber }, select: { id: true } });
  if (pull === null) {
    return { ok: false, error: "not-a-task-pr", message: "the PR isn't one ostra opened for the task" };
  }
  const { codeHost } = deps.adapters;
  if (!codeHost.capabilities.reviews || !codeHost.capabilities.checkRuns) {
    return { ok: true, verdict: { status: "pending", reason: "no-approval" }, outcome: "unsupported" };
  }
  const repoId = repoIdSchema.parse(taskRepo.repoId);
  const access = await repoAccessFor(db, deps.adapters.secretStore, input.organizationId, repoId);
  if (!access.ok) {
    throw new Error(`review.evaluate: ${access.reason}`);
  }
  const listed = await codeHost.listReviews(access.access, input.prNumber);
  if (!listed.ok) {
    throw new Error(`review.evaluate: the code host couldn't list the reviews (${listed.error.code})`);
  }
  if (deps.jobs !== undefined) {
    // Milestone 6 (F-102, ticket 19): each reviewer's latest state, and a reviewer's review clears their own item.
    const jobs = deps.jobs;
    await db.$transaction((tx) => recordReviewerStatesInTx({ jobs, notices: deps.notices }, tx, { organizationId: input.organizationId, taskRepoId: taskRepo.id, reviews: listed.value, now: deps.clock.now() }));
  }
  const reviews = listed.value.flatMap((review) => {
    const lite = liteOf(review);
    return lite === null ? [] : [lite];
  });
  // Each reviewer, by their host account, to the active member it's verified for (F-119).
  const reviewerIds = [...new Set(reviews.map((review) => review.userId))];
  const members =
    reviewerIds.length === 0
      ? []
      : await db.member.findMany({
          where: { organizationId: input.organizationId, state: "active", user: { githubUserId: { in: reviewerIds } } },
          select: { id: true, user: { select: { githubUserId: true, name: true } } },
        });
  const links = new Map<string, MemberId>();
  const names = new Map<MemberId, string>();
  for (const member of members) {
    if (member.user.githubUserId !== null) {
      const memberId = memberIdSchema.parse(member.id);
      links.set(member.user.githubUserId, memberId);
      names.set(memberId, member.user.name);
    }
  }
  // The drivers: every member credited with a trailer on the task (Q121).
  const coAuthors = await db.taskCoAuthor.findMany({ where: { taskId: taskRepo.taskId }, select: { memberId: true } });
  const drivers = new Set(coAuthors.flatMap((row) => (row.memberId === null ? [] : [memberIdSchema.parse(row.memberId)])));
  const verdict = evaluateIndependentReview({ reviews, drivers, links, headSha: input.headSha });

  const status = verdict.status;
  const approverMemberId = verdict.status === "passed" ? verdict.approverMemberId : null;
  const reason = verdict.status === "passed" ? `Approved by ${names.get(verdict.approverMemberId) ?? verdict.approverLogin}` : pendingReasonWords(verdict.reason);
  const existing = await db.reviewCheck.findUnique({ where: { taskRepoId_headSha: { taskRepoId: taskRepo.id, headSha: input.headSha } } });
  const existingRunId = existing?.checkRunId ?? null;
  if (existing !== null && existingRunId !== null && existing.status === status && existing.reason === reason && existing.approverMemberId === approverMemberId) {
    return { ok: true, verdict, outcome: "unchanged" };
  }

  const run: CheckRunInput = {
    ...checkRunStateOf(verdict, deps.waiting),
    name: INDEPENDENT_REVIEW_CHECK_NAME,
    headSha: input.headSha,
    title: verdict.status === "passed" ? reason : REVIEW_CHECK_WAITING_TITLE,
    summary: reason,
    externalId: `${taskRepo.id}:${input.headSha}`,
  };
  let checkRunId: string;
  let outcome: "published" | "updated";
  if (existingRunId === null) {
    const published = await codeHost.publishCheckRun(access.access, run);
    if (!published.ok) {
      throw new Error(`review.evaluate: the code host refused the check run (${published.error.code})`);
    }
    checkRunId = published.value.checkRunId;
    outcome = "published";
  } else {
    const updated = await codeHost.updateCheckRun(access.access, existingRunId, run);
    if (!updated.ok) {
      throw new Error(`review.evaluate: the code host refused the check run's update (${updated.error.code})`);
    }
    checkRunId = existingRunId;
    outcome = "updated";
  }

  const now = deps.clock.now();
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const projectId = projectIdSchema.parse(taskRepo.projectId);
  const taskId = taskIdSchema.parse(taskRepo.taskId);
  await db.$transaction(async (tx) => {
    await tx.reviewCheck.upsert({
      where: { taskRepoId_headSha: { taskRepoId: taskRepo.id, headSha: input.headSha } },
      create: { organizationId, projectId, taskRepoId: taskRepo.id, prNumber: input.prNumber, headSha: input.headSha, checkRunId, status, reason, approverMemberId },
      update: { checkRunId, status, reason, approverMemberId, prNumber: input.prNumber },
    });
    const session = await tx.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId,
        sessionId: sessionIdSchema.parse(session.id),
        at: now,
        event: { kind: "review.check_updated", repoId, prNumber: input.prNumber, headSha: input.headSha, status, approverMemberId, reason },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
  });
  deps.logger?.info("review.check-updated", {
    taskId,
    repoId,
    prNumber: input.prNumber,
    status,
    reason: verdict.status === "passed" ? "approved" : verdict.reason,
    reviews: reviews.length,
  });
  return { ok: true, verdict, outcome };
}) satisfies (deps: ReviewCheckDeps, input: Parameters<EvaluateReviewCheck>[1]) => Promise<EvaluateReviewCheckResult>;

// ---------- what enqueues an evaluation (spec section 4) ----------

/** One `review.evaluate` for a PR's head, after the window that lets reviews a moment apart evaluate once. */
export const enqueueReviewEvaluationInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly prNumber: number; readonly headSha: string; readonly connectionId: string },
): Promise<boolean> => {
  const headSha = gitShaSchema.safeParse(input.headSha);
  if (!headSha.success) {
    return false;
  }
  await jobs.enqueueInTx(
    tx,
    "review.evaluate",
    { organizationId: input.organizationId, taskRepoId: taskRepoIdSchema.parse(input.taskRepoId), prNumber: input.prNumber, headSha: headSha.data },
    { startAfterMs: reviewEvaluateSingletonSeconds * 1000, group: { id: input.connectionId } },
  );
  return true;
};

/** The open PRs of a set of task repos, with what an evaluation is keyed by. */
const openPullRequestsOf = (tx: Tx, where: { readonly organizationId: OrganizationId; readonly taskId?: TaskId; readonly taskRepoId?: string; readonly hostRepo?: { readonly connectionId: string; readonly hostRepoId: string; readonly prNumber: number } }) =>
  tx.taskRepo.findMany({
    where: {
      organizationId: where.organizationId,
      state: "pr_open",
      prNumber: where.hostRepo === undefined ? { not: null } : where.hostRepo.prNumber,
      headSha: { not: null },
      ...(where.taskId === undefined ? {} : { taskId: where.taskId }),
      ...(where.taskRepoId === undefined ? {} : { id: where.taskRepoId }),
      ...(where.hostRepo === undefined ? {} : { repo: { connectionId: where.hostRepo.connectionId, hostRepoId: where.hostRepo.hostRepoId } }),
    },
    take: 500,
    select: { id: true, prNumber: true, headSha: true, repo: { select: { connectionId: true } } },
  });

/**
 * Enqueues an evaluation for each open task PR that matches: a task's (a new trailer), a task
 * repo's, a host PR's (a review, a push), or every one of an organization's (a link or unlink).
 * `headSha` overrides the stored head when the host reported a newer one. Returns how many.
 */
export const enqueueReviewEvaluationsInTx = async (
  jobs: JobQueue,
  tx: Tx,
  where: Parameters<typeof openPullRequestsOf>[1] & { readonly headSha?: string },
): Promise<number> => {
  let count = 0;
  for (const row of await openPullRequestsOf(tx, where)) {
    const headSha = where.headSha ?? row.headSha;
    if (row.prNumber === null || headSha === null) {
      continue;
    }
    if (await enqueueReviewEvaluationInTx(jobs, tx, { organizationId: where.organizationId, taskRepoId: row.id, prNumber: row.prNumber, headSha, connectionId: row.repo.connectionId })) {
      count += 1;
    }
  }
  return count;
};

/** A link or an unlink of a GitHub account: every open task PR of each organization the account is a member of. */
export const enqueueReviewEvaluationsForUserInTx = async (jobs: JobQueue, tx: Tx, userId: string): Promise<number> => {
  const memberships = await tx.member.findMany({ where: { userId }, select: { organizationId: true } });
  let count = 0;
  for (const membership of memberships) {
    count += await enqueueReviewEvaluationsInTx(jobs, tx, { organizationId: organizationIdSchema.parse(membership.organizationId) });
  }
  return count;
};
