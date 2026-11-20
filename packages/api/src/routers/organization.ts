import { retentionInEffect, setMemberRole } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { organizationRoleNames } from "../auth/roles.ts";
import { adminProcedure, authedProcedure, instanceAdminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { loadMembers, memberViewSchema } from "./members.ts";

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
      /** F-082: dark, light or system; the root layout applies it from the cookie before first paint. */
      theme: user.theme,
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
      /**
       * F-002 (ADR 0053): with no organization, whether an admin removed the account's membership
       * (`removed`) or it has none active yet (`none`, an invitation not confirmed), for the page
       * that says why the panel opens nothing. `null` with an organization.
       */
      noMembership:
        member === null
          ? (await ctx.deps.db.member.count({ where: { userId: user.userId, state: "removed" } })) > 0
            ? ("removed" as const)
            : ("none" as const)
          : null,
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

  /**
   * Everyone in the organization, removed members included with "(removed)" after their name, so a
   * task's history keeps its names (ADR 0053). Addresses are shown to admins only. Wraps
   * `members.list` (ticket 23), keeping milestone 1's shape plus each member's `state`.
   */
  members: memberProcedure
    .output(z.array(memberViewSchema.pick({ memberId: true, userId: true, name: true, username: true, email: true, role: true, joinedAt: true, state: true })))
    .query(async ({ ctx }) =>
      (await loadMembers(ctx.deps.db, ctx.scope, { includeRemoved: true })).map((member) => ({
        memberId: member.memberId,
        userId: member.userId,
        name: member.name,
        username: member.username,
        email: member.email,
        role: member.role,
        joinedAt: member.joinedAt,
        state: member.state,
      })),
    ),

  /** Changes a member's role: `members.setRole`'s use case. The last active admin can't be demoted. */
  setMemberRole: adminProcedure
    .input(z.strictObject({ memberId: memberIdSchema, role: roleSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = unwrap(await setMemberRole({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "last-admin": "CONFLICT",
      });
      return { memberId: input.memberId, role: result.role };
    }),
});
