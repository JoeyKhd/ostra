import {
  branchRuleCheckSchema,
  builtInTicketTemplate,
  checkProjectRepos,
  createProject,
  createProjectInputSchema,
  parseTicketTemplate,
  renderTicketPrompt,
  setProjectAccess,
  setProjectDefaultProfile,
  setProjectMember,
  TICKET_TEMPLATE_MAX_CHARS,
  ticketTemplateFor,
  ticketTemplateVocabulary,
  visibleProjects,
} from "@ostra/domain";
import type { RepoChecked, TicketPromptContext } from "@ostra/domain";
import { agentProfileIdSchema, environmentIdSchema, memberIdSchema, poolIdSchema, projectIdSchema, repoIdSchema, taskKindSchema, ticketIdSchema, ticketKeySchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { adminProcedure, memberProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";
import { inboxCounts } from "./inbox.ts";
import { agentProfileViewSchema, loadAgentProfileView } from "./agent-profile-view.ts";
import { detectionViewSchema } from "./environments.ts";
import { projectReposProcedures } from "./project-repos.ts";
import { projectProviderProcedures } from "./project-providers.ts";
import { projectRunnerProcedures } from "./project-runners.ts";

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
  /**
   * F-136 (ticket 54): the App installation the repo is reached through, on `accountLogin`.
   * `linked`: ostra uses it. `unlinked`: an admin unlinked it. `removed`: the App was uninstalled
   * there. While it isn't linked, new tasks on the repo wait until an admin links it again.
   * `null` when the repo's row is gone between the two reads.
   */
  installation: z
    .object({ accountLogin: z.string(), accountKind: z.enum(["organization", "user"]).nullable(), state: z.enum(["linked", "unlinked", "removed"]) })
    .nullable(),
});

type InstallationOfRepo = {
  readonly accountLogin: string;
  readonly accountKind: "organization" | "user" | null;
  readonly state: "linked" | "removed";
  readonly removedByMemberId: string | null;
};

/** Each repo's installation, by repo ID (F-136). */
const installationsOfRepos = async (db: Context["deps"]["db"], organizationId: string, projectId: string): Promise<ReadonlyMap<string, InstallationOfRepo>> => {
  const rows = await db.repo.findMany({
    where: { organizationId, projectId },
    select: { id: true, installation: { select: { accountLogin: true, accountKind: true, state: true, removedByMemberId: true } } },
  });
  return new Map(rows.map((row) => [row.id, row.installation] as const));
};

const repoDetailOf = (checked: RepoChecked, installation: InstallationOfRepo | undefined) => ({
  repoId: checked.repoId,
  fullName: checked.fullName,
  defaultBranch: checked.defaultBranch,
  private: checked.private,
  checkedAt: checked.checkedAt,
  defaultBranchProtected: checked.rules.protected,
  signedCommitsRequired: checked.rules.signedCommits,
  installation:
    installation === undefined
      ? null
      : {
          accountLogin: installation.accountLogin,
          accountKind: installation.accountKind,
          state: installation.state === "linked" ? ("linked" as const) : installation.removedByMemberId === null ? ("removed" as const) : ("unlinked" as const),
        },
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
  /** The default profile for each task kind (F-021, ticket 34); `code` is `defaultCodeProfile`. */
  defaultProfiles: z.object({ refine: agentProfileViewSchema.nullable(), code: agentProfileViewSchema.nullable(), review: agentProfileViewSchema.nullable() }),
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

/** A project's access and its listed members (F-087). */
const projectAccessViewSchema = z.object({
  access: z.enum(["open", "restricted"]),
  /** The caller's role on it. */
  role: z.enum(["admin", "member"]),
  members: z.array(z.object({ memberId: memberIdSchema, name: z.string(), username: z.string().nullable(), role: z.enum(["admin", "member"]) })),
});

export const projectsRouter = router({
  // F-098 (ticket 30): the project's several repos, in order.
  ...projectReposProcedures,
  // F-135 (ticket 50): the project's providers, by name, and an organization admin's changes to them.
  ...projectProviderProcedures,
  ...projectRunnerProcedures,

  /**
   * Creates a project on one or more repos the App's installations include (`repo` first, then
   * `moreRepos`), with its environment drafted from the first repo.
   */
  create: adminProcedure
    .input(createProjectInputSchema)
    .output(createdSchema)
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      // F-098 (ticket 30): a project holds at most `OSTRA_PROJECT_MAX_REPOS` repos from its start.
      const repoCount = 1 + (input.moreRepos?.length ?? 0);
      if (repoCount > settings.projectMaxRepos) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `A project holds at most ${String(settings.projectMaxRepos)} repos` });
      }
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
      include: { repos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] } },
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
          repos: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
          environment: { select: { status: true } },
          pools: { include: { pool: { select: { id: true, name: true, isDefault: true } } } },
        },
      });
      const profile = await loadAgentProfileView(db, organizationId, project.defaultCodeProfileId);
      // Read at every page load, and reused for 10 minutes (`BRANCH_RULES_CACHE_MS`).
      const checkedRepos = await checkProjectRepos({ db, clock: ctx.deps.ports.clock, adapters: ctx.deps.ports.adapters }, { organizationId, projectId: input.projectId, force: false });
      const installationOf = await installationsOfRepos(db, organizationId, input.projectId);
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
        repos: checkedRepos.map((checked) => repoDetailOf(checked, installationOf.get(checked.repoId))),
        needsYouCount: needsYou,
        runningCount: running,
        activeCount: active,
        inboxCount: (await inboxCounts(ctx.deps, organizationId, [project.id])).get(project.id) ?? 0,
        createdAt: project.createdAt.getTime(),
        environmentStatus: project.environment === null ? null : project.environment.status,
        pools: project.pools.map((link) => ({ poolId: link.pool.id, name: link.pool.name, isDefault: link.pool.isDefault })),
        defaultCodeProfile: profile,
        defaultProfiles: {
          refine: await loadAgentProfileView(db, organizationId, project.defaultRefineProfileId),
          code: profile,
          review: await loadAgentProfileView(db, organizationId, project.defaultReviewProfileId),
        },
      };
    }),

  /**
   * The project's default profile for a task kind (F-021, ticket 34). A project admin; the profile
   * must be open to every member of the project, so nobody is handed a default they can't use.
   */
  setDefaultProfile: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, kind: taskKindSchema, profileId: agentProfileIdSchema }))
    .output(z.object({ profileId: agentProfileIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await setProjectDefaultProfile({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { projectId: input.projectId, kind: input.kind, profileId: input.profileId });
      const checked = unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "not-open-to-every-member": "BAD_REQUEST", archived: "CONFLICT", "provider-not-allowed": "PRECONDITION_FAILED" });
      return { profileId: checked.profileId };
    }),

  /** "Check again": a project admin reads the default branch's rules now, whatever the cache holds. */
  checkRepos: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(z.array(repoDetailSchema))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const checked = await checkProjectRepos({ db, clock: ports.clock, adapters: ports.adapters }, { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: true });
      const installationOf = await installationsOfRepos(db, ctx.scope.organizationId, input.projectId);
      return checked.map((repo) => repoDetailOf(repo, installationOf.get(repo.repoId)));
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

  // ---------- access (F-087, ADR 0026, ticket 23) ----------

  /**
   * Who may open the project: open or restricted, and the members listed on it with their roles
   * (anyone who can open it). Organization admins are admins of every project, listed or not.
   */
  access: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(projectAccessViewSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const [project, listed] = await Promise.all([
        db.project.findFirstOrThrow({ where: { id: input.projectId, organizationId }, select: { access: true } }),
        db.projectMember.findMany({
          where: { organizationId, projectId: input.projectId, member: { state: "active" } },
          orderBy: { createdAt: "asc" },
          select: { memberId: true, role: true, member: { select: { user: { select: { name: true, username: true } } } } },
        }),
      ]);
      return {
        access: project.access,
        role: ctx.project.role,
        members: listed.map((row) => ({ memberId: memberIdSchema.parse(row.memberId), name: row.member.user.name, username: row.member.user.username, role: row.role })),
      };
    }),

  /** Opens or restricts the project (project admin). Restricting lists the member who does it as an admin. */
  setAccess: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, access: z.enum(["open", "restricted"]) }))
    .output(z.object({ access: z.enum(["open", "restricted"]) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = unwrap(await setProjectAccess({ db, ...ports }, ctx.scope, { projectId: input.projectId, access: input.access }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
      });
      return { access: result.access };
    }),

  /** Lists an existing member on the project with a role, or changes it (project admin). Never an invitation. */
  setMember: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, memberId: memberIdSchema, role: z.enum(["admin", "member"]) }))
    .output(z.object({ role: z.enum(["admin", "member"]) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      unwrap(await setProjectMember({ db, ...ports }, ctx.scope, { projectId: input.projectId, memberId: input.memberId, role: input.role }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-a-member": "NOT_FOUND",
      });
      return { role: input.role };
    }),

  /** Takes a member off the project's list (project admin). */
  removeMember: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, memberId: memberIdSchema }))
    .output(z.object({ removed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      unwrap(await setProjectMember({ db, ...ports }, ctx.scope, { projectId: input.projectId, memberId: input.memberId, role: null }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-a-member": "NOT_FOUND",
      });
      return { removed: true as const };
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
