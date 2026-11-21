import { checkPreviewDomain, createPreviewDomainProbe, grantInstanceAdmin, previewDomainCheckSchema } from "@ostra/domain";
import { userIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { instanceAdminProcedure, router, unwrap } from "../trpc/init.ts";

// The install's own settings (ticket 31): instance admins only, apart from organization admins.

/** How many accounts a page of the Accounts page holds. */
const ACCOUNTS_PAGE = 50;

/** Where a page of accounts starts: the last account of the page before, by name then ID. */
const accountsCursorSchema = z.strictObject({ name: z.string().max(256), id: userIdSchema });

/**
 * An account as the instance admin's Accounts page shows it (`instance-settings.md`): who it is, its
 * organizations by name, and the instance admin role. Nothing of any organization's content.
 */
const accountViewSchema = z.strictObject({
  userId: userIdSchema,
  name: z.string(),
  username: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /** The organizations it's an active member of, by name. */
  organizations: z.array(z.string()),
  /** Epoch ms. */
  createdAt: z.number().int(),
  /** Its newest sign-in, epoch ms, or `null` when it has none. */
  lastSignInAt: z.number().int().nullable(),
  instanceAdmin: z.boolean(),
  /** When it was made an instance admin, epoch ms (its creation, for the first admin). */
  instanceAdminSince: z.number().int().nullable(),
});

/** What `grantInstanceAdmin` answers, as the panel reads it. */
const grantCodes = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "last-instance-admin": "CONFLICT" } as const;

export const instanceRouter = router({
  /**
   * The preview domain's check (milestone 8, ticket 25, F-144; `instance-preview-domain.md`), for
   * the instance's settings page (ticket 26): a random name under `OSTRA_PREVIEW_DOMAIN` resolved,
   * then opened over core's public scheme and port, reporting the DNS record, the certificate,
   * whether core's preview proxy answered and whether a WebSocket upgrade went through. `not-set`
   * with no domain. It reaches the install's own domain only, and sends nothing of a member's.
   */
  previewDomainCheck: instanceAdminProcedure.output(previewDomainCheckSchema).mutation(({ ctx }) =>
    checkPreviewDomain(
      { probe: ctx.deps.previews.domainProbe ?? createPreviewDomainProbe(), mark: ctx.deps.previews.checkMark, clock: ctx.deps.ports.clock },
      { domain: ctx.deps.settings.previews.domain, corePublicUrl: ctx.deps.settings.corePublicUrl },
    ),
  ),
  /**
   * The install's accounts (instance admin only, F-003, ticket 43): by a prefix of the username, the
   * address or the name, case-insensitive, sorted by name, 50 at a time.
   */
  accounts: router({
    search: instanceAdminProcedure
      .input(z.strictObject({ query: z.string().trim().max(254).default(""), cursor: accountsCursorSchema.optional() }))
      .output(z.object({ accounts: z.array(accountViewSchema), next: accountsCursorSchema.nullable() }))
      .query(async ({ ctx, input }) => {
        const { db } = ctx.deps;
        const prefix = input.query;
        const matching =
          prefix === ""
            ? {}
            : {
                OR: [
                  { username: { startsWith: prefix, mode: "insensitive" as const } },
                  { email: { startsWith: prefix, mode: "insensitive" as const } },
                  { name: { startsWith: prefix, mode: "insensitive" as const } },
                ],
              };
        const after =
          input.cursor === undefined ? {} : { OR: [{ name: { gt: input.cursor.name } }, { name: input.cursor.name, id: { gt: input.cursor.id } }] };
        const rows = await db.user.findMany({
          where: { AND: [matching, after] },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: ACCOUNTS_PAGE + 1,
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            emailVerified: true,
            createdAt: true,
            role: true,
            members: { where: { state: "active" }, orderBy: { createdAt: "asc" }, select: { organization: { select: { name: true } } } },
          },
        });
        const page = rows.slice(0, ACCOUNTS_PAGE);
        const ids = page.map((row) => row.id);
        const [signIns, grants] = await Promise.all([
          db.authSession.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { createdAt: true } }),
          db.auditEntry.groupBy({ by: ["entityId"], where: { action: "instance.admin-granted", entity: "user", entityId: { in: ids } }, _max: { createdAt: true } }),
        ]);
        const lastSignIn = new Map(signIns.map((row) => [row.userId, row._max.createdAt] as const));
        const grantedAt = new Map(grants.map((row) => [row.entityId, row._max.createdAt] as const));
        const last = page.at(-1);
        return {
          accounts: page.map((row) => {
            const instanceAdmin = row.role === "admin";
            return {
              userId: userIdSchema.parse(row.id),
              name: row.name,
              username: row.username,
              email: row.email,
              emailVerified: row.emailVerified,
              organizations: row.members.map((member) => member.organization.name),
              createdAt: row.createdAt.getTime(),
              lastSignInAt: lastSignIn.get(row.id)?.getTime() ?? null,
              instanceAdmin,
              instanceAdminSince: instanceAdmin ? (grantedAt.get(row.id) ?? row.createdAt).getTime() : null,
            };
          }),
          next: rows.length > ACCOUNTS_PAGE && last !== undefined ? { name: last.name, id: userIdSchema.parse(last.id) } : null,
        };
      }),
  }),

  /**
   * The install's instance admins (instance admin only, F-003, ticket 33): the Accounts page's
   * "Instance admins" section, by name, each with when it got the role.
   */
  admins: instanceAdminProcedure
    .output(z.array(z.object({ userId: userIdSchema, name: z.string(), email: z.string(), since: z.number().int() })))
    .query(async ({ ctx }) => {
      const { db } = ctx.deps;
      const rows = await db.user.findMany({ where: { role: "admin" }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, email: true, createdAt: true } });
      const grants = await db.auditEntry.groupBy({
        by: ["entityId"],
        where: { action: "instance.admin-granted", entity: "user", entityId: { in: rows.map((row) => row.id) } },
        _max: { createdAt: true },
      });
      const grantedAt = new Map(grants.map((row) => [row.entityId, row._max.createdAt] as const));
      return rows.map((row) => ({ userId: userIdSchema.parse(row.id), name: row.name, email: row.email, since: (grantedAt.get(row.id) ?? row.createdAt).getTime() }));
    }),

  /** Makes an account an instance admin (instance admin only). Audited. */
  grantAdmin: instanceAdminProcedure
    .input(z.strictObject({ userId: userIdSchema }))
    .output(z.object({ instanceAdmin: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const result = unwrap(
        await grantInstanceAdmin({ db: ctx.deps.db, ...ctx.deps.ports }, { userId: ctx.user.userId, instanceAdmin: ctx.user.instanceAdmin }, { userId: input.userId, grant: true }),
        grantCodes,
      );
      return { instanceAdmin: result.instanceAdmin };
    }),

  /** Takes the instance admin role back (instance admin only). The last one can't give it up. Audited. */
  revokeAdmin: instanceAdminProcedure
    .input(z.strictObject({ userId: userIdSchema }))
    .output(z.object({ instanceAdmin: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const result = unwrap(
        await grantInstanceAdmin({ db: ctx.deps.db, ...ctx.deps.ports }, { userId: ctx.user.userId, instanceAdmin: ctx.user.instanceAdmin }, { userId: input.userId, grant: false }),
        grantCodes,
      );
      return { instanceAdmin: result.instanceAdmin };
    }),

  /**
   * Sets how long finished tasks' histories, archives and blobs are kept (F-079): a number of days,
   * or `null` to keep them while the task exists. What is saved here wins over `OSTRA_RETENTION_DAYS`,
   * and a saved "keep" wins too (spec section 11, item 11). Audited.
   */
  saveRetention: instanceAdminProcedure
    .input(z.strictObject({ days: z.number().int().min(1).max(36_500).nullable() }))
    .output(z.object({ days: z.number().int().nullable(), savedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const now = ports.clock.now();
      await db.$transaction(async (tx) => {
        await tx.instanceSetting.upsert({
          where: { id: "instance" },
          create: { id: "instance", retentionDays: input.days, retentionSetAt: new Date(now) },
          update: { retentionDays: input.days, retentionSetAt: new Date(now) },
        });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "retention.saved",
          entity: "organization",
          entityId: organizationId,
          data: { days: input.days },
        });
      });
      return { days: input.days, savedAt: now };
    }),
});
