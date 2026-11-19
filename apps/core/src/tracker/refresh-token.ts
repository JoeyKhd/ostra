import { refreshToken as refreshLinearToken } from "@ostra/adapter-linear";
import type { LinearOAuthResult, LinearTokenSet } from "@ostra/adapter-linear";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Logger, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { LINEAR_REFRESH_MARGIN_MS } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import type { ConnectionTrackers } from "./connections.ts";

// `linear.refresh-token` (F-005, ticket 14): a delayed job an hour before a Linear connection's
// access token expires. It refreshes through ticket 08's `refreshToken`, stores the rotated pair
// through the secret store, then points the connection at them, and drops the old ones. A refresh
// Linear refuses marks the connection `failed` with the reason: its polling and writes stop,
// visibly, until an admin authorizes again. The tokens never reach a log line or a column.
//
// The job can't send its own next run while it runs (its queue holds one job per key), so core's
// tick (`ensureTokenRefreshes`) sends the next one for every active app connection lacking one.

export type RefreshTokens = (input: { readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string }) => Promise<LinearOAuthResult<LinearTokenSet>>;

export type TokenRefreshDeps = {
  readonly db: Db;
  readonly jobs: Pick<Jobs, "sendInTx" | "find">;
  readonly secretStore: SecretStoreAdapter;
  readonly trackers: Pick<ConnectionTrackers, "forget">;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Linear's token endpoint; tests pass the fake Linear server's. */
  readonly refresh?: RefreshTokens;
  readonly tokenUrl?: string;
};

export type RefreshOutcome =
  | { readonly outcome: "refreshed"; readonly expiresAt: number }
  | { readonly outcome: "not-due"; readonly expiresAt: number }
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

const refOf = (value: string | null) => {
  const parsed = secretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** When the next refresh is due: an hour before the token expires, and never sooner than a minute from now. */
const dueIn = (expiresAt: number, now: number): number => Math.max(60_000, expiresAt - now - LINEAR_REFRESH_MARGIN_MS);

/** One refresh. Exported for tests; `linear.refresh-token` is its job. */
export const refreshConnectionToken = async (
  deps: TokenRefreshDeps,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId },
): Promise<RefreshOutcome> => {
  const { db } = deps;
  const connection = await db.connection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId, kind: "linear" },
    select: {
      id: true,
      state: true,
      appId: true,
      credentialKind: true,
      clientSecretSecretRef: true,
      accessTokenSecretRef: true,
      refreshTokenSecretRef: true,
      accessTokenExpiresAt: true,
    },
  });
  if (connection?.state !== "active") {
    return { outcome: "skipped", reason: connection === null ? "no such connection" : `the connection is ${connection.state}` };
  }
  const refreshRef = refOf(connection.refreshTokenSecretRef);
  const secretRef = refOf(connection.clientSecretSecretRef);
  if (connection.credentialKind !== "app_oauth" || refreshRef === null || secretRef === null) {
    return { outcome: "skipped", reason: "the connection has no refresh token" };
  }
  const now = deps.clock.now();
  const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? now;
  if (expiresAt - now > LINEAR_REFRESH_MARGIN_MS + 5 * 60_000) {
    // Sent early (a replayed timer): the token is fine for now.
    return { outcome: "not-due", expiresAt };
  }
  const [refresh, clientSecret] = await Promise.all([
    deps.secretStore.get(input.organizationId, refreshRef),
    deps.secretStore.get(input.organizationId, secretRef),
  ]);
  if (!refresh.ok || !clientSecret.ok) {
    throw new Error("the connection's secrets couldn't be read");
  }
  const call =
    deps.refresh ??
    ((args: Parameters<RefreshTokens>[0]) => refreshLinearToken({ ...args, ...(deps.tokenUrl === undefined ? {} : { tokenUrl: deps.tokenUrl }) }));
  const refreshed = await call({ clientId: connection.appId, clientSecret: clientSecret.value, refreshToken: refresh.value });
  if (!refreshed.ok) {
    const refused = refreshed.error.code === "invalid-grant" || refreshed.error.code === "invalid-client";
    if (!refused) {
      // Linear didn't answer: the job retries, within the 30 minutes Linear repeats the same pair.
      throw new Error(`refreshing Linear's token failed (${refreshed.error.code})`);
    }
    const reason = "Linear refused the refresh token: authorize the Linear app again";
    await db.$transaction(async (tx) => {
      await tx.connection.update({ where: { id: connection.id }, data: { state: "failed", failedReason: reason } });
      await deps.audit.recordInTx(tx, {
        organizationId: input.organizationId,
        projectId: null,
        actor: { kind: "system", id: null },
        action: "linear.token-refresh-failed",
        entity: "connection",
        entityId: input.connectionId,
        data: { code: refreshed.error.code },
      });
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "connection", entityId: input.connectionId });
    });
    deps.trackers.forget(input.connectionId);
    deps.logger.warn("linear.refresh-refused", { organizationId: input.organizationId, connectionId: input.connectionId, code: refreshed.error.code });
    return { outcome: "failed", reason };
  }
  // The rotated pair first; the connection points at it; then the old pair goes.
  const access = await deps.secretStore.put({ organizationId: input.organizationId, purpose: "linear-access-token" }, refreshed.value.accessToken);
  const rotated = await deps.secretStore.put({ organizationId: input.organizationId, purpose: "linear-refresh-token" }, refreshed.value.refreshToken);
  if (!access.ok || !rotated.ok) {
    throw new Error("the secret store refused the refreshed tokens");
  }
  await db.$transaction(async (tx) => {
    await tx.connection.update({
      where: { id: connection.id },
      data: { accessTokenSecretRef: access.value, refreshTokenSecretRef: rotated.value, accessTokenExpiresAt: new Date(refreshed.value.expiresAt) },
    });
    await deps.audit.recordInTx(tx, {
      organizationId: input.organizationId,
      projectId: null,
      actor: { kind: "system", id: null },
      action: "linear.token-refreshed",
      entity: "connection",
      entityId: input.connectionId,
      data: { expiresAt: refreshed.value.expiresAt },
    });
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "connection", entityId: input.connectionId });
  });
  deps.trackers.forget(input.connectionId);
  for (const old of [refOf(connection.accessTokenSecretRef), refreshRef]) {
    if (old !== null) {
      await deps.secretStore.delete(input.organizationId, old).catch(() => undefined);
    }
  }
  deps.logger.info("linear.token-refreshed", { organizationId: input.organizationId, connectionId: input.connectionId, expiresAt: refreshed.value.expiresAt });
  return { outcome: "refreshed", expiresAt: refreshed.value.expiresAt };
};

export const refreshTokenHandler =
  (deps: TokenRefreshDeps): JobHandler<"linear.refresh-token"> =>
  async (context) => {
    const outcome = await refreshConnectionToken(deps, context.payload);
    context.logger.info("linear.refresh-token", { outcome: outcome.outcome });
  };

/**
 * Every active Linear app connection has its next refresh queued: one delayed job, sent here when
 * none is waiting (after a refresh, or for a connection whose job was lost).
 */
export const ensureTokenRefreshes = async (deps: Pick<TokenRefreshDeps, "db" | "jobs" | "clock">): Promise<number> => {
  const connections = await deps.db.connection.findMany({
    where: { kind: "linear", state: "active", credentialKind: "app_oauth", refreshTokenSecretRef: { not: null }, accessTokenExpiresAt: { not: null } },
    select: { id: true, organizationId: true, accessTokenExpiresAt: true },
  });
  let sent = 0;
  const now = deps.clock.now();
  for (const connection of connections) {
    const payload = { organizationId: organizationIdSchema.parse(connection.organizationId), connectionId: connectionIdSchema.parse(connection.id) };
    const waiting = (await deps.jobs.find("linear.refresh-token", payload)).some((job) => job.state === "created" || job.state === "retry" || job.state === "active");
    if (waiting) continue;
    const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? now;
    const result = await deps.db.$transaction((tx) => deps.jobs.sendInTx(tx, "linear.refresh-token", payload, { startAfterMs: dueIn(expiresAt, now) }));
    if (result.kind === "enqueued") sent += 1;
  }
  return sent;
};
