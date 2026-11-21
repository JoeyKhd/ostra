import type { Db } from "@ostra/db";
import { modelInputModalities, promptFilesOfMessage, taskSpecFilesOf } from "@ostra/domain";
import type { TaskSpecFilesCaps } from "@ostra/domain";
import { taskEventSchema, taskIdSchema } from "@ostra/protocol";
import type { InputModality, PendingMessage, PromptFiles, TaskSpecMessageFile, TaskSpecRestore } from "@ostra/protocol";

// The task spec's milestone 9 parts (ticket 11, F-148, ADR 0070): the files the runner writes under
// the workspace root's `.ostra/` before a session starts, and which prompt names which of them.
//
// - `files`: every sent file of the task, a member's and a ticket's, oldest first, so a fresh box
//   gets every earlier file back at its place (ADR 0039). Each blob is the task's, so the runner's
//   bulk downloads pass the lease's ownership check. Past `taskFilesMax` or `taskFilesTotalBytes`
//   the newest stay (the lead, 2026-11-21): the first prompt's files and every pending message's
//   always, then the others newest first, and the oldest are left out.
// - `promptFiles`: the session's first prompt's files, for a session that starts new (a new task's
//   first message). A reopen's message, and every message no turn answered, is a pending message of
//   the restore section, with its own files.
// - Every prompt's files are kept to those `files` carries: a file whose blob retention took is
//   never named, and a pending message left with no words and no file is dropped.
// - `agent.inputModalities`: the session's model's inputs (the catalog's, with an admin's "Reads
//   images"), for the agent's config (Q335).
//
// A spec with files goes only to a runner at minor 8: the dispatch reads the same rows
// (`taskHasFilesInTx`), and `isTaskOfferable` says `message-files`. Names and contents never reach a
// log line.

export type SpecFileParts = {
  /** Every sent file of the task; empty for a task with none, and then the spec has no `files`. */
  readonly files: readonly TaskSpecMessageFile[];
  /** The first prompt's files; `undefined` for none. */
  readonly promptFiles: PromptFiles | undefined;
  /** The restore section with each pending message's files kept to `files`; `undefined` as it came. */
  readonly restore: TaskSpecRestore | undefined;
};

/** A prompt's files kept to those the spec carries, or `undefined` when none is left. */
export const filesInSpec = (files: PromptFiles | undefined, carried: ReadonlySet<string>): PromptFiles | undefined => {
  if (files === undefined) {
    return undefined;
  }
  const fileIds = files.fileIds.filter((id) => carried.has(id));
  return fileIds.length === 0 ? undefined : { fileIds, images: files.images.filter((id) => fileIds.includes(id)) };
};

/** A pending message with its files kept to the spec's, or `null` when it's left with no words and no file. */
const pendingInSpec = (message: PendingMessage, carried: ReadonlySet<string>): PendingMessage | null => {
  const files = filesInSpec(message.files, carried);
  if (files === undefined && message.text.length === 0) {
    return null;
  }
  return { clientMessageId: message.clientMessageId, text: message.text, ...(files === undefined ? {} : { files }) };
};

/**
 * The files of the session's first member message, as the event recorded them: its first prompt's.
 * An outside start (F-012) has no member's message: the ticket's files went with its first read
 * (`ticket.context_read`, round 1), each going as an image as its row says (milestone 9's ticket 12).
 */
const firstPromptFilesOf = async (db: Pick<Db, "event" | "messageFile">, taskId: string, sessionId: string): Promise<PromptFiles | undefined> => {
  const first = await db.event.findFirst({ where: { taskId, sessionId, kind: { in: ["user.message", "ticket.context_read"] } }, orderBy: { seq: "asc" }, select: { payload: true } });
  const parsed = taskEventSchema.safeParse(first?.payload);
  if (!parsed.success) {
    return undefined;
  }
  if (parsed.data.kind === "user.message") {
    return promptFilesOfMessage(parsed.data.files);
  }
  if (parsed.data.kind !== "ticket.context_read" || parsed.data.reason !== "start" || parsed.data.files.length === 0) {
    return undefined;
  }
  const fileIds = parsed.data.files;
  const images = new Set((await db.messageFile.findMany({ where: { id: { in: [...fileIds] }, taskId, asImage: true }, select: { id: true } })).map((row) => row.id));
  return { fileIds: [...fileIds], images: fileIds.filter((id) => images.has(id)) };
};

export const specFileParts = async (
  db: Pick<Db, "messageFile" | "event">,
  task: { readonly id: string },
  session: { readonly id: string; readonly origin: "new" | "resumed" | "restored" | "rebuilt" },
  restore: TaskSpecRestore | undefined,
  caps?: TaskSpecFilesCaps,
): Promise<SpecFileParts> => {
  const firstPrompt = session.origin === "new" ? await firstPromptFilesOf(db, task.id, session.id) : undefined;
  // The files the session's prompts name stay in the spec whatever the task holds besides.
  const keep = new Set<string>([...(firstPrompt?.fileIds ?? []), ...(restore?.pendingMessages ?? []).flatMap((message) => message.files?.fileIds ?? [])]);
  const files = await taskSpecFilesOf(db, taskIdSchema.parse(task.id), { keep, ...(caps === undefined ? {} : { caps }) });
  const carried = new Set<string>(files.map((file) => file.fileId));
  const promptFiles = files.length > 0 ? filesInSpec(firstPrompt, carried) : undefined;
  return {
    files,
    promptFiles,
    restore:
      restore === undefined
        ? undefined
        : { ...restore, pendingMessages: restore.pendingMessages.flatMap((message) => pendingInSpec(message, carried) ?? []) },
  };
};

/** The spec's `agent.inputModalities`: the session's model's inputs; `["text"]` when nothing is known. */
export const specInputModalities = (model: { readonly adminImageInput: boolean | null; readonly catalogInputModalities: unknown }): InputModality[] => [
  ...modelInputModalities(model),
];
