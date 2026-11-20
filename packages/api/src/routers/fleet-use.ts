import { BOX_SIZE_MAX, BOX_SIZE_MIN, poolQueueInTx, projectPoolsInTx, slotHoldingBoxStates } from "@ostra/domain";
import { boxSizeNameSchema, executorKindSchema, poolIdSchema, projectIdSchema, PROTOCOL_MINOR, runnerIdSchema } from "@ostra/protocol";
import type { BoxSizeName, ExecutorKind, OrganizationId } from "@ostra/protocol";
import { z } from "zod";

import type { Db, Tx } from "@ostra/db";
import { memberProcedure, projectProcedure, router } from "../trpc/init.ts";
import { QUEUE_VIEW_MAX } from "./fleet-view.ts";

// F-095, F-086, F-069 (milestone 5's ticket 32): what the Box sizes page and a project's Runners
// tab show beside ticket 27's settings. Counts and names only: how many boxes of each size hold a
// slot now, which projects default to each, the most a runner offers, which runners enforce sizes;
// and per pool on a project's list, its executors, its cap, the boxes the project holds there and
// its tasks queued there. Reads only: every change goes through ticket 27's procedures.

const slotHolding = [...slotHoldingBoxStates];

/** The runners that count toward the fleet now: connected and approved, or finishing their boxes. */
const liveStates = ["online", "draining"] as const;

/** Whether a runner enforces a box's size as a limit: `docker` and `kubernetes` at minor 4 or later. */
const enforcesSizes = (runner: { readonly executor: ExecutorKind; readonly minor: number | null }): boolean =>
  runner.executor !== "host" && (runner.minor ?? 0) >= 4;

const offerSchema = z.object({ value: z.number().int(), runnerName: z.string() }).nullable();

export const boxSizeUseSchema = z.object({
  sizes: z.array(
    z.object({
      name: boxSizeNameSchema,
      /** The projects whose default is this size, by name. */
      projects: z.array(z.object({ id: projectIdSchema, name: z.string() })),
      /** Boxes of this size that hold a slot now. */
      boxesNow: z.number().int(),
    }),
  ),
  /** The largest offer of an online `docker` or `kubernetes` runner at minor 4 or later. */
  largest: z.object({ cpuMillis: offerSchema, memoryMiB: offerSchema }),
  runners: z.object({
    /** Online or draining `docker` and `kubernetes` runners at minor 4 or later. */
    enforce: z.number().int(),
    /** Online or draining `host` runners, and `docker` or `kubernetes` ones below minor 4. */
    slotsOnly: z.number().int(),
    host: z.number().int(),
    /** The ones one minor or more behind, by name. */
    behind: z.array(z.object({ id: runnerIdSchema, name: z.string() })),
  }),
  bounds: z.object({ min: z.object({ cpuMillis: z.number().int(), memoryMiB: z.number().int() }), max: z.object({ cpuMillis: z.number().int(), memoryMiB: z.number().int() }) }),
});
export type BoxSizeUse = z.infer<typeof boxSizeUseSchema>;

const largestOf = (runners: readonly { readonly name: string; readonly value: number | null }[]): { readonly value: number; readonly runnerName: string } | null =>
  runners.reduce<{ readonly value: number; readonly runnerName: string } | null>(
    (best, runner) => (runner.value === null || (best !== null && best.value >= runner.value) ? best : { value: runner.value, runnerName: runner.name }),
    null,
  );

export const projectPoolUseSchema = z.object({
  /** In the project's order, as `projects.runners` lists them. */
  pools: z.array(
    z.object({
      poolId: poolIdSchema,
      /** The executors its runners use, in a fixed order; none before a runner joins. */
      executors: z.array(executorKindSchema),
      /** The pool's own cap of boxes, or `null`. */
      poolMaxBoxes: z.number().int().nullable(),
      /** The project's boxes that hold a slot in the pool now. */
      held: z.number().int(),
      /** The project's tasks in the pool's queue now. */
      queued: z.number().int(),
      /** A pool with a `kubernetes` runner and no registry set builds and starts nothing. */
      needsRegistry: z.boolean(),
    }),
  ),
  /** The organization's pools not on the list, for "Add pool": names and executors only. */
  others: z.array(z.object({ poolId: poolIdSchema, name: z.string(), executors: z.array(executorKindSchema), poolMaxBoxes: z.number().int().nullable() })),
  /** The project's boxes that hold a slot across all its pools, and its queued tasks in any of them. */
  running: z.number().int(),
  waiting: z.number().int(),
});
export type ProjectPoolUse = z.infer<typeof projectPoolUseSchema>;

const executorOrder: readonly ExecutorKind[] = ["docker", "kubernetes", "host"];

const executorsByPool = async (db: Db | Tx, organizationId: OrganizationId): Promise<ReadonlyMap<string, readonly ExecutorKind[]>> => {
  const rows = await db.runner.findMany({
    where: { organizationId, kind: "pool", revokedAt: null, state: { not: "revoked" }, poolId: { not: null } },
    distinct: ["poolId", "executor"],
    select: { poolId: true, executor: true },
  });
  const byPool = new Map<string, ExecutorKind[]>();
  for (const row of rows) {
    if (row.poolId === null) continue;
    byPool.set(row.poolId, [...(byPool.get(row.poolId) ?? []), row.executor]);
  }
  return new Map([...byPool].map(([poolId, executors]) => [poolId, executorOrder.filter((executor) => executors.includes(executor))] as const));
};

export const fleetUseRouter = router({
  /** F-095: the Box sizes page's counts. Every member reads it, as `boxSizes.list`. */
  boxSizes: memberProcedure.output(boxSizeUseSchema).query(async ({ ctx }) => {
    const db = ctx.deps.db;
    const organizationId = ctx.scope.organizationId;
    const [projects, boxes, runners] = await Promise.all([
      db.project.findMany({ where: { organizationId, defaultBoxSize: { not: null } }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, defaultBoxSize: true } }),
      db.box.groupBy({ by: ["size"], where: { organizationId, state: { in: slotHolding }, size: { not: null } }, _count: { _all: true } }),
      db.runner.findMany({
        where: { organizationId, revokedAt: null, state: { in: [...liveStates] } },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, executor: true, minor: true, state: true, cpuMillis: true, memoryMiB: true },
      }),
    ]);
    const sizes = boxSizeNameSchema.options.map((name: BoxSizeName) => ({
      name,
      projects: projects.filter((project) => project.defaultBoxSize === name).map((project) => ({ id: projectIdSchema.parse(project.id), name: project.name })),
      boxesNow: boxes.find((row) => row.size === name)?._count._all ?? 0,
    }));
    const enforcing = runners.filter(enforcesSizes);
    const offering = enforcing.filter((runner) => runner.state === "online");
    return {
      sizes,
      largest: {
        cpuMillis: largestOf(offering.map((runner) => ({ name: runner.name, value: runner.cpuMillis }))),
        memoryMiB: largestOf(offering.map((runner) => ({ name: runner.name, value: runner.memoryMiB }))),
      },
      runners: {
        enforce: enforcing.length,
        slotsOnly: runners.length - enforcing.length,
        host: runners.filter((runner) => runner.executor === "host").length,
        behind: runners
          .filter((runner) => runner.executor !== "host" && (runner.minor ?? 0) < PROTOCOL_MINOR)
          .map((runner) => ({ id: runnerIdSchema.parse(runner.id), name: runner.name })),
      },
      bounds: { min: BOX_SIZE_MIN, max: BOX_SIZE_MAX },
    };
  }),

  /**
   * F-086, F-069: a project's use of its pools, for its Runners tab. The project's admins and the
   * organization's read it, as they set the list.
   */
  project: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(projectPoolUseSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const projectId = input.projectId;
      return ctx.deps.db.$transaction(async (tx) => {
        const entries = await projectPoolsInTx(tx, organizationId, projectId);
        const [pools, executors, boxes, registries] = await Promise.all([
          tx.runnerPool.findMany({ where: { organizationId }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, maxBoxes: true } }),
          executorsByPool(tx, organizationId),
          tx.box.findMany({ where: { organizationId, projectId, state: { in: slotHolding }, runnerId: { not: null } }, select: { runner: { select: { poolId: true } } } }),
          tx.registry.count({ where: { organizationId } }),
        ]);
        // The project's tasks in each pool's queue; a task waits in every pool that may run it, so the
        // total counts each once.
        const queues = new Map<string, readonly string[]>();
        for (const entry of entries) {
          const queue = await poolQueueInTx(tx, organizationId, entry.poolId, QUEUE_VIEW_MAX);
          queues.set(entry.poolId, queue.filter((task) => task.projectId === projectId).map((task) => task.taskId));
        }
        const listed = new Set<string>(entries.map((entry) => entry.poolId));
        return {
          pools: entries.map((entry) => {
            const pool = pools.find((row) => row.id === entry.poolId);
            const used = executors.get(entry.poolId) ?? [];
            return {
              poolId: entry.poolId,
              executors: [...used],
              poolMaxBoxes: pool?.maxBoxes ?? null,
              held: boxes.filter((box) => box.runner?.poolId === entry.poolId).length,
              queued: queues.get(entry.poolId)?.length ?? 0,
              needsRegistry: registries === 0 && used.includes("kubernetes"),
            };
          }),
          others: pools
            .filter((pool) => !listed.has(pool.id))
            .map((pool) => ({ poolId: poolIdSchema.parse(pool.id), name: pool.name, executors: [...(executors.get(pool.id) ?? [])], poolMaxBoxes: pool.maxBoxes })),
          running: boxes.length,
          waiting: new Set([...queues.values()].flat()).size,
        };
      });
    }),
});
