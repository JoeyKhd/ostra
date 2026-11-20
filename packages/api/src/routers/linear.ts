import {
  authorizeLinear,
  authorizeLinearInputSchema,
  connectLinear,
  connectLinearInputSchema,
  createLinearAuthorizeUrl,
  authorizeUrlInputSchema,
  disconnectLinear,
  disconnectLinearInputSchema,
  linearAppName,
  linearCallbackUrl,
  linearWebhookUrl,
  startLinearConnection,
} from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";

// F-005, F-042, ticket 27: the organization's Linear connection. Every procedure is for organization
// admins and works inside their organization only (ADR 0026), `status` included: a member gets what
// they need of the connection from the boards and the Inbox. The app's client secret, the webhook
// signing secret, the tokens and the PKCE verifier go to the secret store at once, and no
// procedure, log line or audit entry carries one: every output is built field by field.

const modeSchema = z.enum(["webhooks", "polling"]);

const commonSchema = z.object({
  mode: modeSchema,
  /** The address pre-check's words when the mode is polling; `null` for webhooks. */
  modeReason: z.string().nullable(),
  /** What the app asks for at authorize time, read-only. */
  scopes: z.array(z.string()),
  /** The webhook resource types the manifest subscribes to, read-only. */
  webhookEvents: z.array(z.string()),
  /** `OSTRA_TRACKER_POLL_SECONDS`, read-only. */
  pollSeconds: z.number().int(),
  /** `OSTRA_RECONCILE_MINUTES`, read-only. */
  reconcileMinutes: z.number().int(),
});

const noneSchema = commonSchema.extend({
  state: z.literal("none"),
  /** The revoked connection this one replaces, for "Disconnected from … on …". */
  lastRevoked: z.object({ workspaceKey: z.string().nullable(), at: z.number().int() }).nullable(),
});

const connectionSchema = commonSchema.extend({
  state: z.enum(["pending", "active", "failed"]),
  connectionId: connectionIdSchema,
  /** `api_key` is the development seed: the page labels it `Personal API key (development)`. */
  credentialKind: z.enum(["app_oauth", "app_client_credentials", "api_key"]),
  workspaceKey: z.string().nullable(),
  workspaceName: z.string().nullable(),
  appUserName: z.string().nullable(),
  activatedAt: z.number().int().nullable(),
  /** When the state last changed: the time the connection failed, for `since 14:02`. */
  stateSince: z.number().int(),
  /** The webhook URL in webhooks mode. */
  webhookUrl: z.string().nullable(),
  /** The app's values are saved (step 2 of a pending connection). Never the values. */
  appSaved: z.boolean(),
  /** The manifest link, while the connection is pending. */
  manifestUrl: z.string().nullable(),
  lastEvent: z.object({ at: z.number().int(), type: z.string().nullable(), ticketKey: z.string().nullable() }).nullable(),
  lastPoll: z.object({ at: z.number().int(), changed: z.number().int() }).nullable(),
  accessTokenExpiresAt: z.number().int().nullable(),
  /** Webhooks went quiet while polling still finds changes: since when. */
  silentSince: z.number().int().nullable(),
  startedAt: z.number().int(),
  startedByName: z.string().nullable(),
});

export const linearStatusSchema = z.discriminatedUnion("state", [noneSchema, connectionSchema]);
export type LinearStatusView = z.infer<typeof linearStatusSchema>;

/** The mode an address would give, from the kit's pre-check: webhooks need an address Linear can reach. */
const modeOf = (deps: ApiDeps) => {
  const check = deps.linear.checkPublicUrl(deps.settings.corePublicUrl);
  return check.public
    ? { mode: "webhooks" as const, reason: null, corePublicUrl: deps.settings.corePublicUrl }
    : { mode: "polling" as const, reason: check.reason, corePublicUrl: null };
};

/**
 * "Webhooks silent since …": the connection takes webhooks, yet tickets changed since the last
 * delivery by more than two poll intervals, so polling is what finds them. Ticket 14's reading;
 * the cache's own updates are the evidence, and the connection is never switched off by it.
 */
const silentSinceOf = async (
  deps: ApiDeps,
  row: { readonly id: string; readonly organizationId: string; readonly webhookMode: "webhooks" | "polling"; readonly state: string; readonly activatedAt: Date | null },
  lastEventAt: number | null,
): Promise<number | null> => {
  if (row.webhookMode !== "webhooks" || row.state !== "active") return null;
  const since = lastEventAt ?? row.activatedAt?.getTime() ?? null;
  if (since === null) return null;
  const threshold = new Date(since + 2 * deps.settings.trackerPollSeconds * 1000);
  const changed = await deps.db.ticket.findFirst({ where: { connectionId: row.id, organizationId: row.organizationId, updatedAt: { gt: threshold } }, select: { id: true } });
  return changed === null ? null : since;
};

const statusOf = async (deps: ApiDeps, organizationId: OrganizationId): Promise<LinearStatusView> => {
  const { db, settings, linear } = deps;
  const mode = modeOf(deps);
  const common = {
    scopes: [...linear.scopes],
    webhookEvents: [...linear.webhookEvents],
    pollSeconds: settings.trackerPollSeconds,
    reconcileMinutes: settings.reconcileMinutes,
  };
  const row = await db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } });
  if (row === null) {
    const revoked = await db.connection.findFirst({ where: { organizationId, kind: "linear", state: "revoked" }, orderBy: { updatedAt: "desc" }, select: { externalWorkspaceKey: true, updatedAt: true } });
    return {
      state: "none",
      mode: mode.mode,
      modeReason: mode.reason,
      ...common,
      lastRevoked: revoked === null ? null : { workspaceKey: revoked.externalWorkspaceKey, at: revoked.updatedAt.getTime() },
    };
  }

  const connectionId = connectionIdSchema.parse(row.id);
  const [delivery, polled, starter] = await Promise.all([
    db.webhookDelivery.findFirst({ where: { organizationId, connectionId: row.id }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, event: true, ticketKey: true } }),
    db.board.aggregate({ where: { organizationId, connectionId: row.id }, _max: { lastPolledAt: true } }),
    row.createdByMemberId === null
      ? Promise.resolve(null)
      : db.member.findFirst({ where: { id: row.createdByMemberId, organizationId }, select: { user: { select: { name: true } } } }),
  ]);
  // The newest of the delivery and the connection's own `lastEventAt`: with only the latter, the time alone.
  const deliveredAt = delivery?.receivedAt.getTime() ?? null;
  const lastEventAt = Math.max(deliveredAt ?? 0, row.lastEventAt?.getTime() ?? 0);
  const lastEvent =
    lastEventAt === 0 ? null : { at: lastEventAt, type: lastEventAt === deliveredAt ? (delivery?.event ?? null) : null, ticketKey: lastEventAt === deliveredAt ? (delivery?.ticketKey ?? null) : null };
  const lastPolledAt = polled._max.lastPolledAt?.getTime() ?? null;
  const changed =
    lastPolledAt === null
      ? 0
      : await db.ticket.count({ where: { organizationId, connectionId: row.id, updatedAt: { gte: new Date(lastPolledAt - settings.trackerPollSeconds * 1000) } } });

  const webhookUrl = row.webhookMode === "webhooks" && mode.corePublicUrl !== null ? linearWebhookUrl(mode.corePublicUrl, connectionId) : null;
  const state = row.state === "revoked" ? "failed" : row.state;
  return {
    state,
    connectionId,
    mode: row.webhookMode,
    // Polling says why: the address as it stands now. A connection that polls by choice has none.
    modeReason: row.webhookMode === "polling" ? mode.reason : null,
    ...common,
    credentialKind: row.credentialKind ?? "app_oauth",
    workspaceKey: row.externalWorkspaceKey,
    workspaceName: row.externalWorkspaceName,
    appUserName: row.appUserName,
    activatedAt: row.activatedAt?.getTime() ?? null,
    stateSince: (state === "pending" ? row.createdAt : state === "active" ? (row.activatedAt ?? row.updatedAt) : row.updatedAt).getTime(),
    webhookUrl,
    appSaved: row.clientSecretSecretRef !== null && (row.webhookMode === "polling" || row.webhookSecretSecretRef !== null),
    manifestUrl:
      state === "pending"
        ? linear.manifestUrl({ name: linearAppName(settings.publicUrl), callbackUrl: linearCallbackUrl(settings.publicUrl), webhookUrl })
        : null,
    lastEvent,
    lastPoll: lastPolledAt === null ? null : { at: lastPolledAt, changed },
    accessTokenExpiresAt: row.accessTokenExpiresAt?.getTime() ?? null,
    silentSince: await silentSinceOf(deps, row, lastEvent?.at ?? null),
    startedAt: row.createdAt.getTime(),
    startedByName: starter?.user.name ?? null,
  };
};

const startedSchema = z.object({
  connectionId: connectionIdSchema,
  manifestUrl: z.string(),
  callbackUrl: z.string(),
  webhookUrl: z.string().nullable(),
  mode: modeSchema,
  modeReason: z.string().nullable(),
});

const authorizeUrlSchema = z.object({ authorizeUrl: z.string() });

export const linearRouter = router({
  /**
   * Where the connection stands: one union. With none (or a revoked one) it answers `none` with the
   * mode the address would give, so the page shows the mode before `start`.
   */
  status: adminProcedure.output(linearStatusSchema).query(({ ctx }) => statusOf(ctx.deps, ctx.scope.organizationId)),

  /**
   * "Connect Linear": makes the connection `pending` (or picks up the pending one), decides the mode
   * and answers the manifest link with the callback and webhook URLs in it. A second connection
   * while one is active is refused.
   */
  start: adminProcedure.output(startedSchema).mutation(async ({ ctx }) => {
    const { db, ports, settings, linear } = ctx.deps;
    const mode = modeOf(ctx.deps);
    const result = await db.$transaction((tx) =>
      startLinearConnection({ tx, scope: ctx.scope, corePublicUrl: mode.corePublicUrl, corePublicUrlProblem: mode.reason, publicUrl: settings.publicUrl, linear, ...ports }),
    );
    const started = unwrap(result, { forbidden: "FORBIDDEN", "already-connected": "CONFLICT" });
    return {
      connectionId: started.connectionId,
      manifestUrl: started.manifestUrl,
      callbackUrl: started.callbackUrl,
      webhookUrl: started.webhookUrl,
      mode: started.mode,
      modeReason: started.modeReason,
    };
  }),

  /**
   * Keeps the app's client ID, client secret and (in webhooks mode) webhook signing secret, through
   * the secret store, and answers the authorize URL for the next step. Nothing is returned back.
   */
  saveApp: adminProcedure
    .input(connectLinearInputSchema)
    .output(authorizeUrlSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings, linear } = ctx.deps;
      const mode = modeOf(ctx.deps);
      const result = await db.$transaction((tx) =>
        connectLinear(
          { tx, scope: ctx.scope, corePublicUrl: mode.corePublicUrl, publicUrl: settings.publicUrl, linear, authSessionId: ctx.user.sessionId, ...ports },
          input,
        ),
      );
      const saved = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "not-pending": "CONFLICT", "webhook-secret-required": "BAD_REQUEST" });
      return { authorizeUrl: saved.authorizeUrl };
    }),

  /**
   * A fresh authorize URL: an `OAuthState` bound to this admin's session (10 minutes), with Linear's
   * consent page behind it (`actor=app`, S256 PKCE). For step 3, and to authorize a failed
   * connection again.
   */
  authorizeUrl: adminProcedure
    .input(authorizeUrlInputSchema)
    .output(authorizeUrlSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings, linear } = ctx.deps;
      const mode = modeOf(ctx.deps);
      const result = await db.$transaction((tx) =>
        createLinearAuthorizeUrl({ tx, scope: ctx.scope, corePublicUrl: mode.corePublicUrl, publicUrl: settings.publicUrl, linear, authSessionId: ctx.user.sessionId, ...ports }, input),
      );
      const made = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "not-ready": "PRECONDITION_FAILED" });
      return { authorizeUrl: made.authorizeUrl };
    }),

  /**
   * Linear's callback, called by the panel's route with the `code` and `state` Linear sent back. The
   * state must be this admin's own, from this session, unexpired and unused; it is used up. The
   * token must be the app's own user. On success the connection is `active`.
   */
  complete: adminProcedure
    .input(authorizeLinearInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, workspaceName: z.string(), appUserName: z.string(), mode: modeSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings, linear } = ctx.deps;
      const result = await authorizeLinear({ db, scope: ctx.scope, authSessionId: ctx.user.sessionId, publicUrl: settings.publicUrl, linear, ...ports }, input);
      const connected = unwrap(result, {
        "bad-state": "BAD_REQUEST",
        "exchange-failed": "BAD_GATEWAY",
        "not-app-user": "BAD_REQUEST",
        forbidden: "FORBIDDEN",
        "missing-scopes": "PRECONDITION_FAILED",
      });
      return { connectionId: connected.connectionId, workspaceName: connected.workspaceName, appUserName: connected.appUserName, mode: connected.mode };
    }),

  /**
   * Revokes the token at Linear, deletes the secrets and ends the connection (`revoked`). Its boards
   * and tickets stay, read-only.
   */
  disconnect: adminProcedure
    .input(disconnectLinearInputSchema)
    .output(z.object({ connectionId: connectionIdSchema, revokedAtLinear: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, linear } = ctx.deps;
      const result = await disconnectLinear({ db, scope: ctx.scope, linear, ...ports }, input);
      const done = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
      return { connectionId: done.connectionId, revokedAtLinear: done.revokedAtLinear };
    }),
});
