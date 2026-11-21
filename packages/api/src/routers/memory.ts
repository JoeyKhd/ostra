import {
  agentDisplayName,
  archiveNote,
  buildMemoryIndex,
  canArchiveNote,
  decideProposal,
  loadBlockNotes,
  proposeRememberThis,
  rankNotes,
  readNoteForMember,
  relatedNotes,
  rememberThis,
  saveNote,
} from "@ostra/domain";
import type { MemberScope, NotesDeps, RememberThisSource } from "@ostra/domain";
import type { Db, DbOrTx } from "@ostra/db";
import {
  diffCommentIdSchema,
  memberIdSchema,
  memoryKindSchema,
  memoryNoteBodySchema,
  memoryNoteTitleSchema,
  memoryScopeSchema,
  memoryUseViaSchema,
  noteIdSchema,
  projectIdSchema,
  proposalIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { loadProjectAccess, memberProcedure, router, taskProcedure } from "../trpc/init.ts";
import { boardProjectIds } from "./home-board.ts";

// F-109, F-110, F-111 (ticket 29; ADR 0044 amended): memory in the panel. A scope's notes, searched
// by full text; a note with its versions; saving and archiving through ticket 16's use cases; the
// proposals and their decisions; "Remember this"; and what a task's sessions used. An organization
// note is any member's to read and write; a project note is for whoever can open the project, and
// a restricted project's notes are `NOT_FOUND` to anyone else. A secret refusal names the kind it
// found, never the value; a stale save or merge is `CONFLICT`, naming who saved which version.

const noteStatusSchema = z.enum(["active", "archived"]);
const sourceKindSchema = z.enum(["member", "task", "proposal", "diff_comment", "pr_comment", "ai_finding"]);

const personSchema = z.object({ memberId: memberIdSchema, name: z.string() });

export const noteViewSchema = z.object({
  noteId: noteIdSchema,
  scope: memoryScopeSchema,
  projectId: projectIdSchema.nullable(),
  title: z.string(),
  body: z.string(),
  kind: memoryKindSchema,
  always: z.boolean(),
  status: noteStatusSchema,
  version: z.number().int(),
  source: z.object({ kind: sourceKindSchema, taskId: taskIdSchema.nullable(), ref: z.string().nullable() }),
  author: personSchema.nullable(),
  /** The last time an agent read it or found it by search (ADR 0044, Q91); `null` before. */
  lastUsedAt: z.number().nullable(),
  useCount: z.number().int(),
  /** Whether the caller may archive it: its author, or an admin of its scope. */
  canArchive: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type NoteView = z.infer<typeof noteViewSchema>;

const proposalStateSchema = z.enum(["proposed", "approved", "rejected", "merged"]);
const proposalSourceSchema = z.enum(["agent", "closing_turn", "diff_comment", "pr_comment", "ai_finding"]);

export const proposalViewSchema = z.object({
  proposalId: proposalIdSchema,
  scope: memoryScopeSchema,
  projectId: projectIdSchema.nullable(),
  title: z.string(),
  body: z.string(),
  kind: memoryKindSchema,
  state: proposalStateSchema,
  source: proposalSourceSchema,
  /** The task it came from, with its title (the panel links it); `null` once the task is gone. */
  task: z.object({ taskId: taskIdSchema, title: z.string(), projectId: projectIdSchema }).nullable(),
  proposedBy: personSchema.nullable(),
  /** The note the agent says it relates to, and how. */
  relatesTo: z.object({ noteId: noteIdSchema, relation: z.enum(["contradicts", "refines"]).nullable() }).nullable(),
  decidedBy: personSchema.nullable(),
  decidedAt: z.number().nullable(),
  resultNoteId: noteIdSchema.nullable(),
  createdAt: z.number(),
});
export type ProposalView = z.infer<typeof proposalViewSchema>;

type ScopeInput = { readonly scope: "organization" | "project"; readonly projectId?: ProjectId | undefined };

const scopeInputSchema = z.strictObject({ scope: memoryScopeSchema, projectId: projectIdSchema.optional() });

/** The scope's project, after its access check: `null` for the organization's own memory. */
const scopeProject = async (ctx: Pick<Context, "deps"> & { readonly scope: MemberScope }, input: ScopeInput): Promise<ProjectId | null> => {
  if (input.scope === "organization") {
    if (input.projectId !== undefined) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "An organization's memory names no project" });
    }
    return null;
  }
  if (input.projectId === undefined) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A project's memory names its project" });
  }
  return (await loadProjectAccess(ctx.deps.db, ctx.scope, input.projectId, "read")).projectId;
};

const namesOf = async (db: DbOrTx, organizationId: OrganizationId, ids: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> => {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.member.findMany({ where: { organizationId, id: { in: wanted } }, select: { id: true, user: { select: { name: true } } } });
  return new Map(rows.map((row) => [row.id, row.user.name] as const));
};

const personOf = (names: ReadonlyMap<string, string>, id: string | null): { readonly memberId: MemberId; readonly name: string } | null =>
  id === null ? null : { memberId: memberIdSchema.parse(id), name: names.get(id) ?? "A former member" };

type NoteRow = Awaited<ReturnType<DbOrTx["memoryNote"]["findMany"]>>[number];

const noteViews = async (db: DbOrTx, scope: MemberScope, rows: readonly NoteRow[], projectAccess: ReadonlyMap<string, "open" | "restricted">): Promise<NoteView[]> => {
  const names = await namesOf(db, scope.organizationId, rows.map((row) => row.authorMemberId));
  return rows.map((row) => {
    const projectId = row.projectId === null ? null : projectIdSchema.parse(row.projectId);
    const access = projectId === null ? null : projectAccess.get(projectId);
    return {
      noteId: noteIdSchema.parse(row.id),
      scope: row.scope,
      projectId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      always: row.always,
      status: row.status,
      version: row.version,
      source: { kind: row.sourceKind, taskId: row.sourceTaskId === null ? null : taskIdSchema.parse(row.sourceTaskId), ref: row.sourceRef },
      author: personOf(names, row.authorMemberId),
      lastUsedAt: row.lastUsedAt?.getTime() ?? null,
      useCount: row.useCount,
      canArchive: canArchiveNote(scope, {
        organizationId: scope.organizationId,
        project: projectId === null || access === null || access === undefined ? null : { id: projectId, organizationId: scope.organizationId, access },
        authorMemberId: row.authorMemberId === null ? null : memberIdSchema.parse(row.authorMemberId),
      }),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  });
};

const projectAccessOf = async (db: DbOrTx, organizationId: OrganizationId, projectId: ProjectId | null): Promise<ReadonlyMap<string, "open" | "restricted">> => {
  if (projectId === null) {
    return new Map();
  }
  const project = await db.project.findFirstOrThrow({ where: { id: projectId, organizationId }, select: { access: true } });
  return new Map([[projectId, project.access]]);
};

type ProposalRow = Awaited<ReturnType<DbOrTx["memoryProposal"]["findMany"]>>[number];

const proposalViews = async (db: DbOrTx, organizationId: OrganizationId, rows: readonly ProposalRow[]): Promise<ProposalView[]> => {
  const names = await namesOf(db, organizationId, rows.flatMap((row) => [row.proposedByMemberId, row.decidedByMemberId]));
  const taskIds = [...new Set(rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId])))];
  const tasks = taskIds.length === 0 ? [] : await db.task.findMany({ where: { organizationId, id: { in: taskIds } }, select: { id: true, title: true, projectId: true } });
  const taskOf = new Map(tasks.map((task) => [task.id, task] as const));
  return rows.map((row) => {
    const task = row.taskId === null ? undefined : taskOf.get(row.taskId);
    return {
      proposalId: proposalIdSchema.parse(row.id),
      scope: row.scope,
      projectId: row.projectId === null ? null : projectIdSchema.parse(row.projectId),
      title: row.title,
      body: row.body,
      kind: row.kind,
      state: row.state,
      source: row.sourceKind,
      task: task === undefined ? null : { taskId: taskIdSchema.parse(task.id), title: task.title, projectId: projectIdSchema.parse(task.projectId) },
      proposedBy: personOf(names, row.proposedByMemberId),
      relatesTo: row.relatesToNoteId === null ? null : { noteId: noteIdSchema.parse(row.relatesToNoteId), relation: row.relation },
      decidedBy: personOf(names, row.decidedByMemberId),
      decidedAt: row.decidedAt?.getTime() ?? null,
      resultNoteId: row.resultNoteId === null ? null : noteIdSchema.parse(row.resultNoteId),
      createdAt: row.createdAt.getTime(),
    };
  });
};

/** A task's short key: its ticket's, or the end of its ID (as Home and Needs you say it). */
const taskKeyOf = (task: { readonly id: string; readonly ticketKey: string | null }): string => task.ticketKey ?? task.id.replaceAll("-", "").slice(-8);

/**
 * Where each proposal a note's versions came from, by proposal ID: its kind, the agent (an agent's
 * or a closing turn's) or the member (a comment's), and its task with its key while the viewer can
 * open the task's project; a task they can't open isn't named.
 */
const versionSources = async (db: Db, scope: MemberScope, proposalIds: readonly string[]) => {
  type Source = { readonly kind: ProposalRow["sourceKind"]; readonly agent: string | null; readonly by: { readonly memberId: MemberId; readonly name: string } | null; readonly task: { readonly taskId: ReturnType<typeof taskIdSchema.parse>; readonly key: string } | null };
  const out = new Map<string, Source>();
  if (proposalIds.length === 0) return out;
  const { organizationId } = scope;
  const proposals = await db.memoryProposal.findMany({ where: { organizationId, id: { in: [...proposalIds] } }, select: { id: true, sourceKind: true, taskId: true, proposedByMemberId: true } });
  const taskIds = [...new Set(proposals.flatMap((proposal) => (proposal.taskId === null ? [] : [proposal.taskId])))];
  const [tasks, visible, names] = await Promise.all([
    taskIds.length === 0 ? [] : db.task.findMany({ where: { organizationId, id: { in: taskIds } }, select: { id: true, ticketKey: true, projectId: true, agentProfileId: true } }),
    boardProjectIds(db, scope, undefined),
    namesOf(db, organizationId, proposals.map((proposal) => proposal.proposedByMemberId)),
  ]);
  const profileIds = [...new Set(tasks.flatMap((task) => (task.agentProfileId === null ? [] : [task.agentProfileId])))];
  const profiles = profileIds.length === 0 ? [] : await db.agentProfile.findMany({ where: { organizationId, id: { in: profileIds } }, select: { id: true, adapter: true } });
  const adapterOf = new Map(profiles.map((profile) => [profile.id, profile.adapter] as const));
  const taskOf = new Map(tasks.map((task) => [task.id, task] as const));
  const open = new Set(visible ?? []);
  for (const proposal of proposals) {
    const task = proposal.taskId === null ? undefined : taskOf.get(proposal.taskId);
    const agentMade = proposal.sourceKind === "agent" || proposal.sourceKind === "closing_turn";
    out.set(proposal.id, {
      kind: proposal.sourceKind,
      agent: agentMade ? agentDisplayName(task === undefined || task.agentProfileId === null ? "opencode" : (adapterOf.get(task.agentProfileId) ?? "opencode")) : null,
      by: agentMade ? null : personOf(names, proposal.proposedByMemberId),
      task: task === undefined || !open.has(task.projectId) ? null : { taskId: taskIdSchema.parse(task.id), key: taskKeyOf(task) },
    });
  }
  return out;
};

/** The proposal panel's facts of its task: the driver, the session's number, the agent's proposals of the cap. */
const proposalTaskFacts = async (db: DbOrTx, organizationId: OrganizationId, at: { readonly taskId: string; readonly sessionId: string | null }, cap: number) => {
  const [task, sessions, made] = await Promise.all([
    db.task.findFirst({ where: { id: at.taskId, organizationId }, select: { driverMemberId: true } }),
    at.sessionId === null ? [] : db.session.findMany({ where: { organizationId, taskId: at.taskId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }], select: { id: true } }),
    // The cap's own count (`proposeNote`): what the task's agent proposed, not members' comments.
    db.memoryProposal.count({ where: { organizationId, taskId: at.taskId, sourceKind: { in: ["agent", "closing_turn"] } } }),
  ]);
  const names = await namesOf(db, organizationId, [task?.driverMemberId ?? null]);
  const index = sessions.findIndex((session) => session.id === at.sessionId);
  return {
    driver: personOf(names, task?.driverMemberId ?? null),
    session: index === -1 ? null : index + 1,
    proposals: { made, cap },
  };
};

const notesDeps = (ctx: Pick<Context, "deps">): NotesDeps => ({
  db: ctx.deps.db,
  audit: ctx.deps.ports.audit,
  clock: ctx.deps.ports.clock,
  adapters: { secretStore: ctx.deps.ports.adapters.secretStore },
});

/** A refusal of ticket 16's use cases, as the panel gets it. A note's text is never in it. */
const refuse = (refusal: { readonly error: string; readonly message: string }): never => {
  const code = (() => {
    switch (refusal.error) {
      case "secret-found":
      case "invalid-input":
        return "BAD_REQUEST" as const;
      case "conflict":
      case "not-proposed":
        return "CONFLICT" as const;
      case "forbidden":
        return "FORBIDDEN" as const;
      default:
        return "NOT_FOUND" as const;
    }
  })();
  throw new TRPCError({ code, message: refusal.message });
};

/** The proposals of a scope still waiting for a decision. */
const openProposals = (db: DbOrTx, organizationId: OrganizationId, projectId: ProjectId | null): Promise<number> =>
  db.memoryProposal.count({ where: { organizationId, projectId, state: "proposed" } });

const MAX_NOTES = 500;

export const memoryRouter = router({
  /**
   * What a new task gets from the scope's memory (memory.md, the index line), counted by the
   * domain's own index builder: the "always" notes in full, then the index, within ADR 0044's limits.
   */
  index: memberProcedure
    .input(scopeInputSchema)
    .output(z.object({ always: z.number().int(), indexed: z.number().int(), others: z.number().int(), alwaysOver: z.number().int(), alwaysBytes: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const projectId = await scopeProject(ctx, input);
      const notes = await loadBlockNotes(ctx.deps.db, ctx.scope.organizationId, projectId);
      const built = buildMemoryIndex(notes);
      return {
        always: built.always.length,
        indexed: built.index.length,
        others: built.index.length + built.omitted,
        alwaysOver: notes.filter((note) => note.always).length - built.always.length,
        alwaysBytes: built.alwaysBytes,
      };
    }),

  /**
   * A scope's notes, newest first, or the best matches for `query`, ranked as `memory_search`
   * ranks (`rankNotes`: a question's meaningful words, and a path, a flag or an identifier as
   * written, by bound parameter), with the count of the scope's open proposals. Only the scope's
   * own notes, after its access check.
   */
  notes: memberProcedure
    .input(
      scopeInputSchema.extend({
        query: z.string().max(200).optional(),
        kinds: z.array(memoryKindSchema).max(6).optional(),
        status: noteStatusSchema.optional(),
      }),
    )
    .output(z.object({ notes: z.array(noteViewSchema), openProposals: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const projectId = await scopeProject(ctx, input);
      const status = input.status ?? "active";
      const query = input.query?.trim() ?? "";
      let ids: readonly string[] | null = null;
      if (query !== "") {
        const ranked = await rankNotes(db, { kind: "scope", organizationId, scope: input.scope, projectId, status }, query, MAX_NOTES);
        if (ranked.length === 0) {
          return { notes: [], openProposals: await openProposals(db, organizationId, projectId) };
        }
        ids = ranked.map((note) => note.noteId);
      }
      const rows = await db.memoryNote.findMany({
        where: {
          organizationId,
          scope: input.scope,
          projectId,
          status,
          ...(input.kinds === undefined ? {} : { kind: { in: input.kinds } }),
          ...(ids === null ? {} : { id: { in: [...ids] } }),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: MAX_NOTES,
      });
      const ordered = ids === null ? rows : [...rows].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
      return {
        notes: await noteViews(db, ctx.scope, ordered, await projectAccessOf(db, organizationId, projectId)),
        openProposals: await openProposals(db, organizationId, projectId),
      };
    }),

  /** One note with its versions: who saved each, when, and the proposal a version came from. */
  note: memberProcedure
    .input(z.strictObject({ noteId: noteIdSchema }))
    .output(
      noteViewSchema.extend({
        /** How many tasks read it or found it by search (memory-note.md, `Used · 9 times in 6 tasks`). */
        usedInTasks: z.number().int(),
        versions: z.array(
          z.object({
            version: z.number().int(),
            title: z.string(),
            body: z.string(),
            kind: memoryKindSchema,
            always: z.boolean(),
            editedBy: personSchema.nullable(),
            proposalId: proposalIdSchema.nullable(),
            /**
             * Where a version from a proposal came from (memory-note.md, Versions' Source): the
             * proposal's kind, the agent or the member who made it, and its task with its key, when
             * the viewer can open that task's project. `null` for a member's own save.
             */
            source: z
              .object({
                kind: proposalSourceSchema,
                agent: z.string().nullable(),
                by: personSchema.nullable(),
                task: z.object({ taskId: taskIdSchema, key: z.string() }).nullable(),
              })
              .nullable(),
            at: z.number(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      if ((await readNoteForMember(db, ctx.scope, input.noteId)) === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such note" });
      }
      const row = await db.memoryNote.findFirstOrThrow({ where: { id: input.noteId, organizationId } });
      const projectId = row.projectId === null ? null : projectIdSchema.parse(row.projectId);
      const [view] = await noteViews(db, ctx.scope, [row], await projectAccessOf(db, organizationId, projectId));
      if (view === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such note" });
      }
      const versions = await db.memoryNoteVersion.findMany({ where: { noteId: row.id, organizationId }, orderBy: { version: "desc" } });
      const [uses, sources] = await Promise.all([
        // A use is a read or a search hit (ADR 0044, Q91): its place in the index or the always block isn't.
        db.memoryUse.groupBy({ by: ["taskId"], where: { organizationId, noteId: row.id, via: { in: ["read", "search"] } } }),
        versionSources(db, ctx.scope, versions.flatMap((version) => (version.proposalId === null ? [] : [version.proposalId]))),
      ]);
      const names = await namesOf(db, organizationId, versions.map((version) => version.editedByMemberId));
      return {
        ...view,
        usedInTasks: uses.length,
        versions: versions.map((version) => ({
          version: version.version,
          title: version.title,
          body: version.body,
          kind: version.kind,
          always: version.always,
          editedBy: personOf(names, version.editedByMemberId),
          proposalId: version.proposalId === null ? null : proposalIdSchema.parse(version.proposalId),
          source: version.proposalId === null ? null : (sources.get(version.proposalId) ?? null),
          at: version.createdAt.getTime(),
        })),
      };
    }),

  /**
   * Writes a new note (`noteId` null), or edits one at the version the member opened
   * (`expectedVersion`). A saved note keeps its scope.
   */
  save: memberProcedure
    .input(
      z.strictObject({
        noteId: noteIdSchema.nullable(),
        expectedVersion: z.number().int().positive().nullable(),
        scope: memoryScopeSchema,
        projectId: projectIdSchema.nullable(),
        title: memoryNoteTitleSchema,
        body: memoryNoteBodySchema,
        kind: memoryKindSchema,
        always: z.boolean(),
      }),
    )
    .output(z.object({ noteId: noteIdSchema, version: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const saved = await saveNote(notesDeps(ctx), ctx.scope, input);
      if (!saved.ok) {
        return refuse(saved);
      }
      return { noteId: saved.noteId, version: saved.version };
    }),

  /** Archives a note: its author, or an admin of its scope. Notes are archived, never deleted. */
  archive: memberProcedure
    .input(z.strictObject({ noteId: noteIdSchema }))
    .output(z.object({ archivedAt: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const archived = await archiveNote(notesDeps(ctx), ctx.scope, input);
      if (!archived.ok) {
        return refuse(archived);
      }
      return { archivedAt: archived.archivedAt };
    }),

  /** A scope's proposals, open ones first (`state` narrows them). */
  proposals: memberProcedure
    .input(scopeInputSchema.extend({ state: proposalStateSchema.optional() }))
    .output(z.array(proposalViewSchema))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const projectId = await scopeProject(ctx, input);
      const rows = await db.memoryProposal.findMany({
        where: { organizationId, scope: input.scope, projectId, ...(input.state === undefined ? {} : { state: input.state }) },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: MAX_NOTES,
      });
      const views = await proposalViews(db, organizationId, rows);
      return [...views.filter((view) => view.state === "proposed"), ...views.filter((view) => view.state !== "proposed")];
    }),

  /** One proposal, with the note it declares it relates to and the three that rank highest against it. */
  proposal: memberProcedure
    .input(z.strictObject({ proposalId: proposalIdSchema }))
    .output(
      proposalViewSchema.extend({
        /**
         * The panel's Source and This task rows (memory-proposals.md): the task's driver, the
         * proposal's session as its number among the task's sessions, and how many proposals the
         * task's agent has made of its cap (`OSTRA_MEMORY_PROPOSALS_PER_TASK`). `null` without a task.
         */
        taskFacts: z
          .object({
            driver: personSchema.nullable(),
            session: z.number().int().nullable(),
            proposals: z.object({ made: z.number().int(), cap: z.number().int() }),
          })
          .nullable(),
        related: z.array(
          z.object({
            noteId: noteIdSchema,
            title: z.string(),
            version: z.number().int(),
            relation: z.enum(["contradicts", "refines"]).nullable(),
            /** The note's kind and its body's first line (memory-proposals.md, a related note's two lines). */
            kind: memoryKindSchema,
            firstLine: z.string(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const related = await relatedNotes(db, ctx.scope, input.proposalId);
      if (related === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such proposal" });
      }
      const row = await db.memoryProposal.findFirstOrThrow({ where: { id: input.proposalId, organizationId: ctx.scope.organizationId } });
      const [view] = await proposalViews(db, ctx.scope.organizationId, [row]);
      if (view === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such proposal" });
      }
      const notes = await db.memoryNote.findMany({
        where: { organizationId: ctx.scope.organizationId, id: { in: related.map((note) => note.noteId) } },
        select: { id: true, kind: true, body: true },
      });
      const byId = new Map(notes.map((note) => [note.id, note] as const));
      return {
        ...view,
        taskFacts: view.task === null ? null : await proposalTaskFacts(db, ctx.scope.organizationId, { taskId: view.task.taskId, sessionId: row.sessionId }, ctx.deps.settings.memoryProposalsPerTask),
        related: related.flatMap((note) => {
          const found = byId.get(note.noteId);
          return found === undefined ? [] : [{ ...note, kind: found.kind, firstLine: found.body.split("\n", 1)[0] ?? "" }];
        }),
      };
    }),

  /**
   * A proposal's decision: approve as a new note, approve and archive a note, merge into a note at
   * the version the member opened (`CONFLICT` when it moved on), or reject.
   */
  decide: memberProcedure
    .input(
      z.discriminatedUnion("decision", [
        z.strictObject({ proposalId: proposalIdSchema, decision: z.literal("approve") }),
        z.strictObject({ proposalId: proposalIdSchema, decision: z.literal("approve_and_archive"), archiveNoteId: noteIdSchema }),
        z.strictObject({ proposalId: proposalIdSchema, decision: z.literal("reject") }),
        z.strictObject({
          proposalId: proposalIdSchema,
          decision: z.literal("merge"),
          intoNoteId: noteIdSchema,
          expectedVersion: z.number().int().positive(),
          title: memoryNoteTitleSchema,
          body: memoryNoteBodySchema,
        }),
      ]),
    )
    .output(z.object({ noteId: noteIdSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const decided = await decideProposal(notesDeps(ctx), ctx.scope, input);
      if (!decided.ok) {
        return refuse(decided);
      }
      return { noteId: decided.noteId };
    }),

  /**
   * "Remember this" on a diff comment or an accepted `@ostra` PR comment: a project proposal. The
   * member's edited title and body, or, for a diff comment, the comment's own first line and text.
   */
  rememberThis: memberProcedure
    .input(
      z.strictObject({
        source: z.union([
          z.strictObject({ diffCommentId: diffCommentIdSchema }),
          z.strictObject({ taskId: taskIdSchema, prCommentEventSeq: z.number().int().positive() }),
        ]),
        title: memoryNoteTitleSchema.optional(),
        body: memoryNoteBodySchema.optional(),
        kind: memoryKindSchema.optional(),
      }),
    )
    .output(z.object({ proposalId: proposalIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      let source: RememberThisSource;
      let taskId;
      if ("diffCommentId" in input.source) {
        const comment = await db.diffComment.findFirst({ where: { id: input.source.diffCommentId, organizationId }, select: { id: true, taskId: true, path: true, line: true, body: true } });
        if (comment === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such comment" });
        }
        taskId = taskIdSchema.parse(comment.taskId);
        source = { kind: "diff_comment", commentId: diffCommentIdSchema.parse(comment.id), path: comment.path, line: comment.line, body: comment.body };
      } else {
        taskId = input.source.taskId;
        const event = await db.event.findFirst({ where: { taskId, organizationId, seq: input.source.prCommentEventSeq, kind: "pr.comment_received" }, select: { payload: true } });
        const url = z.looseObject({ url: z.string() }).safeParse(event?.payload);
        if (!url.success) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such comment on this task" });
        }
        source = { kind: "pr_comment", url: url.data.url, body: "" };
      }
      // Access first: a task the member can't open is NOT_FOUND, whatever the comment says.
      const task = await db.task.findFirst({ where: { id: taskId, organizationId }, select: { projectId: true } });
      if (task === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such task" });
      }
      await loadProjectAccess(db, ctx.scope, projectIdSchema.parse(task.projectId), "read");
      let title = input.title;
      let body = input.body;
      if (title === undefined || body === undefined) {
        const draft = rememberThis({ source, projectId: projectIdSchema.parse(task.projectId), taskId, memberId: ctx.scope.memberId });
        if ("error" in draft) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Give the proposal a title and a body" });
        }
        title ??= draft.title;
        body ??= draft.body;
      }
      const proposed = await proposeRememberThis(notesDeps(ctx), ctx.scope, { taskId, source, title, body, kind: input.kind ?? "convention" });
      if (!proposed.ok) {
        return refuse(proposed);
      }
      return { proposalId: proposed.proposalId };
    }),
});

/** `tasks.memory`: the notes each of the task's sessions used and how, and the proposals the task made. */
export const taskMemoryProcedure = taskProcedure("read", z.strictObject({ taskId: taskIdSchema }))
  .output(
    z.object({
      sessions: z.array(
        z.object({
          sessionId: sessionIdSchema,
          startedAt: z.number(),
          uses: z.array(z.object({ noteId: noteIdSchema, title: z.string(), scope: memoryScopeSchema, via: memoryUseViaSchema, at: z.number() })),
        }),
      ),
      proposals: z.array(proposalViewSchema),
    }),
  )
  .query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [sessions, uses, proposals] = await Promise.all([
      db.session.findMany({ where: { taskId: input.taskId, organizationId }, orderBy: { startedAt: "asc" }, select: { id: true, startedAt: true } }),
      db.memoryUse.findMany({
        where: { taskId: input.taskId, organizationId },
        orderBy: [{ at: "asc" }, { id: "asc" }],
        select: { sessionId: true, noteId: true, via: true, at: true, note: { select: { title: true, scope: true } } },
      }),
      db.memoryProposal.findMany({ where: { taskId: input.taskId, organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    ]);
    return {
      sessions: sessions.map((session) => ({
        sessionId: sessionIdSchema.parse(session.id),
        startedAt: session.startedAt.getTime(),
        uses: uses
          .filter((use) => use.sessionId === session.id)
          .map((use) => ({ noteId: noteIdSchema.parse(use.noteId), title: use.note.title, scope: use.note.scope, via: use.via, at: use.at.getTime() })),
      })),
      proposals: await proposalViews(db, organizationId, proposals),
    };
  });
