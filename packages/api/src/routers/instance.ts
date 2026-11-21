import {
  checkPreviewDomain,
  createPreviewDomainProbe,
  grantInstanceAdmin,
  previewDomainCheckedSchema,
  previewDomainCheckSchema,
  previewDomainStatus,
  previewHost,
  previewHostOrigin,
  previewOriginOf,
  previewSharedSite,
  previewSiteLayout,
  savePreviewDomainCheck,
} from "@ostra/domain";
import type { PreviewDomainStatus } from "@ostra/domain";
import { previewIdSchema, userIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
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

// ---------- Instance › Previews (milestone 8, ticket 26, F-144; `instance-preview-domain.md`) ----------

/** The domain's last check, as the page shows it. */
const domainStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not-set") }),
  z.strictObject({ state: z.literal("unchecked"), domain: z.string() }),
  z.strictObject({ state: z.literal("checked"), domain: z.string(), check: previewDomainCheckedSchema, at: z.number().int(), byName: z.string().nullable(), passed: z.boolean() }),
]);

/** The one DNS record to add: a CNAME to core's host, or an A or AAAA record when core's public address is an IP. */
const dnsRecordSchema = z.strictObject({ name: z.string(), type: z.enum(["CNAME", "A", "AAAA"]), value: z.string() });

/**
 * The page's data: the settings it reads (never writes), whether the domain shares the panel's site
 * (Q307: allowed, with a warning), the record to add, a real preview's host as the example, the
 * cookie's `SameSite` by the install's layout, the check's last result, and the organization's
 * public-links switch with whether the viewer may change it.
 */
const instancePreviewsSchema = z.strictObject({
  domain: z.string().nullable(),
  /** A one-machine install's `preview.localhost`, with `OSTRA_PREVIEW_DOMAIN` unset (ADR 0068, 2026-11-21). */
  defaulted: z.boolean(),
  /** Under `localhost`: browsers send every name to the machine itself, so no record or certificate. */
  localhost: z.boolean(),
  panelHost: z.string(),
  coreHost: z.string(),
  /** The panel's site when the preview domain is on it, for the warning; `null` on a site of its own. */
  sharedSite: z.string().nullable(),
  sameSite: z.enum(["lax", "none-partitioned"]).nullable(),
  record: dnsRecordSchema.nullable(),
  /** A real preview's host in the organization, or `null` for the pattern. */
  exampleHost: z.string().nullable(),
  status: domainStatusSchema,
  organization: z.strictObject({ name: z.string(), admin: z.boolean(), publicPreviewLinks: z.boolean() }),
  linkMaxDays: z.number().int(),
  /** The docs' page on the preview domain (`OSTRA_DOCS_URL`), for the top bar's link and `Why`. */
  docs: z.string(),
});
export type InstancePreviews = z.infer<typeof instancePreviewsSchema>;

const isIpv4 = (host: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

/** The record for `*.<domain>`, pointing at core's public host. */
const recordFor = (domain: string, corePublicUrl: string): z.infer<typeof dnsRecordSchema> => {
  const host = new URL(corePublicUrl).hostname.replace(/^\[|\]$/g, "");
  return { name: `*.${domain}`, type: isIpv4(host) ? "A" : host.includes(":") ? "AAAA" : "CNAME", value: host };
};

/** The host of the organization's newest native preview, for the page's example; `null` before one opened. */
const exampleHostOf = async (deps: ApiDeps, organizationId: string, domain: string): Promise<string | null> => {
  const code = await deps.db.previewCode.findFirst({
    where: { organizationId, kind: "enter", task: { previewId: { not: null } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { port: true, task: { select: { previewId: true } } },
  });
  const previewId = previewIdSchema.safeParse(code?.task.previewId);
  if (code === null || !previewId.success) {
    return null;
  }
  return new URL(previewHostOrigin(previewHost(code.port, previewId.data, domain), previewOriginOf(deps.settings.corePublicUrl))).host;
};

/** The status as the page's schema holds it. */
const statusView = (status: PreviewDomainStatus): z.infer<typeof domainStatusSchema> => status;

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
  previewDomainCheck: instanceAdminProcedure.output(previewDomainCheckSchema).mutation(async ({ ctx }) => {
    const domain = ctx.deps.settings.previews.domain;
    const check = await checkPreviewDomain(
      { probe: ctx.deps.previews.domainProbe ?? createPreviewDomainProbe(), mark: ctx.deps.previews.checkMark, clock: ctx.deps.ports.clock },
      { domain, corePublicUrl: ctx.deps.settings.corePublicUrl },
    );
    // Ticket 26: its result is kept for the install, with who ran it, and the run is audited.
    await savePreviewDomainCheck({ db: ctx.deps.db, audit: ctx.deps.ports.audit, clock: ctx.deps.ports.clock }, { kind: "member", userId: ctx.user.userId, scope: ctx.scope }, { domain, check });
    return check;
  }),

  /**
   * Instance › Previews (ticket 26, F-144, F-142; `instance-preview-domain.md`): the preview domain as
   * configured, read-only; the record and certificate to add; the check's last result; and the
   * organization's "Allow public preview links", which only its admins change.
   */
  previews: instanceAdminProcedure.output(instancePreviewsSchema).query(async ({ ctx }) => {
    const { db, settings } = ctx.deps;
    const domain = settings.previews.domain;
    const organizationId = ctx.scope.organizationId;
    const [organization, setting, status] = await Promise.all([
      db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } }),
      db.organizationSetting.findUnique({ where: { organizationId }, select: { publicPreviewLinks: true } }),
      previewDomainStatus(db, domain),
    ]);
    const localhost = domain !== null && (domain === "localhost" || domain.endsWith(".localhost"));
    return {
      domain,
      defaulted: settings.previews.localDefault,
      localhost,
      panelHost: new URL(settings.publicUrl).host,
      coreHost: new URL(settings.corePublicUrl).host,
      sharedSite: domain === null ? null : previewSharedSite(settings.publicUrl, domain),
      sameSite: domain === null ? null : previewSiteLayout(settings.publicUrl, domain) === "same-site" ? "lax" : "none-partitioned",
      record: domain === null || localhost ? null : recordFor(domain, settings.corePublicUrl),
      exampleHost: domain === null ? null : await exampleHostOf(ctx.deps, organizationId, domain),
      status: statusView(status),
      organization: { name: organization.name, admin: ctx.scope.role === "admin", publicPreviewLinks: setting?.publicPreviewLinks ?? false },
      linkMaxDays: settings.previews.linkMaxDays,
      docs: `${settings.docsUrl}install/preview-domain/`,
    };
  }),
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
