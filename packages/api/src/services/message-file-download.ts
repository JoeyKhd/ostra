import { requireProjectAccess } from "@ostra/domain";
import { isPromptImageContentType, messageFileIdSchema, projectIdSchema, safeFileNameSchema, taskIdSchema } from "@ostra/protocol";

import type { Context } from "../trpc/context.ts";

// A message's file, downloaded (F-148/c3, ADR 0070 "Storage, serving and safety", ticket 14):
// `GET /api/tasks/<taskId>/files/<fileId>`, for any member who can open the task. The file must be
// one sent with a message of that task (a member's or the ticket's) whose blob is there; its bytes
// come through core's blob service from whichever store keeps them (`coreBlobReader`). It always
// goes out as a download, never a page: an image (a PNG, a JPEG, a GIF or a WebP, as core told it
// by its bytes) with that type, anything else as `application/octet-stream` (an SVG, an HTML file
// and a document alike, whatever the bytes say), `Content-Disposition: attachment` with its safe
// name, `nosniff`, a sandbox that runs nothing, `same-origin` and `private, no-store`. Another
// organization's task, a restricted project the member isn't on, another task's file, a file that
// was never sent and an unknown one are all the same 404, so nothing about them leaks.

const textHeaders = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;

const notFound = (): Response => new Response("Not found", { status: 404, headers: textHeaders });

/** The type a file downloads as: an image's own (one a prompt carries, never SVG), else bytes. */
export const downloadContentTypeOf = (file: { readonly kind: string; readonly contentType: string }): string =>
  file.kind === "image" && isPromptImageContentType(file.contentType) ? file.contentType : "application/octet-stream";

/** RFC 5987's `filename*` value: UTF-8, every character outside its `attr-char` percent-encoded. */
const extendedValue = (name: string): string =>
  `UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/**
 * `Content-Disposition` for a file: always an attachment, with its safe name (letters, digits,
 * spaces and `._-()`: nothing a header or a shell reads) as `filename` and as `filename*`. A name
 * that somehow isn't safe downloads as `file`.
 */
export const attachmentDisposition = (name: string): string => {
  const safe = safeFileNameSchema.safeParse(name);
  const shown = safe.success ? safe.data : "file";
  return `attachment; filename="${shown}"; filename*=${extendedValue(shown)}`;
};

export const serveTaskFile = async (ctx: Context, taskIdText: string, fileIdText: string): Promise<Response> => {
  if (ctx.user === null || ctx.member === null) {
    return new Response("Sign in first", { status: 401, headers: textHeaders });
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return new Response("Choose a new password first", { status: 403, headers: textHeaders });
  }
  const taskId = taskIdSchema.safeParse(taskIdText);
  const fileId = messageFileIdSchema.safeParse(fileIdText);
  if (!taskId.success || !fileId.success) {
    return notFound();
  }
  const { db, blobStore } = ctx.deps;
  const scope = ctx.member.scope;
  const file = await db.messageFile.findFirst({
    where: { id: fileId.data, taskId: taskId.data, organizationId: scope.organizationId, state: "sent", blobId: { not: null } },
    select: { name: true, kind: true, contentType: true, blobId: true, projectId: true, project: { select: { access: true } } },
  });
  if (file?.blobId === null || file?.blobId === undefined) {
    return notFound();
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(file.projectId), organizationId: scope.organizationId, access: file.project.access }, "read");
  if (!access.ok) {
    return notFound();
  }
  const read = await blobStore.read(scope.organizationId, taskId.data, file.blobId);
  if (read.kind === "not-found") {
    return notFound();
  }
  if (read.kind === "unavailable") {
    return new Response("The file can't be read from the blob store just now: try again", { status: 503, headers: textHeaders });
  }
  return new Response(read.blob.stream, {
    status: 200,
    headers: {
      // Core's type from the bytes for an image, never the browser's or the name's; bytes for anything else.
      "content-type": downloadContentTypeOf(file),
      "content-disposition": attachmentDisposition(file.name),
      "content-length": String(read.blob.size),
      "x-content-type-options": "nosniff",
      // Opened on its own it runs nothing: no script, no frame, no form.
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    },
  });
};
