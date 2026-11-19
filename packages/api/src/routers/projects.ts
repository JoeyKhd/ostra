import {
  branchRuleCheckSchema,
  builtInTicketTemplate,
  checkProjectRepos,
  createProject,
  createProjectInputSchema,
  parseTicketTemplate,
  renderTicketPrompt,
  TICKET_TEMPLATE_MAX_CHARS,
  ticketTemplateFor,
  ticketTemplateVocabulary,
  visibleProjects,
} from "@ostra/domain";
import type { RepoChecked, TicketPromptContext } from "@ostra/domain";
import { environmentIdSchema, poolIdSchema, projectIdSchema, repoIdSchema, ticketIdSchema, ticketKeySchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, memberProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";
import { inboxCounts } from "./inbox.ts";
import { agentProfileViewSchema, loadAgentProfileView } from "./agent-profile-view.ts";
import { detectionViewSchema } from "./environments.ts";

// F-086, ticket 32: projects. A project is one repo linked through the organization's App, with its
// one environment. Another organization's projects, and a restricted one a member isn't on, are
// invisible: `list` leaves them out and `get` says `NOT_FOUND` (ADR 0026).

/** The states a task ends in: what the sidebar's count of active tasks leaves out. */
const finishedStates = ["stopped", "merged", "done"] as const;

const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string(),
  slug: z.string(),
  access: z.enum(["open", "restricted"]),
  repos: z.array(z.object({ repoId: repoIdSchema, fullName: z.string(), defaultBranch: z.string() })),
  /** Tasks waiting on a person, for the sidebar's amber dot. */
  needsYouCount: z.number().int(),
  runningCount: z.number().int(),
  /** Tasks in every state but stopped, merged and done, for the sidebar's Tasks count. */
  activeCount: z.number().int(),
  /** The open tickets in the Inbox's default filter (the mapped open statuses), for the sidebar's Inbox count. */
  inboxCount: z.number().int(),
  /** Epoch ms. */
  createdAt: z.number().int(),
});

/**
 * A repo as the project page shows it (F-055, F-060, ticket 31): what the code host says about the
 * default branch. Each check is `true`, `false` or `unknown`, with the reason when it is not a yes.
 */
const repoDetailSchema = z.object({
  repoId: repoIdSchema,
  fullName: z.string(),
  defaultBranch: z.string(),
  /** `null` until the code host has said. */
  private: z.boolean().nullable(),
  /** Epoch ms of the read the two checks are from, or `null` when they were never read. */
  checkedAt: z.number().int().nullable(),
  defaultBranchProtected: branchRuleCheckSchema,
  signedCommitsRequired: branchRuleCheckSchema,
});

const repoDetailOf = (checked: RepoChecked) => ({
  repoId: checked.repoId,
  fullName: checked.fullName,
  defaultBranch: checked.defaultBranch,
  private: checked.private,
  checkedAt: checked.checkedAt,
  defaultBranchProtected: checked.rules.protected,
  signedCommitsRequired: checked.rules.signedCommits,
});

const projectDetailSchema = projectSummarySchema.extend({
  repos: z.array(repoDetailSchema),
  /** The caller's role on it. */
  role: z.enum(["admin", "member"]),
  environmentStatus: z.enum(["draft", "saved"]).nullable(),
  /** The pools its tasks may go to. */
  pools: z.array(z.object({ poolId: poolIdSchema, name: z.string(), isDefault: z.boolean() })),
  /** The profile a prompt task uses (F-097): its agent and model, shown before the task starts. */
  defaultCodeProfile: agentProfileViewSchema.nullable(),
});

const createdSchema = z.object({
  projectId: projectIdSchema,
  repoId: repoIdSchema,
  environmentId: environmentIdSchema,
  detection: detectionViewSchema,
});

const templateProblemSchema = z.object({ line: z.number().int(), message: z.string() });

const vocabularySchema = z.record(z.string(), z.object({ placeholders: z.array(z.string()), sections: z.array(z.string()) }));

const ticketTemplateViewSchema = z.object({
  /** The saved text, or `null` while the project uses the built-in template. */
  saved: z.string().nullable(),
  /** Whether the built-in template is the one in effect. */
  builtIn: z.boolean(),
  builtInTemplate: z.string(),
  vocabulary: vocabularySchema,
  maxChars: z.number().int(),
});

const ticketTemplateView = (saved: string | null) => ({
  saved,
  builtIn: ticketTemplateFor(saved).builtIn,
  builtInTemplate: builtInTicketTemplate,
  vocabulary: Object.fromEntries(
    Object.entries(ticketTemplateVocabulary).map(([scope, vocabulary]) => [scope, { placeholders: [...vocabulary.placeholders], sections: [...vocabulary.sections] }]),
  ),
  maxChars: TICKET_TEMPLATE_MAX_CHARS,
});

export const projectsRouter = router({
  /** Creates a project on one repo the App's installation includes, with its environment drafted from the repo. */
  create: adminProcedure
    .input(createProjectInputSchema)
    .output(createdSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      // Reading the repo's files is part of it, so the transaction gets time.
      const result = await db.$transaction((tx) => createProject({ tx, scope: ctx.scope, ...ports }, input), { timeout: 60_000, maxWait: 10_000 });
      const created = unwrap(result, {
        forbidden: "FORBIDDEN",
        "slug-taken": "CONFLICT",
        "repo-not-installed": "BAD_REQUEST",
        "no-agent-profile": "PRECONDITION_FAILED",
      });
      // F-055, F-060: the checks are read as the repo is added, so the project's first page has them.
      await checkProjectRepos({ db, clock: ports.clock, adapters: ports.adapters }, { organizationId: ctx.scope.organizationId, projectId: created.projectId, force: true });
      return { projectId: created.projectId, repoId: created.repoId, environmentId: created.environmentId, detection: created.detection };
    }),

  /** The projects the caller can open, in their organization. */
  list: memberProcedure.output(z.array(projectSummarySchema)).query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const rows = await db.project.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      include: { repos: { orderBy: { createdAt: "asc" } } },
    });
    const visible = visibleProjects(
      ctx.scope,
      rows.map((row) => ({ id: projectIdSchema.parse(row.id), organizationId, access: row.access, row })),
    );
    const ids = visible.map((project) => project.id);
    const counts = await db.task.groupBy({
      by: ["projectId", "state"],
      where: { organizationId, projectId: { in: ids }, state: { notIn: [...finishedStates] } },
      _count: { _all: true },
    });
    const inbox = await inboxCounts(ctx.deps, organizationId, ids);
    const countOf = (projectId: string, states: readonly string[]): number =>
      counts.filter((row) => row.projectId === projectId && states.includes(row.state)).reduce((sum, row) => sum + row._count._all, 0);
    return visible.map(({ row }) => ({
      id: projectIdSchema.parse(row.id),
      name: row.name,
      slug: row.slug,
      access: row.access,
      repos: row.repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), fullName: repo.fullName, defaultBranch: repo.defaultBranch })),
      needsYouCount: countOf(row.id, ["needs_you"]),
      runningCount: countOf(row.id, ["running", "preparing"]),
      activeCount: counts.filter((count) => count.projectId === row.id).reduce((sum, count) => sum + count._count._all, 0),
      inboxCount: inbox.get(row.id) ?? 0,
      createdAt: row.createdAt.getTime(),
    }));
  }),

  get: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(projectDetailSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const project = await db.project.findFirstOrThrow({
        where: { id: input.projectId, organizationId },
        include: {
          repos: { orderBy: { createdAt: "asc" } },
          environment: { select: { status: true } },
          pools: { include: { pool: { select: { id: true, name: true, isDefault: true } } } },
        },
      });
      const profile = await loadAgentProfileView(db, organizationId, project.defaultCodeProfileId);
      // Read at every page load, and reused for 10 minutes (`BRANCH_RULES_CACHE_MS`).
      const checkedRepos = await checkProjectRepos({ db, clock: ctx.deps.ports.clock, adapters: ctx.deps.ports.adapters }, { organizationId, projectId: input.projectId, force: false });
      const [needsYou, running, active] = await Promise.all([
        db.task.count({ where: { organizationId, projectId: project.id, state: "needs_you" } }),
        db.task.count({ where: { organizationId, projectId: project.id, state: { in: ["running", "preparing"] } } }),
        db.task.count({ where: { organizationId, projectId: project.id, state: { notIn: [...finishedStates] } } }),
      ]);
      return {
        id: projectIdSchema.parse(project.id),
        name: project.name,
        slug: project.slug,
        access: project.access,
        role: ctx.project.role,
        repos: checkedRepos.map(repoDetailOf),
        needsYouCount: needsYou,
        runningCount: running,
        activeCount: active,
        inboxCount: (await inboxCounts(ctx.deps, organizationId, [project.id])).get(project.id) ?? 0,
        createdAt: project.createdAt.getTime(),
        environmentStatus: project.environment === null ? null : project.environment.status,
        pools: project.pools.map((link) => ({ poolId: link.pool.id, name: link.pool.name, isDefault: link.pool.isDefault })),
        defaultCodeProfile: profile,
      };
    }),

  /** "Check again": a project admin reads the default branch's rules now, whatever the cache holds. */
  checkRepos: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(z.array(repoDetailSchema))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const checked = await checkProjectRepos({ db, clock: ports.clock, adapters: ports.adapters }, { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: true });
      return checked.map(repoDetailOf);
    }),

  /** The project's ticket template: the saved text, and the built-in one it falls back to (F-064). */
  getTicketTemplate: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(ticketTemplateViewSchema)
    .query(async ({ ctx, input }) => {
      const project = await ctx.deps.db.project.findFirstOrThrow({ where: { id: input.projectId, organizationId: ctx.scope.organizationId }, select: { ticketTemplate: true } });
      return ticketTemplateView(project.ticketTemplate);
    }),

  /**
   * Saves the template (`null` goes back to the built-in one). A template that doesn't pass the
   * validator is not saved, and the answer lists its problems by line.
   */
  saveTicketTemplate: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, template: z.string().max(TICKET_TEMPLATE_MAX_CHARS).nullable() }))
    .output(z.discriminatedUnion("saved", [z.object({ saved: z.literal(true), template: ticketTemplateViewSchema }), z.object({ saved: z.literal(false), problems: z.array(templateProblemSchema) })]))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      // Blank means the built-in template, as null does.
      const text = input.template === null || input.template.trim() === "" ? null : input.template;
      if (text !== null) {
        const parsed = parseTicketTemplate(text);
        if (!parsed.ok) {
          return { saved: false as const, problems: parsed.problems.map((problem) => ({ line: problem.line, message: problem.message })) };
        }
      }
      await db.$transaction(async (tx) => {
        await tx.project.update({ where: { id: input.projectId }, data: { ticketTemplate: text } });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: input.projectId,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "project.ticket-template-saved",
          entity: "project",
          entityId: input.projectId,
          data: { builtIn: text === null, chars: text?.length ?? 0 },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
      });
      return { saved: true as const, template: ticketTemplateView(text) };
    }),

  /**
   * Renders a template on one of the project's cached tickets, for the editor's preview: the
   * template in the editor (`template`), or the saved one. The render is returned and never logged.
   */
  previewTicketTemplate: projectProcedure(
    "admin",
    z.strictObject({ projectId: projectIdSchema, ticketId: ticketIdSchema, template: z.string().max(TICKET_TEMPLATE_MAX_CHARS).optional() }),
  )
    .output(z.discriminatedUnion("rendered", [z.object({ rendered: z.literal(true), prompt: z.string() }), z.object({ rendered: z.literal(false), problems: z.array(templateProblemSchema) })]))
    .mutation(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const ticket = await db.ticket.findFirst({ where: { id: input.ticketId, organizationId, projectId: input.projectId } });
      if (ticket === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket in this project" });
      }
      const project = await db.project.findFirstOrThrow({ where: { id: input.projectId, organizationId }, select: { ticketTemplate: true, defaultCodeProfileId: true } });
      let template: ReturnType<typeof ticketTemplateFor>["template"];
      if (input.template === undefined) {
        template = ticketTemplateFor(project.ticketTemplate).template;
      } else {
        const parsed = parseTicketTemplate(input.template.trim() === "" ? builtInTicketTemplate : input.template);
        if (!parsed.ok) {
          return { rendered: false as const, problems: parsed.problems.map((problem) => ({ line: problem.line, message: problem.message })) };
        }
        template = parsed.template;
      }
      const profile = project.defaultCodeProfileId === null ? null : await db.agentProfile.findFirst({ where: { id: project.defaultCodeProfileId, organizationId }, select: { instructions: true } });
      const labels = z.array(z.string()).safeParse(ticket.labels);
      // The cache holds the ticket itself; comments, relations and images are read when a task
      // starts (`ticket.fetch-context`), so the preview shows those sections empty.
      const context: TicketPromptContext = {
        ticket: {
          key: ticket.key,
          title: ticket.title,
          url: ticket.url,
          status: ticket.statusName ?? "",
          priority: priorityLabelOf(ticket.priority),
          description: ticket.description,
        },
        labels: (labels.success ? labels.data : []).map((name) => ({ name })),
        comments: [],
        parent: null,
        children: [],
        linked: [],
        images: [],
        instructions: profile?.instructions ?? null,
        task: { branch: previewBranchOf(ticket.key) },
      };
      return { rendered: true as const, prompt: renderTicketPrompt(template, context) };
    }),
});

/** Linear's scale as words (1 urgent to 4 low); `null` for none. */
const priorityLabelOf = (priority: number | null): string | null => {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    case null:
    default:
      return null;
  }
};

/** The branch a task would have, with a placeholder where the task's ID digits go. */
const previewBranchOf = (key: string): string => {
  const parsed = ticketKeySchema.safeParse(key);
  return `ostra/${(parsed.success ? parsed.data : key).toLowerCase()}-xxxxxxxx-title`;
};
