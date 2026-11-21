import { randomUUID } from "node:crypto";

import { isImageFile } from "@ostra/adapter-sdk";
import type { TicketContext, TicketContextFile, TicketFilesCapability } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import {
  canSendFiles,
  clientMessageIdSchema,
  fileLeftOutWords,
  leaseEpochSchema,
  memberIdSchema,
  messageFileIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
  runnerLimits,
  safeFileName,
  sessionIdSchema,
  taskIdSchema,
  truncateBytes,
} from "@ostra/protocol";
import type { MemberId, MessageFileId, OrganizationId, ProjectId, SessionId, TaskEventOf, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { appendMemberMessageInTx, bindTicketFilesInTx, defaultMessageFilesDeps, filesToBindInTx, noBoundFiles, steerFileFields } from "../files/message-files.ts";
import type { BoundMessageFiles, MessageFilesDeps, StoredTicketFile, TicketFileNote, TicketFilesToBind } from "../files/message-files.ts";
import type { FileLimits } from "../files/limits.ts";
import type { Ports } from "../ports.ts";
import { sessionModelIdInTx } from "../use-cases/budgets.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import { appendServerEvent, appendServerEventNumbered } from "../use-cases/server-events.ts";
import { markTicketInline } from "./ticket-template.ts";
import {
  contextReadComments,
  contextReadLinks,
  peopleComments,
  ticketChanges,
  ticketFileSourceKey,
  ticketFilesToFetch,
  ticketReadRecordOf,
  ticketUpdatePrompt,
} from "./ticket-files.ts";
import type { TicketChanges, TicketReadRecord } from "./ticket-files.ts";

// Reading a ticket task's ticket (F-149, ADR 0070, Q336, tickets 06 and 12): at its start (round 1,
// core's `ticket.fetch-context`, `writeTicketStartInTx`), and again on a reopen, a member's "Send
// ticket updates", or a Retry of its failed files (`readTicketForTask`, core's
// `ticket.read-changes`). The read goes through the connection's adapter, with its credential, in
// core; the files (at the start, every one; after it, what changed since the last read
// (`TaskTicketRead`), or for a Retry the failed ones again) are fetched within the ticket's limits
// (`fetchTicketFiles`), stored as blobs of the task with their text, and written in one
// transaction: the message with the files as the ticket's, the read's record and
// `ticket.context_read`. A round after the start passes on the changes in a `ticket-update`
// message credited to the member: a reopen's goes as the new session's pending message after the
// member's own, and the dispatch follows; a press's goes as the driver's steer. A read that finds
// nothing new, or a ticket that couldn't be read, is still a round, so the thread says so. The
// ticket's text and its files are never logged.

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
  /**
   * Ticket 12: the job's last try. A tracker that doesn't answer then makes an `unreadable` round
   * (a reopen goes on without the ticket's changes) instead of a retry.
   */
  readonly lastTry?: boolean;
};

/**
 * What the read did: `sent` a message (as a steer, or a pending message the dispatch carries),
 * `nothing-new` (no message), `unreadable` (the ticket couldn't be read: no message), and for a
 * reopen whether it sent the dispatch. Each but a pre-milestone-9 task's first read is a round,
 * with its `ticket.context_read`, so the thread answers the press.
 */
export type ReadTicketResult = UseCaseResult<
  { readonly outcome: "sent" | "nothing-new" | "unreadable"; readonly round: number | null; readonly dispatched: boolean; readonly steered: boolean },
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

// ---------- fetching a ticket's files (the start's, each later round's, a follow-up's) ----------

/** What a fetch of a ticket's files needs: core's download and store, and the ticket's limits. */
export type TicketFetchDeps = {
  readonly reads: Pick<TicketReadPorts, "downloadFile" | "storeFile">;
  /** The ticket's limits (`OSTRA_TICKET_FILES_MAX`, `_FILE_MAX_MIB`, `_FILES_TOTAL_MIB`). */
  readonly limits: FileLimits;
};

/** A ticket's files for one read, fetched or noted, and whether the tracker fetches none at all (`ticketFiles: "none"`). */
export type FetchedTicketFiles = TicketFilesToBind & { readonly notFetched: boolean };

/** No files: a read with nothing to fetch. */
export const noTicketFiles: FetchedTicketFiles = { stored: [], notes: [], notFetched: false };

/** Whether the tracker's capability lets ostra fetch a file: every one, the images, or none. */
const capabilityLets = (capability: TicketFilesCapability, file: TicketContextFile): boolean => {
  switch (capability) {
    case "all":
      return true;
    case "images":
      return isImageFile(file);
    case "none":
      return false;
    default:
      return capability satisfies never;
  }
};

/**
 * Fetches a ticket's files for one read (ADR 0070, Q329, Q331), in the ticket's order: ostra's own
 * (`byOstra`) skipped; those the tracker's capability doesn't let through left out (`not-fetched`);
 * then each within the ticket's limits. A file the tracker gave no size for is held to what's left
 * as it downloads (`downloadFile`'s `maxBytes`): one over a file's size is `too-big`, one past the
 * total `total-too-big`, and neither takes one of the count's places, so a ticket of 22 files with
 * one too big gives 20. A failed download keeps its place, noted `failed` for a Retry; the task
 * starts without it. Each fetched file is stored (core tells its kind by its bytes and reads a
 * document's text). A Retry's files carry the failed file they fetch again (`retryOfId`).
 */
export const fetchTicketFiles = async (
  deps: TicketFetchDeps,
  task: { readonly organizationId: OrganizationId; readonly projectId: string; readonly taskId: TaskId },
  files: readonly (TicketContextFile & { readonly retryOfId?: MessageFileId })[],
  capability: TicketFilesCapability,
): Promise<FetchedTicketFiles> => {
  const { limits } = deps;
  const stored: StoredTicketFile[] = [];
  const notes: TicketFileNote[] = [];
  let given = 0;
  let total = 0;
  for (const file of files) {
    if (file.byOstra) {
      continue;
    }
    const source = { where: file.where, commentId: file.commentId, sourceKey: ticketFileSourceKey(file.url), ...(file.retryOfId === undefined ? {} : { retryOfId: file.retryOfId }) };
    const note = (state: TicketFileNote["state"], reason: TicketFileNote["reason"]): void => {
      notes.push({ ...source, name: safeFileName(file.name, null), state, reason, size: file.size });
    };
    const room = limits.maxTotalBytes - total;
    if (!capabilityLets(capability, file)) {
      note("left_out", "not-fetched");
    } else if (file.size !== null && file.size > limits.maxFileBytes) {
      note("left_out", "too-big");
    } else if (given >= limits.maxFiles) {
      note("left_out", "too-many");
    } else if (room <= 0 || (file.size !== null && file.size > room)) {
      note("left_out", "total-too-big");
    } else {
      const maxBytes = Math.min(limits.maxFileBytes, room);
      const fetched = await deps.reads.downloadFile(task, file.url, maxBytes);
      if (!fetched.ok && fetched.reason === "too-big") {
        note("left_out", maxBytes < limits.maxFileBytes ? "total-too-big" : "too-big");
      } else if (!fetched.ok) {
        given += 1;
        note("failed", "download-failed");
      } else {
        given += 1;
        total += fetched.bytes.byteLength;
        stored.push({ ...source, ...(await deps.reads.storeFile(task, { name: file.name, bytes: fetched.bytes })) });
      }
    }
  }
  return { stored, notes, notFetched: capability === "none" };
};

/**
 * The lines a prompt names the ticket's files the agent doesn't have with (F-149/c3), after the
 * ticket's text: each left-out or failed file by its safe name, marked as the ticket's, with why;
 * and that the tracker's files aren't fetched at all. Empty when there's nothing to say. The
 * runner's block names the files the agent has.
 */
export const ticketFilesLeftOutLines = (files: Pick<FetchedTicketFiles, "notes" | "notFetched">): string => {
  const lines: string[] = [];
  if (files.notes.length > 0) {
    lines.push(
      "## The ticket's files you don't have",
      "",
      "ostra didn't put these of the ticket's files in your workspace:",
      ...files.notes.slice(0, runnerLimits.fileNotesMax).map((note) => `- ${markTicketInline(note.name)}: ${fileLeftOutWords(note.reason)}.`),
    );
    if (files.notes.length > runnerLimits.fileNotesMax) {
      lines.push(`- and ${String(files.notes.length - runnerLimits.fileNotesMax)} more.`);
    }
  }
  if (files.notFetched) {
    lines.push(...(lines.length === 0 ? [] : [""]), "ostra doesn't fetch this tracker's files: you have the ticket's text only.");
  }
  return lines.join("\n");
};

/** Text with the left-out lines after it, when there are any. */
const withLeftOutLines = (text: string, files: Pick<FetchedTicketFiles, "notes" | "notFetched">): string => {
  const lines = ticketFilesLeftOutLines(files);
  return lines === "" ? text : `${text.replace(/\s+$/, "")}\n\n${lines}\n`;
};

/** The words of a Retry's message: no ticket text, only that the files came again. */
const retryWords = (key: string): string => `The files of the ticket ${key} that failed to download before were fetched again: they come with this message.`;

/** The read's record's file keys: those given and those left out, never a failed one, so the next read tries it again. */
const recordedFileKeys = (earlier: readonly string[], files: TicketFilesToBind): readonly string[] => [
  ...earlier,
  ...files.stored.map((file) => file.sourceKey),
  ...files.notes.filter((note) => note.state === "left_out").map((note) => note.sourceKey),
];

/** A round's left-out and failed notes, as `ticket.context_read` holds them. */
const roundNotes = (notes: readonly TicketFileNote[]): Pick<TaskEventOf<"ticket.context_read">, "leftOut" | "failed"> => ({
  leftOut: notes.filter((note) => note.state === "left_out").slice(0, runnerLimits.fileNotesMax).map((note) => ({ name: note.name, reason: note.reason })),
  failed: notes.filter((note) => note.state === "failed").slice(0, runnerLimits.fileNotesMax).map((note) => ({ name: note.name, reason: note.reason })),
});

// ---------- the start's read (round 1) ----------

export type TicketStartInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  /**
   * The task's creator, credited with the first message. `null` for an outside start (F-012): it
   * has no member's message, so its files go with the read itself, under the read's number.
   */
  readonly memberId: MemberId | null;
  /** The rendered first prompt, the first message's text. Never logged. */
  readonly prompt: string;
  /** The ticket as read, or as the ticket cache keeps it when the tracker no longer has it. */
  readonly context: TicketContext;
  /** The connection's own user: ostra's comments are left out by it. */
  readonly ownUserId: string | null;
  readonly files: FetchedTicketFiles;
  readonly now: number;
};

/** The `clientMessageId` an outside start's files are bound under: no member's message has it. */
export const ticketStartFilesMessageId = (taskId: TaskId) => clientMessageIdSchema.parse(`ticket-start-${taskId}`);

/**
 * The start's read, in the caller's transaction (F-149, ADR 0070; core's `ticket.fetch-context`,
 * which renders the prompt, writes it on the task and sends the dispatch): the first `user.message`
 * with the ticket's files (each at `ticket/<name>`, images decided for the session's agent and
 * model), `ticket.context_read` (round 1, `start`: the description, the comments but ostra's own,
 * the links, the files given, those left out and failed, and `filesNotFetched` for a tracker that
 * fetches none), and the `TaskTicketRead` the next round compares with.
 */
export const writeTicketStartInTx = async (
  tx: Tx,
  deps: { readonly files?: MessageFilesDeps | undefined },
  input: TicketStartInput,
): Promise<{ readonly messageSeq: TaskSeq | null; readonly files: readonly MessageFileId[] }> => {
  const session = await tx.session.findFirst({ where: { id: input.sessionId, taskId: input.taskId }, select: { modelId: true, agentProfileId: true } });
  const agentProfileId = session?.agentProfileId ?? null;
  // The model the session will run on: the dispatch writes it on the session, so until then the profile's.
  const modelId = await sessionModelIdInTx(tx, input.organizationId, { agentProfileId, modelId: session?.modelId ?? null });
  const bind = await filesToBindInTx(tx, input.organizationId, deps.files ?? defaultMessageFilesDeps, { fileIds: [], modelId, agentProfileId, ticket: input.files });
  const where = { organizationId: input.organizationId, projectId: input.projectId, taskId: input.taskId, sessionId: input.sessionId, at: input.now };
  const readOf = (bound: BoundMessageFiles): TaskEventOf<"ticket.context_read"> => ({
    kind: "ticket.context_read",
    round: 1,
    reason: "start",
    description: input.context.ticket.description === null ? null : truncateBytes(input.context.ticket.description, runnerLimits.ticketDescriptionMaxBytes),
    comments: [...contextReadComments(peopleComments(input.context, input.ownUserId))],
    links: [...contextReadLinks(input.context)],
    files: bound.files.map((file) => file.fileId),
    ...roundNotes(input.files.notes),
    ...(input.files.notFetched ? { filesNotFetched: true as const } : {}),
  });
  let messageSeq: TaskSeq | null = null;
  let bound: BoundMessageFiles = noBoundFiles;
  if (input.memberId !== null) {
    // The first message is the rendered ticket, as a prompt task's is its prompt, with the ticket's files.
    ({ seq: messageSeq, bound } = await appendMemberMessageInTx(
      tx,
      where,
      { kind: "user.message", memberId: input.memberId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: input.prompt, delivery: "immediate" },
      bind,
    ));
    await appendServerEvent(tx, { ...where, event: readOf(bound) });
  } else {
    // An outside start has no member's message: its files go with the read, under the read's number.
    await appendServerEventNumbered(tx, where, async (seq) => {
      if (bind?.ticket !== undefined) {
        bound = await bindTicketFilesInTx(tx, { ...where, clientMessageId: ticketStartFilesMessageId(input.taskId), eventSeq: seq, now: input.now }, bind.ticket, {
          model: bind.model,
          agentTakesImages: bind.agentTakesImages,
        });
      }
      return readOf(bound);
    });
  }
  const record = ticketReadRecordOf(input.context, input.ownUserId, recordedFileKeys([], input.files));
  await tx.taskTicketRead.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      round: 1,
      reason: "start",
      descriptionSha256: record.descriptionSha256,
      comments: [...record.comments],
      fileKeys: [...record.fileKeys],
      eventSeq: messageSeq,
    },
  });
  return { messageSeq, files: bound.files.map((file) => file.fileId) };
};

/**
 * Reads a ticket task's ticket again (ADR 0070): passes on what changed since the last read, or for
 * a Retry the failed files, as a `ticket-update` message credited to the member, in one
 * transaction with the read's record and `ticket.context_read`. Nothing new writes no message, only
 * the round that says so (a reopen still sends its dispatch). A tracker that doesn't answer throws,
 * and the job retries; on its last try (`lastTry`), or when the ticket or its connection is gone,
 * the round says the ticket couldn't be read, and a reopen goes on without its changes.
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
  if (!read.ok && read.reason === "unavailable" && input.lastTry !== true) {
    throw new Error(TICKET_READ_UNAVAILABLE);
  }
  const last = await lastReadOf(deps.db, input.taskId);
  // What changed, and which files to fetch: a Retry's are its failed ones, found on the ticket by their source key.
  let changes: TicketChanges | null = null;
  let files: FetchedTicketFiles = noTicketFiles;
  if (read.ok && last !== null) {
    if (input.reason === "retry") {
      const failed = await deps.db.messageFile.findMany({ where: { taskId: input.taskId, origin: "ticket", state: "failed" }, select: { id: true, ticketSourceKey: true } });
      const retried = new Set((await deps.db.messageFile.findMany({ where: { taskId: input.taskId, retryOfId: { in: failed.map((file) => file.id) } }, select: { retryOfId: true } })).map((file) => file.retryOfId));
      const byKey = new Map(read.context.files.map((file) => [ticketFileSourceKey(file.url), file]));
      const toFetch = failed.flatMap((file) => {
        const found = file.ticketSourceKey === null || retried.has(file.id) ? undefined : byKey.get(file.ticketSourceKey);
        return found === undefined ? [] : [{ ...found, retryOfId: messageFileIdSchema.parse(file.id) }];
      });
      files = await fetchTicketFiles(deps, owner, toFetch, read.capability);
    } else {
      changes = ticketChanges(last.record, read.context, read.ownUserId);
      files = await fetchTicketFiles(deps, owner, changes.files, read.capability);
    }
  }
  const words =
    !read.ok || last === null
      ? null
      : input.reason === "retry"
        ? files.stored.length === 0 && files.notes.length === 0
          ? null
          : retryWords(read.context.ticket.key)
        : changes === null
          ? null
          : ticketUpdatePrompt(changes, read.context.ticket);
  // The files that didn't come are named in the message's words too: the runner's block names only those it got.
  const text = words === null ? null : withLeftOutLines(words, { notes: files.notes, notFetched: false });
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${input.taskId} FOR UPDATE`;
    const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
    const organizationId = organizationIdSchema.parse(input.organizationId);
    const projectId = projectIdSchema.parse(task.projectId);
    const now = deps.clock.now();
    const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    let outcome: "sent" | "nothing-new" | "unreadable" = "nothing-new";
    let round: number | null = null;
    let steered = false;
    /** One round of the read: its record (the next round compares with it) and its `ticket.context_read`. */
    const writeRound = async (
      sessionId: SessionId,
      record: TicketReadRecord | null,
      eventSeq: TaskSeq | null,
      event: Omit<TaskEventOf<"ticket.context_read">, "kind" | "round" | "reason">,
    ): Promise<void> => {
      round = (last?.round ?? 0) + 1;
      if (record !== null) {
        await tx.taskTicketRead.create({
          data: { organizationId, projectId, taskId: task.id, round, reason: input.reason, descriptionSha256: record.descriptionSha256, comments: [...record.comments], fileKeys: [...record.fileKeys], eventSeq },
        });
      }
      await appendServerEvent(tx, { organizationId, projectId, taskId: task.id, sessionId, at: now, event: { kind: "ticket.context_read", round, reason: input.reason, ...event } });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
    };
    const nothing = { description: null, comments: [], links: [], files: [], leftOut: [], failed: [] };
    if (session === null) {
      // No session to write to: nothing to record.
    } else if (!read.ok) {
      // The ticket couldn't be read: a round that says so, the last record kept for the next read.
      // A task started before milestone 9, with no record yet, gets its baseline from its next read.
      outcome = "unreadable";
      await writeRound(sessionIdSchema.parse(session.id), last?.record ?? null, null, { ...nothing, unreadable: true });
    } else if (last === null) {
      // A task started before milestone 9 has no record: this read is its baseline, and passes nothing on.
      round = 1;
      const record = ticketReadRecordOf(read.context, read.ownUserId, read.context.files.filter((file) => !file.byOstra).map((file) => ticketFileSourceKey(file.url)));
      await tx.taskTicketRead.create({
        data: { organizationId, projectId, taskId: task.id, round, reason: input.reason, descriptionSha256: record.descriptionSha256, comments: [...record.comments], fileKeys: [...record.fileKeys] },
      });
    } else if (text === null) {
      // Nothing new: no message, and the round says so (every list empty, no description).
      const record = ticketReadRecordOf(read.context, read.ownUserId, recordedFileKeys(last.record.fileKeys, files));
      await writeRound(sessionIdSchema.parse(session.id), record, null, { ...nothing, ...(read.capability === "none" ? { filesNotFetched: true as const } : {}) });
    } else {
      outcome = "sent";
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
      const record = ticketReadRecordOf(read.context, read.ownUserId, recordedFileKeys(last.record.fileKeys, files));
      const edited = new Set(changes?.comments.edited.map((comment) => comment.id) ?? []);
      const comments = changes === null ? [] : [...changes.comments.new, ...changes.comments.edited];
      await writeRound(sessionId, record, seq, {
        description: changes?.description === undefined || changes.description === null ? null : truncateBytes(changes.description, runnerLimits.ticketDescriptionMaxBytes),
        comments: [...contextReadComments(comments, edited)],
        links: [...contextReadLinks(read.context)],
        files: bound.files.map((file) => file.fileId),
        ...roundNotes(files.notes),
        ...(read.capability === "none" ? { filesNotFetched: true as const } : {}),
      });
    }
    // A reopen's dispatch, held back for this read: the new session's pending messages are the
    // member's words and then the update, in their order.
    let dispatched = false;
    if (input.reason === "reopen" && task.state === "queued" && session !== null && session.state === "starting") {
      await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
      dispatched = true;
    }
    return { ok: true, outcome, round, dispatched, steered };
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
