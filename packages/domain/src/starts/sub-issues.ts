import type { BoardRef, TicketContext } from "@ostra/adapter-sdk";

import { boardIdSchema, connectionIdSchema, externalTicketIdSchema, projectIdSchema, ticketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { AgentProfileId, BoardId, ConnectionId, ExternalTicketId, MemberId, OrganizationId, ProjectId, TaskId, TicketId, TicketKey } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { attachedBoardWhere, boardStateOf, isBoardAttached } from "../lifecycles/m11-trackers.ts";
import { ingestTicketHintBody } from "../tickets/ticket-cache.ts";
import type { ConnectionTracker } from "../use-cases/tracker-connections.ts";
import type { StartTaskOptions } from "../use-cases/m6-signatures.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { leavesToStart } from "./start-task.ts";
import type { Leaves, TicketTree } from "./start-task.ts";
import { startTask } from "./start-task-body.ts";
import type { StartPorts } from "./start-task-body.ts";

// Sub-issues (F-077, F-031, ADR 0056, Q213; milestone 6's ticket 12). A code start on a ticket with
// open sub-issues starts its leaves instead: the open tickets without open children of their own,
// down to `OSTRA_SUB_ISSUES_DEPTH` levels, that are cached on one of the project's boards (a child
// not yet cached is read and upserted first), one task each through the one start (so each goes
// through the one-active-task index), with `parentTicketId` set. Over `OSTRA_SUB_ISSUES_MAX`
// leaves, nothing starts. The parent never gets a code task: `startTask` refuses one while the
// cache holds an open child of it. The parent keeps one progress comment that lists its children,
// edited in place as they move (milestone 2's tracker writer). A ticket's text is data throughout.

/** `OSTRA_SUB_ISSUES_MAX`'s and `OSTRA_SUB_ISSUES_DEPTH`'s defaults. */
export const SUB_ISSUES_MAX_DEFAULT = 50;
export const SUB_ISSUES_DEPTH_DEFAULT = 3;

/** The tracker of a connection, or `null` when it can't be read now. */
export type TrackerFor = (organizationId: OrganizationId, connectionId: ConnectionId) => Promise<ConnectionTracker | null>;

export type SubIssueDeps = StartPorts &
  Pick<StartTaskOptions, "publicUrl"> & {
    readonly trackerFor: TrackerFor;
    /** `OSTRA_SUB_ISSUES_MAX`. */
    readonly subIssuesMax?: number;
    /** `OSTRA_SUB_ISSUES_DEPTH`. */
    readonly subIssuesDepth?: number;
  };

/** What happened to one leaf. */
export type LeafOutcome =
  | { readonly key: TicketKey; readonly state: "started"; readonly taskId: TaskId }
  | { readonly key: TicketKey; readonly state: "skipped"; readonly reason: "has-task"; readonly taskId: TaskId }
  | { readonly key: TicketKey; readonly state: "failed"; readonly reason: string };

export type StartSubIssuesResult = UseCaseResult<
  {
    /** Always `null`: each leaf starts in its own transaction here, as a bulk start's item would. */
    readonly bulkStartId: null;
    readonly leaves: Leaves;
    /** One per leaf `leaves` lists to start, in its order. */
    readonly outcomes: readonly LeafOutcome[];
  },
  "forbidden" | "not-found" | "tracker-failed"
>;

type ProjectBoard = { readonly id: string; readonly externalId: string; readonly connectionId: string };

/**
 * The parent's tree, read through `getTicketContext` to `depth` levels below it, each child mapped
 * to its cached row on one of the project's boards. A child no board of the project caches is read
 * and upserted first; one that still isn't on a board is a leaf on none. Its own children aren't read.
 */
const readTree = async (
  deps: Pick<SubIssueDeps, "db" | "notices" | "clock" | "jobs">,
  tracker: ConnectionTracker,
  boards: readonly ProjectBoard[],
  root: { readonly externalId: ExternalTicketId; readonly key: TicketKey; readonly board: BoardRef },
  depth: number,
): Promise<{ readonly ok: true; readonly tree: TicketTree } | { readonly ok: false; readonly message: string }> => {
  const boardIds = boards.map((board) => board.id);
  const cachedOn = async (externalId: ExternalTicketId) =>
    deps.db.ticket.findFirst({ where: { externalId, boardId: { in: boardIds }, removedAt: null }, select: { boardId: true }, orderBy: { createdAt: "asc" } });
  const node = async (at: { readonly externalId: ExternalTicketId; readonly key: TicketKey; readonly board: BoardRef; readonly boardId: BoardId | null }, level: number): Promise<TicketTree | string> => {
    const context = await tracker.tracker.getTicketContext(at.board, { externalId: at.externalId });
    if (!context.ok) {
      return `the tracker could not be read (${context.error.code})`;
    }
    const children: TicketTree[] = [];
    const value: TicketContext = context.value;
    for (const child of value.children) {
      if (!child.open) {
        children.push({ externalId: child.externalId, key: child.key, open: false, boardId: null, children: [] });
        continue;
      }
      let cached = await cachedOn(child.externalId);
      if (cached === null) {
        // A child not cached yet: read and upserted like any ticket change, then looked up again.
        const read = await ingestTicketHintBody(
          { db: deps.db, tracker, notices: deps.notices, clock: deps.clock, jobs: deps.jobs },
          {
            source: "webhook",
            hint: { event: "ostra:sub-issue", subject: "ticket", action: "update", ticketExternalId: child.externalId, ticketKey: child.key, boardExternalId: null, byOwnUser: false },
          },
        );
        if (!read.ok) {
          return read.message;
        }
        cached = await cachedOn(child.externalId);
      }
      const boardId = cached === null ? null : boardIdSchema.parse(cached.boardId);
      const board = boards.find((candidate) => candidate.id === boardId);
      if (board === undefined || level + 1 > depth) {
        // On no board of the project (its children aren't read), or below the last level read.
        children.push({ externalId: child.externalId, key: child.key, open: true, boardId, children: level + 1 > depth && board !== undefined ? await openChildrenOf(child.externalId, board) : [] });
        continue;
      }
      const sub = await node({ externalId: child.externalId, key: child.key, board: { externalId: board.externalId }, boardId }, level + 1);
      if (typeof sub === "string") {
        return sub;
      }
      children.push(sub);
    }
    return { externalId: at.externalId, key: at.key, open: true, boardId: at.boardId, children };
  };
  /** Below the last level: only whether it has open children, so the walk can say it's too deep. */
  const openChildrenOf = async (externalId: ExternalTicketId, board: ProjectBoard): Promise<TicketTree[]> => {
    const context = await tracker.tracker.getTicketContext({ externalId: board.externalId }, { externalId });
    return context.ok
      ? context.value.children.filter((child) => child.open).map((child) => ({ externalId: child.externalId, key: child.key, open: true, boardId: null, children: [] }))
      : [];
  };
  const tree = await node({ ...root, boardId: null }, 0);
  return typeof tree === "string" ? { ok: false, message: tree } : { ok: true, tree };
};

/**
 * "Start" on a parent ticket (F-077): its open leaves on the project's boards, one task each, with
 * the member as each one's starter and the parent as its `parentTicketId`. `leaves` says what was
 * found: `no-children` (the caller starts the ticket itself), `over-limit` (nothing started), or the
 * leaves with the children skipped (on no board of the project, or too deep). Asking again starts
 * nothing twice: a leaf with its task is `skipped: has-task`.
 */
export const startSubIssues = async (
  deps: SubIssueDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly ticketId: TicketId; readonly agentProfileId: AgentProfileId | null },
): Promise<StartSubIssuesResult> => {
  const organizationId = scope.organizationId;
  const project = await deps.db.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const projectId = projectIdSchema.parse(project.id);
  const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "You may not start a task in this project" };
  }
  const parent = await deps.db.ticket.findFirst({
    where: { id: input.ticketId, projectId, organizationId, removedAt: null },
    select: { id: true, externalId: true, key: true, connectionId: true, board: { select: { externalId: true, detachedAt: true, connection: { select: { state: true } } } } },
  });
  if (parent === null || boardStateOf(parent.board, parent.board.connection).state === "detached") {
    return { ok: false, error: "not-found", message: "No such ticket in this project" };
  }
  // A paused board's tickets start nothing (ADR 0071): its connection isn't active.
  if (!isBoardAttached(parent.board, parent.board.connection)) {
    return { ok: false, error: "tracker-failed", message: "The ticket's board is paused: its tracker connection isn't connected" };
  }
  const tracker = await deps.trackerFor(organizationId, connectionIdSchema.parse(parent.connectionId));
  if (tracker === null) {
    return { ok: false, error: "tracker-failed", message: "The ticket's tracker can't be read now" };
  }
  if (!tracker.tracker.capabilities.subIssues) {
    return { ok: true, bulkStartId: null, leaves: { ok: false, reason: "no-children" }, outcomes: [] };
  }
  const boards = await deps.db.board.findMany({ where: { organizationId, projectId, ...attachedBoardWhere }, select: { id: true, externalId: true, connectionId: true } });
  const read = await readTree(
    deps,
    tracker,
    boards.filter((board) => board.connectionId === parent.connectionId),
    { externalId: externalTicketIdSchema.parse(parent.externalId), key: ticketKeySchema.parse(parent.key), board: { externalId: parent.board.externalId } },
    deps.subIssuesDepth ?? SUB_ISSUES_DEPTH_DEFAULT,
  );
  if (!read.ok) {
    return { ok: false, error: "tracker-failed", message: read.message };
  }
  const leaves = leavesToStart(read.tree, new Set(boards.map((board) => boardIdSchema.parse(board.id))), deps.subIssuesDepth ?? SUB_ISSUES_DEPTH_DEFAULT, deps.subIssuesMax ?? SUB_ISSUES_MAX_DEFAULT);
  if (!leaves.ok) {
    return { ok: true, bulkStartId: null, leaves, outcomes: [] };
  }
  const memberId: MemberId = scope.memberId;
  const outcomes: LeafOutcome[] = [];
  for (const leaf of leaves.start) {
    // Each leaf in its own transaction, as a bulk start's item: one leaf's refusal leaves the others started.
    const outcome = await deps.db.$transaction(async (tx): Promise<LeafOutcome> => {
      const row = await tx.ticket.findUniqueOrThrow({ where: { boardId_externalId: { boardId: leaf.boardId, externalId: leaf.externalId } }, select: { id: true } });
      const started = await startTask(
        { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, scope, ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }) },
        {
          organizationId,
          projectId,
          origin: { kind: "sub-issue", memberId, parentTicketId: ticketIdSchema.parse(parent.id) },
          kind: "code",
          ticketId: ticketIdSchema.parse(row.id),
          prompt: null,
          title: null,
          agentProfileId: input.agentProfileId,
          poolLabels: [],
        },
      );
      if (started.ok) {
        return { key: leaf.key, state: "started", taskId: started.taskId };
      }
      return started.error === "ticket-has-active-task" ? { key: leaf.key, state: "skipped", reason: "has-task", taskId: started.taskId } : { key: leaf.key, state: "failed", reason: started.error };
    });
    outcomes.push(outcome);
  }
  return { ok: true, bulkStartId: null, leaves, outcomes };
};
