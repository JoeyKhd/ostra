import { retentionInEffect } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema, userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { highestRole, organizationRoleNames } from "../auth/roles.ts";
import { adminProcedure, authedProcedure, instanceAdminProcedure, memberProcedure, router } from "../trpc/init.ts";

// The organization and its members (ticket 30, F-003's first slice). Roles are `admin` and
// `member` only (ADR 0026). Invitations and the rest of F-002 are milestone 4.

const roleSchema = z.enum(organizationRoleNames);

const organizationViewSchema = z.object({
  id: organizationIdSchema,
  name: z.string(),
  slug: z.string(),
  /** The caller's role in it. */
  role: roleSchema,
});

const memberViewSchema = z.object({
  memberId: memberIdSchema,
  userId: userIdSchema,
  name: z.string(),
  username: z.string().nullable(),
  /** Admins only: members don't see each other's addresses. */
  email: z.string().nullable(),
  role: roleSchema,
  /** Epoch ms. */
  joinedAt: z.number().int(),
});

/** Whether the signed-in account must, may or needn't change a seeded default password (F-001). */
export type PasswordChange = "required" | "suggested" | "none";

const passwordChangeOf = (mustChangePassword: boolean, allowDefaultPassword: boolean): PasswordChange => {
  if (!mustChangePassword) return "none";
  return allowDefaultPassword ? "suggested" : "required";
};

export const meRouter = router({
  /** The signed-in account, and the organization it is acting in (null before it has one). */
  get: authedProcedure.query(async ({ ctx }) => {
    const { user, member } = ctx;
    const organization =
      member === null
        ? null
        : await ctx.deps.db.organization.findUnique({
            where: { id: member.scope.organizationId },
            select: { id: true, name: true, slug: true },
          });
    return {
      userId: user.userId,
      name: user.name,
      username: user.username,
      email: user.email,
      instanceAdmin: user.instanceAdmin,
      /**
       * F-001: the account still has the default password it was seeded with. `required`: the
       * panel's only step is choosing a new one. `suggested` (OSTRA_ALLOW_DEFAULT_PASSWORD): the
       * panel works, with a warning until it changes. `none`: its own password.
       */
      passwordChange: passwordChangeOf(user.mustChangePassword, ctx.deps.settings.allowDefaultPassword),
      memberId: member === null ? null : member.scope.memberId,
      organization:
        member === null || organization === null
          ? null
          : {
              id: member.scope.organizationId,
              name: organization.name,
              slug: organization.slug,
              role: member.scope.role,
            },
    };
  }),
});

const storageViewSchema = z.object({
  /** The blob store in use, and whether it answers (F-114). */
  store: z.object({
    name: z.enum(["postgres", "s3"]),
    health: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok") }),
      z.object({ status: z.literal("degraded"), reason: z.string() }),
      z.object({ status: z.literal("down"), reason: z.string() }),
    ]),
    /** The S3-compatible store is the one in use, with its settings complete (`OSTRA_BLOB_STORE=s3`). */
    s3Configured: z.boolean(),
  }),
  /** This organization's blobs only. */
  blobCount: z.number().int(),
  totalBytes: z.number().int(),
  /** The largest blob (`OSTRA_BLOB_MAX_MIB`), in bytes. */
  capBytes: z.number().int(),
  /** The retention in effect: a saved choice wins over `OSTRA_RETENTION_DAYS`; `days: null` keeps. */
  retention: z.object({ days: z.number().int().nullable(), source: z.enum(["saved", "env", "default"]), savedAt: z.number().int().nullable() }),
  /** The newest `retention.swept` entry of the audit log (ticket 20): when, and what it recorded. */
  lastSweep: z.object({ at: z.number().int(), data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).nullable(),
});

export const organizationRouter = router({
  /**
   * Storage and retention (F-114, F-079, ticket 31), for instance admins: the blob store in use, how
   * much this organization keeps in it, and how long finished tasks' histories, archives and blobs
   * are kept.
   */
  storage: instanceAdminProcedure.output(storageViewSchema).query(async ({ ctx }) => {
    const { db, settings, blobStore } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [totals, instance, sweep, health] = await Promise.all([
      db.blob.aggregate({ where: { organizationId }, _count: { _all: true }, _sum: { size: true } }),
      db.instanceSetting.findUnique({ where: { id: "instance" }, select: { retentionDays: true, retentionSetAt: true } }),
      db.auditEntry.findFirst({ where: { organizationId, action: "retention.swept" }, orderBy: { createdAt: "desc" }, select: { createdAt: true, data: true } }),
      blobStore.health(),
    ]);
    const retention = retentionInEffect(instance, settings.retentionDays);
    const data = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).safeParse(sweep?.data);
    return {
      store: { name: blobStore.name, health, s3Configured: settings.blobStore.kind === "s3" },
      blobCount: totals._count._all,
      totalBytes: totals._sum.size ?? 0,
      capBytes: settings.blobStore.maxBytes,
      retention: { days: retention.days, source: retention.source, savedAt: instance?.retentionSetAt?.getTime() ?? null },
      lastSweep: sweep === null ? null : { at: sweep.createdAt.getTime(), data: data.success ? data.data : {} },
    };
  }),

  get: memberProcedure.output(organizationViewSchema).query(async ({ ctx }) => {
    const row = await ctx.deps.db.organization.findUnique({
      where: { id: ctx.scope.organizationId },
      select: { id: true, name: true, slug: true },
    });
    if (row === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such organization" });
    }
    return { id: ctx.scope.organizationId, name: row.name, slug: row.slug, role: ctx.scope.role };
  }),

  rename: adminProcedure
    .input(z.strictObject({ name: z.string().trim().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      await db.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: organizationId }, data: { name: input.name } });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "organization.renamed",
          entity: "organization",
          entityId: organizationId,
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
      });
      return { name: input.name };
    }),

  /** Everyone in the organization. Addresses are shown to admins only. */
  members: memberProcedure.output(z.array(memberViewSchema)).query(async ({ ctx }) => {
    const rows = await ctx.deps.db.member.findMany({
      where: { organizationId: ctx.scope.organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, username: true, email: true } },
      },
    });
    const isAdmin = ctx.scope.role === "admin";
    return rows.map((row) => ({
      memberId: memberIdSchema.parse(row.id),
      userId: userIdSchema.parse(row.userId),
      name: row.user.name,
      username: row.user.username,
      email: isAdmin ? row.user.email : null,
      role: highestRole(row.role),
      joinedAt: row.createdAt.getTime(),
    }));
  }),

  /** Changes a member's role. The last admin can't be demoted: an organization always has one. */
  setMemberRole: adminProcedure
    .input(z.strictObject({ memberId: memberIdSchema, role: roleSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      await db.$transaction(async (tx) => {
        // Admins are counted under a row lock, so two demotions at once can't leave none.
        const locked: unknown = await tx.$queryRaw`
          SELECT "id" FROM "member" WHERE "organizationId" = ${organizationId} AND "role" = 'admin' FOR UPDATE`;
        const adminCount = z.array(z.unknown()).parse(locked).length;
        const target = await tx.member.findFirst({ where: { id: input.memberId, organizationId }, select: { id: true, role: true } });
        if (target === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such member" });
        }
        if (highestRole(target.role) === "admin" && input.role === "member" && adminCount <= 1) {
          throw new TRPCError({ code: "CONFLICT", message: "An organization needs at least one admin" });
        }
        await tx.member.update({ where: { id: target.id }, data: { role: input.role } });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "member.role-changed",
          entity: "member",
          entityId: input.memberId,
          data: { role: input.role },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: input.memberId });
      });
      return { memberId: input.memberId, role: input.role };
    }),
});
