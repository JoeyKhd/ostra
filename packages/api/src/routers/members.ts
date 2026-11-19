import { invitationHandleOf, invitationLifecycleOf, inviteMember, projectGrantsSchema, revokeInvitation } from "@ostra/domain";
import { invitationIdSchema, projectIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { organizationRoleNames } from "../auth/roles.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";

// F-002 (ADR 0053, ticket 22): the organization's invitations. An organization admin invites an
// address with a role and, optionally, projects with a role each. The link is the invitation's ID,
// which is its secret: `invite` returns it once, and no later read does.

const roleSchema = z.enum(organizationRoleNames);

const invitationStateSchema = z.enum(["pending", "accepted", "revoked", "expired"]);

/** An invitation as the panel calls it: by its handle, never its ID, which is the link's secret. */
const invitationHandleSchema = z.string().regex(/^[0-9a-f]{32}$/, "an invitation's handle");

const invitationViewSchema = z.object({
  handle: invitationHandleSchema,
  email: z.string(),
  role: roleSchema,
  state: invitationStateSchema,
  /** The projects it grants, with the role on each, by name. */
  projects: z.array(z.object({ projectId: projectIdSchema, name: z.string(), role: z.enum(["admin", "member"]) })),
  invitedBy: z.string().nullable(),
  /** Epoch ms. */
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  acceptedAt: z.number().int().nullable(),
  acceptedBy: z.string().nullable(),
  revokedAt: z.number().int().nullable(),
});

/** How many past invitations the page lists after the pending ones. */
const PAST_INVITATIONS = 20;

export const membersRouter = router({
  /**
   * Invites an address (organization admin). Returns the link once: the invitation's ID is its
   * secret, so it's never stored readable and no other read returns it. With email set up it's
   * also mailed, as an account mail.
   */
  invite: adminProcedure
    .input(
      z.strictObject({
        email: z.string().trim().min(3).max(254),
        role: roleSchema,
        projectGrants: projectGrantsSchema.default([]),
      }),
    )
    .output(z.object({ invitationId: invitationIdSchema, handle: invitationHandleSchema, link: z.string(), expiresAt: z.number().int(), mailed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const emailOn = await ctx.deps.emailOn();
      const result = unwrap(
        await inviteMember({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, {
          email: input.email,
          role: input.role,
          projectGrants: input.projectGrants,
          emailOn,
          days: ctx.deps.settings.invitationDays,
        }),
        { forbidden: "FORBIDDEN", "already-member": "CONFLICT", "already-invited": "CONFLICT", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST" },
      );
      const link = `${ctx.deps.settings.publicUrl.replace(/\/+$/, "")}/invite/${result.invitationId}`;
      return { invitationId: result.invitationId, handle: invitationHandleOf(result.invitationId), link, expiresAt: result.expiresAt, mailed: emailOn };
    }),

  /** Revokes a pending invitation (organization admin): its link stops working at once. */
  revokeInvitation: adminProcedure
    .input(z.strictObject({ handle: invitationHandleSchema }))
    .output(z.object({ revokedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      // The handle names one of this organization's invitations; only its pending ones can be revoked.
      const pending = await ctx.deps.db.invitation.findMany({
        where: { organizationId: ctx.scope.organizationId, status: "pending", acceptedAt: null, revokedAt: null },
        select: { id: true },
      });
      const found = pending.find((row) => invitationHandleOf(row.id) === input.handle);
      if (found === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such invitation waiting" });
      }
      const invitationId = invitationIdSchema.parse(found.id);
      const result = unwrap(await revokeInvitation({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { invitationId }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-pending": "CONFLICT",
      });
      return { revokedAt: result.revokedAt };
    }),

  /** The pending invitations, then the latest past ones (organization admin). Never a link. */
  invitations: adminProcedure.output(z.array(invitationViewSchema)).query(async ({ ctx }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const now = ports.clock.now();
    const rows = await db.invitation.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        acceptedAt: true,
        acceptedUserId: true,
        revokedAt: true,
        revokedByMemberId: true,
        projectGrants: true,
        user: { select: { name: true } },
      },
    });
    const viewed = rows.map((row) => ({ row, lifecycle: invitationLifecycleOf(row, now) }));
    const pending = viewed.filter((entry) => entry.lifecycle.state === "pending");
    const past = viewed.filter((entry) => entry.lifecycle.state !== "pending").slice(0, PAST_INVITATIONS);
    const shown = [...pending, ...past];
    const grantsOf = (value: unknown) => {
      const parsed = projectGrantsSchema.safeParse(value);
      return parsed.success ? parsed.data : [];
    };
    const projectIds = [...new Set(shown.flatMap((entry) => grantsOf(entry.row.projectGrants).map((grant) => grant.projectId)))];
    const projects = new Map(
      (await db.project.findMany({ where: { organizationId, id: { in: projectIds } }, select: { id: true, name: true } })).map((project) => [project.id, project.name] as const),
    );
    const acceptors = new Map(
      (
        await db.user.findMany({
          where: { id: { in: shown.flatMap((entry) => (entry.row.acceptedUserId === null ? [] : [entry.row.acceptedUserId])) } },
          select: { id: true, name: true },
        })
      ).map((user) => [user.id, user.name] as const),
    );
    return shown.map(({ row, lifecycle }) => ({
      handle: invitationHandleOf(row.id),
      email: row.email,
      role: row.role === "admin" ? ("admin" as const) : ("member" as const),
      state: lifecycle.state,
      projects: grantsOf(row.projectGrants).flatMap((grant) => {
        const name = projects.get(grant.projectId);
        return name === undefined ? [] : [{ projectId: grant.projectId, name, role: grant.role }];
      }),
      invitedBy: row.user.name,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      acceptedAt: row.acceptedAt?.getTime() ?? null,
      acceptedBy: row.acceptedUserId === null ? null : (acceptors.get(row.acceptedUserId) ?? null),
      revokedAt: row.revokedAt?.getTime() ?? null,
    }));
  }),
});
