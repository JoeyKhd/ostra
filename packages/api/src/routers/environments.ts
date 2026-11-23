import { secretRefSchema } from "@ostra/adapter-sdk";
import type { Db, EnvironmentEntry as EntryRow } from "@ostra/db";
import {
  applyRepoDraft,
  detectionWithoutFiles,
  detectRepoEnvironment,
  dismissRepoDraft,
  installationStateSelect,
  installationUsable,
  listRepoDrafts,
  saveEnvironment,
  saveEnvironmentInputSchema,
} from "@ostra/domain";
import { connectionIdSchema, environmentIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadGitHubConnection } from "../services/github-connection.ts";
import { appProcessesRouter, detectedAppProcessViewSchema, screenshotsRouter } from "./environment-app.ts";
import { checksRouter, servicesRouter, snapshotRouter, whereTasksRun, whereTasksRunSchema } from "./environment-services.ts";
import { onboardingProcedures } from "./environment-proposals.ts";
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
  /**
   * Milestone 8 (F-140, ticket 16): the app's processes it read, with the primary first, each
   * command as a file says it or `null`. Read as text, never run.
   */
  appProcesses: z.array(detectedAppProcessViewSchema).readonly(),
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
  /** Milestone 3 (ticket 40): the project's pools, who is online in them, and whether its services can start. */
  whereTasksRun: whereTasksRunSchema,
});

type EntryView = z.infer<typeof entryViewSchema>;

/**
 * F-112/c1 (Q345 option (b)): a repo added after the environment was saved, its draft waiting
 * beside the saved setup. `lines` is the setup script Apply saves, each line kept or added.
 */
export const repoDraftViewSchema = z.object({
  repoId: repoIdSchema,
  fullName: z.string(),
  /** Epoch ms. */
  createdAt: z.number().int(),
  createdBy: z.string().nullable(),
  kind: z.enum(["case", "plain", "nothing"]),
  lines: z.array(z.object({ kind: z.enum(["same", "add"]), text: z.string() })).readonly(),
  script: z.string().nullable(),
  envFile: z.string(),
  variables: z.array(z.object({ name: z.string(), secret: z.boolean(), source: z.string() })).readonly(),
  reasons: z.array(z.object({ file: z.string(), finding: z.string() })).readonly(),
  tools: z.array(z.object({ tool: z.string(), version: z.string(), source: z.string() })).readonly(),
  services: z.array(z.object({ name: z.string(), image: z.string().nullable(), ports: z.array(z.number().int()).readonly(), source: z.string() })).readonly(),
  language: z.enum(["node", "python", "rust", "go", "ruby"]).nullable(),
  tool: z.string().nullable(),
  savedTool: z.string().nullable(),
});

const repoDraftInput = z.strictObject({ projectId: projectIdSchema, repoId: repoIdSchema });

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
  // F-113 (milestone 6's ticket 29): the onboarding task and its environment proposal.
  ...onboardingProcedures,

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
      const repos = await db.repo.findMany({ where: { projectId: input.projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
      return {
        environmentId: environmentIdSchema.parse(environment.id),
        status: environment.status,
        baseImage: environment.baseImage,
        setupScript: environment.setupScript,
        savedAt: environment.savedAt === null ? null : environment.savedAt.getTime(),
        repos: repos.map((repo) => ({ repoId: repoIdSchema.parse(repo.id), fullName: repo.fullName, checkoutDir: repo.checkoutDir, envFile: repo.envFile })),
        entries: environment.entries.flatMap(viewOf),
        whereTasksRun: await whereTasksRun(db, ctx.scope, input.projectId, ctx.deps.ports.clock.now()),
      };
    }),

  /** Drafts the environment again from each repo's files now (F-112): no agent, no model. */
  detect: projectProcedure("admin", projectInput)
    .output(z.array(z.object({ repoId: repoIdSchema, fullName: z.string(), detection: detectionViewSchema })))
    .mutation(async ({ ctx, input }) => {
      // F-136 (ticket 51): each repo through its own App, which may be a client's.
      const apps = new Map<string, Awaited<ReturnType<typeof loadGitHubConnection>>>();
      const appOf = async (connectionId: string) => {
        const known = apps.get(connectionId);
        if (known !== undefined) {
          return known;
        }
        const loaded = await loadGitHubConnection(ctx.deps, ctx.scope, connectionIdSchema.parse(connectionId));
        apps.set(connectionId, loaded);
        return loaded;
      };
      const repos = await ctx.deps.db.repo.findMany({
        where: { projectId: input.projectId, organizationId: ctx.scope.organizationId },
        include: { ...installationStateSelect },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      const out = [];
      for (const repo of repos) {
        const fullName = repoFullNameSchema.parse(repo.fullName);
        // Milestone 4 (F-136, ADR 0065): nothing is minted through an installation that isn't linked.
        if (!installationUsable(repo.installation)) {
          out.push({ repoId: repoIdSchema.parse(repo.id), fullName, detection: detectionWithoutFiles("its GitHub installation isn't linked to ostra") });
          continue;
        }
        const github = await appOf(repo.connectionId);
        const detection = await detectRepoEnvironment(
          ctx.deps.ports.adapters.codeHost,
          { app: github.credentials, installationId: repo.installationId, repo: fullName },
          repo.defaultBranch,
        );
        out.push({ repoId: repoIdSchema.parse(repo.id), fullName, detection });
      }
      return out;
    }),

  /** F-112/c1: the drafts of repos added since the environment was saved, waiting for review (anyone who can open the project). */
  repoDrafts: projectProcedure("read", projectInput)
    .output(z.array(repoDraftViewSchema))
    .query(async ({ ctx, input }) => [...(await listRepoDrafts(ctx.deps.db, ctx.scope, input.projectId))]),

  /**
   * F-112/c1: "Apply" on a new repo's draft: saves the environment at once with its lines in the
   * setup script and its variables in its section, scanned, audited and versioned like any save;
   * the snapshot rebuilds. Answers the secrets detection named, which need a value before they're kept.
   */
  applyRepoDraft: projectProcedure("admin", repoDraftInput)
    .output(z.object({ environmentId: environmentIdSchema, secretsWithoutValue: z.array(z.string()).readonly() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await applyRepoDraft({ db, audit: ports.audit, notices: ports.notices, clock: ports.clock, jobs: ports.jobs, adapters: ports.adapters }, ctx.scope, input);
      if (!result.ok && result.error === "secret-found") {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
      }
      const applied = unwrap(result, {
        "not-found": "NOT_FOUND",
        forbidden: "FORBIDDEN",
        "nothing-to-apply": "BAD_REQUEST",
        "unknown-repo": "BAD_REQUEST",
        "duplicate-entry": "BAD_REQUEST",
        "secret-without-value": "BAD_REQUEST",
      });
      return { environmentId: applied.environmentId, secretsWithoutValue: applied.secretsWithoutValue };
    }),

  /** F-112/c1: "Dismiss" on a new repo's draft: the environment stays as it is. Audited. */
  dismissRepoDraft: projectProcedure("admin", repoDraftInput)
    .output(z.object({ dismissed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      unwrap(await dismissRepoDraft({ db, audit: ports.audit, notices: ports.notices, clock: ports.clock }, ctx.scope, { ...input, undo: false }), { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
      return { dismissed: true as const };
    }),

  /** F-112/c1: "Undo" after Dismiss, while the page is open: the draft waits again. Audited. */
  undoDismissRepoDraft: projectProcedure("admin", repoDraftInput)
    .output(z.object({ dismissed: z.literal(false) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      unwrap(await dismissRepoDraft({ db, audit: ports.audit, notices: ports.notices, clock: ports.clock }, ctx.scope, { ...input, undo: true }), { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
      return { dismissed: false as const };
    }),

  /** Milestone 3 (ticket 40): the services beside each box on `docker` runners (F-094). */
  services: servicesRouter,
  /** The checks that run after every turn with changes, before the push (F-054). */
  checks: checksRouter,
  /** The snapshot a box starts from on `docker` (F-051). */
  snapshot: snapshotRouter,
  /** Milestone 8 (F-140, ticket 16): the app's processes, in their start order. */
  appProcesses: appProcessesRouter,
  /** Milestone 8 (F-121, ticket 16): "Screenshots after each turn". */
  screenshots: screenshotsRouter,

  /**
   * Saves the environment: the setup script, and each repo's variables, secrets and files. Secret
   * values go to the secret store. The result carries warnings that don't stop the save.
   */
  save: projectProcedure("admin", saveEnvironmentInputSchema)
    .output(z.object({ environmentId: environmentIdSchema, warnings: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction(
        async (tx) => {
          const outcome = await saveEnvironment({ tx, scope: ctx.scope, ...ports }, input);
          // The environment changed: its snapshot rebuilds (F-051, ticket 26), one a minute at most.
          if (outcome.ok) {
            await ports.jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId: ctx.scope.organizationId, projectId: input.projectId, reason: "environment-changed" });
          }
          return outcome;
        },
        { timeout: 30_000 },
      );
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
