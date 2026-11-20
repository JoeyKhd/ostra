import type { Logger, PullRequestReview } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { clientMessageIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, repoIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId, TaskRepoId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope, ProjectRole } from "../access.ts";
import type { Ports, ServerAdapters } from "../ports.ts";
import { changesRequestedPrompt } from "../prompts/m6.ts";
import type { ReviewCommentForPrompt } from "../prompts/m6.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { sendMemberMessageInTx } from "../use-cases/member-message.ts";
import type { SendMemberMessageDeps } from "../use-cases/member-message.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";

// "Changes requested" reopens the task (F-105, ADR 0040 amended, ADR 0041, ADR 0058; milestone 6's
// ticket 20). A `submitted` review with `changes_requested` on a task's PR, from a GitHub user
// linked to an active member who can open the project, enqueues `changes.reopen` keyed by the
// review. The job reads the review (its body) and its line comments on the host, and sends them as
// one member message from the reviewer, intent `changes-requested`, wrapped as data: through
// milestone 4's gate with the origin `changes-requested` and the task's spend cap, after the turn
// that's running, as an `@ostra` comment is. It's a person's action: no round cap applies, and the
// automatic counters reset. The reviewer stays a reviewer: no co-author trailer is written for
// them (so their approval still counts for the independent-review check) and the task keeps its
// driver. A review from anyone else, a bot (ostra's own App's included) or an unlinked user is
// ignored with no reply. The review's text never reaches a log line.

/** Why a review doesn't reopen the task, in words for the delivery's record. Never its text. */
export type ChangesRequestedSkip = "not-changes-requested" | "a-bot" | "unlinked" | "not-a-member" | "no-access" | "not-a-task-pr";

/** The linked member a GitHub user is: their scope in the organization, when they're an active member. */
const linkedMemberInTx = async (
  tx: Pick<Tx, "user" | "member" | "projectMember">,
  organizationId: OrganizationId,
  githubUserId: string,
): Promise<{ readonly scope: MemberScope; readonly name: string } | "unlinked" | "not-a-member"> => {
  const user = await tx.user.findFirst({ where: { githubUserId }, select: { id: true, name: true } });
  if (user === null) {
    return "unlinked";
  }
  const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId, userId: user.id } }, select: { id: true, role: true, state: true } });
  if (member?.state !== "active") {
    return "not-a-member";
  }
  const memberId = memberIdSchema.parse(member.id);
  const listed = await tx.projectMember.findMany({ where: { organizationId, memberId }, select: { projectId: true, role: true } });
  const projectRoles = new Map<ProjectId, ProjectRole>(listed.map((row) => [projectIdSchema.parse(row.projectId), row.role] as const));
  return { scope: { organizationId, memberId, role: member.role === "admin" ? "admin" : "member", projectRoles }, name: user.name };
};

/**
 * Whether a review may reopen its task: `changes_requested`, by a person (never a bot or an App),
 * whose verified link (F-119) is an active member who can open the task's project.
 */
export const reviewerMayReopenInTx = async (
  tx: Pick<Tx, "user" | "member" | "projectMember" | "project">,
  input: { readonly organizationId: OrganizationId; readonly projectId: string; readonly review: Pick<PullRequestReview, "state" | "isBot" | "userId"> },
): Promise<{ readonly ok: true; readonly scope: MemberScope; readonly name: string } | { readonly ok: false; readonly skip: ChangesRequestedSkip }> => {
  if (input.review.state !== "changes_requested") {
    return { ok: false, skip: "not-changes-requested" };
  }
  if (input.review.isBot) {
    return { ok: false, skip: "a-bot" };
  }
  const linked = await linkedMemberInTx(tx, input.organizationId, input.review.userId);
  if (linked === "unlinked" || linked === "not-a-member") {
    return { ok: false, skip: linked };
  }
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId: input.organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(linked.scope, { id: projectIdSchema.parse(project.id), organizationId: input.organizationId, access: project.access }, "read").ok) {
    return { ok: false, skip: "no-access" };
  }
  return { ok: true, scope: linked.scope, name: linked.name };
};

/** The task PR a review is on: the open task repo of a code task with that PR on the host's repo. */
export const taskRepoOfPrInTx = async (
  tx: Pick<Tx, "taskRepo">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: string; readonly hostRepoId: string; readonly prNumber: number },
): Promise<{ readonly id: TaskRepoId; readonly projectId: string } | null> => {
  const row = await tx.taskRepo.findFirst({
    where: { organizationId: input.organizationId, state: "pr_open", prNumber: input.prNumber, repo: { connectionId: input.connectionId, hostRepoId: input.hostRepoId }, task: { kind: "code" } },
    select: { id: true, projectId: true },
  });
  return row === null ? null : { id: taskRepoIdSchema.parse(row.id), projectId: row.projectId };
};

export type ChangesRequestedDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> &
  Pick<SendMemberMessageDeps, "spendCap" | "timers"> & {
    readonly db: Db;
    readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
    readonly logger?: Logger;
  };

export type ReopenOnChangesRequestedResult = UseCaseResult<
  {
    readonly taskId: TaskId;
    /** `false` for a replay: the review reopened the task once already. */
    readonly reopened: boolean;
    /** `steer`: the running turn finishes first; `reopen`: a new turn. */
    readonly delivery: "steer" | "reopen" | null;
    /** The budget gate held the turn: the message is saved and waits for the release. */
    readonly held: boolean;
  },
  /** `busy`: the task is between sessions (queued for its next turn): the job tries again once that one runs. */
  "not-found" | "not-a-member" | "ignored" | "spend-cap-reached" | "busy"
>;

/** The one member message of a review: its body and each line comment with its file and line, as data. */
const promptOf = (review: PullRequestReview, comments: readonly ReviewCommentForPrompt[]): string =>
  changesRequestedPrompt({ reviewBody: review.body ?? "", comments });

/**
 * `changes.reopen`: reads the review and its comments on the host, checks the reviewer again, and
 * sends the message. A code host failure throws, so the job retries; a host without `reviews` reads
 * nothing (an optional capability, ADR 0025). Idempotent by the review: a replay sends nothing twice.
 */
export const reopenOnChangesRequested = async (
  deps: ChangesRequestedDeps,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId; readonly reviewId: string },
): Promise<ReopenOnChangesRequestedResult> => {
  const { db } = deps;
  const { codeHost } = deps.adapters;
  const taskRepo = await db.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, taskId: true, projectId: true, repoId: true, prNumber: true, prUrl: true, task: { select: { kind: true } } },
  });
  if (taskRepo?.prNumber === null || taskRepo?.prNumber === undefined || taskRepo.task.kind !== "code") {
    return { ok: false, error: "not-found", message: "no task PR" };
  }
  if (!codeHost.capabilities.reviews) {
    return { ok: false, error: "ignored", message: "the code host doesn't list reviews" };
  }
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const taskId = taskIdSchema.parse(taskRepo.taskId);
  const projectId = projectIdSchema.parse(taskRepo.projectId);
  const prNumber = taskRepo.prNumber;
  const access = await repoAccessFor(db, deps.adapters.secretStore, organizationId, repoIdSchema.parse(taskRepo.repoId));
  if (!access.ok) {
    throw new Error(`changes.reopen: ${access.reason}`);
  }
  const listed = await codeHost.listReviews(access.access, prNumber);
  if (!listed.ok) {
    throw new Error(`changes.reopen: the code host couldn't list the reviews (${listed.error.code})`);
  }
  const review = listed.value.find((one) => one.reviewId === input.reviewId);
  if (review === undefined) {
    return { ok: false, error: "ignored", message: "no such review on the PR" };
  }
  const reviewer = await reviewerMayReopenInTx(db, { organizationId, projectId: taskRepo.projectId, review });
  if (!reviewer.ok) {
    return { ok: false, error: reviewer.skip === "unlinked" || reviewer.skip === "not-a-member" || reviewer.skip === "no-access" ? "not-a-member" : "ignored", message: reviewer.skip };
  }
  let comments: readonly ReviewCommentForPrompt[] = [];
  if (codeHost.capabilities.reviewComments) {
    const read = await codeHost.listReviewComments(access.access, prNumber, input.reviewId);
    if (!read.ok) {
      throw new Error(`changes.reopen: the code host couldn't list the review's comments (${read.error.code})`);
    }
    comments = read.value.map((comment) => ({ path: comment.path, line: comment.line, body: comment.body }));
  }
  const clientMessageId = clientMessageIdSchema.parse(`changes-requested:${input.reviewId}`);
  // A refused send, set before its transaction throws, so the transaction keeps nothing of it.
  let refused: Extract<ReopenOnChangesRequestedResult, { readonly ok: false }> | null = null;
  const result = await db
    .$transaction(
    async (tx): Promise<ReopenOnChangesRequestedResult> => {
      const sent = await sendMemberMessageInTx(deps, tx, reviewer.scope, {
        taskId,
        clientMessageId,
        text: promptOf(review, comments),
        intent: "changes-requested",
        sender: "anyone",
        // The reviewer asked for changes; the task's driver stays its driver (ADR 0040, amended).
        keepDriver: true,
      });
      if (!sent.ok) {
        // Refused: nothing of the send is kept (its counter reset included), so the transaction rolls back.
        refused =
          sent.error === "spend-cap-reached" || sent.error === "not-found"
            ? { ok: false, error: sent.error, message: sent.message }
            : { ok: false, error: sent.error === "not-reopenable" ? "busy" : "ignored", message: sent.message };
        throw new Error("changes.reopen: the send was refused");
      }
      if (sent.duplicate) {
        return { ok: true, taskId, reopened: false, delivery: null, held: false };
      }
      const held = sent.held === true;
      // The round, by the review: a person's, so it's never capped and never automatic.
      const number = (await tx.taskRound.count({ where: { taskId, kind: "changes_requested" } })) + 1;
      await tx.taskRound.create({
        data: { organizationId, projectId, taskId, kind: "changes_requested", number, automatic: false, causeRef: input.reviewId, state: held ? "held" : "started" },
      });
      const now = deps.clock.now();
      await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId: sent.sessionId, at: now, event: { kind: "round.started", round: "changes-requested", number, automatic: false } });
      // "Changes requested by <member> on GitHub", with a link to the review: the review's own URL, else the PR's.
      const url = review.url ?? taskRepo.prUrl;
      if (url !== null) {
        await appendServerEvent(tx, { organizationId, projectId, taskId, sessionId: sent.sessionId, at: now, event: { kind: "pr.comment_received", url, login: review.login.slice(0, 100), path: null, line: null } });
      }
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: reviewer.scope.memberId },
        action: "pr.changes-requested",
        entity: "task",
        entityId: taskId,
        data: { repoId: taskRepo.repoId, prNumber, reviewId: input.reviewId, comments: comments.length, delivery: sent.delivery, held },
      });
      return { ok: true, taskId, reopened: true, delivery: sent.delivery, held };
    },
    { timeout: 20_000 },
    )
    .catch((error: unknown) => {
      if (refused !== null) return refused;
      throw error;
    });
  deps.logger?.info("changes.reopen", { taskId, prNumber, reviewId: input.reviewId, comments: comments.length, ...(result.ok ? { reopened: result.reopened, delivery: result.delivery, held: result.held } : { error: result.error }) });
  return result;
};
