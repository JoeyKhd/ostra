import type { DbEnum } from "@ostra/db";
import { modelTokenPrices, moveOutcomeOf } from "@ostra/domain";
import { blobIdSchema, boxSizeNameSchema, sessionIdSchema, ticketIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { SessionLimit } from "@ostra/protocol";
import { z } from "zod";

import { ticketConnectionOf, ticketConnectionSelect } from "../services/ticket-trackers.ts";
import type { ApiDeps } from "../trpc/context.ts";

// F-032, F-033, F-064, F-031, F-068, F-096 (ticket 30): what the task page shows beyond milestone 1's
// task: its ticket, the ticket's context files, the sync state of each write to the tracker, its
// sessions with where each came from, its box, its spend against the cap, and the limit that
// stopped it. Everything is read from the task's own rows in its organization; a ticket's text is
// untrusted and returned as data.

/**
 * The trackers the task page names (`task-ticket.tsx`'s `trackerName`, `from Linear`): Linear's and
 * GitHub's. Milestone 11's migration added the `jira` kind (its ticket 01); the task page draws
 * Jira's name and mark from its ticket 16 on (`ticket-chips.md`), and until then answers no
 * tracker for a Jira ticket, so it shows no ticket card rather than another tracker's words.
 * Milestone 11's ticket 10 built the card for every kind (its `connection`, sub-issue counts, and
 * the "On Jira" rows' `move`); the card's gate is this function alone, which ticket 16 removes in
 * the same commit as `trackerName`'s Jira case (the task page's folder is the thread build's).
 */
export const taskPageTrackerOf = (kind: DbEnum.ConnectionKind): "linear" | "github" | null => {
  switch (kind) {
    case "linear":
    case "github":
      return kind;
    case "jira":
      return null;
    default:
      return kind satisfies never;
  }
};

type TaskRow = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly ticketId: string | null;
  readonly spentMicroUsd: number;
};

type SessionRow = {
  readonly id: string;
  readonly state: string;
  readonly origin: "new" | "resumed" | "restored" | "rebuilt";
  readonly outcome: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly limitReached: "max_duration" | "stall" | "spend_cap" | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly agentProfileId: string | null;
};

/** The database's limit names (underscores) as the protocol writes them (hyphens). */
const limitOf = (limit: SessionRow["limitReached"]): SessionLimit | null => {
  switch (limit) {
    case null:
      return null;
    case "max_duration":
      return "max-duration";
    case "stall":
      return "stall";
    case "spend_cap":
      return "spend-cap";
    default:
      return limit satisfies never;
  }
};

const restoredPayload = z.looseObject({ previousBox: z.enum(["kept", "released", "lost"]).optional() });

/** Milestone 5 (F-095): the size a box was made with, or `null` where sizes don't apply. */
const sizeOf = (box: { readonly size: string | null; readonly cpuMillis: number | null; readonly memoryMiB: number | null }) => {
  const name = boxSizeNameSchema.safeParse(box.size);
  return !name.success || box.cpuMillis === null || box.memoryMiB === null ? null : { name: name.data, cpuMillis: box.cpuMillis, memoryMiB: box.memoryMiB };
};

/** How a task's box shows: `ready` holds a running turn, `idle` waits for the next one. */
const boxStateOf = (state: "creating" | "preparing" | "ready" | "idle" | "stopped" | "released" | "failed"): "starting" | "running" | "idle" | "stopped" | "released" | "failed" => {
  switch (state) {
    case "creating":
    case "preparing":
      return "starting";
    case "ready":
      return "running";
    case "idle":
    case "stopped":
    case "released":
    case "failed":
      return state;
    default:
      return state satisfies never;
  }
};

const prStateOf = (state: "no_branch" | "branch_pushed" | "pr_open" | "merged" | "closed_unmerged"): "open" | "merged" | "closed" => {
  switch (state) {
    case "merged":
      return "merged";
    case "closed_unmerged":
      return "closed";
    case "no_branch":
    case "branch_pushed":
    case "pr_open":
      return "open";
    default:
      return state satisfies never;
  }
};

export { prStateOf };

export const loadTaskExtras = async (deps: ApiDeps, task: TaskRow, profileModelId: string | null, runnerName: string | null) => {
  const { db, settings } = deps;
  const { organizationId } = task;
  const [ticket, writes, sessions, boxes, restored, filesReady] = await Promise.all([
    task.ticketId === null
      ? Promise.resolve(null)
      : db.ticket.findFirst({ where: { id: task.ticketId, organizationId }, include: { board: { select: { name: true } }, connection: { select: ticketConnectionSelect } } }),
    db.ticketWrite.findMany({ where: { taskId: task.id, organizationId }, orderBy: { createdAt: "asc" } }),
    // Oldest first, a tie by ID: the last is the newest session as a reopen and the review loop pick it.
    db.session.findMany({ where: { taskId: task.id, organizationId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] }),
    db.box.findMany({ where: { taskId: task.id, organizationId }, orderBy: { createdAt: "desc" }, take: 1 }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "session.restored" }, select: { sessionId: true, payload: true } }),
    db.event.findFirst({ where: { taskId: task.id, organizationId, kind: "ticket.files_ready" }, orderBy: { seq: "desc" }, select: { payload: true } }),
  ]);
  // The spend's unit follows the model row the newest session runs on, as ingest prices the calls
  // and the cap and a reopen read them (F-135, ADR 0065); the profile's before a session recorded one.
  const pricedModelId = sessions.at(-1)?.modelId ?? profileModelId;
  const model =
    pricedModelId === null
      ? null
      : await db.model.findFirst({ where: { id: pricedModelId, organizationId }, select: { inputPricePerMTok: true, outputPricePerMTok: true, cacheReadPricePerMTok: true, cacheWritePricePerMTok: true } });

  // The ticket's context files: the newest `ticket.files_ready` names them, the blobs say how big.
  const filesPayload = z.object({ files: z.array(z.object({ path: z.string(), blobId: z.string() })) }).safeParse(filesReady?.payload);
  const blobIds = filesPayload.success ? filesPayload.data.files.map((file) => file.blobId) : [];
  const blobs = blobIds.length === 0 ? [] : await db.blob.findMany({ where: { id: { in: blobIds }, organizationId, taskId: task.id }, select: { id: true, size: true, contentType: true } });
  const contextFiles = filesPayload.success
    ? filesPayload.data.files.flatMap((file) => {
        const blob = blobs.find((candidate) => candidate.id === file.blobId);
        return blob === undefined ? [] : [{ name: file.path, blobId: blobIdSchema.parse(file.blobId), size: blob.size, contentType: blob.contentType }];
      })
    : [];

  const previousBoxOf = new Map<string, "kept" | "released" | "lost">();
  for (const row of restored) {
    const parsed = restoredPayload.safeParse(row.payload);
    if (parsed.success && parsed.data.previousBox !== undefined) {
      previousBoxOf.set(row.sessionId, parsed.data.previousBox);
    }
  }
  const sessionViews = sessions.map((session: SessionRow) => ({
    id: sessionIdSchema.parse(session.id),
    origin: session.origin,
    state: session.state,
    outcome: session.outcome,
    startedAt: session.startedAt.getTime(),
    endedAt: session.endedAt?.getTime() ?? null,
    limit: limitOf(session.limitReached),
    /** What became of the earlier box when this session restored: kept, released, or lost. */
    previousBox: previousBoxOf.get(session.id) ?? null,
  }));
  const newest = sessions.at(-1);

  const box = boxes[0];
  const idleDue = box !== undefined && (box.state === "idle" || box.state === "ready") && box.idleSince !== null ? box.idleSince.getTime() + settings.boxIdleMinutes * 60_000 : null;

  // The cap is in dollars at the model's prices, or in tokens when it has none (spec section 11, item 8).
  const priced = model !== null && modelTokenPrices(model) !== null;
  const spendBase = priced
    ? { unit: "usd" as const, spent: task.spentMicroUsd, cap: settings.taskSpendCapMicroUsd }
    : {
        unit: "tokens" as const,
        spent: sessions.reduce((sum, session) => sum + session.inputTokens + session.outputTokens + session.cacheReadTokens + session.cacheWriteTokens, 0),
        cap: settings.taskTokenCap,
      };
  /** At the cap (`spendCapReached`): a reopen is refused until the cap is raised. */
  const spend = { ...spendBase, reached: spendBase.spent >= spendBase.cap };

  const tracker = ticket === null ? null : taskPageTrackerOf(ticket.connection.kind);
  // F-077, F-008/c6: the ticket's sub-issues (Jira's sub-tasks) in the cache, and how many are done.
  const children =
    ticket === null || tracker === null
      ? []
      : await db.ticket.groupBy({
          by: ["open"],
          where: { organizationId, connectionId: ticket.connectionId, parentExternalId: ticket.externalId, removedAt: null },
          _count: { _all: true },
        });
  return {
    ticket:
      ticket === null || tracker === null
        ? null
        : {
            id: ticketIdSchema.parse(ticket.id),
            key: ticket.key,
            title: ticket.title,
            url: ticket.url,
            status: { name: ticket.statusName, category: ticket.statusCategory },
            /** The board the ticket came in on, and its tracker's kind (task-ticket.md: `Board`, `from Linear`). */
            board: ticket.board.name,
            tracker,
            /** Milestone 11 (F-152/c4, ticket-chips.md): its tracker, the board's connection: `Jira · Globex Jira`. */
            connection: ticketConnectionOf(ticket.connection),
            /** Its sub-issues (Jira's sub-tasks) in the cache: `Sub-tasks 2 · 1 done`. */
            subIssues: {
              count: children.reduce((sum, row) => sum + row._count._all, 0),
              done: children.filter((row) => !row.open).reduce((sum, row) => sum + row._count._all, 0),
            },
            /** The strip's label chips and priority (task-ticket.md, "Ticket strip"); Linear's 1 urgent to 4 low. */
            labels: z.array(z.string()).catch([]).parse(ticket.labels),
            priority: ticket.priority,
            cachedAt: ticket.updatedAt.getTime(),
            removed: ticket.removedAt !== null,
          },
    contextFiles,
    /** Each write to the tracker and where it stands; a failed one can be retried. */
    sync: writes.map((write) => {
      // Milestone 11 (F-008/c5): a done move either went through (by the transitions in `via`) or
      // stayed put; a move that stayed keeps its `movedNot` line in `error`, which is no failure.
      const move = moveOutcomeOf(write);
      return {
      id: ticketWriteIdSchema.parse(write.id),
      kind: write.kind,
      state: write.state,
      attempts: write.attempts,
      /** Why a write failed: words and IDs, never content. A done move that stayed put has none (`move.line` says it). */
      error: move?.kind === "stays" ? null : write.error,
      /**
       * A done move's outcome for the "On Jira" rows: `moved` with the transitions taken (`[]` for a
       * tracker that writes statuses, and for a move done before milestone 11), or `stays` with the
       * progress comment's line. `null` for any other write, or a move not done yet.
       */
      move,
      createdAt: write.createdAt.getTime(),
      doneAt: write.doneAt?.getTime() ?? null,
      };
    }),
    sessions: sessionViews,
    box:
      box === undefined
        ? null
        : {
            state: boxStateOf(box.state),
            /** When the idle stop is due, while the box waits for its next turn. */
            idleStopDueAt: idleDue,
            releasedAt: box.releasedAt?.getTime() ?? null,
            releaseReason: box.releaseReason,
            runnerName,
            /** Milestone 5 (F-095): the size it was made with, or `null` where sizes don't apply. */
            size: sizeOf(box),
            /** Milestone 5 (F-093): why it's still being made, and since when (epoch ms), or `null`. */
            waiting: box.waitingReason === null || box.waitingSince === null ? null : { reason: box.waitingReason === "node" ? ("node" as const) : ("image-pull" as const), since: box.waitingSince.getTime() },
          },
    spend,
    /** The limit that stopped the newest session, if one did. */
    limit: newest === undefined ? null : limitOf(newest.limitReached),
    startedAt: sessions[0]?.startedAt.getTime() ?? null,
  };
};
