import { JIRA_CAPABILITIES } from "@ostra/adapter-jira";
import { LINEAR_CAPABILITIES } from "@ostra/adapter-linear";
import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretStoreAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { defaultConnectionName, isTrackerKind, trackerConnectionOf, trackerConnectionsOf } from "@ostra/domain";
import type { ConnectionTracker, TrackerConnection, TrackerKindCapabilities } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

// The organization's tracker connections as the routers use them (F-005, F-007; milestone 11,
// F-152 and ADR 0071): every connection of any kind, looked up by its ID and the organization,
// never "the organization's Linear". A connection's token is read from the secret store for the
// one call that needs it, and the adapter is built with it: the token lives in a local of the
// adapter's constructor call and goes nowhere else. No router returns it and no log carries it.

/** How a Linear adapter authenticates: a personal API key (development) or an OAuth access token. */
export type LinearTrackerAuth =
  | { readonly kind: "api-key"; readonly token: string }
  | { readonly kind: "oauth"; readonly token: string };

/** How a Jira adapter reaches its site: through Atlassian's gateway with the site's cloud ID, as the service account. */
export type JiraTrackerAuth = {
  /** The site's host, `globex.atlassian.net`: browse links and attachment URLs name it. */
  readonly host: string;
  readonly cloudId: string;
  /** The service account's email: the user half of the token's Basic auth. */
  readonly email: string;
  /** Its scoped API token. */
  readonly token: string;
};

/** What each kind's adapter declares, for the panel's rows: the adapters' own declarations, not a list of the panel's. */
export const trackerKindCapabilities: TrackerKindCapabilities = { linear: LINEAR_CAPABILITIES, jira: JIRA_CAPABILITIES };

export type TrackerLookup =
  | { readonly ok: true; readonly tracker: ConnectionTracker }
  | { readonly ok: false; readonly error: "no-connection" | "not-usable"; readonly message: string };

export type TrackerDirectory = {
  /**
   * The tracker adapter for one of the organization's connections, of any kind, built with its
   * stored token. A connection that is not `active`, has no token, or belongs to another
   * organization is refused.
   */
  readonly forConnection: (organizationId: OrganizationId, connectionId: ConnectionId) => Promise<TrackerLookup>;
  /** Every tracker connection of the organization that isn't revoked, of any kind, oldest first. */
  readonly connectionsOf: (organizationId: OrganizationId) => Promise<readonly TrackerConnection[]>;
  /** One of them by its ID, or `null`: another organization's, a revoked one, or none. */
  readonly connectionOf: (organizationId: OrganizationId, connectionId: ConnectionId) => Promise<TrackerConnection | null>;
  /** What each kind's adapter declares. */
  readonly capabilities: TrackerKindCapabilities;
};

export type TrackerDirectoryInput = {
  readonly db: Db;
  readonly secretStore: SecretStoreAdapter;
  /** Builds a Linear adapter. The panel's composition root passes `new LinearAdapter(...)`. */
  readonly makeLinear: (auth: LinearTrackerAuth) => TrackerAdapter;
  /** Builds a Jira adapter. The panel's composition root passes `new JiraAdapter(...)` on `OSTRA_JIRA_API_URL`. */
  readonly makeJira: (auth: JiraTrackerAuth) => TrackerAdapter;
};

export const createTrackerDirectory = (input: TrackerDirectoryInput): TrackerDirectory => ({
  capabilities: trackerKindCapabilities,
  connectionsOf: (organizationId) => trackerConnectionsOf(input.db, organizationId, trackerKindCapabilities),
  connectionOf: (organizationId, connectionId) => trackerConnectionOf(input.db, organizationId, connectionId, trackerKindCapabilities),
  forConnection: async (organizationId, connectionId) => {
    const row = await input.db.connection.findFirst({ where: { id: connectionId, organizationId } });
    if (row === null || !isTrackerKind(row.kind)) {
      return { ok: false, error: "no-connection", message: "No such tracker connection" };
    }
    const kind = row.kind;
    const name = row.name ?? defaultConnectionName(kind, row.externalWorkspaceName);
    if (row.state !== "active") {
      return { ok: false, error: "not-usable", message: `${name} isn't connected: open it under Trackers` };
    }
    const ref = secretRefSchema.safeParse(row.accessTokenSecretRef);
    if (!ref.success) {
      return { ok: false, error: "not-usable", message: `${name} has no token: open it under Trackers` };
    }
    const token = await input.secretStore.get(organizationId, ref.data);
    if (!token.ok) {
      return { ok: false, error: "not-usable", message: `${name}'s token could not be read from the secret store` };
    }
    let tracker: TrackerAdapter;
    switch (kind) {
      case "linear":
        tracker = input.makeLinear(row.credentialKind === "api_key" ? { kind: "api-key", token: token.value } : { kind: "oauth", token: token.value });
        break;
      case "jira":
        if (row.externalWorkspaceKey === null || row.externalWorkspaceId === null || row.accountEmail === null) {
          return { ok: false, error: "not-usable", message: `${name} has no site or service account: open it under Trackers` };
        }
        tracker = input.makeJira({ host: row.externalWorkspaceKey, cloudId: row.externalWorkspaceId, email: row.accountEmail, token: token.value });
        break;
      default:
        return kind satisfies never;
    }
    return { ok: true, tracker: { connectionId: connectionIdSchema.parse(row.id), kind, name, tracker, ownUserId: row.appUserId } };
  },
});
