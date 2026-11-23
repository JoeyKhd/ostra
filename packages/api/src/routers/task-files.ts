import { randomUUID } from "node:crypto";

import { modelImageInput, requestTicketUpdates, retryTicketFiles, ticketFileLimits, ticketFileSourceKey } from "@ostra/domain";
import type { FileLimits, ModelImageInput } from "@ostra/domain";
import type { Db } from "@ostra/db";
import { mapEventToStored } from "@ostra/db";
import {
  FILES_ROOT_DIR,
  MESSAGE_FILES_FOLDER,
  TICKET_FILES_FOLDER,
  fileLeftOutReasonSchema,
  fileTextFailureReasonSchema,
  isPromptImageContentType,
  memberIdSchema,
  messageFileIdSchema,
  safeFileName,
  safeFileNameSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type {
  FileLeftOutReason,
  ImagesNotSent,
  MemberId,
  MessageFileId,
  OrganizationId,
  TaskEventOf,
  TaskId,
  TicketContextComment,
  TicketContextLink,
  TicketReadReason,
  UserMessageFile,
} from "@ostra/protocol";
import { messageFileViewOf } from "@ostra/task-view";
import type { MessageFileView } from "@ostra/task-view";
import type { DbEnum } from "@ostra/db";
import { z } from "zod";

import { ticketConnectionOf, ticketConnectionSelect } from "../services/ticket-trackers.ts";
import type { TicketConnection } from "../services/ticket-trackers.ts";
import { taskProcedure, unwrap } from "../trpc/init.ts";

// Milestone 9 (F-148, F-149, F-150, ADR 0070, ticket 14): a task's files and its ticket's context,
// for any member who can open the task (`taskProcedure("read")`), and the driver's two presses.
//
// - `tasks.files`: every file sent with the task's messages, a member's and the ticket's, oldest
//   first, each as the thread draws it (`MessageFileView`: its download, `null` once its blob is
//   gone; its text's words or reason) with its message's number and where on the ticket it was;
//   and people's files counted for the properties panel's `Attachments` group.
// - `tasks.ticketContext`: each read of the ticket (`ticket.context_read`, round 1 at the start),
//   with the ticket's files in the ticket's order (given, left out by the ticket's limits with why
//   and its size, or failed with what a Retry did), the description's file links matched to the
//   stored files, the rendered first prompt, the ticket's limits and the tracker, whether it's
//   still being fetched, and what the caller may press. `null` for a task with no ticket.
// - `tasks.ticketUpdates` ("Send ticket updates") and `tasks.retryTicketFiles` ("Retry"): the
//   driver's, while the task runs or waits; each enqueues `ticket.read-changes` and answers at
//   once. The answer, "nothing new" among them, comes as the next round (`afterRound` + 1).
//
// Every string of the ticket is its own: data, drawn as text, never logged.

// ---------- a file as the thread and the panel show it ----------

/** The row fields a file's view is made from. */
const fileSelect = {
  id: true,
  name: true,
  kind: true,
  contentType: true,
  size: true,
  origin: true,
  asImage: true,
  textState: true,
  textWords: true,
  textReason: true,
  blobId: true,
} as const;

type FileRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: DbEnum.MessageFileKind;
  readonly contentType: string;
  readonly size: number;
  readonly origin: DbEnum.MessageFileOrigin;
  readonly asImage: boolean;
  readonly textState: DbEnum.FileTextState;
  readonly textWords: number | null;
  readonly textReason: string | null;
  readonly blobId: string | null;
};

/** A stored name, as safe as the box holds it. */
const nameOf = (name: string): string => (safeFileNameSchema.safeParse(name).success ? name : safeFileName(name, null));

/** A file row as the thread draws it: the same view the fold makes of its message's event. */
export const fileViewOfRow = (taskId: TaskId, row: FileRow): MessageFileView => {
  const reason = fileTextFailureReasonSchema.safeParse(row.textReason);
  const recorded: UserMessageFile = {
    fileId: messageFileIdSchema.parse(row.id),
    name: nameOf(row.name),
    kind: row.kind,
    contentType: row.contentType,
    size: row.size,
    origin: row.origin,
    asImage: row.asImage,
    text: row.textState,
    ...(row.textState === "ready" && row.textWords !== null ? { textWords: row.textWords } : {}),
    ...(row.textState === "failed" && reason.success ? { textReason: reason.data } : {}),
  };
  return messageFileViewOf(taskId, recorded, row.blobId === null);
};

/** Where on the ticket a ticket's file was: its description, a comment (and whose), or its attachments. */
export type TicketFileFrom = { readonly where: "description" | "comment" | "attachment" | null; readonly author: string | null };

const whereOf = (value: string | null): TicketFileFrom["where"] => (value === "description" || value === "comment" || value === "attachment" ? value : null);

// ---------- the task's files ----------

/** A sent file of the task: its view, its message's number (its folder `.ostra/attachments/<seq>/`), whose it is and where on the ticket it was. */
export type TaskFileView = MessageFileView & {
  readonly seq: number | null;
  readonly memberId: MemberId | null;
  readonly ticketWhere: TicketFileFrom["where"];
};

/** People's files for the `Attachments` group: pictures, other files, their bytes, and their folders in the box. */
export type PeopleFiles = { readonly images: number; readonly files: number; readonly bytes: number; readonly folders: readonly string[] };

const taskInput = z.strictObject({ taskId: taskIdSchema });

export const taskFilesProcedure = taskProcedure("read", taskInput).query(async ({ ctx, input }): Promise<{ readonly files: readonly TaskFileView[]; readonly people: PeopleFiles }> => {
  const rows = await ctx.deps.db.messageFile.findMany({
    where: { taskId: input.taskId, organizationId: ctx.scope.organizationId, state: "sent" },
    orderBy: [{ eventSeq: "asc" }, { position: "asc" }, { createdAt: "asc" }],
    take: 2_000,
    select: { ...fileSelect, eventSeq: true, memberId: true, ticketWhere: true, boxPath: true },
  });
  const files = rows.map((row): TaskFileView => ({
    ...fileViewOfRow(input.taskId, row),
    seq: row.eventSeq,
    memberId: row.memberId === null ? null : memberIdSchema.parse(row.memberId),
    ticketWhere: whereOf(row.ticketWhere),
  }));
  const folders = [MESSAGE_FILES_FOLDER, TICKET_FILES_FOLDER].filter((folder) => rows.some((row) => row.boxPath?.startsWith(`${folder}/`) === true)).map((folder) => `${FILES_ROOT_DIR}/${folder}/`);
  const images = files.filter((file) => file.kind === "image").length;
  return { files, people: { images, files: files.length - images, bytes: files.reduce((sum, file) => sum + file.size, 0), folders } };
});

// ---------- the ticket's context ----------

/** One of the ticket's files in a round, in the ticket's order: given, left out by the limits, or failed to load. */
export type TicketAttachmentView =
  | { readonly state: "ready"; readonly file: MessageFileView; readonly from: TicketFileFrom }
  | { readonly state: "left-out"; readonly name: string; readonly size: number | null; readonly reason: Exclude<FileLeftOutReason, "download-failed" | "unreadable">; readonly from: TicketFileFrom }
  | {
      readonly state: "failed";
      readonly fileId: MessageFileId;
      readonly name: string;
      readonly from: TicketFileFrom;
      /** What a Retry made of it: the file it fetched, given or failed again; `null` before one. */
      readonly retry: { readonly fileId: MessageFileId; readonly state: "ready" | "failed" } | null;
    };

/**
 * Why a round's files didn't load, as far as ostra knows: how many times it tried (the read, then
 * each Retry) and when it last did. The tracker's own answer (`status`) isn't recorded: core keeps
 * only that the download failed, so it's `null`.
 */
export type TicketFailure = { readonly status: null; readonly tries: number; readonly lastAt: number };

export type TicketRoundView = {
  readonly round: number;
  readonly reason: TicketReadReason;
  /** The round's `ticket.context_read`, by its number in the task's log, and when ostra read the ticket. */
  readonly seq: number;
  readonly at: number;
  /** The description the agent got: `null` when it didn't change since the last round. The ticket's text. */
  readonly description: string | null;
  /** The description's file links that are files ostra stored, so a name in it opens the viewer. */
  readonly descriptionFiles: readonly { readonly url: string; readonly fileId: MessageFileId }[];
  readonly comments: readonly TicketContextComment[];
  readonly links: readonly TicketContextLink[];
  readonly attachments: readonly TicketAttachmentView[];
  readonly failure: TicketFailure | null;
  /** The tracker fetches no files (`ticketFiles: none`): the task has the ticket's text only. */
  readonly filesNotFetched: boolean;
  /** The ticket couldn't be read this round: nothing of it reached the agent. */
  readonly unreadable: boolean;
  /** A round after the start that found nothing new: "Nothing new on the ticket since the agent read it". */
  readonly nothingNew: boolean;
  /** The message the round went with, by its number: the start's first message, or the update. `null` with none. */
  readonly messageSeq: number | null;
  /** Why the round's images went as files only: the model, or the agent. */
  readonly imagesNotSent: ImagesNotSent | null;
  /** The model's name, when the round's images went as files because it can't see them. */
  readonly imagesAsFilesFor: string | null;
};

export type TicketContextView = {
  /** `fetching` while the start's read hasn't happened; `read` once it has. */
  readonly state: "fetching" | "read";
  readonly ticketKey: string;
  /**
   * Milestone 11 (F-152/c4, ticket-chips.md): the ticket's tracker for the meta line
   * (`PROJ-12 from Jira`), its board's connection, for every kind; `null` when the ticket is gone.
   */
  readonly connection: TicketConnection | null;
  /** The ticket's limits (`OSTRA_TICKET_FILES_*`), for the left-out notes. */
  readonly limits: FileLimits;
  /** The rendered first prompt, for "Show the prompt": text, never HTML. `null` until rendered. */
  readonly prompt: string | null;
  /** The task's model: its name and whether it sees images. */
  readonly model: { readonly name: string; readonly imageInput: ModelImageInput } | null;
  readonly isDriver: boolean;
  /** "Send ticket updates": the driver's, while the task runs or waits. */
  readonly canSendUpdates: boolean;
  /** "Retry": the same, while a failed file waits for one. */
  readonly canRetry: boolean;
  /** Every read, oldest first: the first is "What the agent got". */
  readonly rounds: readonly TicketRoundView[];
};

/** A URL in a piece of ticket text: a link's or an image's target, or one written out. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`()[\]]+/g;

/** The URLs a description names, as written and with HTML's `&amp;` read as `&`, each once. */
export const urlsInText = (text: string): readonly string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    found.add(url);
    found.add(url.replaceAll("&amp;", "&"));
  }
  return [...found];
};

const recordCommentsSchema = z.array(z.object({ id: z.string() })).catch([]);

/** The task's model now: its newest session's, else its profile's; with its name and image input. */
const taskModelOf = async (db: Db, organizationId: OrganizationId, task: { readonly id: string; readonly agentProfileId: string | null }) => {
  const session = await db.session.findFirst({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { modelId: true, agentProfileId: true } });
  const profileId = session?.agentProfileId ?? task.agentProfileId;
  const modelId =
    session?.modelId ?? (profileId === null ? null : ((await db.agentProfile.findFirst({ where: { id: profileId, organizationId }, select: { modelId: true } }))?.modelId ?? null));
  const model =
    modelId === null
      ? null
      : await db.model.findFirst({ where: { id: modelId, organizationId }, select: { displayName: true, endpointModelId: true, adminImageInput: true, catalogInputModalities: true } });
  return model === null ? null : { name: model.displayName ?? model.endpointModelId, imageInput: modelImageInput(model) };
};

export const ticketContextProcedure = taskProcedure("read", taskInput).query(async ({ ctx, input }): Promise<TicketContextView | null> => {
  const { db, settings } = ctx.deps;
  const organizationId = ctx.scope.organizationId;
  const task = await db.task.findFirst({
    where: { id: input.taskId, organizationId },
    select: { id: true, ticketId: true, ticketKey: true, kind: true, state: true, prompt: true, driverMemberId: true, agentProfileId: true },
  });
  if (task?.ticketId === null || task?.ticketId === undefined) {
    return null;
  }
  const [ticket, events, reads, rows, model] = await Promise.all([
    db.ticket.findFirst({ where: { id: task.ticketId, organizationId }, select: { key: true, connection: { select: ticketConnectionSelect } } }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "ticket.context_read" }, orderBy: { seq: "asc" }, take: 500 }),
    db.taskTicketRead.findMany({ where: { taskId: task.id, organizationId }, orderBy: { round: "asc" }, select: { round: true, eventSeq: true, comments: true } }),
    db.messageFile.findMany({
      where: { taskId: task.id, organizationId, origin: "ticket" },
      orderBy: [{ eventSeq: "asc" }, { position: "asc" }, { createdAt: "asc" }],
      take: 2_000,
      select: { ...fileSelect, state: true, reason: true, eventSeq: true, ticketWhere: true, ticketCommentId: true, ticketSourceKey: true, retryOfId: true, createdAt: true },
    }),
    taskModelOf(db, organizationId, task),
  ]);
  const roundEvents = events.flatMap((row) => {
    const stored = mapEventToStored(row);
    return stored.event.kind === "ticket.context_read" ? [{ seq: stored.seq, at: stored.at, event: stored.event }] : [];
  });
  const readOf = new Map(reads.map((read) => [read.round, read] as const));
  // The messages the rounds went with: their image decision.
  const messageSeqs = reads.flatMap((read) => (read.eventSeq === null ? [] : [read.eventSeq]));
  const messages = messageSeqs.length === 0 ? [] : await db.event.findMany({ where: { taskId: task.id, organizationId, kind: "user.message", seq: { in: messageSeqs } } });
  const imagesOf = new Map(
    messages.flatMap((row) => {
      const stored = mapEventToStored(row);
      return stored.event.kind === "user.message" ? [[stored.seq, stored.event.imagesNotSent ?? null] as const] : [];
    }),
  );
  // A failed file's Retry: the file that fetched it again, by the failed one's ID.
  const retryOf = new Map(rows.flatMap((row) => (row.retryOfId === null ? [] : [[row.retryOfId, row] as const])));
  /** How many times a failed file was tried, and when last: it, then each Retry that failed again. */
  const triesOf = (row: (typeof rows)[number]): { readonly tries: number; readonly lastAt: number } => {
    let tries = 1;
    let lastAt = row.createdAt.getTime();
    let next = retryOf.get(row.id);
    while (next?.state === "failed") {
      tries += 1;
      lastAt = Math.max(lastAt, next.createdAt.getTime());
      next = retryOf.get(next.id);
    }
    return { tries, lastAt };
  };

  const rounds = roundEvents.map(({ seq, at, event }: { readonly seq: number; readonly at: number; readonly event: TaskEventOf<"ticket.context_read"> }): TicketRoundView => {
    const read = readOf.get(event.round);
    const messageSeq = read?.eventSeq ?? null;
    // An outside start has no message: its files are bound under the read's own number.
    const inRound = rows.filter((row) => row.eventSeq !== null && (row.eventSeq === messageSeq || row.eventSeq === seq));
    // Round 1's comments are the record's, in the same order: whose comment a file was in.
    const commentIds = event.round === 1 && read !== undefined ? recordCommentsSchema.parse(read.comments).map((comment) => comment.id) : [];
    const authorOf = (commentId: string | null): string | null => {
      const index = commentId === null ? -1 : commentIds.indexOf(commentId);
      return index < 0 ? null : (event.comments[index]?.author ?? null);
    };
    const attachments = inRound.flatMap((row): TicketAttachmentView[] => {
      const from: TicketFileFrom = { where: whereOf(row.ticketWhere), author: row.ticketWhere === "comment" ? authorOf(row.ticketCommentId) : null };
      const name = nameOf(row.name);
      switch (row.state) {
        case "sent":
          return [{ state: "ready", file: fileViewOfRow(input.taskId, row), from }];
        case "left_out": {
          const reason = fileLeftOutReasonSchema.safeParse(row.reason);
          const leftOut = reason.success && reason.data !== "download-failed" && reason.data !== "unreadable" ? reason.data : "too-big";
          return [{ state: "left-out", name, size: row.size === 0 ? null : row.size, reason: leftOut, from }];
        }
        case "failed": {
          const retried = retryOf.get(row.id);
          return [
            {
              state: "failed",
              fileId: messageFileIdSchema.parse(row.id),
              name,
              from,
              retry: retried === undefined ? null : { fileId: messageFileIdSchema.parse(retried.id), state: retried.state === "sent" ? "ready" : "failed" },
            },
          ];
        }
        case "uploaded":
        case "expired":
          return [];
        default:
          return row.state satisfies never;
      }
    });
    const failedRows = inRound.filter((row) => row.state === "failed");
    const tried = failedRows.map(triesOf);
    const failure: TicketFailure | null =
      tried.length === 0 ? null : { status: null, tries: Math.max(...tried.map((one) => one.tries)), lastAt: Math.max(...tried.map((one) => one.lastAt)) };
    const stored = new Map(inRound.flatMap((row) => (row.state === "sent" && row.ticketSourceKey !== null ? [[row.ticketSourceKey, messageFileIdSchema.parse(row.id)] as const] : [])));
    const descriptionFiles = (event.description === null ? [] : urlsInText(event.description)).flatMap((url) => {
      const fileId = stored.get(ticketFileSourceKey(url));
      return fileId === undefined ? [] : [{ url, fileId }];
    });
    // Why the images went as files: the message's word; with no message (an outside start), what the decision would have been.
    const readyImages = inRound.filter((row) => row.state === "sent" && row.kind === "image" && isPromptImageContentType(row.contentType));
    const derived: ImagesNotSent | null = readyImages.length === 0 || readyImages.some((row) => row.asImage) ? null : model?.imageInput === "yes" ? "agent" : "model";
    const imagesNotSent = messageSeq === null ? derived : (imagesOf.get(messageSeq) ?? null);
    const unreadable = event.unreadable === true;
    return {
      round: event.round,
      reason: event.reason,
      seq,
      at,
      description: event.description,
      descriptionFiles,
      comments: event.comments,
      links: event.links,
      attachments,
      failure,
      filesNotFetched: event.filesNotFetched === true,
      unreadable,
      nothingNew:
        event.round > 1 && !unreadable && event.description === null && event.comments.length === 0 && event.links.length === 0 && event.files.length === 0 && event.leftOut.length === 0 && event.failed.length === 0,
      messageSeq,
      imagesNotSent,
      imagesAsFilesFor: imagesNotSent === "model" ? (model?.name ?? null) : null,
    };
  });
  const isDriver = task.driverMemberId === ctx.scope.memberId;
  const canSendUpdates = isDriver && task.kind === "code" && (task.state === "running" || task.state === "needs_you");
  return {
    state: rounds.length === 0 && task.prompt === null ? "fetching" : "read",
    ticketKey: ticket?.key ?? task.ticketKey ?? "",
    connection: ticket === null ? null : ticketConnectionOf(ticket.connection),
    limits: ticketFileLimits(settings.files),
    prompt: task.prompt,
    model,
    isDriver,
    canSendUpdates,
    canRetry: canSendUpdates && rows.some((row) => row.state === "failed" && !retryOf.has(row.id)),
    rounds,
  };
});

// ---------- the driver's presses ----------

const pressInput = z.strictObject({
  taskId: taskIdSchema,
  /** The press's own ID, so a double press reads once; one is made when it's left out. */
  requestId: z.uuid().optional(),
});

/** The newest round so far: the press's answer is the round after it. */
const lastRoundOf = async (db: Db, taskId: TaskId): Promise<number> => (await db.taskTicketRead.findFirst({ where: { taskId }, orderBy: { round: "desc" }, select: { round: true } }))?.round ?? 0;

const pressCodes = {
  "not-found": "NOT_FOUND",
  "not-a-ticket-task": "PRECONDITION_FAILED",
  "not-the-driver": "FORBIDDEN",
  "not-running": "CONFLICT",
  "nothing-failed": "PRECONDITION_FAILED",
} as const;

/** "Send ticket updates" (F-149/c8): the driver's, while the task runs or waits. */
export const ticketUpdatesProcedure = taskProcedure("read", pressInput).mutation(async ({ ctx, input }) => {
  const { db, ports } = ctx.deps;
  const afterRound = await lastRoundOf(db, input.taskId);
  const pressed = unwrap(await requestTicketUpdates({ db, jobs: ports.jobs }, ctx.scope, { taskId: input.taskId, requestId: input.requestId ?? randomUUID() }), pressCodes);
  return { requestId: pressed.requestId, afterRound };
});

/** "Retry" (F-149/c3): the driver's, while a failed file of the ticket waits for one. */
export const retryTicketFilesProcedure = taskProcedure("read", pressInput).mutation(async ({ ctx, input }) => {
  const { db, ports } = ctx.deps;
  const afterRound = await lastRoundOf(db, input.taskId);
  const pressed = unwrap(await retryTicketFiles({ db, jobs: ports.jobs }, ctx.scope, { taskId: input.taskId, requestId: input.requestId ?? randomUUID() }), pressCodes);
  return { requestId: pressed.requestId, afterRound };
});
