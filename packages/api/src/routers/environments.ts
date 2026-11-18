import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db, EnvironmentEntry as EntryRow } from "@ostra/db";
import { detectRepoEnvironment, saveEnvironment, saveEnvironmentInputSchema } from "@ostra/domain";
import { environmentIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadGitHubConnection } from "../services/github-connection.ts";
import { projectProcedure, router, unwrap } from "../trpc/init.ts";

// F-050, F-112, ticket 32: a project's one environment, and the draft detection makes. Reading is
// for anyone who can open the project (secrets masked); detecting and saving are for project
// admins and organization admins.

const projectInput = z.strictObject({ projectId: projectIdSchema });

export const detectionViewSchema = z.object({
  baseImage: z.string().nullable(),
  setupLines: z.array(z.string()).readonly(),
  setupScript: z.string().nullable(),
  variables: z.array(z.object({ name: z.string(), secret: z.boolean(), source: z.string() })).readonly(),
  tools: z.array(z.object({ tool: z.string(), version: z.string(), source: z.string() })).readonly(),
  services: z.array(
    z.object({
      name: z.string(),
      image: z.string().nullable(),
      ports: z.array(z.number().int()).readonly(),
      source: z.string(),
      /** Always false: a service needs a container runtime, so the `host` executor doesn't run it. */
      runsOnHost: z.literal(false),
    }),
  ).readonly(),
  /** What it found and why, per file, for the panel to show. */
  reasons: z.array(z.object({ file: z.string(), finding: z.string() })).readonly(),
});

const entryViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("variable"), repoId: repoIdSchema, name: z.string(), value: z.string(), availableDuringSetup: z.boolean() }),
  /** A secret is shown by name and whether it has a value: never the value, never its reference. */
  z.object({ kind: z.literal("secret"), repoId: repoIdSchema, name: z.string(), hasValue: z.boolean(), availableDuringSetup: z.boolean() }),
  z.object({ kind: z.literal("file"), repoId: repoIdSchema, path: z.string(), content: z.string(), availableDuringSetup: z.boolean() }),
]);

const environmentViewSchema = z.object({
  environmentId: environmentIdSchema,
  status: z.enum(["draft", "saved"]),
  baseImage: z.string().nullable(),
  setupScript: z.string().nullable(),
  /** Epoch ms. */
  savedAt: z.number().int().nullable(),
  repos: z.array(z.object({ repoId: repoIdSchema, fullName: z.string(), checkoutDir: z.string(), envFile: z.string() })),
  entries: z.array(entryViewSchema),
});

type EntryView = z.infer<typeof entryViewSchema>;

/** A stored entry as the panel sees it: a secret by name only. */
const viewOf = (entry: EntryRow): EntryView[] => {
  const repoId = repoIdSchema.parse(entry.repoId);
  switch (entry.kind) {
    case "variable":
      return entry.name === null ? [] : [{ kind: "variable", repoId, name: entry.name, value: entry.value ?? "", availableDuringSetup: entry.availableDuringSetup }];
    case "secret":
      return entry.name === null
        ? []
        : [{ kind: "secret", repoId, name: entry.name, hasValue: secretRefSchema.safeParse(entry.secretRef).success, availableDuringSetup: entry.availableDuringSetup }];
    case "file":
      return entry.path === null ? [] : [{ kind: "file", repoId, path: entry.path, content: entry.value ?? "", availableDuringSetup: entry.availableDuringSetup }];
    default:
      return entry.kind satisfies never;
  }
};

export const environmentsRouter = router({
  /** The environment as stored: the draft or the saved one, its secrets masked. */
  get: projectProcedure("read", projectInput)
    .output(environmentViewSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environment = await db.environment.findFirst({
        where: { projectId: input.projectId, organizationId },
        include: { entries: { orderBy: [{ repoId: "asc" }, { kind: "asc" }, { name: "asc" }, { path: "asc" }] } },
      });
      if (environment === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "This project has no environment" });
      }
      const repos = await db.repo.findMany({ where: { projectId: input.projectId, organizationId }, orderBy: { createdAt: "asc" } });
      return {
        environmentId: environmentIdSchema.parse(environment.id),
        status: environment.status,
        baseImage: environment.baseImage,
        setupScript: environment.setupScript,
        savedAt: environment.savedAt === null ? null : environment.savedAt.getTime(),
        repos: repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), fullName: repo.fullName, checkoutDir: repo.checkoutDir, envFile: repo.envFile })),
        entries: environment.entries.flatMap(viewOf),
      };
    }),

  /** Drafts the environment again from each repo's files now (F-112): no agent, no model. */
  detect: projectProcedure("admin", projectInput)
    .output(z.array(z.object({ repoId: repoIdSchema, fullName: z.string(), detection: detectionViewSchema })))
    .mutation(async ({ ctx, input }) => {
      const github = await loadGitHubConnection(ctx.deps, ctx.scope);
      const repos = await ctx.deps.db.repo.findMany({ where: { projectId: input.projectId, organizationId: ctx.scope.organizationId }, orderBy: { createdAt: "asc" } });
      const out = [];
      for (const repo of repos) {
        const fullName = repoFullNameSchema.parse(repo.fullName);
        const detection = await detectRepoEnvironment(
          ctx.deps.ports.adapters.codeHost,
          { app: github.credentials, installationId: repo.installationId, repo: fullName },
          repo.defaultBranch,
        );
        out.push({ repoId: repoIdSchema.parse(repo.id), fullName, detection });
      }
      return out;
    }),

  /**
   * Saves the environment: the setup script, and each repo's variables, secrets and files. Secret
   * values go to the secret store. The result carries warnings that don't stop the save.
   */
  save: projectProcedure("admin", saveEnvironmentInputSchema)
    .output(z.object({ environmentId: environmentIdSchema, warnings: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction((tx) => saveEnvironment({ tx, scope: ctx.scope, ...ports }, input), { timeout: 30_000 });
      const saved = unwrap(result, {
        "not-found": "NOT_FOUND",
        forbidden: "FORBIDDEN",
        "unknown-repo": "BAD_REQUEST",
        "duplicate-entry": "BAD_REQUEST",
        "secret-without-value": "BAD_REQUEST",
      });
      return { environmentId: saved.environmentId, warnings: await warningsFor(ctx.deps.db, ctx.scope.organizationId, input.projectId, input.environment.baseImage) };
    }),
});

/** What a save should tell the admin without refusing it. */
const warningsFor = async (db: Db, organizationId: string, projectId: string, baseImage: string | null): Promise<string[]> => {
  const warnings: string[] = [];
  if (baseImage !== null) {
    const docker = await db.runner.count({
      where: {
        organizationId,
        executor: "docker",
        state: { not: "revoked" },
        pool: { projectPools: { some: { projectId } } },
      },
    });
    if (docker === 0) {
      warnings.push("The base image applies on the `docker` executor only, and none of this project's runners uses it: tasks on `host` ignore it.");
    }
  }
  return warnings;
};
