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
  /** The turn it sits in, counted over the task (`turn 2` in the panel); `null` without an event. */
  turn: z.number().int().nullable(),
});

const resultSchema = z.object({
  taskId: taskIdSchema,
  projectId: projectIdSchema,
  projectName: z.string(),
  state: z.enum(["awaiting_approval", "queued", "preparing", "running", "needs_you", "in_review", "stopped", "merged", "done"]),
  ticketKey: z.string().nullable(),
  title: z.string(),
  snippets: z.array(snippetSchema),
  /** The task's repos in the project's order, its driver's name and its PRs (search.md, the block's line 2 and the panel). */
  repos: z.array(z.string()),
  driverName: z.string().nullable(),
  prs: z.array(z.object({ number: z.number().int(), url: z.string(), state: z.enum(["open", "merged", "closed_unmerged"]) })),
  /** Epoch ms: the task's last change, and the newest matched entry's (the block's age). */
  updatedAt: z.number().int(),
  matchedAt: z.number().int().nullable(),
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
  // A repo has a row in each project that lists it: `repo:test2` names every one of them.
  let repoIds: readonly RepoId[] | null = null;
  if (parsed.repo !== null) {
    const wanted = parsed.repo.toLowerCase();
    const repos = await db.repo.findMany({ where: { organizationId, projectId: { in: projects.map((project) => project.id) } }, select: { id: true, fullName: true } });
    const named = repos.filter((candidate) => candidate.fullName.toLowerCase() === wanted || candidate.fullName.toLowerCase().split("/").at(-1) === wanted);
    if (named.length === 0) return NOTHING;
    repoIds = named.map((repo) => repoIdSchema.parse(repo.id));
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
    repoId: null,
    repoIds,
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
  const organizationId = scope.organizationId;
  const taskIds = shown.map((result) => result.taskId);
  const [tasks, turns, entries] = await Promise.all([
    db.task.findMany({
      where: { organizationId, id: { in: taskIds } },
      select: {
        id: true,
        state: true,
        ticketKey: true,
        title: true,
        updatedAt: true,
        driverMemberId: true,
        project: { select: { name: true } },
        repos: {
          orderBy: { repo: { position: "asc" } },
          select: { repo: { select: { fullName: true } }, pullRequests: { orderBy: { number: "asc" }, select: { number: true, url: true, state: true } } },
        },
      },
    }),
    db.turn.findMany({ where: { organizationId, taskId: { in: taskIds } }, orderBy: { startSeq: "asc" }, select: { taskId: true, startSeq: true } }),
    db.searchEntry.findMany({ where: { organizationId, id: { in: shown.flatMap((result) => [...result.matched]) } }, select: { taskId: true, createdAt: true } }),
  ]);
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const drivers = await db.member.findMany({
    where: { organizationId, id: { in: tasks.flatMap((task) => (task.driverMemberId === null ? [] : [task.driverMemberId])) } },
    select: { id: true, user: { select: { name: true } } },
  });
  const driverName = new Map(drivers.map((member) => [member.id, member.user.name] as const));
  /** The task-wide turn an event sits in: the turns that started at or before it. */
  const turnOf = (taskId: string, eventSeq: number | null): number | null => {
    if (eventSeq === null) return null;
    const count = turns.filter((turn) => turn.taskId === taskId && turn.startSeq <= eventSeq).length;
    return count === 0 ? null : count;
  };
  const matchedAt = new Map<string, number>();
  for (const entry of entries) {
    matchedAt.set(entry.taskId, Math.max(matchedAt.get(entry.taskId) ?? 0, entry.createdAt.getTime()));
  }
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
              snippets: result.snippets.map((snippet) => ({ kind: snippet.kind, eventSeq: snippet.eventSeq, parts: [...snippet.parts], turn: turnOf(result.taskId, snippet.eventSeq) })),
              repos: task.repos.map((taskRepo) => taskRepo.repo.fullName),
              driverName: task.driverMemberId === null ? null : (driverName.get(task.driverMemberId) ?? null),
              prs: task.repos.flatMap((taskRepo) => taskRepo.pullRequests.map((pr) => ({ number: pr.number, url: pr.url, state: pr.state }))),
              updatedAt: task.updatedAt.getTime(),
              matchedAt: matchedAt.get(result.taskId) ?? null,
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
