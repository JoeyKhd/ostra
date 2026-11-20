import { clearRegistry, registryCheckFromDb, registryCheckResultSchema, registryHostOf, registryImageByDigest, setRegistry } from "@ostra/domain";
import type { RegistryPlace } from "@ostra/domain";
import { imageDigestSchema, poolIdSchema, projectIdSchema, registryIdSchema, runnerCapabilitiesSchema, snapshotIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, router, unwrap } from "../trpc/init.ts";

// F-120 (milestone 5's ticket 28): the organization's snapshot registry, for its admins. The page
// reads the address, the prefix, the auth kind, whether each credential is set (never its value),
// the last check, the pools that need a registry and the snapshots it holds. `set` and `clear` go
// through the domain (ticket 17's `setRegistry`, and `clearRegistry`), and `check` queues the
// check for the settings' version and returns at once: asking again while it's queued joins it.
// No credential's value is in an answer, an error or a log line.

/** The most snapshots the page lists, newest pushed first. */
const SNAPSHOTS_MAX = 200;

/** A credential as an admin enters it. The token is never logged or returned. */
const credentialInput = z.strictObject({ username: z.string().trim().min(1).max(512), token: z.string().min(1).max(65_536) });

const registryViewSchema = z.object({
  registry: z
    .object({
      registryId: registryIdSchema,
      url: z.string(),
      repositoryPrefix: z.string(),
      auth: z.enum(["basic", "node"]),
      /** Whether each credential is stored: never its value. */
      pushSet: z.boolean(),
      pullSet: z.boolean(),
      /** The last check, `null` before one finished for these settings. */
      check: registryCheckResultSchema.extend({ checkedAt: z.number().int() }).nullable(),
      /** Epoch ms: the settings' version, which a check is queued for. */
      updatedAt: z.number().int(),
    })
    .nullable(),
  /** Pools with a runner whose executor needs a registry for snapshots (`kubernetes`). */
  poolsNeedingIt: z.array(z.object({ poolId: poolIdSchema, name: z.string() })),
  /** The organization's snapshots in it, newest pushed first. */
  snapshots: z.array(
    z.object({
      snapshotId: snapshotIdSchema,
      projectId: projectIdSchema,
      projectName: z.string(),
      digest: z.string(),
      /** The image by digest, as a box pulls it. */
      ref: z.string(),
      pushedAt: z.number().int(),
    }),
  ),
});
export type RegistryView = z.infer<typeof registryViewSchema>;

const registryView = async (deps: ApiDeps, organizationId: string): Promise<RegistryView> => {
  const { db } = deps;
  const row = await db.registry.findUnique({ where: { organizationId } });
  const runners = await db.runner.findMany({
    where: { organizationId, kind: "pool", revokedAt: null, state: { not: "revoked" }, poolId: { not: null } },
    select: { poolId: true, executor: true, capabilities: true, pool: { select: { name: true } } },
  });
  const needing = new Map<string, string>();
  for (const runner of runners) {
    const declared = runnerCapabilitiesSchema.safeParse(runner.capabilities);
    const registry = declared.success ? declared.data.registry : runner.executor === "kubernetes" ? "required" : "none";
    if (registry === "required" && runner.poolId !== null && runner.pool !== null) {
      needing.set(runner.poolId, runner.pool.name);
    }
  }
  const poolsNeedingIt = [...needing.entries()].map(([poolId, name]) => ({ poolId: poolIdSchema.parse(poolId), name })).sort((a, b) => a.name.localeCompare(b.name));
  if (row === null) {
    return { registry: null, poolsNeedingIt, snapshots: [] };
  }
  const place: RegistryPlace = { url: registryHostOf(row.url), repositoryPrefix: row.repositoryPrefix };
  const pushed = await db.snapshot.findMany({
    where: { organizationId, registryId: row.id, pushedAt: { not: null }, digest: { not: null } },
    orderBy: [{ pushedAt: "desc" }, { id: "desc" }],
    take: SNAPSHOTS_MAX,
    select: { id: true, projectId: true, digest: true, pushedAt: true, project: { select: { name: true } } },
  });
  const check = registryCheckFromDb(row.checkResult);
  return {
    registry: {
      registryId: registryIdSchema.parse(row.id),
      url: row.url,
      repositoryPrefix: row.repositoryPrefix,
      auth: row.auth,
      pushSet: row.pushSecretId !== null,
      pullSet: row.pullSecretId !== null,
      check: check === null || row.checkedAt === null ? null : { ...check, checkedAt: row.checkedAt.getTime() },
      updatedAt: row.updatedAt.getTime(),
    },
    poolsNeedingIt,
    snapshots: pushed.flatMap((snapshot) => {
      const digest = imageDigestSchema.safeParse(snapshot.digest);
      if (!digest.success || snapshot.pushedAt === null) {
        return [];
      }
      const projectId: ProjectId = projectIdSchema.parse(snapshot.projectId);
      return [
        {
          snapshotId: snapshotIdSchema.parse(snapshot.id),
          projectId,
          projectName: snapshot.project.name,
          digest: digest.data,
          ref: registryImageByDigest(place, projectId, digest.data),
          pushedAt: snapshot.pushedAt.getTime(),
        },
      ];
    }),
  };
};

/** What the registry's use cases take, from the API's deps. */
const registryDeps = (deps: ApiDeps) => ({ db: deps.db, ...deps.ports });

export const registryRouter = router({
  get: adminProcedure.output(registryViewSchema).query(({ ctx }) => registryView(ctx.deps, ctx.scope.organizationId)),

  /** Sets the address, the prefix, the auth kind and the credentials; a credential left out keeps the stored one. */
  set: adminProcedure
    .input(
      z.strictObject({
        url: z.string().trim().min(1).max(255),
        repositoryPrefix: z.string().trim().max(200),
        auth: z.enum(["basic", "node"]),
        push: credentialInput.optional(),
        pull: credentialInput.optional(),
      }),
    )
    .output(registryViewSchema)
    .mutation(async ({ ctx, input }) => {
      unwrap(
        await setRegistry(registryDeps(ctx.deps), ctx.scope, {
          url: input.url,
          repositoryPrefix: input.repositoryPrefix,
          auth: input.auth,
          ...(input.push === undefined ? {} : { push: input.push }),
          ...(input.pull === undefined ? {} : { pull: input.pull }),
        }),
        { forbidden: "FORBIDDEN", "invalid-input": "BAD_REQUEST" },
      );
      return registryView(ctx.deps, ctx.scope.organizationId);
    }),

  /** Clears the registry: its credentials leave the secret store; the images stay where they are. */
  clear: adminProcedure.output(z.object({ cleared: z.boolean() })).mutation(async ({ ctx }) => {
    const done = unwrap(await clearRegistry(registryDeps(ctx.deps), ctx.scope), { forbidden: "FORBIDDEN" });
    return { cleared: done.cleared };
  }),

  /** Queues the check for the settings as they are, and returns at once. */
  check: adminProcedure.output(z.object({ version: z.number().int() })).mutation(async ({ ctx }) => {
    const organizationId = ctx.scope.organizationId;
    return ctx.deps.db.$transaction(async (tx) => {
      const row = await tx.registry.findUnique({ where: { organizationId }, select: { id: true, updatedAt: true } });
      if (row === null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No registry is set" });
      }
      const version = row.updatedAt.getTime();
      // Keyed by the settings' version: a check already queued for them is the one this asks for.
      await ctx.deps.ports.jobs.enqueueInTx(tx, "registry.check", { organizationId, registryId: registryIdSchema.parse(row.id), version });
      return { version };
    });
  }),
});
