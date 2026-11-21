import { createHash } from "node:crypto";

import {
  acceptUpdate,
  addSource,
  allowed,
  allowlistEntryFromRow,
  allowlistOf,
  attachItem,
  decideSuggestion,
  detachItem,
  dismissUpdate,
  INSTANCE_SEARCH_OFF_WORDS,
  installItem,
  libraryCounts,
  librarySourceSchema,
  libraryVersionFilesSchema,
  MARKETPLACE_WORDS_MAX,
  marketplaceSearchSendsWords,
  ORGANIZATION_SEARCH_OFF_WORDS,
  parseLibraryReference,
  readGitHubSkillForInstall,
  readMarketplaceSearch,
  readWellKnownSkills,
  referenceAllowed,
  removeItem,
  removeSource,
  requestUpdateCheck,
  resolveReference,
  searchMarketplace,
  setEveryProfile,
  setMarketplaceSearch,
  setReadOnly,
  subjectOfSource,
  suggestItem,
  SUGGESTION_NOTE_MAX,
  testServer,
} from "@ostra/domain";
import type { AttachError, MarketplaceSearchState, ResolveReferenceError, SkillRead } from "@ostra/domain";
import {
  agentProfileIdSchema,
  gitShaSchema,
  libraryItemIdSchema,
  libraryItemVersionIdSchema,
  librarySourceIdSchema,
  librarySuggestionIdSchema,
  memberIdSchema,
  sha256HexSchema,
} from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { z } from "zod";

import { blobBytes } from "../services/blob-store-view.ts";
import { libraryDepsOf } from "../services/library-deps.ts";
import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { fileTextOf, libraryItemSelect, libraryItemViews } from "./library-views.ts";

// F-145, F-146 (milestone 8, ticket 30; ADR 0069, Q315 to Q324): the skills and MCP library, and
// its marketplace search. The bodies are the domain's (`packages/domain/src/library/`), which
// core's jobs run too; these procedures wire them to the panel.
// - Any member reads the library (`list`, `get`), suggests an item (`suggest`) and reads their own
//   suggestions with each answer (`suggestions.mine`, ticket 31).
// - An organization admin looks at a reference and installs it, tests a server, attaches, detaches
//   and puts an item on every profile, asks for an update check and decides an update, removes an
//   item, edits the list of sources, decides suggestions, and searches the marketplace behind its
//   switch. Each refusal of a role is FORBIDDEN, before the input is read; another organization's
//   item, version, source or suggestion is NOT_FOUND.
// - Every write is the domain's transaction with its audit entry. Nothing here returns a secret: a
//   server's secret inputs show as set (`library-views.ts`). The calls out (the look, the install,
//   the test call, a file of the look, the search) go from the server, never from the browser, and
//   carry the admin's words and nothing else; a search's words are sent in a request's body, so they
//   reach no URL. Lines carry IDs, never a file, a header's value, a note or a search's words.

/** A source's refusal, the look's and the install's. */
const sourceCodes = {
  forbidden: "FORBIDDEN",
  "invalid-reference": "BAD_REQUEST",
  "not-found": "NOT_FOUND",
  "unsupported-host": "PRECONDITION_FAILED",
  "rate-limited": "TOO_MANY_REQUESTS",
  unavailable: "BAD_GATEWAY",
  "digest-mismatch": "BAD_GATEWAY",
  "too-large": "PAYLOAD_TOO_LARGE",
} as const satisfies Record<ResolveReferenceError, TRPC_ERROR_CODE_KEY>;

const installCodes = {
  ...sourceCodes,
  "not-allowed": "PRECONDITION_FAILED",
  "hash-changed": "CONFLICT",
  "skill-refused": "PRECONDITION_FAILED",
  "server-refused": "PRECONDITION_FAILED",
  "name-taken": "CONFLICT",
  "invalid-input": "BAD_REQUEST",
} as const;

const attachCodes = {
  forbidden: "FORBIDDEN",
  "not-found": "NOT_FOUND",
  "needs-oauth": "PRECONDITION_FAILED",
  unavailable: "BAD_GATEWAY",
  "too-many-skills": "PRECONDITION_FAILED",
  "too-many-servers": "PRECONDITION_FAILED",
  "name-taken": "CONFLICT",
} as const satisfies Record<AttachError, TRPC_ERROR_CODE_KEY>;

const itemCodes = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" } as const;
const decidedCodes = { ...itemCodes, "not-allowed-in-state": "CONFLICT" } as const;

/** A reference as an admin or a member types it: the domain reads it and says why it doesn't take one. */
const referenceText = z.string().max(4096);
const itemInput = z.strictObject({ itemId: libraryItemIdSchema });
const versionInput = z.strictObject({ versionId: libraryItemVersionIdSchema });
const onProfileInput = z.strictObject({ profileId: agentProfileIdSchema, itemId: libraryItemIdSchema });

/** A server input's value as the admin typed it: a secret one goes to the secret store. Never logged. */
const serverInputValue = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), value: z.string().max(8192) }),
  z.strictObject({ kind: z.literal("secret"), value: z.string().max(8192) }),
]);
const serverInputs = z
  .record(z.string().min(1).max(256), serverInputValue)
  .refine((inputs) => Object.keys(inputs).length <= 50, "at most 50 inputs")
  .default({});

const installInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("skill"),
    reference: referenceText,
    /** The folder picked from the look. */
    folder: z.string().max(1024),
    /** The look's commit (`null` for a site's skill) and hash: a source that changed since is refused. */
    commit: gitShaSchema.nullable(),
    computedHash: sha256HexSchema,
    /** Add the source to the list in the same call, with its own audit entry. */
    allowSource: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("server"),
    reference: referenceText,
    /** The look's version. */
    version: z.string().min(1).max(256),
    variables: serverInputs,
    headers: serverInputs,
    allowSource: z.boolean(),
  }),
]);

/** An entry an admin types for the list: the domain checks it and normalizes it. */
const sourceEntryInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("github_owner"), value: z.string().max(300) }),
  z.strictObject({ kind: z.literal("github_repo"), value: z.string().max(300) }),
  z.strictObject({ kind: z.literal("well_known_host"), value: z.string().max(300) }),
  z.strictObject({ kind: z.literal("registry"), value: z.string().max(2048), namespace: z.string().max(256).nullable() }),
]);

/** The switch as the library shows it, with its words: why it's off, and what a search sends where. */
const searchStateView = (state: MarketplaceSearchState) => ({
  ...state,
  /** Why search is off, in the fixed words of the switch that keeps it off; `null` while it's on. */
  offWords: state.off === "instance" ? INSTANCE_SEARCH_OFF_WORDS : state.off === "organization" ? ORGANIZATION_SEARCH_OFF_WORDS : null,
  /** What a search sends where. */
  sendsWords: marketplaceSearchSendsWords(state.sendsTo),
});

const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` });

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const sourcesRouter = router({
  /** The organization's list of sources, each with who added it (`null`: ostra's seed) and how many installed items it allows. */
  list: adminProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [rows, items] = await Promise.all([
      db.librarySource.findMany({ where: { organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, kind: true, value: true, namespace: true, addedByMemberId: true, createdAt: true } }),
      db.libraryItem.findMany({ where: { organizationId, removedAt: null }, select: { source: true } }),
    ]);
    const adders = await db.member.findMany({
      where: { organizationId, id: { in: rows.flatMap((row) => (row.addedByMemberId === null ? [] : [row.addedByMemberId])) } },
      select: { id: true, user: { select: { name: true } } },
    });
    const names = new Map(adders.map((member) => [member.id, member.user.name] as const));
    const subjects = items.flatMap((item) => {
      const source = librarySourceSchema.safeParse(item.source);
      return source.success ? [subjectOfSource(source.data)] : [];
    });
    return rows.map((row) => {
      const entry = allowlistEntryFromRow(row);
      return {
        sourceId: librarySourceIdSchema.parse(row.id),
        kind: row.kind,
        value: row.value,
        namespace: row.namespace,
        addedBy: row.addedByMemberId === null ? null : { memberId: memberIdSchema.parse(row.addedByMemberId), name: names.get(row.addedByMemberId) ?? null },
        createdAt: row.createdAt.getTime(),
        items: subjects.filter((subject) => allowed(subject, [entry]).allowed).length,
      };
    });
  }),

  /** Adds a source, with its audit entry. One already on the list is CONFLICT. */
  add: adminProcedure
    .input(z.strictObject({ entry: sourceEntryInput }))
    .mutation(async ({ ctx, input }) => {
      const added = unwrap(await addSource(libraryDepsOf(ctx.deps), ctx.scope, input), { forbidden: "FORBIDDEN", "invalid-input": "BAD_REQUEST", conflict: "CONFLICT" });
      return { sourceId: added.sourceId };
    }),

  /** Takes a source off: its items stay installed, marked, and their updates are refused. */
  remove: adminProcedure
    .input(z.strictObject({ sourceId: librarySourceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const removed = unwrap(await removeSource(libraryDepsOf(ctx.deps), ctx.scope, input), itemCodes);
      return { itemsMarked: removed.itemsMarked };
    }),
});

const suggestionsRouter = router({
  /** The members' suggestions, open ones first, each with whether its source is on the list now. The note is the member's text, shown as data. */
  list: adminProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const rows = await db.librarySuggestion.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: { id: true, memberId: true, reference: true, note: true, state: true, decidedByMemberId: true, decidedAt: true, itemId: true, createdAt: true },
    });
    const memberIds = [...new Set(rows.flatMap((row) => [row.memberId, ...(row.decidedByMemberId === null ? [] : [row.decidedByMemberId])]))];
    const [members, sources] = await Promise.all([
      db.member.findMany({ where: { organizationId, id: { in: memberIds } }, select: { id: true, user: { select: { name: true } } } }),
      allowlistOf(db, organizationId),
    ]);
    const names = new Map(members.map((member) => [member.id, member.user.name] as const));
    const views = [];
    for (const row of rows) {
      const parsed = parseLibraryReference(row.reference);
      views.push({
        suggestionId: librarySuggestionIdSchema.parse(row.id),
        reference: row.reference,
        note: row.note,
        state: row.state,
        sourceAllowed: parsed.ok && (await referenceAllowed(db, organizationId, parsed.value, sources)),
        suggestedBy: { memberId: memberIdSchema.parse(row.memberId), name: names.get(row.memberId) ?? null },
        createdAt: row.createdAt.getTime(),
        decidedBy: row.decidedByMemberId === null ? null : { memberId: memberIdSchema.parse(row.decidedByMemberId), name: names.get(row.decidedByMemberId) ?? null },
        decidedAt: row.decidedAt?.getTime() ?? null,
        itemId: row.itemId === null ? null : libraryItemIdSchema.parse(row.itemId),
      });
    }
    return [...views.filter((view) => view.state === "open"), ...views.filter((view) => view.state !== "open")];
  }),

  /**
   * Ticket 31: the member's own suggestions, newest first, each with its answer (who decided it and
   * when, the item an install made) and whether its source is on the list now. Any member's, and
   * only their own: nobody else's suggestion or note is in it.
   */
  mine: memberProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const rows = await db.librarySuggestion.findMany({
      where: { organizationId, memberId: ctx.scope.memberId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: { id: true, reference: true, note: true, state: true, decidedByMemberId: true, decidedAt: true, itemId: true, createdAt: true },
    });
    const deciders = [...new Set(rows.flatMap((row) => (row.decidedByMemberId === null ? [] : [row.decidedByMemberId])))];
    const [members, sources] = await Promise.all([
      db.member.findMany({ where: { organizationId, id: { in: deciders } }, select: { id: true, user: { select: { name: true } } } }),
      allowlistOf(db, organizationId),
    ]);
    const names = new Map(members.map((member) => [member.id, member.user.name] as const));
    const views = [];
    for (const row of rows) {
      const parsed = parseLibraryReference(row.reference);
      views.push({
        suggestionId: librarySuggestionIdSchema.parse(row.id),
        reference: row.reference,
        note: row.note,
        state: row.state,
        sourceAllowed: parsed.ok && (await referenceAllowed(db, organizationId, parsed.value, sources)),
        createdAt: row.createdAt.getTime(),
        decidedBy: row.decidedByMemberId === null ? null : { memberId: memberIdSchema.parse(row.decidedByMemberId), name: names.get(row.decidedByMemberId) ?? null },
        decidedAt: row.decidedAt?.getTime() ?? null,
        itemId: row.itemId === null ? null : libraryItemIdSchema.parse(row.itemId),
      });
    }
    return views;
  }),

  /** Installed (the item an install of it made) or dismissed, with its audit entry. */
  decide: adminProcedure
    .input(
      z.strictObject({
        suggestionId: librarySuggestionIdSchema,
        decision: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("installed"), itemId: libraryItemIdSchema }), z.strictObject({ kind: z.literal("dismissed") })]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const decided = unwrap(await decideSuggestion(libraryDepsOf(ctx.deps), ctx.scope, input), decidedCodes);
      return { decidedAt: decided.decidedAt };
    }),
});

export const libraryRouter = router({
  /** Every installed item, for any member: what's installed, so they can suggest what isn't. */
  list: memberProcedure.query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const rows = await db.libraryItem.findMany({ where: { organizationId: ctx.scope.organizationId, removedAt: null }, orderBy: [{ kind: "asc" }, { name: "asc" }, { id: "asc" }], select: libraryItemSelect });
    return libraryItemViews(db, ctx.scope, rows, { withDiff: false });
  }),

  /** One installed item, for any member; an update's whole diff for an organization admin only. */
  get: memberProcedure.input(itemInput).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const row = await db.libraryItem.findFirst({ where: { id: input.itemId, organizationId: ctx.scope.organizationId, removedAt: null }, select: libraryItemSelect });
    if (row === null) {
      throw notFound("item in the library");
    }
    const canManage = ctx.scope.role === "admin";
    const [view] = await libraryItemViews(db, ctx.scope, [row], { withDiff: canManage });
    if (view === undefined) {
      throw notFound("item in the library");
    }
    return { ...view, canManage };
  }),

  /** The admins' quiet counts: open suggestions, and items with an update waiting. */
  counts: adminProcedure.query(async ({ ctx }) => {
    const counts = unwrap(await libraryCounts({ db: ctx.deps.db }, ctx.scope), { forbidden: "FORBIDDEN" });
    return { openSuggestions: counts.openSuggestions, updatesWaiting: counts.updatesWaiting };
  }),

  /**
   * A file of one of an item's versions as text, with a cap, for an organization admin: the
   * update's diff and the current pin. Data, never a page. Read through core's blob service, from
   * whichever store keeps it, and checked against the digest its version pinned.
   */
  file: adminProcedure
    .input(z.strictObject({ versionId: libraryItemVersionIdSchema, path: z.string().min(1).max(1024) }))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const version = await ctx.deps.db.libraryItemVersion.findFirst({ where: { id: input.versionId, organizationId, item: { removedAt: null, kind: "skill" } }, select: { files: true } });
      const files = libraryVersionFilesSchema.safeParse(version?.files);
      const file = files.success ? files.data.find((candidate) => candidate.path === input.path) : undefined;
      if (file === undefined) {
        throw notFound("file in that version");
      }
      const read = await ctx.deps.blobStore.read(organizationId, null, file.blobId);
      switch (read.kind) {
        case "not-found":
          throw notFound("file in that version");
        case "unavailable":
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The file can't be read from the blob store just now: try again" });
        case "found": {
          // A stream that stops short, or whose bytes aren't its row's, reads as the store not answering.
          const bytes = await blobBytes(read.blob).catch(() => null);
          if (bytes === null) {
            ctx.deps.logger.warn("library.file.read-failed", { organizationId, versionId: input.versionId });
            throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The file can't be read from the blob store just now: try again" });
          }
          if (sha256Of(bytes) !== file.sha256) {
            ctx.deps.logger.warn("library.file.digest-mismatch", { organizationId, versionId: input.versionId });
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The stored file doesn't match the digest its version pinned" });
          }
          return fileTextOf(file.path, bytes);
        }
        default:
          return read satisfies never;
      }
    }),

  /** An admin's look at a reference before installing: the skills found or the server's entry, and whether the list allows it. Writes nothing. */
  resolve: adminProcedure.input(z.strictObject({ reference: referenceText })).mutation(async ({ ctx, input }) => {
    const looked = unwrap(await resolveReference(libraryDepsOf(ctx.deps), ctx.scope, input), sourceCodes);
    return { reference: looked.reference, resolved: looked.resolved };
  }),

  /**
   * A file of a skill the look found, as text with a cap: read again at the look's commit (or the
   * site's index), and refused when the skill's hash changed since. Writes nothing.
   */
  lookFile: adminProcedure
    .input(
      z.strictObject({
        reference: referenceText,
        folder: z.string().max(1024),
        commit: gitShaSchema.nullable(),
        computedHash: sha256HexSchema,
        path: z.string().min(1).max(1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const parsed = parseLibraryReference(input.reference);
      if (!parsed.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error });
      }
      const reference = parsed.value;
      const deps = libraryDepsOf(ctx.deps);
      let read: { readonly ok: true; readonly skill: SkillRead } | { readonly ok: false; readonly error: ResolveReferenceError; readonly message: string };
      switch (reference.kind) {
        case "registry":
          throw new TRPCError({ code: "BAD_REQUEST", message: "A registry holds MCP servers, which have no files to read" });
        case "github": {
          if (input.commit === null) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "A skill from GitHub is read at the commit its look resolved" });
          }
          const fetched = await readGitHubSkillForInstall({ db: deps.db, codeHost: deps.adapters.codeHost, secretStore: deps.adapters.secretStore }, organizationId, reference, input.folder, input.commit);
          read = fetched.ok ? { ok: true, skill: fetched.skill } : fetched;
          break;
        }
        case "well_known": {
          const fetched = await readWellKnownSkills({ fetch: deps.fetch, serverVersion: deps.serverVersion }, reference.url, input.folder);
          const [skill] = fetched.ok ? fetched.skills : [];
          read = !fetched.ok ? fetched : skill === undefined ? { ok: false, error: "not-found", message: "The site's index has no such skill" } : { ok: true, skill };
          break;
        }
        default:
          return reference satisfies never;
      }
      if (!read.ok) {
        throw new TRPCError({ code: sourceCodes[read.error], message: read.message });
      }
      if (read.skill.computedHash !== input.computedHash) {
        throw new TRPCError({ code: "CONFLICT", message: "The skill's files changed since the look: look again" });
      }
      const file = read.skill.files.find((candidate) => candidate.path === input.path);
      if (file === undefined) {
        throw notFound("file in that skill");
      }
      return fileTextOf(file.path, file.bytes);
    }),

  /** Installs what a look showed, at the same commit or version, or not at all. A server's secret inputs go to the secret store. */
  install: adminProcedure.input(installInput).mutation(async ({ ctx, input }) => {
    const installed = unwrap(await installItem(libraryDepsOf(ctx.deps), ctx.scope, input), installCodes);
    return { itemId: installed.itemId, versionId: installed.versionId };
  }),

  /** The test call to a server: its tools' names, or the OAuth mark, kept on its current version. */
  testServer: adminProcedure.input(itemInput).mutation(async ({ ctx, input }) => {
    const tested = unwrap(await testServer(libraryDepsOf(ctx.deps), ctx.scope, input), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      unavailable: "BAD_GATEWAY",
      "invalid-response": "BAD_GATEWAY",
    });
    return { toolNames: tested.toolNames, needsOAuth: tested.needsOAuth };
  }),

  /** On a profile, within its limits and with no name it uses. */
  attach: adminProcedure.input(onProfileInput).mutation(async ({ ctx, input }) => {
    const attached = unwrap(await attachItem(libraryDepsOf(ctx.deps), ctx.scope, input), attachCodes);
    return { attachedAt: attached.attachedAt };
  }),

  detach: adminProcedure.input(onProfileInput).mutation(async ({ ctx, input }) => {
    const detached = unwrap(await detachItem(libraryDepsOf(ctx.deps), ctx.scope, input), itemCodes);
    return { detached: detached.detached };
  }),

  /** On every profile, the built-in ones included, or off them: refused as a whole, naming each profile it would break. */
  setEveryProfile: adminProcedure.input(z.strictObject({ itemId: libraryItemIdSchema, everyProfile: z.boolean() })).mutation(async ({ ctx, input }) => {
    const set = unwrap(await setEveryProfile(libraryDepsOf(ctx.deps), ctx.scope, input), attachCodes);
    return { everyProfile: set.everyProfile };
  }),

  /** A library server marked read-only, or not: plan mode may call a read-only one's tools. */
  setReadOnly: adminProcedure.input(z.strictObject({ itemId: libraryItemIdSchema, readOnly: z.boolean() })).mutation(async ({ ctx, input }) => {
    const set = unwrap(await setReadOnly(libraryDepsOf(ctx.deps), ctx.scope, input), itemCodes);
    return { readOnly: set.readOnly };
  }),

  /** "Check for updates" on one item: core's update check for it, queued by the item's key. */
  checkUpdates: adminProcedure.input(itemInput).mutation(async ({ ctx, input }) => {
    unwrap(await requestUpdateCheck(libraryDepsOf(ctx.deps), ctx.scope, input), itemCodes);
    return { requested: true as const };
  }),

  /** The update becomes the pin, and every attached profile's next session takes it. */
  acceptUpdate: adminProcedure.input(versionInput).mutation(async ({ ctx, input }) => {
    const accepted = unwrap(await acceptUpdate(libraryDepsOf(ctx.deps), ctx.scope, input), {
      ...decidedCodes,
      "not-allowed": "PRECONDITION_FAILED",
      "needs-oauth": "PRECONDITION_FAILED",
      "needs-input": "PRECONDITION_FAILED",
    });
    return { currentVersionId: accepted.currentVersionId };
  }),

  /** The item stays where it is; a newer update shows again. */
  dismissUpdate: adminProcedure.input(versionInput).mutation(async ({ ctx, input }) => {
    const dismissed = unwrap(await dismissUpdate(libraryDepsOf(ctx.deps), ctx.scope, input), decidedCodes);
    return { dismissedAt: dismissed.dismissedAt };
  }),

  /** Out of the library and off every profile; tasks lose it at their next session. */
  remove: adminProcedure.input(itemInput).mutation(async ({ ctx, input }) => {
    const removed = unwrap(await removeItem(libraryDepsOf(ctx.deps), ctx.scope, input), itemCodes);
    return { removedAt: removed.removedAt };
  }),

  /** Any member suggests a reference with a note, told whether its source is on the list. The note is never logged. */
  suggest: memberProcedure
    .input(z.strictObject({ reference: referenceText, note: z.string().max(SUGGESTION_NOTE_MAX * 2) }))
    .mutation(async ({ ctx, input }) => {
      const suggested = unwrap(await suggestItem(libraryDepsOf(ctx.deps), ctx.scope, input), { "invalid-reference": "BAD_REQUEST", "invalid-input": "BAD_REQUEST" });
      return { suggestionId: suggested.suggestionId, sourceAllowed: suggested.sourceAllowed };
    }),

  sources: sourcesRouter,
  suggestions: suggestionsRouter,

  /** The marketplace search's switch: on or off, which setting keeps it off and why, and what a search sends where. */
  searchState: adminProcedure.query(async ({ ctx }) => {
    const read = unwrap(await readMarketplaceSearch(libraryDepsOf(ctx.deps), ctx.scope), { forbidden: "FORBIDDEN" });
    return searchStateView(read.state);
  }),

  /** The organization admin's switch, audited; refused on while `OSTRA_MARKETPLACE_SEARCH=false`. */
  setMarketplaceSearch: adminProcedure.input(z.strictObject({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const set = unwrap(await setMarketplaceSearch(libraryDepsOf(ctx.deps), ctx.scope, input), { forbidden: "FORBIDDEN", "instance-search-off": "PRECONDITION_FAILED" });
    return searchStateView(set.state);
  }),

  /**
   * skills.sh's search, or each registry on the list, from the server: behind the organization's
   * switch and the install's, with the admin's words and nothing else. A mutation, so the words
   * travel in the request's body and never in a URL, and nothing searches again by itself. Each
   * source answers, or says it's unavailable.
   */
  search: adminProcedure
    .input(z.strictObject({ kind: z.enum(["skills", "servers"]), words: z.string().max(MARKETPLACE_WORDS_MAX * 4) }))
    .mutation(async ({ ctx, input }) => {
      const searched = unwrap(await searchMarketplace(libraryDepsOf(ctx.deps), ctx.scope, input), {
        forbidden: "FORBIDDEN",
        "instance-search-off": "PRECONDITION_FAILED",
        "organization-search-off": "PRECONDITION_FAILED",
        "invalid-input": "BAD_REQUEST",
      });
      return { sources: searched.sources };
    }),
});
