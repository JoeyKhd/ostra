import { secretRefSchema } from "@ostra/adapter-sdk";
import type { AdapterContext, Logger, SecretStoreAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import { JIRA_CAPABILITIES, JiraAdapter } from "@ostra/adapter-jira";
import { LINEAR_CAPABILITIES, LinearAdapter } from "@ostra/adapter-linear";
import type { Db, DbEnum } from "@ostra/db";
import { defaultConnectionName, isTrackerKind, postgresIdempotencyStore, postgresRateBudgetStore } from "@ostra/domain";
import type { Clock, ConnectionTracker, TrackerKindCapabilities } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

// A connection's tracker (tickets 14 and 15): the tracker adapter built with the connection's
// token from the secret store, and with the organization's Postgres stores for its plumbing, so
// every call goes through the connection's rate budget and its idempotency keys (F-046). The token
// never leaves this module or the adapter: never a log line, never an error message.

export type TrackerLookup =
  /** The connection's tracker, with its kind and name (milestone 11). */
  | { readonly ok: true; readonly value: ConnectionTracker }
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

type TrackerBuildBase = {
  readonly credentialKind: DbEnum.ConnectionCredential | null;
  /** The access token or API key. Never logged. */
  readonly token: string;
  readonly context: AdapterContext;
};

/** A Jira connection's site and service account (milestone 11): what its adapter signs in as, beside the token. */
export type JiraBuildSite = {
  /** The site's cloud ID (`appId`, `externalWorkspaceId`): calls go through Atlassian's gateway with it. */
  readonly cloudId: string;
  /** The site's host, `globex.atlassian.net` (`externalWorkspaceKey`): its browse links name it. */
  readonly host: string;
  /** The service account's email, the user half of Basic auth (`accountEmail`). Not a secret. */
  readonly email: string;
};

/** What a tracker is built from: the connection's row and its token. */
export type TrackerBuildInput =
  | (TrackerBuildBase & { readonly kind: Exclude<DbEnum.ConnectionKind, "jira"> })
  /** Jira's (ticket 07): its site, `null` when the row hasn't one yet (a connection that never found its site). */
  | (TrackerBuildBase & { readonly kind: "jira"; readonly site: JiraBuildSite | null });

/** Where core reaches each tracker: its vendor's own API unless a setting points it at a fake. */
export type TrackerEndpoints = {
  /** Linear's GraphQL endpoint; the default is Linear's own. */
  readonly linearApiUrl?: string;
  /** OSTRA_JIRA_API_URL: Atlassian's gateway (`https://api.atlassian.com`) unless set to a fake Jira. */
  readonly jiraApiUrl?: string | null;
};

/** What each kind's shipped adapter declares, for the domain's choices that build no adapter (a PR's magic word). */
export const trackerKindCapabilities: TrackerKindCapabilities = { linear: LINEAR_CAPABILITIES, jira: JIRA_CAPABILITIES };

/** Linear's own file host: where its uploads live, and the only host `downloadFile` sends the token to. */
const LINEAR_FILE_HOST = "https://uploads.linear.app";

/**
 * Builds a connection's adapter from its row and token: Linear's, or Jira's through the gateway
 * with the service account's scoped token (ADR 0047), the connection's own credential in each.
 * Exported so a test can point each Jira site at its own fake.
 */
export const buildTracker =
  (endpoints: TrackerEndpoints) =>
  (input: TrackerBuildInput): TrackerAdapter | null => {
    switch (input.kind) {
      case "linear":
        return new LinearAdapter(
          {
            auth: input.credentialKind === "api_key" ? { kind: "api-key", token: input.token } : { kind: "oauth", token: input.token },
            // Another API (the dev stack's fake Linear) serves its own files too: its origin is a
            // file host the token may go to, as it already goes to the API itself (milestone 9).
            ...(endpoints.linearApiUrl === undefined ? {} : { apiUrl: endpoints.linearApiUrl, fileOrigins: [LINEAR_FILE_HOST, new URL(endpoints.linearApiUrl).origin] }),
          },
          input.context,
        );
      case "jira":
        return input.site === null
          ? null
          : new JiraAdapter(
              {
                siteUrl: `https://${input.site.host}`,
                auth: { email: input.site.email, token: input.token },
                cloudId: input.site.cloudId,
                ...(endpoints.jiraApiUrl === undefined || endpoints.jiraApiUrl === null ? {} : { gatewayUrl: endpoints.jiraApiUrl }),
              },
              input.context,
            );
      case "github":
        return null;
      default:
        return input satisfies never;
    }
  };

/**
 * The webhook inbox's verifiers, one per tracker kind: verifying is pure, so each needs no token or
 * site, only the connection's secret, which the inbox passes with each delivery.
 */
export const verifyOnlyTrackers = (context?: AdapterContext): { readonly linear: TrackerAdapter; readonly jira: TrackerAdapter } => ({
  linear: new LinearAdapter({ auth: { kind: "oauth", token: "verify-only" } }, context),
  jira: new JiraAdapter({ siteUrl: "https://verify-only.atlassian.net", auth: { email: "verify-only", token: "verify-only" } }, context),
});

export type ConnectionTrackersDeps = {
  readonly db: Db;
  readonly secretStore: SecretStoreAdapter;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Builds the adapter; the default is `buildTracker` with the endpoints below. Tests pass the fakes. */
  readonly build?: (input: TrackerBuildInput) => TrackerAdapter | null;
} & TrackerEndpoints;

/** How long a built adapter is reused before its token is read again. */
const CACHE_MS = 60_000;

export const createConnectionTrackers = (deps: ConnectionTrackersDeps): ConnectionTrackers => {
  const cache = new Map<ConnectionId, { readonly value: TrackerLookup & { readonly ok: true }; readonly secretRef: string; readonly until: number }>();
  const build = deps.build ?? buildTracker({ ...(deps.linearApiUrl === undefined ? {} : { linearApiUrl: deps.linearApiUrl }), jiraApiUrl: deps.jiraApiUrl ?? null });

  return {
    forget: (connectionId) => {
      cache.delete(connectionId);
    },
    forConnection: async (organizationId, connectionId) => {
      const row = await deps.db.connection.findFirst({
        where: { id: connectionId, organizationId },
        select: {
          id: true,
          kind: true,
          name: true,
          externalWorkspaceId: true,
          externalWorkspaceKey: true,
          externalWorkspaceName: true,
          accountEmail: true,
          state: true,
          credentialKind: true,
          accessTokenSecretRef: true,
          appUserId: true,
        },
      });
      if (row === null) {
        return { ok: false, reason: "not-found", message: "no such connection" };
      }
      const kind = row.kind;
      if (!isTrackerKind(kind)) {
        return { ok: false, reason: "unsupported", message: `a ${kind} connection has no tracker` };
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
      const base = { credentialKind: row.credentialKind, token: token.value, context };
      const tracker = build(
        kind === "jira"
          ? {
              ...base,
              kind,
              site:
                row.externalWorkspaceId === null || row.externalWorkspaceKey === null || row.accountEmail === null
                  ? null
                  : { cloudId: row.externalWorkspaceId, host: row.externalWorkspaceKey, email: row.accountEmail },
            }
          : { ...base, kind },
      );
      if (tracker === null) {
        return { ok: false, reason: "unsupported", message: `a ${row.kind} connection has no tracker` };
      }
      const value = {
        ok: true,
        value: { connectionId: connectionIdSchema.parse(row.id), kind, name: row.name ?? defaultConnectionName(kind, row.externalWorkspaceName), tracker, ownUserId: row.appUserId },
      } as const;
      cache.set(connectionId, { value, secretRef: row.accessTokenSecretRef, until: now + CACHE_MS });
      return value;
    },
  };
};
