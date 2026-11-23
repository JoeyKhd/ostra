import { mappedStatusId } from "@ostra/adapter-sdk";
import type { AdapterError, AdapterResult, IdempotencyStore, Logger, MoveResult, Ticket, TicketRef, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db, DbEnum } from "@ostra/db";
import {
  isParentCommentWrite,
  movedNot,
  parentChildrenOf,
  parentCommentKey,
  parentTicketUrlOf,
  parseBoardMapping,
  renderParentProgressComment,
  postgresIdempotencyStore,
  renderProgressComment,
  settleMoveInTx,
  statusMappingOf,
  stayedLineInTx,
  ticketWritePayloadSchema,
  writeTicketStepsInTx,
} from "@ostra/domain";
import type { Clock, JobQueue, TicketMoveOutcome, TicketWritePayload } from "@ostra/domain";
import { queueSettings } from "@ostra/jobs";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { connectionIdSchema, draftIdSchema, externalTicketIdSchema, organizationIdSchema, taskIdSchema, ticketKeySchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, TicketWriteId } from "@ostra/protocol";

import { z } from "zod";

import { killPoint } from "../kill-points.ts";
import type { ConnectionTrackers } from "./connections.ts";
import { hedgedCall } from "./retry.ts";

// The tracker writer (F-031, F-046, ADR 0037, ticket 15): `ticket.sync` applies one `TicketWrite`
// through the tracker adapter, with the row's idempotency key in the organization's Postgres
// store. A retry after a write that committed on the tracker but whose answer was lost finds it
// done: by the key when the answer was recorded, or by a read before writing again (the comment
// holding the task's URL, by ostra's user; the ticket whose description holds it). Each write
// stores what the tracker made (the comment's ID goes on the task the first time) and marks the
// row done. A write that keeps failing is marked `failed`, shown on the task page, and retried by
// "Retry sync"; it never blocks the task, whose state the writer never touches.
//
// Logs carry the task, the write, its kind and the error's code, never the comment's text.

export type TicketWriterDeps = {
  readonly db: Db;
  readonly trackers: ConnectionTrackers;
  readonly clock: Clock;
  /** The panel's address, for the task's link and the progress comment. */
  readonly publicUrl: string;
  readonly logger: Logger;
  /**
   * The jobs a write leads to: a prompt refine task's "Create ticket" (F-099, ticket 27) sends its
   * draft's `draft.apply` once the ticket exists. Without it, no follow-up job is sent.
   */
  readonly jobs?: Pick<JobQueue, "enqueueInTx">;
  /** The organization's idempotency store; the default is Postgres. */
  readonly idempotency?: (organizationId: OrganizationId) => IdempotencyStore;
  /**
   * Whether a retry reads the tracker before writing again. Only the F-046 control (ADR 0037) turns
   * it off, to show that without the lookup a retried write is made twice.
   */
  readonly lookupBeforeRetry?: boolean;
  /** Attempts within one run: the in-run retry's budget. */
  readonly attemptDeadlineMs?: number;
  /**
   * Milestone 11 (F-008/c8): the tracker refused the connection's saved token (401): the
   * connection fails at once and its boards pause (`failRefusedToken`), unless its credential
   * renews itself. `true` when it failed it; the write is then marked failed, for "Retry sync"
   * once the token is replaced.
   */
  readonly tokenRefused?: (input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId }) => Promise<boolean>;
};

export type ApplyOutcome =
  | { readonly outcome: "done"; readonly externalId: string | null; readonly how: "written" | "recorded" | "found" | "superseded" | "already" }
  | { readonly outcome: "retry"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/** The task's page on the panel: its link on the ticket, and the marker its comment holds. */
export const taskUrlOf = (publicUrl: string, taskId: string): string => `${publicUrl.replace(/\/+$/, "")}/tasks/${taskId}`;

/** Errors another attempt may fix. */
const retryable = (error: AdapterError): boolean => {
  switch (error.code) {
    case "rate-limited":
    case "unavailable":
    case "invalid-response":
    case "aborted":
    case "unauthorized":
      return true;
    case "forbidden":
    case "not-found":
    case "invalid-input":
    case "conflict":
    case "unsupported":
      return false;
    default:
      return error.code satisfies never;
  }
};

const words = (error: AdapterError): string => `${error.code}: ${error.message}`.slice(0, 500);

const REVIEW_LOOKBACK_MS = 2 * 60_000;

/** A PR's own state, as the progress comment words a repo's. */
const repoStateOf = (state: DbEnum.PullRequestState): DbEnum.TaskRepoState => {
  switch (state) {
    case "open":
      return "pr_open";
    case "merged":
      return "merged";
    case "closed_unmerged":
      return "closed_unmerged";
    default:
      return state satisfies never;
  }
};

/** What a write's idempotency record holds: the ID the tracker made, if any. Storage: read loosely. */
const recordedSchema = z.looseObject({ externalId: z.string().nullable() });

/** Applies one row. Exported for tests; `ticket.sync` is its job. */
export const applyTicketWrite = async (
  deps: TicketWriterDeps,
  input: { readonly organizationId: OrganizationId; readonly ticketWriteId: TicketWriteId },
): Promise<ApplyOutcome> => {
  const { db } = deps;
  const row = await db.ticketWrite.findFirst({
    where: { id: input.ticketWriteId, organizationId: input.organizationId },
    include: {
      board: { select: { id: true, externalId: true, statusMap: true, connectionId: true } },
      ticket: { select: { id: true, externalId: true, key: true, statusName: true } },
      task: { select: { id: true, title: true, progressCommentId: true } },
    },
  });
  if (row === null) {
    return { outcome: "done", externalId: null, how: "already" };
  }
  if (row.state !== "pending") {
    return { outcome: "done", externalId: row.externalId, how: "already" };
  }
  const payload = ticketWritePayloadSchema.safeParse(row.payload);
  if (!payload.success) {
    return { outcome: "failed", reason: "the write's payload can't be read" };
  }
  const taskId = taskIdSchema.parse(row.task.id);
  const taskUrl = taskUrlOf(deps.publicUrl, taskId);
  // Milestone 6 (F-077): a write to a sub-issue's parent: its one comment listing the children.
  const parentTicketId = isParentCommentWrite(row.idempotencyKey) ? row.ticketId : null;

  // An edit superseded by a newer one for the same parent: the newer renders the latest text anyway.
  if (parentTicketId !== null && payload.data.kind === "comment_update") {
    const newer = await db.ticketWrite.count({
      where: { ticketId: parentTicketId, kind: "comment_update", state: "pending", createdAt: { gt: row.createdAt }, idempotencyKey: { startsWith: "ticket-write:parent:" } },
    });
    if (newer > 0) {
      return { outcome: "done", externalId: null, how: "superseded" };
    }
  }
  // An edit superseded by a newer one for the same task: the newer renders the latest text anyway.
  if (parentTicketId === null && payload.data.kind === "comment_update") {
    const newer = await db.ticketWrite.count({ where: { taskId, kind: "comment_update", state: "pending", createdAt: { gt: row.createdAt } } });
    if (newer > 0) {
      return { outcome: "done", externalId: null, how: "superseded" };
    }
  }

  const lookup = await deps.trackers.forConnection(input.organizationId, connectionIdSchema.parse(row.board.connectionId));
  if (!lookup.ok) {
    // A connection that isn't active stops its writes, visibly: the row fails with the reason.
    return lookup.reason === "not-active" || lookup.reason === "not-found" || lookup.reason === "unsupported"
      ? { outcome: "failed", reason: `the tracker connection can't write: ${lookup.message}` }
      : { outcome: "retry", reason: lookup.message };
  }
  const { tracker, ownUserId, connectionId } = lookup.value;
  const board = { externalId: row.board.externalId };
  const ref: TicketRef | null = row.ticket === null ? null : { externalId: externalTicketIdSchema.parse(row.ticket.externalId) };
  const key = row.ticket === null ? null : ticketKeySchema.parse(row.ticket.key);

  const store = (deps.idempotency ?? ((organizationId) => postgresIdempotencyStore(db, organizationId)))(input.organizationId);
  const claim = await store.claim(row.idempotencyKey, deps.clock.now());
  if (!claim.claimed && claim.existing.state === "done") {
    // The write happened and its answer was recorded: nothing is written again.
    const recorded = recordedSchema.safeParse(claim.existing.result);
    return { outcome: "done", externalId: recorded.success ? recorded.data.externalId : null, how: "recorded" };
  }
  // A claim left pending by an attempt that died, or any earlier attempt: the tracker is read first.
  const inDoubt = !claim.claimed || row.attempts > 0;
  const lookupFirst = inDoubt && deps.lookupBeforeRetry !== false;

  const render = async (): Promise<string> => {
    // Every PR of the task (F-031): a repo's merged or closed PR stays beside the new one a reopen
    // opened (F-066, ADR 0052), in the order they opened. A PR its row doesn't hold yet comes from
    // the repo's own columns.
    const repos = await db.taskRepo.findMany({
      where: { taskId },
      orderBy: { createdAt: "asc" },
      select: {
        prUrl: true,
        state: true,
        repo: { select: { fullName: true } },
        pullRequests: { orderBy: [{ openedAt: "asc" }, { number: "asc" }], select: { url: true, state: true } },
      },
    });
    const pullRequests = repos.flatMap((repo) => {
      const kept = repo.pullRequests.map((pr) => ({ repo: repo.repo.fullName, url: pr.url, state: repoStateOf(pr.state) }));
      const current = repo.prUrl;
      return current === null || kept.some((pr) => pr.url === current) ? kept : [...kept, { repo: repo.repo.fullName, url: current, state: repo.state }];
    });
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true, stoppedReason: true } });
    // Milestone 11 (Q352): a move no route reached says so, while it's the newest move.
    return renderProgressComment({ taskUrl, state: task.state, stoppedReason: task.stoppedReason, pullRequests, stays: await stayedLineInTx(db, taskId) });
  };

  const attempt = async <T,>(call: () => Promise<AdapterResult<T>>, hedge: boolean): Promise<AdapterResult<T>> => {
    if (!hedge) {
      // A create runs once per run: a retry must read the tracker first, which a later run does.
      return call();
    }
    const { result } = await hedgedCall(call, {
      deadlineMs: deps.attemptDeadlineMs ?? 20_000,
      hedgeAfterMs: 8_000,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      retryable,
    });
    return result;
  };

  const finish = async (externalId: string | null, how: "written" | "found"): Promise<ApplyOutcome> => {
    await store.complete(row.idempotencyKey, { externalId }, deps.clock.now());
    return { outcome: "done", externalId, how };
  };
  const fail = async (error: AdapterError): Promise<ApplyOutcome> => {
    // Not done: a later attempt may claim the key again, and reads the tracker before writing.
    await store.release(row.idempotencyKey);
    // Milestone 11 (F-008/c8): a refused token fails its connection at once, and the write with it.
    if (error.code === "unauthorized" && deps.tokenRefused !== undefined && (await deps.tokenRefused({ organizationId: input.organizationId, connectionId }))) {
      return { outcome: "failed", reason: "the tracker refused the connection's token: replace it, then retry" };
    }
    return retryable(error) ? { outcome: "retry", reason: words(error) } : { outcome: "failed", reason: words(error) };
  };

  /** A move is done with its outcome on its row, and the progress comment follows when it changes what it says. */
  const settleMove = async (outcome: TicketMoveOutcome, externalId: string | null): Promise<ApplyOutcome> => {
    await store.complete(row.idempotencyKey, { externalId }, deps.clock.now());
    await db.$transaction((tx) =>
      settleMoveInTx({ tx, ...(deps.jobs === undefined ? {} : { jobs: deps.jobs }) }, { ticketWriteId: input.ticketWriteId, outcome, externalId, now: deps.clock.now() }),
    );
    return { outcome: "done", externalId, how: "written" };
  };

  const data: TicketWritePayload = payload.data;
  if (parentTicketId !== null && (data.kind === "comment" || data.kind === "comment_update")) {
    if (ref === null || key === null) return { outcome: "failed", reason: "the write has no ticket" };
    const parentUrl = parentTicketUrlOf(deps.publicUrl, parentTicketId);
    // The children's keys, states and PRs as they are now: never a ticket's text.
    const renderParent = async (): Promise<string> =>
      renderParentProgressComment({ parentUrl, children: await parentChildrenOf(db, { organizationId: input.organizationId, parentTicketId, publicUrl: deps.publicUrl }) });
    if (data.kind === "comment") {
      if (lookupFirst) {
        const found = await findOwnComment(tracker, board, ref, parentUrl, ownUserId);
        if (!found.ok) return fail(found.error);
        if (found.value !== null) return finish(found.value, "found");
      }
      const made = await attempt(async () => tracker.comment(board, key, await renderParent()), false);
      return made.ok ? finish(made.value.commentId, "written") : fail(made.error);
    }
    // The parent's comment's ID is what its `comment` row made.
    const comment = await db.ticketWrite.findUnique({ where: { idempotencyKey: parentCommentKey(parentTicketId) }, select: { state: true, externalId: true } });
    if (comment?.state === "pending") {
      await store.release(row.idempotencyKey);
      return { outcome: "retry", reason: "waiting for the parent's comment to be made" };
    }
    if (comment?.state !== "done" || comment.externalId === null) {
      return finish(null, "found");
    }
    if (!tracker.capabilities.commentEdit) {
      return finish(comment.externalId, "found");
    }
    const commentId = comment.externalId;
    const edited = await attempt(async () => tracker.updateComment(board, ref, commentId, await renderParent()), true);
    return edited.ok ? finish(commentId, "written") : fail(edited.error);
  }
  switch (data.kind) {
    case "move": {
      if (ref === null) return { outcome: "failed", reason: "the write has no ticket" };
      const mapping = parseBoardMapping(row.board.statusMap);
      if (mapping === null) {
        await store.release(row.idempotencyKey);
        return { outcome: "failed", reason: "the board has no status mapping" };
      }
      // A move is idempotent on the tracker: one already there writes nothing.
      const statuses = statusMappingOf(mapping);
      // Milestone 6 (F-099): "Mark ready" moves to the board's ready status, by the tracker's own
      // move (a Jira's transitions), as the move to "started" would with that status as its target.
      const ready = mapping.ready;
      if (data.target === "ready" && ready === undefined) {
        await store.release(row.idempotencyKey);
        return { outcome: "failed", reason: "the board has no ready status" };
      }
      const mapped = data.target === "ready" ? { target: "started" as const, statuses: { ...statuses, started: ready ?? statuses.started } } : { target: data.target, statuses };
      const moved: AdapterResult<MoveResult> = await attempt(() => tracker.moveTicket(board, ref, mapped.target, mapped.statuses), true);
      if (moved.ok) {
        // Milestone 11 (F-008/c5): the transitions it took are kept on the row, for "On Jira".
        return settleMove({ kind: "moved", via: moved.value.via }, moved.value.status.id);
      }
      if (moved.error.code !== "conflict") {
        return fail(moved.error);
      }
      // No route of the ticket's workflow reaches the target (Q352): nothing was written, the ticket
      // stays where it is, and the progress comment says so. The names come from the tracker.
      const goal = mappedStatusId(mapped.statuses, mapped.target);
      const [current, listed] = await Promise.all([tracker.getTicket(board, ref), tracker.listStatuses(board)]);
      const line = movedNot({
        key: current.ok ? current.value.key : (key ?? ref.externalId),
        from: current.ok ? current.value.status.name : (row.ticket?.statusName ?? "its status"),
        to: (listed.ok ? listed.value.find((status) => status.id === goal)?.name : undefined) ?? goal,
      });
      return settleMove({ kind: "stays", line }, null);
    }
    case "comment": {
      if (ref === null || key === null) return { outcome: "failed", reason: "the write has no ticket" };
      if (row.task.progressCommentId !== null) {
        return finish(row.task.progressCommentId, "found");
      }
      if (lookupFirst) {
        const found = await findOwnComment(tracker, board, ref, taskUrl, ownUserId);
        if (!found.ok) return fail(found.error);
        if (found.value !== null) {
          await keepCommentId(db, taskId, found.value);
          return finish(found.value, "found");
        }
      }
      const made = await attempt(async () => tracker.comment(board, key, await render()), false);
      if (!made.ok) return fail(made.error);
      await keepCommentId(db, taskId, made.value.commentId);
      return finish(made.value.commentId, "written");
    }
    case "comment_update": {
      if (ref === null || key === null) return { outcome: "failed", reason: "the write has no ticket" };
      const commentId = row.task.progressCommentId;
      if (commentId === null) {
        await store.release(row.idempotencyKey);
        const comment = await db.ticketWrite.findFirst({ where: { taskId, kind: "comment" }, select: { state: true } });
        if (comment?.state === "pending") {
          return { outcome: "retry", reason: "waiting for the progress comment to be made" };
        }
        if (comment === null) {
          // No comment yet (a task whose start wrote none): make it, with the latest text.
          await db.$transaction((tx) => writeTicketStepsInTx({ tx }, { taskId, trigger: { kind: "task-started", taskUrl, taskTitle: row.task.title } }));
        }
        return { outcome: "done", externalId: null, how: "superseded" };
      }
      if (!tracker.capabilities.commentEdit) {
        return finish(commentId, "found");
      }
      const edited = await attempt(async () => tracker.updateComment(board, ref, commentId, await render()), true);
      return edited.ok ? finish(commentId, "written") : fail(edited.error);
    }
    case "link_pr": {
      if (key === null) return { outcome: "failed", reason: "the write has no ticket" };
      const mapping = parseBoardMapping(row.board.statusMap);
      const kind = mapping?.magicWord === "Refs" ? "references" : "closes";
      // Linking the same URL again links it once (the adapter's contract).
      const linked = await attempt(() => tracker.linkPullRequest(board, key, data.url, { kind }), true);
      return linked.ok ? finish(null, "written") : fail(linked.error);
    }
    case "link_task": {
      if (ref === null) return { outcome: "failed", reason: "the write has no ticket" };
      // The task's own URL, as the panel serves it now; linking it again returns the same attachment.
      const linked = await attempt(() => tracker.linkTask(board, ref, { url: taskUrl, title: data.title, subtitle: data.subtitle }), true);
      return linked.ok ? finish(linked.value.attachmentId, "written") : fail(linked.error);
    }
    case "create": {
      const marker = `Made by ostra for ${taskUrl}`;
      if (lookupFirst) {
        const found = await findCreatedTicket(tracker, board, taskUrl, row.createdAt.getTime() - REVIEW_LOOKBACK_MS);
        if (!found.ok) return fail(found.error);
        if (found.value !== null) {
          await adoptCreatedTicket(deps, row, found.value);
          return finish(found.value.externalId, "found");
        }
      }
      const description = `${data.description ?? ""}\n\n${marker}`.trim();
      const made = await attempt(() => tracker.createTicket(board, { title: data.title, description }), false);
      if (!made.ok) return fail(made.error);
      await adoptCreatedTicket(deps, row, made.value);
      return finish(made.value.externalId, "written");
    }
    default:
      return data satisfies never;
  }
};

/** ostra's comment on the ticket: the one holding the task's URL, by ostra's own user when it's known. */
const findOwnComment = async (
  tracker: TrackerAdapter,
  board: { readonly externalId: string },
  ref: TicketRef,
  taskUrl: string,
  ownUserId: string | null,
): Promise<AdapterResult<string | null>> => {
  const context = await tracker.getTicketContext(board, ref);
  if (!context.ok) return context;
  const mine = context.value.comments.find(
    (comment) => comment.body.includes(taskUrl) && (ownUserId === null || comment.author === null || comment.author.id === ownUserId),
  );
  return { ok: true, value: mine?.id ?? null };
};

/** A ticket "Create ticket" made: the one whose description holds the task's URL, changed since the write. */
const findCreatedTicket = async (
  tracker: TrackerAdapter,
  board: { readonly externalId: string },
  taskUrl: string,
  since: number,
): Promise<AdapterResult<Ticket | null>> => {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const listed = await tracker.listTickets({ board, updatedSince: since, order: "updatedAt", pageSize: 50, ...(cursor === undefined ? {} : { cursor }) });
    if (!listed.ok) return listed;
    const found = listed.value.tickets.find((ticket) => ticket.description?.includes(taskUrl) === true);
    if (found !== undefined) return { ok: true, value: found };
    if (listed.value.nextCursor === null) break;
    cursor = listed.value.nextCursor;
  }
  return { ok: true, value: null };
};

const keepCommentId = async (db: Db, taskId: string, commentId: string): Promise<void> => {
  // The first comment's ID wins: a later one is never put in its place.
  await db.task.updateMany({ where: { id: taskId, progressCommentId: null }, data: { progressCommentId: commentId } });
};

/** The ticket "Create ticket" made: cached on its board, and the task linked to it. */
const adoptCreatedTicket = async (
  deps: TicketWriterDeps,
  row: { readonly organizationId: string; readonly projectId: string; readonly taskId: string; readonly boardId: string; readonly board: { readonly connectionId: string } },
  ticket: Ticket,
): Promise<void> => {
  await deps.db.$transaction(async (tx) => {
    const cached = await tx.ticket.upsert({
      where: { boardId_externalId: { boardId: row.boardId, externalId: ticket.externalId } },
      create: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        boardId: row.boardId,
        connectionId: row.board.connectionId,
        externalId: ticket.externalId,
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
        open: ticket.status.category === "open" || ticket.status.category === "started",
        trackerUpdatedAt: new Date(ticket.updatedAt),
      },
      update: {},
      select: { id: true },
    });
    const linked = await tx.task.updateMany({
      where: { id: row.taskId, ticketId: null },
      data: { ticketId: cached.id, ticketKey: ticket.key, boardId: row.boardId },
    });
    await tx.ticketWrite.updateMany({ where: { taskId: row.taskId, kind: "create" }, data: { ticketId: cached.id } });
    if (linked.count === 1) {
      const taskId = taskIdSchema.parse(row.taskId);
      // The new ticket gets the task's link and the progress comment, written with the link.
      await writeTicketStepsInTx({ tx }, { taskId, trigger: { kind: "task-started", taskUrl: taskUrlOf(deps.publicUrl, taskId), taskTitle: ticket.title } });
      // A refine task's draft a member sent with "Create ticket": the rest of it (its images and its
      // sub-tickets under the new ticket) goes out now, through `draft.apply`, once per version.
      const draft = await tx.refineDraft.findFirst({
        where: { taskId, organizationId: row.organizationId, appliedAt: { not: null }, task: { kind: "refine" } },
        orderBy: { version: "desc" },
        select: { id: true, version: true },
      });
      if (draft !== null && deps.jobs !== undefined) {
        await deps.jobs.enqueueInTx(tx, "draft.apply", {
          organizationId: organizationIdSchema.parse(row.organizationId),
          draftId: draftIdSchema.parse(draft.id),
          version: draft.version,
        });
      }
    }
  });
};

/** `ticket.sync`: one row, then its mark. Throws to retry; the last retry marks it failed. */
export const ticketSyncHandler =
  (deps: TicketWriterDeps): JobHandler<"ticket.sync"> =>
  async (context) => {
    const { organizationId, ticketWriteId } = context.payload;
    const logger = context.logger.child({ organizationId, ticketWriteId });
    killPoint("ticket.sync.before");
    let outcome: ApplyOutcome;
    try {
      outcome = await applyTicketWrite(deps, { organizationId, ticketWriteId });
    } catch (error) {
      outcome = { outcome: "retry", reason: error instanceof Error ? error.name : "unknown" };
    }
    const last = context.retryCount >= queueSettings["ticket.sync"].retryLimit;
    if (outcome.outcome === "done") {
      killPoint("ticket.sync.answered");
      await deps.db.ticketWrite.updateMany({
        where: { id: ticketWriteId, organizationId, state: "pending" },
        data: { state: "done", externalId: outcome.externalId, doneAt: new Date(deps.clock.now()), error: null, attempts: { increment: 1 } },
      });
      logger.info("ticket.sync.done", { how: outcome.how });
      return;
    }
    if (outcome.outcome === "failed" || last) {
      await deps.db.ticketWrite.updateMany({
        where: { id: ticketWriteId, organizationId, state: "pending" },
        data: { state: "failed", error: outcome.reason, attempts: { increment: 1 } },
      });
      logger.warn("ticket.sync.failed", { retryCount: context.retryCount });
      return;
    }
    await deps.db.ticketWrite.updateMany({ where: { id: ticketWriteId, organizationId, state: "pending" }, data: { error: outcome.reason, attempts: { increment: 1 } } });
    logger.info("ticket.sync.retry", { retryCount: context.retryCount });
    throw new Error("the ticket write will be tried again");
  };

/**
 * The outbox's drain: every pending write gets its `ticket.sync`. Writes made where no queue was at
 * hand (a task's move) are sent here; a job already queued under the row's key isn't sent twice.
 */
export const drainTicketWrites = async (deps: { readonly db: Db; readonly jobs: Pick<Jobs, "sendInTx">; readonly clock: Clock }): Promise<number> => {
  const pending = await deps.db.ticketWrite.findMany({
    where: { state: "pending", attempts: 0, createdAt: { lt: new Date(deps.clock.now() - 500) } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, organizationId: true },
  });
  let sent = 0;
  for (const row of pending) {
    const result = await deps.db.$transaction((tx) =>
      deps.jobs.sendInTx(tx, "ticket.sync", { organizationId: organizationIdSchema.parse(row.organizationId), ticketWriteId: ticketWriteIdSchema.parse(row.id) }),
    );
    if (result.kind === "enqueued") sent += 1;
  }
  return sent;
};
