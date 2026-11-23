import { addProjectRepo, branchRuleCheckSchema, checkProjectRepos, removeProjectRepo, reorderProjectRepos, setRepoSkills } from "@ostra/domain";
import type { ProjectReposDeps } from "@ostra/domain";
import { projectIdSchema, repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { projectProcedure } from "../trpc/init.ts";

// F-098 (ticket 30; ADR 0027 amended): a project's several repos. Anyone who can open the project
// reads them in order, with each one's default branch, its branch-rule warnings and the unfinished
// tasks using it; a project admin (or an organization admin) adds, removes and reorders them, through
// ticket 17's use cases, each with its audit entry.

/** The states a task ends in: a task in any other still uses its repos. */
const finishedStates = ["stopped", "merged", "done"] as const;

const repoTaskSchema = z.object({ taskId: taskIdSchema, title: z.string(), ticketKey: z.string().nullable() });
/** A task using a repo, with its state for the panel's In use rows (project-repos.md: the mark and the state word). */
const repoUseTaskSchema = repoTaskSchema.extend({
  state: z.enum(["awaiting_approval", "queued", "preparing", "running", "needs_you", "in_review", "stopped", "merged", "done"]),
});

export const projectRepoViewSchema = z.object({
  repoId: repoIdSchema,
  fullName: z.string(),
  defaultBranch: z.string(),
  /** Its place in the project's order, from 0. */
  position: z.number().int(),
  /** Its folder in a task's workspace. */
  checkoutDir: z.string(),
  private: z.boolean().nullable(),
  /** Milestone 2's branch rules on the default branch (F-055, F-060), as of `checkedAt`. */
  checkedAt: z.number().int().nullable(),
  defaultBranchProtected: branchRuleCheckSchema,
  signedCommitsRequired: branchRuleCheckSchema,
  /** The unfinished tasks with a branch in it: while there are any, it can't be removed. */
  tasks: z.array(repoUseTaskSchema),
});
export type ProjectRepoView = z.infer<typeof projectRepoViewSchema>;

const deps = (ctx: Pick<Context, "deps">): ProjectReposDeps => ({
  db: ctx.deps.db,
  audit: ctx.deps.ports.audit,
  notices: ctx.deps.ports.notices,
  clock: ctx.deps.ports.clock,
  adapters: ctx.deps.ports.adapters,
  maxRepos: ctx.deps.settings.projectMaxRepos,
});

export const projectReposProcedures = {
  /** The project's repos in order (anyone who can open it). */
  repos: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(z.array(projectRepoViewSchema))
    .query(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      // Read at every page load, and reused for 10 minutes (`BRANCH_RULES_CACHE_MS`).
      const checked = await checkProjectRepos({ db, clock: ports.clock, adapters: ports.adapters }, { organizationId, projectId: input.projectId, force: false });
      const rows = await db.repo.findMany({
        where: { projectId: input.projectId, organizationId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          position: true,
          checkoutDir: true,
          taskRepos: {
            where: { state: { not: "no_branch" }, task: { state: { notIn: [...finishedStates] } } },
            orderBy: { createdAt: "asc" },
            select: { task: { select: { id: true, title: true, ticketKey: true, state: true } } },
          },
        },
      });
      const byId = new Map(checked.map((repo) => [repo.repoId, repo] as const));
      return rows.flatMap((row) => {
        const repo = byId.get(repoIdSchema.parse(row.id));
        if (repo === undefined) {
          return [];
        }
        const seen = new Set<string>();
        const tasks = row.taskRepos.flatMap(({ task }) => {
          if (seen.has(task.id)) {
            return [];
          }
          seen.add(task.id);
          return [{ taskId: taskIdSchema.parse(task.id), title: task.title, ticketKey: task.ticketKey, state: task.state }];
        });
        return [
          {
            repoId: repo.repoId,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            position: row.position,
            checkoutDir: row.checkoutDir,
            private: repo.private,
            checkedAt: repo.checkedAt,
            defaultBranchProtected: repo.rules.protected,
            signedCommitsRequired: repo.rules.signedCommits,
            tasks,
          },
        ];
      });
    }),

  /**
   * Adds a repo an App installation linked to the organization reaches, at the end of the order, up
   * to `OSTRA_PROJECT_MAX_REPOS`. Tasks pick it up at their next session.
   */
  addRepo: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, fullName: repoFullNameSchema }))
    .output(
      z.object({
        repoId: repoIdSchema,
        checkoutDir: z.string(),
        position: z.number().int(),
        /** F-112/c1: the environment was saved, and the repo's own draft waits on Environment for review. */
        drafted: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const added = await addProjectRepo(deps(ctx), ctx.scope, { projectId: input.projectId, fullName: input.fullName });
      if (!added.ok) {
        return throwRefusal(added.error, added.message);
      }
      // F-055, F-060: the new repo's rules are read now, so the page shows them at once.
      await checkProjectRepos({ db: ctx.deps.db, clock: ctx.deps.ports.clock, adapters: ctx.deps.ports.adapters }, { organizationId: ctx.scope.organizationId, projectId: input.projectId, force: false });
      return { repoId: added.repoId, checkoutDir: added.checkoutDir, position: added.position, drafted: added.drafted };
    }),

  /**
   * Removes a repo, unless it's the project's last or unfinished tasks have a branch in it: then
   * the answer names those tasks, and nothing changes.
   */
  removeRepo: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, repoId: repoIdSchema }))
    .output(
      z.discriminatedUnion("removed", [
        z.object({ removed: z.literal(true) }),
        z.object({ removed: z.literal(false), message: z.string(), tasks: z.array(repoTaskSchema) }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await removeProjectRepo(deps(ctx), ctx.scope, { projectId: input.projectId, repoId: input.repoId });
      if (result.ok) {
        return { removed: true as const };
      }
      if (result.error === "in-use" && "tasks" in result) {
        const keys = await ctx.deps.db.task.findMany({
          where: { organizationId: ctx.scope.organizationId, id: { in: result.tasks.map((task) => task.taskId) } },
          select: { id: true, ticketKey: true },
        });
        const keyOf = new Map(keys.map((row) => [row.id, row.ticketKey] as const));
        const tasks = result.tasks.map((task) => ({ taskId: task.taskId, title: task.title, ticketKey: keyOf.get(task.taskId) ?? null }));
        const named = tasks.map((task) => task.ticketKey ?? task.title).join(", ");
        return { removed: false as const, message: `Unfinished tasks have a branch in this repo: ${named}`.slice(0, 2_000), tasks };
      }
      return throwRefusal(result.error, result.message);
    }),

  /** Sets the order: each of the project's repos once, first to last. */
  reorderRepos: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, repoIds: z.array(repoIdSchema).min(1).max(100) }))
    .output(z.object({ reordered: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const result = await reorderProjectRepos(deps(ctx), ctx.scope, { projectId: input.projectId, repoIds: input.repoIds });
      if (!result.ok) {
        return throwRefusal(result.error, result.message);
      }
      return { reordered: true as const };
    }),

  /**
   * Whether each repo's own skills (`.agents/skills`, `.claude/skills`, `.opencode/skills`) reach
   * the agent beside the profile's (F-021, ADR 0049 amended 2026-11-21). On by default; a project
   * admin turns it off and on, audited. It reaches each task's next session.
   */
  setRepoSkills: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, on: z.boolean() }))
    .output(z.object({ repoSkills: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const result = await setRepoSkills({ db: ctx.deps.db, audit: ctx.deps.ports.audit, notices: ctx.deps.ports.notices }, ctx.scope, input);
      if (!result.ok) {
        return throwRefusal(result.error, result.message);
      }
      return { repoSkills: result.on };
    }),
};

type RepoRefusal = "forbidden" | "not-found" | "limit-reached" | "already-added" | "no-access" | "not-linked" | "last-repo" | "in-use" | "invalid-input";

const codeOf = (error: RepoRefusal) => {
  switch (error) {
    case "forbidden":
      return "FORBIDDEN" as const;
    case "not-found":
      return "NOT_FOUND" as const;
    case "already-added":
      return "CONFLICT" as const;
    case "invalid-input":
      return "BAD_REQUEST" as const;
    case "limit-reached":
    case "no-access":
    case "not-linked":
    case "last-repo":
    case "in-use":
      return "PRECONDITION_FAILED" as const;
    default:
      return error satisfies never;
  }
};

const throwRefusal = (error: RepoRefusal, message: string): never => {
  throw new TRPCError({ code: codeOf(error), message });
};
