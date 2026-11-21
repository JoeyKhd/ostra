import { randomUUID } from "node:crypto";

import type { TicketContext, TicketContextFile, TicketFilesCapability } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import { canSendFiles, clientMessageIdSchema, leaseEpochSchema, memberIdSchema, messageFileIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, safeFileName, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemberId, MessageFileId, OrganizationId, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { appendMemberMessageInTx, defaultMessageFilesDeps, filesToBindInTx, steerFileFields } from "../files/message-files.ts";
import type { MessageFilesDeps, StoredTicketFile, TicketFileNote, TicketFilesToBind } from "../files/message-files.ts";
import type { FileLimits } from "../files/limits.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import {
  contextReadComments,
  contextReadLinks,
  ticketChanges,
  ticketFileSourceKey,
  ticketFilesToFetch,
  ticketReadRecordOf,
  ticketUpdatePrompt,
} from "./ticket-files.ts";
import type { TicketChanges, TicketReadRecord } from "./ticket-files.ts";

// Reading a ticket task's ticket again (F-149, ADR 0070, Q336, ticket 06): on a reopen, a member's
// "Send ticket updates", or a Retry of its failed files. The read goes through the connection's
// adapter, with its credential, in core; what changed since the last read (`TaskTicketRead`) is
// fetched (new files within the ticket's limits; for a Retry, the failed ones again), stored as
// blobs of the task with their text, and written in one transaction: a `ticket-update` message
// with the changes in marked blocks and the files as the ticket's, credited to the member, the
// next read's record and `ticket.context_read`. A reopen's goes as the new session's pending
// message after the member's own, and the dispatch follows; a press's goes as the driver's steer.
// The first read, at the task's start, is `ticket.fetch-context`'s (core, ticket 12), on the same
// pieces. The ticket's text and its files are never logged.

/** What core does for a read, with the connection's credential and its own stores. */
export type TicketReadPorts = {
  /**
   * The ticket's context through its connection's adapter, the adapter's `ticketFiles`, and the
   * connection's own user (ostra's comments are left out by it). `unavailable` retries the job.
   */
  readonly readTicket: (task: { readonly organizationId: OrganizationId; readonly taskId: TaskId }) => Promise<
    | { readonly ok: true; readonly context: TicketContext; readonly capability: TicketFilesCapability; readonly ownUserId: string | null }
    | { readonly ok: false; readonly reason: "unavailable" | "gone" }
  >;
  /** Fetches one of the ticket's files with the connection's credential, reading at most `maxBytes`. */
  readonly downloadFile: (
    task: { readonly organizationId: OrganizationId; readonly taskId: TaskId },
    url: string,
    maxBytes: number,
  ) => Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: "too-big" | "download-failed" }>;
  /** Stores a fetched file as a blob of the task (`ticket-file`), tells its kind from its bytes, and reads a document's text. */
  readonly storeFile: (
    task: { readonly organizationId: OrganizationId; readonly projectId: string; readonly taskId: TaskId },
    file: { readonly name: string; readonly bytes: Uint8Array },
  ) => Promise<Omit<StoredTicketFile, "where" | "commentId" | "sourceKey" | "retryOfId">>;
};

export type ReadTicketDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly reads: TicketReadPorts;
  /** The ticket's limits (`OSTRA_TICKET_FILES_MAX`, `_FILE_MAX_MIB`, `_FILES_TOTAL_MIB`). */
  readonly limits: FileLimits;
  /** Which agents take images; the defaults when left out. */
  readonly files?: MessageFilesDeps;
};

export type TicketReadReasonAfterStart = "reopen" | "member" | "retry";

export type ReadTicketInput = {
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly reason: TicketReadReasonAfterStart;
  /** The member the update is credited to: the reopener, or the driver who pressed. */
  readonly memberId: MemberId;
};

/**
 * What the read did: `sent` a message (as a steer, or a pending message the dispatch carries),
 * `nothing-new` (no message), and for a reopen whether it sent the dispatch.
 */
export type ReadTicketResult = UseCaseResult<
  { readonly outcome: "sent" | "nothing-new"; readonly round: number | null; readonly dispatched: boolean; readonly steered: boolean },
  "not-found" | "not-a-ticket-task"
>;

/** Thrown so the queue retries: the tracker didn't answer, and nothing was written. */
export const TICKET_READ_UNAVAILABLE = "the tracker didn't answer; the read retries";

const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

const recordSchema = z.object({
  descriptionSha256: z.string(),
  comments: z.array(z.object({ id: z.string(), updatedAt: z.number() })),
  fileKeys: z.array(z.string()),
});

/** The last read's record and round, or `null` before the first. */
const lastReadOf = async (tx: Pick<Tx, "taskTicketRead">, taskId: TaskId): Promise<{ readonly round: number; readonly record: TicketReadRecord } | null> => {
  const row = await tx.taskTicketRead.findFirst({ where: { taskId }, orderBy: { round: "desc" } });
  if (row === null) {
    return null;
  }
  const record = recordSchema.safeParse({ descriptionSha256: row.descriptionSha256, comments: row.comments, fileKeys: row.fileKeys });
  return { round: row.round, record: record.success ? record.data : { descriptionSha256: row.descriptionSha256, comments: [], fileKeys: [] } };
};

/** One of the ticket's files fetched, stored or not: a stored file, or a note of why not. */
const fetchFiles = async (
  deps: ReadTicketDeps,
  task: { readonly organizationId: OrganizationId; readonly projectId: string; readonly taskId: TaskId },
  files: readonly (TicketContextFile & { readonly retryOfId?: MessageFileId })[],
): Promise<TicketFilesToBind> => {
  const stored: StoredTicketFile[] = [];
  const notes: TicketFileNote[] = [];
  let total = 0;
  for (const file of files) {
    const source = { where: file.where, commentId: file.commentId, sourceKey: ticketFileSourceKey(file.url), ...(file.retryOfId === undefined ? {} : { retryOfId: file.retryOfId }) };
    const name = safeFileName(file.name, null);
    const maxBytes = Math.min(deps.limits.maxFileBytes, deps.limits.maxTotalBytes - total);
    if (maxBytes <= 0) {
      notes.push({ ...source, name, state: "left_out", reason: "total-too-big", size: file.size });
      continue;
    }
    const fetched = await deps.reads.downloadFile(task, file.url, maxBytes);
    if (!fetched.ok) {
      notes.push(
        fetched.reason === "too-big"
          ? { ...source, name, state: "left_out", reason: maxBytes < deps.limits.maxFileBytes ? "total-too-big" : "too-big", size: file.size }
          : { ...source, name, state: "failed", reason: "download-failed", size: file.size },
      );
      continue;
    }
    total += fetched.bytes.byteLength;
    stored.push({ ...source, ...(await deps.reads.storeFile(task, { name: file.name, bytes: fetched.bytes })) });
  }
  return { stored, notes };
};

/** A plan's left-out files as notes, with no bytes fetched. */
const leftOutNotes = (leftOut: ReturnType<typeof ticketFilesToFetch>["leftOut"]): readonly TicketFileNote[] =>
  leftOut.map(({ file, reason }) => ({ where: file.where, commentId: file.commentId, sourceKey: ticketFileSourceKey(file.url), name: safeFileName(file.name, null), state: "left_out", reason, size: file.size }));

/** The words of a Retry's message: no ticket text, only that the files came again. */
const retryWords = (key: string): string => `The files of the ticket ${key} that failed to download before were fetched again: they come with this message.`;

/**
 * Reads a ticket task's ticket again (ADR 0070): passes on what changed since the last read, or for
 * a Retry the failed files, as a `ticket-update` message credited to the member, in one
 * transaction with the read's record and `ticket.context_read`. Nothing new writes nothing (a
 * reopen still sends its dispatch). A tracker that doesn't answer throws, and the job retries.
 */
export const readTicketForTask = async (deps: ReadTicketDeps, input: ReadTicketInput): Promise<ReadTicketResult> => {
  const row = await deps.db.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  if (row.ticketId === null) {
    return { ok: false, error: "not-a-ticket-task", message: "The task wasn't started from a ticket" };
  }
  const owner = { organizationId: input.organizationId, projectId: row.projectId, taskId: input.taskId };
  const read = await deps.reads.readTicket(owner);
  if (!read.ok && read.reason === "unavailable") {
    throw new Error(TICKET_READ_UNAVAILABLE);
  }
  const last = await lastReadOf(deps.db, input.taskId);
  // What changed, and which files to fetch: a Retry's are its failed ones, found on the ticket by their source key.
  let changes: TicketChanges | null = null;
  let toFetch: readonly (TicketContextFile & { readonly retryOfId?: MessageFileId })[] = [];
  let leftOut: readonly TicketFileNote[] = [];
  if (read.ok && last !== null) {
    if (input.reason === "retry") {
      const failed = await deps.db.messageFile.findMany({ where: { taskId: input.taskId, origin: "ticket", state: "failed" }, select: { id: true, ticketSourceKey: true } });
      const retried = new Set((await deps.db.messageFile.findMany({ where: { taskId: input.taskId, retryOfId: { in: failed.map((file) => file.id) } }, select: { retryOfId: true } })).map((file) => file.retryOfId));
      const byKey = new Map(read.context.files.map((file) => [ticketFileSourceKey(file.url), file]));
      toFetch = failed.flatMap((file) => {
        const found = file.ticketSourceKey === null || retried.has(file.id) ? undefined : byKey.get(file.ticketSourceKey);
        return found === undefined ? [] : [{ ...found, retryOfId: messageFileIdSchema.parse(file.id) }];
      });
    } else {
      changes = ticketChanges(last.record, read.context, read.ownUserId);
      const plan = ticketFilesToFetch(changes.files, read.capability, deps.limits);
      toFetch = plan.fetch;
      leftOut = leftOutNotes(plan.leftOut);
    }
  }
  const fetched = await fetchFiles(deps, owner, toFetch);
  const files: TicketFilesToBind = { stored: fetched.stored, notes: [...leftOut, ...fetched.notes] };
  const text =
    !read.ok || last === null
      ? null
      : input.reason === "retry"
        ? files.stored.length === 0 && files.notes.length === 0
          ? null
          : retryWords(read.context.ticket.key)
        : changes === null
          ? null
          : ticketUpdatePrompt(changes, read.context.ticket);
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${input.taskId} FOR UPDATE`;
    const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
    const organizationId = organizationIdSchema.parse(input.organizationId);
    const projectId = projectIdSchema.parse(task.projectId);
    const now = deps.clock.now();
    const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    let round: number | null = null;
    let steered = false;
    if (text !== null && session !== null && read.ok) {
      const sessionId: SessionId = sessionIdSchema.parse(session.id);
      const clientMessageId = clientMessageIdSchema.parse(`ticket-update-${randomUUID()}`);
      const bind = await filesToBindInTx(tx, organizationId, deps.files ?? defaultMessageFilesDeps, { fileIds: [], modelId: session.modelId, agentProfileId: session.agentProfileId, ticket: files });
      const { seq, bound } = await appendMemberMessageInTx(
        tx,
        { organizationId, projectId, taskId: task.id, sessionId, at: now },
        { kind: "user.message", memberId: input.memberId, clientMessageId, text, delivery: "queued", intent: "ticket-update" },
        bind,
      );
      // A press while the task runs or waits: the driver's steer, into the going session's box.
      const lease = input.reason === "reopen" ? null : await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } });
      const going = lease !== null && (task.state === "running" || task.state === "needs_you") && GOING_SESSION_STATES.some((state) => state === session.state);
      if (going) {
        const presence = await tx.runnerPresence.findUnique({ where: { runnerId: lease.runnerId }, select: { minor: true } });
        // A runner below minor 8 takes the words alone; the files reach its next fresh box with the spec.
        const fileFields = canSendFiles(presence?.minor ?? 0) ? steerFileFields(bound) : {};
        await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
          kind: "steer",
          body: { sessionId, clientMessageId, text: text.slice(0, runnerLimits.steerTextMaxChars), delivery: "queue", intent: "ticket-update", ...fileFields },
          notAfter: now + runnerLimits.offerTimeoutMs,
          task: { taskId: task.id, projectId },
        });
        steered = true;
      }
      // The read's record: the ticket as read, the files' keys given and left out (a failed one isn't, so the next read tries it).
      round = (last?.round ?? 0) + 1;
      const keys = [...(last?.record.fileKeys ?? []), ...files.stored.map((file) => file.sourceKey), ...files.notes.filter((note) => note.state === "left_out").map((note) => note.sourceKey)];
      const record = ticketReadRecordOf(read.context, read.ownUserId, keys);
      await tx.taskTicketRead.create({
        data: { organizationId, projectId, taskId: task.id, round, reason: input.reason, descriptionSha256: record.descriptionSha256, comments: [...record.comments], fileKeys: [...record.fileKeys], eventSeq: seq },
      });
      const edited = new Set(changes?.comments.edited.map((comment) => comment.id) ?? []);
      const comments = changes === null ? [] : [...changes.comments.new, ...changes.comments.edited];
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId,
        at: now,
        event: {
          kind: "ticket.context_read",
          round,
          reason: input.reason,
          description: changes?.description ?? null,
          comments: [...contextReadComments(comments, edited)],
          links: [...contextReadLinks(read.context)],
          files: bound.files.map((file) => file.fileId),
          leftOut: files.notes.filter((note) => note.state === "left_out").slice(0, runnerLimits.fileNotesMax).map((note) => ({ name: note.name, reason: note.reason })),
          failed: files.notes.filter((note) => note.state === "failed").slice(0, runnerLimits.fileNotesMax).map((note) => ({ name: note.name, reason: note.reason })),
        },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    } else if (read.ok && last === null && session !== null) {
      // A task started before milestone 9 has no record: this read is its baseline, and passes nothing on.
      round = 1;
      const record = ticketReadRecordOf(read.context, read.ownUserId, read.context.files.filter((file) => !file.byOstra).map((file) => ticketFileSourceKey(file.url)));
      await tx.taskTicketRead.create({
        data: { organizationId, projectId, taskId: task.id, round, reason: input.reason, descriptionSha256: record.descriptionSha256, comments: [...record.comments], fileKeys: [...record.fileKeys] },
      });
    }
    // A reopen's dispatch, held back for this read: the new session's pending messages are the
    // member's words and then the update, in their order.
    let dispatched = false;
    if (input.reason === "reopen" && task.state === "queued" && session !== null && session.state === "starting") {
      await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
      dispatched = true;
    }
    return { ok: true, outcome: text !== null && round !== null && session !== null ? "sent" : "nothing-new", round: text === null ? null : round, dispatched, steered };
  });
};

// ---------- a member's press: "Send ticket updates" and "Retry" ----------

export type TicketPressDeps = { readonly db: Db; readonly jobs: Ports["jobs"] };

export type TicketPressResult = UseCaseResult<
  { readonly requestId: string },
  "not-found" | "not-a-ticket-task" | "not-the-driver" | "not-running" | "nothing-failed"
>;

/** The press's checks: a ticket task the member can open, that runs or waits, driven by them. */
const pressCheckInTx = async (
  tx: Tx,
  scope: MemberScope,
  taskId: TaskId,
): Promise<Exclude<TicketPressResult, { readonly ok: true }> | { readonly ok: true; readonly projectId: string }> => {
  const task = await tx.task.findFirst({ where: { id: taskId, organizationId: scope.organizationId }, select: { projectId: true, ticketId: true, kind: true, state: true, driverMemberId: true } });
  if (task === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access }, "read").ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  if (task.ticketId === null || task.kind !== "code") {
    return { ok: false, error: "not-a-ticket-task", message: "The task wasn't started from a ticket" };
  }
  if (task.driverMemberId !== scope.memberId) {
    return { ok: false, error: "not-the-driver", message: "Only the task's driver sends it the ticket's updates: take over first" };
  }
  if (task.state !== "running" && task.state !== "needs_you") {
    return { ok: false, error: "not-running", message: "The task isn't running: reopen it, and it reads the ticket again" };
  }
  return { ok: true, projectId: task.projectId };
};

/**
 * "Send ticket updates" (ADR 0070, Q336): the driver's press, while the task runs or waits, sends
 * `ticket.read-changes` keyed by the press's request ID, so a double press reads once. The job
 * says "nothing new" when nothing changed.
 */
export const requestTicketUpdates = async (deps: TicketPressDeps, scope: MemberScope, input: { readonly taskId: TaskId; readonly requestId: string }): Promise<TicketPressResult> =>
  deps.db.$transaction(async (tx) => {
    const checked = await pressCheckInTx(tx, scope, input.taskId);
    if (!checked.ok) {
      return checked;
    }
    await deps.jobs.enqueueInTx(tx, "ticket.read-changes", {
      organizationId: organizationIdSchema.parse(scope.organizationId),
      taskId: taskIdSchema.parse(input.taskId),
      reason: "member",
      memberId: memberIdSchema.parse(scope.memberId),
      requestId: input.requestId,
    });
    return { ok: true, requestId: input.requestId };
  });

/**
 * "Retry" on a ticket's failed files (ADR 0070): the driver's press sends `ticket.read-changes`
 * with the reason `retry`, which fetches only the failed files not retried yet and sends what it got.
 */
export const retryTicketFiles = async (deps: TicketPressDeps, scope: MemberScope, input: { readonly taskId: TaskId; readonly requestId: string }): Promise<TicketPressResult> =>
  deps.db.$transaction(async (tx) => {
    const checked = await pressCheckInTx(tx, scope, input.taskId);
    if (!checked.ok) {
      return checked;
    }
    const failed = await tx.messageFile.findMany({ where: { taskId: input.taskId, origin: "ticket", state: "failed" }, select: { id: true } });
    const retried = await tx.messageFile.count({ where: { taskId: input.taskId, retryOfId: { in: failed.map((file) => file.id) } } });
    if (failed.length === 0 || retried >= failed.length) {
      return { ok: false, error: "nothing-failed", message: "No file of the ticket is waiting for a Retry" };
    }
    await deps.jobs.enqueueInTx(tx, "ticket.read-changes", {
      organizationId: organizationIdSchema.parse(scope.organizationId),
      taskId: taskIdSchema.parse(input.taskId),
      reason: "retry",
      memberId: memberIdSchema.parse(scope.memberId),
      requestId: input.requestId,
    });
    return { ok: true, requestId: input.requestId };
  });

/** A follow-up's files (ADR 0057 amended): those `filesInText` found, as a ticket's are fetched, within the ticket's limits. */
export const followUpFilesToFetch = (files: readonly TicketContextFile[], capability: TicketFilesCapability, limits: FileLimits) => ticketFilesToFetch(files, capability, limits);
