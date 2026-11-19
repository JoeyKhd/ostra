import { userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { collectResetLink } from "../auth/account-hooks.ts";
import { instanceAdminProcedure, router } from "../trpc/init.ts";

// F-002 (ADR 0053, ADR 0003, ticket 22): accounts at the install's level. Without email, only the
// instance admin makes a reset link: better-auth makes it, its mail callback drops it into this
// request's sink (`collectResetLink`), and the admin gets it once. Only its hash is kept.

export const accountsRouter = router({
  /** A one-time reset link for an account (instance admin only), shown once. */
  createResetLink: instanceAdminProcedure
    .input(z.strictObject({ userId: userIdSchema }))
    .output(z.object({ link: z.string(), expiresAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, auth, settings, ports } = ctx.deps;
      const account = await db.user.findUnique({ where: { id: input.userId }, select: { email: true } });
      if (account === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such account" });
      }
      const startedAt = ports.clock.now();
      const { sink } = await collectResetLink(ctx.user.userId, () =>
        auth.api.requestPasswordReset({ body: { email: account.email, redirectTo: `${settings.publicUrl.replace(/\/+$/, "")}/reset-password` } }),
      );
      if (sink.link === null) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "That didn't work. Try again." });
      }
      return { link: sink.link.url, expiresAt: startedAt + settings.resetLinkHours * 60 * 60 * 1000 };
    }),
});
