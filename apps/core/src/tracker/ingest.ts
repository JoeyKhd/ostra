import type { Logger, Ticket } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { boardsOnSameTeam, enqueueIntakeMatchesInTx, ingestTicketHint, markTicketRemovedInTx, recordTicketsClosed, upsertTicketCacheInTx } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, TicketClosedDeps } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { boardIdSchema, connectionIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId, OrganizationId } from "@ostra/protocol";

import type { WebhookHandler } from "../webhooks/process.ts";
import type { ConnectionTrackers } from "./connections.ts";

// Tickets in (F-005, F-010, F-042, F-044, ticket 14). Two ways a ticket change reaches the cache:
// - a webhook (`webhook.process` → `trackerWebhookHandler`): the delivery is a hint; the ticket is
//   read through the adapter and upserted on every board of the connection that holds it;
// - polling (`tracker.poll-board`): a schedule per attached board, every OSTRA_TRACKER_POLL_SECONDS
//   on a `polling` connection and every OSTRA_RECONCILE_MINUTES on a `webhooks` one, as the drift
//   check. It lists tickets updated since the board's cursor minus 2 min of overlap, oldest change
//   first, a page per transaction, and moves the cursor after each page commits, so a restart, or a
//   cut in the middle of a page, picks up from the cursor and stores nothing twice.
// Every call goes through the connection's rate budget, in its adapter's plumbing (ticket 15).
//
// Logs carry the connection, the board, counts and keys' absence, never ticket text.

/** A poll asks from the cursor minus this much, so a change committed late on the tracker isn't skipped. */
export const POLL_OVERLAP_MS = 2 * 60_000;

/** Pages one poll reads at most; the next tick carries on from the cursor. */
const MAX_PAGES_PER_POLL = 20;
const PAGE_SIZE = 50;

/**
 * A webhook connection whose last webhook is this much older than a change polling found is
 * flagged "webhooks silent since …" (never switched to polling on its own).
 */
export const WEBHOOKS_SILENT_AFTER_MS = 10 * 60_000;

export type TrackerIngestDeps = {
  readonly db: Db;
  readonly trackers: ConnectionTrackers;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Milestone 3 (F-066, ticket 24): what a ticket closed while its task runs needs, to interrupt
   * the turn and raise `ticket_closed`. Without it, a closed ticket only updates the cache.
   */
  readonly closed?: Omit<TicketClosedDeps, "db" | "notices" | "clock">;
  /** Milestone 6 (F-011, ticket 11): the queue `intake.match` is sent on with each upsert. Without it, no rule sees a change. */
  readonly jobs?: JobQueue;
};

/** The tickets a read moved to done or cancelled: each running task on one hears it. */
const tellRunningTasks = async (deps: TrackerIngestDeps, organizationId: OrganizationId, ticketIds: readonly string[]): Promise<void> => {
  if (deps.closed === undefined || ticketIds.length === 0) {
    return;
  }
  const told = await recordTicketsClosed({ db: deps.db, notices: deps.notices, clock: deps.clock, ...deps.closed }, { organizationId, ticketIds });
  if (told.raised > 0) {
    deps.logger.info("ticket.closed-while-running", { tasks: told.raised, interrupted: told.interrupted });
  }
};

/** `webhook.process`'s handler for a tracker connection: the hint, then the read and the upsert. */
export const trackerWebhookHandler =
  (deps: TrackerIngestDeps): WebhookHandler =>
  async (context) => {
    const lookup = await deps.trackers.forConnection(context.organizationId, context.connectionId);
    if (!lookup.ok) {
      return lookup.reason === "not-active" || lookup.reason === "not-found" || lookup.reason === "unsupported"
        ? { outcome: "failed", reason: `the connection can't read tickets: ${lookup.message}` }
        : Promise.reject(new Error(lookup.message));
    }
    const tracker = lookup.value;
    const hint = tracker.tracker.parseWebhook({ body: context.payload, ownUserId: tracker.ownUserId });
    if (!hint.ok) {
      return { outcome: "ignored", reason: "the delivery could not be read as a hint" };
    }
    if (hint.value.subject === "other" || (hint.value.ticketExternalId === null && hint.value.ticketKey === null)) {
      return { outcome: "ignored", reason: `not about a ticket (${hint.value.event.slice(0, 64)})`, ticketKey: hint.value.ticketKey };
    }
    const ingested = await ingestTicketHint(
      { db: deps.db, tracker, notices: deps.notices, clock: deps.clock, ...(deps.jobs === undefined ? {} : { jobs: deps.jobs }) },
      { source: "webhook", hint: hint.value },
    );
    if (!ingested.ok) {
      // A rate limit or a tracker that didn't answer: the job retries, with its backoff.
      throw new Error(ingested.message);
    }
    const key = ingested.ticketIds.length === 0 ? hint.value.ticketKey : await keyOf(deps.db, ingested.ticketIds[0] ?? null);
    context.logger.info("ticket.ingested", { outcome: ingested.outcome, rows: ingested.ticketIds.length, event: hint.value.event });
    // A ticket closed by someone else (never ostra's own write: that's `own-echo`) while its task runs.
    if (ingested.outcome === "upserted") {
      await tellRunningTasks(deps, context.organizationId, ingested.closedTicketIds ?? []);
    }
    switch (ingested.outcome) {
      case "upserted":
      case "removed":
        return { outcome: "processed", ticketKey: key };
      case "own-echo":
        return { outcome: "ignored", reason: "the connection's own change: recorded, not acted on", ticketKey: key };
      case "not-on-a-board":
        return { outcome: "ignored", reason: "the ticket is on no attached board", ticketKey: key };
      default:
        return ingested.outcome satisfies never;
    }
  };

const keyOf = async (db: Db, ticketId: string | null): Promise<string | null> =>
  ticketId === null ? null : ((await db.ticket.findUnique({ where: { id: ticketId }, select: { key: true } }))?.key ?? null);

export type PollOutcome =
  | { readonly outcome: "polled"; readonly pages: number; readonly tickets: number; readonly changed: number; readonly cursor: number | null }
  | { readonly outcome: "skipped"; readonly reason: string };

/** One poll of a board. Exported for tests; `tracker.poll-board` is its job. */
export const pollBoard = async (
  deps: TrackerIngestDeps,
  input: { readonly organizationId: OrganizationId; readonly boardId: BoardId },
  options: { readonly pageSize?: number; readonly maxPages?: number } = {},
): Promise<PollOutcome> => {
  const { db } = deps;
  const board = await db.board.findFirst({
    where: { id: input.boardId, organizationId: input.organizationId },
    select: { id: true, externalId: true, pollCursor: true, detachedAt: true, connectionId: true, connection: { select: { webhookMode: true, lastEventAt: true } } },
  });
  if (board === null) {
    return { outcome: "skipped", reason: "no such board" };
  }
  if (board.detachedAt !== null) {
    return { outcome: "skipped", reason: "the board is detached" };
  }
  const lookup = await deps.trackers.forConnection(input.organizationId, connectionIdSchema.parse(board.connectionId));
  if (!lookup.ok) {
    return { outcome: "skipped", reason: lookup.message };
  }
  const { tracker } = lookup.value;
  const teamBoards = await boardsOnSameTeam(db, boardIdSchema.parse(board.id));
  let cursor = board.pollCursor?.getTime() ?? null;
  const since = cursor === null ? undefined : cursor - POLL_OVERLAP_MS;
  let pageCursor: string | undefined;
  let pages = 0;
  let tickets = 0;
  let changed = 0;
  let newestChange = 0;
  for (; pages < (options.maxPages ?? MAX_PAGES_PER_POLL); ) {
    const page = await tracker.listTickets({
      board: { externalId: board.externalId },
      order: "updatedAt",
      pageSize: options.pageSize ?? PAGE_SIZE,
      ...(since === undefined ? {} : { updatedSince: since }),
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    if (!page.ok) {
      if (pages === 0) {
        throw new Error(`the tracker could not be listed (${page.error.code})`);
      }
      break;
    }
    pages += 1;
    const listed: readonly Ticket[] = page.value.tickets;
    // One transaction per page: the copies, then the cursor, which moves only as far as this page.
    const closedHere: string[] = [];
    const pageChanged = await db.$transaction(async (tx) => {
      let count = 0;
      for (const ticket of listed) {
        const upserted = await upsertTicketCacheInTx(tx, teamBoards, ticket);
        count += upserted.changed;
        // Milestone 6 (F-011): intake rules see the change in the page's transaction.
        if (deps.jobs !== undefined) {
          await enqueueIntakeMatchesInTx({ jobs: deps.jobs }, tx, upserted.changedTicketIds);
        }
        closedHere.push(...upserted.closed);
        // A ticket listed here that a copy on another team's board holds has moved: marked there.
        const others = await tx.ticket.findMany({
          where: { connectionId: board.connectionId, externalId: ticket.externalId, board: { externalId: { not: board.externalId } }, removedAt: null },
          select: { boardId: true },
        });
        if (others.length > 0) {
          await markTicketRemovedInTx(tx, others.map((row) => row.boardId), ticket.externalId, new Date(deps.clock.now()), { key: ticket.key });
        }
      }
      const last = listed.reduce((max, ticket) => Math.max(max, ticket.updatedAt), cursor ?? 0);
      await tx.board.update({
        where: { id: board.id },
        data: { lastPolledAt: new Date(deps.clock.now()), ...(listed.length === 0 ? {} : { pollCursor: new Date(last) }) },
      });
      if (count > 0) {
        for (const projectId of new Set(teamBoards.map((teamBoard) => teamBoard.projectId))) {
          const project = projectIdSchema.parse(projectId);
          await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: project, entity: "project", entityId: project });
        }
      }
      if (listed.length > 0) {
        cursor = last;
      }
      return count;
    });
    await tellRunningTasks(deps, input.organizationId, closedHere);
    tickets += listed.length;
    changed += pageChanged;
    for (const ticket of listed) newestChange = Math.max(newestChange, ticket.updatedAt);
    if (page.value.nextCursor === null) break;
    pageCursor = page.value.nextCursor;
  }
  await db.board.update({ where: { id: board.id }, data: { lastPollChanged: changed } });
  if (changed > 0) {
    // The panel's "last event received" covers what polling brought too.
    await db.connection.updateMany({
      where: { id: board.connectionId, OR: [{ lastEventAt: null }, { lastEventAt: { lt: new Date(deps.clock.now()) } }] },
      data: { lastEventAt: new Date(deps.clock.now()) },
    });
  }
  // The drift check found changes the webhooks never brought: flag it, never switch modes on its own.
  if (board.connection.webhookMode === "webhooks" && changed > 0 && since !== undefined) {
    const lastWebhook = await db.webhookDelivery.findFirst({ where: { connectionId: board.connectionId }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } });
    const lastWebhookAt = lastWebhook?.receivedAt.getTime() ?? 0;
    if (newestChange - lastWebhookAt > WEBHOOKS_SILENT_AFTER_MS) {
      await db.connection.updateMany({
        where: { id: board.connectionId, webhooksSilentSince: null },
        data: { webhooksSilentSince: new Date(lastWebhookAt === 0 ? newestChange : lastWebhookAt) },
      });
      deps.logger.warn("tracker.webhooks-silent", { organizationId: input.organizationId, connectionId: board.connectionId, boardId: board.id });
    }
  }
  return { outcome: "polled", pages, tickets, changed, cursor };
};

/** `tracker.poll-board`. */
export const pollBoardHandler =
  (deps: TrackerIngestDeps): JobHandler<"tracker.poll-board"> =>
  async (context) => {
    const outcome = await pollBoard(deps, context.payload);
    context.logger.info("tracker.polled", outcome.outcome === "polled" ? { pages: outcome.pages, tickets: outcome.tickets, changed: outcome.changed } : { skipped: outcome.reason });
  };

/** A cron for a period: every N minutes, at least one (pg-boss's cron has minutes, not seconds). */
export const cronEveryMinutes = (minutes: number): string => {
  const whole = Math.max(1, Math.round(minutes));
  return whole === 1 ? "* * * * *" : whole < 60 ? `*/${String(whole)} * * * *` : `0 */${String(Math.min(23, Math.round(whole / 60)))} * * *`;
};

export type PollScheduleDeps = {
  readonly db: Db;
  readonly jobs: Pick<Jobs, "schedule" | "unschedule">;
  /** OSTRA_TRACKER_POLL_SECONDS: a `polling` connection's boards. */
  readonly pollSeconds: number;
  /** OSTRA_RECONCILE_MINUTES: a `webhooks` connection's boards, as the drift check. */
  readonly reconcileMinutes: number;
  readonly logger: Logger;
};

/**
 * Makes a schedule for every attached board and drops the schedules of detached ones (the panel is
 * enqueue-only and can't make schedules). Remembers what it made in `known`, so a tick that changes
 * nothing costs one query.
 */
export const createPollSchedules = (deps: PollScheduleDeps) => {
  const known = new Map<string, string>();
  return {
    ensure: async (): Promise<{ readonly scheduled: number; readonly dropped: number }> => {
      const boards = await deps.db.board.findMany({
        select: { id: true, organizationId: true, connectionId: true, detachedAt: true, connection: { select: { webhookMode: true, state: true, kind: true } } },
      });
      let scheduled = 0;
      let dropped = 0;
      for (const board of boards) {
        const wanted =
          board.detachedAt === null && board.connection.kind === "linear" && board.connection.state !== "revoked"
            ? cronEveryMinutes(board.connection.webhookMode === "polling" ? deps.pollSeconds / 60 : deps.reconcileMinutes)
            : null;
        const had = known.get(board.id);
        if (wanted !== null && had !== wanted) {
          await deps.jobs.schedule(
            "tracker.poll-board",
            board.id,
            wanted,
            { organizationId: organizationIdSchema.parse(board.organizationId), boardId: boardIdSchema.parse(board.id) },
          );
          known.set(board.id, wanted);
          scheduled += 1;
        } else if (wanted === null && had !== "none") {
          await deps.jobs.unschedule("tracker.poll-board", board.id);
          known.set(board.id, "none");
          dropped += 1;
        }
      }
      if (scheduled + dropped > 0) {
        deps.logger.info("tracker.poll-schedules", { scheduled, dropped });
      }
      return { scheduled, dropped };
    },
  };
};
