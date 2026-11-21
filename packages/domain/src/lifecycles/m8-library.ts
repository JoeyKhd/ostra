import type { DbEnum } from "@ostra/db";
import { libraryItemIdSchema, memberIdSchema } from "@ostra/protocol";
import type { LibraryItemId, MemberId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 8's library lifecycles (spec section 5.4, ticket 06; ADR 0069; domain-model.md, "The
// library"). Each is a discriminated union with one transition function, and every switch is
// exhaustive. Nothing moves by itself: an update waits for an admin (Q323). The state names come
// from the schema's enums (milestone 8's migration), and each `...FromRow` switches over the enum,
// so a state added on one side only is a type error.

// ---------- a version of an item: its pin ----------

/**
 * A version: `available` when the update check found a newer pin, `current` once accepted (an
 * install's first version starts current), `dismissed` when an admin left the item where it is,
 * and `superseded` when a newer one took its place: a newer version became current, or (ticket
 * 28) the check found a newer update while this one still waited, so an item has at most one
 * update waiting, and an accept names the exact content the admin saw.
 */
export type LibraryVersionLifecycle =
  | { readonly state: Extract<DbEnum.LibraryVersionState, "available">; readonly fetchedAt: number }
  /** `decidedBy` is `null` for an install's first version, which nobody accepted: it was installed. */
  | { readonly state: Extract<DbEnum.LibraryVersionState, "current">; readonly decidedBy: MemberId | null; readonly at: number }
  | { readonly state: Extract<DbEnum.LibraryVersionState, "dismissed">; readonly decidedBy: MemberId; readonly at: number }
  | { readonly state: Extract<DbEnum.LibraryVersionState, "superseded">; readonly at: number };

export type LibraryVersionState = DbEnum.LibraryVersionState;

export type LibraryVersionInput =
  /** An admin's "Accept": the item's next dispatches take it. */
  | { readonly type: "accept"; readonly by: MemberId; readonly at: number }
  /** An admin's "Dismiss": a newer one shows again. */
  | { readonly type: "dismiss"; readonly by: MemberId; readonly at: number }
  /** A newer version became current, or a newer update was found while this one waited. */
  | { readonly type: "supersede"; readonly at: number };

export const transitionLibraryVersion = (version: LibraryVersionLifecycle, input: LibraryVersionInput): Transition<LibraryVersionLifecycle> => {
  switch (version.state) {
    case "available":
      switch (input.type) {
        case "accept":
          return moveTo({ state: "current", decidedBy: input.by, at: input.at });
        case "dismiss":
          return moveTo({ state: "dismissed", decidedBy: input.by, at: input.at });
        case "supersede":
          return moveTo({ state: "superseded", at: input.at });
        default:
          return input satisfies never;
      }
    case "current":
      switch (input.type) {
        case "supersede":
          return moveTo({ state: "superseded", at: input.at });
        case "accept":
        case "dismiss":
          return refuse(input, version.state);
        default:
          return input satisfies never;
      }
    case "dismissed":
    case "superseded":
      return refuse(input, version.state);
    default:
      return version satisfies never;
  }
};

// ---------- a member's suggestion ----------

export type LibrarySuggestionLifecycle =
  | { readonly state: Extract<DbEnum.LibrarySuggestionState, "open"> }
  | { readonly state: Extract<DbEnum.LibrarySuggestionState, "installed">; readonly itemId: LibraryItemId; readonly decidedBy: MemberId; readonly at: number }
  | { readonly state: Extract<DbEnum.LibrarySuggestionState, "dismissed">; readonly decidedBy: MemberId; readonly at: number };

export type LibrarySuggestionState = DbEnum.LibrarySuggestionState;

export type LibrarySuggestionInput =
  | { readonly type: "install"; readonly itemId: LibraryItemId; readonly by: MemberId; readonly at: number }
  | { readonly type: "dismiss"; readonly by: MemberId; readonly at: number };

export const transitionLibrarySuggestion = (suggestion: LibrarySuggestionLifecycle, input: LibrarySuggestionInput): Transition<LibrarySuggestionLifecycle> => {
  switch (suggestion.state) {
    case "open":
      switch (input.type) {
        case "install":
          return moveTo({ state: "installed", itemId: input.itemId, decidedBy: input.by, at: input.at });
        case "dismiss":
          return moveTo({ state: "dismissed", decidedBy: input.by, at: input.at });
        default:
          return input satisfies never;
      }
    case "installed":
    case "dismissed":
      return refuse(input, suggestion.state);
    default:
      return suggestion satisfies never;
  }
};

// ---------- an item ----------

/** An item: installed, then removed, which detaches it everywhere. A removed item is never installed again: a new install is a new item. */
export type LibraryItemLifecycle =
  | { readonly state: "installed"; readonly installedBy: MemberId; readonly at: number }
  | { readonly state: "removed"; readonly removedBy: MemberId; readonly at: number };

export type LibraryItemInput = { readonly type: "remove"; readonly by: MemberId; readonly at: number };

export const transitionLibraryItem = (item: LibraryItemLifecycle, input: LibraryItemInput): Transition<LibraryItemLifecycle> => {
  switch (item.state) {
    case "installed":
      return moveTo({ state: "removed", removedBy: input.by, at: input.at });
    case "removed":
      return refuse(input, item.state);
    default:
      return item satisfies never;
  }
};

// ---------- from the rows ----------

/** A row whose state's columns don't hold together: a bug, never a member's doing. */
const inconsistent = (what: string): never => {
  throw new Error(`a library ${what} row's state doesn't match its columns`);
};

/** A version's lifecycle from its row. */
export const libraryVersionFromRow = (row: {
  readonly state: DbEnum.LibraryVersionState;
  readonly fetchedAt: Date;
  readonly decidedByMemberId: string | null;
  readonly decidedAt: Date | null;
}): LibraryVersionLifecycle => {
  const decidedBy = row.decidedByMemberId === null ? null : memberIdSchema.parse(row.decidedByMemberId);
  const at = (row.decidedAt ?? row.fetchedAt).getTime();
  switch (row.state) {
    case "available":
      return { state: "available", fetchedAt: row.fetchedAt.getTime() };
    case "current":
      return { state: "current", decidedBy, at };
    case "dismissed":
      return decidedBy === null ? inconsistent("version") : { state: "dismissed", decidedBy, at };
    case "superseded":
      return { state: "superseded", at };
    default:
      return row.state satisfies never;
  }
};

/** A suggestion's lifecycle from its row. */
export const librarySuggestionFromRow = (row: {
  readonly state: DbEnum.LibrarySuggestionState;
  readonly decidedByMemberId: string | null;
  readonly decidedAt: Date | null;
  readonly itemId: string | null;
}): LibrarySuggestionLifecycle => {
  switch (row.state) {
    case "open":
      return { state: "open" };
    case "installed":
      return row.decidedByMemberId === null || row.decidedAt === null || row.itemId === null
        ? inconsistent("suggestion")
        : { state: "installed", itemId: libraryItemIdSchema.parse(row.itemId), decidedBy: memberIdSchema.parse(row.decidedByMemberId), at: row.decidedAt.getTime() };
    case "dismissed":
      return row.decidedByMemberId === null || row.decidedAt === null
        ? inconsistent("suggestion")
        : { state: "dismissed", decidedBy: memberIdSchema.parse(row.decidedByMemberId), at: row.decidedAt.getTime() };
    default:
      return row.state satisfies never;
  }
};

/** An item's lifecycle from its row. */
export const libraryItemFromRow = (row: {
  readonly installedByMemberId: string;
  readonly installedAt: Date;
  readonly removedAt: Date | null;
  readonly removedByMemberId: string | null;
}): LibraryItemLifecycle => {
  if (row.removedAt === null) {
    return { state: "installed", installedBy: memberIdSchema.parse(row.installedByMemberId), at: row.installedAt.getTime() };
  }
  return row.removedByMemberId === null ? inconsistent("item") : { state: "removed", removedBy: memberIdSchema.parse(row.removedByMemberId), at: row.removedAt.getTime() };
};
