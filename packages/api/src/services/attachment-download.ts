import { attachmentContentTypes, requireProjectAccess } from "@ostra/domain";
import { attachmentIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";

import type { Context } from "../trpc/context.ts";

// Milestone 8, ticket 16 (F-121, ADR 0043, ADR 0068): a task's screenshot or recording, served by the
// web app after the access check: the signed-in member must be able to open the task's project, the
// attachment must be the task's, and its blob the task's own. It goes out as a file of its kind's
// fixed type (a PNG, a frame reel), never the type the blob was stored with, never as a page: the
// pixels are the app's, which the agent ran. Another organization's task, a restricted project the
// member isn't on, an attachment of another task and an unknown one are all the same 404, so
// nothing about them leaks. The panel draws a screenshot from this download (`img-src 'self'`).

const textHeaders = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;

const notFound = (): Response => new Response("Not found", { status: 404, headers: textHeaders });

/** Each kind's file name ending. */
const extensions = { screenshot: "png", recording: "reel" } as const;

/** A file name from the runner's ID of it: letters, digits and a few marks, so it is safe in a header. */
const fileNameOf = (kind: keyof typeof extensions, attachmentId: string): string => {
  const base = attachmentId
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${kind}-${base === "" ? "attachment" : base}.${extensions[kind]}`;
};

export const serveTaskAttachment = async (ctx: Context, taskIdText: string, attachmentIdText: string): Promise<Response> => {
  if (ctx.user === null || ctx.member === null) {
    return new Response("Sign in first", { status: 401, headers: textHeaders });
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return new Response("Choose a new password first", { status: 403, headers: textHeaders });
  }
  const taskId = taskIdSchema.safeParse(taskIdText);
  const attachmentId = attachmentIdSchema.safeParse(attachmentIdText);
  if (!taskId.success || !attachmentId.success) {
    return notFound();
  }
  const { db, blobStore } = ctx.deps;
  const scope = ctx.member.scope;
  const attachment = await db.taskAttachment.findFirst({
    where: { taskId: taskId.data, attachmentId: attachmentId.data, organizationId: scope.organizationId },
    select: { kind: true, blobId: true, projectId: true, task: { select: { project: { select: { access: true } } } } },
  });
  if (attachment === null) {
    return notFound();
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(attachment.projectId), organizationId: scope.organizationId, access: attachment.task.project.access }, "read");
  if (!access.ok) {
    return notFound();
  }
  const read = await blobStore.read(scope.organizationId, taskId.data, attachment.blobId);
  if (read.kind === "not-found") {
    return notFound();
  }
  if (read.kind === "other-store") {
    return new Response(`The picture is kept in the ${read.store} store, which the panel does not read yet`, { status: 503, headers: textHeaders });
  }
  return new Response(read.blob.bytes.slice().buffer, {
    status: 200,
    headers: {
      "content-type": attachmentContentTypes[attachment.kind],
      "content-disposition": `attachment; filename="${fileNameOf(attachment.kind, attachmentId.data)}"`,
      "content-length": String(read.blob.size),
      "x-content-type-options": "nosniff",
      // Opened on its own it runs nothing: no script, no frame, no form.
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    },
  });
};
