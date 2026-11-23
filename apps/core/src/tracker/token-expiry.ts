import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { failConnection, TOKEN_EXPIRY_CRON, tokenExpiryState } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";

import type { ConnectionTrackers } from "./connections.ts";

// A tracker token's life (F-008/c8, milestone 11's ticket 07, spec section 4, "The token's date").
// - `tracker.token-expiry`, once a day: a Jira connection's scoped token has the date the admin gave
//   (Jira's API doesn't say it). From 14 days before it, the admins are warned once per connection
//   and date (`tracker.token-expiring`, audited by the system, and the connection's change told so
//   its row and page say "Token expires"); on the day, the connection fails (`token-expired`) and
//   its boards pause, until an admin replaces the token.
// - A token the tracker refuses (401) on a call ostra makes with it fails its connection at once
//   (`token-refused`), when the credential has no refresh of its own: Linear's app token is renewed
//   by `linear.refresh-token` instead, which fails the connection itself if Linear refuses that.
// Logs carry IDs and dates, never a token.

export type TokenExpiryDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The built adapters, dropped for a connection that fails. */
  readonly trackers: Pick<ConnectionTrackers, "forget">;
};

export type TokenExpiryOutcome = { readonly warned: number; readonly failed: number };

/** A `@db.Date` value as `YYYY-MM-DD`: the date a warning is recorded once for. */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** One pass over every active Jira connection with a token date. Exported for tests; `tracker.token-expiry` is its job. */
export const checkTokenExpiry = async (deps: TokenExpiryDeps): Promise<TokenExpiryOutcome> => {
  const now = deps.clock.now();
  const rows = await deps.db.connection.findMany({
    where: { kind: "jira", state: "active", tokenExpiresOn: { not: null } },
    select: { id: true, organizationId: true, tokenExpiresOn: true },
    orderBy: { id: "asc" },
  });
  let warned = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.tokenExpiresOn === null) continue;
    const organizationId = organizationIdSchema.parse(row.organizationId);
    const connectionId = connectionIdSchema.parse(row.id);
    const expiresOn = dayOf(row.tokenExpiresOn);
    const state = tokenExpiryState(row, now);
    switch (state.state) {
      case "healthy":
        break;
      case "expires-soon": {
        const made = await deps.db.$transaction(async (tx) => {
          // Once per connection and date: a replaced token with a new date is warned of again.
          const said = await tx.auditEntry.findFirst({
            where: { organizationId, action: "tracker.token-expiring", entity: "connection", entityId: connectionId, data: { path: ["expiresOn"], equals: expiresOn } },
            select: { id: true },
          });
          if (said !== null) {
            return false;
          }
          await deps.audit.recordInTx(tx, {
            organizationId,
            projectId: null,
            actor: { kind: "system", id: null },
            action: "tracker.token-expiring",
            entity: "connection",
            entityId: connectionId,
            data: { kind: "jira", expiresOn, days: state.days },
          });
          await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "connection", entityId: connectionId });
          return true;
        });
        if (made) {
          warned += 1;
          deps.logger.info("tracker.token-expiring", { organizationId, connectionId, expiresOn, days: state.days });
        }
        break;
      }
      case "expired": {
        const moved = await deps.db.$transaction((tx) => failConnection({ tx, audit: deps.audit, notices: deps.notices }, { organizationId, connectionId, reason: "token-expired" }));
        if (moved) {
          failed += 1;
          deps.trackers.forget(connectionId);
          deps.logger.warn("tracker.token-expired", { organizationId, connectionId, expiresOn });
        }
        break;
      }
      default:
        return state satisfies never;
    }
  }
  return { warned, failed };
};

export const tokenExpiryHandler =
  (deps: TokenExpiryDeps): JobHandler<"tracker.token-expiry"> =>
  async (context) => {
    const outcome = await checkTokenExpiry(deps);
    if (outcome.warned + outcome.failed > 0) {
      context.logger.info("tracker.token-expiry", { ...outcome });
    }
  };

/** The daily schedule: one pass a day however many replicas run. */
export const ensureTokenExpirySchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("tracker.token-expiry", "daily", TOKEN_EXPIRY_CRON, {});
};

/**
 * The tracker refused a connection's saved token (401): the connection fails at once
 * (`token-refused`) and its boards pause, unless its credential renews itself (a refresh token,
 * which `linear.refresh-token` keeps). `true` when it failed it.
 */
export const failRefusedToken = async (deps: TokenExpiryDeps, input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId }): Promise<boolean> => {
  const row = await deps.db.connection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { state: true, refreshTokenSecretRef: true },
  });
  if (row?.state !== "active" || row.refreshTokenSecretRef !== null) {
    return false;
  }
  const moved = await deps.db.$transaction((tx) => failConnection({ tx, audit: deps.audit, notices: deps.notices }, { ...input, reason: "token-refused" }));
  deps.trackers.forget(input.connectionId);
  if (moved) {
    deps.logger.warn("tracker.token-refused", { organizationId: input.organizationId, connectionId: input.connectionId });
  }
  return moved;
};
