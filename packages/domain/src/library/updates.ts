import type { DbEnum, Tx } from "@ostra/db";
import { libraryItemIdSchema, libraryItemVersionIdSchema } from "@ostra/protocol";
import type { GitSha, LibraryItemId, LibraryItemVersionId, OrganizationId } from "@ostra/protocol";

import { requireOrganizationAdmin } from "../access.ts";
import { libraryVersionFromRow, transitionLibraryVersion } from "../lifecycles/m8-library.ts";
import type { AcceptUpdate, CheckUpdates, DismissUpdate, LibraryCheckDeps, LibraryDeps, RequestUpdateCheck, UpdateFound } from "../use-cases/m8-library-signatures.ts";
import { allowed } from "./allowed.ts";
import { serverDiff, skillDiff } from "./diffs.ts";
import type { ServerDiff, SkillDiff } from "./diffs.ts";
import type { SkillFile } from "./hash.ts";
import { readGitHubSkill, resolveGitHubCommit, sha256Hex } from "./github-source.ts";
import type { GitHubSourceDeps, SkillRead } from "./github-source.ts";
import { LIBRARY_SECRET_PURPOSE, testCallOf } from "./install.ts";
import type { OutboundDeps } from "./outbound.ts";
import { librarySourceSchema } from "./reference.ts";
import type { LibrarySource } from "./reference.ts";
import { readRegistryServer, serverOfferOf } from "./registry-source.ts";
import { allowlistOf, subjectOfSource } from "./sources.ts";
import {
  libraryVersionFilesSchema,
  serverSnapshotOf,
  storedServerEntrySchema,
  storedServerInputsSchema,
  storedToolNamesSchema,
  storedVersionDiffSchema,
} from "./stored.ts";
import type { LibraryVersionFile, ServerUpdateTest, StoredServerEntry, StoredServerInput, StoredServerInputSpec, StoredServerInputs } from "./stored.ts";
import { readWellKnownSkills } from "./well-known-source.ts";

// F-145 (ADR 0069, "Updates", Q323, ticket 28): an update waits for an admin, with its diff.
// - `checkUpdates` (`library.check-updates`, once each `OSTRA_LIBRARY_UPDATE_HOURS` per
//   organization, and per item on an admin's "Check for updates") reads each item again at its
//   source. A skill's ref is resolved again; when the commit moved and the content's hash changed,
//   its files are fetched into an `available` version with `skillDiff` against the current one. A
//   server's registry is asked for its latest version; when it differs, an `available` version
//   keeps its entry, the item's inputs carried over by name, `serverDiff` and a fresh test call's
//   tools. Content the check found before, waiting or dismissed, isn't found again, so a dismissed
//   update stays dismissed until a newer one; a newer one takes a waiting one's place. An update
//   whose source was taken off the allowlist is stored, and can't be accepted.
// - `acceptUpdate` makes it current and the old one `superseded`; `dismissUpdate` marks it
//   `dismissed`; each with its audit entry. Nothing moves by itself: the next dispatch of every
//   attached profile's tasks takes the current version, so a running task gets it at its next
//   session.
// Lines carry the organization, the item's ID, its kind and its source kind: never a file, a
// header's value, a secret or the source's text.

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const loggerOf = (deps: Pick<LibraryDeps, "logger">) => deps.logger.child({ component: "library" });
const githubDeps = (deps: LibraryDeps): GitHubSourceDeps => ({ db: deps.db, codeHost: deps.adapters.codeHost, secretStore: deps.adapters.secretStore });
const outbound = (deps: LibraryDeps): OutboundDeps => ({ fetch: deps.fetch, serverVersion: deps.serverVersion });

const versionSelect = { id: true, number: true, state: true, commitSha: true, computedHash: true, registryVersion: true } as const;

/** What the check found before: an update waiting, or one an admin dismissed. */
const FOUND_BEFORE: DbEnum.LibraryVersionState[] = ["available", "dismissed"];

const itemSelect = {
  id: true,
  kind: true,
  name: true,
  source: true,
  currentVersion: { select: { ...versionSelect, files: true, serverEntry: true, serverInputs: true, toolNames: true } },
  versions: { where: { state: { in: FOUND_BEFORE } }, select: versionSelect },
} as const;

type CheckedItem = {
  readonly id: string;
  readonly kind: "skill" | "mcp_server";
  readonly name: string;
  readonly source: unknown;
  readonly currentVersion: {
    readonly id: string;
    readonly number: number;
    readonly commitSha: string | null;
    readonly computedHash: string | null;
    readonly registryVersion: string | null;
    readonly files: unknown;
    readonly serverEntry: unknown;
    readonly serverInputs: unknown;
    readonly toolNames: unknown;
  } | null;
  readonly versions: readonly { readonly id: string; readonly number: number; readonly state: string; readonly commitSha: string | null; readonly computedHash: string | null; readonly registryVersion: string | null }[];
};

type Outcome = { readonly kind: "checked"; readonly update: UpdateFound } | { readonly kind: "failed"; readonly reason: string };

const none: Outcome = { kind: "checked", update: { kind: "none" } };
const failed = (reason: string): Outcome => ({ kind: "failed", reason });

/** What a new version adds beside its item, its number and its state. */
type NewVersion = {
  readonly ref?: string | null;
  readonly commitSha?: string | null;
  readonly computedHash?: string;
  readonly files?: readonly LibraryVersionFile[];
  readonly registryVersion?: string;
  readonly serverEntry?: StoredServerEntry;
  readonly serverInputs?: StoredServerInputs;
  readonly toolNames?: readonly string[];
  readonly needsOAuth?: boolean;
  /** Parsed by `storedVersionDiffSchema` on the way in. */
  readonly diff:
    | { readonly kind: "skill"; readonly diff: SkillDiff }
    | { readonly kind: "server"; readonly diff: ServerDiff; readonly test: ServerUpdateTest; readonly missingInputs: readonly string[] };
};

/**
 * Writes an `available` version, under the item's row lock: unless the item's current version
 * changed since the check began, or content the check found before (waiting or dismissed) came
 * back meanwhile. A waiting update gives way to it (→ superseded). `null` when nothing was written.
 */
const writeUpdate = async (
  deps: LibraryDeps,
  organizationId: OrganizationId,
  item: CheckedItem,
  same: (version: CheckedItem["versions"][number]) => boolean,
  version: NewVersion,
): Promise<LibraryItemVersionId | null> =>
  deps.db.$transaction(async (tx: Tx) => {
    await tx.$executeRaw`SELECT 1 FROM "library_item" WHERE "id" = ${item.id} FOR UPDATE`;
    const fresh = await tx.libraryItem.findFirst({
      where: { id: item.id, organizationId, removedAt: null },
      select: { currentVersionId: true, versions: { select: { ...versionSelect, fetchedAt: true, decidedByMemberId: true, decidedAt: true } } },
    });
    const current = fresh?.versions.find((row) => row.id === fresh.currentVersionId);
    if (fresh === null || current === undefined || current.id !== item.currentVersion?.id) {
      return null;
    }
    const above = fresh.versions.filter((row) => row.number > current.number && (row.state === "available" || row.state === "dismissed"));
    if (above.some(same)) {
      return null;
    }
    const at = deps.clock.now();
    for (const waiting of fresh.versions.filter((row) => row.state === "available")) {
      const moved = transitionLibraryVersion(libraryVersionFromRow(waiting), { type: "supersede", at });
      if (moved.ok) {
        await tx.libraryItemVersion.update({ where: { id: waiting.id }, data: { state: "superseded" } });
      }
    }
    const number = Math.max(...fresh.versions.map((row) => row.number)) + 1;
    const created = await tx.libraryItemVersion.create({
      data: {
        organizationId,
        itemId: item.id,
        number,
        state: "available",
        ref: version.ref ?? null,
        commitSha: version.commitSha ?? null,
        computedHash: version.computedHash ?? null,
        files: libraryVersionFilesSchema.parse(version.files ?? []),
        registryVersion: version.registryVersion ?? null,
        ...(version.serverEntry === undefined ? {} : { serverEntry: storedServerEntrySchema.parse(version.serverEntry) }),
        ...(version.serverInputs === undefined ? {} : { serverInputs: storedServerInputsSchema.parse(version.serverInputs) }),
        toolNames: storedToolNamesSchema.parse([...(version.toolNames ?? [])]),
        needsOAuth: version.needsOAuth ?? false,
        diff: storedVersionDiffSchema.parse(version.diff),
        fetchedAt: new Date(at),
      },
      select: { id: true },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return libraryItemVersionIdSchema.parse(created.id);
  });

/** The versions above the current one that are waiting or dismissed: what the check found before. */
const foundBefore = (item: CheckedItem): CheckedItem["versions"] => item.versions.filter((version) => version.number > (item.currentVersion?.number ?? 0));

/** A skill read again: its content compared, its files stored, its update written with the diff. */
const skillUpdate = async (
  deps: LibraryCheckDeps,
  organizationId: OrganizationId,
  item: CheckedItem,
  read: SkillRead,
  pin: { readonly ref: string | null; readonly commit: GitSha | null },
): Promise<Outcome> => {
  const current = item.currentVersion;
  if (current === null) {
    return failed("no-current-version");
  }
  if (!read.check.ok || read.check.name !== item.name) {
    // A version that wouldn't install isn't offered: the item stays where it is.
    return failed("skill-refused");
  }
  if (read.computedHash === current.computedHash || foundBefore(item).some((version) => version.computedHash === read.computedHash)) {
    return none;
  }
  const files = libraryVersionFilesSchema.safeParse(current.files);
  if (!files.success) {
    return failed("current-unreadable");
  }
  const before: SkillFile[] = [];
  for (const file of files.data) {
    const bytes = await deps.readBlob(organizationId, file.blobId);
    if (!bytes.ok) {
      return failed("current-unreadable");
    }
    before.push({ path: file.path, bytes: bytes.bytes });
  }
  const diff = skillDiff(before, read.files);
  const stored: LibraryVersionFile[] = [];
  for (const file of read.files) {
    const put = await deps.blobs.put(organizationId, file.bytes);
    if (!put.ok) {
      return failed("blob-failed");
    }
    stored.push({ path: file.path, blobId: put.blobId, size: file.bytes.length, sha256: sha256Hex(file.bytes), executable: file.executable });
  }
  const versionId = await writeUpdate(deps, organizationId, item, (version) => version.computedHash === read.computedHash, {
    ref: pin.ref,
    commitSha: pin.commit,
    computedHash: read.computedHash,
    files: stored,
    diff: { kind: "skill", diff },
  });
  return versionId === null ? none : { kind: "checked", update: { kind: "skill", versionId, commit: pin.commit, diff } };
};

/** The item's inputs carried over to a server's new version, by name (a header's without case); what it now asks for and lacks. */
const carriedInputs = async (
  deps: LibraryDeps,
  organizationId: OrganizationId,
  kept: StoredServerInputs,
  entry: StoredServerEntry,
  defaults: { readonly variables: Readonly<Record<string, string>>; readonly headers: Readonly<Record<string, string>> },
): Promise<{ readonly ok: true; readonly inputs: StoredServerInputs; readonly missing: readonly string[] } | { readonly ok: false }> => {
  const missing: string[] = [];
  const pick = async (specs: readonly StoredServerInputSpec[], from: Readonly<Record<string, StoredServerInput>>, fallback: Readonly<Record<string, string>>, header: boolean): Promise<Record<string, StoredServerInput> | null> => {
    const out: Record<string, StoredServerInput> = {};
    for (const spec of specs) {
      const name = Object.keys(from).find((candidate) => (header ? candidate.toLowerCase() === spec.name.toLowerCase() : candidate === spec.name));
      const value = name === undefined ? undefined : from[name];
      if (value !== undefined) {
        if (spec.isSecret && value.kind === "plain") {
          // The new version marks it secret: it goes to the secret store, as an install would put it.
          const ref = await deps.adapters.secretStore.put({ organizationId, purpose: LIBRARY_SECRET_PURPOSE }, value.value);
          if (!ref.ok) {
            return null;
          }
          out[spec.name] = { kind: "secret", ref: ref.value };
        } else {
          out[spec.name] = value;
        }
        continue;
      }
      const given = fallback[spec.name];
      if (given !== undefined) {
        out[spec.name] = { kind: "plain", value: given };
      } else if (spec.isRequired) {
        missing.push(spec.name);
      }
    }
    return out;
  };
  const variables = await pick(entry.variables, kept.variables, defaults.variables, false);
  const headers = variables === null ? null : await pick(entry.headers, kept.headers, defaults.headers, true);
  return variables === null || headers === null ? { ok: false } : { ok: true, inputs: { variables, headers }, missing };
};

/** A server read again at its registry's latest version: compared, its inputs carried over, tested, its update written with the diff. */
const serverUpdate = async (deps: LibraryCheckDeps, organizationId: OrganizationId, item: CheckedItem, source: Extract<LibrarySource, { readonly kind: "registry" }>): Promise<Outcome> => {
  const current = item.currentVersion;
  const currentEntry = storedServerEntrySchema.safeParse(current?.serverEntry);
  const currentInputs = storedServerInputsSchema.safeParse(current?.serverInputs);
  if (current === null || !currentEntry.success || !currentInputs.success) {
    return failed("current-unreadable");
  }
  const read = await readRegistryServer({ ...outbound(deps), db: deps.db }, organizationId, { name: source.name, registryUrl: source.registryUrl }, "latest");
  if (!read.ok) {
    return failed(read.error);
  }
  const version = read.entry.server.version;
  if (version === current.registryVersion || foundBefore(item).some((found) => found.registryVersion === version)) {
    return none;
  }
  const offer = serverOfferOf(read.entry);
  if (offer.entry === null || offer.refusal !== null) {
    // The latest version isn't one ostra installs (no streamable-HTTP remote, deprecated): not offered.
    return failed(offer.refusal ?? "no-remote");
  }
  const carried = await carriedInputs(deps, organizationId, currentInputs.data, offer.entry, offer.defaults);
  if (!carried.ok) {
    return failed("secret-failed");
  }
  const currentTools = storedToolNamesSchema.safeParse(current.toolNames);
  const toolsBefore = currentTools.success ? currentTools.data : [];
  let test: ServerUpdateTest = "needs-input";
  let toolNames: readonly string[] = [];
  if (carried.missing.length === 0) {
    const tested = await testCallOf(deps, organizationId, libraryItemIdSchema.parse(item.id), offer.entry, carried.inputs);
    test = !tested.ok ? "unavailable" : tested.needsOAuth ? "needs-oauth" : "listed";
    toolNames = tested.ok ? tested.toolNames : [];
  }
  // With no list from the test call, the tools aren't compared: the diff says so by its test.
  const diff = serverDiff(
    serverSnapshotOf({ registryVersion: current.registryVersion ?? "", entry: currentEntry.data, toolNames: toolsBefore }),
    serverSnapshotOf({ registryVersion: version, entry: offer.entry, toolNames: test === "listed" ? toolNames : toolsBefore }),
  );
  const versionId = await writeUpdate(deps, organizationId, item, (found) => found.registryVersion === version, {
    registryVersion: version,
    serverEntry: offer.entry,
    serverInputs: carried.inputs,
    toolNames,
    needsOAuth: test === "needs-oauth",
    diff: { kind: "server", diff, test, missingInputs: [...carried.missing] },
  });
  return versionId === null ? none : { kind: "checked", update: { kind: "server", versionId, registryVersion: version, diff } };
};

/** One item read again at its source. */
const checkItem = async (deps: LibraryCheckDeps, organizationId: OrganizationId, item: CheckedItem, source: LibrarySource): Promise<Outcome> => {
  const current = item.currentVersion;
  if (current === null) {
    return failed("no-current-version");
  }
  switch (source.kind) {
    case "github": {
      const at = await resolveGitHubCommit(githubDeps(deps), organizationId, source, source.ref ?? "HEAD");
      if (!at.ok) {
        return failed(at.error);
      }
      // The pin didn't move, or moved to a commit already found: nothing to read.
      if (at.commit === current.commitSha || foundBefore(item).some((version) => version.commitSha === at.commit)) {
        return none;
      }
      const read = await readGitHubSkill(githubDeps(deps), at, source.path);
      return read.ok ? skillUpdate(deps, organizationId, item, read.skill, { ref: source.ref, commit: at.commit }) : failed(read.error);
    }
    case "well_known": {
      const read = await readWellKnownSkills(outbound(deps), source.url, source.skill);
      if (!read.ok) {
        return failed(read.error);
      }
      const [skill] = read.skills;
      return skill === undefined ? failed("not-found") : skillUpdate(deps, organizationId, item, skill, { ref: null, commit: null });
    }
    case "registry":
      return item.kind === "mcp_server" ? serverUpdate(deps, organizationId, item, source) : failed("source-kind");
    default:
      return source satisfies never;
  }
};

/** `library.check-updates`: each installed item of the organization, or the one asked for, in turn. */
export const checkUpdates: CheckUpdates = async (deps, input) => {
  const logger = loggerOf(deps);
  const items: CheckedItem[] = await deps.db.libraryItem.findMany({
    where: { organizationId: input.organizationId, removedAt: null, currentVersionId: { not: null }, ...(input.itemId === null ? {} : { id: input.itemId }) },
    select: itemSelect,
    orderBy: [{ installedAt: "asc" }, { id: "asc" }],
  });
  const sources = await allowlistOf(deps.db, input.organizationId);
  const found: { itemId: LibraryItemId; update: UpdateFound }[] = [];
  let refused = 0;
  let failures = 0;
  for (const item of items) {
    const itemId = libraryItemIdSchema.parse(item.id);
    const source = librarySourceSchema.safeParse(item.source);
    const outcome = source.success ? await checkItem(deps, input.organizationId, item, source.data) : failed("source-unreadable");
    if (outcome.kind === "failed") {
      failures += 1;
      logger.info("library.update.check-failed", { organizationId: input.organizationId, itemId, kind: item.kind, sourceKind: source.success ? source.data.kind : null, reason: outcome.reason });
      continue;
    }
    found.push({ itemId, update: outcome.update });
    if (outcome.update.kind !== "none") {
      const sourceAllowed = source.success && allowed(subjectOfSource(source.data), sources).allowed;
      if (!sourceAllowed) {
        refused += 1;
      }
      logger.info("library.update.found", { organizationId: input.organizationId, itemId, versionId: outcome.update.versionId, kind: item.kind, sourceKind: source.success ? source.data.kind : null, sourceAllowed });
    }
  }
  logger.info("library.updates.checked", { organizationId: input.organizationId, checked: items.length, found: found.filter((entry) => entry.update.kind !== "none").length, refused, failed: failures });
  return { checked: items.length, found, refused, failed: failures };
};

/** An organization admin's "Check for updates" on one item: its check, queued by the item's key. */
export const requestUpdateCheck: RequestUpdateCheck = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin checks the library for updates");
  }
  const item = await deps.db.libraryItem.findFirst({ where: { id: input.itemId, organizationId, removedAt: null }, select: { id: true } });
  if (item === null) {
    return refuse("not-found", "No such item in the library");
  }
  await deps.db.$transaction((tx) => deps.jobs.enqueueInTx(tx, "library.check-updates", { organizationId, itemId: input.itemId }));
  return { ok: true, requested: true };
};

const updateSelect = {
  id: true,
  number: true,
  state: true,
  fetchedAt: true,
  decidedByMemberId: true,
  decidedAt: true,
  needsOAuth: true,
  diff: true,
  item: { select: { id: true, kind: true, name: true, source: true, currentVersion: { select: { id: true, number: true } } } },
} as const;

const NO_UPDATE = "No such update in the library";
const DECIDED = "This update was decided already, or a newer one took its place";

/** An organization admin accepts an update: it becomes the item's pin, and every attached profile's next session takes it. */
export const acceptUpdate: AcceptUpdate = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin accepts a library update");
  }
  const version = await deps.db.libraryItemVersion.findFirst({ where: { id: input.versionId, organizationId, item: { removedAt: null } }, select: updateSelect });
  if (version === null) {
    return refuse("not-found", NO_UPDATE);
  }
  const at = deps.clock.now();
  if (!transitionLibraryVersion(libraryVersionFromRow(version), { type: "accept", by: scope.memberId, at }).ok) {
    return refuse("not-allowed-in-state", DECIDED);
  }
  const source = librarySourceSchema.safeParse(version.item.source);
  if (!source.success) {
    return refuse("not-found", NO_UPDATE);
  }
  if (!allowed(subjectOfSource(source.data), await allowlistOf(deps.db, organizationId)).allowed) {
    return refuse("not-allowed", "The item's source is no longer on the organization's list of sources: add it back to accept its update");
  }
  if (version.item.kind === "mcp_server") {
    if (version.needsOAuth) {
      return refuse("needs-oauth", "This version of the server asks for an OAuth sign-in, which ostra doesn't do yet");
    }
    const diff = storedVersionDiffSchema.safeParse(version.diff);
    if (diff.success && diff.data.kind === "server" && diff.data.missingInputs.length > 0) {
      return refuse("needs-input", `This version of the server asks for ${diff.data.missingInputs.join(", ")}, which the item doesn't have: install it again to give ${diff.data.missingInputs.length === 1 ? "it" : "them"}`);
    }
  }
  const accepted = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "library_item" WHERE "id" = ${version.item.id} FOR UPDATE`;
    const fresh = await tx.libraryItemVersion.findFirst({ where: { id: version.id, organizationId, item: { removedAt: null } }, select: updateSelect });
    if (fresh?.state !== "available") {
      return null;
    }
    const previous = fresh.item.currentVersion;
    if (previous !== null) {
      await tx.libraryItemVersion.update({ where: { id: previous.id }, data: { state: "superseded" } });
    }
    await tx.libraryItemVersion.update({ where: { id: fresh.id }, data: { state: "current", decidedByMemberId: scope.memberId, decidedAt: new Date(at) } });
    await tx.libraryItem.update({ where: { id: fresh.item.id }, data: { currentVersionId: fresh.id } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "library.update_accepted",
      entity: "library-item",
      entityId: libraryItemIdSchema.parse(fresh.item.id),
      data: { kind: fresh.item.kind, name: fresh.item.name, from: previous?.number ?? null, to: fresh.number },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return { itemId: fresh.item.id, kind: fresh.item.kind };
  });
  if (accepted === null) {
    return refuse("not-allowed-in-state", DECIDED);
  }
  loggerOf(deps).info("library.update.accepted", { organizationId, itemId: accepted.itemId, versionId: input.versionId, kind: accepted.kind });
  return { ok: true, currentVersionId: input.versionId };
};

/** An organization admin dismisses an update: the item stays where it is, and the same content found again stays dismissed. */
export const dismissUpdate: DismissUpdate = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin dismisses a library update");
  }
  const at = deps.clock.now();
  const dismissed = await deps.db.$transaction(async (tx) => {
    const version = await tx.libraryItemVersion.findFirst({ where: { id: input.versionId, organizationId, item: { removedAt: null } }, select: updateSelect });
    if (version === null) {
      return "not-found" as const;
    }
    await tx.$executeRaw`SELECT 1 FROM "library_item" WHERE "id" = ${version.item.id} FOR UPDATE`;
    const fresh = await tx.libraryItemVersion.findFirst({ where: { id: version.id }, select: updateSelect });
    if (fresh === null || !transitionLibraryVersion(libraryVersionFromRow(fresh), { type: "dismiss", by: scope.memberId, at }).ok) {
      return "decided" as const;
    }
    await tx.libraryItemVersion.update({ where: { id: fresh.id }, data: { state: "dismissed", decidedByMemberId: scope.memberId, decidedAt: new Date(at) } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "library.update_dismissed",
      entity: "library-item",
      entityId: libraryItemIdSchema.parse(fresh.item.id),
      data: { kind: fresh.item.kind, name: fresh.item.name, version: fresh.number },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return { itemId: fresh.item.id, kind: fresh.item.kind };
  });
  if (dismissed === "not-found") {
    return refuse("not-found", NO_UPDATE);
  }
  if (dismissed === "decided") {
    return refuse("not-allowed-in-state", DECIDED);
  }
  loggerOf(deps).info("library.update.dismissed", { organizationId, itemId: dismissed.itemId, versionId: input.versionId, kind: dismissed.kind });
  return { ok: true, dismissedAt: at };
};
