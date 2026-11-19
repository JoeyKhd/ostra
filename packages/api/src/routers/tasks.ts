import {
  appendServerEvent,
  checkProjectRepos,
  createPromptTask,
  createPromptTaskInputSchema,
  createTicketForTask,
  createTicketForTaskInputSchema,
  dismissNeedsYou,
  dismissNeedsYouInputSchema,
  reopenTask,
  reopenTaskInputSchema,
  retryTicketWrites,
  retryTicketWritesInputSchema,
  startTicketTask,
  resolveNeedsYouItemsInTx,
  startTicketTaskInputSchema,
  waitingFor,
  stopTask,
  taskFromColumns,
  taskToColumns,
  transitionTask,
} from "@ostra/domain";
import type { TaskLifecycle, Waiting } from "@ostra/domain";
import { mapEventToStored } from "@ostra/db";
import type { Tx } from "@ostra/db";
import {
  approvalDecisionSchema,
  approvalIdSchema,
  approvalOptionSchema,
  clientMessageIdSchema,
  memberIdSchema,
  needsYouItemIdSchema,
  optionIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
  toolKindSchema,
} from "@ostra/protocol";
import type { OrganizationId, StoredEvent, TaskId, ToolKind } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadAgentProfileView } from "./agent-profile-view.ts";
import { loadTaskExtras, prStateOf } from "./task-extras.ts";
import { loadProjectAccess, memberProcedure, projectProcedure, router, taskProcedure, unwrap } from "../trpc/init.ts";

// F-097, F-023, F-025, F-014 (picking the runner), ticket 33: tasks. A task is visible to every
// member who can open its project and to nobody else (ADR 0026). Reading, stopping and answering an
// approval are for any such member; sending, interrupting and taking over follow the one-driver rule
// (ADR 0036): the server enforces it, under the task's lock, and the UI only hides the controls.

const taskInput = z.strictObject({ taskId: taskIdSchema });

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

/** The kinds of event the list words as "what the agent is doing now", newest wins. */
const doingKinds = [
  "tool.called",
  "agent.message",
  "agent.thought",
  "environment.setup_started",
  "environment.setup_output",
  "approval.requested",
  "question.asked",
  "git.pushed",
] as const;

export type DoingKind = (typeof doingKinds)[number];

/**
 * What the agent is doing now, for the list: a kind the panel words, and its detail. For a tool
 * call or an approval, `detail` is the command (`execute`) or the path (`edit`, `read`), and
 * `toolKind` says which; for another tool it's the tool's title, with `toolKind` null. For a
 * question it's the question.
 */
export type Doing = { readonly kind: DoingKind; readonly detail: string | null; readonly toolKind: ToolKind | null };

const DETAIL_MAX = 160;

const toolCallPayload = z.looseObject({ toolKind: toolKindSchema, title: z.string(), input: z.unknown() });
const pathInput = z.union([
  z.looseObject({ path: z.string().min(1) }).transform((input) => input.path),
  z.looseObject({ paths: z.tuple([z.string().min(1)], z.string()) }).transform((input) => input.paths[0]),
]);
const toolCallIdPayload = z.looseObject({ toolCallId: z.string() });
const questionPayload = z.looseObject({ message: z.string() });

/** A tool call's command or path, or its title when it names neither. */
const toolDetailOf = (payload: unknown): Pick<Doing, "detail" | "toolKind"> => {
  const call = toolCallPayload.safeParse(payload);
  if (!call.success) return { detail: null, toolKind: null };
  const { toolKind, title, input } = call.data;
  if (toolKind === "execute") return { detail: title.slice(0, DETAIL_MAX), toolKind };
  if (toolKind === "edit" || toolKind === "read") {
    const path = pathInput.safeParse(input);
    if (path.success) return { detail: path.data.slice(0, DETAIL_MAX), toolKind };
  }
  return { detail: title.slice(0, DETAIL_MAX), toolKind: null };
};

/** `toolCall`: the tool call an approval asks about, when there is one. */
const doingOf = (kind: DoingKind, payload: unknown, toolCall: unknown): Doing => {
  switch (kind) {
    case "tool.called":
      return { kind, ...toolDetailOf(payload) };
    case "approval.requested":
      return toolCall === undefined ? { kind, detail: null, toolKind: null } : { kind, ...toolDetailOf(toolCall) };
    case "question.asked": {
      const question = questionPayload.safeParse(payload);
      return { kind, detail: question.success && question.data.message !== "" ? question.data.message.slice(0, DETAIL_MAX) : null, toolKind: null };
    }
    case "agent.message":
    case "agent.thought":
    case "environment.setup_started":
    case "environment.setup_output":
    case "git.pushed":
      return { kind, detail: null, toolKind: null };
    default:
      return kind satisfies never;
  }
};

const latestDoingRow = z.object({ taskId: taskIdSchema, kind: z.enum(doingKinds), payload: z.unknown() });

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

/**
 * A prompt task's short ID: the last 8 hex digits, as in its branch name (`branchNameFor`). A
 * UUIDv7's first 8 are its timestamp, the same for every task made within about a minute.
 */
const shortKeyOf = (id: string): string => id.replaceAll("-", "").slice(-8);

const notFoundTask = () => new TRPCError({ code: "NOT_FOUND", message: "No such task" });

/** The task states a finished or waiting task can be reopened from (merged is refused in milestone 2: F-066). */
const REOPEN_FROM = ["stopped", "in_review", "done"] as const;
/** The needs-you reasons that wait for a reopen, not for an answer to the agent. */
const REOPEN_FROM_NEEDS_YOU = ["no_changes", "stalled", "spend_cap", "crashed", "setup_failed", "ticket_closed", "files_outside_repos"] as const;
/** The reasons a one-click reopen needs no message for (the carry-on text is written for the member). */
const CARRY_ON_REASONS = ["stalled", "spend_cap", "crashed"] as const;
const finishedTaskStates = ["stopped", "merged", "done"] as const;

const isOneOf = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

export const tasksRouter = router({
  /** Starts a code task from a prompt (F-097): no ticket is created. */
  create: projectProcedure("read", createPromptTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    // F-055: the repos' branch rules are read again as a task starts, so the use case refuses on a
    // current answer. A host that can't say never refuses.
    await checkProjectRepos(
      { db, clock: ports.clock, adapters: ports.adapters },
      { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: true },
    );
    const result = await db.$transaction((tx) => createPromptTask({ tx, scope: ctx.scope, ...ports }, input));
    const created = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      "runner-not-yours": "FORBIDDEN",
      "provider-not-allowed-on-personal-runners": "PRECONDITION_FAILED",
      "no-agent-profile": "PRECONDITION_FAILED",
      "no-repo": "PRECONDITION_FAILED",
      "repo-unsupported": "PRECONDITION_FAILED",
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
      "no-agent-profile": "PRECONDITION_FAILED",
      "no-repo": "PRECONDITION_FAILED",
      "repo-unsupported": "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
    });
    return { taskId: created.taskId, sessionId: created.sessionId, branchName: created.branchName };
  }),

  /**
   * "Create ticket" (F-097): for a prompt task with no ticket, on one of the project's boards. It
   * writes the `create` ticket write; when ticket sync has made the ticket, the task holds it and
   * the ticket holds the task's link. Asking again while one is made or exists is refused.
   */
  createTicket: taskProcedure("read", createTicketForTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await db.$transaction((tx) => createTicketForTask({ tx, scope: ctx.scope, publicUrl: settings.publicUrl, ...ports }, input));
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

    const [leases, pinned, members, latest] = await Promise.all([
      db.lease.findMany({
        where: { organizationId, taskId: { in: ids }, state: "active" },
        select: { taskId: true, runnerId: true, acceptedAt: true, grantedAt: true },
      }),
      db.runner.findMany({ where: { organizationId, id: { in: rows.flatMap((row) => (row.runnerId === null ? [] : [row.runnerId])) } }, select: { id: true } }),
      db.member.findMany({
        where: { organizationId, id: { in: rows.flatMap((row) => (row.driverMemberId === null ? [] : [row.driverMemberId])) } },
        select: { id: true, user: { select: { name: true } } },
      }),
      live.length === 0
        ? Promise.resolve<unknown>([])
        : db.$queryRaw`
            SELECT DISTINCT ON ("taskId") "taskId", "kind", "payload" FROM "event"
            WHERE "taskId" = ANY(${live}::text[]) AND "kind" = ANY(${[...doingKinds]}::text[])
            ORDER BY "taskId", "seq" DESC`,
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
    const latestRows = z.array(latestDoingRow).parse(latest);
    // An approval asks about a tool call: its command or path is what the row shows.
    const asked = latestRows.flatMap((row) => {
      const call = row.kind === "approval.requested" ? toolCallIdPayload.safeParse(row.payload) : null;
      return call?.success === true ? [{ taskId: row.taskId, toolCallId: call.data.toolCallId }] : [];
    });
    const calls =
      asked.length === 0
        ? []
        : z.array(z.object({ taskId: taskIdSchema, payload: z.unknown() })).parse(
            await db.$queryRaw`
              SELECT "taskId", "payload" FROM "event"
              WHERE "taskId" = ANY(${asked.map((row) => row.taskId)}::text[]) AND "kind" = 'tool.called'
                AND "payload"->>'toolCallId' = ANY(${asked.map((row) => row.toolCallId)}::text[])`,
          );
    const toolCallOf = (taskId: TaskId, payload: unknown): unknown => {
      const id = toolCallIdPayload.safeParse(payload);
      if (!id.success) return undefined;
      return calls.find((call) => call.taskId === taskId && toolCallIdPayload.safeParse(call.payload).data?.toolCallId === id.data.toolCallId)?.payload;
    };
    const doing = new Map(latestRows.map((row) => [row.taskId, doingOf(row.kind, row.payload, toolCallOf(row.taskId, row.payload))] as const));

    const summaries = rows.map((row) => {
      const runner = runnerById.get(leaseRunner.get(row.id) ?? row.runnerId ?? "");
      const id = taskIdSchema.parse(row.id);
      return {
        id,
        key: row.ticketKey ?? shortKeyOf(row.id),
        title: row.title,
        kind: row.kind,
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
        repos: { include: { repo: { select: { fullName: true } } }, orderBy: { createdAt: "asc" } },
        sessions: { orderBy: { startedAt: "desc" }, take: 1 },
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
    const [driver, creator, lease, agent] = await Promise.all([
      task.driverMemberId === null ? null : db.member.findFirst({ where: { id: task.driverMemberId, organizationId }, select: { id: true, user: { select: { name: true } } } }),
      task.creatorMemberId === null ? null : db.member.findFirst({ where: { id: task.creatorMemberId, organizationId }, select: { id: true, user: { select: { name: true } } } }),
      db.lease.findFirst({ where: { taskId: task.id, state: "active" }, include: { runner: { select: { id: true, name: true, kind: true, executor: true } } } }),
      loadAgentProfileView(db, organizationId, profileId),
    ]);
    const pinnedRunner = lease === null && task.runnerId !== null ? await db.runner.findFirst({ where: { id: task.runnerId, organizationId }, select: { id: true, name: true, kind: true, executor: true } }) : null;
    const runner = lease === null ? pinnedRunner : lease.runner;
    const extras = await loadTaskExtras(ctx.deps, task, agent?.model?.id ?? null, runner?.name ?? null);
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
    const reopenState = isOneOf(REOPEN_FROM, state) || (state === "needs_you" && isOneOf(REOPEN_FROM_NEEDS_YOU, task.needsYouReason));
    const reopenBlocked =
      state === "merged"
        ? ("merged_reopen_later" as const)
        : reopenState && otherActive > 0
          ? ("ticket_has_task" as const)
          : reopenState && extras.spend.reached
            ? ("spend_cap" as const)
            : null;
    // What the caller may do: send and interrupt as the driver of a task with a session going, answer
    // approvals as any member, take over as any member who isn't the driver, stop until it is stopped.
    const sessionGoing = session !== undefined && ["starting", "running", "waiting", "idle"].includes(session.state);
    return {
      id: taskIdSchema.parse(task.id),
      projectId: projectIdSchema.parse(task.projectId),
      key: task.ticketKey ?? shortKeyOf(task.id),
      title: task.title,
      kind: task.kind,
      source: task.source,
      state,
      subState: task.subState,
      reason: task.needsYouReason ?? task.stoppedReason,
      group: groupOf(state),
      /** Why a queued task waits (Q132): data the panel words, never a sentence. */
      waiting: waitingFor(task, lease),
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
        branchName: repo.branchName,
        baseBranch: repo.baseBranch,
        state: repo.state,
        headSha: repo.headSha,
        pr: repo.prNumber === null || repo.prUrl === null ? null : { number: repo.prNumber, url: repo.prUrl, state: prStateOf(repo.state) },
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
            },
      /** The agent profile the task runs with: its agent and model (task.md, the properties panel). */
      agent,
      // Ticket 36: the item's ID, so the page can answer it (`tasks.dismissNeedsYou`).
      needsYou: task.needsYouItems.map((item) => ({ id: needsYouItemIdSchema.parse(item.id), reason: item.reason, audience: item.audience, approvalId: item.approvalId, summary: item.summary })),
      ...extras,
      capabilities: {
        send: isDriver && sessionGoing && (state === "running" || state === "needs_you"),
        interrupt: isDriver && sessionGoing && state === "running",
        answerApprovals: state === "needs_you" || state === "running",
        takeOver: !isDriver,
        stop: state !== "stopped" && state !== "merged" && state !== "done" && state !== "in_review" && !endedByLimitOrCrash,
        /** Any member who can read the project may reopen: stopped, in review, done, or needing a reopen. */
        reopen: reopenState && reopenBlocked === null,
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
   * Reopens a task (F-032, F-033): any member who can read the project, from stopped, in review, done
   * or needing a reopen. The same `clientMessageId` twice is applied once. `text` may be left out only
   * for the one-click reopen from a limit or a crash; a merged task is refused until F-066.
   */
  reopen: taskProcedure("read", reopenTaskInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    // A task at its spend cap stays stopped until the cap is raised (F-068, ticket 19).
    const spendCap = { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap };
    const result = await db.$transaction((tx) => reopenTask({ tx, scope: ctx.scope, ...ports, spendCap }, input));
    const reopened = unwrap(result, {
      "not-found": "NOT_FOUND",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
    });
    return { sessionId: reopened.sessionId };
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
   * order or the send is refused. Sending the same `clientMessageId` again is applied once.
   */
  send: taskProcedure(
    "read",
    z.strictObject({
      taskId: taskIdSchema,
      clientMessageId: clientMessageIdSchema,
      text: z.string().trim().min(1).max(runnerLimits.steerTextMaxChars),
      delivery: z.enum(["queue", "interrupt"]).default("queue"),
    }),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
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
      if (lifecycle.status.state === "needs_you") {
        const moved = transitionTask(lifecycle, { type: "member_acted", boxWarm: true });
        if (moved.ok) {
          await tx.task.update({ where: { id: task.id }, data: taskToColumns(moved.state) });
        }
      }
      if (input.delivery === "interrupt") {
        await appendServerEvent(tx, { organizationId, projectId, taskId: input.taskId, sessionId, at: now, event: { kind: "turn.cancel_requested", memberId: ctx.scope.memberId } });
      }
      const seq = await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: input.taskId,
        sessionId,
        at: now,
        event: {
          kind: "user.message",
          memberId: ctx.scope.memberId,
          clientMessageId: input.clientMessageId,
          text: input.text,
          delivery: input.delivery === "interrupt" ? "after-interrupt" : "queued",
        },
      });
      await ports.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
        kind: "steer",
        body: { sessionId, clientMessageId: input.clientMessageId, text: input.text, delivery: input.delivery },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: input.taskId, projectId },
      });
      await ports.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: input.taskId });
      return { seq, duplicate: false as const };
    });
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

/** The lease and the session a send, an interrupt or an answer goes through. */
const activeLeaseAndSession = async (tx: Tx, taskId: string) => {
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId, state: "active" }, select: { runnerId: true, epoch: true } }),
    tx.session.findFirst({ where: { taskId, state: { in: ["starting", "running", "waiting", "idle"] } }, select: { id: true } }),
  ]);
  return { lease, session };
};

// ---------- approvals ----------

export const approvalsRouter = router({
  /**
   * Answers an approval (F-026): any member who can open the project may. The first answer wins,
   * through a compare-and-set on the approval, and a second member gets `CONFLICT`. The answer is a
   * committed event and an audit entry, and a command to the runner holding the task's lease.
   */
  answer: memberProcedure
    .input(z.strictObject({ approvalId: approvalIdSchema, decision: approvalDecisionSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const found = await db.approval.findFirst({ where: { id: input.approvalId, organizationId }, select: { taskId: true, projectId: true } });
      if (found === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      }
      const projectId = projectIdSchema.parse(found.projectId);
      await loadProjectAccess(db, ctx.scope, projectId, "read").catch(() => {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such approval" });
      });
      return db.$transaction(async (tx) => {
        const task = await lockTask(tx, taskIdSchema.parse(found.taskId), organizationId);
        if (task === null) {
          throw notFoundTask();
        }
        const approval = await tx.approval.findUniqueOrThrow({ where: { id: input.approvalId } });
        const options = z.array(approvalOptionSchema).safeParse(approval.options);
        const option = options.success ? options.data.find((candidate) => candidate.decision === input.decision) : undefined;
        if (option === undefined) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The agent offered no such option" });
        }
        // The compare-and-set: of two members answering at once, one row update matches.
        const won = await tx.approval.updateMany({
          where: { id: approval.id, state: "open" },
          data: { state: "answered", decision: input.decision, optionId: option.optionId, answeredByMemberId: ctx.scope.memberId, resolvedAt: new Date(ports.clock.now()) },
        });
        if (won.count !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "Someone answered this first" });
        }
        const now = ports.clock.now();
        const sessionId = sessionIdSchema.parse(approval.sessionId);
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId: taskIdSchema.parse(task.id),
          sessionId,
          at: now,
          event: { kind: "approval.answered", approvalId: approvalIdSchema.parse(approval.id), optionId: optionIdSchema.parse(option.optionId), decision: input.decision, memberId: ctx.scope.memberId },
        });
        await resolveNeedsYouItemsInTx(ports, tx, { approvalId: approval.id }, { state: "answered", at: new Date(now), byMemberId: ctx.scope.memberId });
        // A deny ends the agent's turn, and the runner cancels the session's other pending requests
        // and reports each as `approval.closed`: that kind is the runner's to write, so the other
        // approvals close when its events are saved (ADR 0036, ticket 25), not here.
        const lifecycle = lifecycleOf(task);
        if (lifecycle.status.state === "needs_you") {
          const moved = transitionTask(lifecycle, { type: "member_acted", boxWarm: true });
          if (moved.ok) {
            await tx.task.update({ where: { id: task.id }, data: taskToColumns(moved.state) });
          }
        }
        const { lease } = await activeLeaseAndSession(tx, task.id);
        if (lease !== null) {
          await ports.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
            kind: "approval-answer",
            body: { sessionId, approvalId: approvalIdSchema.parse(approval.id), decision: input.decision },
            notAfter: now + runnerLimits.offerTimeoutMs,
            task: { taskId: taskIdSchema.parse(task.id), projectId },
          });
        }
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "approval.answered",
          entity: "approval",
          entityId: input.approvalId,
          data: { decision: input.decision },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskIdSchema.parse(task.id) });
        return { approvalId: input.approvalId, decision: input.decision };
      });
    }),
});
