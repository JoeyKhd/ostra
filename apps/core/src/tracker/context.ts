import { randomUUID } from "node:crypto";

import type { Logger, TicketContext, TicketImage } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { appendServerEvent, isProgressComment, markTicketInline, renderTicketPrompt, ticketTemplateFor } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue, TicketPromptContext } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import {
  TICKET_FILES_DIR,
  clientMessageIdSchema,
  connectionIdSchema,
  externalTicketIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  projectIdSchema,
  runnerLimits,
  ticketKeySchema,
} from "@ostra/protocol";
import type { ExternalTicketId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { BlobService } from "../blobs/blob-service.ts";
import { TICKET_FILE_PURPOSE, ticketFileNameFor } from "../dispatch/restore-spec.ts";
import type { ConnectionTrackers } from "./connections.ts";

// `ticket.fetch-context` (ticket 18, F-064): a new ticket task's first prompt. It reads the ticket's
// full context through the adapter, copies each image into the blob store as a blob of the task
// (at most 20, 10 MiB each: spec section 11, item 9), renders the prompt with the project's
// template (or the built-in one), stores it on the task with the first `user.message`, and sends
// `task.dispatch`. Every piece of ticket text is untrusted: it's data inside the template's marked
// blocks, it never reaches a log line, and it never reaches a shell. An image that can't be copied
// leaves a line in the prompt saying so, and the task still starts.

/** At most this many images per ticket (spec section 11, item 9): a working value. */
export const TICKET_IMAGES_MAX = Math.min(20, runnerLimits.ticketFilesMax);
/** At most this many bytes per image: a working value. */
export const TICKET_IMAGE_MAX_BYTES = Math.min(10 * 1024 * 1024, runnerLimits.ticketFileMaxBytes);
/** The prompt's cap: the task spec's. */
const PROMPT_MAX_CHARS = 262_144;

export type FetchContextDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly trackers: Pick<ConnectionTrackers, "forConnection">;
  readonly blobs: Pick<BlobService, "put">;
  readonly logger: Logger;
};

/** Thrown so the queue retries: the tracker didn't answer, and nothing was written. */
export const TRACKER_UNAVAILABLE = "the tracker didn't answer; the job retries";

const labelsSchema = z.array(z.string());

/** Linear's scale, as words for the template. */
const priorityLabel = (priority: number | null): string | null => {
  switch (priority ?? 0) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    default:
      return null;
  }
};

type CopiedImage = { readonly path: string; readonly name: string };

/** A file fetched with the connection's credential, or why it wasn't: a code, never content. */
type Download = (
  url: string,
  maxBytes: number,
) => Promise<{ readonly ok: true; readonly bytes: Uint8Array; readonly contentType: string | null } | { readonly ok: false; readonly reason: string }>;

/** Copies the ticket's images into the blob store; one that can't be copied is named in `failed`. */
const copyImages = async (
  deps: FetchContextDeps,
  owner: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly taskId: TaskId },
  images: readonly TicketImage[],
  download: Download,
): Promise<{ readonly copied: readonly CopiedImage[]; readonly failed: readonly string[] }> => {
  const copied: CopiedImage[] = [];
  const failed: string[] = [];
  for (const image of images.slice(0, TICKET_IMAGES_MAX)) {
    const file = await download(image.url, TICKET_IMAGE_MAX_BYTES);
    if (!file.ok) {
      failed.push(`${image.name} (${file.reason})`);
      continue;
    }
    const contentType = file.contentType ?? image.contentType ?? "application/octet-stream";
    const stored = await deps.blobs.put(
      { organizationId: owner.organizationId, task: { projectId: owner.projectId, taskId: owner.taskId } },
      { purpose: TICKET_FILE_PURPOSE, contentType, bytes: file.bytes },
    );
    if (!stored.ok) {
      failed.push(`${image.name} (${stored.error})`);
      continue;
    }
    copied.push({ path: `${TICKET_FILES_DIR}/${ticketFileNameFor(stored.value.blobId, contentType)}`, name: image.name });
  }
  if (images.length > TICKET_IMAGES_MAX) {
    failed.push(`${String(images.length - TICKET_IMAGES_MAX)} more beyond the first ${String(TICKET_IMAGES_MAX)}`);
  }
  return { copied, failed };
};

/** The template's context from what the tracker said, and the images as copied. */
export const promptContextOf = (
  context: TicketContext,
  images: readonly CopiedImage[],
  extra: { readonly instructions: string | null; readonly branch: string; readonly ownUserId?: string | null },
): TicketPromptContext => ({
  ticket: {
    key: context.ticket.key,
    title: context.ticket.title,
    url: context.ticket.url,
    status: context.ticket.status.name,
    priority: priorityLabel(context.ticket.priority),
    description: context.ticket.description,
  },
  labels: context.ticket.labels.map((name) => ({ name })),
  // ostra's own comments aren't the ticket's: its progress comment (by its marker), and anything its
  // app user wrote.
  comments: context.comments
    .filter((comment) => !isProgressComment(comment.body) && ((extra.ownUserId ?? null) === null || comment.author?.id !== extra.ownUserId))
    .map((comment) => ({
    author: comment.author?.name ?? "Someone",
    body: comment.body,
    date: new Date(comment.createdAt).toISOString().slice(0, 10),
  })),
  parent: context.parent === null ? null : { key: context.parent.key, title: context.parent.title, url: context.parent.url },
  children: context.children.map((child) => ({ key: child.key, title: child.title, url: child.url })),
  linked: context.linked.map((link) => ({ key: link.ticket.key, title: link.ticket.title, url: link.ticket.url, relation: link.kind })),
  images,
  instructions: extra.instructions,
  task: { branch: extra.branch },
});

/** The context from the ticket cache's row alone, when the tracker no longer has the ticket. */
const cachedContextOf = (row: {
  readonly externalId: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly statusId: string | null;
  readonly statusName: string | null;
  readonly priority: number | null;
  readonly labels: unknown;
}): TicketContext | null => {
  const externalId = externalTicketIdSchema.safeParse(row.externalId);
  const key = ticketKeySchema.safeParse(row.key);
  if (!externalId.success || !key.success) {
    return null;
  }
  const labels = labelsSchema.safeParse(row.labels);
  return {
    ticket: {
      externalId: externalId.data,
      key: key.data,
      title: row.title,
      description: row.description,
      status: { id: row.statusId ?? "", name: row.statusName ?? "", category: "open" },
      url: row.url,
      priority: row.priority,
      parentKey: null,
      parentExternalId: null,
      labels: labels.success ? labels.data : [],
      updatedAt: 0,
    },
    comments: [],
    attachments: [],
    images: [],
    parent: null,
    children: [],
    linked: [],
  };
};

export const fetchContextHandler =
  (deps: FetchContextDeps): JobHandler<"ticket.fetch-context"> =>
  async (context) => {
    const { payload } = context;
    const task = await deps.db.task.findFirst({ where: { id: payload.taskId, organizationId: payload.organizationId } });
    const ticketId = task?.ticketId ?? null;
    if (task === null || ticketId === null || task.boardId === null) {
      context.logger.info("ticket.fetch-context-skipped", { taskId: payload.taskId, reason: "not-a-ticket-task" });
      return;
    }
    if (task.state !== "queued" || task.prompt !== null) {
      context.logger.info("ticket.fetch-context-skipped", { taskId: payload.taskId, reason: "already-rendered" });
      return;
    }
    const ticket = await deps.db.ticket.findFirst({ where: { id: ticketId, organizationId: payload.organizationId } });
    const board = await deps.db.board.findFirst({ where: { id: task.boardId, organizationId: payload.organizationId } });
    if (ticket === null || board === null) {
      context.logger.warn("ticket.fetch-context-skipped", { taskId: payload.taskId, reason: "ticket-gone" });
      return;
    }
    const projectId = projectIdSchema.parse(task.projectId);
    const owner = { organizationId: payload.organizationId, projectId, taskId: payload.taskId };

    // The context, through the adapter; the cache's row when the tracker can't find the ticket.
    const lookup = await deps.trackers.forConnection(payload.organizationId, connectionIdSchema.parse(board.connectionId));
    let ticketContext: TicketContext | null = null;
    let download: Download = () => Promise.resolve({ ok: false, reason: "the tracker isn't connected" });
    if (lookup.ok) {
      const tracker = lookup.value.tracker;
      const externalId: ExternalTicketId = externalTicketIdSchema.parse(ticket.externalId);
      const read = await tracker.getTicketContext({ externalId: board.externalId }, { externalId });
      if (read.ok) {
        ticketContext = read.value;
      } else if (read.error.code === "rate-limited" || read.error.code === "unavailable") {
        throw new Error(TRACKER_UNAVAILABLE);
      }
      download = async (url, maxBytes) => {
        const file = await tracker.downloadFile(url, maxBytes);
        return file.ok ? { ok: true, bytes: file.value.bytes, contentType: file.value.contentType } : { ok: false, reason: file.error.code };
      };
    } else if (lookup.reason !== "not-active" && lookup.reason !== "not-found") {
      throw new Error(TRACKER_UNAVAILABLE);
    }
    ticketContext ??= cachedContextOf(ticket);
    if (ticketContext === null) {
      context.logger.warn("ticket.fetch-context-skipped", { taskId: payload.taskId, reason: "ticket-unreadable" });
      return;
    }

    // A retry after a partial run reuses the images already copied: none is stored twice.
    const already = await deps.db.blob.findMany({
      where: { taskId: payload.taskId, organizationId: payload.organizationId, purpose: TICKET_FILE_PURPOSE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, contentType: true },
    });
    const images =
      already.length > 0
        ? {
            copied: already.map((blob, index) => ({
              path: `${TICKET_FILES_DIR}/${ticketFileNameFor(blob.id, blob.contentType)}`,
              name: ticketContext.images[index]?.name ?? "image",
            })),
            failed: [],
          }
        : await copyImages(deps, owner, ticketContext.images, download);

    const session = await deps.db.session.findFirst({ where: { id: payload.sessionId, taskId: payload.taskId }, select: { agentProfileId: true } });
    const profile =
      (session?.agentProfileId ?? null) === null
        ? null
        : await deps.db.agentProfile.findFirst({ where: { id: session?.agentProfileId ?? "", organizationId: payload.organizationId }, select: { instructions: true } });
    const project = await deps.db.project.findUniqueOrThrow({ where: { id: task.projectId }, select: { ticketTemplate: true } });
    const rendered = renderTicketPrompt(
      ticketTemplateFor(project.ticketTemplate).template,
      promptContextOf(ticketContext, images.copied, {
        instructions: profile?.instructions ?? null,
        branch: task.branchName,
        ownUserId: lookup.ok ? lookup.value.ownUserId : null,
      }),
    );
    const failedLine =
      images.failed.length === 0
        ? ""
        : `\n\n(ostra couldn't copy ${String(images.failed.length)} of the ticket's images into the workspace: ${images.failed.map(markTicketInline).join(", ")}.)\n`;
    const prompt = `${rendered}${failedLine}`.slice(0, PROMPT_MAX_CHARS);

    const outcome = await deps.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${payload.taskId} FOR UPDATE`;
      const fresh = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: payload.taskId } });
      if (fresh?.state !== "queued" || fresh.prompt !== null) {
        return "moved-on";
      }
      await tx.task.update({ where: { id: payload.taskId }, data: { prompt } });
      const creator = memberIdSchema.safeParse(fresh.creatorMemberId);
      if (creator.success) {
        // The first message is the rendered ticket, as a prompt task's is its prompt.
        await appendServerEvent(tx, {
          organizationId: payload.organizationId,
          projectId,
          taskId: payload.taskId,
          sessionId: payload.sessionId,
          at: deps.clock.now(),
          event: { kind: "user.message", memberId: creator.data, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: prompt, delivery: "immediate" },
        });
      }
      await deps.jobs.enqueueInTx(tx, "task.dispatch", {
        organizationId: payload.organizationId,
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        leaseEpoch: leaseEpochSchema.parse(fresh.leaseEpoch + 1),
      });
      await deps.notices.emitInTx(tx, { organizationId: payload.organizationId, projectId, entity: "task", entityId: payload.taskId });
      return "rendered";
    });
    // IDs and counts only: never the ticket's text, never a file name.
    context.logger.info("ticket.fetch-context", {
      taskId: payload.taskId,
      outcome,
      images: images.copied.length,
      imagesFailed: images.failed.length,
      fromCache: !lookup.ok,
    });
  };
