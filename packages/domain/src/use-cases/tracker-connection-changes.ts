import type { Db } from "@ostra/db";
import type { ConnectionId } from "@ostra/protocol";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { disconnectJira, startJiraConnection } from "./jira-connection.ts";
import { disconnectLinear, startLinearConnection } from "./linear-connection.ts";
import type { LinearAddressProblem, LinearAppKit, StartLinearConnectionResult } from "./linear-connection.ts";
import { isTrackerKind, trackerAdminOnly } from "./tracker-connections.ts";
import type { TrackerKind } from "./tracker-connections.ts";

// Milestone 11, ticket 06 (F-152, ADR 0071; spec section 5.4): the Trackers page's own changes,
// which start or end a connection of either kind. Each kind's steps are its own file's
// (`linear-connection.ts`, `jira-connection.ts`); a rename, a failure and the end of a disconnect
// are every kind's (`tracker-connections.ts`). Admin only, audited, by the connection's ID and the
// organization: never "the organization's" tracker of a kind.

export type TrackerConnectionChangeDeps = Pick<Ports, "audit" | "notices" | "clock"> & {
  readonly db: Db;
  readonly scope: MemberScope;
  readonly adapters: Pick<Ports["adapters"], "secretStore">;
  /** Core's public address, or `null` when it fails the pre-check: a new connection polls. */
  readonly corePublicUrl: string | null;
  readonly corePublicUrlProblem?: LinearAddressProblem | null;
  /** The panel's address: Linear's OAuth callback. */
  readonly publicUrl: string;
  /** Linear's calls: the manifest link, and the revocation a Linear disconnect makes first. */
  readonly linear: LinearAppKit;
};

export type StartTrackerConnectionInput = { readonly kind: TrackerKind; readonly name?: string };

export type StartTrackerConnectionResult =
  | ({ readonly kind: "linear" } & Extract<StartLinearConnectionResult, { readonly ok: true }>)
  | {
      readonly ok: true;
      readonly kind: "jira";
      readonly connectionId: ConnectionId;
      readonly name: string;
      readonly mode: "webhooks" | "polling";
      readonly modeReason: LinearAddressProblem | null;
    }
  | Exclude<StartLinearConnectionResult, { readonly ok: true }>;

/**
 * `trackers.create({ kind, name })` (F-152/c1): a new named `pending` connection of the kind. Linear's
 * is `startLinearConnection` (its manifest link); Jira's waits for its three steps. Audited
 * `tracker.connection-created`.
 */
export const startTrackerConnection = async (deps: TrackerConnectionChangeDeps, input: StartTrackerConnectionInput): Promise<StartTrackerConnectionResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const name = input.name === undefined ? {} : { name: input.name };
  switch (input.kind) {
    case "linear": {
      const started = await deps.db.$transaction((tx) => startLinearConnection({ ...deps, tx }, name));
      return started.ok ? { ...started, kind: "linear" } : started;
    }
    case "jira": {
      const started = await startJiraConnection(deps, name);
      return started.ok ? { ...started, kind: "jira" } : started;
    }
    default:
      return input.kind satisfies never;
  }
};

export type DisconnectTrackerResult = UseCaseResult<
  {
    readonly connectionId: ConnectionId;
    readonly kind: TrackerKind;
    /** Whether the tracker took the token back itself: Linear's, when it answered; never Jira's scoped token. */
    readonly revokedAtTracker: boolean;
  },
  "forbidden" | "no-connection"
>;

/**
 * `trackers.disconnect({ id })` (F-152/c5; ADR 0071, choice 12), for either kind: Linear's through
 * `disconnectLinear`, which revokes its tokens at Linear first; Jira's through `disconnectJira`.
 * Every secret of the connection is deleted, its open agent sessions end, and it's `revoked` with
 * its `appId` given back. Its boards stay attached and pause by derivation; the same site connected
 * again resumes them. Audited `tracker.disconnected`.
 */
export const disconnectTracker = async (deps: TrackerConnectionChangeDeps, input: { readonly connectionId: ConnectionId }): Promise<DisconnectTrackerResult> => {
  const denied = trackerAdminOnly(deps.scope);
  if (denied !== null) return denied;
  const row = await deps.db.connection.findFirst({
    where: { id: input.connectionId, organizationId: deps.scope.organizationId, state: { not: "revoked" } },
    select: { kind: true },
  });
  if (row === null || !isTrackerKind(row.kind)) {
    return { ok: false, error: "no-connection", message: "No such tracker connection" };
  }
  switch (row.kind) {
    case "linear": {
      const done = await disconnectLinear(deps, input);
      if (!done.ok) {
        return done.error === "not-found" ? { ok: false, error: "no-connection", message: done.message } : { ok: false, error: done.error, message: done.message };
      }
      return { ok: true, connectionId: input.connectionId, kind: "linear", revokedAtTracker: done.revokedAtLinear };
    }
    case "jira": {
      const done = await disconnectJira(deps, input);
      return done.ok ? { ok: true, connectionId: input.connectionId, kind: "jira", revokedAtTracker: false } : done;
    }
    default:
      return row.kind satisfies never;
  }
};
