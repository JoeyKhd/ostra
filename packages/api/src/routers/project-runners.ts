import { projectPoolsInTx, setProjectPools } from "@ostra/domain";
import { boxSizeNameSchema, poolIdSchema, projectIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import type { MemberScope } from "@ostra/domain";
import { projectProcedure, unwrap } from "../trpc/init.ts";

// F-086, F-095 (milestone 5's ticket 27): a project's runners. The pools it may use, in its order,
// each with its share in boxes, and its default box size. Anyone who can open the project reads
// them; its admins and the organization's change them. A pool of another organization is refused.

const shareSchema = z.number().int().positive().max(100_000).nullable();

const projectRunnersSchema = z.object({
  /** In the project's order. A project that lists none uses the default pool, with no share. */
  pools: z.array(z.object({ poolId: poolIdSchema, name: z.string(), isDefault: z.boolean(), maxBoxes: shareSchema })),
  /** Whether the list is the project's own, or the default pool it falls back on. */
  listed: z.boolean(),
  defaultBoxSize: boxSizeNameSchema.nullable(),
});

const projectRunnersOf = async (deps: ApiDeps, scope: MemberScope, projectId: z.infer<typeof projectIdSchema>): Promise<z.infer<typeof projectRunnersSchema>> => {
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const [entries, listed, project] = await Promise.all([
      projectPoolsInTx(tx, organizationId, projectId),
      tx.projectPool.count({ where: { organizationId, projectId } }),
      tx.project.findFirstOrThrow({ where: { id: projectId, organizationId }, select: { defaultBoxSize: true } }),
    ]);
    const pools = await tx.runnerPool.findMany({ where: { organizationId, id: { in: entries.map((entry) => entry.poolId) } }, select: { id: true, name: true, isDefault: true } });
    const size = boxSizeNameSchema.safeParse(project.defaultBoxSize);
    return {
      pools: entries.flatMap((entry) => {
        const pool = pools.find((row) => row.id === entry.poolId);
        return pool === undefined ? [] : [{ poolId: entry.poolId, name: pool.name, isDefault: pool.isDefault, maxBoxes: entry.maxBoxes }];
      }),
      listed: listed > 0,
      defaultBoxSize: size.success ? size.data : null,
    };
  });
};

const setCodes = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST" } as const;

export const projectRunnerProcedures = {
  /** F-086, F-095: the project's pools in order with their shares, and its default box size. */
  runners: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(projectRunnersSchema)
    .query(({ ctx, input }) => projectRunnersOf(ctx.deps, ctx.scope, input.projectId)),

  /** F-086: the pools the project may use, in this order, each with its share (`null`: none). */
  setPools: projectProcedure(
    "admin",
    z.strictObject({
      projectId: projectIdSchema,
      pools: z.array(z.strictObject({ poolId: poolIdSchema, maxBoxes: shareSchema })).min(1).max(64),
    }),
  )
    .output(projectRunnersSchema)
    .mutation(async ({ ctx, input }) => {
      unwrap(await setProjectPools({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { projectId: input.projectId, pools: input.pools }), setCodes);
      return projectRunnersOf(ctx.deps, ctx.scope, input.projectId);
    }),

  /** F-095: the size a box of the project gets (`null`: none, slots only). */
  setDefaultBoxSize: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, size: boxSizeNameSchema.nullable() }))
    .output(projectRunnersSchema)
    .mutation(async ({ ctx, input }) => {
      unwrap(await setProjectPools({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { projectId: input.projectId, defaultBoxSize: input.size }), setCodes);
      return projectRunnersOf(ctx.deps, ctx.scope, input.projectId);
    }),
};
