import type { DbEnum, Tx } from "@ostra/db";
import { organizationIdSchema, taskIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { JobQueue } from "../ports.ts";

// A parent ticket's side of sub-issues (F-077, F-031, F-064; milestone 6's ticket 12), kept apart
// from the start so the ticket writes and the start both import it without a cycle: how a start
// knows a parent from the cache, the parent's one progress comment (its writes, its keys and its
// text) and the parent's acceptance criteria in a child's prompt.

/** The open children of a ticket that ostra's cache holds: how a start knows a parent without the tracker. */
export const openCachedChildrenInTx = (tx: Pick<Tx, "ticket">, ticket: { readonly connectionId: string; readonly externalId: string }): Promise<number> =>
  tx.ticket.count({ where: { connectionId: ticket.connectionId, parentExternalId: ticket.externalId, open: true, removedAt: null } });

// ---------- the parent's progress comment (F-031, F-077) ----------

/** The parent's one comment: made once, whichever child's start comes first. */
export const parentCommentKey = (parentTicketId: string): string => `ticket-write:parent:${parentTicketId}:comment`;

/** Each edit of the parent's comment, per child and what it shows: a replay of the same edit writes nothing. */
export const parentCommentUpdateKey = (parentTicketId: string, childTaskId: string, revision: string): string =>
  `ticket-write:parent:${parentTicketId}:comment-update:${childTaskId}:${revision}`.slice(0, 400);

/** Whether a ticket write is to a parent's comment (its key says so), not to the task's own ticket. */
export const isParentCommentWrite = (idempotencyKey: string): boolean => idempotencyKey.startsWith("ticket-write:parent:");

/** The page of a parent ticket in the panel: the marker the parent's comment holds. */
export const parentTicketUrlOf = (publicUrl: string, parentTicketId: string): string => `${publicUrl.replace(/\/+$/, "")}/tickets/${parentTicketId}`;

/**
 * The writes a child's change makes on its parent, in the caller's transaction: the parent's
 * comment (once) and an edit that shows the change. A task without a parent writes nothing. The
 * writer renders the comment's text from the children's state when it applies the row.
 */
export const writeParentProgressInTx = async (deps: { readonly tx: Tx; readonly jobs?: JobQueue }, input: { readonly taskId: TaskId; readonly revision: string }): Promise<number> => {
  const { tx } = deps;
  const task = await tx.task.findFirst({ where: { id: input.taskId }, select: { id: true, organizationId: true, projectId: true, parentTicketId: true } });
  if (task?.parentTicketId === null || task === null) {
    return 0;
  }
  const parent = await tx.ticket.findFirst({ where: { id: task.parentTicketId, projectId: task.projectId }, select: { id: true, boardId: true } });
  if (parent === null) {
    return 0;
  }
  const base = { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, boardId: parent.boardId, ticketId: parent.id };
  const rows = await tx.ticketWrite.createManyAndReturn({
    data: [
      { ...base, kind: "comment" satisfies DbEnum.TicketWriteKind, payload: { kind: "comment", markdown: "ostra: sub-issues" }, idempotencyKey: parentCommentKey(parent.id) },
      {
        ...base,
        kind: "comment_update" satisfies DbEnum.TicketWriteKind,
        payload: { kind: "comment_update", markdown: "ostra: a sub-issue moved" },
        idempotencyKey: parentCommentUpdateKey(parent.id, task.id, input.revision),
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  if (deps.jobs !== undefined) {
    for (const row of rows) {
      await deps.jobs.enqueueInTx(tx, "ticket.sync", { organizationId: organizationIdSchema.parse(task.organizationId), ticketWriteId: ticketWriteIdSchema.parse(row.id) });
    }
  }
  return rows.length;
};

/** The parent's comment's last line starts with this, then the parent's page: how ostra knows it. */
export const PARENT_COMMENT_MARKER = "<sub>ostra edits this comment as the sub-issues move:";

/** One child as the parent's comment lists it. */
export type ParentCommentChild = {
  readonly key: string;
  readonly taskUrl: string;
  readonly state: DbEnum.TaskState;
  readonly pullRequests: readonly string[];
};

const childStateWords = (state: DbEnum.TaskState): string => {
  switch (state) {
    case "awaiting_approval":
      return "waiting for approval";
    case "queued":
      return "queued";
    case "preparing":
    case "running":
      return "working";
    case "needs_you":
      return "waiting for a person";
    case "in_review":
      return "in review";
    case "merged":
      return "merged";
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    default:
      return state satisfies never;
  }
};

/**
 * The parent's comment: one line per child with its task's state and its PRs, then the marker line
 * with the parent's page. Keys, states and URLs only: no ticket text, no agent output.
 */
export const renderParentProgressComment = (input: { readonly parentUrl: string; readonly children: readonly ParentCommentChild[] }): string => {
  const lines = [`**ostra is working on this ticket's sub-issues**, one task each.`, ""];
  for (const child of input.children) {
    const prs = child.pullRequests.length === 0 ? "" : ` · ${child.pullRequests.join(" · ")}`;
    lines.push(`- ${child.key}: ${childStateWords(child.state)} ([task](${child.taskUrl}))${prs}`);
  }
  lines.push("", `${PARENT_COMMENT_MARKER} ${input.parentUrl}</sub>`);
  return lines.join("\n");
};

/** The parent's children with their tasks, for its comment and its page: the newest task per child. */
export const parentChildrenOf = async (
  tx: Pick<Tx, "task">,
  input: { readonly organizationId: string; readonly parentTicketId: string; readonly publicUrl: string },
): Promise<readonly ParentCommentChild[]> => {
  const tasks = await tx.task.findMany({
    where: { organizationId: input.organizationId, parentTicketId: input.parentTicketId },
    orderBy: [{ ticketKey: "asc" }, { createdAt: "desc" }],
    select: { id: true, ticketKey: true, state: true, repos: { where: { prUrl: { not: null } }, orderBy: { createdAt: "asc" }, select: { prUrl: true } } },
  });
  const seen = new Set<string>();
  const children: ParentCommentChild[] = [];
  for (const task of tasks) {
    const key = task.ticketKey ?? task.id;
    if (seen.has(key)) continue;
    seen.add(key);
    children.push({
      key,
      taskUrl: `${input.publicUrl.replace(/\/+$/, "")}/tasks/${taskIdSchema.parse(task.id)}`,
      state: task.state,
      pullRequests: task.repos.flatMap((repo) => (repo.prUrl === null ? [] : [repo.prUrl])),
    });
  }
  return children;
};

// ---------- a child's prompt (F-064, F-077) ----------

const criteriaSchema = z.array(z.string()).catch([]);

/**
 * The parent's acceptance criteria, for a child's prompt: from the parent's accepted refine draft
 * (the latest version a member applied to the ticket or marked ready). Empty without one.
 */
export const parentCriteriaOf = async (
  tx: Pick<Tx, "refineDraft">,
  input: { readonly organizationId: string; readonly parentTicketId: string | null },
): Promise<readonly { readonly text: string }[]> => {
  if (input.parentTicketId === null) {
    return [];
  }
  const draft = await tx.refineDraft.findFirst({
    where: { organizationId: input.organizationId, task: { ticketId: input.parentTicketId, kind: "refine" }, OR: [{ appliedAt: { not: null } }, { readyAt: { not: null } }] },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    select: { acceptanceCriteria: true },
  });
  return draft === null ? [] : criteriaSchema.parse(draft.acceptanceCriteria).map((text) => ({ text }));
};

