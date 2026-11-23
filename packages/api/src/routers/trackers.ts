import {
  checkJiraToken,
  disconnectTracker,
  findJiraSite,
  findJiraSiteInputSchema,
  finishJiraPolling,
  jiraConnectionInputSchema,
  jiraProjectPermissions,
  jiraTokenInputSchema,
  jiraTokenScopes,
  jiraWebhookOf,
  jiraWebhookUrl,
  linearAddressProblems,
  recheckJiraToken,
  renameConnection,
  replaceJiraToken,
  requireOrganizationAdmin,
  rotateJiraSecret,
  saveJiraToken,
  startTrackerConnection,
  tokenExpiryState,
  trackerKinds,
  visibleProjects,
} from "@ostra/domain";
import type { JiraConnectionDeps, JiraTokenReadBack, MemberScope, SaveJiraTokenResult, TrackerConnection } from "@ostra/domain";
import { boardIdSchema, connectionIdSchema, projectIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { connectionHolderSchema, linearConnectionStatusOf, linearConnectionStatusSchema, trackerChangeDepsOf, trackersLinearRouter } from "./linear.ts";

// Milestone 11, ticket 09 (F-152, F-008, F-005, F-076; ADR 0071, ADR 0047; spec section 4): an
// organization's tracker connections, of any kind, each named, one per site or workspace.
// - `trackers.list` and `trackers.get` serve Organization › Trackers and a connection's page
//   (`app-targets/m11-trackers/trackers.md`, `connection-settings.md`). A member reads both, with
//   no webhook URL, secret, service account email or token detail, and only the boards of the
//   projects they may open; another organization's connection is `NOT_FOUND`.
// - `create`, `rename` and `disconnect`, and `trackers.jira.*` (Jira's three connect steps and its
//   changes, `jira-connect.md`) and `trackers.linear.*` (Linear's, per connection), are an
//   organization admin's, each audited by the domain.
// Every output is built field by field from the domain's view: no token, secret or Jira body.
// The step outcomes the panel draws in place (a site another connection holds, a token Jira
// refused, a read-back with a red line) are answered, not thrown, so their holder, status code
// and read-back reach the page.

const kindSchema = z.enum(trackerKinds);
const stateSchema = z.enum(["pending", "active", "failed"]);
const modeSchema = z.enum(["webhooks", "polling"]);

/** What a connection's adapter declares (`TrackerCapabilities`): the panel shows a row only where it does. */
const capabilitiesSchema = z.object({
  agentSessions: z.boolean(),
  subIssues: z.boolean(),
  statusGraph: z.boolean(),
  webhooks: z.boolean(),
  commentEdit: z.boolean(),
  attachments: z.boolean(),
  transitions: z.boolean(),
  mentions: z.boolean(),
  agentScopes: z.array(z.string()).readonly(),
  agentSessionLink: z.boolean(),
  ticketFields: z.object({ acceptanceCriteria: z.boolean() }),
  ticketFiles: z.enum(["all", "images", "none"]),
  magicWords: z.boolean(),
  richText: z.enum(["markdown", "adf"]),
  jqlFilter: z.boolean(),
});

/** The token's date against today (Jira's, from the date the admin gave). */
const tokenExpirySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("healthy") }),
  z.object({ state: z.literal("expires-soon"), days: z.number().int() }),
  z.object({ state: z.literal("expired") }),
]);

/** A board on the connection, and the project it's attached to. */
const boardSchema = z.object({ id: boardIdSchema, name: z.string(), key: z.string().nullable(), project: z.object({ id: projectIdSchema, name: z.string() }) });

/** A connection as Trackers lists it. The fields marked "admins" are `null` for a member. */
const connectionFields = {
  id: connectionIdSchema,
  kind: kindSchema,
  name: z.string(),
  /** Linear's workspace URL key, or Jira's host (`globex.atlassian.net`); `null` until known. */
  site: z.string().nullable(),
  state: stateSchema,
  webhookMode: modeSchema,
  lastEventAt: z.number().int().nullable(),
  /** `token-refused`, `token-expired`, or Linear's own reasons. */
  failedReason: z.string().nullable(),
  /** Webhooks silent since then, while polling still finds changes. */
  silentSince: z.number().int().nullable(),
  /** Admins: Jira's token's expiry date, as midnight UTC of the day the admin gave; `null` for Linear. */
  tokenExpiresAt: z.number().int().nullable(),
  /** Admins: Jira's token's date against today (`Token expires` from 14 days before); `null` for Linear. */
  tokenExpiry: tokenExpirySchema.nullable(),
  /** Admins: who it signs in as, Jira's service account or Linear's app user, by display name. */
  signsInAs: z.string().nullable(),
  /** Linear's agent mode, on since then; `null` when off, and for Jira. */
  agentModeAt: z.number().int().nullable(),
  /** Its boards that aren't detached, oldest first: for a member, only those of projects they may open. */
  boards: z.array(boardSchema),
  capabilities: capabilitiesSchema,
  createdAt: z.number().int(),
};

const connectionItemSchema = z.object(connectionFields);
type ConnectionItem = z.infer<typeof connectionItemSchema>;

const listSchema = z.object({
  /** Whether the reader is an organization admin: Connect a tracker, and every change, are theirs. */
  canManage: z.boolean(),
  connections: z.array(connectionItemSchema),
});

const lastEventSchema = z.object({ at: z.number().int(), type: z.string().nullable(), ticketKey: z.string().nullable() }).nullable();

/** A project a Jira token reaches, with the permissions it holds there and lacks. */
const reachProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  permissions: z.array(z.enum(jiraProjectPermissions)),
  missing: z.array(z.enum(jiraProjectPermissions)),
});

/** Jira's part of a connection's page (`connection-settings.md`, `jira-connect.md`). */
const jiraDetailSchema = z.object({
  /** The site's cloud ID; `null` before step 1. */
  cloudId: z.string().nullable(),
  /** Admins: the service account's email. */
  email: z.string().nullable(),
  /** Admins: what the last read-back found the token reaches, and when; `null` before step 2. */
  reach: z.object({ projects: z.array(reachProjectSchema), checkedAt: z.number().int().nullable() }).nullable(),
  /** Whether the token reads workflows (`read:workflow:jira`); `null` before the read-back. */
  workflowsReadable: z.boolean().nullable(),
  /** Admins: the scopes the last read-back confirmed. */
  scopes: z.array(z.string()),
  /** The scopes a token needs (choice 5), for step 2's chips and the panel's Scopes. */
  neededScopes: z.array(z.enum(jiraTokenScopes)),
  /** The six events the admin webhook sends. */
  webhookEvents: z.array(z.string()),
  /** Admins: where Jira delivers this connection's events, in webhooks mode while the install's address is public. */
  webhookUrl: z.string().nullable(),
  /** Admins: Jira's WebHooks page on the site. */
  webhooksPage: z.string().nullable(),
  /** The first signed delivery: the secret is shown (by `trackers.jira.webhook`) until then. */
  firstDeliveryAt: z.number().int().nullable(),
  /** Admins: the last delivery refused for its signature. */
  badSignatureAt: z.number().int().nullable(),
  /** Why the connection polls: the address pre-check's code; `null` in webhooks mode. */
  modeReason: z.enum(linearAddressProblems).nullable(),
  pollSeconds: z.number().int(),
  reconcileMinutes: z.number().int(),
  lastEvent: lastEventSchema,
  lastPollAt: z.number().int().nullable(),
  activatedAt: z.number().int().nullable(),
  startedAt: z.number().int(),
  startedByName: z.string().nullable(),
});

const getSchema = z.discriminatedUnion("kind", [
  z.object({
    ...connectionFields,
    kind: z.literal("linear"),
    /** Admins: Linear's page as `linear.status` has drawn it since milestone 2; `null` for a member. */
    linear: linearConnectionStatusSchema.nullable(),
  }),
  z.object({ ...connectionFields, kind: z.literal("jira"), jira: jiraDetailSchema }),
]);

const isAdmin = (scope: MemberScope): boolean => requireOrganizationAdmin(scope, scope.organizationId).ok;

/** A connection as the reader may see it: admins whole, a member without token details or other projects' boards. */
const itemOf = (deps: ApiDeps, scope: MemberScope, view: TrackerConnection, signsInAs: ReadonlyMap<string, string | null>): ConnectionItem => {
  const admin = isAdmin(scope);
  const projects = visibleProjects(
    scope,
    view.boards.map((board) => ({ id: board.project.id, organizationId: scope.organizationId, access: board.project.access })),
  ).map((project) => project.id);
  const jira = view.kind === "jira" ? view : null;
  const expiresOn = jira?.tokenExpiresOn ?? null;
  const expiresAt = expiresOn === null ? null : Date.parse(`${expiresOn}T00:00:00Z`);
  return {
    id: view.id,
    kind: view.kind,
    name: view.name,
    site: view.site,
    state: view.state,
    webhookMode: view.webhookMode,
    lastEventAt: view.lastEventAt,
    failedReason: view.failedReason,
    silentSince: view.silentSince,
    tokenExpiresAt: admin && expiresAt !== null && !Number.isNaN(expiresAt) ? expiresAt : null,
    tokenExpiry: admin && expiresOn !== null ? tokenExpiryState({ tokenExpiresOn: expiresOn }, deps.ports.clock.now()) : null,
    signsInAs: admin ? (signsInAs.get(view.id) ?? null) : null,
    agentModeAt: view.kind === "linear" ? view.agentModeAt : null,
    boards: view.boards
      .filter((board) => projects.includes(board.project.id))
      .map((board) => ({ id: board.id, name: board.name, key: board.key, project: { id: board.project.id, name: board.project.name } })),
    capabilities: view.capabilities,
    createdAt: view.createdAt,
  };
};

/**
 * Who each connection signs in as, by display name: Jira's service account as its read-back named
 * it, Linear's app user. Read for the admins' rows only.
 */
const signsInAsOf = async (deps: ApiDeps, scope: MemberScope, ids: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
  if (!isAdmin(scope) || ids.length === 0) {
    return new Map();
  }
  const rows = await deps.db.connection.findMany({ where: { organizationId: scope.organizationId, id: { in: [...ids] } }, select: { id: true, appUserName: true } });
  return new Map(rows.map((row) => [row.id, row.appUserName]));
};

/** The connection by its ID in the reader's organization, or `NOT_FOUND`: another organization's, a revoked one, or none. */
const connectionOrMissing = async (deps: ApiDeps, organizationId: OrganizationId, id: z.infer<typeof connectionIdSchema>): Promise<TrackerConnection> => {
  const view = await deps.trackers.connectionOf(organizationId, id);
  if (view === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such tracker connection" });
  }
  return view;
};

/** Core's public address, or why it isn't one: webhooks need an address Jira and Linear can reach. */
const addressOf = (deps: ApiDeps) => {
  const check = deps.linear.checkPublicUrl(deps.settings.corePublicUrl);
  return check.public ? { corePublicUrl: deps.settings.corePublicUrl, problem: null } : { corePublicUrl: null, problem: check.problem };
};

/** What Jira's connect steps need (`JiraConnectionDeps`). */
const jiraDepsOf = (ctx: { readonly deps: ApiDeps; readonly scope: MemberScope }): JiraConnectionDeps => {
  const { db, ports, jira } = ctx.deps;
  const address = addressOf(ctx.deps);
  return {
    db,
    scope: ctx.scope,
    jira,
    adapters: ports.adapters,
    audit: ports.audit,
    notices: ports.notices,
    clock: ports.clock,
    corePublicUrl: address.corePublicUrl,
    corePublicUrlProblem: address.problem,
  };
};

/** Jira's page: its read-back, events and polls, with the admin's fields `null` for a member. */
const jiraDetailOf = async (deps: ApiDeps, scope: MemberScope, view: Extract<TrackerConnection, { readonly kind: "jira" }>): Promise<z.infer<typeof jiraDetailSchema>> => {
  const { db, settings, jira } = deps;
  const admin = isAdmin(scope);
  const organizationId = scope.organizationId;
  const [row, delivery, polled] = await Promise.all([
    db.connection.findFirstOrThrow({ where: { id: view.id, organizationId }, select: { scopes: true, accessCheckedAt: true, activatedAt: true, createdAt: true, createdByMemberId: true } }),
    db.webhookDelivery.findFirst({ where: { organizationId, connectionId: view.id }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, event: true, ticketKey: true } }),
    db.board.aggregate({ where: { organizationId, connectionId: view.id }, _max: { lastPolledAt: true } }),
  ]);
  const starter = row.createdByMemberId === null ? null : await db.member.findFirst({ where: { id: row.createdByMemberId, organizationId }, select: { user: { select: { name: true } } } });
  const address = addressOf(deps);
  const deliveredAt = delivery?.receivedAt.getTime() ?? null;
  const lastEventAt = Math.max(deliveredAt ?? 0, view.lastEventAt ?? 0);
  return {
    cloudId: view.cloudId,
    email: admin ? view.accountEmail : null,
    reach:
      !admin || view.accessCheck === null
        ? null
        : {
            projects: view.accessCheck.projects.map((project) => ({
              id: project.id,
              key: project.key,
              name: project.name,
              permissions: [...project.permissions],
              missing: jiraProjectPermissions.filter((permission) => !project.permissions.includes(permission)),
            })),
            checkedAt: row.accessCheckedAt?.getTime() ?? null,
          },
    workflowsReadable: view.workflowsReadable,
    scopes: admin ? [...row.scopes] : [],
    neededScopes: [...jira.scopes],
    webhookEvents: [...jira.webhookEvents],
    webhookUrl: admin && view.webhookMode === "webhooks" && address.corePublicUrl !== null ? jiraWebhookUrl(address.corePublicUrl, view.id) : null,
    webhooksPage: admin && view.site !== null ? jira.webhooksPage(view.site) : null,
    firstDeliveryAt: view.firstDeliveryAt,
    badSignatureAt: admin ? view.badSignatureAt : null,
    modeReason: view.webhookMode === "polling" ? address.problem : null,
    pollSeconds: settings.trackerPollSeconds,
    reconcileMinutes: settings.reconcileMinutes,
    lastEvent:
      lastEventAt === 0
        ? null
        : { at: lastEventAt, type: lastEventAt === deliveredAt ? (delivery?.event ?? null) : null, ticketKey: lastEventAt === deliveredAt ? (delivery?.ticketKey ?? null) : null },
    lastPollAt: polled._max.lastPolledAt?.getTime() ?? null,
    activatedAt: row.activatedAt?.getTime() ?? null,
    startedAt: row.createdAt.getTime(),
    startedByName: starter?.user.name ?? null,
  };
};

// ---------- trackers.jira.* ----------

const accountCheckSchema = z.object({ outcome: z.enum(["ok", "warn", "fail"]), accountId: z.string(), name: z.string(), accountType: z.string().nullable() });
const projectRefSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });

/** Step 2's four checks and the scopes, as the read-back found them: IDs, names and outcomes only. */
const tokenChecksSchema = z.object({
  kind: z.literal("checked"),
  account: accountCheckSchema,
  projects: z.object({ outcome: z.enum(["ok", "fail"]), projects: z.array(projectRefSchema).readonly() }),
  permissions: z.object({
    outcome: z.enum(["ok", "warn"]),
    projects: z.array(projectRefSchema.extend({ missing: z.array(z.enum(jiraProjectPermissions)).readonly() })).readonly(),
  }),
  workflows: z.object({ outcome: z.enum(["ok", "warn"]), readable: z.boolean(), unreadable: z.array(projectRefSchema).readonly() }),
  scopes: z.array(z.object({ scope: z.enum(jiraTokenScopes), state: z.enum(["confirmed", "refused", "unchecked"]) })).readonly(),
});

/** What step 2 reads back: the checks, Jira refusing the token itself (its status code), or Jira not answering. */
const readBackSchema = z.discriminatedUnion("kind", [
  tokenChecksSchema,
  z.object({ kind: z.literal("refused"), status: z.union([z.literal(401), z.literal(403)]) }),
  z.object({ kind: z.literal("unreachable"), status: z.number().int().nullable() }),
]);

const verdictSchema = z.enum(["pass", "warnings", "fail"]);

/** A read-back as the panel draws it: field by field, so nothing Jira added rides along. */
const readBackOf = (readBack: JiraTokenReadBack): z.infer<typeof readBackSchema> => {
  switch (readBack.kind) {
    case "checked":
      return {
        kind: "checked",
        account: { outcome: readBack.account.outcome, accountId: readBack.account.accountId, name: readBack.account.name, accountType: readBack.account.accountType },
        projects: { outcome: readBack.projects.outcome, projects: readBack.projects.projects.map(projectRefOf) },
        permissions: { outcome: readBack.permissions.outcome, projects: readBack.permissions.projects.map((project) => ({ ...projectRefOf(project), missing: [...project.missing] })) },
        workflows: { outcome: readBack.workflows.outcome, readable: readBack.workflows.readable, unreadable: readBack.workflows.unreadable.map(projectRefOf) },
        scopes: readBack.scopes.map((scope) => ({ scope: scope.scope, state: scope.state })),
      };
    case "refused":
      return { kind: "refused", status: readBack.status };
    case "unreachable":
      return { kind: "unreachable", status: readBack.status };
    default:
      return readBack satisfies never;
  }
};

const projectRefOf = (project: { readonly id: string; readonly key: string; readonly name: string }) => ({ id: project.id, key: project.key, name: project.name });

/**
 * Save and Replace: stored after the read-back passes or only warns; or the refusal the step draws
 * (Jira's status code, the read-back's red lines, Jira not answering). Every other failure is a
 * tRPC error.
 */
const storedSchema = z.union([
  z.object({
    ok: z.literal(true),
    connectionId: connectionIdSchema,
    readBack: tokenChecksSchema,
    verdict: z.enum(["pass", "warnings"]),
    tokenExpiresOn: z.iso.date(),
    state: z.enum(["pending", "active"]),
  }),
  z.object({ ok: z.literal(false), error: z.literal("token-refused"), message: z.string(), status: z.union([z.literal(401), z.literal(403)]) }),
  z.object({ ok: z.literal(false), error: z.literal("token-failed"), message: z.string(), readBack: tokenChecksSchema }),
  z.object({ ok: z.literal(false), error: z.literal("unreachable"), message: z.string() }),
]);

const storedOf = (result: SaveJiraTokenResult): z.infer<typeof storedSchema> => {
  if (result.ok) {
    const readBack = readBackOf(result.readBack);
    if (readBack.kind !== "checked") {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The read-back changed shape" });
    }
    return { ok: true, connectionId: result.connectionId, readBack, verdict: result.verdict, tokenExpiresOn: result.tokenExpiresOn, state: result.state };
  }
  switch (result.error) {
    case "token-refused":
      return { ok: false, error: "token-refused", message: result.message, status: result.status };
    case "token-failed": {
      const readBack = readBackOf(result.readBack);
      if (readBack.kind !== "checked") {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The read-back changed shape" });
      }
      return { ok: false, error: "token-failed", message: result.message, readBack };
    }
    case "unreachable":
      return { ok: false, error: "unreachable", message: result.message };
    case "forbidden":
    case "no-connection":
    case "no-site":
    case "not-pending":
    case "not-connected":
    case "expired-date":
    case "changed":
      throw new TRPCError({ code: storeRefusals[result.error], message: result.message });
    default:
      return result satisfies never;
  }
};

/** Save's and Replace's failures that aren't the step's own to draw. */
const storeRefusals = {
  forbidden: "FORBIDDEN",
  "no-connection": "NOT_FOUND",
  "no-site": "PRECONDITION_FAILED",
  "not-pending": "CONFLICT",
  "not-connected": "PRECONDITION_FAILED",
  "expired-date": "BAD_REQUEST",
  changed: "CONFLICT",
} as const satisfies Record<string, TRPC_ERROR_CODE_KEY>;

/** Step 1's answer: the site found, or the refusal drawn under the field (a holder named for `Open it →`). */
const siteSchema = z.union([
  z.object({
    ok: z.literal(true),
    connectionId: connectionIdSchema,
    cloudId: z.string(),
    host: z.string(),
    title: z.string(),
    name: z.string(),
    webhooksPage: z.string().nullable(),
    /** A changed site cleared steps 2 and 3. */
    cleared: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.enum(["not-found", "data-center", "unreachable", "name-taken"]), message: z.string() }),
  z.object({ ok: z.literal(false), error: z.literal("site-taken"), message: z.string(), holder: connectionHolderSchema }),
]);

/** Step 3's answer: the webhook's values while webhooks reach the install, or polling and why. */
const webhookSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("webhooks"),
    /** `null` when the install's address stopped passing the pre-check. */
    url: z.string().nullable(),
    /** The secret, only until the first signed delivery; then `null`, and only Rotate makes a new one. */
    secret: z.string().nullable(),
    events: z.array(z.string()),
    jql: z.string().nullable(),
    webhooksPage: z.string().nullable(),
    firstDeliveryAt: z.number().int().nullable(),
    badSignatureAt: z.number().int().nullable(),
    lastEventAt: z.number().int().nullable(),
  }),
  z.object({ mode: z.literal("polling"), reason: z.enum(linearAddressProblems).nullable() }),
]);

/** Step 1's failures that aren't the step's own to draw. */
const siteRefusals = { forbidden: "FORBIDDEN", "no-connection": "NOT_FOUND", "not-pending": "CONFLICT", "invalid-name": "BAD_REQUEST" } as const satisfies Record<string, TRPC_ERROR_CODE_KEY>;

const trackersJiraRouter = router({
  /**
   * Step 1: the site's cloud ID from its name, host or a pasted URL. A site no Jira Cloud answers
   * at, a Data Center address, a site that doesn't answer, a name another connection holds, and a
   * site another connection of the organization holds (named, with its ID) are answered as such.
   */
  findSite: adminProcedure
    .input(findJiraSiteInputSchema)
    .output(siteSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await findJiraSite(jiraDepsOf(ctx), input);
      if (result.ok) {
        return {
          ok: true as const,
          connectionId: result.connectionId,
          cloudId: result.cloudId,
          host: result.host,
          title: result.title,
          name: result.name,
          webhooksPage: result.webhooksPage,
          cleared: result.cleared,
        };
      }
      switch (result.error) {
        case "site-taken":
          return { ok: false as const, error: result.error, message: result.message, holder: { id: result.holder.id, name: result.holder.name } };
        case "not-found":
        case "data-center":
        case "unreachable":
        case "name-taken":
          return { ok: false as const, error: result.error, message: result.message };
        case "forbidden":
        case "no-connection":
        case "not-pending":
        case "invalid-name":
          throw new TRPCError({ code: siteRefusals[result.error], message: result.message });
        default:
          return result satisfies never;
      }
    }),

  /** Step 2's `Check the token`: the read-back with the pasted token, held for the call. Nothing is stored. */
  checkToken: adminProcedure
    .input(jiraTokenInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, readBack: readBackSchema, verdict: verdictSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const checked = unwrap(await checkJiraToken(jiraDepsOf(ctx), input), {
        forbidden: "FORBIDDEN",
        "no-connection": "NOT_FOUND",
        "no-site": "PRECONDITION_FAILED",
        "expired-date": "BAD_REQUEST",
      });
      return { connectionId: checked.connectionId, readBack: readBackOf(checked.readBack), verdict: checked.verdict };
    }),

  /** Step 2's `Save and continue`: the read-back again, then the token to the secret store. */
  saveToken: adminProcedure
    .input(jiraTokenInputSchema)
    .output(storedSchema)
    .mutation(async ({ ctx, input }) => storedOf(await saveJiraToken(jiraDepsOf(ctx), input))),

  /** `Replace` on a connected (or failed) connection: the read-back first, then the new token takes the old one's place. */
  replaceToken: adminProcedure
    .input(jiraTokenInputSchema)
    .output(storedSchema)
    .mutation(async ({ ctx, input }) => storedOf(await replaceJiraToken(jiraDepsOf(ctx), input))),

  /** `Check again`: the read-back with the saved token, kept as the connection's last. */
  recheck: adminProcedure
    .input(jiraConnectionInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, readBack: readBackSchema, verdict: verdictSchema.nullable(), state: stateSchema }))
    .mutation(async ({ ctx, input }) => {
      const checked = unwrap(await recheckJiraToken(jiraDepsOf(ctx), input), {
        forbidden: "FORBIDDEN",
        "no-connection": "NOT_FOUND",
        "not-ready": "PRECONDITION_FAILED",
        changed: "CONFLICT",
      });
      return { connectionId: checked.connectionId, readBack: readBackOf(checked.readBack), verdict: checked.verdict, state: checked.state };
    }),

  /**
   * Step 3: the webhook's URL, the six events, the suggested JQL, and the secret while no delivery
   * has arrived (made on the first call while pending); the page polls it for `firstDeliveryAt`
   * and `badSignatureAt`. An admin's only: no secret ever reaches a member.
   */
  webhook: adminProcedure
    .input(jiraConnectionInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, webhook: webhookSchema }))
    .query(async ({ ctx, input }) => {
      const made = unwrap(await jiraWebhookOf(jiraDepsOf(ctx), input), { forbidden: "FORBIDDEN", "no-connection": "NOT_FOUND", "not-ready": "PRECONDITION_FAILED" });
      const webhook = made.webhook;
      return {
        connectionId: made.connectionId,
        webhook:
          webhook.mode === "polling"
            ? { mode: "polling" as const, reason: webhook.reason }
            : {
                mode: "webhooks" as const,
                url: webhook.url,
                secret: webhook.secret,
                events: [...webhook.events],
                jql: webhook.jql,
                webhooksPage: webhook.webhooksPage,
                firstDeliveryAt: webhook.firstDeliveryAt,
                badSignatureAt: webhook.badSignatureAt,
                lastEventAt: webhook.lastEventAt,
              },
      };
    }),

  /** Step 3's `Finish` without a public address, or `Use polling instead`: active at once, polling. */
  finishPolling: adminProcedure
    .input(jiraConnectionInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, mode: z.literal("polling"), resumedBoards: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const done = unwrap(await finishJiraPolling(jiraDepsOf(ctx), input), {
        forbidden: "FORBIDDEN",
        "no-connection": "NOT_FOUND",
        "not-pending": "CONFLICT",
        "not-ready": "PRECONDITION_FAILED",
        changed: "CONFLICT",
      });
      return { connectionId: done.connectionId, mode: done.mode, resumedBoards: done.resumedBoards };
    }),

  /** `Rotate the secret`, or step 3's `Make a new secret`: the new secret, answered this once. */
  rotateSecret: adminProcedure
    .input(jiraConnectionInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, secret: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const rotated = unwrap(await rotateJiraSecret(jiraDepsOf(ctx), input), {
        forbidden: "FORBIDDEN",
        "no-connection": "NOT_FOUND",
        polling: "PRECONDITION_FAILED",
        "not-ready": "PRECONDITION_FAILED",
        changed: "CONFLICT",
      });
      return { connectionId: rotated.connectionId, secret: rotated.secret };
    }),
});

// ---------- trackers.* ----------

const createdSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("linear"),
    connectionId: connectionIdSchema,
    name: z.string(),
    mode: modeSchema,
    modeReason: z.enum(linearAddressProblems).nullable(),
    /** Linear's "create an app from this manifest" link, pre-filled. */
    manifestUrl: z.string(),
    callbackUrl: z.string(),
    webhookUrl: z.string().nullable(),
  }),
  z.object({ kind: z.literal("jira"), connectionId: connectionIdSchema, name: z.string(), mode: modeSchema, modeReason: z.enum(linearAddressProblems).nullable() }),
]);

export const trackersRouter = router({
  /**
   * Every tracker connection of the organization that isn't revoked, of any kind, oldest first,
   * with its mode, last event, state, boards and its adapter's capabilities (trackers.md, "Data").
   */
  list: memberProcedure.output(listSchema).query(async ({ ctx }) => {
    const views = await ctx.deps.trackers.connectionsOf(ctx.scope.organizationId);
    const signsInAs = await signsInAsOf(ctx.deps, ctx.scope, views.map((view) => view.id));
    return { canManage: isAdmin(ctx.scope), connections: views.map((view) => itemOf(ctx.deps, ctx.scope, view, signsInAs)) };
  }),

  /** One connection's page: the list's row, and Jira's read-back and events, or Linear's status (connection-settings.md). */
  get: memberProcedure
    .input(z.strictObject({ id: connectionIdSchema }))
    .output(getSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const view = await connectionOrMissing(ctx.deps, organizationId, input.id);
      const item = itemOf(ctx.deps, ctx.scope, view, await signsInAsOf(ctx.deps, ctx.scope, [view.id]));
      switch (view.kind) {
        case "linear": {
          if (!isAdmin(ctx.scope)) {
            return { ...item, kind: "linear" as const, linear: null };
          }
          const row = await ctx.deps.db.connection.findFirstOrThrow({ where: { id: view.id, organizationId } });
          return { ...item, kind: "linear" as const, linear: await linearConnectionStatusOf(ctx.deps, organizationId, row) };
        }
        case "jira":
          return { ...item, kind: "jira" as const, jira: await jiraDetailOf(ctx.deps, ctx.scope, view) };
        default:
          return view satisfies never;
      }
    }),

  /**
   * `Continue with <kind>` in the picker: a new named `pending` connection (Linear's with its
   * manifest link, Jira's waiting for its three steps). Audited `tracker.connection-created`.
   */
  create: adminProcedure
    .input(z.strictObject({ kind: kindSchema, name: z.string().optional() }))
    .output(createdSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await startTrackerConnection(trackerChangeDepsOf(ctx), input.name === undefined ? { kind: input.kind } : { kind: input.kind, name: input.name });
      const started = unwrap(result, { forbidden: "FORBIDDEN", "invalid-name": "BAD_REQUEST", "name-taken": "CONFLICT", "not-found": "NOT_FOUND", "not-pending": "CONFLICT" });
      switch (started.kind) {
        case "linear":
          return {
            kind: "linear" as const,
            connectionId: started.connectionId,
            name: started.name,
            mode: started.mode,
            modeReason: started.modeReason,
            manifestUrl: started.manifestUrl,
            callbackUrl: started.callbackUrl,
            webhookUrl: started.webhookUrl,
          };
        case "jira":
          return { kind: "jira" as const, connectionId: started.connectionId, name: started.name, mode: started.mode, modeReason: started.modeReason };
        default:
          return started satisfies never;
      }
    }),

  /** The header's pencil: what boards, tickets and the panel call it. A name another connection holds is `CONFLICT`. Audited `tracker.renamed`. */
  rename: adminProcedure
    .input(z.strictObject({ id: connectionIdSchema, name: z.string() }))
    .output(z.object({ id: connectionIdSchema, name: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const renamed = unwrap(await renameConnection({ db, scope: ctx.scope, audit: ports.audit, notices: ports.notices }, { connectionId: input.id, name: input.name }), {
        forbidden: "FORBIDDEN",
        "no-connection": "NOT_FOUND",
        "invalid-name": "BAD_REQUEST",
        "name-taken": "CONFLICT",
      });
      return { id: renamed.connectionId, name: renamed.name };
    }),

  /**
   * Disconnect (ADR 0071, choice 12): the connection's secrets deleted (Linear's token revoked at
   * Linear first), its open agent sessions ended, and it `revoked`. Its boards pause; the same site
   * connected again resumes them. Audited `tracker.disconnected`.
   */
  disconnect: adminProcedure
    .input(z.strictObject({ id: connectionIdSchema }))
    .output(z.object({ id: connectionIdSchema, kind: kindSchema, revokedAtTracker: z.boolean(), pausedBoards: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const done = unwrap(await disconnectTracker(trackerChangeDepsOf(ctx), { connectionId: input.id }), { forbidden: "FORBIDDEN", "no-connection": "NOT_FOUND" });
      const pausedBoards = await ctx.deps.db.board.count({ where: { organizationId, connectionId: input.id, detachedAt: null } });
      return { id: done.connectionId, kind: done.kind, revokedAtTracker: done.revokedAtTracker, pausedBoards };
    }),

  jira: trackersJiraRouter,
  linear: trackersLinearRouter,
});
