import type { DbEnum, Prisma } from "@ostra/db";
import { connectionIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 11's lifecycles (F-152, ADR 0071; spec section 5.4, ticket 05; domain-model.md, "A
// tracker connection's lifecycle" and "A board's state"). A tracker connection is one tracker
// account an organization holds: one Linear workspace or one Jira site. It is `pending` until it
// connects, `active` while it works, `failed` when its token stops working, and `revoked` once an
// admin disconnects it; a revoked one names the connection of the same site that took its boards.
// A board's state is derived, never stored: `attached` while its connection is active, `paused`
// while it isn't, `detached` once a project admin detaches it. `boardStateOf` is the one place that
// derives it, and `attachedBoardWhere` is the same rule as a query.

// ---------- a tracker connection ----------

export type TrackerConnectionLifecycle =
  /** Made, not connected yet: Linear's app waits for its values or its consent, Jira's steps for theirs. */
  | { readonly state: Extract<DbEnum.ConnectionState, "pending"> }
  /** Connected: events arrive, its boards are attached. `activatedAt` is `null` on a row older than the column. */
  | { readonly state: Extract<DbEnum.ConnectionState, "active">; readonly activatedAt: number | null }
  /** Its token stopped working (refused, expired, not refreshed): its boards pause until it's fixed. Words and IDs only. */
  | { readonly state: Extract<DbEnum.ConnectionState, "failed">; readonly reason: string | null }
  /** Disconnected: its secrets are gone. `resumedInto` is the connection of the same site that took its paused boards. */
  | { readonly state: Extract<DbEnum.ConnectionState, "revoked">; readonly resumedInto: ConnectionId | null };

export type TrackerConnectionInput =
  /** The connection works: Linear's consent, Jira's first signed delivery or its polling finish, a fixed token. */
  | { readonly type: "activate"; readonly at: number }
  /** The token stopped working. */
  | { readonly type: "fail"; readonly reason: string }
  /** An admin disconnects it, whatever state it's in. */
  | { readonly type: "revoke" }
  /** A later connection of the same site took its paused boards (`resumeBoardsInTx`): once. */
  | { readonly type: "resume"; readonly into: ConnectionId };

/** `pending` → `active` ⇄ `failed` → `revoked` (and `pending` → `revoked`); a revoked one is resumed into its successor once. */
export const transitionTrackerConnection = (connection: TrackerConnectionLifecycle, input: TrackerConnectionInput): Transition<TrackerConnectionLifecycle> => {
  switch (connection.state) {
    case "pending":
      switch (input.type) {
        case "activate":
          return moveTo({ state: "active", activatedAt: input.at });
        case "revoke":
          return moveTo({ state: "revoked", resumedInto: null });
        case "fail":
        case "resume":
          return refuse(input, connection.state);
        default:
          return input satisfies never;
      }
    case "active":
      switch (input.type) {
        case "fail":
          return moveTo({ state: "failed", reason: input.reason });
        case "revoke":
          return moveTo({ state: "revoked", resumedInto: null });
        case "activate":
        case "resume":
          return refuse(input, connection.state);
        default:
          return input satisfies never;
      }
    case "failed":
      switch (input.type) {
        case "activate":
          return moveTo({ state: "active", activatedAt: input.at });
        case "revoke":
          return moveTo({ state: "revoked", resumedInto: null });
        case "fail":
        case "resume":
          return refuse(input, connection.state);
        default:
          return input satisfies never;
      }
    case "revoked":
      switch (input.type) {
        case "resume":
          return connection.resumedInto === null ? moveTo({ state: "revoked", resumedInto: input.into }) : refuse(input, connection.state);
        case "activate":
        case "fail":
        case "revoke":
          return refuse(input, connection.state);
        default:
          return input satisfies never;
      }
    default:
      return connection satisfies never;
  }
};

/** A connection row's lifecycle, as its columns hold it. */
export const trackerConnectionLifecycleOf = (row: {
  readonly state: DbEnum.ConnectionState;
  readonly activatedAt: Date | null;
  readonly failedReason: string | null;
  readonly resumedIntoId: string | null;
}): TrackerConnectionLifecycle => {
  switch (row.state) {
    case "pending":
      return { state: "pending" };
    case "active":
      return { state: "active", activatedAt: row.activatedAt?.getTime() ?? null };
    case "failed":
      return { state: "failed", reason: row.failedReason };
    case "revoked":
      return { state: "revoked", resumedInto: row.resumedIntoId === null ? null : connectionIdSchema.parse(row.resumedIntoId) };
    default:
      return row.state satisfies never;
  }
};

// ---------- a board ----------

/** Why a board is paused: its connection was disconnected (or isn't connected yet), or its token failed. */
export const boardPauseReasons = ["disconnected", "failed"] as const;
export type BoardPauseReason = (typeof boardPauseReasons)[number];

export type BoardState =
  /** Its connection is active: polled, moved, its tickets start tasks. */
  | { readonly state: "attached" }
  /**
   * Its connection isn't active: nothing moves on the tracker, polling stops, no rule, schedule or
   * ticket starts a task from it, and its tickets and tasks stay readable. It still counts as the
   * project's board, and resumes when its connection (or its site's next one) is active.
   */
  | { readonly state: "paused"; readonly pausedBy: BoardPauseReason }
  /** A project admin detached it: no polling, no new task. Attaching its team again clears it. */
  | { readonly state: "detached"; readonly detachedAt: number };

export type BoardStateName = BoardState["state"];

/**
 * The one derivation of a board's state (ADR 0071): detached when a project admin detached it, else
 * from its connection's state. Ingest, polling, ticket sync, rules, schedules, prompt tickets and
 * the panel read it, never `detachedAt` and the connection's state by hand.
 */
export const boardStateOf = (board: { readonly detachedAt: Date | null }, connection: { readonly state: DbEnum.ConnectionState }): BoardState => {
  if (board.detachedAt !== null) {
    return { state: "detached", detachedAt: board.detachedAt.getTime() };
  }
  switch (connection.state) {
    case "active":
      return { state: "attached" };
    case "failed":
      return { state: "paused", pausedBy: "failed" };
    case "pending":
    case "revoked":
      return { state: "paused", pausedBy: "disconnected" };
    default:
      return connection.state satisfies never;
  }
};

/** Whether a board is attached: polled, moved, and started from. */
export const isBoardAttached = (board: { readonly detachedAt: Date | null }, connection: { readonly state: DbEnum.ConnectionState }): boolean =>
  boardStateOf(board, connection).state === "attached";

/**
 * `boardStateOf`'s `attached` as a query, for the readers that list boards or their tickets in SQL.
 * A test holds the two to the same answer for every board and connection state.
 */
export const attachedBoardWhere = { detachedAt: null, connection: { state: "active" } } as const satisfies Prisma.BoardWhereInput;
