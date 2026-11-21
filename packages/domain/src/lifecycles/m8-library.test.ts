import { libraryItemIdSchema, memberIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { libraryItemFromRow, librarySuggestionFromRow, libraryVersionFromRow, transitionLibraryItem, transitionLibrarySuggestion, transitionLibraryVersion } from "./m8-library.ts";
import type { LibraryItemLifecycle, LibrarySuggestionInput, LibrarySuggestionLifecycle, LibraryVersionInput, LibraryVersionLifecycle } from "./m8-library.ts";

// Milestone 8 (ticket 06): the library's lifecycles, every state against every input, as
// domain-model.md draws them.

const at = Date.UTC(2026, 10, 21, 12);
const by = memberIdSchema.parse("member-1");
const itemId = libraryItemIdSchema.parse("item-1");

describe("the library's lifecycles", () => {
  it("F-145: a version is available, then current or dismissed, and a current one superseded; nothing else moves", () => {
    const available: LibraryVersionLifecycle = { state: "available", fetchedAt: at };
    const current: LibraryVersionLifecycle = { state: "current", decidedBy: by, at };
    const dismissed: LibraryVersionLifecycle = { state: "dismissed", decidedBy: by, at };
    const superseded: LibraryVersionLifecycle = { state: "superseded", at };
    const accept: LibraryVersionInput = { type: "accept", by, at };
    const dismiss: LibraryVersionInput = { type: "dismiss", by, at };
    const supersede: LibraryVersionInput = { type: "supersede", at };
    const table: readonly (readonly [LibraryVersionLifecycle, LibraryVersionInput, LibraryVersionLifecycle | null])[] = [
      [available, accept, current],
      [available, dismiss, dismissed],
      [available, supersede, null],
      [current, accept, null],
      [current, dismiss, null],
      [current, supersede, superseded],
      [dismissed, accept, null],
      [dismissed, dismiss, null],
      [dismissed, supersede, null],
      [superseded, accept, null],
      [superseded, dismiss, null],
      [superseded, supersede, null],
    ];
    for (const [from, input, to] of table) {
      const moved = transitionLibraryVersion(from, input);
      expect(moved, `${from.state} + ${input.type}`).toEqual(to === null ? { ok: false, reason: `${input.type} is not allowed in ${from.state}` } : { ok: true, state: to });
    }
  });

  it("F-145: a suggestion is open, then installed or dismissed, once", () => {
    const open: LibrarySuggestionLifecycle = { state: "open" };
    const install: LibrarySuggestionInput = { type: "install", itemId, by, at };
    const dismiss: LibrarySuggestionInput = { type: "dismiss", by, at };
    expect(transitionLibrarySuggestion(open, install)).toEqual({ ok: true, state: { state: "installed", itemId, decidedBy: by, at } });
    expect(transitionLibrarySuggestion(open, dismiss)).toEqual({ ok: true, state: { state: "dismissed", decidedBy: by, at } });
    for (const decided of [{ state: "installed", itemId, decidedBy: by, at }, { state: "dismissed", decidedBy: by, at }] as const satisfies readonly LibrarySuggestionLifecycle[]) {
      expect(transitionLibrarySuggestion(decided, install).ok).toBe(false);
      expect(transitionLibrarySuggestion(decided, dismiss).ok).toBe(false);
    }
  });

  it("F-145: an item is installed, then removed, and a removed one stays removed", () => {
    const installed: LibraryItemLifecycle = { state: "installed", installedBy: by, at };
    const removed: LibraryItemLifecycle = { state: "removed", removedBy: by, at: at + 1 };
    expect(transitionLibraryItem(installed, { type: "remove", by, at: at + 1 })).toEqual({ ok: true, state: removed });
    expect(transitionLibraryItem(removed, { type: "remove", by, at: at + 2 })).toEqual({ ok: false, reason: "remove is not allowed in removed" });
  });

  it("F-145: reads each lifecycle from its row, every state of the schema's enums, and refuses a row whose columns don't hold together", () => {
    const fetchedAt = new Date(at);
    const decidedAt = new Date(at + 5);
    expect(libraryVersionFromRow({ state: "available", fetchedAt, decidedByMemberId: null, decidedAt: null })).toEqual({ state: "available", fetchedAt: at });
    expect(libraryVersionFromRow({ state: "current", fetchedAt, decidedByMemberId: null, decidedAt: null })).toEqual({ state: "current", decidedBy: null, at });
    expect(libraryVersionFromRow({ state: "current", fetchedAt, decidedByMemberId: by, decidedAt })).toEqual({ state: "current", decidedBy: by, at: at + 5 });
    expect(libraryVersionFromRow({ state: "dismissed", fetchedAt, decidedByMemberId: by, decidedAt })).toEqual({ state: "dismissed", decidedBy: by, at: at + 5 });
    expect(libraryVersionFromRow({ state: "superseded", fetchedAt, decidedByMemberId: by, decidedAt })).toEqual({ state: "superseded", at: at + 5 });
    expect(() => libraryVersionFromRow({ state: "dismissed", fetchedAt, decidedByMemberId: null, decidedAt: null })).toThrow();
    expect(librarySuggestionFromRow({ state: "open", decidedByMemberId: null, decidedAt: null, itemId: null })).toEqual({ state: "open" });
    expect(librarySuggestionFromRow({ state: "installed", decidedByMemberId: by, decidedAt, itemId })).toEqual({ state: "installed", itemId, decidedBy: by, at: at + 5 });
    expect(librarySuggestionFromRow({ state: "dismissed", decidedByMemberId: by, decidedAt, itemId: null })).toEqual({ state: "dismissed", decidedBy: by, at: at + 5 });
    expect(() => librarySuggestionFromRow({ state: "installed", decidedByMemberId: by, decidedAt, itemId: null })).toThrow();
    expect(libraryItemFromRow({ installedByMemberId: by, installedAt: fetchedAt, removedAt: null, removedByMemberId: null })).toEqual({ state: "installed", installedBy: by, at });
    expect(libraryItemFromRow({ installedByMemberId: by, installedAt: fetchedAt, removedAt: decidedAt, removedByMemberId: by })).toEqual({ state: "removed", removedBy: by, at: at + 5 });
  });
});
