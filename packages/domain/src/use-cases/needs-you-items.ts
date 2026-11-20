import type { Db, DbEnum, Tx } from "@ostra/db";
import { needsYouItemIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { NeedsYouItemId, OrganizationId } from "@ostra/protocol";

import type { NotificationKind } from "../notifications/choices.ts";
import type { ChangeNotices, Clock, JobQueue } from "../ports.ts";

// The one place that writes a needs-you item (F-036, ADR 0050, ADR 0011). Every creation, answer
// and dismissal goes through these functions, which enqueue `notify.fanout` in the caller's
// transaction, keyed by the item and the change, so no item changes without its notifications being
// owed, and no notification is owed for a change that didn't commit. A test fails when any other
// file writes the table (`needs-you-writers.test.ts`).

/**
 * The notification a needs-you reason sends (ADR 0050): the reason of the same name, except that a
 * ready draft PR is `pr_ready`. Reasons with no moment of their own (a round cap, a reviewer's wait,
 * an environment proposal, a restore conflict, an unstorable event, files left outside the repos)
 * notify nobody in milestone 3: their item shows in the panel, and fan-out writes nothing for it.
 */
export const notificationKindOfReason = (reason: DbEnum.NeedsYouReason): NotificationKind | null => {
  switch (reason) {
    case "question":
    case "approval":
    case "plan":
    case "no_changes":
    case "stalled":
    case "spend_cap":
    case "crashed":
    case "setup_failed":
    case "ticket_closed":
      return reason;
    case "draft_ready":
      return "pr_ready";
    case "round_cap":
    case "waiting_for_reviewer":
    case "environment_proposal":
    case "restore_conflict":
    case "unstorable_event":
    case "files_outside_repos":
    // Milestone 4 (F-135): shown to the organization's admins in needs-you, with no mail of its own.
    case "no_provider_for_model":
    // Milestone 5 (F-091): the join sends its own runner notices to the admins (ticket 12), so the
    // item adds no second one.
    case "runner_awaiting_approval":
    // Milestone 6 (F-040): an outside task's approval. Its `task_approval` notice comes with the
    // notification kinds of the adapter SDK (milestone 6's ticket 04) and ticket 14.
    case "awaiting_approval":
      return null;
    default:
      return reason satisfies never;
  }
};

/** What changed about an item: the key of its fan-out job. */
export type ItemChange = "created" | "answered" | "dismissed";

/** Enqueues the fan-out of one item's change, in the caller's transaction. Idempotent by its key. */
export const enqueueNotifyFanoutInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly itemId: NeedsYouItemId; readonly change: ItemChange },
): Promise<void> => {
  await deps.jobs.enqueueInTx(tx, "notify.fanout", {
    organizationId: input.organizationId,
    needsYouItemId: input.itemId,
    notificationId: null,
    change: input.change,
  });
};

export type NewNeedsYouItem = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: DbEnum.NeedsYouReason;
  readonly audience: DbEnum.NeedsYouAudience;
  readonly summary?: string | null;
  readonly approvalId?: string | null;
  readonly questionId?: string | null;
  readonly planTurnId?: string | null;
};

/**
 * Whether a new item of this reason supersedes the task's open one of the same reason (2026-11-20).
 * A moment about where the task stands (a turn's end, a limit, a crash, a closed ticket, a draft, a
 * round cap, a reviewer's wait, a proposal, an outside task's approval to run, what sits beside the
 * task) has one open item per task, the newest: a task that ends three turns without changes needs
 * you once, with the last summary.
 * An approval, a question and a plan each wait on their own request's answer, and a runner's
 * approval on its runner's, so they stack.
 */
const supersedesOpen = {
  no_changes: true,
  stalled: true,
  spend_cap: true,
  crashed: true,
  setup_failed: true,
  ticket_closed: true,
  draft_ready: true,
  round_cap: true,
  waiting_for_reviewer: true,
  environment_proposal: true,
  restore_conflict: true,
  unstorable_event: true,
  files_outside_repos: true,
  no_provider_for_model: true,
  // F-040: a task from outside has one approval to run, so the newer request stands.
  awaiting_approval: true,
  question: false,
  approval: false,
  plan: false,
  runner_awaiting_approval: false,
} satisfies Record<DbEnum.NeedsYouReason, boolean>;

const isSupersedeReason = (value: string): value is DbEnum.NeedsYouReason => value in supersedesOpen;

/** The reasons a new item supersedes, from the record above: one open item per task each. */
export const supersedingReasons: readonly DbEnum.NeedsYouReason[] = Object.entries(supersedesOpen).flatMap(([reason, supersedes]) =>
  supersedes && isSupersedeReason(reason) ? [reason] : [],
);

/**
 * Creates an item and owes its fan-out, in the caller's transaction. A reason that supersedes
 * (`supersedesOpen`) first dismisses the task's open item of that reason, by ostra, its fan-out owed
 * so its notifications close too; the new item is the new moment, with its own notifications.
 */
export const createNeedsYouItemInTx = async (deps: { readonly jobs: JobQueue }, tx: Tx, item: NewNeedsYouItem): Promise<NeedsYouItemId> => {
  if (supersedesOpen[item.reason]) {
    await resolveNeedsYouItemsInTx(deps, tx, { taskId: item.taskId, reason: item.reason }, { state: "dismissed", at: new Date(), byMemberId: null });
  }
  const row = await tx.needsYouItem.create({
    data: {
      organizationId: item.organizationId,
      projectId: item.projectId,
      taskId: item.taskId,
      reason: item.reason,
      audience: item.audience,
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      ...(item.approvalId === undefined ? {} : { approvalId: item.approvalId }),
      ...(item.questionId === undefined ? {} : { questionId: item.questionId }),
      ...(item.planTurnId === undefined ? {} : { planTurnId: item.planTurnId }),
    },
    select: { id: true },
  });
  const itemId = needsYouItemIdSchema.parse(row.id);
  await enqueueNotifyFanoutInTx(deps, tx, { organizationId: organizationIdSchema.parse(item.organizationId), itemId, change: "created" });
  return itemId;
};

/** Which open items an answer or a dismissal closes. At least one field narrows it. */
export type OpenItemsWhere = {
  readonly id?: string;
  readonly taskId?: string;
  readonly approvalId?: string;
  readonly questionId?: string;
  readonly reason?: DbEnum.NeedsYouReason;
  readonly reasonIn?: readonly DbEnum.NeedsYouReason[];
  readonly reasonNotIn?: readonly DbEnum.NeedsYouReason[];
};

export type ItemResolution = {
  readonly state: "answered" | "dismissed";
  readonly at: Date;
  /** `null` when ostra itself resolved it (a file moved, a restore conflict cleared). */
  readonly byMemberId: string | null;
};

/**
 * Answers or dismisses the open items that match, and owes each one's fan-out, in the caller's
 * transaction. Returns the IDs it closed; an item already closed by another is left as it is.
 */
export const resolveNeedsYouItemsInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  where: OpenItemsWhere,
  resolution: ItemResolution,
): Promise<readonly NeedsYouItemId[]> => {
  const open = await tx.needsYouItem.findMany({
    where: {
      state: "open",
      ...(where.id === undefined ? {} : { id: where.id }),
      ...(where.taskId === undefined ? {} : { taskId: where.taskId }),
      ...(where.approvalId === undefined ? {} : { approvalId: where.approvalId }),
      ...(where.questionId === undefined ? {} : { questionId: where.questionId }),
      ...(where.reason === undefined ? {} : { reason: where.reason }),
      ...(where.reasonIn === undefined ? {} : { reason: { in: [...where.reasonIn] } }),
      ...(where.reasonNotIn === undefined ? {} : { reason: { notIn: [...where.reasonNotIn] } }),
    },
    select: { id: true, organizationId: true },
  });
  const closed: NeedsYouItemId[] = [];
  for (const item of open) {
    // The compare-and-set: of two writers closing one item, one update matches.
    const won = await tx.needsYouItem.updateMany({
      where: { id: item.id, state: "open" },
      data: { state: resolution.state, resolvedAt: resolution.at, resolvedByMemberId: resolution.byMemberId },
    });
    if (won.count !== 1) {
      continue;
    }
    const itemId = needsYouItemIdSchema.parse(item.id);
    await enqueueNotifyFanoutInTx(deps, tx, { organizationId: organizationIdSchema.parse(item.organizationId), itemId, change: resolution.state });
    closed.push(itemId);
  }
  return closed;
};

/**
 * Hands a task's open driver items to the project's members, as when its driver is removed from the
 * organization (ADR 0053, F-002): the task is driven by nobody, so whoever can open the project
 * answers. Not a new moment: it enqueues nothing, and the items show in the project's members'
 * needs-you at once. Returns how many it handed over.
 */
export const handDriverItemsToProjectInTx = async (tx: Tx, taskId: string): Promise<number> => {
  const handed = await tx.needsYouItem.updateMany({ where: { taskId, state: "open", audience: "driver" }, data: { audience: "project_members" } });
  return handed.count;
};

// ---------- an item never outlives its reason ----------

/** The task states nothing waits in (domain-model.md, "A task's lifecycle"): stopped, merged and done. */
export const endedTaskStates = ["stopped", "merged", "done"] as const satisfies readonly DbEnum.TaskState[];

const ENDED: ReadonlySet<DbEnum.TaskState> = new Set(endedTaskStates);

/** Whether a task in this state has ended, so none of its items can still be waited on. */
export const isEndedTaskState = (state: DbEnum.TaskState): boolean => ENDED.has(state);

/**
 * A task that stops, merges or is done waits on nobody (domain-model.md, "When a task needs you"):
 * its open items are dismissed with it, each one's fan-out owed, in the caller's transaction, so its
 * notifications close too. `byMemberId`: the member whose action ended the task, or `null` when
 * ostra ended it. Returns the IDs it closed.
 */
export const closeItemsOfEndedTaskInTx = (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  taskId: string,
  closing: { readonly at: Date; readonly byMemberId: string | null },
): Promise<readonly NeedsYouItemId[]> =>
  resolveNeedsYouItemsInTx(deps, tx, { taskId }, { state: "dismissed", at: closing.at, byMemberId: closing.byMemberId });

/**
 * Whether a member's message that starts the task's next turn answers an item of this reason
 * (F-024): the moments a turn's end raised do. An approval, a question and a plan wait on their own
 * answer; a restore conflict, files left outside the repos and an unstorable event sit beside the
 * task until dismissed; a reviewer's wait ends with its review; the admins' items wait on an admin.
 */
const answeredByNextTurn = {
  no_changes: true,
  stalled: true,
  spend_cap: true,
  crashed: true,
  setup_failed: true,
  ticket_closed: true,
  draft_ready: true,
  round_cap: true,
  question: false,
  approval: false,
  plan: false,
  waiting_for_reviewer: false,
  environment_proposal: false,
  restore_conflict: false,
  unstorable_event: false,
  files_outside_repos: false,
  no_provider_for_model: false,
  runner_awaiting_approval: false,
  awaiting_approval: false,
} satisfies Record<DbEnum.NeedsYouReason, boolean>;

const isReason = (value: string): value is DbEnum.NeedsYouReason => value in answeredByNextTurn;

/** The reasons a new turn answers, from the record above. */
export const nextTurnAnswers: readonly DbEnum.NeedsYouReason[] = Object.entries(answeredByNextTurn).flatMap(([reason, answers]) =>
  answers && isReason(reason) ? [reason] : [],
);

/**
 * A member's message moved the task out of needs you into its next turn: what that turn answers
 * closes, answered by the member, in the caller's transaction. Returns the IDs it closed.
 */
export const answerNextTurnItemsInTx = (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  taskId: string,
  answer: { readonly at: Date; readonly byMemberId: string },
): Promise<readonly NeedsYouItemId[]> =>
  resolveNeedsYouItemsInTx(deps, tx, { taskId, reasonIn: nextTurnAnswers }, { state: "answered", at: answer.at, byMemberId: answer.byMemberId });

/** How many tasks one pass of the clean-up reads at a time. */
const STALE_BATCH = 200;

type CleanupDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
};

/**
 * One task's share of the clean-up, in its own transaction, under its row's lock and read again,
 * so what changed meanwhile is seen. The task's page hears of what it closed. Returns how many.
 */
const cleanTaskUnderLock = (
  deps: CleanupDeps,
  taskId: string,
  work: (tx: Tx, state: DbEnum.TaskState) => Promise<readonly NeedsYouItemId[]>,
): Promise<number> =>
  deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${taskId} FOR UPDATE`;
    const task = await tx.task.findUnique({ where: { id: taskId }, select: { state: true, organizationId: true, projectId: true } });
    if (task === null) {
      return 0;
    }
    const ids = await work(tx, task.state);
    if (ids.length > 0) {
      await deps.notices.emitInTx(tx, {
        organizationId: organizationIdSchema.parse(task.organizationId),
        projectId: projectIdSchema.parse(task.projectId),
        entity: "task",
        entityId: taskIdSchema.parse(taskId),
      });
    }
    return ids.length;
  });

/** The items left open on tasks that already ended; a task reopened meanwhile keeps its items. */
const closeItemsOfEndedTasks = async (deps: CleanupDeps): Promise<number> => {
  let closed = 0;
  for (;;) {
    const stale = await deps.db.needsYouItem.findMany({
      where: { state: "open", task: { state: { in: [...endedTaskStates] } } },
      distinct: ["taskId"],
      select: { taskId: true },
      take: STALE_BATCH,
    });
    let pass = 0;
    for (const { taskId } of stale) {
      pass += await cleanTaskUnderLock(deps, taskId, (tx, state) =>
        isEndedTaskState(state) ? closeItemsOfEndedTaskInTx(deps, tx, taskId, { at: new Date(deps.clock.now()), byMemberId: null }) : Promise.resolve([]),
      );
    }
    closed += pass;
    // Done when nothing is left, or when a pass closed nothing (every task found was reopened meanwhile).
    if (stale.length < STALE_BATCH || pass === 0) {
      return closed;
    }
  }
};

/**
 * The older open items of a superseding reason (`supersedesOpen`) on one task, as releases before
 * the rule left them: the newest stays open, and the rest are dismissed by ostra.
 */
const dismissSupersededItems = async (deps: CleanupDeps): Promise<number> => {
  let closed = 0;
  for (;;) {
    const doubled = await deps.db.needsYouItem.groupBy({
      by: ["taskId", "reason"],
      where: { state: "open", reason: { in: [...supersedingReasons] } },
      having: { id: { _count: { gt: 1 } } },
      orderBy: [{ taskId: "asc" }, { reason: "asc" }],
      take: STALE_BATCH,
    });
    let pass = 0;
    for (const { taskId, reason } of doubled) {
      pass += await cleanTaskUnderLock(deps, taskId, async (tx) => {
        const open = await tx.needsYouItem.findMany({ where: { taskId, reason, state: "open" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
        const at = new Date(deps.clock.now());
        const dismissed: NeedsYouItemId[] = [];
        for (const older of open.slice(1)) {
          dismissed.push(...(await resolveNeedsYouItemsInTx(deps, tx, { id: older.id }, { state: "dismissed", at, byMemberId: null })));
        }
        return dismissed;
      });
    }
    closed += pass;
    // Done when nothing is left, or when a pass closed nothing (another writer collapsed them meanwhile).
    if (doubled.length < STALE_BATCH || pass === 0) {
      return closed;
    }
  }
};

/**
 * Closes what older releases left open: the items on tasks that already ended (and any a late
 * writer raises after the end), and the older duplicates of a superseding reason on one task, the
 * newest kept. Core runs it once at start and in the daily clean-up. Each task in its own
 * transaction, under its row's lock. Each close owes its fan-out. Returns how many items it closed.
 */
export const closeStaleNeedsYouItems = async (deps: CleanupDeps): Promise<number> => {
  const ended = await closeItemsOfEndedTasks(deps);
  const superseded = await dismissSupersededItems(deps);
  return ended + superseded;
};

/** Rewrites an open item's summary. Not a moment: it enqueues nothing. */
export const setNeedsYouSummaryInTx = async (tx: Tx, itemId: string, summary: string): Promise<void> => {
  await tx.needsYouItem.update({ where: { id: itemId }, data: { summary } });
};
