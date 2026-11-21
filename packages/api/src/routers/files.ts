import { discardUpload, messageFileLimits } from "@ostra/domain";
import type { FileLimits } from "@ostra/domain";
import { messageFileIdSchema, projectIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadProjectAccess, memberProcedure, router, unwrap } from "../trpc/init.ts";

// Milestone 9 (F-148, ADR 0070, ticket 14): the message box's files beside the upload route
// (`POST /api/projects/<projectId>/files`, `serveMessageFileUpload`):
//
// - `files.limits`: the three limits a message's files keep to (`OSTRA_MESSAGE_FILES_MAX`,
//   `_FILE_MAX_MIB`, `_FILES_TOTAL_MIB`), so the box refuses an item over one as it arrives. The
//   server checks them again at send.
// - `files.discard`: the member's "remove" before sending: their own unsent upload, in a project
//   they can open, can't be sent from then on, and core's sweep deletes its blobs. Another
//   member's, a sent one and an unknown one are the same `NOT_FOUND`.

export const filesRouter = router({
  limits: memberProcedure.query(({ ctx }): FileLimits => messageFileLimits(ctx.deps.settings.files)),

  discard: memberProcedure.input(z.strictObject({ fileId: messageFileIdSchema })).mutation(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const file = await db.messageFile.findFirst({
      where: { id: input.fileId, organizationId: ctx.scope.organizationId, memberId: ctx.scope.memberId, origin: "member", state: "uploaded", taskId: null },
      select: { projectId: true },
    });
    if (file === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such file" });
    }
    // The member's project access, now: an upload in a project they can no longer open is no file of theirs.
    await loadProjectAccess(db, ctx.scope, projectIdSchema.parse(file.projectId), "read").catch(() => {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such file" });
    });
    const discarded = unwrap(await discardUpload({ db, scope: ctx.scope }, { fileId: input.fileId }), { "not-found": "NOT_FOUND" });
    return { fileId: discarded.fileId };
  }),
});
