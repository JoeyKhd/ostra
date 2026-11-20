import type { TrackerFor } from "@ostra/domain";

import type { ConnectionTrackers } from "../tracker/connections.ts";

// Sub-issues in core (F-077, milestone 6's ticket 12): the domain's `startSubIssues` reads a parent's
// tree through the connection's tracker, which core's cached connections give it. The parent's
// progress comment is milestone 2's tracker writer (`tracker/writer.ts`).

/** The domain's tracker lookup over core's cached connections: `null` when one can't be read now. */
export const trackerForConnections =
  (trackers: Pick<ConnectionTrackers, "forConnection">): TrackerFor =>
  async (organizationId, connectionId) => {
    const lookup = await trackers.forConnection(organizationId, connectionId);
    return lookup.ok ? lookup.value : null;
  };
