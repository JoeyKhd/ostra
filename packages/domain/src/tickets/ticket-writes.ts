import type { DbEnum, Prisma, Tx } from "@ostra/db";
import { organizationIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { BoardId, OrganizationId, RepoId, TaskId, TicketWriteId } from "@ostra/protocol";

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
  | { readonly kind: "pr-opened"; readonly repoId: RepoId; readonly url: string }
  | { readonly kind: "pr-merged"; readonly repoId: RepoId; readonly changedAt: number }
  | { readonly kind: "pr-closed"; readonly repoId: RepoId; readonly changedAt: number }
  | { readonly kind: "pr-reopened"; readonly repoId: RepoId; readonly changedAt: number }
  /**
   * The comment shows something new: a reopen, an idle box, a stop, a crash, any move of the task.
   * `revision` names what it shows, such as `idle:<boxId>:<n>`: the same revision writes once.
   */
  | { readonly kind: "progress"; readonly reason: "reopened" | "idle" | "stopped" | "crashed" | "state"; readonly revision: string }
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
        { step: { kind: "link_pr", repoId: trigger.repoId }, payload: { kind: "link_pr", repoId: trigger.repoId, url: trigger.url } },
        // Its key is the task's: only the first PR moves the ticket to in review.
        { step: { kind: "move", target: "in-review" }, payload: { kind: "move", target: "in-review" } },
        { step: { kind: "comment_update", revision: `pr-opened:${trigger.repoId}` }, payload: { kind: "comment_update", markdown: summary("a PR opened") } },
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
  const board = await deps.tx.board.findFirst({ where: { id: boardId, projectId: task.projectId }, select: { id: true, statusMap: true } });
  if (board === null) {
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
  const prs = input.pullRequests.filter((pr) => pr.url !== "");
  if (prs.length > 0) {
    lines.push("", ...prs.map((pr) => `- ${pr.repo}: ${pr.url} (${prWords(pr.state)})`));
  }
  lines.push("", `${PROGRESS_COMMENT_MARKER} ${input.taskUrl}</sub>`);
  return lines.join("\n");
};
