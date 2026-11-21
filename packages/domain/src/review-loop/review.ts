import { randomUUID } from "node:crypto";

import type { DiffFileLines, Logger, ReviewLineComment } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import {
  clientMessageIdSchema,
  findingIdSchema,
  gitShaSchema,
  httpUrlSchema,
  leaseEpochSchema,
  organizationIdSchema,
  projectIdSchema,
  repoIdSchema,
  reviewRunIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { Finding, FindingId, MemoryKind, OrganizationId, RepoId, ReviewRequestBody, ReviewRunId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import { proposeRememberThis } from "../memory/notes.ts";
import type { NotesDeps } from "../memory/notes.ts";
import { rememberThis } from "../memory/remember-this.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import { reviewPrompt } from "../prompts/m6.ts";
import type { PullRequestForReview } from "../prompts/m6.ts";
import { checkBudget, holdTurnInTx, sessionModelIdInTx } from "../use-cases/budgets.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { moveSessionInTx, moveTaskInTx } from "../use-cases/moves.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { endSessionTimersInTx } from "../use-cases/sessions-m2.ts";
import type { SessionTimers } from "../use-cases/sessions-m2.ts";
import { openTaskPrsInTx, reviewRoundsInTx } from "./loop.ts";
import { placeFindings, REVIEW_FINDINGS_MAX, reviewBody } from "./place-findings.ts";
import { acceptedCriteriaOfTicketInTx } from "./review-settings.ts";
import { countReviewRerun, DEFAULT_ROUND_LIMITS, reviewRerunAllowed } from "./rounds.ts";
import type { RoundLimits } from "./rounds.ts";
import { reviewRerunCappedInTx, roundCountersInTx } from "./start-round.ts";

// The AI review (F-100, F-111, ADR 0028 amended, ADR 0058, Q223; milestone 6's ticket 17). Each
// code task has one review task (`reviewOfTaskId`), made at its first review and reopened per
// round on every open PR's current head, read-only, on the project's review profile, in its own
// box. Its agent hands in typed findings through `submit_review`; core stores them, then posts one
// comment-type review per PR (`review.post`): each finding on a line of the PR's diff as a line
// comment, the rest in the review's body. Then blocking findings start a findings round (ticket
// 18), none moves the code task to "waiting for a reviewer". A finding's text, the summary and
// the review's body are untrusted: never logged, never in an event.

/** The tools a review task's sidecar serves: the review and the memory tools (ADR 0044). */
export const REVIEW_TASK_TOOLS = ["review", "memory"] as const;

/** A review task's branch name: its code task's, with a suffix, as two tasks never share one. */
export const reviewBranchName = (codeBranch: string): string => `${codeBranch}--review`.slice(0, 240);

/** A review run's heads, as `ReviewRun.heads` keeps them. */
export const reviewHeadSchema = z.object({ repoId: repoIdSchema, prNumber: z.number().int().positive(), baseSha: gitShaSchema, headSha: gitShaSchema });
export const reviewHeadsSchema = z.array(reviewHeadSchema);
export type ReviewHead = z.infer<typeof reviewHeadSchema>;

export type ReviewDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly timers?: SessionTimers;
  readonly logger?: Logger;
  /** `OSTRA_REVIEW_ROUNDS` and the rest, which a review rerun counts toward; the working values without it. */
  readonly limits?: RoundLimits;
};

// ---------- review.start ----------

export type StartReviewResult = UseCaseResult<
  { readonly reviewRunId: ReviewRunId; readonly reviewTaskId: TaskId; readonly created: boolean; readonly held: boolean },
  "not-found" | "ai-review-off" | "already-started" | "not-in-review" | "round-cap"
>;

/** The profile a review runs on: the project's default for reviews, the built-in Review profile, else the code task's. */
const reviewProfileInTx = async (tx: Tx, project: { readonly organizationId: string; readonly defaultReviewProfileId: string | null }, codeProfileId: string | null): Promise<string | null> => {
  if (project.defaultReviewProfileId !== null) {
    const chosen = await tx.agentProfile.findFirst({ where: { id: project.defaultReviewProfileId, organizationId: project.organizationId, archivedAt: null }, select: { id: true } });
    if (chosen !== null) {
      return chosen.id;
    }
  }
  const builtIn = await tx.agentProfile.findFirst({ where: { organizationId: project.organizationId, builtInKind: "review", archivedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return builtIn?.id ?? codeProfileId;
};

/**
 * The acceptance criteria the review reads (F-100): the ticket's refine draft a member applied,
 * newest first, else `null`, and the ticket's own text, which the prompt holds, says them.
 */
const acceptedCriteriaInTx = async (tx: Tx, ticketId: string | null): Promise<string | null> => {
  // The review screen reads the same list (ticket 28): `acceptedCriteriaOfTicketInTx`.
  const criteria = await acceptedCriteriaOfTicketInTx(tx, ticketId);
  return criteria === null ? null : criteria.map((line) => `- ${line}`).join("\n");
};

/**
 * `review.start`: the code task's review round on its open PRs' heads. The bases are read from the
 * code host first (a compare's merge base), then one transaction makes or reopens the review task,
 * its session and the review run, and sends its dispatch through the budget gate as an automatic
 * round: a closed gate holds it, and the release dispatches it.
 */
export const startReview = async (deps: ReviewDeps, input: { readonly organizationId: OrganizationId; readonly codeTaskId: TaskId; readonly round: number }): Promise<StartReviewResult> => {
  const { db } = deps;
  const code = await db.task.findFirst({ where: { id: input.codeTaskId, organizationId: input.organizationId }, select: { id: true, kind: true, projectId: true } });
  if (code?.kind !== "code") {
    return { ok: false, error: "not-found", message: "no such code task" };
  }
  // Each open PR at its head, with the base it's compared to.
  const heads: ReviewHead[] = [];
  const pullRequests: PullRequestForReview[] = [];
  for (const pr of await openTaskPrsInTx(db, code.id)) {
    const repoId = repoIdSchema.parse(pr.repoId);
    const taskRepo = await db.taskRepo.findUniqueOrThrow({ where: { id: pr.taskRepoId }, select: { branchName: true, baseBranch: true, prUrl: true, repo: { select: { fullName: true } } } });
    const access = await repoAccessFor(db, deps.adapters.secretStore, input.organizationId, repoId);
    if (!access.ok) {
      throw new Error(`review.start: ${access.reason}`);
    }
    const compared = await deps.adapters.codeHost.compare(access.access, taskRepo.baseBranch, pr.headSha);
    if (!compared.ok) {
      throw new Error(`review.start: the code host couldn't compare the PR (${compared.error.code})`);
    }
    const baseSha = gitShaSchema.safeParse(compared.value.mergeBase);
    if (!baseSha.success) {
      throw new Error("review.start: the code host gave no merge base for the PR");
    }
    const headSha = gitShaSchema.parse(pr.headSha);
    heads.push({ repoId, prNumber: pr.prNumber, baseSha: baseSha.data, headSha });
    const files = compared.value.files;
    pullRequests.push({
      repo: taskRepo.repo.fullName,
      number: pr.prNumber,
      url: httpUrlSchema.safeParse(taskRepo.prUrl).success ? (taskRepo.prUrl ?? "") : "",
      branch: taskRepo.branchName,
      baseSha: baseSha.data,
      headSha,
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    });
  }
  return db.$transaction((tx) => startReviewInTx(deps, tx, input, heads, pullRequests), { timeout: 20_000 });
};

const startReviewInTx = async (
  deps: ReviewDeps,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly codeTaskId: TaskId; readonly round: number },
  heads: readonly ReviewHead[],
  pullRequests: readonly PullRequestForReview[],
): Promise<StartReviewResult> => {
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${input.codeTaskId} FOR UPDATE`;
  const code = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.codeTaskId } }));
  if (code.state !== "in_review" || code.subState !== "ai_review") {
    return { ok: false, error: "not-in-review", message: "the code task isn't waiting for its AI review" };
  }
  const organizationId = organizationIdSchema.parse(code.organizationId);
  const projectId = projectIdSchema.parse(code.projectId);
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const rounds = await reviewRoundsInTx(tx, projectId, deps.adapters.codeHost.capabilities);
  if (!rounds.aiReview) {
    // Switched off since: the task goes on to its reviewer.
    await moveTaskInTx(moveDeps, code, { type: "ai_review_done", blocking: false, capReached: false });
    return { ok: false, error: "ai-review-off", message: "the project's AI review is off" };
  }
  if ((await tx.reviewRun.findUnique({ where: { codeTaskId_round: { codeTaskId: code.id, round: input.round } }, select: { id: true } })) !== null) {
    return { ok: false, error: "already-started", message: "this review round was started already" };
  }
  if (heads.length === 0) {
    return { ok: false, error: "not-in-review", message: "the code task has no open PR" };
  }
  // ADR 0058 as amended 2026-11-21 (the maintainer's "all yes"): a review run again because the last
  // run never posted (a head moved under it) is one of the task's review rounds. Past their cap, the
  // new head gets no automatic review, and the task needs its driver, as at any round cap.
  const limits = deps.limits ?? DEFAULT_ROUND_LIMITS;
  const previous = await tx.reviewRun.findFirst({ where: { codeTaskId: code.id }, orderBy: { round: "desc" }, select: { state: true } });
  if (previous !== null && previous.state !== "posted") {
    const counters = await roundCountersInTx(tx, code.id);
    if (reviewRerunAllowed(counters, limits).kind === "capped") {
      await reviewRerunCappedInTx(deps, tx, code, limits);
      deps.logger?.info("review.capped", { codeTaskId: code.id, round: input.round, reviewRounds: counters.reviewRounds, limit: limits.reviewRounds });
      return { ok: false, error: "round-cap", message: "the AI review has run its review rounds since a person last acted" };
    }
    await tx.task.update({ where: { id: code.id }, data: { ...countReviewRerun(counters) } });
  }
  const now = deps.clock.now();
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { organizationId: true, defaultReviewProfileId: true } });
  const ticket = code.ticketId === null ? null : await tx.ticket.findUnique({ where: { id: code.ticketId }, select: { key: true, title: true, description: true } });
  // Which review this is since a person last acted: the first, then one per findings round or
  // rerun (each counted above, or by its round), of the most the review rounds' cap lets run.
  const reviewRounds = (await roundCountersInTx(tx, code.id)).reviewRounds;
  const prompt = reviewPrompt({
    ticket: ticket === null ? { key: "", title: code.title, description: code.prompt } : { key: ticket.key, title: ticket.title, description: ticket.description },
    acceptanceCriteria: await acceptedCriteriaInTx(tx, code.ticketId),
    pullRequests,
    round: { number: reviewRounds + 1, of: Math.max(limits.reviewRounds, reviewRounds) + 1 },
  });

  // The one review task: made the first time, reopened every round after.
  let review = await tx.task.findFirst({ where: { reviewOfTaskId: code.id, kind: "review" }, orderBy: { createdAt: "asc" } });
  const created = review === null;
  if (review === null) {
    const profileId = await reviewProfileInTx(tx, project, code.agentProfileId);
    review = await tx.task.create({
      data: {
        organizationId,
        projectId,
        kind: "review",
        source: "prompt",
        title: `Review: ${code.title}`.slice(0, 200),
        prompt,
        branchName: reviewBranchName(code.branchName),
        state: "queued",
        reviewOfTaskId: code.id,
        origin: "pr_review",
        driverMemberId: code.driverMemberId,
        creatorMemberId: code.creatorMemberId,
        agentProfileId: profileId,
        effort: code.effort,
      },
    });
  } else {
    // Reopened: the old session and its grant end, so the round runs in a box of its own again.
    const reviewTask = mapTask(review);
    const sessions = await tx.session.findMany({ where: { taskId: review.id, state: { in: ["starting", "running", "waiting", "idle"] } } });
    for (const old of sessions) {
      await moveSessionInTx(moveDeps, old, { type: "stop" });
      await endSessionTimersInTx(deps, tx, { organizationId, taskId: reviewTask.id, sessionId: sessionIdSchema.parse(old.id) });
    }
    await tx.lease.updateMany({ where: { taskId: review.id, state: "active" }, data: { state: "ended", endedAt: new Date(now), endReason: "superseded" } });
    const reopened = await moveTaskInTx(moveDeps, reviewTask, { type: "reopen" });
    if (!reopened && reviewTask.state !== "queued") {
      // Still running an earlier round (it never handed in): that round is void, and this one starts over.
      await moveTaskInTx(moveDeps, reviewTask, { type: "stop", reason: "requested" });
      await moveTaskInTx(moveDeps, mapTask(await tx.task.findUniqueOrThrow({ where: { id: review.id } })), { type: "reopen" });
    }
    await tx.reviewRun.updateMany({ where: { reviewTaskId: review.id, state: { in: ["running", "submitted"] } }, data: { state: "failed" } });
    await tx.task.update({ where: { id: review.id }, data: { prompt, queuedAt: null } });
  }
  const reviewTaskId = taskIdSchema.parse(review.id);
  // The review task's repos: the code task's PR repos, each at its head.
  for (const head of heads) {
    const codeRepo = await tx.taskRepo.findFirstOrThrow({ where: { taskId: code.id, repoId: head.repoId }, select: { baseBranch: true } });
    await tx.taskRepo.upsert({
      where: { taskId_repoId: { taskId: reviewTaskId, repoId: head.repoId } },
      create: { organizationId, projectId, taskId: reviewTaskId, repoId: head.repoId, branchName: review.branchName, baseBranch: codeRepo.baseBranch, headSha: head.headSha },
      update: { headSha: head.headSha },
    });
  }
  const session = await tx.session.create({
    data: { organizationId, projectId, taskId: reviewTaskId, agentProfileId: review.agentProfileId, origin: "new", state: "starting" },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(session.id);
  const memberId = code.driverMemberId ?? code.creatorMemberId;
  if (memberId !== null) {
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId: reviewTaskId,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: prompt.slice(0, runnerLimits.steerTextMaxChars), delivery: "immediate" },
    });
  }
  const run = await tx.reviewRun.create({
    data: { organizationId, projectId, codeTaskId: code.id, reviewTaskId, round: input.round, heads: heads.map((head) => ({ ...head })), state: "running" },
    select: { id: true },
  });
  const reviewRunId = reviewRunIdSchema.parse(run.id);

  // The dispatch, through the budget gate as an automatic round; the review task's own spend cap
  // holds in its spec. The review task's turns aren't the coding agent's automatic turns (Q224).
  const gate = await checkBudget(tx, {
    organizationId,
    projectId,
    modelId: await sessionModelIdInTx(tx, organizationId, { agentProfileId: review.agentProfileId }),
    origin: "automatic-round",
    now,
  });
  const leaseEpoch = leaseEpochSchema.parse(review.leaseEpoch + 1);
  if (gate.kind === "held") {
    await holdTurnInTx(deps, tx, { organizationId, projectId, taskId: reviewTaskId, sessionId, held: gate, pendingMessageSeq: null, now, queued: true });
  } else {
    await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId: reviewTaskId, sessionId, leaseEpoch });
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: reviewTaskId });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: code.id });
  deps.logger?.info("review.started", { codeTaskId: code.id, reviewTaskId, reviewRunId, round: input.round, repos: heads.length, created, held: gate.kind === "held" });
  return { ok: true, reviewRunId, reviewTaskId, created, held: gate.kind === "held" };
};

// ---------- POST /runner/v1/tasks/:taskId/review ----------

export type SubmitReviewResult = UseCaseResult<{ readonly reviewRunId: ReviewRunId }, "wrong-kind" | "invalid" | "limit-reached" | "not-in-review">;

/**
 * The `submit_review` tool's endpoint (F-100): a review task's findings, in the review task's
 * lock. A review task only, with a run that's running; the findings checked and capped
 * (`OSTRA_REVIEW_FINDINGS_MAX`), each on one of the run's repos; stored as `Finding` rows, with
 * `review.submitted` in both threads, and one `review.post` per repo.
 */
export const submitReview = async (
  deps: Pick<Ports, "jobs" | "notices" | "clock"> & { readonly tx: Tx; readonly findingsMax?: number; readonly logger?: Logger | undefined },
  input: { readonly organizationId: OrganizationId; readonly reviewTaskId: TaskId; readonly review: ReviewRequestBody },
): Promise<SubmitReviewResult> => {
  const { tx } = deps;
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${input.reviewTaskId} FOR UPDATE`;
  const task = await tx.task.findFirst({ where: { id: input.reviewTaskId, organizationId: input.organizationId }, select: { id: true, kind: true, projectId: true, reviewOfTaskId: true } });
  if (task?.kind !== "review" || task.reviewOfTaskId === null) {
    return { ok: false, error: "wrong-kind", message: "Only a review task hands in a review." };
  }
  const run = await tx.reviewRun.findFirst({ where: { reviewTaskId: task.id }, orderBy: { round: "desc" }, select: { id: true, state: true, heads: true, codeTaskId: true } });
  const code = run === null ? null : await tx.task.findUnique({ where: { id: run.codeTaskId }, select: { state: true, subState: true } });
  if (run?.state !== "running" || code?.state !== "in_review" || code.subState !== "ai_review") {
    return { ok: false, error: "not-in-review", message: "This review round is over: nothing waits for a review now." };
  }
  const max = Math.min(deps.findingsMax ?? REVIEW_FINDINGS_MAX, REVIEW_FINDINGS_MAX);
  if (input.review.findings.length > max) {
    return { ok: false, error: "limit-reached", message: `A review has at most ${String(max)} findings: keep the ones that matter most.` };
  }
  const heads = reviewHeadsSchema.safeParse(run.heads);
  const repos = new Set(heads.success ? heads.data.map((head) => head.repoId) : []);
  if (input.review.findings.some((finding) => !repos.has(finding.repoId))) {
    return { ok: false, error: "invalid", message: "Each finding names one of the reviewed repositories." };
  }
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const codeTaskId = taskIdSchema.parse(run.codeTaskId);
  const taskRepos = await tx.taskRepo.findMany({ where: { taskId: codeTaskId, repoId: { in: [...repos] } }, select: { id: true, repoId: true } });
  const repoOf = new Map(taskRepos.map((row) => [row.repoId, row.id]));
  const blocking = input.review.findings.filter((finding) => finding.severity === "blocking").length;
  const nits = input.review.findings.length - blocking;
  await tx.finding.createMany({
    data: input.review.findings.flatMap((finding) => {
      const taskRepoId = repoOf.get(finding.repoId);
      return taskRepoId === undefined
        ? []
        : [{ organizationId, projectId, reviewRunId: run.id, taskRepoId, path: finding.path, line: finding.line, side: finding.side, severity: finding.severity, title: finding.title, body: finding.body, suggestion: finding.suggestion }];
    }),
  });
  await tx.reviewRun.update({ where: { id: run.id }, data: { state: "submitted", summary: input.review.summary, blocking, nits } });
  const reviewRunId = reviewRunIdSchema.parse(run.id);
  const now = deps.clock.now();
  for (const taskId of [task.id, codeTaskId]) {
    const session = await tx.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await appendServerEvent(tx, { organizationId, projectId, taskId: taskIdSchema.parse(taskId), sessionId: sessionIdSchema.parse(session.id), at: now, event: { kind: "review.submitted", reviewRunId, blocking, nits } });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskIdSchema.parse(taskId) });
  }
  for (const repoId of repos) {
    await deps.jobs.enqueueInTx(tx, "review.post", { organizationId, reviewRunId, repoId });
  }
  deps.logger?.info("review.submitted", { reviewTaskId: task.id, reviewRunId, blocking, nits });
  return { ok: true, reviewRunId };
};

// ---------- review.post ----------

export type PostReviewResult = UseCaseResult<
  { readonly url: string; readonly lineComments: number; readonly inBody: number; readonly done: boolean },
  "not-found" | "already-posted" | "head-moved"
>;

const findingOf = (row: { readonly path: string; readonly line: number; readonly side: "new" | "old"; readonly severity: "blocking" | "nit"; readonly title: string; readonly body: string; readonly suggestion: string | null }, repoId: RepoId): Finding => ({
  repoId,
  path: row.path,
  line: row.line,
  side: row.side,
  severity: row.severity,
  title: row.title,
  body: row.body,
  suggestion: row.suggestion,
});

/**
 * `review.post`: one comment-type review for one PR of a review run, at the reviewed head. A 422
 * on one line comment (its line left the diff) moves it into the body and tries once more. When
 * the run's every PR has its review, the run is posted, the review task is done, earlier runs'
 * findings are marked, and the code task moves: blocking findings ask for a findings round,
 * none sends it on to its reviewer.
 */
export const postReview = async (deps: ReviewDeps, input: { readonly organizationId: OrganizationId; readonly reviewRunId: ReviewRunId; readonly repoId: RepoId }): Promise<PostReviewResult> => {
  const { db } = deps;
  const run = await db.reviewRun.findFirst({ where: { id: input.reviewRunId, organizationId: input.organizationId } });
  if (run === null || (run.state !== "submitted" && run.state !== "posted")) {
    return { ok: false, error: "not-found", message: "no submitted review run" };
  }
  const head = reviewHeadsSchema.safeParse(run.heads).data?.find((one) => one.repoId === input.repoId);
  const taskRepo = await db.taskRepo.findFirst({ where: { taskId: run.codeTaskId, repoId: input.repoId }, select: { id: true, headSha: true, prNumber: true } });
  if (head === undefined || taskRepo === null) {
    return { ok: false, error: "not-found", message: "the run has no such repo" };
  }
  const rows = await db.finding.findMany({ where: { reviewRunId: run.id, taskRepoId: taskRepo.id }, orderBy: { createdAt: "asc" } });
  const postedBefore = await db.event.count({
    where: { taskId: run.codeTaskId, kind: "review.posted", AND: [{ payload: { path: ["reviewRunId"], equals: run.id } }, { payload: { path: ["repoId"], equals: input.repoId } }] },
  });
  if (postedBefore > 0 || rows.some((row) => row.postedAs !== null)) {
    return { ok: false, error: "already-posted", message: "this PR's review was posted" };
  }
  if (taskRepo.headSha !== head.headSha) {
    // A person pushed while the review read the old head: the run is void (`failReviewOnHeadMoveInTx`).
    return { ok: false, error: "head-moved", message: "the PR's head moved since the review" };
  }
  const access = await repoAccessFor(db, deps.adapters.secretStore, input.organizationId, input.repoId);
  if (!access.ok) {
    throw new Error(`review.post: ${access.reason}`);
  }
  const { codeHost } = deps.adapters;
  const lines = await codeHost.diffLines(access.access, head.prNumber);
  if (!lines.ok) {
    throw new Error(`review.post: the code host couldn't read the PR's diff (${lines.error.code})`);
  }
  const findings = rows.map((row) => findingOf(row, input.repoId));
  const placed = placeFindings(findings, lines.value);
  let comments: (ReviewLineComment & { readonly findingIndex: number })[] = [...placed.lineComments];
  let inBody = [...placed.inBody];
  const post = () =>
    codeHost.createReview(access.access, head.prNumber, {
      commitId: head.headSha,
      body: reviewBody({ summary: run.summary ?? "", findings, inBody }),
      event: "COMMENT",
      comments: comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })),
    });
  let posted = await post();
  if (!posted.ok && posted.error.code === "line-outside-diff") {
    // GitHub refused one line comment: that finding goes in the body, and the review once more.
    const refusedIndex = posted.error.commentIndex;
    const refused = comments[refusedIndex];
    if (refused !== undefined) {
      comments = comments.filter((_, index) => index !== refusedIndex);
      inBody = [...inBody, refused.findingIndex].sort((a, b) => a - b);
    }
    posted = await post();
  }
  if (!posted.ok) {
    throw new Error(`review.post: the code host refused the review (${posted.error.code})`);
  }
  const url = posted.value.url;
  const onLine = new Set(comments.map((comment) => comment.findingIndex));
  const done = await db.$transaction(async (tx) => {
    for (const [index, row] of rows.entries()) {
      await tx.finding.update({ where: { id: row.id }, data: { postedAs: onLine.has(index) ? "line_comment" : "review_body" } });
    }
    const organizationId = organizationIdSchema.parse(input.organizationId);
    const projectId = projectIdSchema.parse(run.projectId);
    const reviewRunId = reviewRunIdSchema.parse(run.id);
    const prUrl = httpUrlSchema.safeParse(url);
    for (const taskId of [run.codeTaskId, run.reviewTaskId]) {
      if (taskId === null) continue;
      const session = await tx.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session !== null && prUrl.success) {
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId: taskIdSchema.parse(taskId),
          sessionId: sessionIdSchema.parse(session.id),
          at: deps.clock.now(),
          event: { kind: "review.posted", reviewRunId, repoId: input.repoId, prNumber: head.prNumber, url: prUrl.data },
        });
      }
    }
    return finishRunIfPostedInTx(deps, tx, run.id, lines.value, input.repoId);
  });
  deps.logger?.info("review.posted", { reviewRunId: run.id, repoId: input.repoId, prNumber: head.prNumber, lineComments: comments.length, inBody: inBody.length, done });
  return { ok: true, url, lineComments: comments.length, inBody: inBody.length, done };
};

/**
 * When every repo of the run has its review: the run is posted, the review task done, earlier
 * runs' open findings marked (outdated when the new head's diff no longer has their line, else
 * resolved by this run when it didn't find them again), and the code task moves on.
 */
const finishRunIfPostedInTx = async (deps: ReviewDeps, tx: Tx, reviewRunId: string, diff: readonly DiffFileLines[], repoId: RepoId): Promise<boolean> => {
  const run = await tx.reviewRun.findUniqueOrThrow({ where: { id: reviewRunId } });
  const heads = reviewHeadsSchema.safeParse(run.heads).data ?? [];
  const posted = await tx.event.findMany({ where: { taskId: run.codeTaskId, kind: "review.posted", payload: { path: ["reviewRunId"], equals: run.id } }, select: { payload: true } });
  const postedRepos = new Set(posted.flatMap((event) => {
    const parsed = z.looseObject({ repoId: z.string() }).safeParse(event.payload);
    return parsed.success ? [parsed.data.repoId] : [];
  }));
  postedRepos.add(repoId);
  if (!heads.every((head) => postedRepos.has(head.repoId)) || run.state === "posted") {
    return false;
  }
  const now = deps.clock.now();
  await tx.reviewRun.update({ where: { id: run.id }, data: { state: "posted", postedAt: new Date(now) } });
  // Earlier runs' open findings: outdated when their line left the diff, else resolved by this run unless found again.
  const current = await tx.finding.findMany({ where: { reviewRunId: run.id }, select: { taskRepoId: true, path: true, line: true, title: true } });
  const earlier = await tx.finding.findMany({ where: { state: "open", reviewRun: { codeTaskId: run.codeTaskId, round: { lt: run.round } } }, select: { id: true, taskRepoId: true, path: true, line: true, side: true, title: true } });
  const files = new Map(diff.map((file) => [file.path, file]));
  for (const finding of earlier) {
    const again = current.some((one) => one.taskRepoId === finding.taskRepoId && one.path === finding.path && one.line === finding.line && one.title === finding.title);
    if (again) {
      continue;
    }
    const file = files.get(finding.path);
    const ranges = file === undefined ? [] : finding.side === "new" ? file.new : file.old;
    const inDiff = ranges.some((range) => finding.line >= range.start && finding.line <= range.end);
    await tx.finding.update({ where: { id: finding.id }, data: inDiff ? { state: "resolved", resolvedInRunId: run.id } : { state: "outdated", resolvedInRunId: run.id } });
  }
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  if (run.reviewTaskId !== null) {
    const reviewTask = await tx.task.findUniqueOrThrow({ where: { id: run.reviewTaskId } });
    await moveTaskInTx(moveDeps, mapTask(reviewTask), { type: "findings_posted" });
  }
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${run.codeTaskId} FOR UPDATE`;
  const code = mapTask(await tx.task.findUniqueOrThrow({ where: { id: run.codeTaskId } }));
  const organizationId = organizationIdSchema.parse(run.organizationId);
  if (run.blocking > 0) {
    await deps.jobs.enqueueInTx(tx, "round.start", { organizationId, taskId: code.id, kind: "findings", causeRef: run.id });
  } else {
    await moveTaskInTx(moveDeps, code, { type: "ai_review_done", blocking: false, capReached: false });
  }
  return true;
};

// ---------- a head that moves during the review ----------

/**
 * A PR's head moved (a person pushed) while the code task's AI review read the old one: the
 * running or submitted run is void (`failed`), and the code task goes back to "CI running" on the
 * new head, whose `ci.evaluate` the caller sends. In the task's lock, in the caller's transaction.
 */
export const failReviewOnHeadMoveInTx = async (
  deps: Pick<ReviewDeps, "jobs" | "notices" | "adapters" | "logger">,
  tx: Tx,
  input: { readonly taskId: TaskId; readonly repoId: RepoId; readonly headSha: string },
): Promise<boolean> => {
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${input.taskId} FOR UPDATE`;
  const code = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  if (code.kind !== "code" || code.state !== "in_review" || code.subState !== "ai_review") {
    return false;
  }
  const runs = await tx.reviewRun.findMany({ where: { codeTaskId: code.id, state: { in: ["running", "submitted"] } }, select: { id: true, heads: true } });
  const moved = runs.filter((run) => (reviewHeadsSchema.safeParse(run.heads).data ?? []).some((head) => head.repoId === input.repoId && head.headSha !== input.headSha));
  if (moved.length === 0) {
    return false;
  }
  await tx.reviewRun.updateMany({ where: { id: { in: moved.map((run) => run.id) } }, data: { state: "failed" } });
  const rounds = await reviewRoundsInTx(tx, code.projectId, deps.adapters.codeHost.capabilities);
  await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) }, code, { type: "head_moved", rounds });
  deps.logger?.info("review.head-moved", { taskId: code.id, repoId: input.repoId, failedRuns: moved.length });
  return true;
};

// ---------- "Remember this" on a finding (F-111) ----------

export type RememberFindingResult = UseCaseResult<{ readonly proposalId: string }, "forbidden" | "not-found" | "secret-found" | "invalid-input">;

/** "Remember this" on a finding: milestone 4's proposal path, with the finding as its source (`ai_finding`). */
export const rememberFinding = async (
  deps: NotesDeps,
  scope: MemberScope,
  input: { readonly findingId: FindingId; readonly kind?: MemoryKind; readonly title?: string; readonly body?: string },
): Promise<RememberFindingResult> => {
  const finding = await deps.db.finding.findFirst({
    where: { id: input.findingId, organizationId: scope.organizationId },
    select: { id: true, projectId: true, title: true, body: true, reviewRun: { select: { codeTaskId: true } } },
  });
  if (finding === null) {
    return { ok: false, error: "not-found", message: "No such finding" };
  }
  const taskId = taskIdSchema.parse(finding.reviewRun.codeTaskId);
  const draft = rememberThis({
    source: { kind: "ai_finding", findingId: findingIdSchema.parse(finding.id), body: `${finding.title}\n\n${finding.body}` },
    projectId: projectIdSchema.parse(finding.projectId),
    taskId,
    memberId: scope.memberId,
  });
  if ("error" in draft) {
    return { ok: false, error: "invalid-input", message: "The finding has no text to remember" };
  }
  const result = await proposeRememberThis(deps, scope, {
    taskId,
    source: { kind: "ai_finding", findingId: findingIdSchema.parse(finding.id), body: finding.body },
    title: input.title ?? draft.title,
    body: input.body ?? draft.body,
    kind: input.kind ?? draft.kind,
  });
  if (!result.ok) {
    return result.error === "secret-found" ? { ok: false, error: "secret-found", message: result.message } : { ok: false, error: result.error, message: result.message };
  }
  return { ok: true, proposalId: result.proposalId };
};
