import type { MemberId, NotificationId, OrganizationId } from "@ostra/protocol";

// The rows the panel channel delivers (ADR 0050). The channel writes nothing itself: core backs
// these ports with the `Notification` table in `packages/db` (milestone 3, ticket 20), as the
// built-in blob store's rows are backed (ADR 0043). This package never imports the database
// package, so the Apache-2.0 side stays clear of the restricted one (ADR 0045).
// `createMemoryPanelRows` is what tests and a one-process dev run use.

/** Where a panel notification stands: the "Needs you" page shows an open one, and counts it. */
export type PanelNotificationState = "open" | "answered" | "dismissed";

/** Which row. The organization is part of it, so another organization's row is never found. */
export type PanelRowRef = { readonly organizationId: OrganizationId; readonly notificationId: NotificationId };

/** What a port call found: the member the row belongs to, and whether this call was the first delivery. */
export type PanelDelivery = { readonly memberId: MemberId; readonly firstDelivery: boolean };

export type PanelNotificationRows = {
  /**
   * Marks the row delivered, at `at` (ms since the epoch). Marking it twice keeps the first time and
   * answers `firstDelivery: false`. No such row (or another organization's): `undefined`.
   */
  readonly markDelivered: (ref: PanelRowRef, at: number) => Promise<PanelDelivery | undefined>;
  /**
   * Sets the row's state, and hands it the line the panel shows now (core's words for the moment:
   * "Answered by ..."). A backing that renders from the needs-you item may ignore the line. `false`
   * when there is no such row.
   */
  readonly updateState: (ref: PanelRowRef, update: { readonly state: PanelNotificationState; readonly line: string }) => Promise<boolean>;
};

/** A row of the in-memory backing, for a test to seed and read. */
export type MemoryPanelRow = {
  readonly organizationId: OrganizationId;
  readonly notificationId: NotificationId;
  readonly memberId: MemberId;
  readonly state: PanelNotificationState;
  readonly deliveredAt: number | null;
  /** The line the row shows, as the last send or update gave it. */
  readonly line: string;
  /** How many times the row's state was updated. */
  readonly updates: number;
};

export type MemoryPanelRows = PanelNotificationRows & {
  /** Adds an open, undelivered row for a member. */
  readonly add: (row: Pick<MemoryPanelRow, "organizationId" | "notificationId" | "memberId">) => void;
  readonly get: (ref: PanelRowRef) => MemoryPanelRow | undefined;
  readonly all: () => readonly MemoryPanelRow[];
  /** The next call of either method throws, as a database that fell over would. */
  readonly failNext: () => void;
};

const keyOf = (ref: PanelRowRef): string => `${ref.organizationId}:${ref.notificationId}`;

export const createMemoryPanelRows = (): MemoryPanelRows => {
  const rows = new Map<string, MemoryPanelRow>();
  let failing = false;
  const guard = (): void => {
    if (failing) {
      failing = false;
      throw new Error("the rows are down");
    }
  };
  return {
    add: (row) => {
      rows.set(keyOf(row), { ...row, state: "open", deliveredAt: null, line: "", updates: 0 });
    },
    get: (ref) => rows.get(keyOf(ref)),
    all: () => [...rows.values()],
    failNext: () => {
      failing = true;
    },
    markDelivered: (ref, at) => {
      try {
        guard();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("the rows are down"));
      }
      const row = rows.get(keyOf(ref));
      if (row === undefined) {
        return Promise.resolve(undefined);
      }
      const first = row.deliveredAt === null;
      if (first) {
        rows.set(keyOf(ref), { ...row, deliveredAt: at });
      }
      return Promise.resolve({ memberId: row.memberId, firstDelivery: first });
    },
    updateState: (ref, update) => {
      try {
        guard();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error("the rows are down"));
      }
      const row = rows.get(keyOf(ref));
      if (row === undefined) {
        return Promise.resolve(false);
      }
      rows.set(keyOf(ref), { ...row, state: update.state, line: update.line, updates: row.updates + 1 });
      return Promise.resolve(true);
    },
  };
};
