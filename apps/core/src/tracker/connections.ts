import { secretRefSchema } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger, SecretStoreAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import { LinearAdapter } from "@ostra/adapter-linear";
import type { Db, DbEnum } from "@ostra/db";
import { postgresIdempotencyStore, postgresRateBudgetStore } from "@ostra/domain";
import type { Clock, ConnectionTracker } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

// A connection's tracker (tickets 14 and 15): the tracker adapter built with the connection's
// token from the secret store, and with the organization's Postgres stores for its plumbing, so
// every call goes through the connection's rate budget and its idempotency keys (F-046). The token
// never leaves this module or the adapter: never a log line, never an error message.

export type TrackerLookup =
  | { readonly ok: true; readonly value: ConnectionTracker & { readonly kind: DbEnum.ConnectionKind } }
  | {
      readonly ok: false;
      /** `not-active`: pending, failed or revoked; writes and polling stop for it, visibly. */
      readonly reason: "not-found" | "not-active" | "no-token" | "unsupported";
      readonly message: string;
    };

export type ConnectionTrackers = {
  readonly forConnection: (organizationId: OrganizationId, connectionId: ConnectionId) => Promise<TrackerLookup>;
  /** Drops a cached adapter, after a token refresh or a revoke. */
  readonly forget: (connectionId: ConnectionId) => void;
};

/** What a tracker is built from: the connection's row and its token. */
export type TrackerBuildInput = {
  readonly kind: DbEnum.ConnectionKind;
  readonly credentialKind: DbEnum.ConnectionCredential | null;
  /** The access token or API key. Never logged. */
  readonly token: string;
  readonly context: AdapterContext;
};

export type ConnectionTrackersDeps = {
  readonly db: Db;
  readonly secretStore: SecretStoreAdapter;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Builds the adapter; the default builds Linear's. Tests pass the fakes. */
  readonly build?: (input: TrackerBuildInput) => TrackerAdapter | null;
  /** Linear's GraphQL endpoint; the default is Linear's own. */
  readonly linearApiUrl?: string;
};

/** Linear's own file host: where its uploads live, and the only host `downloadFile` sends the token to. */
const LINEAR_FILE_HOST = "https://uploads.linear.app";

/** How long a built adapter is reused before its token is read again. */
const CACHE_MS = 60_000;

export const createConnectionTrackers = (deps: ConnectionTrackersDeps): ConnectionTrackers => {
  const cache = new Map<ConnectionId, { readonly value: TrackerLookup & { readonly ok: true }; readonly secretRef: string; readonly until: number }>();
  const build =
    deps.build ??
    ((input: TrackerBuildInput): TrackerAdapter | null => {
      switch (input.kind) {
        case "linear":
          return new LinearAdapter(
            {
              auth: input.credentialKind === "api_key" ? { kind: "api-key", token: input.token } : { kind: "oauth", token: input.token },
              // Another API (the dev stack's fake Linear) serves its own files too: its origin is a
              // file host the token may go to, as it already goes to the API itself (milestone 9).
              ...(deps.linearApiUrl === undefined ? {} : { apiUrl: deps.linearApiUrl, fileOrigins: [LINEAR_FILE_HOST, new URL(deps.linearApiUrl).origin] }),
            },
            input.context,
          );
        case "github":
          return null;
        default:
          return input.kind satisfies never;
      }
    });

  return {
    forget: (connectionId) => {
      cache.delete(connectionId);
    },
    forConnection: async (organizationId, connectionId) => {
      const row = await deps.db.connection.findFirst({
        where: { id: connectionId, organizationId },
        select: { id: true, kind: true, state: true, credentialKind: true, accessTokenSecretRef: true, appUserId: true },
      });
      if (row === null) {
        return { ok: false, reason: "not-found", message: "no such connection" };
      }
      if (row.state !== "active") {
        cache.delete(connectionId);
        return { ok: false, reason: "not-active", message: `the connection is ${row.state}` };
      }
      if (row.accessTokenSecretRef === null) {
        return { ok: false, reason: "no-token", message: "the connection has no token" };
      }
      const now = deps.clock.now();
      const cached = cache.get(connectionId);
      if (cached?.secretRef === row.accessTokenSecretRef && cached.until > now) {
        return cached.value;
      }
      const ref = secretRefSchema.safeParse(row.accessTokenSecretRef);
      const token = ref.success ? await deps.secretStore.get(organizationId, ref.data) : null;
      if (token?.ok !== true) {
        deps.logger.warn("tracker.token-unreadable", { organizationId, connectionId });
        return { ok: false, reason: "no-token", message: "the connection's token couldn't be read" };
      }
      const context: AdapterContext = {
        logger: deps.logger.child({ organizationId, connectionId }),
        clock: deps.clock,
        rateBudgets: postgresRateBudgetStore(deps.db, organizationId),
        idempotency: postgresIdempotencyStore(deps.db, organizationId),
      };
      const tracker = build({ kind: row.kind, credentialKind: row.credentialKind, token: token.value, context });
      if (tracker === null) {
        return { ok: false, reason: "unsupported", message: `a ${row.kind} connection has no tracker` };
      }
      const value = {
        ok: true,
        value: { connectionId: connectionIdSchema.parse(row.id), tracker, ownUserId: row.appUserId, kind: row.kind },
      } as const;
      cache.set(connectionId, { value, secretRef: row.accessTokenSecretRef, until: now + CACHE_MS });
      return value;
    },
  };
};
