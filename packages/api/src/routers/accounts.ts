import { resetLink } from "@ostra/domain";
import { userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { collectResetLink, hashResetToken } from "../auth/account-hooks.ts";
import { clientAddressOf, fixedWindowLimiter } from "../services/rate-limit.ts";
import { instanceAdminProcedure, publicProcedure, router } from "../trpc/init.ts";

// F-002 (ADR 0053, ADR 0003, ticket 22): accounts at the install's level. Without email, only the
// instance admin makes a reset link: better-auth makes it, its mail callback drops it into this
// request's sink (`collectResetLink`), and the admin gets it once. Only its hash is kept.

/** A stranger may try this many reset tokens a minute from one address. */
const RESET_PREVIEWS_PER_MINUTE = 30;
const resetPreviews = fixedWindowLimiter({ limit: RESET_PREVIEWS_PER_MINUTE, windowMs: 60_000 });

const resetPreviewSchema = z.discriminatedUnion("state", [
  /** The link works: the page names the account's address, which its holder already knows. */
  z.object({ state: z.literal("valid"), address: z.string() }),
  z.object({ state: z.enum(["used", "expired", "unknown"]) }),
]);

export const accountsRouter = router({
  /**
   * What a reset link's page shows before the new password (F-002, ticket 32, reset-password.md):
   * by the token's hash, whether the link still works, was used, or expired. Public, since the
   * link's holder is signed out, and rate-limited by the client's address.
   */
  resetPreview: publicProcedure
    .input(z.strictObject({ token: z.string().min(1).max(256) }))
    .output(resetPreviewSchema)
    .query(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const now = ports.clock.now();
      if (!resetPreviews.allow(clientAddressOf(ctx.headers), now)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries: wait a minute" });
      }
      const grant = await db.resetLinkGrant.findUnique({
        where: { tokenHash: hashResetToken(input.token) },
        select: { usedAt: true, expiresAt: true, user: { select: { email: true } } },
      });
      if (grant === null) return { state: "unknown" as const };
      if (grant.usedAt !== null) return { state: "used" as const };
      if (grant.expiresAt.getTime() <= now) return { state: "expired" as const };
      return { state: "valid" as const, address: grant.user.email };
    }),

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
      // The same page a mailed link opens (`/reset/new`, reset-password.md), not better-auth's redirect,
      // so the page can tell an expired link from a used one.
      return { link: resetLink(settings.publicUrl, sink.link.token), expiresAt: startedAt + settings.resetLinkHours * 60 * 60 * 1000 };
    }),
});
