import { acceptInvitation, invitationLifecycleOf, verifyMembership } from "@ostra/domain";
import { invitationIdSchema, memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { clientAddressOf, fixedWindowLimiter } from "../services/rate-limit.ts";
import { authedProcedure, publicProcedure, router, unwrap } from "../trpc/init.ts";

// F-002 (ADR 0053, ticket 22): what the invitation link's page reads and does. The preview is public
// (the link's holder may have no account yet) and says only what the page shows: the organization's
// name, who invited, the address and the state. Nothing of the organization's members or projects.

/** A stranger may try this many IDs a minute from one address. */
const PREVIEWS_PER_MINUTE = 30;
const previews = fixedWindowLimiter({ limit: PREVIEWS_PER_MINUTE, windowMs: 60_000 });

const previewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-found") }),
  z.object({
    state: z.enum(["pending", "accepted", "revoked", "expired"]),
    organizationName: z.string(),
    inviterName: z.string(),
    email: z.string(),
    /** With email set up the address is the invitation's, locked; without, it's taken as written. */
    addressLocked: z.boolean(),
    role: z.enum(["admin", "member"]),
    /** How long an invitation works (`OSTRA_INVITATION_DAYS`), for the expired page's words. */
    days: z.number().int(),
    /** Accepted by an account whose address is still being verified: the "Check your inbox" page. */
    verificationPending: z.boolean(),
  }),
]);

export const invitationsRouter = router({
  /** The page's read of an invitation by its ID. Rate-limited by the client's address. */
  preview: publicProcedure
    .input(z.strictObject({ invitationId: z.string().min(1).max(128) }))
    .output(previewSchema)
    .query(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const now = ports.clock.now();
      if (!previews.allow(clientAddressOf(ctx.headers), now)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries: wait a minute" });
      }
      const id = invitationIdSchema.safeParse(input.invitationId);
      const row = id.success
        ? await db.invitation.findUnique({
            where: { id: id.data },
            select: {
              status: true,
              email: true,
              role: true,
              expiresAt: true,
              acceptedAt: true,
              acceptedUserId: true,
              revokedAt: true,
              revokedByMemberId: true,
              organizationId: true,
              organization: { select: { name: true } },
              user: { select: { name: true } },
            },
          })
        : null;
      if (row === null) {
        return { state: "not-found" as const };
      }
      const lifecycle = invitationLifecycleOf(row, now);
      const acceptor =
        lifecycle.state === "accepted" && row.acceptedUserId !== null
          ? await db.member.findFirst({ where: { organizationId: row.organizationId, userId: row.acceptedUserId }, select: { state: true } })
          : null;
      return {
        state: lifecycle.state,
        organizationName: row.organization.name,
        inviterName: row.user.name,
        email: row.email,
        addressLocked: await ctx.deps.emailOn(),
        role: row.role === "admin" ? ("admin" as const) : ("member" as const),
        days: settings.invitationDays,
        verificationPending: acceptor?.state === "pending_verification",
      };
    }),

  /**
   * The verification mail's link (`/invite/<id>?verify=<token>`, ADR 0053): the address is proven,
   * and the membership waiting on it becomes active. Public, as the link may open in a browser with
   * no session, and rate-limited by the client's address with the preview. The token is a secret: it
   * is never logged, and only its hash is stored.
   */
  verify: publicProcedure
    .input(z.strictObject({ invitationId: z.string().min(1).max(128), token: z.string().min(1).max(256) }))
    .output(z.object({ state: z.enum(["verified", "invalid"]) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      if (!previews.allow(clientAddressOf(ctx.headers), ports.clock.now())) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many tries: wait a minute" });
      }
      const verified = await db.$transaction((tx) => verifyMembership(ports, tx, input));
      return { state: verified.ok ? ("verified" as const) : ("invalid" as const) };
    }),

  /**
   * A signed-in account accepts an invitation by its ID, joining without a second account. With email
   * set up the account's address must be the invitation's, and an unverified one waits for its mail.
   * The session moves to the organization it joined.
   */
  accept: authedProcedure
    .input(z.strictObject({ invitationId: invitationIdSchema }))
    .output(z.object({ memberId: memberIdSchema, organizationId: organizationIdSchema, state: z.enum(["active", "pending_verification"]) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const emailOn = await ctx.deps.emailOn();
      const user = ctx.user;
      return db.$transaction(async (tx) => {
        const accepted = unwrap(await acceptInvitation(ports, tx, { invitationId: input.invitationId, userId: user.userId, email: user.email, emailOn }), {
          "not-found": "NOT_FOUND",
          expired: "PRECONDITION_FAILED",
          revoked: "PRECONDITION_FAILED",
          used: "CONFLICT",
          "address-mismatch": "FORBIDDEN",
          "already-member": "CONFLICT",
        });
        const member = await tx.member.findUniqueOrThrow({ where: { id: accepted.memberId }, select: { organizationId: true } });
        const organizationId = organizationIdSchema.parse(member.organizationId);
        if (accepted.state === "active") {
          await tx.authSession.updateMany({ where: { id: user.sessionId, userId: user.userId }, data: { activeOrganizationId: organizationId } });
        }
        return { memberId: accepted.memberId, organizationId, state: accepted.state };
      });
    }),
});
