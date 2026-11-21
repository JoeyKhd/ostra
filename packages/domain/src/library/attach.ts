import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, libraryItemIdSchema } from "@ostra/protocol";
import type { LibraryItemId, MemberId, OrganizationId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import { libraryItemFromRow, transitionLibraryItem } from "../lifecycles/m8-library.ts";
import type { AttachError, AttachItem, DetachItem, LibraryDeps, RemoveItem, SetEveryProfile, SetReadOnly } from "../use-cases/m8-library-signatures.ts";
import { testCurrentVersion } from "./install.ts";
import { profileListRefusal } from "./profile-library.ts";
import { storedToolNamesSchema } from "./stored.ts";

// F-145 (ADR 0069, "Attaching", Q315, Q321, ticket 28): an organization admin puts a library item
// on a profile, or on every profile of the organization, the built-in Refine and Review profiles
// included, and takes it off again or out of the library. Projects pick profiles, and nothing is
// attached to a task. Each change is one transaction with its audit entry (names, never content)
// and its change notice, under the organization's row lock, so two admins' attaches can't pass a
// limit together. Tasks get the change at their next session, as a profile edit does. A server
// that asks for a sign-in ostra doesn't do yet can't go on a profile; one whose version lists no
// tools yet (installed, never tested) gets its test call first, which marks one that asks.

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const NEEDS_OAUTH = "The server asks for an OAuth sign-in, which ostra doesn't do yet: it can't go on a profile";
const NO_ITEM = "No such item in the library";

const loggerOf = (deps: Pick<LibraryDeps, "logger">) => deps.logger.child({ component: "library" });

/** One admin's attach or every-profile switch at a time, per organization: the lists are checked and written under it. */
export const lockLibraryInTx = async (tx: Tx, organizationId: OrganizationId): Promise<void> => {
  await tx.$executeRaw`SELECT 1 FROM "organization" WHERE "id" = ${organizationId} FOR UPDATE`;
};

const itemSelect = {
  id: true,
  kind: true,
  name: true,
  everyProfile: true,
  readOnly: true,
  installedByMemberId: true,
  installedAt: true,
  removedAt: true,
  removedByMemberId: true,
  currentVersion: { select: { needsOAuth: true, toolNames: true } },
} as const;

const findItem = (deps: Pick<LibraryDeps, "db">, organizationId: OrganizationId, itemId: LibraryItemId) =>
  deps.db.libraryItem.findFirst({ where: { id: itemId, organizationId, removedAt: null }, select: itemSelect });

type FoundItem = NonNullable<Awaited<ReturnType<typeof findItem>>>;

/**
 * A server can go on a profile when its current version doesn't ask for a sign-in. One that lists
 * no tools may never have been tested: its test call runs first, which marks one that asks.
 */
const serverReady = async (deps: LibraryDeps, organizationId: OrganizationId, item: FoundItem): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AttachError; readonly message: string }> => {
  if (item.kind !== "mcp_server") {
    return { ok: true };
  }
  if (item.currentVersion === null) {
    return refuse("not-found", NO_ITEM);
  }
  if (item.currentVersion.needsOAuth) {
    return refuse("needs-oauth", NEEDS_OAUTH);
  }
  const tools = storedToolNamesSchema.safeParse(item.currentVersion.toolNames);
  if (tools.success && tools.data.length > 0) {
    return { ok: true };
  }
  const tested = await testCurrentVersion(deps, organizationId, libraryItemIdSchema.parse(item.id));
  if (!tested.ok) {
    return refuse(tested.error === "not-found" ? "not-found" : "unavailable", `The server was tested before it goes on a profile, and the test call failed: ${tested.message}`);
  }
  return tested.needsOAuth ? refuse("needs-oauth", NEEDS_OAUTH) : { ok: true };
};

const auditData = (item: FoundItem) => ({ kind: item.kind, name: item.name });

const noticeInTx = (deps: LibraryDeps, tx: Tx, organizationId: OrganizationId) => deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });

const recordInTx = (deps: LibraryDeps, tx: Tx, input: { readonly organizationId: OrganizationId; readonly memberId: MemberId; readonly action: "library.attached" | "library.detached" | "library.every_profile_changed" | "library.removed" | "library.read_only_changed"; readonly itemId: string; readonly data: Record<string, string | number | boolean> }) =>
  deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: { kind: "member", id: input.memberId },
    action: input.action,
    entity: "library-item",
    entityId: libraryItemIdSchema.parse(input.itemId),
    data: input.data,
  });

/** An organization admin attaches an item to a profile, within its limits and with no name it uses. Attached already: as it was. */
export const attachItem: AttachItem = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin attaches library items to profiles");
  }
  const item = await findItem(deps, organizationId, input.itemId);
  const profile = await deps.db.agentProfile.findFirst({ where: { id: input.profileId, organizationId }, select: { id: true, name: true } });
  if (item === null) {
    return refuse("not-found", NO_ITEM);
  }
  if (profile === null) {
    return refuse("not-found", "No such agent profile");
  }
  const ready = await serverReady(deps, organizationId, item);
  if (!ready.ok) {
    return ready;
  }
  const result = await deps.db.$transaction(async (tx) => {
    await lockLibraryInTx(tx, organizationId);
    const existing = await tx.agentProfileLibraryItem.findFirst({ where: { organizationId, profileId: profile.id, itemId: item.id }, select: { attachedAt: true } });
    if (existing !== null) {
      return { ok: true, attachedAt: existing.attachedAt.getTime(), added: false } as const;
    }
    // Read again under the lock: the item may have gone since.
    if ((await tx.libraryItem.count({ where: { id: item.id, organizationId, removedAt: null } })) === 0) {
      return refuse("not-found", NO_ITEM);
    }
    const refusal = await profileListRefusal(tx, { organizationId, profileId: agentProfileIdSchema.parse(profile.id), adding: { itemId: libraryItemIdSchema.parse(item.id), kind: item.kind, name: item.name }, as: "attached" });
    if (refusal !== null) {
      return refuse(refusal.code, refusal.message);
    }
    const attachedAt = new Date(deps.clock.now());
    await tx.agentProfileLibraryItem.create({ data: { organizationId, profileId: profile.id, itemId: item.id, attachedByMemberId: scope.memberId, attachedAt } });
    await recordInTx(deps, tx, { organizationId, memberId: scope.memberId, action: "library.attached", itemId: item.id, data: { ...auditData(item), profileId: profile.id, profile: profile.name } });
    await noticeInTx(deps, tx, organizationId);
    return { ok: true, attachedAt: attachedAt.getTime(), added: true } as const;
  });
  if (!result.ok) {
    loggerOf(deps).info("library.attach.refused", { organizationId, itemId: item.id, profileId: profile.id, kind: item.kind, error: result.error });
    return result;
  }
  if (result.added) {
    loggerOf(deps).info("library.attached", { organizationId, itemId: item.id, profileId: profile.id, kind: item.kind });
  }
  return { ok: true, attachedAt: result.attachedAt };
};

/** An organization admin takes an item off a profile. Not on it: `detached: false`. */
export const detachItem: DetachItem = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin detaches library items from profiles");
  }
  const item = await deps.db.libraryItem.findFirst({ where: { id: input.itemId, organizationId }, select: itemSelect });
  const profile = await deps.db.agentProfile.findFirst({ where: { id: input.profileId, organizationId }, select: { id: true, name: true } });
  if (item === null) {
    return refuse("not-found", NO_ITEM);
  }
  if (profile === null) {
    return refuse("not-found", "No such agent profile");
  }
  const detached = await deps.db.$transaction(async (tx) => {
    const removed = await tx.agentProfileLibraryItem.deleteMany({ where: { organizationId, profileId: profile.id, itemId: item.id } });
    if (removed.count === 0) {
      return false;
    }
    await recordInTx(deps, tx, { organizationId, memberId: scope.memberId, action: "library.detached", itemId: item.id, data: { ...auditData(item), profileId: profile.id, profile: profile.name } });
    await noticeInTx(deps, tx, organizationId);
    return true;
  });
  if (detached) {
    loggerOf(deps).info("library.detached", { organizationId, itemId: item.id, profileId: profile.id, kind: item.kind });
  }
  return { ok: true, detached };
};

/**
 * An organization admin puts an item on every profile, or takes it off. On: every profile of the
 * organization that isn't archived, the built-in ones included, must hold it within its limits
 * and with no name it uses, or none gets it, and the refusal names each profile it would break.
 */
export const setEveryProfile: SetEveryProfile = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin puts a library item on every profile");
  }
  const item = await findItem(deps, organizationId, input.itemId);
  if (item === null) {
    return refuse("not-found", NO_ITEM);
  }
  if (item.everyProfile === input.everyProfile) {
    return { ok: true, everyProfile: input.everyProfile };
  }
  if (input.everyProfile) {
    const ready = await serverReady(deps, organizationId, item);
    if (!ready.ok) {
      return ready;
    }
  }
  const result = await deps.db.$transaction(async (tx) => {
    await lockLibraryInTx(tx, organizationId);
    const now = await tx.libraryItem.findFirst({ where: { id: item.id, organizationId, removedAt: null }, select: { everyProfile: true } });
    if (now === null) {
      return refuse("not-found", NO_ITEM);
    }
    if (now.everyProfile === input.everyProfile) {
      return { ok: true, changed: false } as const;
    }
    if (input.everyProfile) {
      const profiles = await tx.agentProfile.findMany({ where: { organizationId, archivedAt: null }, select: { id: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
      const refusals = [];
      for (const profile of profiles) {
        const refusal = await profileListRefusal(tx, { organizationId, profileId: agentProfileIdSchema.parse(profile.id), adding: { itemId: libraryItemIdSchema.parse(item.id), kind: item.kind, name: item.name }, as: "every_profile" });
        if (refusal !== null) {
          refusals.push(refusal);
        }
      }
      const [first] = refusals;
      if (first !== undefined) {
        return refuse(first.code, refusals.map((refusal) => refusal.message).join(". "));
      }
    }
    await tx.libraryItem.update({ where: { id: item.id }, data: { everyProfile: input.everyProfile } });
    await recordInTx(deps, tx, { organizationId, memberId: scope.memberId, action: "library.every_profile_changed", itemId: item.id, data: { ...auditData(item), everyProfile: input.everyProfile } });
    await noticeInTx(deps, tx, organizationId);
    return { ok: true, changed: true } as const;
  });
  if (!result.ok) {
    loggerOf(deps).info("library.every-profile.refused", { organizationId, itemId: item.id, kind: item.kind, error: result.error });
    return result;
  }
  if (result.changed) {
    loggerOf(deps).info("library.every-profile.changed", { organizationId, itemId: item.id, kind: item.kind, everyProfile: input.everyProfile });
  }
  return { ok: true, everyProfile: input.everyProfile };
};

/** An organization admin marks a library server read-only, or not: plan mode may call a read-only one, and "Reaching the network" doesn't ask. */
export const setReadOnly: SetReadOnly = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin marks a library server read-only");
  }
  const item = await findItem(deps, organizationId, input.itemId);
  if (item?.kind !== "mcp_server") {
    return refuse("not-found", "No such MCP server in the library");
  }
  if (item.readOnly !== input.readOnly) {
    await deps.db.$transaction(async (tx) => {
      await tx.libraryItem.update({ where: { id: item.id }, data: { readOnly: input.readOnly } });
      await recordInTx(deps, tx, { organizationId, memberId: scope.memberId, action: "library.read_only_changed", itemId: item.id, data: { ...auditData(item), readOnly: input.readOnly } });
      await noticeInTx(deps, tx, organizationId);
    });
    loggerOf(deps).info("library.read-only.changed", { organizationId, itemId: item.id, readOnly: input.readOnly });
  }
  return { ok: true, readOnly: input.readOnly };
};

/** An organization admin removes an item: off every profile in the same transaction. Tasks lose it at their next session. */
export const removeItem: RemoveItem = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin removes library items");
  }
  const result = await deps.db.$transaction(async (tx) => {
    await lockLibraryInTx(tx, organizationId);
    const item = await tx.libraryItem.findFirst({ where: { id: input.itemId, organizationId }, select: itemSelect });
    if (item === null) {
      return null;
    }
    const at = deps.clock.now();
    const moved = transitionLibraryItem(libraryItemFromRow(item), { type: "remove", by: scope.memberId, at });
    if (!moved.ok) {
      return null;
    }
    const detached = await tx.agentProfileLibraryItem.deleteMany({ where: { organizationId, itemId: item.id } });
    await tx.libraryItem.update({ where: { id: item.id }, data: { removedAt: new Date(at), removedByMemberId: scope.memberId } });
    await recordInTx(deps, tx, { organizationId, memberId: scope.memberId, action: "library.removed", itemId: item.id, data: { ...auditData(item), detached: detached.count, everyProfile: item.everyProfile } });
    await noticeInTx(deps, tx, organizationId);
    return { removedAt: at, detached: detached.count, kind: item.kind };
  });
  if (result === null) {
    return refuse("not-found", NO_ITEM);
  }
  loggerOf(deps).info("library.removed", { organizationId, itemId: input.itemId, kind: result.kind, detached: result.detached });
  return { ok: true, removedAt: result.removedAt };
};
