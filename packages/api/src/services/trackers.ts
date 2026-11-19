import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretStoreAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { ConnectionTracker } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

// The organization's tracker as a router uses it (F-005, F-007): the connection row, its token read
// from the secret store for the one call that needs it, and the adapter built with it. The token
// lives in a local variable of the adapter's constructor call and goes nowhere else: no router
// returns it and no log carries it.

/** How a Linear adapter authenticates: a personal API key (development) or an OAuth access token. */
export type LinearTrackerAuth =
  | { readonly kind: "api-key"; readonly token: string }
  | { readonly kind: "oauth"; readonly token: string };

export type TrackerLookup =
  | { readonly ok: true; readonly tracker: ConnectionTracker }
  | { readonly ok: false; readonly error: "no-connection" | "not-usable"; readonly message: string };

export type TrackerDirectory = {
  /**
   * The tracker adapter for one of the organization's connections, built with its stored token. A
   * connection that is not `active`, has no token, or belongs to another organization is refused.
   */
  readonly forConnection: (organizationId: OrganizationId, connectionId: ConnectionId) => Promise<TrackerLookup>;
  /** The organization's Linear connection that isn't revoked, if any. */
  readonly linearConnectionOf: (organizationId: OrganizationId) => Promise<ConnectionId | null>;
};

export type TrackerDirectoryInput = {
  readonly db: Db;
  readonly secretStore: SecretStoreAdapter;
  /** Builds a Linear adapter. The panel's composition root passes `new LinearAdapter(...)`. */
  readonly makeLinear: (auth: LinearTrackerAuth) => TrackerAdapter;
};

export const createTrackerDirectory = (input: TrackerDirectoryInput): TrackerDirectory => ({
  linearConnectionOf: async (organizationId) => {
    const row = await input.db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } }, select: { id: true } });
    return row === null ? null : connectionIdSchema.parse(row.id);
  },
  forConnection: async (organizationId, connectionId) => {
    const row = await input.db.connection.findFirst({ where: { id: connectionId, organizationId, kind: "linear" } });
    if (row === null) {
      return { ok: false, error: "no-connection", message: "This organization isn't connected to Linear" };
    }
    if (row.state !== "active") {
      return { ok: false, error: "not-usable", message: "The Linear connection isn't active" };
    }
    const ref = secretRefSchema.safeParse(row.accessTokenSecretRef);
    if (!ref.success) {
      return { ok: false, error: "not-usable", message: "The Linear connection has no token" };
    }
    const token = await input.secretStore.get(organizationId, ref.data);
    if (!token.ok) {
      return { ok: false, error: "not-usable", message: "The Linear connection's token could not be read from the secret store" };
    }
    const auth: LinearTrackerAuth = row.credentialKind === "api_key" ? { kind: "api-key", token: token.value } : { kind: "oauth", token: token.value };
    return {
      ok: true,
      tracker: { connectionId: connectionIdSchema.parse(row.id), tracker: input.makeLinear(auth), ownUserId: row.appUserId },
    };
  },
});
