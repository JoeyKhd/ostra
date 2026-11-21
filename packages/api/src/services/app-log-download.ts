import { requireProjectAccess } from "@ostra/domain";
import { blobIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";

import type { Context } from "../trpc/context.ts";

// Milestone 8, ticket 17 (F-140, ADR 0043, ADR 0068): the tail of an app process's log, which the
// runner uploads as an `app-log` blob of the task when the process exits or fails (`app.process`'s
// `logBlobId`), for the thread's and the App tab's "Show log". The same safety as a screenshot's
// download (`serveTaskAttachment`): the signed-in member must be able to open the task's project,
// the blob must be the task's own and an `app-log`, and it goes out as plain text whatever it was
// stored with, never as a page. Another organization's task, a restricted project the member isn't
// on, another task's blob, a blob of another purpose and an unknown one are all the same 404. The
// bytes come through core's blob service (`coreBlobReader`), and nothing of the log is logged.

const textHeaders = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;

const notFound = (): Response => new Response("Not found", { status: 404, headers: textHeaders });

/** The purpose the runner uploads a log's tail with. */
const APP_LOG_PURPOSE = "app-log";

/** Where an app process's log tail downloads: the web app's route, after it checks the caller may open the task. */
export const appLogDownloadPath = (taskId: string, blobId: string): string => `/api/tasks/${taskId}/app-logs/${encodeURIComponent(blobId)}`;

export const serveTaskAppLog = async (ctx: Context, taskIdText: string, blobIdText: string): Promise<Response> => {
  if (ctx.user === null || ctx.member === null) {
    return new Response("Sign in first", { status: 401, headers: textHeaders });
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return new Response("Choose a new password first", { status: 403, headers: textHeaders });
  }
  const taskId = taskIdSchema.safeParse(taskIdText);
  const blobId = blobIdSchema.safeParse(blobIdText);
  if (!taskId.success || !blobId.success) {
    return notFound();
  }
  const { db, blobStore } = ctx.deps;
  const scope = ctx.member.scope;
  const blob = await db.blob.findFirst({
    where: { id: blobId.data, taskId: taskId.data, organizationId: scope.organizationId, purpose: APP_LOG_PURPOSE },
    select: { task: { select: { projectId: true, project: { select: { access: true } } } } },
  });
  if (blob?.task === null || blob?.task === undefined) {
    return notFound();
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(blob.task.projectId), organizationId: scope.organizationId, access: blob.task.project.access }, "read");
  if (!access.ok) {
    return notFound();
  }
  const read = await blobStore.read(scope.organizationId, taskId.data, blobId.data);
  if (read.kind === "not-found") {
    return notFound();
  }
  if (read.kind === "unavailable") {
    return new Response("The log can't be read from the blob store just now: try again", { status: 503, headers: textHeaders });
  }
  return new Response(read.blob.stream, {
    status: 200,
    headers: {
      // Its fixed type, whatever the blob was stored with: the log is the app's output, which the agent ran.
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(read.blob.size),
      "x-content-type-options": "nosniff",
      // Opened on its own it runs nothing: no script, no frame, no form.
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    },
  });
};
