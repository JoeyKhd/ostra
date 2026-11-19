import { searchTasks, visibleProjects } from "@ostra/domain";
import type { MemberScope, SearchFilters } from "@ostra/domain";
import type { Db } from "@ostra/db";
import { memberIdSchema, projectIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { MemberId, ProjectId, RepoId } from "@ostra/protocol";
import { z } from "zod";

import { parseSearchQuery } from "../search/parse-query.ts";
import { memberProcedure, router } from "../trpc/init.ts";

// F-080 (ADR 0054, ticket 26): search over the member's tasks. The query's filter tokens become
// filters (`search/parse-query.ts`), and ticket 11's `searchTasks` runs one statement with the
// member's scope, so a task the member can't open is never matched, shown or counted. The text is
// never logged: a query's length and how many it found are.

/** How many results a search returns by default, at most, and what the palette shows. */
const DEFAULT_RESULTS = 20;
const MAX_RESULTS = 100;
const SUGGESTIONS = 8;

const snippetSchema = z.object({
  kind: z.enum(["title", "prompt", "ticket", "member_message", "agent_message", "tool_input", "pr"]),
  /** The event to open in the thread; `null` for the title, the prompt and the ticket. */
  eventSeq: z.number().int().nullable(),
  /** The snippet's text, with what matched marked. Text, never HTML. */
  parts: z.array(z.object({ text: z.string(), match: z.boolean() })),
});

const resultSchema = z.object({
  taskId: taskIdSchema,
  projectId: projectIdSchema,
  projectName: z.string(),
  state: z.string(),
  ticketKey: z.string().nullable(),
  title: z.string(),
  snippets: z.array(snippetSchema),
});

const searchOutputSchema = z.object({
  results: z.array(resultSchema),
  /** How many tasks matched, up to 100 (`totalCapped` when there may be more). */
  total: z.number().int(),
  totalCapped: z.boolean(),
});

const queryInputSchema = z.strictObject({ query: z.string().max(500), limit: z.number().int().min(1).max(MAX_RESULTS).optional() });

/** A filter whose name matches nothing the member can see: the search finds nothing. */
const NOTHING = Symbol("nothing");

/** The names in a query, as IDs inside the member's organization and visible projects. */
const resolveFilters = async (db: Db, scope: MemberScope, query: string): Promise<SearchFilters | typeof NOTHING> => {
  const parsed = parseSearchQuery(query);
  const organizationId = scope.organizationId;
  const projects = visibleProjects(
    scope,
    (await db.project.findMany({ where: { organizationId }, select: { id: true, access: true, slug: true, name: true } })).map((project) => ({
      ...project,
      id: projectIdSchema.parse(project.id),
      organizationId,
    })),
  );
  let projectId: ProjectId | null = null;
  if (parsed.project !== null) {
    const wanted = parsed.project.toLowerCase();
    const project = projects.find((candidate) => candidate.slug.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted);
    if (project === undefined) return NOTHING;
    projectId = project.id;
  }
  let repoId: RepoId | null = null;
  if (parsed.repo !== null) {
    const wanted = parsed.repo.toLowerCase();
    const repos = await db.repo.findMany({ where: { organizationId, projectId: { in: projects.map((project) => project.id) } }, select: { id: true, fullName: true } });
    const repo = repos.find((candidate) => candidate.fullName.toLowerCase() === wanted || candidate.fullName.toLowerCase().split("/").at(-1) === wanted);
    if (repo === undefined) return NOTHING;
    repoId = repoIdSchema.parse(repo.id);
  }
  let memberId: MemberId | null = null;
  if (parsed.by !== null) {
    if (parsed.by.toLowerCase() === "me") {
      memberId = scope.memberId;
    } else {
      const member = await db.member.findFirst({ where: { organizationId, user: { username: { equals: parsed.by, mode: "insensitive" } } }, select: { id: true } });
      if (member === null) return NOTHING;
      memberId = memberIdSchema.parse(member.id);
    }
  }
  return {
    text: parsed.text === "" ? null : parsed.text,
    ticketKey: parsed.ticket,
    repoId,
    memberId,
    state: parsed.status,
    projectId,
    from: parsed.after,
    to: parsed.before,
    limit: MAX_RESULTS,
  };
};

/** Runs a search for the member and shapes its first `limit` results. */
const runSearch = async (db: Db, scope: MemberScope, query: string, limit: number): Promise<z.infer<typeof searchOutputSchema>> => {
  const filters = await resolveFilters(db, scope, query);
  if (filters === NOTHING) {
    return { results: [], total: 0, totalCapped: false };
  }
  const found = await searchTasks(db, scope, filters);
  const shown = found.slice(0, limit);
  const tasks = await db.task.findMany({
    where: { organizationId: scope.organizationId, id: { in: shown.map((result) => result.taskId) } },
    select: { id: true, state: true, ticketKey: true, title: true, project: { select: { name: true } } },
  });
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  return {
    results: shown.flatMap((result) => {
      const task = byId.get(result.taskId);
      return task === undefined
        ? []
        : [
            {
              taskId: result.taskId,
              projectId: result.projectId,
              projectName: task.project.name,
              state: task.state,
              ticketKey: task.ticketKey,
              title: task.title,
              snippets: result.snippets.map((snippet) => ({ kind: snippet.kind, eventSeq: snippet.eventSeq, parts: [...snippet.parts] })),
            },
          ];
    }),
    total: found.length,
    totalCapped: found.length >= MAX_RESULTS,
  };
};

export const searchRouter = router({
  /** The search page: tasks the member can open, with what matched. */
  tasks: memberProcedure
    .input(queryInputSchema)
    .output(searchOutputSchema)
    .query(async ({ ctx, input }) => {
      const answer = await runSearch(ctx.deps.db, ctx.scope, input.query, input.limit ?? DEFAULT_RESULTS);
      ctx.deps.logger.info("search.tasks", { queryLength: input.query.length, total: answer.total });
      return answer;
    }),

  /** The palette's suggestions: the top 8, with the same access. The panel debounces it. */
  suggest: memberProcedure
    .input(z.strictObject({ query: z.string().max(500) }))
    .output(searchOutputSchema)
    .query(async ({ ctx, input }) => {
      const answer = await runSearch(ctx.deps.db, ctx.scope, input.query, SUGGESTIONS);
      ctx.deps.logger.info("search.suggest", { queryLength: input.query.length, total: answer.total });
      return answer;
    }),
});
