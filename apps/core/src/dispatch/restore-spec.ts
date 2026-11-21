import type { Db } from "@ostra/db";
import { buildRebuildPrompt, rebuildInputInTx, unansweredMessagesInTx } from "@ostra/domain";
import {
  blobIdSchema,
  gitShaSchema,
  httpUrlSchema,
  repoIdSchema,
  runnerLimits,
  sha256HexSchema,
  taskIdSchema,
  ticketFileNameSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { BlobRef, HiddenRefRestore, TaskSpecContextFile, TaskSpecRestore, TaskSpecTicket } from "@ostra/protocol";

// The task spec's milestone 2 parts (ticket 18): a ticket task's ticket and its images, and a
// reopen's restore section (ADR 0039). The dispatch chose the step and wrote it as the session's
// origin; this reads it back with what the step needs: the newest archive (for `restored`), each
// repo's hidden ref and the head it was saved on, and the member messages no turn answered. Every
// reopen's prompt is the rebuild template, so a runner whose resume or import fails falls back to it
// (ticket 24); a `resumed` or `restored` session never sends it.

/** The purpose a ticket image's blob is stored under (ticket 18's `ticket.fetch-context`). */
export const TICKET_FILE_PURPOSE = "ticket-file";

const extensionOf = (contentType: string): string => {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (type) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
};

/**
 * A ticket file's name in the workspace: made from its blob ID and its type, never from the
 * ticket's text (ticket 26). The prompt names it, and the runner writes it under `.ostra/ticket/`.
 */
export const ticketFileNameFor = (blobId: string, contentType: string): string => ticketFileNameSchema.parse(`${blobId}.${extensionOf(contentType)}`);

export type SpecMilestone2Parts = {
  readonly ticket: TaskSpecTicket | null;
  readonly contextFiles: readonly TaskSpecContextFile[];
  /** `undefined` for a session that starts new: the spec then has no restore section. */
  readonly restore: TaskSpecRestore | undefined;
  /** The rebuild template, for a reopen; `null` keeps the task's own prompt. */
  readonly prompt: string | null;
};

/** The task's newest session archive the blob store still holds, under the cap. */
export const newestArchive = async (db: Pick<Db, "session" | "blob">, task: { readonly id: string; readonly organizationId: string }): Promise<BlobRef | null> => {
  const archived = await db.session.findFirst({
    where: { taskId: task.id, archiveBlobId: { not: null } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { archiveBlobId: true },
  });
  const blobId = archived?.archiveBlobId ?? null;
  if (blobId === null) {
    return null;
  }
  const blob = await db.blob.findFirst({ where: { id: blobId, organizationId: task.organizationId, taskId: task.id }, select: { id: true, size: true, sha256: true } });
  const digest = sha256HexSchema.safeParse(blob?.sha256);
  if (blob === null || !digest.success || blob.size > runnerLimits.archiveMaxBytes) {
    return null;
  }
  return { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: digest.data };
};

export const specMilestone2Parts = async (
  db: Db,
  task: { readonly id: string; readonly organizationId: string; readonly ticketId: string | null },
  session: { readonly origin: "new" | "resumed" | "restored" | "rebuilt" },
): Promise<SpecMilestone2Parts> => {
  const taskId = taskIdSchema.parse(task.id);
  const ticketRow = task.ticketId === null ? null : await db.ticket.findUnique({ where: { id: task.ticketId }, select: { key: true, title: true, url: true } });
  const key = ticketKeySchema.safeParse(ticketRow?.key);
  const url = httpUrlSchema.safeParse(ticketRow?.url);
  const ticket: TaskSpecTicket | null =
    ticketRow !== null && key.success && url.success && ticketRow.title.trim() !== ""
      ? { key: key.data, title: ticketRow.title.slice(0, 1024), url: url.data }
      : null;
  const files = await db.blob.findMany({
    where: { taskId: task.id, organizationId: task.organizationId, purpose: TICKET_FILE_PURPOSE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: runnerLimits.ticketFilesMax,
    select: { id: true, contentType: true, size: true },
  });
  const contextFiles = files
    .filter((file) => file.size <= runnerLimits.ticketFileMaxBytes)
    .map((file) => ({ blobId: blobIdSchema.parse(file.id), path: ticketFileNameFor(file.id, file.contentType), contentType: file.contentType, size: file.size }));
  if (session.origin === "new") {
    return { ticket, contextFiles, restore: undefined, prompt: null };
  }

  const repos = await db.taskRepo.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" }, select: { repoId: true, hiddenRefSha: true, hiddenRefBaseSha: true } });
  const hiddenRefs: HiddenRefRestore[] = repos.flatMap((repo) => {
    const sha = gitShaSchema.safeParse(repo.hiddenRefSha);
    const baseSha = gitShaSchema.safeParse(repo.hiddenRefBaseSha);
    return sha.success && baseSha.success ? [{ repoId: repoIdSchema.parse(repo.repoId), sha: sha.data, baseSha: baseSha.data }] : [];
  });
  return db.$transaction(async (tx) => {
    const pending = await unansweredMessagesInTx(tx, taskId);
    const rebuild = buildRebuildPrompt(await rebuildInputInTx(tx, taskId, { leaveOut: new Set(pending.map((message) => message.clientMessageId)) }));
    return {
      ticket,
      contextFiles,
      restore: {
        origin: session.origin,
        archive: session.origin === "restored" ? await newestArchive(tx, task) : null,
        hiddenRefs,
        // Milestone 9 (F-148, ADR 0070): each with its files, which the spec keeps to those it carries (`files-spec.ts`).
        pendingMessages: pending.map((message) => ({ clientMessageId: message.clientMessageId, text: message.text, ...(message.files === undefined ? {} : { files: message.files }) })),
      },
      prompt: rebuild.prompt,
    };
  });
};
