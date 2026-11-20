import type { Db } from "@ostra/db";
import { Prisma } from "@ostra/db";
import type { ProjectId, RepoId, SearchEntryId, TaskId } from "@ostra/protocol";
import { projectIdSchema, searchEntryIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { visibleProjects } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { SearchTasksInput } from "../use-cases/m4-signatures.ts";

// The search query (F-080, ADR 0054; milestone 4, ticket 11): one SQL statement, bound parameters
// only. The organization and the projects the member can open are in its `where`, so a task the
// member can't open is never fetched, ranked or counted. The filters are columns; the text goes
// through `websearch_to_tsquery('simple', …)`, with its last word as a prefix ("migr" finds
// "migration"). Results are tasks, each once, ranked by its best entry, with its top three
// snippets. A query of filters only lists tasks by recency. The text is never logged.

/** The filters beyond the signature's (ticket 11): a project and a period, on the task. */
export type SearchFilters = SearchTasksInput & {
  readonly projectId?: ProjectId | null;
  /**
   * Every repo row a `repo:` filter names. A repo of the org has a row in each project that lists
   * it, so `repo:test2` names several: a task matches if it uses any of them.
   */
  readonly repoIds?: readonly RepoId[] | null;
  /** The task's creation, in ms since the epoch: from, inclusive, and to, exclusive. */
  readonly from?: number | null;
  readonly to?: number | null;
};

/** A snippet's parts: the matched words are `match: true`. Text, never HTML. */
export type SnippetPart = { readonly text: string; readonly match: boolean };

export type SearchSnippet = {
  readonly entryId: SearchEntryId;
  readonly kind: "title" | "prompt" | "ticket" | "member_message" | "agent_message" | "tool_input" | "pr";
  /** The event's place in the thread; `null` for the title, the prompt and the ticket. */
  readonly eventSeq: number | null;
  readonly parts: readonly SnippetPart[];
};

export type SearchResult = {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  /** The matched entries, best first, at most three. */
  readonly matched: readonly SearchEntryId[];
  readonly rank: number;
  readonly snippets: readonly SearchSnippet[];
};

const START = "\u0001";
const STOP = "\u0002";

/** The highlighted headline into parts; the markers are control characters stripped from the text first. */
export const snippetParts = (headline: string): SnippetPart[] => {
  const parts: SnippetPart[] = [];
  let rest = headline;
  while (rest.length > 0) {
    const open = rest.indexOf(START);
    if (open === -1) {
      parts.push({ text: rest, match: false });
      break;
    }
    if (open > 0) {
      parts.push({ text: rest.slice(0, open), match: false });
    }
    const close = rest.indexOf(STOP, open + 1);
    const end = close === -1 ? rest.length : close;
    parts.push({ text: rest.slice(open + 1, end), match: true });
    rest = close === -1 ? "" : rest.slice(close + 1);
  }
  // Two highlighted words in a row arrive as two parts: one part per run reads better.
  return parts.reduce<SnippetPart[]>((merged, part) => {
    const last = merged[merged.length - 1];
    if (last?.match === part.match) {
      merged[merged.length - 1] = { text: last.text + part.text, match: part.match };
    } else {
      merged.push(part);
    }
    return merged;
  }, []);
};

/**
 * The text as two bound parts: everything but the last word for `websearch_to_tsquery`, and the
 * last word, made of letters, digits and `_` only, for a prefix match. A text ending in a quote,
 * an operator or punctuation has no prefix word, and all of it goes to `websearch_to_tsquery`.
 */
export const splitQueryText = (text: string): { readonly head: string; readonly prefix: string | null } => {
  const trimmed = text.trim();
  // A word of letters, digits and `_`, with the `.` and `-` inside a file's or a package's name.
  const match = /(^|\s)([\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*)$/u.exec(trimmed);
  if (match?.[2] === undefined || trimmed.slice(0, match.index).replace(/"[^"]*"/g, "").includes('"')) {
    return { head: trimmed, prefix: null };
  }
  return { head: trimmed.slice(0, match.index).trim(), prefix: match[2].toLowerCase() };
};

const rowSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  rank: z.number(),
  snippets: z
    .array(z.object({ id: z.string(), kind: z.enum(["title", "prompt", "ticket", "member_message", "agent_message", "tool_input", "pr"]), eventSeq: z.number().int().nullable(), headline: z.string() }))
    .nullable(),
});

/** The task-level filters, the same for a text search and a filters-only one. */
const taskFilters = (scope: MemberScope, visible: readonly string[], input: SearchFilters): Prisma.Sql => {
  const parts: Prisma.Sql[] = [Prisma.sql`t."organizationId" = ${scope.organizationId}`, Prisma.sql`t."projectId" = ANY(${visible}::text[])`];
  if (input.projectId !== undefined && input.projectId !== null) {
    parts.push(Prisma.sql`t."projectId" = ${input.projectId}`);
  }
  if (input.ticketKey !== null) {
    parts.push(Prisma.sql`upper(t."ticketKey") = upper(${input.ticketKey})`);
  }
  if (input.repoId !== null) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "task_repo" r WHERE r."taskId" = t.id AND r."repoId" = ${input.repoId})`);
  }
  if (input.repoIds !== undefined && input.repoIds !== null) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM "task_repo" r WHERE r."taskId" = t.id AND r."repoId" = ANY(${[...input.repoIds]}::text[]))`);
  }
  if (input.memberId !== null) {
    parts.push(
      Prisma.sql`(t."creatorMemberId" = ${input.memberId} OR t."driverMemberId" = ${input.memberId} OR EXISTS (SELECT 1 FROM "search_entry" a WHERE a."taskId" = t.id AND a."authorMemberId" = ${input.memberId}))`,
    );
  }
  if (input.state !== null) {
    parts.push(Prisma.sql`t.state::text = ${input.state}`);
  }
  if (input.from !== undefined && input.from !== null) {
    parts.push(Prisma.sql`t."createdAt" >= ${new Date(input.from)}`);
  }
  if (input.to !== undefined && input.to !== null) {
    parts.push(Prisma.sql`t."createdAt" < ${new Date(input.to)}`);
  }
  return Prisma.join(parts, " AND ");
};

/**
 * Searches the member's tasks. Access is in the query: the organization of the scope and the
 * projects `visibleProjects` gives it.
 */
export const searchTasks = async (db: Db, scope: MemberScope, input: SearchFilters): Promise<readonly SearchResult[]> => {
  const projects = await db.project.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, access: true } });
  const visible = visibleProjects(
    scope,
    projects.map((project) => ({ id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access })),
  ).map((project) => project.id);
  if (visible.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(input.limit, 100));
  const filters = taskFilters(scope, visible, input);
  const text = input.text?.trim() ?? "";

  const rows =
    text === ""
      ? await db.$queryRaw<unknown[]>`
          SELECT t.id AS "taskId", t."projectId" AS "projectId", 0::float8 AS rank, NULL::json AS snippets
          FROM "task" t
          WHERE ${filters}
          ORDER BY t."createdAt" DESC, t.id DESC
          LIMIT ${limit}`
      : await (async () => {
          const { head, prefix } = splitQueryText(text);
          const query =
            prefix === null
              ? Prisma.sql`websearch_to_tsquery('simple', ${head})`
              : head === ""
                ? Prisma.sql`to_tsquery('simple', ${`${prefix}:*`})`
                : Prisma.sql`(websearch_to_tsquery('simple', ${head}) && to_tsquery('simple', ${`${prefix}:*`}))`;
          return db.$queryRaw<unknown[]>`
            WITH q AS (SELECT ${query} AS query),
            hits AS (
              SELECT e.id, e."taskId", e."projectId", e.kind, e."eventSeq", e.text, ts_rank(e.vector, q.query) AS rank, t."createdAt" AS "taskCreatedAt"
              FROM "search_entry" e
              JOIN "task" t ON t.id = e."taskId" AND t."projectId" = e."projectId"
              CROSS JOIN q
              WHERE e."organizationId" = ${scope.organizationId}
                AND e."projectId" = ANY(${visible}::text[])
                AND e.vector @@ q.query
                AND ${filters}
            ),
            best AS (
              SELECT h."taskId", h."projectId", h."taskCreatedAt", max(h.rank) AS best
              FROM hits h
              GROUP BY h."taskId", h."projectId", h."taskCreatedAt"
              ORDER BY best DESC, h."taskCreatedAt" DESC, h."taskId" DESC
              LIMIT ${limit}
            ),
            ranked AS (
              SELECT h.*, row_number() OVER (PARTITION BY h."taskId" ORDER BY h.rank DESC, h."eventSeq" ASC NULLS FIRST) AS n
              FROM hits h
              WHERE h."taskId" IN (SELECT b."taskId" FROM best b)
            )
            SELECT b."taskId" AS "taskId", b."projectId" AS "projectId", b.best::float8 AS rank,
                   json_agg(json_build_object(
                     'id', r.id, 'kind', r.kind, 'eventSeq', r."eventSeq",
                     'headline', ts_headline('simple', translate(r.text, ${`${START}${STOP}`}, ''), q.query, ${`StartSel=${START}, StopSel=${STOP}, MaxWords=24, MinWords=8, MaxFragments=1`})
                   ) ORDER BY r.n) AS snippets
            FROM best b
            JOIN ranked r ON r."taskId" = b."taskId" AND r.n <= 3
            CROSS JOIN q
            GROUP BY b."taskId", b."projectId", b.best, b."taskCreatedAt"
            ORDER BY b.best DESC, b."taskCreatedAt" DESC, b."taskId" DESC`;
        })();

  return rows.map((raw) => {
    const row = rowSchema.parse(raw);
    const snippets = (row.snippets ?? []).map((snippet) => ({
      entryId: searchEntryIdSchema.parse(snippet.id),
      kind: snippet.kind,
      eventSeq: snippet.eventSeq,
      parts: snippetParts(snippet.headline),
    }));
    return { taskId: taskIdSchema.parse(row.taskId), projectId: projectIdSchema.parse(row.projectId), matched: snippets.map((snippet) => snippet.entryId), rank: row.rank, snippets };
  });
};
