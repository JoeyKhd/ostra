import { randomUUID } from "node:crypto";

import {
  agentSteersMidTurn,
  answerNextTurnItemsInTx,
  answerApproval,
  askAgentToFixChecks,
  keepWorking,
  requestUpdateBranchWith,
  appendServerEvent,
  checkBudget,
  checkProjectRepos,
  creditCoAuthorInTx,
  holdTurnInTx,
  taskCoAuthorsInTx,
  sessionModelIdInTx,
  turnOriginOfIntent,
  createPromptTask,
  createPromptTaskInputSchema,
  createTicketForTask,
  createTicketForTaskInputSchema,
  dismissNeedsYou,
  dismissNeedsYouInputSchema,
  followUpOf,
  reopenTask,
  restartOnProviderChangeInTx,
  sessionProviderGateInTx,
  reopenTaskInputSchema,
  retryTicketWrites,
  retryTicketWritesInputSchema,
  startTicketTask,
  startTicketTaskInputSchema,
  waitingFor,
  setTaskEffort,
  stopTask,
  taskFromColumns,
  taskToColumns,
  transitionTask,
  cancelQueuedTask,
  appendMemberMessageInTx,
  filesToBindInTx,
  modelImageInput,
  runnerTakesFilesInTx,
  RUNNER_NEEDS_UPGRADE_FOR_FILES,
  steerFileFields,
  uploadsOfInTx,
} from "@ostra/domain";
import type { TaskLifecycle, Waiting } from "@ostra/domain";
import { effortLevelFromDb, mapEventToStored, mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import {
  approvalDecisionSchema,
  approvalIdSchema,
  approvalOptionSchema,
  clientMessageIdSchema,
  effortChangeIdSchema,
  effortLevelSchema,
  eventLogFoldedKinds,
  memberIdSchema,
  messageFileIdSchema,
  modelIdSchema,
  needsYouItemIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { EffortLevel, OrganizationId, StoredEvent, TaskId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { startCheckProcedure } from "./task-start-check.ts";
import { runnerChoicesProcedure } from "./task-runner-choices.ts";
import { taskMemoryProcedure } from "./memory.ts";
import { taskRoundsProcedure } from "./review.ts";
import { approveProcedure, needsApprovalProcedure, rejectProcedure } from "./task-approval.ts";
import { attachmentToDraftProcedure, keepPreviewProcedure, taskAttachmentsProcedure } from "./task-attachments.ts";
import { retryTicketFilesProcedure, taskFilesProcedure, ticketContextProcedure, ticketUpdatesProcedure } from "./task-files.ts";
import { GOING_SESSION_STATES, waitsForReopen } from "./task-reopen-state.ts";
import { z } from "zod";

import { loadAgentProfileView } from "./agent-profile-view.ts";
import { ciOfHead } from "./ci-jobs.ts";
import { loadDoingByTask } from "./task-doing.ts";
import { loadChecksView } from "./task-checks.ts";
import { loadLocalView } from "./task-local.ts";
import { loadApprovalsAndPlan, previewApproval } from "./task-m3.ts";
import { loadUsageView } from "./task-usage.ts";
import { levelRefusal, loadModelEffort, toLevelViews } from "../services/agent-effort.ts";
import { agentTakesQuestionFreeText } from "../services/agent-questions.ts";
import type { ApiDeps } from "../trpc/context.ts";
import { loadTaskExtras, prStateOf } from "./task-extras.ts";
import { loadFollowUp, shortKeyOf } from "./task-follow-up.ts";
import { queuePlacesOf } from "./fleet-view.ts";
import { loadProjectAccess, memberProcedure, projectProcedure, router, taskProcedure, unwrap } from "../trpc/init.ts";

// F-097, F-023, F-025, F-014 (picking the runner), ticket 33: tasks. A task is visible to every
// member who can open its project and to nobody else (ADR 0026). Reading, stopping and answering an
// approval are for any such member; sending, interrupting and taking over follow the one-driver rule
// (ADR 0036): the server enforces it, under the task's lock, and the UI only hides the controls.

const taskInput = z.strictObject({ taskId: taskIdSchema });

/**
 * A member's message, sent or as a reopen, is their own words (the maintainer, 2026-11-21): ostra's
 * server code alone sets another intent, for the panel's actions and the rounds
 * (`sendMemberMessageInTx`), so the thread draws each from what ostra sent and never hides a
 * member's words behind one. `message`, the plain intent, is taken and changes nothing.
 */
const memberIntentSchema = z.literal("message", { error: "A member's message is plain words: only ostra sets another intent" }).optional();

// ---------- the list ----------

/** The groups of the task list, in the order of `domain-model.md`: needs you, running, queued, in review. */
export const taskGroups = ["needs-you", "running", "queued", "in-review", "finished"] as const;
export type TaskGroup = (typeof taskGroups)[number];

const stateGroups = {
  awaiting_approval: "needs-you",
  needs_you: "needs-you",
  preparing: "running",
  running: "running",
  queued: "queued",
  in_review: "in-review",
  stopped: "finished",
  merged: "finished",
  done: "finished",
} as const satisfies Record<string, TaskGroup>;

type TaskState = keyof typeof stateGroups;

const groupOf = (state: TaskState): TaskGroup => stateGroups[state];

export type { Doing, DoingKind } from "./task-doing.ts";

// ---------- locking ----------

/** Locks a task's row for this transaction (the counter lock of ADR 0035) and reads it. `null`: no such task here. */
const lockTask = async (tx: Tx, taskId: TaskId, organizationId: OrganizationId) => {
  const locked: unknown = await tx.$queryRaw`
    SELECT "id" FROM "task" WHERE "id" = ${taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (!Array.isArray(locked) || locked.length === 0) {
    return null;
  }
  return tx.task.findUniqueOrThrow({ where: { id: taskId } });
};

const lifecycleOf = (task: Parameters<typeof taskFromColumns>[0]): TaskLifecycle => {
  const decoded = taskFromColumns(task);
  if (!decoded.ok) {
    throw new Error(`a task row breaks its lifecycle: ${decoded.reason}`);
  }
  return decoded.value;
};

const notFoundTask = () => new TRPCError({ code: "NOT_FOUND", message: "No such task" });

/** The reasons a one-click reopen needs no message for (the carry-on text is written for the member). */
const CARRY_ON_REASONS = ["stalled", "spend_cap", "crashed"] as const;
const finishedTaskStates = ["stopped", "merged", "done"] as const;

const isOneOf = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

type ReviewCheckRow = { readonly headSha: string; readonly status: "pending" | "passed"; readonly reason: string | null; readonly approverMemberId: string | null; readonly updatedAt: Date };

const reviewCheckHeadOf = (check: ReviewCheckRow, reviewers: ReadonlyMap<string, string>) => ({
  headSha: check.headSha,
  /** `waiting` until someone who didn't drive the task approves this head; then `passed`. */
  state: check.status === "passed" ? ("passed" as const) : ("waiting" as const),
  /** Words for the thread, never a review's text. */
  reason: check.reason,
  approver: check.approverMemberId === null ? null : { memberId: memberIdSchema.parse(check.approverMemberId), name: reviewers.get(check.approverMemberId) ?? "A former member" },
  updatedAt: check.updatedAt.getTime(),
});

/** A PR's review check: its newest head's, with every head's (newest first). `null` before ostra checked it. */
const reviewCheckOf = (checks: readonly ReviewCheckRow[], reviewers: ReadonlyMap<string, string>) => {
  const [newest] = checks;
  return newest === undefined ? null : { ...reviewCheckHeadOf(newest, reviewers), heads: checks.map((check) => reviewCheckHeadOf(check, reviewers)) };
};

/** How many events a page of the event log holds by default, and at most (ticket 25). */
const EVENT_LOG_PAGE = 200;
const EVENT_LOG_MAX_PAGE = 1000;

export const tasksRouter = router({
  /** F-037, F-135 (tickets 27, 50): whether a new task would start now, or the reason it would wait. */
  startCheck: startCheckProcedure,
  /** Milestone 5 (F-069, F-014): New task's runner picker. */
  runnerChoices: runnerChoicesProcedure,

  /** F-110, F-111 (ticket 29): the notes each session used and how, and the proposals the task made. */
  memory: taskMemoryProcedure,

  /** F-035, F-101, F-105 (milestone 6's ticket 28): the task's CI, findings and changes-requested rounds. */
  rounds: taskRoundsProcedure,
  /** F-040, F-012 (milestone 6's ticket 26): the tasks waiting for a member's approval, and the answers. */
  needsApproval: needsApprovalProcedure,
  approve: approveProcedure,
  reject: rejectProcedure,

  /** Milestone 8 (F-121, F-140, ticket 16): the thread's screenshots and recordings, and whether the runner runs the app. */
  attachments: taskAttachmentsProcedure,

  /** Milestone 9 (F-148, F-150, ticket 14): every file sent with the task's messages, and people's files counted. */
  files: taskFilesProcedure,
  /** Milestone 9 (F-149/c3, c5, ticket 14): each read of the ticket: "What the agent got", Retry's state. */
  ticketContext: ticketContextProcedure,
  /** Milestone 9 (F-149/c8): "Send ticket updates", the driver's; the answer is the next round. */
  ticketUpdates: ticketUpdatesProcedure,
  /** Milestone 9 (F-149/c3): "Retry" of the ticket's failed files, the driver's; the answer is the next round. */
  retryTicketFiles: retryTicketFilesProcedure,
  /** "Add to draft": a screenshot among a refine draft's images. */
  attachmentToDraft: attachmentToDraftProcedure,
  /** "Keep it": a port the agent announced becomes an environment proposal for a project admin. */
  keepPreview: keepPreviewProcedure,

  /**
   * Cancels a queued task (F-067, Q248): an organization admin any, the task's member their own. It
   * stops as `cancelled`, can be reopened like any stopped task, and the audit log has
   * `task.cancelled`.
   */
  cancelQueued: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const cancelled = unwrap(await cancelQueuedTask({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { taskId: input.taskId }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-queued": "CONFLICT",
    });
    return { taskId: input.taskId, state: cancelled.state };
  }),

  /**
   * Starts a code task from a prompt (F-097): no ticket is created. Milestone 9 (F-148, ticket 14):
   * with the member's uploads (`fileIds`), bound to the first message within the limits; a few
   * words are still required with them (the maintainer, the approved designs' choices, 4.2).
   */
  create: projectProcedure("read", createPromptTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports, messageFiles } = ctx.deps;
    // F-055: the repos' branch rules are read again as a task starts, so the use case refuses on a
    // current answer. A host that can't say never refuses.
    await checkProjectRepos(
      { db, clock: ports.clock, adapters: ports.adapters },
      { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: true },
    );
    const result = await db.$transaction((tx) => createPromptTask({ tx, scope: ctx.scope, ...ports, files: messageFiles }, input));
    const created = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      "runner-not-yours": "FORBIDDEN",
      "provider-not-allowed-on-personal-runners": "PRECONDITION_FAILED",
      "no-provider-for-model": "PRECONDITION_FAILED",
      "no-agent-profile": "PRECONDITION_FAILED",
      "no-repo": "PRECONDITION_FAILED",
      "repo-unsupported": "PRECONDITION_FAILED",
      "prompt-required": "BAD_REQUEST",
      "file-not-found": "BAD_REQUEST",
    });
    return { taskId: created.taskId, sessionId: created.sessionId, branchName: created.branchName };
  }),

  /**
   * Starts a code task from a ticket of the project's Inbox (F-010): the project's default agent
   * profile, the ticket's ID and key, the branch with the key in it. A second active task for the
   * ticket is refused, and the message names the existing task. The ticket's "started" writes and
   * the job that reads its full context are sent in the same transaction.
   */
  startFromTicket: projectProcedure("read", startTicketTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    // F-055: the repos' branch rules are read again as a task starts; a host that can't say never refuses.
    await checkProjectRepos({ db, clock: ports.clock, adapters: ports.adapters }, { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: true });
    const result = await db.$transaction((tx) => startTicketTask({ tx, scope: ctx.scope, publicUrl: settings.publicUrl, ...ports }, input));
    const created = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      "runner-not-yours": "FORBIDDEN",
      "provider-not-allowed-on-personal-runners": "PRECONDITION_FAILED",
      "no-provider-for-model": "PRECONDITION_FAILED",
      "no-agent-profile": "PRECONDITION_FAILED",
      "no-repo": "PRECONDITION_FAILED",
      "repo-unsupported": "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      // Milestone 6 (F-077): the panel offers "Start sub-issues" for a parent (ticket 25).
      "has-sub-issues": "PRECONDITION_FAILED",
    });
    return { taskId: created.taskId, sessionId: created.sessionId, branchName: created.branchName };
  }),

  /**
   * "Create ticket" (F-097): for a prompt task with no ticket, on one of the project's boards. It
   * writes the `create` ticket write; when ticket sync has made the ticket, the task holds it and
   * the ticket holds the task's link. Asking again while one is made or exists is refused.
   */
  createTicket: taskProcedure("read", createTicketForTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) => createTicketForTask({ tx, scope: ctx.scope, ...ports }, input));
    const made = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      "already-has-ticket": "CONFLICT",
      "not-a-prompt-task": "PRECONDITION_FAILED",
    });
    return { ticketWriteId: made.ticketWriteId };
  }),

  /** A project's tasks, grouped by state in the order of the domain model, with what the agent is doing now. */
  list: projectProcedure("read", z.strictObject({ projectId: projectIdSchema })).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const rows = await db.task.findMany({
      where: { organizationId, projectId: input.projectId },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { repos: { select: { repoId: true, state: true, prNumber: true, prUrl: true } } },
    });
    const ids = rows.map((row) => row.id);
    const live = rows.filter((row) => row.state === "running" || row.state === "preparing" || row.state === "needs_you").map((row) => row.id);
    const doing = await loadDoingByTask(db, live);

    const [leases, pinned, members] = await Promise.all([
      db.lease.findMany({
        where: { organizationId, taskId: { in: ids }, state: "active" },
        select: { taskId: true, runnerId: true, acceptedAt: true, grantedAt: true },
      }),
      db.runner.findMany({ where: { organizationId, id: { in: rows.flatMap((row) => (row.runnerId === null ? [] : [row.runnerId])) } }, select: { id: true } }),
      db.member.findMany({
        where: { organizationId, id: { in: rows.flatMap((row) => (row.driverMemberId === null ? [] : [row.driverMemberId])) } },
        select: { id: true, user: { select: { name: true } } },
      }),
    ]);
    const runnerIds = new Set([...leases.map((lease) => lease.runnerId), ...pinned.map((runner) => runner.id)]);
    const runners = await db.runner.findMany({
      where: { organizationId, id: { in: [...runnerIds] } },
      select: { id: true, name: true, kind: true, executor: true },
    });
    const runnerById = new Map(runners.map((runner) => [runner.id, runner] as const));
    const leaseRunner = new Map(leases.map((lease) => [lease.taskId, lease.runnerId] as const));
    const leaseOf = new Map(leases.map((lease) => [lease.taskId, lease] as const));
    const driverName = new Map(members.map((member) => [member.id, member.user.name] as const));

    const places = await queuePlacesOf(db, organizationId, rows);
    const summaries = rows.map((row) => {
      const runner = runnerById.get(leaseRunner.get(row.id) ?? row.runnerId ?? "");
      const id = taskIdSchema.parse(row.id);
      return {
        id,
        key: row.ticketKey ?? shortKeyOf(row.id),
        title: row.title,
        kind: row.kind,
        /** 2026-11-21 (F-147): the code task a follow-up (its AI review) belongs to, which a live list nests it under. */
        reviewOf: followUpOf(row),
        state: row.state,
        subState: row.subState,
        /** Why it needs a person, or why it stopped. */
        reason: row.needsYouReason ?? row.stoppedReason,
        needsYouReason: row.needsYouReason,
        stoppedReason: row.stoppedReason,
        group: groupOf(row.state),
        waiting: ((): Waiting => {
          const lease = leaseOf.get(row.id);
          return waitingFor(row, lease === undefined ? null : { ...lease, runner: runnerById.get(lease.runnerId) });
        })(),
        /** Milestone 5 (F-067): its place in its pool's queue now, or `null`. */
        queue: places.get(row.id) ?? null,
        doing: doing.get(id) ?? null,
        runner: runner === undefined ? null : { id: runnerIdSchema.parse(runner.id), name: runner.name, kind: runner.kind, executor: runner.executor, isolated: runner.executor !== "host" },
        driver: row.driverMemberId === null ? null : { memberId: memberIdSchema.parse(row.driverMemberId), name: driverName.get(row.driverMemberId) ?? "" },
        prs: row.repos.flatMap((repo) => (repo.prUrl === null || repo.prNumber === null ? [] : [{ repoId: repo.repoId, number: repo.prNumber, url: repo.prUrl, state: repo.state }])),
        /** Epoch ms: the panel shows the age. */
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      };
    });
    return taskGroups.map((group) => ({ group, tasks: summaries.filter((summary) => summary.group === group) }));
  }),

  /** One task, with the capabilities of the caller: what they may do to it (ADR 0036). */
  get: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const task = await db.task.findFirst({
      where: { id: input.taskId, organizationId },
      include: {
        repos: {
          include: {
            repo: { select: { fullName: true, checkoutDir: true } },
            pullRequests: { orderBy: { openedAt: "asc" } },
            // Milestone 4 (F-104, ticket 30): the review check of each PR, per head, newest first.
            reviewChecks: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
            // Ticket 41: the code host's CI per head, for the Code group's CI row.
            ciRuns: { orderBy: { firstSeenAt: "desc" }, take: 5, select: { headSha: true, state: true, checks: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        sessions: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1, include: { provider: { select: { name: true } } } },
        needsYouItems: { where: { state: "open" }, orderBy: { createdAt: "asc" } },
      },
    });
    if (task === null) {
      throw notFoundTask();
    }
    const session = task.sessions[0];
    // The agent and model of the newest session, or the project's default code profile before there's one.
    const profileId =
      session?.agentProfileId ??
      (await db.project.findFirst({ where: { id: task.projectId, organizationId }, select: { defaultCodeProfileId: true } }))?.defaultCodeProfileId ??
      null;
    // F-104: the members who passed a review check, by name.
    const approverIds = [...new Set(task.repos.flatMap((repo) => repo.reviewChecks.flatMap((check) => (check.approverMemberId === null ? [] : [check.approverMemberId]))))];
    const reviewers = new Map(
      (approverIds.length === 0 ? [] : await db.member.findMany({ where: { organizationId, id: { in: approverIds } }, select: { id: true, user: { select: { name: true } } } })).map(
        (member) => [member.id, member.user.name] as const,
      ),
    );
    const [driver, creator, lease, agent] = await Promise.all([
      task.driverMemberId === null ? null : db.member.findFirst({ where: { id: task.driverMemberId, organizationId }, select: { id: true, user: { select: { name: true } } } }),
      task.creatorMemberId === null ? null : db.member.findFirst({ where: { id: task.creatorMemberId, organizationId }, select: { id: true, user: { select: { name: true } } } }),
      db.lease.findFirst({ where: { taskId: task.id, state: "active" }, include: { runner: { select: { id: true, name: true, kind: true, executor: true } } } }),
      loadAgentProfileView(db, organizationId, profileId),
    ]);
    const pinnedRunner = lease === null && task.runnerId !== null ? await db.runner.findFirst({ where: { id: task.runnerId, organizationId }, select: { id: true, name: true, kind: true, executor: true } }) : null;
    const runner = lease === null ? pinnedRunner : lease.runner;
    const [extras, followUp] = await Promise.all([
      loadTaskExtras(ctx.deps, task, agent?.model?.id ?? null, runner?.name ?? null),
      loadFollowUp(db, organizationId, task, ctx.deps.settings.team.roundLimits),
    ]);
    // F-137: the levels of the model the newest session runs, or the profile's before there's one.
    const effortLevels = await taskEffortLevels(ctx.deps, organizationId, session?.modelId ?? agent?.model?.id ?? null, agent?.adapter ?? null);
    // Milestone 9 (F-148/c5, c9, ticket 14): the same model's image input, and whether the runner takes files.
    const messageFiles = await messageFilesOfTask(ctx.deps, organizationId, {
      modelId: session?.modelId ?? agent?.model?.id ?? null,
      adapter: agent?.adapter ?? null,
      runner: runner === null ? null : { id: runner.id, name: runner.name },
    });
    // Milestone 3 (ticket 35): the approvals, questions and plan the page answers from, and the task's rules.
    const answerable = await loadApprovalsAndPlan(ctx.deps, task);
    const isDriver = task.driverMemberId === ctx.scope.memberId;
    const state = task.state;
    // The composer reads these and never works out which from the state (ADR 0036): a limit or a crash
    // that ended the session leaves nothing to stop, and a task in review, merged or done has none running.
    const newestSession = extras.sessions.at(-1);
    const endedByLimitOrCrash = newestSession !== undefined && (newestSession.state === "crashed" || newestSession.limit !== null);
    const otherActive =
      task.ticketId === null
        ? 0
        : await db.task.count({
            where: { organizationId, projectId: task.projectId, ticketId: task.ticketId, kind: "code", id: { not: task.id }, state: { notIn: [...finishedTaskStates] } },
          });
    // F-066 (ticket 24): a merged task reopens on a fresh branch from each merged repo's base; one
    // whose repos record no merge has no base to start from, and stays blocked as before.
    const mergedRepo = task.repos.some((repo) => repo.state === "merged");
    const sessionGoing = session !== undefined && isOneOf(GOING_SESSION_STATES, session.state);
    // A needs-you task whose session has ended (a question that expired cancels its turn) has no
    // agent left to answer: a reopen with the member's message is the only way on.
    const reopenState = waitsForReopen({ state, needsYouReason: task.needsYouReason, mergedRepo, sessionState: session?.state ?? null });
    const reopenBlocked =
      state === "merged" && !mergedRepo
        ? ("merged_reopen_later" as const)
        : reopenState && otherActive > 0
          ? ("ticket_has_task" as const)
          : reopenState && extras.spend.reached
            ? ("spend_cap" as const)
            : null;
    // What the caller may do: send and interrupt as the driver of a task with a session going, answer
    // approvals as any member, take over as any member who isn't the driver, stop until it is stopped.
    return {
      id: taskIdSchema.parse(task.id),
      projectId: projectIdSchema.parse(task.projectId),
      key: task.ticketKey ?? shortKeyOf(task.id),
      title: task.title,
      kind: task.kind,
      source: task.source,
      state,
      subState: task.subState,
      /**
       * 2026-11-21 (F-100, ADR 0059 amended): for a review task, the code task and PRs it reviews and
       * its newest round; `null` for any other task.
       */
      reviewOf: followUp.reviewOf,
      /** For a code task with an AI review: its review task's state and the newest round's; else `null`. */
      aiReview: followUp.aiReview,
      /**
       * Milestone 10 (F-151/c7, ticket 08): a review task's figures for its status line, its Result
       * group and its top bar (`round 2 of 3: nothing blocking, 1 nit`, `Open the code task`,
       * `PR #483`, `Open the review`); `null` on any other kind.
       */
      review: followUp.review,
      /**
       * Milestone 6 (F-035, F-101, ticket 35): the review loop's counters since a person last acted,
       * with the install's limits, for the task page's stage line and its Rounds group.
       */
      roundCounts: {
        ci: { used: task.ciRounds, limit: ctx.deps.settings.team.roundLimits.ciRounds },
        review: { used: task.reviewRounds, limit: ctx.deps.settings.team.roundLimits.reviewRounds },
        automaticTurns: { used: task.automaticTurns, limit: ctx.deps.settings.team.roundLimits.automaticTurns },
        lastPersonActionAt: task.lastPersonActionAt?.getTime() ?? null,
      },
      reason: task.needsYouReason ?? task.stoppedReason,
      group: groupOf(state),
      /** Why a queued task waits (Q132): data the panel words, never a sentence. */
      waiting: waitingFor(task, lease),
      /** Milestone 5 (F-067): its place in its pool's queue now, or `null`. */
      queue: (await queuePlacesOf(db, organizationId, [task])).get(task.id) ?? null,
      branchName: task.branchName,
      /** The newest event's seq: the live tail resumes after what a history page returned. */
      headSeq: task.eventSeq,
      createdAt: task.createdAt.getTime(),
      updatedAt: task.updatedAt.getTime(),
      driver: driver === null ? null : { memberId: memberIdSchema.parse(driver.id), name: driver.user.name },
      creator: creator === null ? null : { memberId: memberIdSchema.parse(creator.id), name: creator.user.name },
      runner:
        runner === null
          ? null
          : { id: runnerIdSchema.parse(runner.id), name: runner.name, kind: runner.kind, executor: runner.executor, isolated: runner.executor !== "host" },
      repos: task.repos.map((repo) => ({
        repoId: repo.repoId,
        fullName: repo.repo.fullName,
        /** Milestone 10 (F-151): its folder in the workspace, so the thread shows a path relative to it. */
        checkoutDir: repo.repo.checkoutDir,
        branchName: repo.branchName,
        baseBranch: repo.baseBranch,
        state: repo.state,
        headSha: repo.headSha,
        /**
         * Ticket 41 (task-rounds.md's Code group): the code host's CI on the head, with its first
         * failing check; `null` without a PR. Milestone 10 (F-151/c6): counted in jobs, with every
         * failing job by name.
         */
        ci: repo.prNumber === null ? null : ciOfHead(repo.ciRuns.find((run) => run.headSha === repo.headSha) ?? null),
        pr: repo.prNumber === null || repo.prUrl === null ? null : { number: repo.prNumber, url: repo.prUrl, state: prStateOf(repo.state) },
        /** Milestone 3 (ticket 39, F-070): how many commits the base is ahead of the branch, as of `behindCheckedAt`; `null` before it is read. */
        behindBy: repo.behindBy,
        behindCheckedAt: repo.behindCheckedAt?.getTime() ?? null,
        /** Every PR the repo has had, oldest first (F-066): a merged one stays when a reopen opens another. */
        pullRequests: repo.pullRequests.map((pr) => ({
          number: pr.number,
          url: pr.url,
          branchName: pr.branchName,
          state: pr.state,
          draft: pr.draft,
          draftByOstra: pr.draftByOstra,
          openedAt: pr.openedAt.getTime(),
          closedAt: pr.closedAt?.getTime() ?? null,
          /**
           * F-104 (ticket 30, ADR 0040 amended): `ostra/independent-review` on the PR's newest head
           * ostra has checked, `null` before its first evaluation; `heads` keeps every head's.
           */
          reviewCheck: reviewCheckOf(repo.reviewChecks.filter((check) => check.prNumber === pr.number), reviewers),
        })),
      })),
      session:
        session === undefined
          ? null
          : {
              id: sessionIdSchema.parse(session.id),
              state: session.state,
              outcome: session.outcome,
              inputTokens: session.inputTokens,
              outputTokens: session.outputTokens,
              cacheReadTokens: session.cacheReadTokens,
              cacheWriteTokens: session.cacheWriteTokens,
              /** F-135 (ticket 50, ADR 0065): the provider whose key the session uses, by name; `null` before its start resolves one. */
              providerName: session.provider?.name ?? null,
            },
      /** The agent profile the task runs with: its agent and model (task.md, the properties panel). */
      agent,
      /**
       * F-137 (ADR 0066): the task's reasoning level for its next turn, and the levels its session's
       * model offers, `Default` first (`Default` alone: no control). Each turn's level is in `usage`.
       */
      effort: { level: effortLevelFromDb[task.effort], levels: toLevelViews(effortLevels) },
      /**
       * Milestone 9 (F-148, ticket 14): what the message box says of files before sending: the
       * model the next message goes to (the newest session's, else the profile's), by name, and
       * whether it sees images (`yes`, `no`, `unknown`: unknown counts as no); whether the agent
       * takes images in its prompt; and the task's runner by name when it speaks below protocol
       * minor 8 and can't take files (`oldRunner`: a send with files is refused).
       */
      messageFiles,
      // Ticket 36: the item's ID, so the page can answer it (`tasks.dismissNeedsYou`).
      needsYou: task.needsYouItems.map((item) => ({ id: needsYouItemIdSchema.parse(item.id), reason: item.reason, audience: item.audience, approvalId: item.approvalId, summary: item.summary })),
      ...extras,
      /** F-084 (ticket 39): the task's tokens in four kinds, spend and agent time, in total and per turn; estimates are marked. */
      usage: await loadUsageView(ctx.deps, organizationId, taskIdSchema.parse(task.id)),
      /** What the page answers: open approvals with their rule, subject and options, open questions, the plan, and the task's rules. */
      ...answerable,
      capabilities: {
        send: isDriver && sessionGoing && (state === "running" || state === "needs_you"),
        interrupt: isDriver && sessionGoing && state === "running",
        answerApprovals: state === "needs_you" || state === "running",
        takeOver: !isDriver,
        /** F-137: the driver changes the level, from the next turn; anyone else takes over first. */
        setEffort: isDriver,
        /** Milestone 3 (ticket 19, ADR 0036): whether Send reaches the agent mid-turn, for the composer's hint. */
        steersMidTurn: agent !== null && agentSteersMidTurn(agent.adapter),
        /**
         * Milestone 10 (F-151/c5, ticket 07): whether the agent takes a member's own words for a
         * question's choice, as its adapter declares it, so the question block offers "Something else…".
         */
        questionFreeText: agent !== null && agentTakesQuestionFreeText(agent.adapter),
        stop: state !== "stopped" && state !== "merged" && state !== "done" && state !== "in_review" && !endedByLimitOrCrash,
        /** Any member who can read the project may reopen: stopped, in review, done, or needing a reopen. */
        reopen: reopenState && reopenBlocked === null,
        /**
         * Milestone 10 (F-032, ticket 11; `s2.md`): the driver's message starts the next turn in the
         * task's idle box. It's still a reopen (the dispatch resumes the box it finds warm, ADR 0039),
         * so the composer reads as a send there: `Message OpenCode…`, Send, `The box is idle.`
         */
        reopenInBox: isDriver && reopenState && reopenBlocked === null && sessionGoing && extras.box?.state === "idle",
        /** Why a task that looks reopenable can't be: a merged task (F-066), another active task on its ticket, or its spend cap. */
        reopenBlocked: reopenState || state === "merged" ? reopenBlocked : null,
        /** The one-click reopen from a limit or a crash needs no message. A spend cap needs its cap raised first. */
        reopenWithoutText:
          state === "needs_you" &&
          reopenBlocked === null &&
          task.needsYouReason !== null &&
          isOneOf(CARRY_ON_REASONS, task.needsYouReason),
        /** Retry the ticket writes that failed. */
        retrySync: extras.sync.some((write) => write.state === "failed"),
        /** Milestone 3 (ticket 35): the driver answers the agent's questions and the plan; anyone else is told to take over. */
        answerQuestions: isDriver && answerable.questions.length > 0,
        answerPlan: isDriver && answerable.plan !== null && answerable.plan.itemId !== null,
      },
    };
  }),

  /**
   * The task's events, paged by turn, reading backwards (ADR 0036): the newest 20 turns first, and
   * `beforeSeq` (the previous page's `nextBeforeSeq`) asks for the 20 before them. The live tail
   * starts after `headSeq`, the newest seq the first page returned.
   */
  history: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, beforeSeq: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const TURNS_PER_PAGE = 20;
    // One more than a page, to know whether an older page exists.
    const turns = await db.turn.findMany({
      where: { taskId: input.taskId, organizationId, ...(input.beforeSeq === undefined ? {} : { startSeq: { lt: input.beforeSeq } }) },
      orderBy: { startSeq: "desc" },
      take: TURNS_PER_PAGE + 1,
      select: { startSeq: true },
    });
    const hasOlder = turns.length > TURNS_PER_PAGE;
    const page = turns.slice(0, TURNS_PER_PAGE);
    const oldest = page.at(-1);
    // The oldest page reaches back to the start of the log, so what came before the first turn (the
    // prompt, the environment's setup) is on it.
    const from = hasOlder && oldest !== undefined ? oldest.startSeq : 0;
    const rows = await db.event.findMany({
      where: { taskId: input.taskId, organizationId, seq: { gte: from, ...(input.beforeSeq === undefined ? {} : { lt: input.beforeSeq }) } },
      orderBy: { seq: "asc" },
    });
    const events: StoredEvent[] = rows.map(mapEventToStored);
    const task = await db.task.findUniqueOrThrow({ where: { id: input.taskId }, select: { eventSeq: true } });
    return {
      events,
      /** The `beforeSeq` of the next older page, or `null` when this page reaches the start. */
      nextBeforeSeq: hasOlder && oldest !== undefined ? oldest.startSeq : null,
      /** The newest seq that existed when the first page was read: where the live tail resumes. */
      headSeq: input.beforeSeq === undefined ? (events.at(-1)?.seq ?? 0) : null,
      taskHeadSeq: task.eventSeq,
    };
  }),

  /**
   * The task's event log (F-073, ADR 0054, ticket 25): every event in order, paged by `seq`, for any
   * member who can open the task. A tool call carries its full input as stored, a failed or refused
   * one its error, an approval the command it asked about. `kinds` keeps only those kinds. It reads
   * only.
   */
  eventLog: taskProcedure(
    "read",
    z.strictObject({
      taskId: taskIdSchema,
      /** Events after this seq: the previous page's `nextAfterSeq`. */
      afterSeq: z.number().int().nonnegative().optional(),
      kinds: z.array(z.string().min(1).max(80)).max(50).optional(),
      limit: z.number().int().min(1).max(EVENT_LOG_MAX_PAGE).optional(),
    }),
  ).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const limit = input.limit ?? EVENT_LOG_PAGE;
    const rows = await db.event.findMany({
      where: {
        taskId: input.taskId,
        organizationId: ctx.scope.organizationId,
        seq: { gt: input.afterSeq ?? 0 },
        ...(input.kinds === undefined || input.kinds.length === 0 ? {} : { kind: { in: input.kinds } }),
      },
      orderBy: { seq: "asc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const events: StoredEvent[] = page.map(mapEventToStored);
    return {
      events,
      /** The `afterSeq` of the next page, or `null` when this page reaches the newest event. */
      nextAfterSeq: rows.length > limit ? (events.at(-1)?.seq ?? null) : null,
    };
  }),

  /**
   * The Event log tab's count (task-event-log.md, "Layout"): the log's rows, every event but the
   * ones folded into another row or never shown (`eventLogFoldedKinds`), so it is the tab's `All`.
   */
  eventLogCount: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const rows = await ctx.deps.db.event.count({
      where: { taskId: input.taskId, organizationId: ctx.scope.organizationId, kind: { notIn: [...eventLogFoldedKinds] } },
    });
    return { rows };
  }),

  /**
   * Reopens a task (F-032, F-033): any member who can read the project, from stopped, in review, done
   * or needing a reopen. The same `clientMessageId` twice is applied once. `text` may be left out only
   * for the one-click reopen from a limit or a crash; a merged task is refused until F-066.
   */
  reopen: taskProcedure("read", reopenTaskInputSchema.extend({ intent: memberIntentSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports, settings, messageFiles } = ctx.deps;
    // A task at its spend cap stays stopped until the cap is raised (F-068, ticket 19).
    const spendCap = { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap };
    // Milestone 9 (F-148, ticket 14): the reopen's files (`fileIds`) are bound within the limits, and may come without words.
    const result = await db.$transaction((tx) => reopenTask({ tx, scope: ctx.scope, ...ports, spendCap, files: messageFiles }, input));
    const reopened = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
      "file-not-found": "BAD_REQUEST",
    });
    return { sessionId: reopened.sessionId };
  }),

  /**
   * The Checks tab (F-054, ticket 39): the environment's checks, and each turn's runs with the end
   * of their output, the commit they ran on, and a link to the full output (served by the web app
   * after the access check). Any member who can open the project reads it.
   */
  checks: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const task = await ctx.deps.db.task.findFirst({ where: { id: input.taskId, organizationId: ctx.scope.organizationId }, select: { id: true, organizationId: true, projectId: true } });
    if (task === null) {
      throw notFoundTask();
    }
    return loadChecksView(ctx.deps, { id: input.taskId, organizationId: ctx.scope.organizationId, projectId: task.projectId });
  }),

  /**
   * "Ask the agent to fix" (F-054): every failing check's command and output as one message
   * (`intent: "fix-checks"`), sent as the composer sends: the driver to a session that is going, a
   * reopen with none. Anyone else is told "Take over to send".
   */
  fixChecks: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await askAgentToFixChecks({ db, ...ports }, { spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } }, ctx.scope, { taskId: input.taskId });
    const asked = unwrap(result, {
      "not-found": "NOT_FOUND",
      "nothing-failing": "PRECONDITION_FAILED",
      "take-over-to-send": "FORBIDDEN",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
      "file-not-found": "BAD_REQUEST",
      "runner-needs-upgrade": "PRECONDITION_FAILED",
    });
    return { checks: asked.checks, delivery: asked.delivery };
  }),

  /**
   * "Update branch" (F-070, ADR 0052): one message (`intent: "update-branch"`) naming each repo that is
   * behind its base, sent as the composer sends. A task with nothing behind refuses it.
   */
  updateBranch: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await requestUpdateBranchWith({ db, ...ports }, { spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } }, ctx.scope, { taskId: input.taskId });
    const asked = unwrap(result, {
      "not-found": "NOT_FOUND",
      "nothing-behind": "PRECONDITION_FAILED",
      "take-over-to-send": "FORBIDDEN",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
      "file-not-found": "BAD_REQUEST",
      "runner-needs-upgrade": "PRECONDITION_FAILED",
    });
    return { repos: asked.repos, delivery: asked.delivery };
  }),

  /**
   * "Keep working" (F-066, Q181): the answer to a ticket closed while the task ran that lets it carry
   * on. The item is dismissed and "Carry on where you stopped." goes to the agent. The other answer is
   * `tasks.stop`.
   */
  keepWorking: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await keepWorking({ db, ...ports }, { spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } }, ctx.scope, { taskId: input.taskId });
    const kept = unwrap(result, {
      "not-found": "NOT_FOUND",
      "not-waiting": "CONFLICT",
      "take-over-to-send": "FORBIDDEN",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
      "file-not-found": "BAD_REQUEST",
      "runner-needs-upgrade": "PRECONDITION_FAILED",
    });
    return { delivery: kept.delivery };
  }),

  /**
   * "Take it local" (F-028, F-103): the `ostra checkout` line with the task's key (or ID), the
   * login line for a machine that has never signed in, whether the member has a CLI session, and the
   * plain git commands per repo.
   */
  local: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const task = await ctx.deps.db.task.findFirst({ where: { id: input.taskId, organizationId: ctx.scope.organizationId }, select: { id: true, ticketKey: true } });
    if (task === null) {
      throw notFoundTask();
    }
    return loadLocalView(ctx.deps, { id: input.taskId, organizationId: ctx.scope.organizationId, ticketKey: task.ticketKey, shortKey: shortKeyOf(task.id) }, { userId: ctx.user.userId });
  }),

  /** "Carry on without it": the driver or a project admin closes a needs-you item that doesn't hold the task, such as a restore conflict. */
  dismissNeedsYou: taskProcedure("read", dismissNeedsYouInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) => dismissNeedsYou({ tx, scope: ctx.scope, ...ports }, input));
    const dismissed = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "not-open": "CONFLICT" });
    return { itemId: dismissed.itemId };
  }),

  /** Retries the task's failed ticket writes (F-031). They keep their idempotency keys, so a write that did land isn't made twice. */
  retrySync: taskProcedure("read", retryTicketWritesInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) => retryTicketWrites({ tx, scope: ctx.scope, ...ports }, input));
    const retried = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
    return { retried: retried.retried };
  }),

  /** Stops the task's agent (F-025): the branch and the hidden ref stay on GitHub. For any member of the project. */
  stop: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) => stopTask({ tx, scope: ctx.scope, ...ports }, input));
    unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "already-stopped": "CONFLICT" });
    return { stopped: true as const };
  }),

  /**
   * The driver's message to the running agent (F-024, ADR 0036). Only the driver may send: the check
   * runs under the task's lock, so a take-over and a send at the same moment either commit in that
   * order or the send is refused. Sending the same `clientMessageId` again is applied once. The
   * message is the member's own words (`memberIntentSchema`).
   */
  send: taskProcedure(
    "read",
    z
      .strictObject({
        taskId: taskIdSchema,
        clientMessageId: clientMessageIdSchema,
        /** The member's words. Milestone 9 (F-148/c1): may be empty when files come. Never logged. */
        text: z.string().trim().max(runnerLimits.steerTextMaxChars),
        delivery: z.enum(["queue", "interrupt"]).default("queue"),
        intent: memberIntentSchema,
        /** Milestone 9 (F-148, ticket 14): the member's own unsent uploads in the task's project, in their order. */
        fileIds: z.array(messageFileIdSchema).max(runnerLimits.messageFilesMax).optional(),
      })
      .refine((input) => input.text !== "" || (input.fileIds?.length ?? 0) > 0, { message: "Say what the agent should do, or attach a file", path: ["text"] }),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports, messageFiles } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    return db.$transaction(async (tx) => {
      const task = await lockTask(tx, input.taskId, organizationId);
      if (task === null) {
        throw notFoundTask();
      }
      if (task.driverMemberId !== ctx.scope.memberId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the driver can send. Take over first" });
      }
      const sent = await tx.event.findFirst({
        where: { taskId: task.id, kind: "user.message", payload: { path: ["clientMessageId"], equals: input.clientMessageId } },
        select: { seq: true },
      });
      if (sent !== null) {
        return { seq: sent.seq, duplicate: true as const };
      }
      const { lease, session } = await activeLeaseAndSession(tx, task.id);
      const lifecycle = lifecycleOf(task);
      if (lifecycle.status.state !== "running" && lifecycle.status.state !== "needs_you") {
        throw new TRPCError({ code: "CONFLICT", message: "The task isn't running: there is no session to send to" });
      }
      if (lease === null || session === null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The task has no runner holding it right now" });
      }
      const now = ports.clock.now();
      const projectId = projectIdSchema.parse(task.projectId);
      const sessionId = sessionIdSchema.parse(session.id);
      // Milestone 9 (F-148, ticket 14): the files are the sender's own unsent uploads of the task's
      // project, and the runner holding the session must take files (protocol minor 8, Q340): both
      // checked before anything is written. They're bound to the message in this transaction.
      const fileIds = input.fileIds ?? [];
      if (fileIds.length > 0) {
        if ((await uploadsOfInTx(tx, ctx.scope, projectId, fileIds)) === null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "One of the files isn't one of your unsent uploads in this project" });
        }
        if (!(await runnerTakesFilesInTx(tx, lease.runnerId))) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: RUNNER_NEEDS_UPGRADE_FOR_FILES });
        }
      }
      // The session's model: its images decide the files', and between turns the budget gate reads it.
      const modelId =
        fileIds.length > 0 || session.state === "idle" ? await sessionModelIdInTx(tx, organizationId, { agentProfileId: session.agentProfileId, modelId: session.modelId }) : null;
      const files = await filesToBindInTx(tx, organizationId, messageFiles, { fileIds, modelId, agentProfileId: session.agentProfileId });
      // F-078 (ADR 0040): the message is sent, held or restarted below, so the driver who sent it,
      // a member who took over included, is a co-author of what follows: a trailer on its commits.
      await creditCoAuthorInTx(ports.jobs, tx, { organizationId, projectId, taskId: input.taskId, memberId: ctx.scope.memberId });
      const where = { organizationId, projectId, taskId: input.taskId, sessionId, at: now };
      // Milestone 4 (F-037, ADR 0055): between turns a message starts one, so it passes the budget
      // gate first; a closed gate saves it and holds the turn. A turn going takes it, gate or not.
      if (session.state === "idle") {
        // Milestone 4 (F-135, ADR 0065): a turn start checks the session's provider against the
        // project's list now; moved or gone, the message starts a fresh session instead of a steer.
        const providers = await sessionProviderGateInTx(tx, { organizationId, projectId, providerId: session.providerId, modelId: session.modelId, agentProfileId: session.agentProfileId });
        if (providers !== null && providers.kind !== "open") {
          const restarted = await restartOnProviderChangeInTx(ports, tx, mapTask(task), providers, {
            memberId: ctx.scope.memberId,
            clientMessageId: input.clientMessageId,
            text: input.text,
            intent: input.intent,
            files,
          });
          return { seq: restarted.seq, duplicate: false as const };
        }
        const gate = await checkBudget(tx, { organizationId, projectId, modelId, origin: turnOriginOfIntent(input.intent), now });
        if (gate.kind === "held") {
          const { seq: heldSeq } = await appendMemberMessageInTx(
            tx,
            where,
            {
              kind: "user.message",
              memberId: ctx.scope.memberId,
              clientMessageId: input.clientMessageId,
              text: input.text,
              delivery: "queued",
              ...(input.intent === undefined ? {} : { intent: input.intent }),
            },
            files,
          );
          await holdTurnInTx(ports, tx, { organizationId, projectId, taskId: input.taskId, sessionId, held: gate, pendingMessageSeq: heldSeq, now, queued: false });
          return { seq: heldSeq, duplicate: false as const, held: true as const };
        }
      }
      if (lifecycle.status.state === "needs_you") {
        const moved = transitionTask(lifecycle, { type: "member_acted", boxWarm: true });
        if (moved.ok) {
          await tx.task.update({ where: { id: task.id }, data: taskToColumns(moved.state) });
          // The message answers what the task waited on: the items its next turn answers close.
          await answerNextTurnItemsInTx(ports, tx, task.id, { at: new Date(now), byMemberId: ctx.scope.memberId });
        }
      }
      if (input.delivery === "interrupt") {
        await appendServerEvent(tx, { organizationId, projectId, taskId: input.taskId, sessionId, at: now, event: { kind: "turn.cancel_requested", memberId: ctx.scope.memberId } });
      }
      // ADR 0036: an agent that steers mid-turn takes a message at once while its turn runs; for any
      // other, or between turns, the message waits for the next turn and reads "queued" to everyone
      // until that turn starts (`messageDeliveries`).
      const adapter = session.state === "running" ? await sessionAdapterInTx(tx, session.agentProfileId, organizationId) : null;
      const steers = adapter !== null && agentSteersMidTurn(adapter);
      const { seq, bound } = await appendMemberMessageInTx(
        tx,
        where,
        {
          kind: "user.message",
          memberId: ctx.scope.memberId,
          clientMessageId: input.clientMessageId,
          text: input.text,
          delivery: input.delivery === "interrupt" ? "after-interrupt" : steers ? "immediate" : "queued",
          ...(input.intent === undefined ? {} : { intent: input.intent }),
        },
        files,
      );
      await ports.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
        kind: "steer",
        // The steer carries the message's files and which go as images (ticket 11's runner writes them before the agent gets it).
        body: {
          sessionId,
          clientMessageId: input.clientMessageId,
          text: input.text,
          delivery: input.delivery,
          ...(input.intent === undefined ? {} : { intent: input.intent }),
          ...steerFileFields(bound),
          // F-078 (minor 8): the task's co-authors, the sender credited above among them, for the box's commits from this message on.
          coAuthors: await taskCoAuthorsInTx(tx, { organizationId, taskId: input.taskId }),
        },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: input.taskId, projectId },
      });
      await ports.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: input.taskId });
      return { seq, duplicate: false as const, held: false as const };
    });
  }),

  /**
   * F-137 (ADR 0066, Q288): sets the task's reasoning level from its next turn. The driver only,
   * under the task's lock (ticket 56's use case); a level the session's model doesn't offer is
   * refused, naming the ones it does. `changeId` makes a retried change apply once.
   */
  setEffort: taskProcedure(
    "read",
    z.strictObject({ taskId: taskIdSchema, level: effortLevelSchema, changeId: effortChangeIdSchema.optional() }),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const levels = await taskEffortLevelsOf(ctx.deps, organizationId, input.taskId);
    if (!levels.includes(input.level)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: levelRefusal(input.level, levels) });
    }
    // The domain checks the level against the session's model again, inside the task's lock (ticket 59).
    const result = await setTaskEffort({ db, ...ports, effortLevels: ctx.deps.agentEffort.levelsFor }, ctx.scope, {
      taskId: input.taskId,
      level: input.level,
      changeId: input.changeId ?? effortChangeIdSchema.parse(randomUUID()),
    });
    const set = unwrap(result, { "not-found": "NOT_FOUND", "take-over-to-change": "FORBIDDEN", "level-not-offered": "BAD_REQUEST" });
    return { from: set.from, to: set.to, changed: set.changed, sentToRunner: set.sentToRunner };
  }),

  /** Cancels the running turn and keeps the session. The driver only. */
  interrupt: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    return db.$transaction(async (tx) => {
      const task = await lockTask(tx, input.taskId, organizationId);
      if (task === null) {
        throw notFoundTask();
      }
      if (task.driverMemberId !== ctx.scope.memberId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the driver can interrupt. Take over first" });
      }
      const { lease, session } = await activeLeaseAndSession(tx, task.id);
      if (lease === null || session === null || lifecycleOf(task).status.state !== "running") {
        throw new TRPCError({ code: "CONFLICT", message: "There is no running turn to interrupt" });
      }
      const now = ports.clock.now();
      const projectId = projectIdSchema.parse(task.projectId);
      const sessionId = sessionIdSchema.parse(session.id);
      await appendServerEvent(tx, { organizationId, projectId, taskId: input.taskId, sessionId, at: now, event: { kind: "turn.cancel_requested", memberId: ctx.scope.memberId } });
      await ports.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
        kind: "interrupt",
        body: { sessionId },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: input.taskId, projectId },
      });
      await ports.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: input.taskId });
      return { interrupted: true as const };
    });
  }),

  /** Becomes the task's driver (F-024): a compare-and-set under the task's lock, and an event ("Alex took over"). */
  takeOver: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    return db.$transaction(async (tx) => {
      const task = await lockTask(tx, input.taskId, organizationId);
      if (task === null) {
        throw notFoundTask();
      }
      if (task.driverMemberId === ctx.scope.memberId) {
        return { driver: ctx.scope.memberId, changed: false as const };
      }
      const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session === null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The task has no session yet" });
      }
      const projectId = projectIdSchema.parse(task.projectId);
      await tx.task.update({ where: { id: task.id }, data: { driverMemberId: ctx.scope.memberId } });
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: input.taskId,
        sessionId: sessionIdSchema.parse(session.id),
        at: ports.clock.now(),
        event: { kind: "driver.changed", memberId: ctx.scope.memberId, byMemberId: ctx.scope.memberId },
      });
      await ports.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: ctx.scope.memberId },
        action: "task.driver-changed",
        entity: "task",
        entityId: input.taskId,
      });
      await ports.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: input.taskId });
      return { driver: ctx.scope.memberId, changed: true as const };
    });
  }),
});

/**
 * Milestone 9 (F-148/c5, c9, ticket 14): the files a task's message box can send, as the box says
 * them before sending: the model by name and its image input, whether the agent takes images, and
 * the runner's name when it can't take files (below protocol minor 8).
 */
const messageFilesOfTask = async (
  deps: ApiDeps,
  organizationId: OrganizationId,
  input: { readonly modelId: string | null; readonly adapter: string | null; readonly runner: { readonly id: string; readonly name: string } | null },
) => {
  const model =
    input.modelId === null
      ? null
      : await deps.db.model.findFirst({ where: { id: input.modelId, organizationId }, select: { id: true, displayName: true, endpointModelId: true, adminImageInput: true, catalogInputModalities: true } });
  const takesFiles = input.runner === null ? true : await runnerTakesFilesInTx(deps.db, input.runner.id);
  return {
    model: model === null ? null : { id: modelIdSchema.parse(model.id), name: model.displayName ?? model.endpointModelId, imageInput: modelImageInput(model) },
    agentTakesImages: input.adapter !== null && deps.messageFiles.agentTakesImages(input.adapter),
    oldRunner: input.runner === null || takesFiles ? null : input.runner.name,
  };
};

/** The levels a model offers for an agent; `default` alone without either. */
const taskEffortLevels = async (deps: ApiDeps, organizationId: OrganizationId, modelId: string | null, adapter: string | null): Promise<readonly EffortLevel[]> => {
  if (modelId === null || adapter === null) {
    return ["default"];
  }
  return (await loadModelEffort(deps.db, deps.agentEffort, organizationId, modelId, adapter))?.levels ?? ["default"];
};

/** A task's levels: its newest session's model and agent, or its project's default code profile's before it has one. */
const taskEffortLevelsOf = async (deps: ApiDeps, organizationId: OrganizationId, taskId: TaskId): Promise<readonly EffortLevel[]> => {
  const task = await deps.db.task.findFirst({
    where: { id: taskId, organizationId },
    select: { projectId: true, sessions: { orderBy: { startedAt: "desc" }, take: 1, select: { modelId: true, agentProfileId: true } } },
  });
  if (task === null) {
    return ["default"];
  }
  const session = task.sessions[0];
  const profileId =
    session?.agentProfileId ??
    (await deps.db.project.findFirst({ where: { id: task.projectId, organizationId }, select: { defaultCodeProfileId: true } }))?.defaultCodeProfileId ??
    null;
  const profile = profileId === null ? null : await deps.db.agentProfile.findFirst({ where: { id: profileId, organizationId }, select: { adapter: true, modelId: true } });
  return taskEffortLevels(deps, organizationId, session?.modelId ?? profile?.modelId ?? null, profile?.adapter ?? null);
};

/** The agent adapter of a session's profile, or `null` when it has none. */
const sessionAdapterInTx = async (tx: Tx, profileId: string | null, organizationId: OrganizationId): Promise<string | null> =>
  profileId === null ? null : ((await tx.agentProfile.findFirst({ where: { id: profileId, organizationId }, select: { adapter: true } }))?.adapter ?? null);

/** The lease and the session a send, an interrupt or an answer goes through. */
const activeLeaseAndSession = async (tx: Tx, taskId: string) => {
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId, state: "active" }, select: { runnerId: true, epoch: true } }),
    tx.session.findFirst({
      where: { taskId, state: { in: ["starting", "running", "waiting", "idle"] } },
      select: { id: true, state: true, agentProfileId: true, providerId: true, modelId: true },
    }),
  ]);
  return { lease, session };
};

// ---------- approvals ----------

export const approvalsRouter = router({
  /**
   * Answers an approval (F-026): any member who can open the project may. The first answer wins,
   * through a compare-and-set on the approval, and a second member gets `CONFLICT`. The answer is a
   * committed event and an audit entry, and a command to the runner holding the task's lease.
   * Milestone 3 (ticket 17): "for this task" writes a task rule and returns it; a deny takes an
   * optional reason; an expired approval whose item is open is answered too, and reopens the task.
   */
  answer: memberProcedure
    .input(z.strictObject({ approvalId: approvalIdSchema, decision: approvalDecisionSchema, reason: z.string().max(runnerLimits.denyReasonMaxChars * 2).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const found = await db.approval.findFirst({ where: { id: input.approvalId, organizationId: ctx.scope.organizationId }, select: { options: true } });
      const options = z.array(approvalOptionSchema).safeParse(found?.options ?? []);
      const option = options.success ? options.data.find((candidate) => candidate.decision === input.decision) : undefined;
      if (found === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      }
      if (option === undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The agent offered no such option" });
      }
      const result = await answerApproval(
        { db, ...ports, spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } },
        ctx.scope,
        { approvalId: input.approvalId, decision: input.decision, optionId: option.optionId, reason: input.reason ?? null },
      );
      const answered = unwrap(result, {
        "not-found": "NOT_FOUND",
        "already-answered": "CONFLICT",
        "no-pattern": "PRECONDITION_FAILED",
        "invalid-input": "BAD_REQUEST",
      });
      return { approvalId: input.approvalId, decision: input.decision, taskRule: answered.taskRule, reopened: answered.reopened };
    }),

  /**
   * What the card shows before the member decides (ticket 35): the rule that asked, the subject, and
   * the pattern "Approve for this task" would add (`null` when the subject gives none, and the card
   * then offers no such button). For any member who can open the project; read only.
   */
  preview: memberProcedure.input(z.strictObject({ approvalId: approvalIdSchema })).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const found = await db.approval.findFirst({ where: { id: input.approvalId, organizationId: ctx.scope.organizationId }, select: { projectId: true } });
    if (found === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
    }
    await loadProjectAccess(db, ctx.scope, projectIdSchema.parse(found.projectId), "read").catch(() => {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
    });
    return previewApproval(ctx.deps, ctx.scope.organizationId, input.approvalId);
  }),
});
