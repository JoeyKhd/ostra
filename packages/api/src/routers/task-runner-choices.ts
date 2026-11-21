import {
  boxFootprint,
  chooseRunner,
  DEFAULT_PERSONAL_RUNNER_SLOTS,
  dispatchWaitSchema,
  fits,
  fleetInTx,
  poolsInTx,
  projectPoolsInTx,
  projectSizeInTx,
  modelImageInput,
  modelImageInputSchema,
  resolveProfileModelInTx,
  resolveStartProfileInTx,
  runnerRoom,
  runnerTakesFilesInTx,
} from "@ostra/domain";
import type { ChooseTask, DispatchWait, FleetRunner } from "@ostra/domain";
import { agentProfileIdSchema, modelIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { projectProcedure } from "../trpc/init.ts";

// F-069, F-014 (milestone 5's ticket 27): New task's runner picker. "A pool", with each of the
// project's pools in its order and whether it could take the task now, and the member's own
// personal runners, each with whether it can and why not. It reads the rows the dispatch reads and
// runs the same `chooseRunner`, without the locks: it says what the dispatch would decide now, and
// the dispatch still decides when the task is queued. Only the caller's own personal runners are
// offered; `tasks.create` refuses any other (`runner-not-yours`).

/** Why a member's personal runner can't take the task now. */
export const personalRunnerBlockSchema = z.enum([
  /** Not connected, or not online. */
  "offline",
  /** Every slot holds a box, or there's no room for the project's size. */
  "busy",
  /** The project's environment has services, and the runner starts none (`host`, milestone 3's rule). */
  "needs-services",
  /** The project's model provider isn't allowed on personal runners (Q47). */
  "provider-not-allowed",
]);
export type PersonalRunnerBlock = z.infer<typeof personalRunnerBlockSchema>;

export const runnerChoicesSchema = z.object({
  pool: z.object({
    /** Whether any of the project's pools could take the task now. */
    canRun: z.boolean(),
    /** When none can, the nearest miss across them, as the task's waiting line would say it. */
    reason: dispatchWaitSchema.nullable(),
    pools: z.array(z.object({ poolId: poolIdSchema, name: z.string(), canRun: z.boolean(), reason: dispatchWaitSchema.nullable() })),
  }),
  personal: z.array(
    z.object({
      runnerId: runnerIdSchema,
      name: z.string(),
      canRun: z.boolean(),
      reason: personalRunnerBlockSchema.nullable(),
      /** Boxes it holds now, against its slots: "busy (2 of 2)". */
      busy: z.number().int(),
      slots: z.number().int(),
      /** Milestone 9 (F-148/c9, Q340): whether it speaks protocol minor 8, so a task with files can run on it. */
      takesFiles: z.boolean(),
    }),
  ),
  /**
   * Milestone 9 (F-148/c5, ticket 14): the model the task would start on (the profile's, as the
   * project's providers serve it), by name, and whether it sees images (`yes`, `no`, `unknown`:
   * unknown counts as no), for the new-task box's note; `null` when nothing serves it.
   */
  model: z.object({ id: modelIdSchema, name: z.string(), imageInput: modelImageInputSchema }).nullable(),
  /** Whether the profile's agent takes images in its prompt (its adapter's `promptImages`). */
  agentTakesImages: z.boolean(),
});
export type RunnerChoices = z.infer<typeof runnerChoicesSchema>;

/** A stand-in for the task the picker places: it isn't made yet. */
const PICKER_TASK_ID = taskIdSchema.parse("00000000-0000-7000-8000-000000000000");

const startsServices = (runner: FleetRunner): boolean => runner.capabilities?.services ?? runner.executor !== "host";

export const runnerChoicesProcedure = projectProcedure("read", z.strictObject({ projectId: projectIdSchema, profileId: agentProfileIdSchema.optional() }))
  .output(runnerChoicesSchema)
  .query(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const scope = ctx.scope;
    const organizationId = scope.organizationId;
    const projectId = input.projectId;
    const now = ports.clock.now();
    return db.$transaction(async (tx): Promise<RunnerChoices> => {
      const project = await tx.project.findFirstOrThrow({
        where: { id: projectId, organizationId },
        select: { defaultRefineProfileId: true, defaultCodeProfileId: true, defaultReviewProfileId: true },
      });
      const resolved = await resolveStartProfileInTx(tx, scope, { project, kind: "code", chosen: input.profileId });
      if (!resolved.ok) {
        throw new TRPCError({ code: resolved.error === "forbidden" ? "FORBIDDEN" : "PRECONDITION_FAILED", message: resolved.message });
      }
      const profile = await tx.agentProfile.findFirstOrThrow({ where: { id: resolved.profileId, organizationId }, select: { runnerLabels: true, adapter: true } });
      const [serviceCount, size, served] = await Promise.all([
        tx.service.count({ where: { projectId, organizationId } }),
        projectSizeInTx(tx, organizationId, projectId),
        resolveProfileModelInTx(tx, { organizationId, projectId, profileId: resolved.profileId }),
      ]);
      const task: ChooseTask = {
        id: PICKER_TASK_ID,
        projectId,
        personalRunnerId: null,
        startedByMember: true,
        requiredLabels: [...new Set(profile.runnerLabels)].sort(),
        needsServices: serviceCount > 0,
        size: size === null ? null : { name: size.name, footprint: boxFootprint(size.limits, Array.from({ length: serviceCount }, () => null)) },
      };
      const options = { now, personalSlots: DEFAULT_PERSONAL_RUNNER_SLOTS };

      // "A pool": each of the project's pools in its order, alone, then all of them for the nearest miss.
      const projectPools = await projectPoolsInTx(tx, organizationId, projectId);
      const poolIds = projectPools.map((entry) => entry.poolId);
      const [pools, names, registrySet, fleet] = await Promise.all([
        poolsInTx(tx, organizationId, poolIds),
        tx.runnerPool.findMany({ where: { organizationId, id: { in: poolIds } }, select: { id: true, name: true } }),
        tx.registry.count({ where: { organizationId } }).then((count) => count > 0),
        fleetInTx(tx, organizationId, { poolIds }, options),
      ]);
      const nameOf = new Map(names.map((row) => [row.id, row.name] as const));
      const choose = (entries: typeof projectPools) =>
        chooseRunner({ task, project: { id: projectId, pools: entries, snapshotRunnerId: null }, pools, runners: fleet.runners, boxes: fleet.boxes, registrySet });
      const perPool = projectPools.map((entry) => {
        const choice = choose([entry]);
        return { poolId: entry.poolId, name: nameOf.get(entry.poolId) ?? "", canRun: choice.kind === "runner", reason: choice.kind === "waits" ? choice.reason : null };
      });
      const all = choose(projectPools);
      const nearest: DispatchWait | null = all.kind === "waits" ? all.reason : null;

      // The member's own personal runners: theirs only, never another member's.
      const owned = await tx.runner.findMany({
        where: { organizationId, kind: "personal", ownerMemberId: scope.memberId, state: { not: "revoked" }, revokedAt: null },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      const mine = await fleetInTx(
        tx,
        organizationId,
        { runnerIds: owned.map((row) => runnerIdSchema.parse(row.id)) },
        options,
      );
      const providerAllowed = served.ok && served.allowOnPersonalRunners;
      // Milestone 9 (Q340): a task with files goes only to a runner at protocol minor 8.
      const takesFiles = new Map(await Promise.all(owned.map(async (row) => [row.id, await runnerTakesFilesInTx(tx, row.id)] as const)));
      const personal = owned.flatMap((row) => {
        const runner = mine.runners.find((candidate) => candidate.id === row.id);
        if (runner === undefined) {
          return [];
        }
        const room = runnerRoom(runner, mine.boxes);
        const block: PersonalRunnerBlock | null =
          runner.state !== "online"
            ? "offline"
            : task.needsServices && !startsServices(runner)
              ? "needs-services"
              : !providerAllowed
                ? "provider-not-allowed"
                : !fits(room, task.size?.footprint ?? null)
                  ? "busy"
                  : null;
        return [{ runnerId: runner.id, name: row.name, canRun: block === null, reason: block, busy: Math.max(0, runner.slots - room.slots), slots: runner.slots, takesFiles: takesFiles.get(row.id) ?? false }];
      });
      // Milestone 9 (F-148/c5): the model the task would start on, and whether it sees images.
      const model = served.ok
        ? await tx.model.findFirst({ where: { id: served.modelId, organizationId }, select: { id: true, displayName: true, endpointModelId: true, adminImageInput: true, catalogInputModalities: true } })
        : null;
      return {
        pool: { canRun: all.kind === "runner", reason: nearest, pools: perPool },
        personal,
        model: model === null ? null : { id: modelIdSchema.parse(model.id), name: model.displayName ?? model.endpointModelId, imageInput: modelImageInput(model) },
        agentTakesImages: ctx.deps.messageFiles.agentTakesImages(profile.adapter),
      };
    });
  });
