import { invitationHandleOf, invitationLifecycleOf, inviteMember, projectGrantsSchema, removeMember, revokeInvitation, setMemberRole, visibleProjects } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import type { DbOrTx } from "@ostra/db";
import { invitationIdSchema, memberIdSchema, projectIdSchema, userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { highestRole, organizationRoleNames } from "../auth/roles.ts";
import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-002, F-003 (ADR 0053, tickets 22 and 23): the organization's members and its invitations. An
// organization admin invites an address with a role and, optionally, projects with a role each. The
// link is the invitation's ID, which is its secret: `invite` returns it once, and no later read does.

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

/** A member as the Members page shows them (F-003, ticket 23). */
export const memberViewSchema = z.object({
  memberId: memberIdSchema,
  userId: userIdSchema,
  /** The account's name; a removed member's ends in "(removed)", so history keeps reading. */
  name: z.string(),
  username: z.string().nullable(),
  /** Admins only: members don't see each other's addresses. */
  email: z.string().nullable(),
  role: roleSchema,
  state: z.enum(["active", "pending_verification", "removed"]),
  /** The restricted projects they're listed on, with the role on each: those the caller can open. */
  projects: z.array(z.object({ projectId: projectIdSchema, name: z.string(), role: z.enum(["admin", "member"]) })),
  /** Epoch ms. */
  joinedAt: z.number().int(),
  /** Their newest sign-in's last activity, epoch ms; `null` when they have none. */
  lastActiveAt: z.number().int().nullable(),
  removedAt: z.number().int().nullable(),
  /** Admins only: who invited them, from the invitation they accepted; `null` for the first admin. */
  invitedBy: z.string().nullable(),
  /** Admins only: the admin who removed them; `null` while they're a member. */
  removedBy: z.string().nullable(),
  /**
   * Admins only (members.md, "On their behalf"): what removal would end, counted with the filters of
   * `removeMember`'s transaction. `null` in a member's view and for a removed membership.
   */
  onBehalf: z
    .object({
      personalRunners: z.number().int(),
      cliSessions: z.number().int(),
      drivingTasks: z.number().int(),
      draftComments: z.number().int(),
      invitationsSent: z.number().int(),
    })
    .nullable(),
});
export type MemberView = z.infer<typeof memberViewSchema>;

/**
 * The organization's members, oldest first: active and waiting ones, and removed ones when asked
 * (history's names). Addresses for organization admins only; restricted projects only as far as the
 * caller can open them.
 */
export const loadMembers = async (db: DbOrTx, scope: MemberScope, input: { readonly includeRemoved: boolean }): Promise<MemberView[]> => {
  const organizationId = scope.organizationId;
  const rows = await db.member.findMany({
    where: { organizationId, ...(input.includeRemoved ? {} : { state: { not: "removed" } }) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      role: true,
      state: true,
      createdAt: true,
      removedAt: true,
      removedByMemberId: true,
      user: { select: { name: true, username: true, email: true } },
      projectMemberships: { select: { role: true, project: { select: { id: true, name: true, access: true } } } },
    },
  });
  const sessions = await db.authSession.groupBy({ by: ["userId"], where: { userId: { in: rows.map((row) => row.userId) } }, _max: { updatedAt: true } });
  const lastActive = new Map(sessions.map((row) => [row.userId, row._max.updatedAt] as const));
  const isAdmin = scope.role === "admin";
  const extras = isAdmin ? await adminExtras(db, organizationId, rows) : null;
  return rows.map((row) => {
    const listed = visibleProjects(
      scope,
      row.projectMemberships.map((membership) => ({
        id: projectIdSchema.parse(membership.project.id),
        organizationId,
        access: membership.project.access,
        name: membership.project.name,
        role: membership.role,
      })),
    ).filter((project) => project.access === "restricted");
    return {
      memberId: memberIdSchema.parse(row.id),
      userId: userIdSchema.parse(row.userId),
      name: row.state === "removed" ? `${row.user.name} (removed)` : row.user.name,
      username: row.user.username,
      email: isAdmin ? row.user.email : null,
      role: highestRole(row.role),
      state: row.state,
      projects: listed.map((project) => ({ projectId: project.id, name: project.name, role: project.role })),
      joinedAt: row.createdAt.getTime(),
      lastActiveAt: lastActive.get(row.userId)?.getTime() ?? null,
      removedAt: row.removedAt?.getTime() ?? null,
      invitedBy: extras?.invitedBy.get(row.userId) ?? null,
      removedBy: row.removedByMemberId === null ? null : (extras?.removers.get(row.removedByMemberId) ?? null),
      onBehalf: extras === null || row.state === "removed" ? null : extras.onBehalfOf(row.id, row.userId),
    };
  });
};

const countsBy = (rows: readonly { readonly key: string | null; readonly n: number }[]): ReadonlyMap<string, number> =>
  new Map(rows.flatMap((row) => (row.key === null ? [] : [[row.key, row.n] as const])));

/**
 * What only an admin's list holds (members.md): who invited each member, who removed one, and what
 * removing them would end, with the filters of `removeMember`'s transaction (`@ostra/domain`).
 */
const adminExtras = async (
  db: DbOrTx,
  organizationId: string,
  rows: readonly { readonly id: string; readonly userId: string; readonly removedByMemberId: string | null }[],
) => {
  const memberIds = rows.map((row) => row.id);
  const userIds = rows.map((row) => row.userId);
  const removerIds = rows.flatMap((row) => (row.removedByMemberId === null ? [] : [row.removedByMemberId]));
  const [accepted, removers, runners, cliSessions, driving, drafts, invitations] = await Promise.all([
    db.invitation.findMany({
      where: { organizationId, acceptedUserId: { in: userIds }, acceptedAt: { not: null } },
      orderBy: { acceptedAt: "asc" },
      select: { acceptedUserId: true, user: { select: { name: true } } },
    }),
    db.member.findMany({ where: { organizationId, id: { in: removerIds } }, select: { id: true, user: { select: { name: true } } } }),
    db.runner.groupBy({
      by: ["ownerMemberId"],
      where: { organizationId, kind: "personal", ownerMemberId: { in: memberIds }, revokedAt: null, state: { not: "revoked" } },
      _count: { _all: true },
    }),
    db.cliSession.groupBy({ by: ["memberId"], where: { organizationId, memberId: { in: memberIds }, revokedAt: null }, _count: { _all: true } }),
    db.task.groupBy({ by: ["driverMemberId"], where: { organizationId, driverMemberId: { in: memberIds } }, _count: { _all: true } }),
    db.diffComment.groupBy({ by: ["memberId"], where: { organizationId, memberId: { in: memberIds }, state: "draft" }, _count: { _all: true } }),
    db.invitation.groupBy({
      by: ["inviterId"],
      where: { organizationId, inviterId: { in: userIds }, status: "pending", acceptedAt: null, revokedAt: null },
      _count: { _all: true },
    }),
  ]);
  // The newest accepted invitation wins: someone removed and invited again was invited by the second.
  const invitedBy = new Map(accepted.flatMap((row) => (row.acceptedUserId === null ? [] : [[row.acceptedUserId, row.user.name] as const])));
  const runnersBy = countsBy(runners.map((row) => ({ key: row.ownerMemberId, n: row._count._all })));
  const cliBy = countsBy(cliSessions.map((row) => ({ key: row.memberId, n: row._count._all })));
  const drivingBy = countsBy(driving.map((row) => ({ key: row.driverMemberId, n: row._count._all })));
  const draftsBy = countsBy(drafts.map((row) => ({ key: row.memberId, n: row._count._all })));
  const invitationsBy = countsBy(invitations.map((row) => ({ key: row.inviterId, n: row._count._all })));
  return {
    invitedBy,
    removers: new Map(removers.map((row) => [row.id, row.user.name] as const)),
    onBehalfOf: (memberId: string, userId: string) => ({
      personalRunners: runnersBy.get(memberId) ?? 0,
      cliSessions: cliBy.get(memberId) ?? 0,
      drivingTasks: drivingBy.get(memberId) ?? 0,
      draftComments: draftsBy.get(memberId) ?? 0,
      invitationsSent: invitationsBy.get(userId) ?? 0,
    }),
  };
};

/** How many past invitations the page lists after the pending ones. */
const PAST_INVITATIONS = 20;

export const membersRouter = router({
  /** The members (any member). Removed ones on request, for history; addresses for admins only. */
  list: memberProcedure
    .input(z.strictObject({ includeRemoved: z.boolean().default(false) }).default({ includeRemoved: false }))
    .output(z.array(memberViewSchema))
    .query(({ ctx, input }) => loadMembers(ctx.deps.db, ctx.scope, input)),

  /** Changes a member's role (organization admin). The last active admin can't be demoted. */
  setRole: adminProcedure
    .input(z.strictObject({ memberId: memberIdSchema, role: roleSchema }))
    .output(z.object({ memberId: memberIdSchema, role: roleSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = unwrap(await setMemberRole({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "last-admin": "CONFLICT",
      });
      return { memberId: input.memberId, role: result.role };
    }),

  /**
   * Removes a member (organization admin, ADR 0053): kept as removed, with their project roles,
   * personal runners, CLI sessions, driving, drafts and pending invitations ended in one transaction.
   * Never yourself, and never the last admin.
   */
  remove: adminProcedure
    .input(z.strictObject({ memberId: memberIdSchema }))
    .output(
      z.object({
        removedAt: z.number().int(),
        counts: z.object({
          projectRoles: z.number().int(),
          runnersRevoked: z.number().int(),
          cliSessionsRevoked: z.number().int(),
          tasksUndriven: z.number().int(),
          draftsDeleted: z.number().int(),
          invitationsRevoked: z.number().int(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = unwrap(await removeMember({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "last-admin": "CONFLICT",
        self: "BAD_REQUEST",
      });
      return { removedAt: result.removedAt, counts: result.counts };
    }),

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
