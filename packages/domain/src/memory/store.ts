import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db, DbOrTx, Tx } from "@ostra/db";
import {
  memberIdSchema,
  noteIdSchema,
  organizationIdSchema,
  projectIdSchema,
  proposalIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { MemoryKind, MemoryNote, MemoryScope, MemorySearchResult, NoteId, OrganizationId, ProjectId, ProposalId, TaskSpecMemory } from "@ostra/protocol";

import type { AuditLog, Clock } from "../ports.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import type { BuildMemoryBlock, ProposeNote, RecordMemoryUse, SearchNotes } from "../use-cases/m4-signatures.ts";
import { buildMemoryIndex, defaultMemoryLimits, renderMemoryBlock } from "./block.ts";
import type { BlockNote, MemoryLimits, NoteSource } from "./block.ts";
import { scanMemoryText } from "./secret-scan.ts";

// Memory's store (F-110, F-111, ADR 0044 amended, Q91; milestone 4's ticket 15): what a session
// starts with, what the memory tools read, and what an agent proposes. Every query is scoped to
// one organization and, for project notes, one project, with the text as a bound parameter. A
// note's text, a query and a proposal's text never reach a log line.

/** The notes a session of `projectId` may see: the project's own and the organization's. */
const visibleNotes = (organizationId: OrganizationId, projectId: ProjectId | null) => ({
  organizationId,
  status: "active" as const,
  OR: projectId === null ? [{ projectId: null }] : [{ projectId: null }, { projectId }],
});

const sourceOf = (
  row: { readonly sourceKind: string; readonly sourceTaskId: string | null; readonly authorMemberId: string | null },
  names: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): NoteSource => {
  const author = row.authorMemberId === null ? "a former member" : (names.get(row.authorMemberId) ?? "a former member");
  switch (row.sourceKind) {
    case "task":
      return row.sourceTaskId === null
        ? { kind: "member", memberName: author }
        : { kind: "task", taskId: taskIdSchema.parse(row.sourceTaskId), taskTitle: titles.get(row.sourceTaskId) ?? "an earlier task" };
    case "diff_comment":
      return { kind: "diff_comment", memberName: author };
    case "pr_comment":
      return { kind: "pr_comment", memberName: author };
    case "proposal":
      return { kind: "proposal", approvedBy: author };
    default:
      return { kind: "member", memberName: author };
  }
};

/** The active notes of a project and its organization, as the index builder reads them. */
export const loadBlockNotes = async (db: DbOrTx, organizationId: OrganizationId, projectId: ProjectId): Promise<readonly BlockNote[]> => {
  const rows = await db.memoryNote.findMany({
    where: visibleNotes(organizationId, projectId),
    select: {
      id: true,
      scope: true,
      kind: true,
      title: true,
      body: true,
      always: true,
      lastUsedAt: true,
      updatedAt: true,
      sourceKind: true,
      sourceTaskId: true,
      authorMemberId: true,
    },
  });
  const memberIds = [...new Set(rows.flatMap((row) => (row.authorMemberId === null ? [] : [row.authorMemberId])))];
  const taskIds = [...new Set(rows.flatMap((row) => (row.sourceTaskId === null ? [] : [row.sourceTaskId])))];
  const [members, tasks] = await Promise.all([
    memberIds.length === 0
      ? []
      : db.member.findMany({ where: { id: { in: memberIds }, organizationId }, select: { id: true, user: { select: { name: true } } } }),
    taskIds.length === 0 ? [] : db.task.findMany({ where: { id: { in: taskIds }, organizationId }, select: { id: true, title: true } }),
  ]);
  const names = new Map(members.map((member) => [member.id, member.user.name]));
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return rows.map((row) => ({
    noteId: noteIdSchema.parse(row.id),
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    body: row.body,
    always: row.always,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
    updatedAt: row.updatedAt.getTime(),
    source: sourceOf(row, names, titles),
    authorMemberId: row.authorMemberId === null ? null : memberIdSchema.parse(row.authorMemberId),
  }));
};

/**
 * The spec's `memory` section (F-110): the "always" notes in full, then the index in ADR 0044's
 * order, cut at the limits and rendered into one block. `null` when the project and its
 * organization have no active note.
 */
export const buildMemoryBlock = (async (db: Db, input, limits: MemoryLimits = defaultMemoryLimits): Promise<TaskSpecMemory | null> => {
  const notes = await loadBlockNotes(db, input.organizationId, input.projectId);
  if (notes.length === 0) {
    return null;
  }
  return renderMemoryBlock(buildMemoryIndex(notes, limits), input.tools);
}) satisfies BuildMemoryBlock;

// ---------- the memory tools (the sidecar's endpoints) ----------

/** The words of a query, for the prefix query and the matched line. Letters, digits and `_` only. */
export const queryWords = (query: string): readonly string[] =>
  [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((word) => word.length > 0).slice(0, 32);

/** The note's line that holds most of the query's words: what a result shows instead of the body. */
const bestLine = (title: string, body: string, words: readonly string[]): string => {
  let best = title;
  let bestHits = 0;
  for (const line of body.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    const hits = words.filter((word) => lower.includes(word)).length;
    if (hits > bestHits && line.trim() !== "") {
      best = line.trim();
      bestHits = hits;
    }
  }
  const chars: string[] = [];
  for (const char of best) {
    chars.push(char);
  }
  return chars.length <= runnerLimits.memoryQueryMaxChars ? best : `${chars.slice(0, runnerLimits.memoryQueryMaxChars - 1).join("")}…`;
};

/**
 * Full-text search over the active notes of the organization and, when given, the project
 * (`memory_search`). Each word matches as a prefix and any word may match; results are ranked
 * with `ts_rank`. The query is a bound parameter, and at most 20 results come back.
 */
export const searchNotes = (async (db, input): Promise<readonly MemorySearchResult[]> => {
  const words = queryWords(input.query);
  if (words.length === 0) {
    return [];
  }
  const tsquery = words.map((word) => `${word}:*`).join(" | ");
  const limit = Math.max(1, Math.min(input.limit, runnerLimits.memorySearchResultsMax));
  const rows = await db.$queryRaw<readonly { id: string; title: string; body: string; kind: MemoryKind; scope: MemoryScope }[]>`
    SELECT "id", "title", "body", "kind"::text AS "kind", "scope"::text AS "scope"
    FROM "memory_note"
    WHERE "organizationId" = ${input.organizationId}
      AND "status" = 'active'
      AND ("projectId" IS NULL OR "projectId" = ${input.projectId})
      AND "vector" @@ to_tsquery('simple', ${tsquery})
    ORDER BY ts_rank("vector", to_tsquery('simple', ${tsquery})) DESC, "updatedAt" DESC, "id"
    LIMIT ${limit}`;
  return rows.map((row) => ({
    noteId: noteIdSchema.parse(row.id),
    title: row.title,
    line: bestLine(row.title, row.body, words),
    kind: row.kind,
    scope: row.scope,
  }));
}) satisfies SearchNotes;

/** One active note of the project or its organization (`memory_read`), or `null` for any other. */
export const readNote = async (
  db: DbOrTx,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly noteId: NoteId },
): Promise<MemoryNote | null> => {
  const row = await db.memoryNote.findFirst({
    where: { id: input.noteId, ...visibleNotes(input.organizationId, input.projectId) },
    select: { id: true, title: true, body: true, kind: true, scope: true, version: true },
  });
  return row === null ? null : { noteId: noteIdSchema.parse(row.id), title: row.title, body: row.body, kind: row.kind, scope: row.scope, version: row.version };
};

/**
 * `memory.used` (F-110, ADR 0044, Q91): one row per session, note and way, every one of them. Only
 * `read` and `search` move a note's `lastUsedAt` and `useCount`, once per session: a note listed in
 * the index, or carried in full, isn't "used" by being shown, so the index doesn't keep its own
 * notes in it. A note ID of another organization, or of another project, is dropped.
 */
export const recordMemoryUse = (async (tx: Tx, input): Promise<void> => {
  const task = await tx.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId }, select: { projectId: true } });
  if (task === null || input.noteIds.length === 0) {
    return;
  }
  const projectId = projectIdSchema.parse(task.projectId);
  const known = await tx.memoryNote.findMany({
    where: { id: { in: [...new Set(input.noteIds)] }, organizationId: input.organizationId, OR: [{ projectId: null }, { projectId }] },
    select: { id: true },
  });
  if (known.length === 0) {
    return;
  }
  const ids = known.map((note) => note.id);
  const already = await tx.memoryUse.findMany({ where: { sessionId: input.sessionId, via: input.via, noteId: { in: ids } }, select: { noteId: true } });
  const seen = new Set(already.map((row) => row.noteId));
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length === 0) {
    return;
  }
  const at = new Date(input.at);
  await tx.memoryUse.createMany({
    data: fresh.map((noteId) => ({
      organizationId: input.organizationId,
      projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      noteId,
      via: input.via,
      at,
    })),
    skipDuplicates: true,
  });
  switch (input.via) {
    case "read":
    case "search":
      await tx.memoryNote.updateMany({
        where: { id: { in: fresh }, organizationId: input.organizationId },
        data: { lastUsedAt: at, useCount: { increment: 1 } },
      });
      return;
    case "index":
    case "always":
      return;
    default:
      return input.via satisfies never;
  }
}) satisfies RecordMemoryUse;

// ---------- proposals (F-111) ----------

/**
 * The organization's stored secret values, for the scan: its environments' secrets and its model
 * providers' tokens. Read through the secret store; never logged, never returned.
 */
export const organizationSecretValues = async (
  db: DbOrTx,
  secretStore: Pick<SecretStoreAdapter, "get">,
  organizationId: OrganizationId,
): Promise<readonly string[]> => {
  const [entries, providers] = await Promise.all([
    db.environmentEntry.findMany({ where: { organizationId, kind: "secret", secretRef: { not: null } }, select: { secretRef: true } }),
    db.modelProvider.findMany({ where: { organizationId }, select: { tokenSecretRef: true } }),
  ]);
  const refs = [...new Set([...entries.map((entry) => entry.secretRef), ...providers.map((provider) => provider.tokenSecretRef)])];
  const values: string[] = [];
  for (const raw of refs) {
    const ref = secretRefSchema.safeParse(raw);
    if (!ref.success) {
      continue;
    }
    const value = await secretStore.get(organizationId, ref.data);
    if (value.ok) {
      values.push(value.value);
    }
  }
  return values;
};

/** `proposeNote`'s answer: a secret refusal names each kind found (never the value), for the agent's words. */
export type ProposeNoteResult =
  | { readonly ok: true; readonly proposalId: ProposalId }
  | { readonly ok: false; readonly error: "secret-found"; readonly message: string; readonly found: readonly string[] }
  | { readonly ok: false; readonly error: "limit-reached" | "invalid" | "not-found"; readonly message: string };

export type ProposeNoteDeps = {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: { readonly secretStore: Pick<SecretStoreAdapter, "get"> };
  /** `OSTRA_MEMORY_PROPOSALS_PER_TASK`. */
  readonly proposalsPerTask?: number;
};

/**
 * An agent's proposal (`memory_propose`, or the closing turn): the secret scan, then the task's
 * cap, then a `MemoryProposal` with the task and session, `memory.proposed` in the thread and an
 * audit entry, in one transaction. A refusal stores nothing. It reaches no spec until a member
 * approves it.
 */
export const proposeNote = (async (deps: ProposeNoteDeps, input): Promise<ProposeNoteResult> => {
  const secrets = await organizationSecretValues(deps.db, deps.adapters.secretStore, input.organizationId);
  const scan = scanMemoryText([input.title, input.body], secrets);
  if (!scan.ok) {
    return { ok: false, error: "secret-found", message: `The proposal holds ${scan.found.join(", ")}.`, found: scan.found } as const;
  }
  const cap = deps.proposalsPerTask ?? runnerLimits.memoryProposalsPerTask;
  return deps.db.$transaction(async (tx) => {
    // The task's lock: two proposals at once can't both take the last place under the cap.
    const locked = await tx.$queryRaw<readonly { projectId: string }[]>`
      SELECT "projectId" FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
    const projectRow = locked[0];
    if (projectRow === undefined) {
      return { ok: false, error: "not-found", message: "No such task" } as const;
    }
    const projectId = projectIdSchema.parse(projectRow.projectId);
    const made = await tx.memoryProposal.count({ where: { organizationId: input.organizationId, taskId: input.taskId, sourceKind: { in: ["agent", "closing_turn"] } } });
    if (made >= cap) {
      return { ok: false, error: "limit-reached", message: `This task has made its ${String(cap)} proposals.` } as const;
    }
    if (input.relatesTo !== null) {
      const related = await tx.memoryNote.findFirst({
        where: { id: input.relatesTo, organizationId: input.organizationId, OR: [{ projectId: null }, { projectId }] },
        select: { id: true },
      });
      if (related === null) {
        return { ok: false, error: "invalid", message: "The note it relates to isn't one this task can see." } as const;
      }
    }
    const session =
      input.sessionId ??
      (await tx.session.findFirst({ where: { taskId: input.taskId }, orderBy: { startedAt: "desc" }, select: { id: true } }).then((row) =>
        row === null ? null : sessionIdSchema.parse(row.id),
      ));
    const now = deps.clock.now();
    const proposal = await tx.memoryProposal.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.scope === "project" ? projectId : null,
        scope: input.scope,
        title: input.title,
        body: input.body,
        kind: input.kind,
        sourceKind: input.source,
        taskId: input.taskId,
        sessionId: session,
        relatesToNoteId: input.relatesTo,
        relation: input.relation,
        createdAt: new Date(now),
      },
      select: { id: true },
    });
    const proposalId = proposalIdSchema.parse(proposal.id);
    if (session !== null) {
      await appendServerEvent(tx, {
        organizationId: organizationIdSchema.parse(input.organizationId),
        projectId,
        taskId: input.taskId,
        sessionId: session,
        at: now,
        event: { kind: "memory.proposed", proposalId, title: input.title },
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId: input.organizationId,
      projectId,
      actor: { kind: "system", id: null },
      action: "memory.proposal-created",
      entity: "memory-proposal",
      entityId: proposalId,
      data: { taskId: input.taskId, source: input.source, scope: input.scope },
    });
    return { ok: true, proposalId } as const;
  });
}) satisfies ProposeNote;
