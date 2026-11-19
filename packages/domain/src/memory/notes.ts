import type { Db, DbOrTx, Tx } from "@ostra/db";
import {
  diffCommentIdSchema,
  memberIdSchema,
  memoryNoteBodySchema,
  memoryNoteTitleSchema,
  noteIdSchema,
  organizationIdSchema,
  projectIdSchema,
  proposalIdSchema,
  sessionIdSchema,
} from "@ostra/protocol";
import type { MemberId, MemoryKind, MemoryNote, MemoryScope, NoteId, OrganizationId, ProjectId, ProposalId, TaskId } from "@ostra/protocol";

import { canArchiveNote, canWriteNote, requireProjectAccess } from "../access.ts";
import type { MemberScope, NoteAccessInfo, ProjectAccessInfo } from "../access.ts";
import type { AuditLog, Clock } from "../ports.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import type { ArchiveNote, DecideProposal, RememberThis, SaveNote } from "../use-cases/m4-signatures.ts";
import { checkNoteVersion } from "./block.ts";
import type { RememberThisSource } from "./remember-this.ts";
import { scanMemoryText, secretScanMessage } from "./secret-scan.ts";
import { organizationSecretValues, queryWords } from "./store.ts";

// A member's notes and the proposals' decisions (F-109, F-111, ADR 0044 amended, Q91; milestone 4's
// ticket 16). Each write is one transaction with its audit entry, by the note's or the proposal's ID.
// Every text is scanned for secrets before anything is stored. An edit and a merge carry the version
// the member opened, checked under the note's lock, so two saves can't both win. A note's text is
// never in a log line, an audit entry or an error.

export type NotesDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: { readonly secretStore: Parameters<typeof organizationSecretValues>[1] };
};

/** A refusal for a stale edit or merge: who saved the version the member didn't see. */
export type NoteConflict = {
  readonly ok: false;
  readonly error: "conflict";
  readonly message: string;
  readonly currentVersion: number;
  readonly savedBy: MemberId | null;
};

/** A secret refusal: each kind found, never the value. */
export type NoteSecretFound = { readonly ok: false; readonly error: "secret-found"; readonly message: string; readonly found: readonly string[] };

type Failure<E extends string> = { readonly ok: false; readonly error: E; readonly message: string };

const notFound = { ok: false, error: "not-found", message: "No such note" } as const;

const projectAccess = async (db: DbOrTx, organizationId: OrganizationId, projectId: string | null): Promise<ProjectAccessInfo | null | "missing"> => {
  if (projectId === null) {
    return null;
  }
  const project = await db.project.findFirst({ where: { id: projectId, organizationId }, select: { id: true, access: true } });
  return project === null ? "missing" : { id: projectIdSchema.parse(project.id), organizationId, access: project.access };
};

const noteAccess = async (
  db: DbOrTx,
  organizationId: OrganizationId,
  note: { readonly projectId: string | null; readonly authorMemberId: string | null },
): Promise<NoteAccessInfo | null> => {
  const project = await projectAccess(db, organizationId, note.projectId);
  if (project === "missing") {
    return null;
  }
  return { organizationId, project, authorMemberId: note.authorMemberId === null ? null : memberIdSchema.parse(note.authorMemberId) };
};

const memberName = async (db: DbOrTx, organizationId: OrganizationId, memberId: string | null): Promise<string> => {
  if (memberId === null) {
    return "someone";
  }
  const member = await db.member.findFirst({ where: { id: memberId, organizationId }, select: { user: { select: { name: true } } } });
  return member?.user.name ?? "a former member";
};

const lockNote = async (tx: Tx, organizationId: OrganizationId, noteId: NoteId) => {
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "memory_note" WHERE "id" = ${noteId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  return locked.length === 0 ? null : tx.memoryNote.findUniqueOrThrow({ where: { id: noteId } });
};

/** Who saved the note's current version: what a conflict names. */
const lastEditor = async (tx: Tx, noteId: string, version: number): Promise<MemberId | null> => {
  const row = await tx.memoryNoteVersion.findFirst({ where: { noteId, version }, select: { editedByMemberId: true } });
  return row?.editedByMemberId === null || row?.editedByMemberId === undefined ? null : memberIdSchema.parse(row.editedByMemberId);
};

const conflictOf = async (tx: Tx, organizationId: OrganizationId, current: number, savedBy: MemberId | null): Promise<NoteConflict> => ({
  ok: false,
  error: "conflict",
  message: `Version ${String(current)} was saved by ${await memberName(tx, organizationId, savedBy)} since you opened this note.`,
  currentVersion: current,
  savedBy,
});

const scan = async (deps: NotesDeps, organizationId: OrganizationId, texts: readonly string[]): Promise<NoteSecretFound | null> => {
  const found = scanMemoryText(texts, await organizationSecretValues(deps.db, deps.adapters.secretStore, organizationId));
  return found.ok ? null : { ok: false, error: "secret-found", message: secretScanMessage(found.found), found: found.found };
};

// ---------- notes (F-109) ----------

export type SaveNoteResult =
  | { readonly ok: true; readonly noteId: NoteId; readonly version: number }
  | NoteConflict
  | NoteSecretFound
  | Failure<"forbidden" | "not-found" | "invalid-input">;

/**
 * Writes a new note, or edits one at the version the member opened. A saved note keeps its scope.
 * Every save writes a `MemoryNoteVersion`, numbered without gaps under the note's lock.
 */
export const saveNote = (async (deps: NotesDeps, scope: MemberScope, input): Promise<SaveNoteResult> => {
  const title = memoryNoteTitleSchema.safeParse(input.title);
  const body = memoryNoteBodySchema.safeParse(input.body);
  if (!title.success || !body.success || (input.scope === "project") !== (input.projectId !== null)) {
    return { ok: false, error: "invalid-input", message: "A note has a one-line title, a body of at most 4 KiB, and a project when it's a project's." };
  }
  const organizationId = scope.organizationId;
  const found = await scan(deps, organizationId, [title.data, body.data]);
  if (found !== null) {
    return found;
  }
  const now = new Date(deps.clock.now());
  if (input.noteId === null) {
    const access = await noteAccess(deps.db, organizationId, { projectId: input.projectId, authorMemberId: scope.memberId });
    if (access === null || !canWriteNote(scope, access)) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    return deps.db.$transaction(async (tx) => {
      const note = await tx.memoryNote.create({
        data: {
          organizationId,
          projectId: input.projectId,
          scope: input.scope,
          title: title.data,
          body: body.data,
          kind: input.kind,
          always: input.always,
          version: 1,
          sourceKind: "member",
          authorMemberId: scope.memberId,
          createdAt: now,
        },
        select: { id: true },
      });
      const noteId = noteIdSchema.parse(note.id);
      await tx.memoryNoteVersion.create({
        data: { organizationId, noteId, version: 1, title: title.data, body: body.data, kind: input.kind, always: input.always, editedByMemberId: scope.memberId, createdAt: now },
      });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: input.projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "memory.note-created",
        entity: "memory-note",
        entityId: noteId,
        data: { scope: input.scope, kind: input.kind, always: input.always },
      });
      return { ok: true, noteId, version: 1 } as const;
    });
  }
  const noteId = input.noteId;
  const expected = input.expectedVersion;
  return deps.db.$transaction(async (tx): Promise<SaveNoteResult> => {
    const note = await lockNote(tx, organizationId, noteId);
    if (note === null) {
      return notFound;
    }
    const access = await noteAccess(tx, organizationId, note);
    if (access === null || !canWriteNote(scope, access)) {
      return notFound;
    }
    if (note.status !== "active") {
      return { ok: false, error: "forbidden", message: "This note is archived." };
    }
    if (note.scope !== input.scope || note.projectId !== input.projectId) {
      return { ok: false, error: "invalid-input", message: "A saved note keeps its scope." };
    }
    if (expected === null) {
      return { ok: false, error: "invalid-input", message: "An edit names the version it was opened at." };
    }
    const check = checkNoteVersion({ version: note.version, lastEditedBy: await lastEditor(tx, note.id, note.version) }, expected);
    if (!check.ok) {
      return conflictOf(tx, organizationId, check.currentVersion, check.savedBy);
    }
    await tx.memoryNote.update({
      where: { id: note.id },
      data: { title: title.data, body: body.data, kind: input.kind, always: input.always, version: check.nextVersion, updatedAt: now },
    });
    await tx.memoryNoteVersion.create({
      data: {
        organizationId,
        noteId,
        version: check.nextVersion,
        title: title.data,
        body: body.data,
        kind: input.kind,
        always: input.always,
        editedByMemberId: scope.memberId,
        createdAt: now,
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: note.projectId === null ? null : projectIdSchema.parse(note.projectId),
      actor: { kind: "member", id: scope.memberId },
      action: "memory.note-edited",
      entity: "memory-note",
      entityId: noteId,
      data: { version: check.nextVersion, kind: input.kind, always: input.always },
    });
    return { ok: true, noteId, version: check.nextVersion };
  });
}) satisfies SaveNote;

const archiveInTx = async (
  deps: Pick<NotesDeps, "audit">,
  tx: Tx,
  scope: MemberScope,
  noteId: NoteId,
  at: Date,
): Promise<{ readonly ok: true; readonly archivedAt: number } | Failure<"forbidden" | "not-found">> => {
  const note = await lockNote(tx, scope.organizationId, noteId);
  if (note === null) {
    return notFound;
  }
  const access = await noteAccess(tx, scope.organizationId, note);
  if (access === null || !canWriteNote(scope, access)) {
    return notFound;
  }
  if (!canArchiveNote(scope, access)) {
    return { ok: false, error: "forbidden", message: "Only the note's author or an admin archives it." };
  }
  if (note.status === "archived") {
    return { ok: true, archivedAt: note.updatedAt.getTime() };
  }
  await tx.memoryNote.update({ where: { id: note.id }, data: { status: "archived", updatedAt: at } });
  await deps.audit.recordInTx(tx, {
    organizationId: scope.organizationId,
    projectId: note.projectId === null ? null : projectIdSchema.parse(note.projectId),
    actor: { kind: "member", id: scope.memberId },
    action: "memory.note-archived",
    entity: "memory-note",
    entityId: noteId,
  });
  return { ok: true, archivedAt: at.getTime() };
};

/** Archives a note: its author, or a project admin (an organization admin for an organization note). */
export const archiveNote = ((deps: NotesDeps, scope: MemberScope, input) =>
  deps.db.$transaction((tx) => archiveInTx(deps, tx, scope, input.noteId, new Date(deps.clock.now())))) satisfies ArchiveNote;

/** A note as a member reads it, or `null` when it isn't one their scope can open. */
export const readNoteForMember = async (db: DbOrTx, scope: MemberScope, noteId: NoteId): Promise<MemoryNote | null> => {
  const note = await db.memoryNote.findFirst({ where: { id: noteId, organizationId: scope.organizationId } });
  if (note === null) {
    return null;
  }
  const access = await noteAccess(db, scope.organizationId, note);
  if (access === null || !canWriteNote(scope, access)) {
    return null;
  }
  return { noteId, title: note.title, body: note.body, kind: note.kind, scope: note.scope, version: note.version };
};

// ---------- proposals' decisions (F-111) ----------

/** A "Remember this" proposal's comment, which a note made from it names as its source. */
const commentSourceOf = (proposal: {
  readonly sourceKind: "agent" | "closing_turn" | "diff_comment" | "pr_comment";
  readonly sourceRef: string | null;
}): { readonly kind: "diff_comment" | "pr_comment"; readonly ref: string } | null => {
  switch (proposal.sourceKind) {
    case "diff_comment":
    case "pr_comment":
      return proposal.sourceRef === null ? null : { kind: proposal.sourceKind, ref: proposal.sourceRef };
    case "agent":
    case "closing_turn":
      return null;
    default:
      return proposal.sourceKind satisfies never;
  }
};

export type DecideProposalResult =
  | { readonly ok: true; readonly noteId: NoteId | null }
  | NoteConflict
  | NoteSecretFound
  | Failure<"forbidden" | "not-found" | "not-proposed">;

const proposalNotFound = { ok: false, error: "not-found", message: "No such proposal" } as const;

/**
 * Decides a proposal in one transaction with its audit entry: a new note (version 1, the proposal
 * its source), a new note that replaces one it archives, a merge into a note at the version the
 * member opened (refused as a conflict when it has moved on), or a rejection. A decided proposal
 * can't be decided again. An approved note reaches the next session, never a running one.
 */
export const decideProposal = (async (deps: NotesDeps, scope: MemberScope, input): Promise<DecideProposalResult> => {
  const organizationId = scope.organizationId;
  if (input.decision === "merge") {
    const title = memoryNoteTitleSchema.safeParse(input.title);
    const body = memoryNoteBodySchema.safeParse(input.body);
    if (!title.success || !body.success) {
      return { ok: false, error: "forbidden", message: "A merged note has a one-line title and a body of at most 4 KiB." };
    }
    const found = await scan(deps, organizationId, [title.data, body.data]);
    if (found !== null) {
      return found;
    }
  }
  const now = new Date(deps.clock.now());
  return deps.db.$transaction(async (tx): Promise<DecideProposalResult> => {
    const locked = await tx.$queryRaw<readonly unknown[]>`
      SELECT 1 FROM "memory_proposal" WHERE "id" = ${input.proposalId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    if (locked.length === 0) {
      return proposalNotFound;
    }
    const proposal = await tx.memoryProposal.findUniqueOrThrow({ where: { id: input.proposalId } });
    const access = await noteAccess(tx, organizationId, { projectId: proposal.projectId, authorMemberId: null });
    if (access === null || !canWriteNote(scope, access)) {
      return proposalNotFound;
    }
    if (proposal.state !== "proposed") {
      return { ok: false, error: "not-proposed", message: "This proposal was already decided." };
    }
    const projectId = proposal.projectId === null ? null : projectIdSchema.parse(proposal.projectId);
    const proposalId = proposalIdSchema.parse(proposal.id);
    const audit = (action: "memory.proposal-approved" | "memory.proposal-merged" | "memory.proposal-rejected", entityId: NoteId | ProposalId, data: Readonly<Record<string, string | number | boolean | null>> = {}) =>
      deps.audit.recordInTx(tx, { organizationId, projectId, actor: { kind: "member", id: scope.memberId }, action, entity: "memory-proposal", entityId, data });
    const decided = (state: "approved" | "rejected" | "merged", resultNoteId: NoteId | null) =>
      tx.memoryProposal.update({ where: { id: proposal.id }, data: { state, decidedByMemberId: scope.memberId, decidedAt: now, resultNoteId } });

    const approve = async (): Promise<NoteId> => {
      // A comment's proposal keeps the comment as the note's source; an agent's is "approved by".
      const fromComment = commentSourceOf(proposal);
      const note = await tx.memoryNote.create({
        data: {
          organizationId,
          projectId: proposal.projectId,
          scope: proposal.scope,
          title: proposal.title,
          body: proposal.body,
          kind: proposal.kind,
          version: 1,
          sourceKind: fromComment?.kind ?? "proposal",
          sourceTaskId: proposal.taskId,
          sourceRef: fromComment?.ref ?? proposal.id,
          authorMemberId: fromComment === null ? scope.memberId : (proposal.proposedByMemberId ?? scope.memberId),
          createdAt: now,
        },
        select: { id: true },
      });
      const noteId = noteIdSchema.parse(note.id);
      await tx.memoryNoteVersion.create({
        data: { organizationId, noteId, version: 1, title: proposal.title, body: proposal.body, kind: proposal.kind, always: false, editedByMemberId: scope.memberId, proposalId, createdAt: now },
      });
      await decided("approved", noteId);
      return noteId;
    };

    switch (input.decision) {
      case "approve": {
        const noteId = await approve();
        await audit("memory.proposal-approved", proposalId, { noteId });
        return { ok: true, noteId };
      }
      case "approve_and_archive": {
        const archived = await archiveInTx(deps, tx, scope, input.archiveNoteId, now);
        if (!archived.ok) {
          return archived;
        }
        const noteId = await approve();
        await audit("memory.proposal-approved", proposalId, { noteId, archivedNoteId: input.archiveNoteId });
        return { ok: true, noteId };
      }
      case "merge": {
        const note = await lockNote(tx, organizationId, input.intoNoteId);
        const target = note === null ? null : await noteAccess(tx, organizationId, note);
        if (note === null || target === null || !canWriteNote(scope, target) || note.status !== "active") {
          return notFound;
        }
        const check = checkNoteVersion({ version: note.version, lastEditedBy: await lastEditor(tx, note.id, note.version) }, input.expectedVersion);
        if (!check.ok) {
          return conflictOf(tx, organizationId, check.currentVersion, check.savedBy);
        }
        // A merged comment becomes the note's source, as "Remember this" promises (spec step 9).
        const fromComment = commentSourceOf(proposal);
        await tx.memoryNote.update({
          where: { id: note.id },
          data: {
            title: input.title,
            body: input.body,
            version: check.nextVersion,
            updatedAt: now,
            ...(fromComment === null ? {} : { sourceKind: fromComment.kind, sourceRef: fromComment.ref, sourceTaskId: proposal.taskId }),
          },
        });
        await tx.memoryNoteVersion.create({
          data: {
            organizationId,
            noteId: note.id,
            version: check.nextVersion,
            title: input.title,
            body: input.body,
            kind: note.kind,
            always: note.always,
            editedByMemberId: scope.memberId,
            proposalId,
            createdAt: now,
          },
        });
        const noteId = noteIdSchema.parse(note.id);
        await decided("merged", noteId);
        await audit("memory.proposal-merged", proposalId, { noteId, version: check.nextVersion });
        return { ok: true, noteId };
      }
      case "reject":
        await decided("rejected", null);
        await audit("memory.proposal-rejected", proposalId);
        return { ok: true, noteId: null };
      default:
        return input satisfies never;
    }
  });
}) satisfies DecideProposal;

/** A note that may relate to a proposal: the agent's declared one, and the best-ranking others. */
export type RelatedNote = {
  readonly noteId: NoteId;
  readonly title: string;
  readonly version: number;
  /** The agent's declared relation, or `null` for a note ranked by its text. */
  readonly relation: "contradicts" | "refines" | null;
};

/**
 * The notes to show beside a proposal: the one it declares it relates to, then the three active
 * notes of its scope that rank highest against its title and body (`ts_rank`), by bound parameter.
 */
export const relatedNotes = async (db: DbOrTx, scope: MemberScope, proposalId: ProposalId): Promise<readonly RelatedNote[] | null> => {
  const proposal = await db.memoryProposal.findFirst({ where: { id: proposalId, organizationId: scope.organizationId } });
  if (proposal === null) {
    return null;
  }
  const access = await noteAccess(db, scope.organizationId, { projectId: proposal.projectId, authorMemberId: null });
  if (access === null || !canWriteNote(scope, access)) {
    return null;
  }
  const declared =
    proposal.relatesToNoteId === null
      ? null
      : await db.memoryNote.findFirst({
          where: { id: proposal.relatesToNoteId, organizationId: scope.organizationId, status: "active" },
          select: { id: true, title: true, version: true },
        });
  const words = queryWords(`${proposal.title} ${proposal.body}`);
  const ranked =
    words.length === 0
      ? []
      : await db.$queryRaw<readonly { id: string; title: string; version: number }[]>`
          SELECT "id", "title", "version"
          FROM "memory_note"
          WHERE "organizationId" = ${scope.organizationId}
            AND "status" = 'active'
            AND ("projectId" IS NULL OR "projectId" = ${proposal.projectId})
            AND "id" <> ${proposal.relatesToNoteId ?? ""}
            AND "vector" @@ to_tsquery('simple', ${words.map((word) => `${word}:*`).join(" | ")})
          ORDER BY ts_rank("vector", to_tsquery('simple', ${words.map((word) => `${word}:*`).join(" | ")})) DESC, "updatedAt" DESC, "id"
          LIMIT 3`;
  const relation = proposal.relation;
  return [
    ...(declared === null ? [] : [{ noteId: noteIdSchema.parse(declared.id), title: declared.title, version: declared.version, relation }]),
    ...ranked.map((row) => ({ noteId: noteIdSchema.parse(row.id), title: row.title, version: row.version, relation: null })),
  ];
};

// ---------- "Remember this" (F-111) ----------

export type RememberThisResult =
  | { readonly ok: true; readonly proposalId: ProposalId }
  | NoteSecretFound
  | Failure<"forbidden" | "not-found" | "invalid-input">;

/**
 * "Remember this" on a diff comment (F-072) or an accepted `@ostra` PR comment (F-053): a project
 * proposal whose body is the comment's text as the member edited it, its source the comment,
 * proposed by the member who pressed it. Scanned like any other; in the thread and the audit log.
 */
export const proposeRememberThis = (async (deps: NotesDeps, scope: MemberScope, input): Promise<RememberThisResult> => {
  const title = memoryNoteTitleSchema.safeParse(input.title);
  const body = memoryNoteBodySchema.safeParse(input.body);
  if (!title.success || !body.success) {
    return { ok: false, error: "invalid-input", message: "A proposal has a one-line title and a body of at most 4 KiB." };
  }
  const organizationId = scope.organizationId;
  const task = await deps.db.task.findFirst({ where: { id: input.taskId, organizationId }, select: { projectId: true } });
  const project = task === null ? "missing" : await projectAccess(deps.db, organizationId, task.projectId);
  if (task === null || project === null || project === "missing" || !requireProjectAccess(scope, project, "read").ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const sourceFound = await commentOfTask(deps.db, input.taskId, input.source);
  if (!sourceFound) {
    return { ok: false, error: "not-found", message: "No such comment on this task" };
  }
  const found = await scan(deps, organizationId, [title.data, body.data]);
  if (found !== null) {
    return found;
  }
  const projectId = project.id;
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const proposal = await tx.memoryProposal.create({
      data: {
        organizationId,
        projectId,
        scope: "project",
        title: title.data,
        body: body.data,
        kind: input.kind,
        sourceKind: input.source.kind,
        sourceRef: input.source.kind === "diff_comment" ? input.source.commentId : input.source.url,
        taskId: input.taskId,
        proposedByMemberId: scope.memberId,
        createdAt: new Date(now),
      },
      select: { id: true },
    });
    const proposalId = proposalIdSchema.parse(proposal.id);
    const session = await tx.session.findFirst({ where: { taskId: input.taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId: organizationIdSchema.parse(organizationId),
        projectId,
        taskId: input.taskId,
        sessionId: sessionIdSchema.parse(session.id),
        at: now,
        event: { kind: "memory.proposed", proposalId, title: title.data },
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "memory.proposal-created",
      entity: "memory-proposal",
      entityId: proposalId,
      data: { taskId: input.taskId, source: input.source.kind, scope: "project" },
    });
    return { ok: true, proposalId } as const;
  });
}) satisfies RememberThis;

/** Whether the comment is the task's: a diff comment of it, or an `@ostra` comment it received. */
const commentOfTask = async (db: DbOrTx, taskId: TaskId, source: RememberThisSource): Promise<boolean> => {
  switch (source.kind) {
    case "diff_comment": {
      const comment = diffCommentIdSchema.safeParse(source.commentId);
      return comment.success && (await db.diffComment.count({ where: { id: comment.data, taskId } })) > 0;
    }
    case "pr_comment":
      return (await db.event.count({ where: { taskId, kind: "pr.comment_received", payload: { path: ["url"], equals: source.url } } })) > 0;
    default:
      return source satisfies never;
  }
};

/** The kinds and scopes, for a caller that builds a note's input. */
export type { MemoryKind, MemoryScope, ProjectId };
