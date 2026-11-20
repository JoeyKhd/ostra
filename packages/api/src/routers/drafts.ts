import {
  addDraftImage,
  applyDraft,
  createTicketFromDraft,
  DRAFT_IMAGE_MAX_BYTES,
  draftOfRow,
  draftTicketText,
  editDraft,
  markTicketReady,
  parseBoardMapping,
  removeDraftImage,
  taskPageUrl,
} from "@ostra/domain";
import type { M6Deps } from "@ostra/domain";
import {
  boardIdSchema,
  connectionIdSchema,
  memberIdSchema,
  refineDraftSchema,
  taskIdSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { MemberId, OrganizationId, RefineDraft } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { router, taskProcedure, unwrap } from "../trpc/init.ts";

// F-099 (milestone 6's ticket 27; spec section 4, "A refine task"): a refine task's draft in the
// panel. A version with its fields, every version with its source, the images, and the ticket's
// preview: the description as the tracker will show it, rendered by the same function
// `draft.apply` writes with (the domain's `draftTicketText`). A member saves a version of their own
// (`drafts.save`), adds and removes images (milestone 2's blobs, stored by core's blob service), then
// "Update ticket", "Mark ready", or, on a prompt refine task, "Create ticket". Each action is the
// domain's, refused once the task is done, and audited. Any member who can open the project may edit
// and apply: the draft's owner is who it's put in front of, not who may act on it. A draft's text
// never reaches a log line.

/** The image types a draft takes: what a tracker shows inline. */
const draftImageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** A 10 MiB image as base64, with its padding. */
const DRAFT_IMAGE_MAX_BASE64 = Math.ceil(DRAFT_IMAGE_MAX_BYTES / 3) * 4;

const deps = (ctx: Context): M6Deps => ({ db: ctx.deps.db, ...ctx.deps.ports });

const person = (members: ReadonlyMap<string, string>, id: string | null): { readonly memberId: MemberId; readonly name: string } | null =>
  id === null ? null : { memberId: memberIdSchema.parse(id), name: members.get(id) ?? "A former member" };

/** What the tracker of the task's board can hold, for the preview. A board whose connection isn't usable is previewed as Linear holds a draft. */
const trackerFields = async (ctx: Context, organizationId: OrganizationId, connectionId: string | null): Promise<{ readonly acceptanceCriteriaField: boolean; readonly attachments: boolean }> => {
  if (connectionId === null) {
    return { acceptanceCriteriaField: false, attachments: true };
  }
  const lookup = await ctx.deps.trackers.forConnection(organizationId, connectionIdSchema.parse(connectionId));
  if (!lookup.ok) {
    return { acceptanceCriteriaField: false, attachments: true };
  }
  const caps = lookup.tracker.tracker.capabilities;
  return { acceptanceCriteriaField: caps.ticketFields.acceptanceCriteria, attachments: caps.attachments };
};

export const draftsRouter = router({
  /**
   * The draft: one version (`null`: the latest) with its fields and images, every version with its
   * source and who made it, and the preview of what "Update ticket" writes.
   */
  get: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, version: z.number().int().positive().nullable() })).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const task = await db.task.findFirst({
      where: { id: ctx.task.taskId, organizationId },
      select: { id: true, kind: true, state: true, source: true, title: true, ticketId: true, boardId: true },
    });
    if (task?.kind !== "refine") {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such refine task" });
    }
    const versions = await db.refineDraft.findMany({
      where: { taskId: task.id, organizationId },
      orderBy: { version: "asc" },
      select: { id: true, version: true, source: true, editedByMemberId: true, appliedAt: true, appliedByMemberId: true, readyAt: true, createdAt: true },
    });
    const latest = versions.at(-1) ?? null;
    const chosen = input.version === null ? latest : (versions.find((row) => row.version === input.version) ?? null);
    if (input.version !== null && chosen === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such version of the draft" });
    }
    const row = chosen === null ? null : await db.refineDraft.findUniqueOrThrow({ where: { id: chosen.id } });
    const fields: RefineDraft | null = row === null ? null : draftOfRow(row);
    const images =
      row === null
        ? []
        : await db.refineDraftImage.findMany({
            where: { draftId: row.id, organizationId },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, contentType: true, size: true, attachedAt: true },
          });
    const memberIds = [...new Set(versions.flatMap((version) => [version.editedByMemberId, version.appliedByMemberId]).filter((id): id is string => id !== null))];
    const members = new Map(
      (memberIds.length === 0 ? [] : await db.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, user: { select: { name: true } } } })).map((member) => [member.id, member.user.name]),
    );
    const ticket = task.ticketId === null ? null : await db.ticket.findFirst({ where: { id: task.ticketId, organizationId }, select: { key: true, title: true, url: true } });
    const board = task.boardId === null ? null : await db.board.findFirst({ where: { id: task.boardId, organizationId }, select: { connectionId: true, statusMap: true } });
    const tracker = await trackerFields(ctx, organizationId, board?.connectionId ?? null);
    const taskUrl = taskPageUrl(ctx.deps.settings.publicUrl, ctx.task.taskId);
    const unattached = tracker.attachments ? [] : images.filter((image) => image.attachedAt === null).map((image) => image.name);
    const text = fields === null ? null : draftTicketText(fields, { acceptanceCriteriaField: tracker.acceptanceCriteriaField, unattachedImages: unattached, taskUrl });
    return {
      taskId: ctx.task.taskId,
      title: task.title,
      state: task.state,
      /** Done: the draft went to the tracker, and every action is refused until it's reopened. */
      done: task.state === "done",
      source: task.source,
      ticket: ticket === null ? null : { key: ticketKeySchema.parse(ticket.key), title: ticket.title, url: ticket.url },
      /** Whether "Mark ready" has a status to move to: a project admin picks one on the board otherwise. */
      readyStatus: board === null ? false : parseBoardMapping(board.statusMap)?.ready !== undefined,
      latestVersion: latest?.version ?? null,
      versions: versions.map((version) => ({
        version: version.version,
        source: version.source,
        editedBy: person(members, version.editedByMemberId),
        createdAt: version.createdAt.getTime(),
        appliedAt: version.appliedAt?.getTime() ?? null,
        appliedBy: person(members, version.appliedByMemberId),
        readyAt: version.readyAt?.getTime() ?? null,
      })),
      draft:
        chosen === null || fields === null
          ? null
          : {
              version: chosen.version,
              source: chosen.source,
              fields,
              images: images.map((image) => ({ imageId: image.id, name: image.name, contentType: image.contentType, size: image.size, attachedAt: image.attachedAt?.getTime() ?? null })),
            },
      /** The ticket as the tracker will hold it once this version is written. */
      preview:
        text === null || fields === null
          ? null
          : {
              description: text.description,
              acceptanceCriteria: text.acceptanceCriteria,
              subTickets: fields.subTickets.map((sub) => ({ title: sub.title, description: sub.description })),
              attachments: tracker.attachments ? images.filter((image) => image.attachedAt === null).map((image) => image.name) : [],
            },
      imagesMax: ctx.deps.settings.team.draftImagesMax,
      imageMaxBytes: DRAFT_IMAGE_MAX_BYTES,
    };
  }),

  /** A member's version, on the one they read (`baseVersion`): a newer one in between is `CONFLICT`. */
  save: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, baseVersion: z.number().int().positive(), fields: refineDraftSchema })).mutation(async ({ ctx, input }) => {
    const saved = unwrap(await editDraft(deps(ctx), ctx.scope, { taskId: ctx.task.taskId, baseVersion: input.baseVersion, draft: input.fields }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      conflict: "CONFLICT",
      "invalid-input": "BAD_REQUEST",
      "task-done": "PRECONDITION_FAILED",
    });
    return { draftId: saved.draftId, version: saved.version };
  }),

  /** An image on the latest version: stored by core's blob service, at most `OSTRA_DRAFT_IMAGES_MAX` a draft and 10 MiB each. */
  addImage: taskProcedure(
    "read",
    z.strictObject({
      taskId: taskIdSchema,
      name: z.string().trim().min(1).max(200),
      contentType: z.enum(draftImageTypes),
      /** The image's bytes, base64. */
      data: z.base64().max(DRAFT_IMAGE_MAX_BASE64 + 4),
    }),
  ).mutation(async ({ ctx, input }) => {
    const bytes = new Uint8Array(Buffer.from(input.data, "base64"));
    if (bytes.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "The image is empty" });
    }
    if (bytes.length > DRAFT_IMAGE_MAX_BYTES) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "An image of a draft is at most 10 MiB" });
    }
    const max = ctx.deps.settings.team.draftImagesMax;
    // Counted before the upload too, so a full draft stores no blob; the domain counts again under the lock.
    const latest = await ctx.deps.db.refineDraft.findFirst({ where: { taskId: ctx.task.taskId, organizationId: ctx.scope.organizationId }, orderBy: { version: "desc" }, select: { id: true } });
    if (latest !== null && (await ctx.deps.db.refineDraftImage.count({ where: { draftId: latest.id } })) >= max) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `A draft holds at most ${String(max)} images` });
    }
    const stored = await ctx.deps.blobStore.upload({ organizationId: ctx.scope.organizationId, purpose: "draft-image", bytes });
    switch (stored.kind) {
      case "too-large":
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "An image of a draft is at most 10 MiB" });
      case "unavailable":
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The image couldn't be stored: try again" });
      case "stored":
        break;
      default:
        return stored satisfies never;
    }
    const added = unwrap(
      await addDraftImage(deps(ctx), ctx.scope, { taskId: ctx.task.taskId, blobId: stored.blobId, name: input.name, contentType: input.contentType, size: stored.size }, { max }),
      { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "limit-reached": "BAD_REQUEST", "task-done": "PRECONDITION_FAILED" },
    );
    return { imageId: added.imageId, version: added.version };
  }),

  /** Takes an image off the latest version. */
  removeImage: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, imageId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    const removed = unwrap(await removeDraftImage(deps(ctx), ctx.scope, { taskId: ctx.task.taskId, imageId: input.imageId }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "task-done": "PRECONDITION_FAILED",
    });
    return { version: removed.version };
  }),

  /** "Update ticket": the version, which must be the latest, goes to the ticket through `draft.apply`. The task is done. */
  updateTicket: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, version: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const applied = unwrap(await applyDraft(deps(ctx), ctx.scope, { taskId: ctx.task.taskId, version: input.version }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "stale-version": "CONFLICT",
      "no-ticket": "PRECONDITION_FAILED",
      "task-done": "PRECONDITION_FAILED",
    });
    return { appliedAt: applied.appliedAt };
  }),

  /** "Mark ready": the ticket moves to the board's ready status. The task is done. */
  markReady: taskProcedure("read", z.strictObject({ taskId: taskIdSchema })).mutation(async ({ ctx }) => {
    const ready = unwrap(await markTicketReady(deps(ctx), ctx.scope, { taskId: ctx.task.taskId }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-applied": "PRECONDITION_FAILED",
      "no-ready-status": "PRECONDITION_FAILED",
      "task-done": "PRECONDITION_FAILED",
    });
    return { readyAt: ready.readyAt };
  }),

  /** "Create ticket" on a prompt refine task: the version, the latest, as a new ticket on one of the project's boards. The task is done. */
  createTicket: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, version: z.number().int().positive(), boardId: boardIdSchema })).mutation(async ({ ctx, input }) => {
    const made = unwrap(await createTicketFromDraft(deps(ctx), ctx.scope, { taskId: ctx.task.taskId, version: input.version, boardId: input.boardId, publicUrl: ctx.deps.settings.publicUrl }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "stale-version": "CONFLICT",
      "has-ticket": "PRECONDITION_FAILED",
      "task-done": "PRECONDITION_FAILED",
    });
    return { ticketWriteId: made.ticketWriteId };
  }),
});
