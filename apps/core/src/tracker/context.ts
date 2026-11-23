import type { Logger, TicketContext } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  boxPathFor,
  contextReadLinks,
  fetchTicketFiles,
  isProgressComment,
  noTicketFiles,
  parentCriteriaOf,
  refinePrompt,
  renderTicketPrompt,
  ticketFileLimits,
  ticketFilesLeftOutLines,
  ticketTemplateFor,
  writeTicketStartInTx,
} from "@ostra/domain";
import type { ChangeNotices, Clock, FileSettings, JobQueue, TicketPromptContext } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";
import { FILES_ROOT_DIR, externalTicketIdSchema, leaseEpochSchema, memberIdSchema, projectIdSchema, ticketKeySchema } from "@ostra/protocol";
import { z } from "zod";

import { coreMessageFilesDeps } from "../agents/prompt-images.ts";
import type { BlobService } from "../blobs/blob-service.ts";
import type { DocumentTextReader } from "../files/text/index.ts";
import type { ConnectionTrackers } from "./connections.ts";
import { ticketReadPorts } from "./ticket-reads.ts";
import type { TicketReadsDeps } from "./ticket-reads.ts";

// `ticket.fetch-context` (F-064; milestone 9's ticket 12, F-149, F-150): a new ticket task's first
// prompt, the start's read of its ticket (round 1). It reads the ticket's full context through the
// adapter, with ostra's own comments and attachments told apart; fetches every file the ticket holds
// that the tracker's `ticketFiles` lets through, within the ticket's limits (`fetchTicketFiles`),
// each stored as a blob of the task with its kind told by its bytes and a document's text beside it;
// renders the prompt with the project's template (or the built-in one), naming the files left out
// or failed; and in one transaction writes the prompt on the task, the first `user.message` with the
// ticket's files (each at `ticket/<name>`), `ticket.context_read` (round 1, `start`), the
// `TaskTicketRead`, and `task.dispatch` (`writeTicketStartInTx`). Every piece of ticket text is
// untrusted: it's data inside the template's marked blocks, it never reaches a log line, and it
// never reaches a shell. A file that fails leaves a line in the prompt and a Retry in the thread,
// and the task still starts. A tracker that doesn't answer retries the job, and a retry after a
// partial run reuses the files it already stored.

/** The prompt's cap: the task spec's. */
const PROMPT_MAX_CHARS = 262_144;

export type FetchContextDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly trackers: Pick<ConnectionTrackers, "forConnection">;
  readonly blobs: Pick<BlobService, "put" | "delete">;
  /** Core's reader of documents' text (`createDocumentTextReader`). */
  readonly text: Pick<DocumentTextReader, "read">;
  /** The settings' file limits and `OSTRA_FILE_TEXT_EXTRACTION` (`settings.files`). */
  readonly files: FileSettings;
  readonly logger: Logger;
  /** Milestone 11 (F-008/c8): a token the tracker refuses (401) fails its connection at once (`failRefusedToken`). */
  readonly tokenRefused?: NonNullable<TicketReadsDeps["tokenRefused"]>;
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

/** An image of the ticket in the workspace: where under the workspace's root, and its safe name. */
type ImageInBox = { readonly path: string; readonly name: string };

/** The template's context from what the tracker said, and the ticket's images as the box holds them. */
export const promptContextOf = (
  context: TicketContext,
  images: readonly ImageInBox[],
  extra: {
    readonly instructions: string | null;
    readonly branch: string;
    readonly ownUserId?: string | null;
    /** Milestone 6 (F-077): a sub-issue's parent's accepted acceptance criteria. */
    readonly parentCriteria?: readonly { readonly text: string }[];
  },
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
  parentCriteria: extra.parentCriteria ?? [],
  // Milestone 9 (Q337): a link attachment goes as its title and URL; nothing behind it is fetched.
  links: contextReadLinks(context),
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
    files: [],
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
    const reads = ticketReadPorts(deps);
    const read = await reads.readTicket(owner);
    if (!read.ok && read.reason === "unavailable") {
      throw new Error(TRACKER_UNAVAILABLE);
    }
    const ticketContext = read.ok ? read.context : cachedContextOf(ticket);
    if (ticketContext === null) {
      context.logger.warn("ticket.fetch-context-skipped", { taskId: payload.taskId, reason: "ticket-unreadable" });
      return;
    }
    const ownUserId = read.ok ? read.ownUserId : null;

    // Every file the ticket holds, within its limits; a retry after a partial run reuses what it stored.
    const files = read.ok ? await fetchTicketFiles({ reads, limits: ticketFileLimits(deps.files) }, owner, read.context.files, read.capability) : noTicketFiles;
    // A project's own template may still list the images: each at its place under the workspace's
    // root, as the start's message places it (the ticket's folder is empty before its first read).
    const places = boxPathFor("ticket", 1, files.stored.map((file) => file.name));
    const images = files.stored.flatMap((file, index) => (file.kind === "image" ? [{ path: `${FILES_ROOT_DIR}/${places[index] ?? ""}`, name: file.name }] : []));

    const session = await deps.db.session.findFirst({ where: { id: payload.sessionId, taskId: payload.taskId }, select: { agentProfileId: true } });
    const profile =
      (session?.agentProfileId ?? null) === null
        ? null
        : await deps.db.agentProfile.findFirst({ where: { id: session?.agentProfileId ?? "", organizationId: payload.organizationId }, select: { instructions: true } });
    const project = await deps.db.project.findUniqueOrThrow({ where: { id: task.projectId }, select: { ticketTemplate: true } });
    // Milestone 6 (F-099): a refine task's first prompt is the refine prompt, around the same ticket.
    const repos = task.kind === "refine" ? await deps.db.taskRepo.findMany({ where: { taskId: task.id }, select: { repo: { select: { fullName: true, checkoutDir: true } } } }) : [];
    const rendered = task.kind === "refine" ? refinePrompt({ ticket: { key: ticket.key, title: ticketContext.ticket.title, description: ticketContext.ticket.description }, repos: repos.map((row) => row.repo) }) : renderTicketPrompt(
      ticketTemplateFor(project.ticketTemplate).template,
      promptContextOf(ticketContext, images, {
        instructions: profile?.instructions ?? null,
        branch: task.branchName,
        ownUserId,
        parentCriteria: await parentCriteriaOf(deps.db, { organizationId: payload.organizationId, parentTicketId: task.parentTicketId }),
      }),
    );
    // The files the agent doesn't have are named with why (F-149/c3); the runner's block names those it has.
    const leftOut = ticketFilesLeftOutLines(files);
    const prompt = (leftOut === "" ? rendered : `${rendered.replace(/\s+$/, "")}\n\n${leftOut}\n`).slice(0, PROMPT_MAX_CHARS);

    const outcome = await deps.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${payload.taskId} FOR UPDATE`;
      const fresh = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: payload.taskId } });
      if (fresh?.state !== "queued" || fresh.prompt !== null) {
        return "moved-on";
      }
      await tx.task.update({ where: { id: payload.taskId }, data: { prompt } });
      const creator = memberIdSchema.safeParse(fresh.creatorMemberId);
      await writeTicketStartInTx(
        tx,
        { files: coreMessageFilesDeps(deps.files) },
        {
          organizationId: payload.organizationId,
          projectId,
          taskId: payload.taskId,
          sessionId: payload.sessionId,
          memberId: creator.success ? creator.data : null,
          prompt,
          context: ticketContext,
          ownUserId,
          files,
          now: deps.clock.now(),
        },
      );
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
      files: files.stored.length,
      leftOut: files.notes.filter((note) => note.state === "left_out").length,
      failed: files.notes.filter((note) => note.state === "failed").length,
      fromCache: !read.ok,
    });
  };
