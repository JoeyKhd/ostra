import type { TransitionTaken } from "@ostra/adapter-sdk";
import type { DbEnum, Prisma, Tx } from "@ostra/db";
import { organizationIdSchema, taskIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { BoardId, OrganizationId, RepoId, TaskId, TicketWriteId } from "@ostra/protocol";
import { z } from "zod";

import { boardStateOf } from "../lifecycles/m11-trackers.ts";
import type { JobQueue } from "../ports.ts";
import { parseBoardMapping } from "./board-mapping.ts";
import { ticketWriteKey } from "./contracts.ts";
import type { TicketWritePayload, TicketWriteStep } from "./contracts.ts";
import { PARENT_COMMENT_MARKER, writeParentProgressInTx } from "./parent-progress.ts";

// The tracker writer's outbox (F-031, F-046, ADR 0037, ticket 15). Each step of ticket sync that a
// task's change causes is a `TicketWrite` row, written in the same transaction as the change, with
// an idempotency key fixed by the task and the step, so a replayed event finds the row instead of
// writing a second one. `ticket.sync` (core) applies each row through the tracker adapter.
//
// What each change writes:
// - the task starts: move to the board's "started", the progress comment, the task link;
// - a PR opens: link the PR, move to "in review" (the first PR only: its key is fixed), edit the
//   progress comment;
// - a PR merges: move to "done" only when the board's `doneBy` is `ostra`; edit the comment;
// - a PR closes or reopens, a reopen, an idle box, a stop, a crash: edit the progress comment;
// - "Create ticket" on a prompt task: create the ticket, which then gets the task's link.
//
// The progress comment is one comment per task, edited in place. Its text is the task's state, its
// PRs and its link (`renderProgressComment`), never the agent's output or the prompt. Core renders
// it again from the task's current state when it applies a row, so edits that apply out of order
// still leave the latest text.

/** What happened to the task, for its ticket. */
export type TicketSyncTrigger =
  /** The task started from its ticket (ticket 29's `startTicketTask`), or a prompt task got one. */
  | { readonly kind: "task-started"; readonly taskUrl: string; readonly taskTitle: string }
  /** `number`: the PR's own, so each of a repo's PRs (a new one after a merge) is linked (F-066). */
  | { readonly kind: "pr-opened"; readonly repoId: RepoId; readonly number: number; readonly url: string }
  | { readonly kind: "pr-merged"; readonly repoId: RepoId; readonly changedAt: number }
  | { readonly kind: "pr-closed"; readonly repoId: RepoId; readonly changedAt: number }
  | { readonly kind: "pr-reopened"; readonly repoId: RepoId; readonly changedAt: number }
  /**
   * The comment shows something new: a reopen, an idle box, a stop, a crash, any move of the task,
   * or (milestone 11) a ticket move that stayed put or went through after one did (`move`).
   * `revision` names what it shows, such as `idle:<boxId>:<n>`: the same revision writes once.
   */
  | { readonly kind: "progress"; readonly reason: "reopened" | "idle" | "stopped" | "crashed" | "state" | "move"; readonly revision: string }
  /** "Create ticket" on a prompt task (F-097): the board it goes on, and its text (untrusted). */
  | { readonly kind: "create-ticket"; readonly boardId: BoardId; readonly title: string; readonly description: string | null };

export type TicketWritesDeps = {
  readonly tx: Tx;
  /** Enqueues `ticket.sync` for each new row at once; without it, core's outbox drain sends them. */
  readonly jobs?: JobQueue;
};

export type WrittenTicketWrite = { readonly id: TicketWriteId; readonly kind: DbEnum.TicketWriteKind; readonly organizationId: OrganizationId };

type PlannedWrite = { readonly step: TicketWriteStep; readonly payload: TicketWritePayload };

/** The short text a comment row holds; the full text is rendered when the row is applied. */
const summary = (what: string): string => `ostra: ${what}`.slice(0, 1000);

/** The rows a trigger writes, before the board and the task are known. */
const plan = (trigger: TicketSyncTrigger, doneByOstra: boolean): readonly PlannedWrite[] => {
  switch (trigger.kind) {
    case "task-started":
      return [
        { step: { kind: "move", target: "started" }, payload: { kind: "move", target: "started" } },
        { step: { kind: "comment" }, payload: { kind: "comment", markdown: summary("started") } },
        {
          step: { kind: "link_task" },
          payload: { kind: "link_task", url: trigger.taskUrl, title: `ostra: ${trigger.taskTitle}`.slice(0, 256), subtitle: "The task on ostra" },
        },
      ];
    case "pr-opened":
      return [
        {
          step: { kind: "link_pr", repoId: trigger.repoId, prNumber: trigger.number },
          payload: { kind: "link_pr", repoId: trigger.repoId, url: trigger.url },
        },
        // Its key is the task's: only the first PR moves the ticket to in review.
        { step: { kind: "move", target: "in-review" }, payload: { kind: "move", target: "in-review" } },
        {
          step: { kind: "comment_update", revision: `pr-opened:${trigger.repoId}:${String(trigger.number)}` },
          payload: { kind: "comment_update", markdown: summary("a PR opened") },
        },
      ];
    case "pr-merged":
      return [
        ...(doneByOstra ? [{ step: { kind: "move", target: "done" }, payload: { kind: "move", target: "done" } } satisfies PlannedWrite] : []),
        {
          step: { kind: "comment_update", revision: `pr-merged:${trigger.repoId}:${String(trigger.changedAt)}` },
          payload: { kind: "comment_update", markdown: summary("a PR merged") },
        },
      ];
    case "pr-closed":
      return [
        {
          step: { kind: "comment_update", revision: `pr-closed:${trigger.repoId}:${String(trigger.changedAt)}` },
          payload: { kind: "comment_update", markdown: summary("a PR closed") },
        },
      ];
    case "pr-reopened":
      return [
        {
          step: { kind: "comment_update", revision: `pr-reopened:${trigger.repoId}:${String(trigger.changedAt)}` },
          payload: { kind: "comment_update", markdown: summary("a PR reopened") },
        },
      ];
    case "progress":
      return [
        {
          step: { kind: "comment_update", revision: `${trigger.reason}:${trigger.revision}`.slice(0, 200) },
          payload: { kind: "comment_update", markdown: summary(trigger.reason) },
        },
      ];
    case "create-ticket":
      return [{ step: { kind: "create" }, payload: { kind: "create", title: trigger.title, description: trigger.description } }];
    default:
      return trigger satisfies never;
  }
};

/** A payload as the `Json` column takes it: the schema's output is plain JSON. */
const payloadJson = (payload: TicketWritePayload): Prisma.InputJsonValue => {
  switch (payload.kind) {
    case "move":
      return { kind: payload.kind, target: payload.target };
    case "comment":
    case "comment_update":
      return { kind: payload.kind, markdown: payload.markdown };
    case "link_pr":
      return { kind: payload.kind, repoId: payload.repoId, url: payload.url };
    case "link_task":
      return { kind: payload.kind, url: payload.url, title: payload.title, subtitle: payload.subtitle };
    case "create":
      return { kind: payload.kind, title: payload.title, description: payload.description };
    default:
      return payload satisfies never;
  }
};

/**
 * Writes the rows a task's change causes, in the caller's transaction. A task with no ticket (and
 * no board, for "Create ticket") writes nothing. A row whose key exists is left alone: replaying
 * the change writes nothing new. Answers the rows it wrote.
 */
export const writeTicketStepsInTx = async (
  deps: TicketWritesDeps,
  input: { readonly taskId: TaskId; readonly trigger: TicketSyncTrigger },
): Promise<readonly WrittenTicketWrite[]> => {
  const task = await deps.tx.task.findFirst({
    where: { id: input.taskId },
    select: { id: true, organizationId: true, projectId: true, ticketId: true, boardId: true },
  });
  if (task === null) {
    return [];
  }
  const { trigger } = input;
  const boardId = trigger.kind === "create-ticket" ? (task.ticketId === null ? trigger.boardId : null) : task.ticketId === null ? null : task.boardId;
  if (boardId === null) {
    return [];
  }
  const board = await deps.tx.board.findFirst({
    where: { id: boardId, projectId: task.projectId },
    select: { id: true, statusMap: true, detachedAt: true, connection: { select: { state: true } } },
  });
  // A paused board's ticket isn't written (ADR 0071): nothing moves on a tracker whose connection
  // isn't active. A detached board's tasks keep their ticket, and its sync.
  if (board === null || boardStateOf(board, board.connection).state === "paused") {
    return [];
  }
  const doneByOstra = parseBoardMapping(board.statusMap)?.doneBy === "ostra";
  const planned = plan(trigger, doneByOstra);
  if (planned.length === 0) {
    return [];
  }
  const rows = await deps.tx.ticketWrite.createManyAndReturn({
    data: planned.map((write) => ({
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      boardId: board.id,
      ticketId: write.payload.kind === "create" ? null : task.ticketId,
      kind: write.payload.kind,
      payload: payloadJson(write.payload),
      idempotencyKey: ticketWriteKey(input.taskId, write.step),
    })),
    skipDuplicates: true,
    select: { id: true, kind: true, organizationId: true },
  });
  const written = rows.map((row) => ({
    id: ticketWriteIdSchema.parse(row.id),
    kind: row.kind,
    organizationId: organizationIdSchema.parse(task.organizationId),
  }));
  if (deps.jobs !== undefined) {
    for (const row of written) {
      await deps.jobs.enqueueInTx(deps.tx, "ticket.sync", { organizationId: row.organizationId, ticketWriteId: row.id });
    }
  }
  // Milestone 6 (F-077): a sub-issue's change edits its parent's comment too, once per change.
  const edits = planned.filter((write) => write.step.kind === "comment_update" || write.step.kind === "comment");
  for (const write of edits) {
    await writeParentProgressInTx(deps, { taskId: input.taskId, revision: write.step.kind === "comment_update" ? write.step.revision : "started" });
  }
  return written;
};

/**
 * The progress comment edit for a task that just moved (`moveTaskInTx` calls it): one row per move,
 * its revision the move's ordinal among the task's edits. A task with no ticket writes nothing.
 */
export const recordTicketProgressInTx = async (tx: Tx, taskId: TaskId, state: DbEnum.TaskState): Promise<void> => {
  const task = await tx.task.findFirst({ where: { id: taskId }, select: { ticketId: true } });
  if ((task?.ticketId ?? null) === null) {
    return;
  }
  const edits = await tx.ticketWrite.count({ where: { taskId, kind: "comment_update" } });
  await writeTicketStepsInTx({ tx }, { taskId, trigger: { kind: "progress", reason: "state", revision: `${state}:${String(edits + 1)}` } });
};

// ---------- a move's outcome (milestone 11, F-008/c5) ----------

/** A move's transitions as `TicketWrite.via` keeps them: IDs and names. Storage: read loosely. */
const viaSchema = z.array(z.looseObject({ id: z.string(), name: z.string() }));

/**
 * What a done move did on the tracker, as its row keeps it: `moved`, with the transitions it took
 * in `via` (`[]` when the ticket was already there, and on a tracker that writes statuses, such as
 * Linear); or `stays`, when no route of the ticket's workflow reaches the target (Q352): nothing was
 * written, `via` is `[]`, and the row's `error` holds `movedNot`'s line (the key and status names,
 * never content), which the progress comment shows while it's the newest move.
 */
export type TicketMoveOutcome = { readonly kind: "moved"; readonly via: readonly TransitionTaken[] } | { readonly kind: "stays"; readonly line: string };

/** The columns a done move's row keeps its outcome in. */
const moveOutcomeColumns = (outcome: TicketMoveOutcome): { readonly via: Prisma.InputJsonValue; readonly error: string | null } => {
  switch (outcome.kind) {
    case "moved":
      return { via: outcome.via.map((transition) => ({ id: transition.id, name: transition.name })), error: null };
    case "stays":
      return { via: [], error: outcome.line };
    default:
      return outcome satisfies never;
  }
};

/** A move row's outcome once it's done; `null` before, and for any other write. */
export const moveOutcomeOf = (row: {
  readonly kind: DbEnum.TicketWriteKind;
  readonly state: DbEnum.TicketWriteState;
  readonly via: unknown;
  readonly error: string | null;
}): TicketMoveOutcome | null => {
  if (row.kind !== "move" || row.state !== "done") {
    return null;
  }
  if (row.error !== null) {
    return { kind: "stays", line: row.error };
  }
  const via = viaSchema.safeParse(row.via);
  return { kind: "moved", via: via.success ? via.data.map((transition) => ({ id: transition.id, name: transition.name })) : [] };
};

/** The progress comment's line for the task's moves: the newest done move's `movedNot` line while it stays put. */
export const stayedLineInTx = async (tx: Pick<Tx, "ticketWrite">, taskId: TaskId): Promise<string | null> => {
  const newest = await tx.ticketWrite.findFirst({
    where: { taskId, kind: "move", state: "done" },
    orderBy: [{ doneAt: "desc" }, { id: "desc" }],
    select: { kind: true, state: true, via: true, error: true },
  });
  const outcome = newest === null ? null : moveOutcomeOf(newest);
  return outcome?.kind === "stays" ? outcome.line : null;
};

/**
 * Marks a pending move done with its outcome (core's `ticket.sync`). When that changes what the
 * progress comment says of the moves (one that stays put, or a later one that went through), the
 * comment's edit is written in the same transaction, so the comment follows. `false` when the row
 * was no longer pending.
 */
export const settleMoveInTx = async (
  deps: TicketWritesDeps,
  input: { readonly ticketWriteId: TicketWriteId; readonly outcome: TicketMoveOutcome; readonly externalId: string | null; readonly now: number },
): Promise<boolean> => {
  const row = await deps.tx.ticketWrite.findFirst({ where: { id: input.ticketWriteId, kind: "move", state: "pending" }, select: { taskId: true } });
  if (row === null) {
    return false;
  }
  const taskId = taskIdSchema.parse(row.taskId);
  const before = await stayedLineInTx(deps.tx, taskId);
  await deps.tx.ticketWrite.update({
    where: { id: input.ticketWriteId },
    data: { state: "done", externalId: input.externalId, doneAt: new Date(input.now), attempts: { increment: 1 }, ...moveOutcomeColumns(input.outcome) },
  });
  const after = input.outcome.kind === "stays" ? input.outcome.line : null;
  if (before !== after) {
    await writeTicketStepsInTx(deps, { taskId, trigger: { kind: "progress", reason: "move", revision: input.ticketWriteId } });
  }
  return true;
};

/** "Retry sync" (F-031): the task's failed writes go back to pending, and are sent again. */
export const retryTicketSyncInTx = async (deps: { readonly tx: Tx; readonly jobs: JobQueue }, taskId: TaskId): Promise<number> => {
  const failed = await deps.tx.ticketWrite.findMany({ where: { taskId, state: "failed" }, select: { id: true, organizationId: true } });
  if (failed.length === 0) {
    return 0;
  }
  await deps.tx.ticketWrite.updateMany({ where: { id: { in: failed.map((row) => row.id) } }, data: { state: "pending", attempts: 0, error: null } });
  for (const row of failed) {
    await deps.jobs.enqueueInTx(deps.tx, "ticket.sync", {
      organizationId: organizationIdSchema.parse(row.organizationId),
      ticketWriteId: ticketWriteIdSchema.parse(row.id),
    });
  }
  return failed.length;
};

// ---------- the progress comment ----------

export type ProgressCommentInput = {
  readonly taskUrl: string;
  readonly state: DbEnum.TaskState;
  readonly stoppedReason: DbEnum.TaskStopReason | null;
  /** Each repo's PR, in the order they opened. */
  readonly pullRequests: readonly { readonly repo: string; readonly url: string; readonly state: DbEnum.TaskRepoState }[];
  /** Milestone 11 (Q352): the newest move's `movedNot` line while the ticket stays put (`stayedLineInTx`). */
  readonly stays?: string | null;
};

const stateWords = (input: ProgressCommentInput): string => {
  switch (input.state) {
    case "awaiting_approval":
      return "Waiting for approval";
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing its workspace";
    case "running":
      return "Working";
    case "needs_you":
      return "Waiting for a person on ostra";
    case "stopped":
      return input.stoppedReason === "prs_closed" ? "Stopped: its PRs were closed" : "Stopped";
    case "in_review":
      return "In review";
    case "merged":
      return "Merged";
    case "done":
      return "Done";
    default:
      return input.state satisfies never;
  }
};

const prWords = (state: DbEnum.TaskRepoState): string => {
  switch (state) {
    case "pr_open":
      return "open";
    case "merged":
      return "merged";
    case "closed_unmerged":
      return "closed unmerged";
    case "no_branch":
    case "branch_pushed":
      return "no PR";
    default:
      return state satisfies never;
  }
};

const ACTIVE: ReadonlySet<DbEnum.TaskState> = new Set(["awaiting_approval", "queued", "preparing", "running", "needs_you", "in_review"]);

/** The progress comment's last line starts with this, then the task's URL: how ostra knows its own comment. */
export const PROGRESS_COMMENT_MARKER = "<sub>ostra edits this comment as the task moves:";

/**
 * Whether a comment is an ostra task's progress comment, by its marker line. It's ostra's own
 * words, never the ticket's: a task's prompt leaves it out, as it would a comment by ostra's app
 * user (an API-key connection has none to filter by).
 */
export const isProgressComment = (body: string): boolean => body.includes(PROGRESS_COMMENT_MARKER) || body.includes(PARENT_COMMENT_MARKER);

/**
 * The progress comment's markdown: the task's state, its PRs and its link. It holds no ticket
 * text, no prompt and no agent output. The task's URL is its marker (F-046): a retry looks for a
 * comment holding it before writing another.
 */
export const renderProgressComment = (input: ProgressCommentInput): string => {
  const lines = [
    ACTIVE.has(input.state) ? `**ostra is working on this.** [Open the task](${input.taskUrl})` : `**ostra worked on this.** [Open the task](${input.taskUrl})`,
    "",
    `Status: ${stateWords(input)}`,
  ];
  if ((input.stays ?? null) !== null) {
    lines.push("", input.stays ?? "");
  }
  const prs = input.pullRequests.filter((pr) => pr.url !== "");
  if (prs.length > 0) {
    lines.push("", ...prs.map((pr) => `- ${pr.repo}: ${pr.url} (${prWords(pr.state)})`));
  }
  lines.push("", `${PROGRESS_COMMENT_MARKER} ${input.taskUrl}</sub>`);
  return lines.join("\n");
};
