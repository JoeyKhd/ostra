import type { Db, Tx } from "@ostra/db";
import { libraryItemIdSchema, librarySuggestionIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import { librarySuggestionFromRow, transitionLibrarySuggestion } from "../lifecycles/m8-library.ts";
import type { DecideSuggestion, LibraryCounts, SuggestItem } from "../use-cases/m8-library-signatures.ts";
import { allowed } from "./allowed.ts";
import type { AllowlistEntry } from "./allowed.ts";
import { parseLibraryReference } from "./reference.ts";
import type { LibraryReference } from "./reference.ts";
import { listedRegistries } from "./registry-source.ts";
import { allowlistOf } from "./sources.ts";

// F-145 (ADR 0069, "Installing", Q322, ticket 28): members suggest, organization admins install.
// A suggestion is a reference, matched against the allowlist so it can say when its source isn't
// on it, and a note, which is never logged nor written into an audit entry. An admin installs it
// (ticket 27's install, then the suggestion linked to the item it made) or dismisses it, with its
// audit entry. Admins see a quiet count: open suggestions, and items with an update waiting.

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

/** The longest note a suggestion keeps *(working value)*. */
export const SUGGESTION_NOTE_MAX = 2000;

/**
 * Whether a reference's source is on the organization's list: a repo or a site by its own entry; a
 * registry server by its registry, or, when the reference names none, by any registry on the list.
 */
export const referenceAllowed = async (db: Db | Tx, organizationId: OrganizationId, reference: LibraryReference, sources?: readonly AllowlistEntry[]): Promise<boolean> => {
  const list = sources ?? (await allowlistOf(db, organizationId));
  switch (reference.kind) {
    case "github":
      return allowed({ kind: "github", owner: reference.owner, repo: reference.repo }, list).allowed;
    case "well_known":
      return allowed({ kind: "well_known", url: reference.url }, list).allowed;
    case "registry": {
      const registries = reference.registryUrl === null ? await listedRegistries(db, organizationId) : [reference.registryUrl];
      return registries.some((registryUrl) => allowed({ kind: "registry", registryUrl, name: reference.name }, list).allowed);
    }
    default:
      return reference satisfies never;
  }
};

/** Any member suggests a reference with a note. The note is never logged. */
export const suggestItem: SuggestItem = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  const parsed = parseLibraryReference(input.reference);
  if (!parsed.ok) {
    return refuse("invalid-reference", parsed.error);
  }
  const note = input.note.trim();
  if (note.length > SUGGESTION_NOTE_MAX) {
    return refuse("invalid-input", `A suggestion's note is at most ${String(SUGGESTION_NOTE_MAX)} characters`);
  }
  const sourceAllowed = await referenceAllowed(deps.db, organizationId, parsed.value);
  const row = await deps.db.$transaction(async (tx) => {
    const created = await tx.librarySuggestion.create({
      data: { organizationId, memberId: scope.memberId, reference: input.reference.trim(), note: note === "" ? null : note, state: "open" },
      select: { id: true },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return created;
  });
  const suggestionId = librarySuggestionIdSchema.parse(row.id);
  deps.logger.child({ component: "library" }).info("library.suggested", { organizationId, suggestionId, sourceKind: parsed.value.kind, sourceAllowed });
  return { ok: true, suggestionId, sourceAllowed };
};

/** An organization admin decides an open suggestion: installed (the item ticket 27's install made from it) or dismissed. */
export const decideSuggestion: DecideSuggestion = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin decides a suggestion");
  }
  const at = deps.clock.now();
  const decided = await deps.db.$transaction(async (tx) => {
    const suggestion = await tx.librarySuggestion.findFirst({ where: { id: input.suggestionId, organizationId }, select: { id: true, state: true, decidedByMemberId: true, decidedAt: true, itemId: true } });
    if (suggestion === null) {
      return "not-found" as const;
    }
    await tx.$executeRaw`SELECT 1 FROM "library_suggestion" WHERE "id" = ${suggestion.id} FOR UPDATE`;
    const fresh = await tx.librarySuggestion.findFirst({ where: { id: suggestion.id }, select: { state: true, decidedByMemberId: true, decidedAt: true, itemId: true } });
    if (fresh === null) {
      return "not-found" as const;
    }
    let itemId: string | null = null;
    if (input.decision.kind === "installed") {
      const item = await tx.libraryItem.findFirst({ where: { id: input.decision.itemId, organizationId, removedAt: null }, select: { id: true } });
      if (item === null) {
        return "no-item" as const;
      }
      itemId = item.id;
    }
    const moved = transitionLibrarySuggestion(
      librarySuggestionFromRow(fresh),
      input.decision.kind === "installed" ? { type: "install", itemId: libraryItemIdSchema.parse(itemId), by: scope.memberId, at } : { type: "dismiss", by: scope.memberId, at },
    );
    if (!moved.ok) {
      return "decided" as const;
    }
    await tx.librarySuggestion.update({
      where: { id: suggestion.id },
      data: { state: input.decision.kind, decidedByMemberId: scope.memberId, decidedAt: new Date(at), itemId },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "library.suggestion_decided",
      entity: "library-suggestion",
      entityId: input.suggestionId,
      data: { decision: input.decision.kind, itemId },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return "decided-now" as const;
  });
  switch (decided) {
    case "not-found":
      return refuse("not-found", "No such suggestion");
    case "no-item":
      return refuse("not-found", "No such item in the library");
    case "decided":
      return refuse("not-allowed-in-state", "This suggestion was decided already");
    case "decided-now":
      deps.logger.child({ component: "library" }).info("library.suggestion.decided", { organizationId, suggestionId: input.suggestionId, decision: input.decision.kind });
      return { ok: true, decidedAt: at };
    default:
      return decided satisfies never;
  }
};

/** The admins' quiet counts: open suggestions, and items with an update waiting. */
export const libraryCounts: LibraryCounts = async (deps, scope) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin sees the library's counts");
  }
  const [openSuggestions, updatesWaiting] = await Promise.all([
    deps.db.librarySuggestion.count({ where: { organizationId, state: "open" } }),
    deps.db.libraryItem.count({ where: { organizationId, removedAt: null, versions: { some: { state: "available" } } } }),
  ]);
  return { ok: true, openSuggestions, updatesWaiting };
};
