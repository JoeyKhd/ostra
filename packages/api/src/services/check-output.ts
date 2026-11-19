import { requireProjectAccess } from "@ostra/domain";
import { projectIdSchema } from "@ostra/protocol";

import type { Context } from "../trpc/context.ts";

// F-054 (ticket 39; ADR 0052): a check's full output, served by the web app after the access check:
// the signed-in member must be able to open the task's project, the run must belong to that task,
// and the blob must be the task's own. It goes out as plain text and an attachment, never as a page:
// the output is the repo's own program's, and nothing in it is interpreted. Another organization's
// task, a restricted project the member is not on, a run of another task and a run with no saved
// output are all the same 404, so nothing about them leaks.

const textHeaders = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;

const notFound = (): Response => new Response("Not found", { status: 404, headers: textHeaders });

/** A file name from a check's name: letters, digits and a few marks, so it is safe in a header. */
const fileNameOf = (name: string, turn: number): string => {
  const base = name
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base === "" ? "check" : base}-turn-${String(turn)}.txt`;
};

export const serveCheckOutput = async (ctx: Context, taskId: string, runId: string): Promise<Response> => {
  if (ctx.user === null || ctx.member === null) {
    return new Response("Sign in first", { status: 401, headers: textHeaders });
  }
  const { db, blobStore } = ctx.deps;
  const scope = ctx.member.scope;
  const run = await db.checkRun.findFirst({
    where: { id: runId, taskId, organizationId: scope.organizationId },
    select: { name: true, turnOrdinal: true, outputBlobId: true, projectId: true, task: { select: { project: { select: { access: true } } } } },
  });
  if (run === null) {
    return notFound();
  }
  if (run.outputBlobId === null) {
    return notFound();
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(run.projectId), organizationId: scope.organizationId, access: run.task.project.access }, "read");
  if (!access.ok) {
    return notFound();
  }
  const read = await blobStore.read(scope.organizationId, taskId, run.outputBlobId);
  if (read.kind === "not-found") {
    return notFound();
  }
  if (read.kind === "other-store") {
    return new Response(`The output is kept in the ${read.store} store, which the panel does not read yet`, { status: 503, headers: textHeaders });
  }
  return new Response(read.blob.bytes.slice().buffer, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${fileNameOf(run.name, run.turnOrdinal)}"`,
      "content-length": String(read.blob.size),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
};
