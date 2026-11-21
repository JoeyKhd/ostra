import { Prisma } from "@ostra/db";
import type { Db, Tx } from "@ostra/db";
import { librarySourceIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { LibrarySourceId, MemberId, OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { AuditLog, ChangeNotices } from "../ports.ts";
import type { AddSource, RemoveSource, SeedSources } from "../use-cases/m8-library-signatures.ts";
import { allowed, allowlistEntryFromRow, SEEDED_REGISTRY_SOURCE } from "./allowed.ts";
import type { AllowlistEntry, AllowlistSubject } from "./allowed.ts";
import { GITHUB_OWNER, GITHUB_REPO, librarySourceSchema, registryUrlOf } from "./reference.ts";
import type { LibrarySource } from "./reference.ts";

// F-145 (ADR 0069, Q322, Q324, ticket 27): the organization's allowlist of sources, an organization
// admin's to edit. An entry is a GitHub owner or repo, a well-known host, or a registry's address,
// narrowed or not to a namespace. Each add and removal is one transaction with its audit entry and
// change notice. A source taken off the list leaves its items installed, marked (an item whose
// source no list entry allows), and their updates refused (ticket 28). GitHub's curated registry is
// on every organization's list from the start, once: `library.seed-sources` adds it to a list
// nobody has touched, so a source an admin removed never comes back.

const refuse = <E extends string>(error: E, message: string): { readonly ok: false; readonly error: E; readonly message: string } => ({ ok: false, error, message });

const hostOf = (value: string): string | null => {
  const host = value.toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) && URL.canParse(`https://${host}`) && new URL(`https://${host}`).hostname === host ? host : null;
};

/** A registry's namespace as an entry writes it: `io.github.example`, or `io.github.example/*`. */
const NAMESPACE = /^[A-Za-z0-9.-]{1,200}$/;

/** An entry an admin typed, checked and normalized: a host lowercase, a registry's address as `registryUrlOf` writes it. */
export const allowlistEntrySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("github_owner"), value: z.string().regex(GITHUB_OWNER) }),
    z.strictObject({
      kind: z.literal("github_repo"),
      value: z.string().refine((value) => {
        const [owner = "", repo = "", ...rest] = value.split("/");
        return rest.length === 0 && GITHUB_OWNER.test(owner) && GITHUB_REPO.test(repo) && repo !== "." && repo !== "..";
      }, "owner/repo"),
    }),
    z.strictObject({ kind: z.literal("well_known_host"), value: z.string().refine((value) => hostOf(value) !== null, "a host, such as skills.example.com") }),
    z.strictObject({
      kind: z.literal("registry"),
      value: z.string().refine((value) => registryUrlOf(value) !== null, "a registry's https address"),
      namespace: z
        .string()
        .transform((value) => value.replace(/\/\*?$/, ""))
        .pipe(z.string().regex(NAMESPACE))
        .nullable(),
    }),
  ])
  .transform((entry): AllowlistEntry => {
    switch (entry.kind) {
      case "github_owner":
      case "github_repo":
        return entry;
      case "well_known_host":
        return { kind: entry.kind, value: hostOf(entry.value) ?? entry.value };
      case "registry":
        return { kind: entry.kind, value: registryUrlOf(entry.value) ?? entry.value, namespace: entry.namespace };
      default:
        return entry satisfies never;
    }
  });

/** The list as the matcher takes it, each entry with its row's ID, in the order they were added. */
export const allowlistOf = async (db: Db | Tx, organizationId: OrganizationId): Promise<(AllowlistEntry & { readonly id: LibrarySourceId })[]> => {
  const rows = await db.librarySource.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, value: true, namespace: true } });
  return rows.map((row) => ({ ...allowlistEntryFromRow(row), id: librarySourceIdSchema.parse(row.id) }));
};

/** What an installed item's source is matched as. */
export const subjectOfSource = (source: LibrarySource): AllowlistSubject => {
  switch (source.kind) {
    case "github":
      return { kind: "github", owner: source.owner, repo: source.repo };
    case "well_known":
      return { kind: "well_known", url: source.url };
    case "registry":
      return { kind: "registry", registryUrl: source.registryUrl, name: source.name };
    default:
      return source satisfies never;
  }
};

/** The same entry already on the list: GitHub's names without case, as GitHub matches them. */
const existingEntry = (tx: Tx, organizationId: OrganizationId, entry: AllowlistEntry) =>
  tx.librarySource.findFirst({
    where: {
      organizationId,
      kind: entry.kind,
      value: entry.kind === "github_owner" || entry.kind === "github_repo" ? { equals: entry.value, mode: "insensitive" } : entry.value,
      namespace: entry.kind === "registry" ? entry.namespace : null,
    },
    select: { id: true },
  });

const isUniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Puts an entry on the list in the caller's transaction, with its audit entry: by a member (an add,
 * or an install's "add this source"), or by the system (the seed). `null` when it's already there.
 */
export const addSourceInTx = async (
  deps: { readonly audit: AuditLog; readonly notices: ChangeNotices },
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly entry: AllowlistEntry; readonly by: MemberId | null; readonly via: "list" | "install" | "seed" },
): Promise<LibrarySourceId | null> => {
  if ((await existingEntry(tx, input.organizationId, input.entry)) !== null) {
    return null;
  }
  const namespace = input.entry.kind === "registry" ? input.entry.namespace : null;
  const row = await tx.librarySource.create({
    data: { organizationId: input.organizationId, kind: input.entry.kind, value: input.entry.value, namespace, addedByMemberId: input.by },
    select: { id: true },
  });
  const sourceId = librarySourceIdSchema.parse(row.id);
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: input.by === null ? { kind: "system", id: null } : { kind: "member", id: input.by },
    action: "library.source_added",
    entity: "library-source",
    entityId: sourceId,
    data: { kind: input.entry.kind, value: input.entry.value, namespace, via: input.via },
  });
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "organization", entityId: input.organizationId });
  return sourceId;
};

/** An organization admin adds a source. One already on the list is `conflict`. */
export const addSource: AddSource = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin edits the library's sources");
  }
  const entry = allowlistEntrySchema.safeParse(input.entry);
  if (!entry.success) {
    return refuse("invalid-input", "That isn't a GitHub owner, a GitHub repo, a host or a registry's https address");
  }
  try {
    const sourceId = await deps.db.$transaction((tx) => addSourceInTx(deps, tx, { organizationId, entry: entry.data, by: scope.memberId, via: "list" }));
    if (sourceId === null) {
      return refuse("conflict", "That source is on the list already");
    }
    deps.logger.info("library.source.added", { organizationId, sourceId, kind: entry.data.kind });
    return { ok: true, sourceId };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return refuse("conflict", "That source is on the list already");
    }
    throw error;
  }
};

/** An organization admin takes a source off: its items stay, marked, and their updates are refused. */
export const removeSource: RemoveSource = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return refuse("forbidden", "Only an organization admin edits the library's sources");
  }
  const removed = await deps.db.$transaction(async (tx) => {
    const row = await tx.librarySource.findFirst({ where: { id: input.sourceId, organizationId }, select: { id: true, kind: true, value: true, namespace: true } });
    if (row === null) {
      return null;
    }
    const before = await allowlistOf(tx, organizationId);
    const after = before.filter((entry) => entry.id !== row.id);
    const items = await tx.libraryItem.findMany({ where: { organizationId, removedAt: null }, select: { source: true } });
    let itemsMarked = 0;
    for (const item of items) {
      const source = librarySourceSchema.safeParse(item.source);
      if (source.success) {
        const subject = subjectOfSource(source.data);
        if (allowed(subject, before).allowed && !allowed(subject, after).allowed) itemsMarked += 1;
      }
    }
    await tx.librarySource.delete({ where: { id: row.id } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "library.source_removed",
      entity: "library-source",
      entityId: input.sourceId,
      data: { kind: row.kind, value: row.value, namespace: row.namespace, itemsMarked },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return { itemsMarked };
  });
  if (removed === null) {
    return refuse("not-found", "No such source on the list");
  }
  deps.logger.info("library.source.removed", { organizationId, sourceId: input.sourceId, itemsMarked: removed.itemsMarked });
  return { ok: true, itemsMarked: removed.itemsMarked };
};

// ---------- the seed: GitHub's curated registry, once (Q324) ----------

/** Whether nobody, the seed included, ever touched the organization's list: no source, and no audit entry of an edit. */
const untouchedList = (): Prisma.OrganizationWhereInput => ({
  librarySources: { none: {} },
  auditEntries: { none: { action: { in: ["library.source_added", "library.source_removed"] } } },
});

/**
 * GitHub's curated MCP registry on the list of an organization whose list nobody touched, in the
 * caller's transaction: when an organization is made, and by `library.seed-sources` for one that
 * existed before milestone 8. Once: a list with any source or any edit is left alone.
 */
export const seedLibrarySourcesInTx = async (deps: { readonly audit: AuditLog; readonly notices: ChangeNotices }, tx: Tx, organizationId: OrganizationId): Promise<boolean> => {
  const untouched = await tx.organization.findFirst({ where: { id: organizationId, ...untouchedList() }, select: { id: true } });
  if (untouched === null) {
    return false;
  }
  return (await addSourceInTx(deps, tx, { organizationId, entry: SEEDED_REGISTRY_SOURCE, by: null, via: "seed" })) !== null;
};

/** `library.seed-sources` (Q324): the seed, for one organization. */
export const seedSources: SeedSources = async (deps, input) => {
  const added = await deps.db.$transaction((tx) => seedLibrarySourcesInTx(deps, tx, input.organizationId));
  if (added) {
    deps.logger.info("library.sources.seeded", { organizationId: input.organizationId });
  }
  return { added };
};

/** The organizations whose list was never seeded nor edited: `library.seed-sources` once for each, at core's start. */
export const organizationsToSeed = async (db: Db, take = 1000): Promise<OrganizationId[]> => {
  const rows = await db.organization.findMany({ where: untouchedList(), select: { id: true }, orderBy: { createdAt: "asc" }, take });
  return rows.map((row) => organizationIdSchema.parse(row.id));
};
