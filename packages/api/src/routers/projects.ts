import { createProject, createProjectInputSchema, visibleProjects } from "@ostra/domain";
import { environmentIdSchema, projectIdSchema, repoIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { adminProcedure, memberProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";
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
  /** Epoch ms. */
  createdAt: z.number().int(),
});

const projectDetailSchema = projectSummarySchema.extend({
  /** The caller's role on it. */
  role: z.enum(["admin", "member"]),
  environmentStatus: z.enum(["draft", "saved"]).nullable(),
  /** The pools its tasks may go to. */
  pools: z.array(z.object({ poolId: z.string(), name: z.string(), isDefault: z.boolean() })),
  defaultCodeProfile: z.object({ id: z.string(), name: z.string() }).nullable(),
});

const createdSchema = z.object({
  projectId: projectIdSchema,
  repoId: repoIdSchema,
  environmentId: environmentIdSchema,
  detection: detectionViewSchema,
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
      const profile =
        project.defaultCodeProfileId === null
          ? null
          : await db.agentProfile.findFirst({ where: { id: project.defaultCodeProfileId, organizationId }, select: { id: true, name: true } });
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
        repos: project.repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), fullName: repo.fullName, defaultBranch: repo.defaultBranch })),
        needsYouCount: needsYou,
        runningCount: running,
        activeCount: active,
        createdAt: project.createdAt.getTime(),
        environmentStatus: project.environment === null ? null : project.environment.status,
        pools: project.pools.map((link) => ({ poolId: link.pool.id, name: link.pool.name, isDefault: link.pool.isDefault })),
        defaultCodeProfile: profile,
      };
    }),
});
