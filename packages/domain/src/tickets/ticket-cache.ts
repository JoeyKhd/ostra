import type { BoardRef, Ticket as TrackerTicket, TicketRef } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { externalTicketIdSchema, organizationIdSchema, projectIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BoardId, ExternalTicketId, TicketId, TicketKey } from "@ostra/protocol";

import type { IngestTicketHint, IngestTicketHintResult } from "../use-cases/tickets.ts";
import { attachedBoardWhere } from "../lifecycles/m11-trackers.ts";
import { updateTicketSearchEntries } from "../search/entries.ts";
import { enqueueIntakeMatchesInTx } from "../automations/intake-enqueue.ts";
import { isOpenCategory } from "./contracts.ts";

// The ticket cache (F-010, F-042, F-044, ticket 14): ostra's copy of each ticket per board, keyed by
// the board and the tracker's stable ID, never by the key, which changes when a ticket moves team.
// A webhook is only a hint: the ticket is read through the adapter, and the copy upserted from
// that read. A copy is never moved backwards: an older read than the one held changes nothing.
// A ticket that left the board's team, or is gone, keeps its row (its tasks keep their links) and
// gets `removedAt`. Ticket text is untrusted: stored as data, never logged.

/** A board of the connection, as the cache writes it. */
export type CacheBoard = { readonly id: string; readonly organizationId: string; readonly projectId: string; readonly connectionId: string; readonly externalId: string };

const columnsOf = (ticket: TrackerTicket) => ({
  key: ticket.key,
  title: ticket.title,
  description: ticket.description,
  statusId: ticket.status.id,
  statusName: ticket.status.name,
  statusCategory: ticket.status.category,
  priority: ticket.priority,
  labels: [...ticket.labels],
  parentExternalId: ticket.parentExternalId,
  url: ticket.url,
  // An adapter that doesn't say (`undefined`) is kept as no assignee.
  assigneeId: ticket.assignee?.id ?? null,
  assigneeName: ticket.assignee?.name ?? null,
  // Milestone 6 (F-011): the tracker's own project, which an intake rule's filter can name. An
  // adapter that doesn't say is kept as none.
  trackerProjectId: ticket.trackerProject?.id ?? null,
  trackerProjectName: ticket.trackerProject?.name ?? null,
  open: isOpenCategory(ticket.status.category),
  trackerUpdatedAt: new Date(ticket.updatedAt),
  removedAt: null,
});

/**
 * Upserts the ticket's copy on each board, in the caller's transaction. A copy holding a newer read
 * is left alone, unless it was marked removed (the ticket came back). Answers the rows' IDs and
 * whether any changed, and (milestone 3, F-066) the rows this read moved to a `done` or `cancelled`
 * category from an open one, which a task running on them hears.
 */
export const upsertTicketCacheInTx = async (
  tx: Tx,
  boards: readonly CacheBoard[],
  ticket: TrackerTicket,
): Promise<{
  readonly ticketIds: readonly TicketId[];
  readonly changed: number;
  readonly closed: readonly TicketId[];
  /** Milestone 6 (F-011): the rows this read created or changed, which intake rules are matched against. */
  readonly changedTicketIds: readonly TicketId[];
}> => {
  const ticketIds: TicketId[] = [];
  const changedTicketIds: TicketId[] = [];
  const closed: TicketId[] = [];
  let changed = 0;
  const columns = columnsOf(ticket);
  for (const board of boards) {
    const where = { boardId_externalId: { boardId: board.id, externalId: ticket.externalId } };
    const select = { id: true, trackerUpdatedAt: true, removedAt: true, statusCategory: true } as const;
    let existing = await tx.ticket.findUnique({ where, select });
    if (existing === null) {
      // Milestone 6 (F-012): two readers can make the same copy at once (a delegation and its
      // ticket's own webhook). The second's insert waits for the first, does nothing, and takes the
      // copy the first made, as any copy held, instead of failing on the unique key and retrying.
      const created = await tx.ticket.createManyAndReturn({
        data: [
          {
            organizationId: board.organizationId,
            projectId: board.projectId,
            boardId: board.id,
            connectionId: board.connectionId,
            externalId: ticket.externalId,
            ...columns,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      const [row] = created;
      if (row !== undefined) {
        ticketIds.push(ticketIdSchema.parse(row.id));
        changedTicketIds.push(ticketIdSchema.parse(row.id));
        changed += 1;
        continue;
      }
      existing = await tx.ticket.findUniqueOrThrow({ where, select });
    }
    ticketIds.push(ticketIdSchema.parse(existing.id));
    if (existing.trackerUpdatedAt.getTime() > ticket.updatedAt && existing.removedAt === null) {
      continue;
    }
    if (existing.trackerUpdatedAt.getTime() === ticket.updatedAt && existing.removedAt === null) {
      // The same read again (a poll's overlap, a replayed hint): nothing to write.
      continue;
    }
    await tx.ticket.update({ where: { id: existing.id }, data: columns });
    // Search (ticket 11): the ticket's tasks find it by its new key and title.
    await updateTicketSearchEntries(tx, { organizationId: organizationIdSchema.parse(board.organizationId), ticketId: existing.id, key: columns.key, title: columns.title });
    changedTicketIds.push(ticketIdSchema.parse(existing.id));
    changed += 1;
    if (!isOpenCategory(ticket.status.category) && (existing.statusCategory === null || isOpenCategory(existing.statusCategory))) {
      closed.push(ticketIdSchema.parse(existing.id));
    }
  }
  return { ticketIds, changed, closed, changedTicketIds };
};

/**
 * Marks a ticket's copies on these boards as removed from them. A ticket that moved to another
 * team keeps its rows, which take its new key, and so do their tasks. Answers the rows it marked.
 */
export const markTicketRemovedInTx = async (
  tx: Tx,
  boardIds: readonly string[],
  externalId: ExternalTicketId,
  at: Date,
  moved: { readonly key: TicketKey } | null = null,
): Promise<readonly TicketId[]> => {
  if (boardIds.length === 0) {
    return [];
  }
  const rows = await tx.ticket.findMany({ where: { boardId: { in: [...boardIds] }, externalId, removedAt: null }, select: { id: true } });
  if (rows.length > 0) {
    const ids = rows.map((row) => row.id);
    await tx.ticket.updateMany({ where: { id: { in: ids } }, data: { removedAt: at, open: false, ...(moved === null ? {} : { key: moved.key }) } });
    if (moved !== null) {
      await tx.task.updateMany({ where: { ticketId: { in: ids } }, data: { ticketKey: moved.key } });
    }
  }
  return rows.map((row) => ticketIdSchema.parse(row.id));
};

const projectsOf = (boards: readonly CacheBoard[]): readonly string[] => [...new Set(boards.map((board) => board.projectId))];

/** The connection's attached boards: never another connection's, whatever their external IDs (ADR 0071). */
const boardsOf = async (db: Db, connectionId: string): Promise<readonly CacheBoard[]> =>
  db.board.findMany({
    where: { connectionId, ...attachedBoardWhere },
    select: { id: true, organizationId: true, projectId: true, connectionId: true, externalId: true },
  });

/** `ingestTicketHint`'s body (ticket 14). */
export const ingestTicketHintBody: IngestTicketHint = async (deps, change) => {
  const { db, tracker } = deps;
  const boards = await boardsOf(db, tracker.connectionId);
  const now = new Date(deps.clock.now());

  // The ticket and the board the change names.
  let externalId: ExternalTicketId | null;
  let ownEcho = false;
  let found: { readonly team: string; readonly ticket: TrackerTicket } | null = null;
  if (change.source === "poll") {
    const board = boards.find((candidate) => candidate.id === change.boardId);
    if (board === undefined) {
      return { ok: true, outcome: "not-on-a-board", ticketIds: [], externalId: change.ticket.externalId };
    }
    externalId = change.ticket.externalId;
    found = { team: board.externalId, ticket: change.ticket };
  } else {
    const { hint } = change;
    // No echo filter without an app user (the development API key): the cache is upserted either way.
    ownEcho = hint.byOwnUser && tracker.ownUserId !== null;
    externalId = hint.ticketExternalId;
    if (externalId === null && hint.ticketKey === null) {
      return { ok: true, outcome: "not-on-a-board", ticketIds: [], externalId: null };
    }
    const held =
      externalId === null
        ? []
        : await db.ticket.findMany({ where: { connectionId: tracker.connectionId, externalId }, select: { board: { select: { externalId: true } } } });
    // The hint's board first, then the boards that hold a copy: a ticket that moved team is read
    // where it is now, and its old copies are marked.
    const teams = [
      ...new Set([...(hint.boardExternalId === null ? [] : [hint.boardExternalId]), ...held.map((row) => row.board.externalId), ...boards.map((board) => board.externalId)]),
    ];
    const ref: TicketRef | null = externalId !== null ? { externalId } : hint.ticketKey !== null ? { key: hint.ticketKey } : null;
    if (ref === null) {
      return { ok: true, outcome: "not-on-a-board", ticketIds: [], externalId: null };
    }
    for (const team of teams) {
      const board: BoardRef = { externalId: team };
      const read = await tracker.tracker.getTicket(board, ref);
      if (read.ok) {
        found = { team, ticket: read.value };
        break;
      }
      if (read.error.code === "rate-limited") {
        return { ok: false, error: "rate-limited", message: "the tracker's rate limit: try again later" };
      }
      if (read.error.code !== "not-found") {
        return { ok: false, error: "tracker-failed", message: `the tracker could not be read (${read.error.code})` };
      }
    }
    if (found === null) {
      // Gone, or on no board ostra can see: its copies stay, marked removed.
      if (externalId === null) {
        return { ok: true, outcome: "not-on-a-board", ticketIds: [], externalId: null };
      }
      const gone = externalId;
      const removed = await db.$transaction(async (tx) => {
        const ids = await markTicketRemovedInTx(tx, boards.map((board) => board.id), gone, now);
        for (const projectId of projectsOf(boards)) {
          await notifyInTx(deps, tx, boards, projectId);
        }
        return ids;
      });
      return { ok: true, outcome: removed.length > 0 ? "removed" : "not-on-a-board", ticketIds: removed, externalId: gone };
    }
    externalId = found.ticket.externalId;
  }

  const ticket = found.ticket;
  const onTeam = boards.filter((board) => board.externalId === found.team);
  const elsewhere = boards.filter((board) => board.externalId !== found.team);
  const result = await db.$transaction(async (tx) => {
    const upserted = await upsertTicketCacheInTx(tx, onTeam, ticket);
    // Milestone 6 (F-011): intake rules see the change in the same transaction; ostra's own echo isn't acted on.
    if (deps.jobs !== undefined && !ownEcho) {
      await enqueueIntakeMatchesInTx({ jobs: deps.jobs }, tx, upserted.changedTicketIds);
    }
    // A ticket that moved to a team no board of this connection holds: its old copies are marked.
    const removed = await markTicketRemovedInTx(tx, elsewhere.map((board) => board.id), ticket.externalId, now, { key: ticket.key });
    if (upserted.changed > 0 || removed.length > 0) {
      for (const projectId of projectsOf([...onTeam, ...elsewhere])) {
        await notifyInTx(deps, tx, boards, projectId);
      }
    }
    return { upserted, removed };
  });
  if (onTeam.length === 0) {
    const outcome: IngestTicketHintResult = { ok: true, outcome: result.removed.length > 0 ? "removed" : "not-on-a-board", ticketIds: result.removed, externalId };
    return outcome;
  }
  return {
    ok: true,
    outcome: ownEcho ? "own-echo" : "upserted",
    ticketIds: result.upserted.ticketIds,
    externalId: externalTicketIdSchema.parse(ticket.externalId),
    ...(result.upserted.closed.length === 0 ? {} : { closedTicketIds: result.upserted.closed }),
  };
};

/** A change notice for a project whose Inbox changed: its project's record. */
const notifyInTx = async (deps: Parameters<IngestTicketHint>[0], tx: Tx, boards: readonly CacheBoard[], projectId: string): Promise<void> => {
  const board = boards.find((candidate) => candidate.projectId === projectId);
  if (board === undefined) return;
  const project = projectIdSchema.parse(projectId);
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(board.organizationId), projectId: project, entity: "project", entityId: project });
};

/** The boards a poll of `boardId` upserts on: every attached board of the connection on the same team. */
export const boardsOnSameTeam = async (db: Db, boardId: BoardId): Promise<readonly CacheBoard[]> => {
  const board = await db.board.findUnique({ where: { id: boardId }, select: { connectionId: true, externalId: true } });
  if (board === null) return [];
  return db.board.findMany({
    where: { connectionId: board.connectionId, externalId: board.externalId, ...attachedBoardWhere },
    select: { id: true, organizationId: true, projectId: true, connectionId: true, externalId: true },
  });
};
