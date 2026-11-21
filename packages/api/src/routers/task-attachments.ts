import type { Db, DbEnum } from "@ostra/db";
import { addAttachmentToDraft, attachmentContentTypes, proposeAppProcess, taskAppSupport } from "@ostra/domain";
import type { TaskAppSupport } from "@ostra/domain";
import {
  attachmentIdSchema,
  attachmentKindSchema,
  attachmentSourceSchema,
  draftIdSchema,
  draftImageIdSchema,
  environmentProposalIdSchema,
  memberIdSchema,
  previewKeySchema,
  taskIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { AttachmentSource, OrganizationId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { taskProcedure, unwrap } from "../trpc/init.ts";

// Milestone 8, ticket 16 (F-121, F-140, ADR 0068): a task's screenshots and recordings as the thread
// shows them, "Add to draft" on a refine task, and "Keep it" on a port the agent announced.
//
// - `tasks.attachments`: every attachment of a task a member can open, oldest first, each with its
//   kind, who took it, what it shows, its sizes, its caption, the browser that took it and its turn,
//   and where it downloads (the web app's route, `serveTaskAttachment`, which serves the blob as a
//   file of its kind's fixed type, never as a page). Beside them, whether the task's runner can run
//   the app at all (`taskAppSupport`): a runner below minor 7 needs upgrading, in the page's words.
// - `tasks.attachmentToDraft`: a screenshot among the refine draft's images, for anyone who may edit
//   the draft (milestone 6's rule: any member who can open the project).
// - `tasks.keepPreview`: "Keep it", an environment proposal of the one process, for any member who
//   can open the task; a project admin decides it.
//
// A caption is the agent's words: it goes to the project's members and never to a log line.

/** Where an attachment downloads: the web app's route, after it checks the caller may open the task. */
export const attachmentDownloadPath = (taskId: string, attachmentId: string): string => `/api/tasks/${taskId}/attachments/${encodeURIComponent(attachmentId)}`;

const sourceFromDb = {
  agent: "agent",
  after_turn: "after-turn",
  member: "member",
} as const satisfies Readonly<Record<DbEnum.AttachmentSource, AttachmentSource>>;

/** What a picture shows: an app process, a port the agent announced, or a service with a web UI. */
const attachmentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("process"), name: z.string() }),
  z.object({ kind: z.literal("port"), port: z.number().int() }),
  z.object({ kind: z.literal("service"), name: z.string() }),
]);
type AttachmentTarget = z.infer<typeof attachmentTargetSchema>;

export const attachmentViewSchema = z.object({
  attachmentId: attachmentIdSchema,
  /** The task it's a blob of: the review task's, for a finding's. */
  taskId: taskIdSchema,
  kind: attachmentKindSchema,
  source: attachmentSourceSchema,
  target: attachmentTargetSchema,
  /** The path it was taken at, on the app's own host. */
  path: z.string(),
  /** In CSS pixels. */
  width: z.number().int(),
  height: z.number().int(),
  /** The blob's size in bytes. */
  bytes: z.number().int(),
  /** The type it downloads as: a screenshot's PNG, a recording's frame reel. */
  contentType: z.string(),
  /** A recording's length and frames; `null` for a screenshot. */
  durationMs: z.number().int().nullable(),
  frameCount: z.number().int().nullable(),
  /** The agent's caption. Shown to the project's members; never logged. */
  caption: z.string().nullable(),
  /** The browser and the version that took it (F-121). */
  browser: z.object({ name: z.string(), version: z.string() }),
  /** The turn it was taken in, to place it in the thread; `null` for a member's from the pane. */
  turn: z.object({ turnId: turnIdSchema, ordinal: z.number().int(), startSeq: z.number().int() }).nullable(),
  /** The member who took it from the pane. */
  takenBy: z.object({ memberId: memberIdSchema, name: z.string() }).nullable(),
  /** Whether "Add to draft" put it among a draft's images. */
  inDraft: z.boolean(),
  /** Ticket 17: the draft image "Add to draft" made of it, so the draft shows the picture among its images. */
  draftImageId: draftImageIdSchema.nullable(),
  /** Epoch ms. */
  createdAt: z.number().int(),
  /** The web app's route that downloads it. */
  downloadPath: z.string(),
});
export type AttachmentView = z.infer<typeof attachmentViewSchema>;

const targetOf = (row: { readonly targetKind: DbEnum.PreviewTargetKind; readonly targetName: string | null; readonly port: number | null }): AttachmentTarget | null => {
  switch (row.targetKind) {
    case "process":
    case "service":
      return row.targetName === null ? null : { kind: row.targetKind, name: row.targetName };
    case "port":
      return row.port === null ? null : { kind: "port", port: row.port };
    default:
      return row.targetKind satisfies never;
  }
};

/**
 * The attachments of some of an organization's tasks, oldest first, as the panel shows them:
 * `taskIds` the tasks, and `attachmentIds` (when given) the ones asked for. A row whose target no
 * longer reads is left out. The caller has checked the tasks are the member's to open.
 */
export const attachmentViewsOf = async (
  db: Db,
  organizationId: OrganizationId,
  taskIds: readonly TaskId[],
  attachmentIds?: readonly string[],
): Promise<readonly AttachmentView[]> => {
  if (taskIds.length === 0 || attachmentIds?.length === 0) {
    return [];
  }
  const rows = await db.taskAttachment.findMany({
    where: { organizationId, taskId: { in: [...taskIds] }, ...(attachmentIds === undefined ? {} : { attachmentId: { in: [...attachmentIds] } }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2_000,
    select: {
      taskId: true,
      attachmentId: true,
      kind: true,
      source: true,
      targetKind: true,
      targetName: true,
      port: true,
      path: true,
      width: true,
      height: true,
      durationMs: true,
      frameCount: true,
      caption: true,
      browserName: true,
      browserVersion: true,
      turnId: true,
      memberId: true,
      draftImageId: true,
      createdAt: true,
      blob: { select: { size: true } },
    },
  });
  const turnIds = [...new Set(rows.flatMap((row) => (row.turnId === null ? [] : [row.turnId])))];
  const turns = turnIds.length === 0 ? [] : await db.turn.findMany({ where: { organizationId, id: { in: turnIds } }, select: { id: true, ordinal: true, startSeq: true } });
  const memberIds = [...new Set(rows.flatMap((row) => (row.memberId === null ? [] : [row.memberId])))];
  const members =
    memberIds.length === 0 ? [] : await db.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, user: { select: { name: true } } } });
  return rows.flatMap((row): AttachmentView[] => {
    const target = targetOf(row);
    if (target === null) {
      return [];
    }
    const turn = turns.find((one) => one.id === row.turnId);
    return [
      {
        attachmentId: attachmentIdSchema.parse(row.attachmentId),
        taskId: taskIdSchema.parse(row.taskId),
        kind: row.kind,
        source: sourceFromDb[row.source],
        target,
        path: row.path,
        width: row.width,
        height: row.height,
        bytes: row.blob.size,
        contentType: attachmentContentTypes[row.kind],
        durationMs: row.durationMs,
        frameCount: row.frameCount,
        caption: row.caption,
        browser: { name: row.browserName, version: row.browserVersion },
        turn: turn === undefined ? null : { turnId: turnIdSchema.parse(turn.id), ordinal: turn.ordinal, startSeq: turn.startSeq },
        takenBy: row.memberId === null ? null : { memberId: memberIdSchema.parse(row.memberId), name: members.find((one) => one.id === row.memberId)?.user.name ?? "A former member" },
        inDraft: row.draftImageId !== null,
        draftImageId: row.draftImageId === null ? null : draftImageIdSchema.parse(row.draftImageId),
        createdAt: row.createdAt.getTime(),
        downloadPath: attachmentDownloadPath(row.taskId, row.attachmentId),
      },
    ];
  });
};

/** Whether the task's runner can run its app (F-140), with the page's words when it can't. */
export const taskAppSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supported") }),
  /** The environment declares no app process. */
  z.object({ kind: z.literal("no-app") }),
  /** The task hasn't run on a runner yet. */
  z.object({ kind: z.literal("no-runner") }),
  /** A runner below protocol minor 7: the task runs as before, without its app; the page says it needs upgrading. */
  z.object({ kind: z.literal("runner-needs-upgrade"), words: z.string() }),
]);
const supportView = (support: TaskAppSupport): z.infer<typeof taskAppSupportSchema> => support;

const taskInput = z.strictObject({ taskId: taskIdSchema });

const previewDeps = (deps: ApiDeps) => ({ db: deps.db, ...deps.ports, settings: deps.settings.previews });

/** The thread's screenshots and recordings (F-121), and whether the task's runner runs its app (F-140). */
export const taskAttachmentsProcedure = taskProcedure("read", taskInput)
  .output(z.object({ attachments: z.array(attachmentViewSchema), app: taskAppSupportSchema }))
  .query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const task = { id: ctx.task.taskId, organizationId, projectId: ctx.task.projectId };
    return {
      attachments: [...(await attachmentViewsOf(db, organizationId, [task.id]))],
      app: supportView(await taskAppSupport(db, task)),
    };
  });

/**
 * "Add to draft" (F-099, F-121): a screenshot of the refine task's own box among its latest draft's
 * images, so "Update ticket" attaches it like any draft image. Adding it twice answers the same image.
 */
export const attachmentToDraftProcedure = taskProcedure("read", z.strictObject({ taskId: taskIdSchema, attachmentId: attachmentIdSchema, draftId: draftIdSchema }))
  .output(z.object({ draftImageId: draftImageIdSchema }))
  .mutation(async ({ ctx, input }) => {
    const added = unwrap(await addAttachmentToDraft(previewDeps(ctx.deps), ctx.scope, input, { max: ctx.deps.settings.team.draftImagesMax }), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-a-screenshot": "BAD_REQUEST",
      "draft-full": "BAD_REQUEST",
      "task-done": "PRECONDITION_FAILED",
    });
    return { draftImageId: added.draftImageId };
  });

/**
 * "Keep it" (F-140): a port the agent announced in this task becomes an environment proposal of that
 * one process, waiting on the project's admins. Its command is a placeholder until "Edit and accept"
 * names it, so "Accept" alone refuses it.
 */
export const keepPreviewProcedure = taskProcedure("read", z.strictObject({ taskId: taskIdSchema, key: previewKeySchema }))
  .output(z.object({ proposalId: environmentProposalIdSchema }))
  .mutation(async ({ ctx, input }) => {
    const kept = unwrap(await proposeAppProcess(previewDeps(ctx.deps), ctx.scope, input), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-announced": "NOT_FOUND",
      "already-kept": "CONFLICT",
    });
    return { proposalId: kept.proposalId };
  });
