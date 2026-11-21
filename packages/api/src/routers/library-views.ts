import { isUtf8 } from "node:buffer";

import {
  allowed,
  allowlistOf,
  librarySourceSchema,
  libraryVersionFilesSchema,
  profileItemLimits,
  profileItems,
  profileLibraryOf,
  profilesForMember,
  storedServerEntrySchema,
  storedServerInputsSchema,
  storedToolNamesSchema,
  storedVersionDiffSchema,
  subjectOfSource,
} from "@ostra/domain";
import type { LeftOutReason, LibrarySource, MemberScope, ServerUpdateTest, StoredVersionDiff } from "@ostra/domain";
import type { Db, Prisma } from "@ostra/db";
import { agentProfileIdSchema, libraryItemIdSchema, libraryItemVersionIdSchema, memberIdSchema } from "@ostra/protocol";
import type { AgentProfileId, LibraryItemId, LibraryItemVersionId, MemberId, OrganizationId } from "@ostra/protocol";
import { z } from "zod";

// The library as the panel shows it (milestone 8, ticket 30; F-145, ADR 0069): each item with its
// source and whether the organization's list still allows it, its pin (the commit and the
// `skills` CLI's hash, or the registry's version), a skill's files by name and size, a server's
// remote and the inputs it asks for, the profiles it's on, and an update waiting. Any member reads
// it, so members see what's installed and can suggest. Nothing here returns a secret: a server's
// inputs say whether each one is set and whether it's a secret, never a value, a plain one
// included, nor a secret's reference. A file's text and an update's diff are an organization
// admin's (`diff`), and they're the source's text, shown as data.

/** A version's pin: what tasks get, or what an update would give. */
export type PinView = {
  readonly versionId: LibraryItemVersionId;
  readonly number: number;
  /** The ref the reference asked for (`#ref`); `null`: the default branch. */
  readonly ref: string | null;
  readonly commitSha: string | null;
  /** The `skills` CLI's `computedHash`, for a skill. */
  readonly computedHash: string | null;
  /** The registry's version, for a server. */
  readonly registryVersion: string | null;
  readonly fetchedAt: number;
};

/** An input a library server's remote asks for: never its value. */
export type ServerInputView = {
  readonly kind: "variable" | "header";
  readonly name: string;
  readonly secret: boolean;
  readonly required: boolean;
  /** A value is kept for it (in the secret store, for a secret one). */
  readonly set: boolean;
};

/** Why an update can't be accepted yet: its source is off the list, its server asks for a sign-in, or it asks for an input the item lacks. */
export type UpdateRefusal = "not-allowed" | "needs-oauth" | "needs-input";

export type UpdateView = {
  readonly versionId: LibraryItemVersionId;
  readonly number: number;
  readonly fetchedAt: number;
  readonly commitSha: string | null;
  readonly registryVersion: string | null;
  /** `null`: an admin can accept it. */
  readonly refusal: UpdateRefusal | null;
  /** A skill's files added, removed and changed, by path. */
  readonly files: readonly { readonly path: string; readonly change: "added" | "removed" | "changed" }[];
  /** A server update's fresh test call: its tools listed, a sign-in asked for, no answer, or not made for a missing input. */
  readonly test: ServerUpdateTest | null;
  /** The inputs a server's new version asks for that the item doesn't have, by name. */
  readonly missingInputs: readonly string[];
  /** The whole diff, with each changed text file's lines: an organization admin's only, else `null`. */
  readonly diff: StoredVersionDiff | null;
};

export type LibraryItemView = {
  readonly itemId: LibraryItemId;
  readonly kind: "skill" | "mcp_server";
  readonly name: string;
  /** Where it comes from; `unreadable` for a row this build can't read. */
  readonly source: LibrarySource | { readonly kind: "unreadable" };
  /** Whether a source on the organization's list allows it: an item whose source was taken off stays, marked, and its updates are refused. */
  readonly sourceAllowed: boolean;
  readonly everyProfile: boolean;
  readonly readOnly: boolean;
  readonly installedAt: number;
  readonly installedBy: { readonly memberId: MemberId; readonly name: string | null };
  /** The current version: what tasks get. */
  readonly pin: PinView | null;
  /** A skill's files at its pin: names and sizes, never content. */
  readonly files: readonly { readonly path: string; readonly size: number; readonly executable: boolean }[];
  /** A server's remote at its pin. */
  readonly server: {
    readonly transport: "streamable-http";
    /** The remote's URL template, `{name}` where a variable goes: never a value. */
    readonly remoteUrl: string;
    /** The registry's words, shown as data. */
    readonly description: string | null;
    readonly inputs: readonly ServerInputView[];
    /** Headers the entry fixes itself, by name. */
    readonly fixedHeaders: readonly string[];
    readonly toolNames: readonly string[];
    readonly needsOAuth: boolean;
  } | null;
  /** The profiles it's attached to that the viewer may see; `everyProfile` says it's on all of them. */
  readonly profiles: readonly { readonly profileId: AgentProfileId; readonly name: string; readonly attachedAt: number }[];
  /** The update waiting for an admin, if any. */
  readonly update: UpdateView | null;
};

const versionSelect = {
  id: true,
  number: true,
  ref: true,
  commitSha: true,
  computedHash: true,
  registryVersion: true,
  fetchedAt: true,
  files: true,
  serverEntry: true,
  serverInputs: true,
  toolNames: true,
  needsOAuth: true,
} as const satisfies Prisma.LibraryItemVersionSelect;

/** What a view reads of an item. */
export const libraryItemSelect = {
  id: true,
  kind: true,
  name: true,
  source: true,
  everyProfile: true,
  readOnly: true,
  installedAt: true,
  installedByMemberId: true,
  currentVersion: { select: versionSelect },
  versions: { where: { state: "available" }, orderBy: { number: "desc" }, take: 1, select: { id: true, number: true, fetchedAt: true, commitSha: true, registryVersion: true, needsOAuth: true, diff: true } },
  profiles: { orderBy: { attachedAt: "asc" }, select: { profileId: true, attachedAt: true } },
} as const satisfies Prisma.LibraryItemSelect;

export type LibraryItemRow = Prisma.LibraryItemGetPayload<{ select: typeof libraryItemSelect }>;

type VersionRow = NonNullable<LibraryItemRow["currentVersion"]>;

export const pinOf = (version: Pick<VersionRow, "id" | "number" | "ref" | "commitSha" | "computedHash" | "registryVersion" | "fetchedAt"> | null): PinView | null =>
  version === null
    ? null
    : {
        versionId: libraryItemVersionIdSchema.parse(version.id),
        number: version.number,
        ref: version.ref,
        commitSha: version.commitSha,
        computedHash: version.computedHash,
        registryVersion: version.registryVersion,
        fetchedAt: version.fetchedAt.getTime(),
      };

const filesOf = (version: VersionRow): LibraryItemView["files"] => {
  const files = libraryVersionFilesSchema.safeParse(version.files);
  return files.success ? files.data.map((file) => ({ path: file.path, size: file.size, executable: file.executable })) : [];
};

/** A server's remote as the library shows it: the inputs by name, each set or not, never a value nor a secret's reference. */
const serverOf = (version: VersionRow): LibraryItemView["server"] => {
  const entry = storedServerEntrySchema.safeParse(version.serverEntry);
  if (!entry.success) {
    return null;
  }
  const inputs = storedServerInputsSchema.safeParse(version.serverInputs);
  const given = inputs.success ? inputs.data : { variables: {}, headers: {} };
  const tools = storedToolNamesSchema.safeParse(version.toolNames);
  const viewOf =
    (kind: "variable" | "header", values: Readonly<Record<string, { readonly kind: "plain" | "secret" }>>) =>
    (spec: { readonly name: string; readonly isSecret: boolean; readonly isRequired: boolean }): ServerInputView => {
      const value = Object.hasOwn(values, spec.name) ? values[spec.name] : undefined;
      return { kind, name: spec.name, secret: spec.isSecret || value?.kind === "secret", required: spec.isRequired, set: value !== undefined };
    };
  return {
    transport: entry.data.transport,
    remoteUrl: entry.data.remoteUrl,
    description: entry.data.description,
    inputs: [...entry.data.variables.map(viewOf("variable", given.variables)), ...entry.data.headers.map(viewOf("header", given.headers))],
    fixedHeaders: Object.keys(entry.data.fixedHeaders),
    toolNames: tools.success ? tools.data : [],
    needsOAuth: version.needsOAuth,
  };
};

const updateOf = (row: LibraryItemRow, sourceAllowed: boolean, withDiff: boolean): UpdateView | null => {
  const [version] = row.versions;
  if (version === undefined) {
    return null;
  }
  const parsed = storedVersionDiffSchema.safeParse(version.diff);
  const diff = parsed.success ? parsed.data : null;
  const missingInputs = diff?.kind === "server" ? diff.missingInputs : [];
  const refusal: UpdateRefusal | null = !sourceAllowed ? "not-allowed" : row.kind === "mcp_server" && version.needsOAuth ? "needs-oauth" : missingInputs.length > 0 ? "needs-input" : null;
  return {
    versionId: libraryItemVersionIdSchema.parse(version.id),
    number: version.number,
    fetchedAt: version.fetchedAt.getTime(),
    commitSha: version.commitSha,
    registryVersion: version.registryVersion,
    refusal,
    files: diff?.kind === "skill" ? diff.diff.files.map((file) => ({ path: file.path, change: file.change })) : [],
    test: diff?.kind === "server" ? diff.test : null,
    missingInputs,
    diff: withDiff ? diff : null,
  };
};

/**
 * The items as a member sees them: the profiles each is on limited to those the member may see
 * (an organization admin sees all), and an update's diff only when `withDiff` (an admin's).
 */
export const libraryItemViews = async (db: Db, scope: MemberScope, rows: readonly LibraryItemRow[], options: { readonly withDiff: boolean }): Promise<LibraryItemView[]> => {
  const organizationId = scope.organizationId;
  const [sources, visible, installers] = await Promise.all([
    allowlistOf(db, organizationId),
    profilesForMember(db, scope, { projectId: null }),
    db.member.findMany({ where: { organizationId, id: { in: [...new Set(rows.map((row) => row.installedByMemberId))] } }, select: { id: true, user: { select: { name: true } } } }),
  ]);
  const profileNames = new Map<string, string>(visible.map((profile) => [profile.profileId, profile.name]));
  const installerNames = new Map(installers.map((member) => [member.id, member.user.name] as const));
  return rows.map((row) => {
    const source = librarySourceSchema.safeParse(row.source);
    const sourceAllowed = source.success && allowed(subjectOfSource(source.data), sources).allowed;
    const version = row.currentVersion;
    return {
      itemId: libraryItemIdSchema.parse(row.id),
      kind: row.kind,
      name: row.name,
      source: source.success ? source.data : { kind: "unreadable" as const },
      sourceAllowed,
      everyProfile: row.everyProfile,
      readOnly: row.readOnly,
      installedAt: row.installedAt.getTime(),
      installedBy: { memberId: memberIdSchema.parse(row.installedByMemberId), name: installerNames.get(row.installedByMemberId) ?? null },
      pin: pinOf(version),
      files: row.kind === "skill" && version !== null ? filesOf(version) : [],
      server: row.kind === "mcp_server" && version !== null ? serverOf(version) : null,
      profiles: row.profiles.flatMap((profile) => {
        const name = profileNames.get(profile.profileId);
        return name === undefined ? [] : [{ profileId: agentProfileIdSchema.parse(profile.profileId), name, attachedAt: profile.attachedAt.getTime() }];
      }),
      update: updateOf(row, sourceAllowed, options.withDiff),
    };
  });
};

// ---------- a profile's library items (the profile editor) ----------

const pinViewSchema = z.object({
  versionId: libraryItemVersionIdSchema,
  number: z.number().int(),
  ref: z.string().nullable(),
  commitSha: z.string().nullable(),
  computedHash: z.string().nullable(),
  registryVersion: z.string().nullable(),
  fetchedAt: z.number(),
}) satisfies z.ZodType<PinView>;

/** A library item on a profile, with its pin, and why its tasks leave it out, if they do. */
const profileLibraryEntrySchema = z.object({
  itemId: libraryItemIdSchema,
  kind: z.enum(["skill", "mcp_server"]),
  name: z.string(),
  readOnly: z.boolean(),
  pin: pinViewSchema.nullable(),
  /** `null`: its tasks get it. Else why a dispatch leaves it out (an own item of its name, a limit, a sign-in, a version that doesn't read). */
  leftOut: z.enum(["too-many-skills", "too-many-servers", "name-taken", "needs-oauth", "unreadable"]).nullable() satisfies z.ZodType<LeftOutReason | null>,
});
export type ProfileLibraryEntry = z.infer<typeof profileLibraryEntrySchema>;

/** `agentProfiles.get`'s `library`, as its output schema checks it. */
export const profileLibraryViewSchema = z.object({
  /** Attached to this profile, in the order they were attached. */
  attached: z.array(profileLibraryEntrySchema.extend({ attachedAt: z.number(), everyProfile: z.boolean() })),
  /** On every profile and not attached here: inherited. */
  inherited: z.array(profileLibraryEntrySchema),
});
export type ProfileLibraryView = z.infer<typeof profileLibraryViewSchema>;

/** The profile editor's library items: attached, and inherited from every profile, each at its pin. */
export const loadProfileLibrary = async (db: Db, organizationId: OrganizationId, profileId: AgentProfileId): Promise<ProfileLibraryView> => {
  const [rows, reaching] = await Promise.all([
    db.libraryItem.findMany({
      where: { organizationId, removedAt: null, OR: [{ everyProfile: true }, { profiles: { some: { profileId } } }] },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        name: true,
        readOnly: true,
        everyProfile: true,
        profiles: { where: { profileId }, select: { attachedAt: true } },
        currentVersion: { select: { id: true, number: true, ref: true, commitSha: true, computedHash: true, registryVersion: true, fetchedAt: true } },
      },
    }),
    profileLibraryOf(db, { organizationId, profileId }),
  ]);
  const leftOut = new Map<string, LeftOutReason>(reaching.leftOut.map((entry) => [entry.itemId, entry.reason]));
  const entryOf = (row: (typeof rows)[number]): ProfileLibraryEntry => ({
    itemId: libraryItemIdSchema.parse(row.id),
    kind: row.kind,
    name: row.name,
    readOnly: row.readOnly,
    pin: pinOf(row.currentVersion),
    leftOut: leftOut.get(row.id) ?? null,
  });
  const attached = rows.flatMap((row) => {
    const [link] = row.profiles;
    return link === undefined ? [] : [{ ...entryOf(row), attachedAt: link.attachedAt.getTime(), everyProfile: row.everyProfile }];
  });
  return {
    attached: attached.sort((a, b) => a.attachedAt - b.attachedAt),
    inherited: rows.filter((row) => row.profiles.length === 0 && row.everyProfile).map(entryOf),
  };
};

/**
 * Whether a profile's own skills and servers, as an editor's save would leave them, still hold
 * beside its library items (ticket 28's hand-off): no own item named like a library item attached
 * to it or on every profile, and all of them together within 50 skills and 20 servers. `null` when
 * they do; else the refusal, naming the library item. A new profile (`profileId: null`) has only
 * the every-profile items. A dispatch would otherwise leave the library item out unseen.
 */
export const profileSaveLibraryRefusal = async (
  db: Db,
  organizationId: OrganizationId,
  profileId: AgentProfileId | null,
  profile: { readonly name: string; readonly skills: readonly { readonly name: string }[]; readonly servers: readonly { readonly name: string }[] },
): Promise<{ readonly code: "CONFLICT" | "PRECONDITION_FAILED"; readonly message: string } | null> => {
  const rows = await db.libraryItem.findMany({
    where: { organizationId, removedAt: null, OR: [{ everyProfile: true }, ...(profileId === null ? [] : [{ profiles: { some: { profileId } } }])] },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, name: true, everyProfile: true, profiles: { where: profileId === null ? {} : { profileId }, select: { profileId: true, attachedAt: true } } },
  });
  const linkHere = (row: (typeof rows)[number]) => (profileId === null ? undefined : row.profiles.find((link) => link.profileId === profileId));
  const attachedHere = (row: (typeof rows)[number]): boolean => linkHere(row) !== undefined;
  const listed = (row: (typeof rows)[number]) => ({ itemId: row.id, kind: row.kind, name: row.name, pinned: null });
  const attachedAt = (row: (typeof rows)[number]): number => linkHere(row)?.attachedAt.getTime() ?? 0;
  const list = profileItems(
    { name: profile.name, skills: profile.skills, servers: profile.servers },
    rows
      .filter(attachedHere)
      .sort((a, b) => attachedAt(a) - attachedAt(b))
      .map(listed),
    rows.filter((row) => !attachedHere(row) && row.everyProfile).map(listed),
  );
  if (list.ok) {
    return null;
  }
  const refused = rows.find((row) => row.id === list.refusal.itemId);
  const noun = refused?.kind === "mcp_server" ? "MCP server" : "skill";
  const here = refused !== undefined && attachedHere(refused);
  const name = refused?.name ?? "";
  switch (list.refusal.code) {
    case "name-taken":
      return {
        code: "CONFLICT",
        message: here
          ? `The library's ${noun} ${name} is attached to this profile: give the profile's own ${noun} another name, or detach the library's first`
          : `The library's ${noun} ${name} is on every profile: give the profile's own ${noun} another name, or take the library's off every profile first`,
      };
    case "too-many-skills":
      return { code: "PRECONDITION_FAILED", message: `With the library's skills on it, the profile would have more than ${String(profileItemLimits.skillsMax)} skills, the most a profile hands a task` };
    case "too-many-servers":
      return { code: "PRECONDITION_FAILED", message: `With the library's MCP servers on it, the profile would have more than ${String(profileItemLimits.serversMax)} MCP servers, the most a profile hands a task` };
    default:
      return list.refusal.code satisfies never;
  }
};

// ---------- a file's text ----------

/** The most of a file's text a call returns *(working value)*: a skill's file is at most 1 MiB. */
export const LIBRARY_FILE_TEXT_MAX_BYTES = 256 * 1024;

export type LibraryFileText = {
  readonly path: string;
  readonly size: number;
  /** Not text (a NUL byte, or not UTF-8): no `text`. */
  readonly binary: boolean;
  /** The file's text, up to the cap: data, never a page. */
  readonly text: string | null;
  readonly truncated: boolean;
};

/** A file's bytes as text with a cap, for the update's diff and the install's look. */
export const fileTextOf = (path: string, bytes: Uint8Array): LibraryFileText => {
  if (bytes.includes(0) || !isUtf8(bytes)) {
    return { path, size: bytes.length, binary: true, text: null, truncated: false };
  }
  const truncated = bytes.length > LIBRARY_FILE_TEXT_MAX_BYTES;
  return { path, size: bytes.length, binary: false, text: new TextDecoder().decode(truncated ? bytes.subarray(0, LIBRARY_FILE_TEXT_MAX_BYTES) : bytes), truncated };
};
