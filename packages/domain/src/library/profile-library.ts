import type { Db, Tx } from "@ostra/db";
import { agentItemNameSchema, libraryItemIdSchema, libraryItemVersionIdSchema } from "@ostra/protocol";
import type { AgentProfileId, LibraryItemId, LibraryItemVersionId, OrganizationId } from "@ostra/protocol";

import { storedMcpServersSchema } from "../use-cases/task-profile.ts";
import { profileItems } from "./profile-items.ts";
import type { ProfileItemsRefusal, ProfileLibraryItem, ProfileOwnItems } from "./profile-items.ts";
import { libraryVersionFilesSchema, storedServerEntrySchema, storedServerInputsSchema } from "./stored.ts";
import type { LibraryVersionFile, StoredServerEntry, StoredServerInputs } from "./stored.ts";

// F-145 (ADR 0069, "Attaching" and "Delivery: unchanged", ticket 28): the library items a profile
// hands its tasks, as the dispatch and the credentials read them, and the profile's whole list as
// an attach or a switch to every profile checks it. A profile's items are its own skills and
// servers, the items attached to it, and the items on every profile, each at its current version,
// and all of them together within 50 skills and 20 servers. An attach refuses what would pass a
// limit or take a name the profile uses; a session's dispatch never refuses its task for it: the
// profile's own items come first, and a library item that no longer fits (an own skill added
// since, of its name) is left out and named in the log by its ID. So is a server whose current
// version asks for a sign-in ostra doesn't do (Q321), which can't be attached, and one whose
// version doesn't read. Reads only; nothing here is logged.

/** A library skill as a task gets it: its current version's files, each a blob of the organization with its digest. */
export type LibrarySkillDelivery = {
  readonly itemId: LibraryItemId;
  readonly versionId: LibraryItemVersionId;
  readonly name: string;
  readonly files: readonly LibraryVersionFile[];
};

/** A library server as a task gets it: an HTTP server behind the sidecar's MCP proxy, its address and headers from its version. */
export type LibraryServerDelivery = {
  readonly itemId: LibraryItemId;
  readonly versionId: LibraryItemVersionId;
  readonly name: string;
  readonly readOnly: boolean;
  readonly entry: StoredServerEntry;
  readonly inputs: StoredServerInputs;
};

/** Why a library item on a profile doesn't reach its tasks. */
export type LeftOutReason = ProfileItemsRefusal["code"] | "needs-oauth" | "unreadable";

export type ProfileLibrary = {
  readonly skills: readonly LibrarySkillDelivery[];
  readonly servers: readonly LibraryServerDelivery[];
  readonly leftOut: readonly { readonly itemId: LibraryItemId; readonly reason: LeftOutReason }[];
};

type Pinned = { readonly kind: "skill"; readonly delivery: LibrarySkillDelivery } | { readonly kind: "server"; readonly delivery: LibraryServerDelivery } | { readonly kind: "unreadable" } | { readonly kind: "needs-oauth" };

type ItemRow = {
  readonly id: string;
  readonly kind: "skill" | "mcp_server";
  readonly name: string;
  readonly readOnly: boolean;
  readonly everyProfile: boolean;
  readonly profiles: readonly { readonly attachedAt: Date }[];
  readonly currentVersion: {
    readonly id: string;
    readonly files: unknown;
    readonly serverEntry: unknown;
    readonly serverInputs: unknown;
    readonly needsOAuth: boolean;
  } | null;
};

/** A profile's own skills' and servers' names, as the list counts them: a servers column that doesn't parse counts the names it can read. */
const ownItemsOf = async (db: Db | Tx, organizationId: OrganizationId, profileId: AgentProfileId): Promise<ProfileOwnItems | null> => {
  const profile = await db.agentProfile.findFirst({
    where: { id: profileId, organizationId },
    select: { name: true, mcpServers: true, skills: { select: { name: true }, orderBy: { name: "asc" } } },
  });
  if (profile === null) {
    return null;
  }
  const parsed = storedMcpServersSchema.safeParse(profile.mcpServers);
  const servers = parsed.success
    ? parsed.data.map((server) => ({ name: server.name }))
    : (Array.isArray(profile.mcpServers) ? profile.mcpServers : []).flatMap((server: unknown) =>
        typeof server === "object" && server !== null && "name" in server && typeof server.name === "string" ? [{ name: server.name }] : [],
      );
  return { name: profile.name, skills: profile.skills.map((skill) => ({ name: skill.name })), servers };
};

/** The library items on a profile: attached ones in the order they were attached, then the every-profile ones by name. */
const libraryRowsOf = async (db: Db | Tx, organizationId: OrganizationId, profileId: AgentProfileId): Promise<{ readonly attached: readonly ItemRow[]; readonly everyProfile: readonly ItemRow[] }> => {
  const rows: ItemRow[] = await db.libraryItem.findMany({
    where: { organizationId, removedAt: null, OR: [{ everyProfile: true }, { profiles: { some: { profileId } } }] },
    select: {
      id: true,
      kind: true,
      name: true,
      readOnly: true,
      everyProfile: true,
      profiles: { where: { profileId }, select: { attachedAt: true } },
      currentVersion: { select: { id: true, files: true, serverEntry: true, serverInputs: true, needsOAuth: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const attachedAt = (row: ItemRow): number => row.profiles[0]?.attachedAt.getTime() ?? 0;
  return {
    attached: rows.filter((row) => row.profiles.length > 0).sort((a, b) => attachedAt(a) - attachedAt(b)),
    everyProfile: rows.filter((row) => row.profiles.length === 0 && row.everyProfile),
  };
};

const pinnedOf = (row: ItemRow): Pinned => {
  const version = row.currentVersion;
  const name = agentItemNameSchema.safeParse(row.name);
  if (version === null || !name.success) {
    return { kind: "unreadable" };
  }
  const itemId = libraryItemIdSchema.parse(row.id);
  const versionId = libraryItemVersionIdSchema.parse(version.id);
  switch (row.kind) {
    case "skill": {
      const files = libraryVersionFilesSchema.safeParse(version.files);
      return files.success && files.data.some((file) => file.path === "SKILL.md") ? { kind: "skill", delivery: { itemId, versionId, name: name.data, files: files.data } } : { kind: "unreadable" };
    }
    case "mcp_server": {
      if (version.needsOAuth) {
        return { kind: "needs-oauth" };
      }
      const entry = storedServerEntrySchema.safeParse(version.serverEntry);
      const inputs = storedServerInputsSchema.safeParse(version.serverInputs);
      return entry.success && inputs.success ? { kind: "server", delivery: { itemId, versionId, name: name.data, readOnly: row.readOnly, entry: entry.data, inputs: inputs.data } } : { kind: "unreadable" };
    }
    default:
      return row.kind satisfies never;
  }
};

const asListItem = <T,>(row: ItemRow, pinned: T): ProfileLibraryItem<T> => ({ itemId: row.id, kind: row.kind, name: row.name, pinned });

/**
 * What a profile's tasks get from the library now, at each item's current version. Never refuses:
 * an item that doesn't fit, asks for a sign-in or doesn't read is left out and named.
 */
export const profileLibraryOf = async (db: Db | Tx, input: { readonly organizationId: OrganizationId; readonly profileId: AgentProfileId }): Promise<ProfileLibrary> => {
  const own = await ownItemsOf(db, input.organizationId, input.profileId);
  if (own === null) {
    return { skills: [], servers: [], leftOut: [] };
  }
  const rows = await libraryRowsOf(db, input.organizationId, input.profileId);
  const leftOut: { itemId: LibraryItemId; reason: LeftOutReason }[] = [];
  const usable = (list: readonly ItemRow[]): ProfileLibraryItem<Pinned>[] =>
    list.flatMap((row) => {
      const pinned = pinnedOf(row);
      if (pinned.kind === "unreadable" || pinned.kind === "needs-oauth") {
        leftOut.push({ itemId: libraryItemIdSchema.parse(row.id), reason: pinned.kind });
        return [];
      }
      return [asListItem(row, pinned)];
    });
  let attached = usable(rows.attached);
  let everyProfile = usable(rows.everyProfile);
  // The profile's own come first: an item that no longer fits is left out, and the rest tried again.
  for (;;) {
    const list = profileItems(own, attached, everyProfile);
    if (list.ok) {
      const pinned = [...list.skills, ...list.servers].flatMap((item) => (item.source === "own" ? [] : [item.pinned]));
      return {
        skills: pinned.flatMap((item) => (item.kind === "skill" ? [item.delivery] : [])),
        servers: pinned.flatMap((item) => (item.kind === "server" ? [item.delivery] : [])),
        leftOut,
      };
    }
    const refused = list.refusal.itemId;
    leftOut.push({ itemId: libraryItemIdSchema.parse(refused), reason: list.refusal.code });
    attached = attached.filter((item) => item.itemId !== refused);
    everyProfile = everyProfile.filter((item) => item.itemId !== refused);
  }
};

/** A library item as an attach or a switch to every profile adds it to a profile's list. */
export type ListedItem = { readonly itemId: LibraryItemId; readonly kind: "skill" | "mcp_server"; readonly name: string };

/**
 * Whether a profile's list holds with `adding` on it (attached, or on every profile): `null` when it
 * does, else the refusal `profileItems` gives, naming the profile. Every item on the profile counts
 * toward the limits, one that its tasks leave out included, so they hold for what an admin sees; a
 * name clash is `adding`'s own, since another item's (an own skill added since) is left out anyway.
 */
export const profileListRefusal = async (
  db: Db | Tx,
  input: { readonly organizationId: OrganizationId; readonly profileId: AgentProfileId; readonly adding: ListedItem; readonly as: "attached" | "every_profile" },
): Promise<ProfileItemsRefusal | null> => {
  const own = await ownItemsOf(db, input.organizationId, input.profileId);
  if (own === null) {
    return null;
  }
  const rows = await libraryRowsOf(db, input.organizationId, input.profileId);
  const adding = { itemId: input.adding.itemId, kind: input.adding.kind, name: input.adding.name, pinned: null };
  const others = (list: readonly ItemRow[]) => list.filter((row) => row.id !== input.adding.itemId).map((row) => asListItem(row, null));
  let attached = [...others(rows.attached), ...(input.as === "attached" ? [adding] : [])];
  let everyProfile = [...others(rows.everyProfile), ...(input.as === "every_profile" ? [adding] : [])];
  for (;;) {
    const list = profileItems(own, attached, everyProfile);
    if (list.ok) {
      return null;
    }
    const refused = list.refusal.itemId;
    if (list.refusal.code !== "name-taken" || refused === input.adding.itemId) {
      return list.refusal;
    }
    attached = attached.filter((item) => item.itemId !== refused);
    everyProfile = everyProfile.filter((item) => item.itemId !== refused);
  }
};
