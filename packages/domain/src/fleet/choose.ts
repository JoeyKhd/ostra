import type { BoxSizeName, PoolId, ProjectId, RunnerId, TaskId } from "@ostra/protocol";

import type { DispatchWait } from "../dispatch-wait.ts";
import { couldEverFit, fits, projectUseOfPool, poolUse, runnerRoom } from "./capacity.ts";
import type { FleetBox, FleetRunner, Resources, Room } from "./capacity.ts";
import { labelsMatch } from "./labels.ts";

// Choosing a runner (F-069, ADR 0059). Pure: core reads the rows in the admitting transaction,
// under the pool's lock, and passes them in (ticket 14 calls it from the admission, ticket 13).
//
// - A task a member started and picked their personal runner for goes to that runner only.
// - A task no member started (intake rules, schedules and agent mode, milestone 6) goes to pools
//   only, and is never offered to a personal runner, even when its member is known.
// - Otherwise the project's pools in the project's order. In a pool, a runner is a candidate when
//   it's online and approved, carries every label the task needs, declares what it needs
//   (services; a registry where its executor requires one and the organization has none), has a
//   free slot and, where sizes apply, room for the box's whole footprint. The project's share
//   and the pool's cap apply on top. Among candidates: the most free room, then the runner
//   holding the project's ready snapshot, then the one offered least recently, then the ID.
// - When nothing fits anywhere, the task waits with the nearest miss across the pools. The checks
//   run in the order ADR 0059 lists the reasons (a registry, services, labels, the size, the
//   share, the pool's cap, a runner online) and then the room now (`queued`). A pool's miss is
//   the furthest check any of its runners reached, and the task's reason is the pool that got
//   furthest (the first such pool in the project's order).

/** The task being placed. */
export type ChooseTask = {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  /** The personal runner its member picked; ignored for a task no member started. */
  readonly personalRunnerId: RunnerId | null;
  /** Whether a member started it. `false` for a rule's, a schedule's or the agent mode's. */
  readonly startedByMember: boolean;
  /** The labels a runner needs, copied from the profile when it was queued. */
  readonly requiredLabels: readonly string[];
  /** Whether its environment has services, which `host` never starts (milestone 3's rule). */
  readonly needsServices: boolean;
  /**
   * The project's default size with its whole footprint (`boxFootprint`), or `null` when the
   * project names none (slots only).
   */
  readonly size: { readonly name: BoxSizeName; readonly footprint: Resources } | null;
};

/** The project's pools in its order, each with its share, and its ready snapshot's runner. */
export type ChooseProject = {
  readonly id: ProjectId;
  /** `ProjectPool` rows, in any order: sorted by `position` here. */
  readonly pools: readonly { readonly poolId: PoolId; readonly position: number; readonly maxBoxes: number | null }[];
  /** The runner that holds the project's ready snapshot, if one does (milestone 3's rule). */
  readonly snapshotRunnerId: RunnerId | null;
};

/** A pool as the choice reads it. */
export type ChoosePool = { readonly id: PoolId; readonly maxBoxes: number | null };

export type ChooseInput = {
  readonly task: ChooseTask;
  readonly project: ChooseProject;
  readonly pools: readonly ChoosePool[];
  readonly runners: readonly FleetRunner[];
  readonly boxes: readonly FleetBox[];
  /** Whether the organization has a registry set (F-120). */
  readonly registrySet: boolean;
  /** The task's place in each pool's queue (`placeInQueue`), for `queued`; 1 where absent. */
  readonly places?: ReadonlyMap<PoolId, number>;
};

export type ChooseResult =
  | { readonly kind: "runner"; readonly runnerId: RunnerId; /** `null` for a personal runner. */ readonly poolId: PoolId | null }
  | { readonly kind: "waits"; readonly reason: DispatchWait };

/** Whether an executor starts services: from what it declares, or for an older runner from its kind. */
const startsServices = (runner: FleetRunner): boolean => runner.capabilities?.services ?? runner.executor !== "host";

/** Whether an executor needs a registry for its snapshots: `kubernetes` does (ADR 0060). */
const needsRegistry = (runner: FleetRunner): boolean =>
  (runner.capabilities?.registry ?? (runner.executor === "kubernetes" ? "required" : "none")) === "required";

/** A runner that's joined and not removed: one that could take this task once it's online with room. */
const isMember = (runner: FleetRunner): boolean => runner.approved && runner.state !== "joining" && runner.state !== "revoked";

/** How far a pool got: the furthest check its runners reached, and the reason it stopped there. */
type Miss = { readonly step: number; readonly reason: DispatchWait };

/** The order among candidates: most free room, then the snapshot's holder, then least recently offered, then the ID. */
const compareCandidates =
  (snapshotRunnerId: RunnerId | null) =>
  (a: { readonly runner: FleetRunner; readonly room: Room }, b: { readonly runner: FleetRunner; readonly room: Room }): number => {
    if (a.room.slots !== b.room.slots) {
      return b.room.slots - a.room.slots;
    }
    const cpuA = a.room.resources?.cpuMillis ?? 0;
    const cpuB = b.room.resources?.cpuMillis ?? 0;
    if (cpuA !== cpuB) {
      return cpuB - cpuA;
    }
    const memoryA = a.room.resources?.memoryMiB ?? 0;
    const memoryB = b.room.resources?.memoryMiB ?? 0;
    if (memoryA !== memoryB) {
      return memoryB - memoryA;
    }
    const holdsA = a.runner.id === snapshotRunnerId;
    const holdsB = b.runner.id === snapshotRunnerId;
    if (holdsA !== holdsB) {
      return holdsA ? -1 : 1;
    }
    const offeredA = a.runner.lastOfferedAt ?? -1;
    const offeredB = b.runner.lastOfferedAt ?? -1;
    if (offeredA !== offeredB) {
      return offeredA - offeredB;
    }
    return a.runner.id < b.runner.id ? -1 : a.runner.id > b.runner.id ? 1 : 0;
  };

type PoolOutcome = { readonly kind: "runner"; readonly runnerId: RunnerId } | { readonly kind: "miss"; readonly miss: Miss };

const choosePool = (input: ChooseInput, pool: ChoosePool, share: number | null): PoolOutcome => {
  const { task } = input;
  const need = task.size?.footprint ?? null;
  const members = input.runners.filter((runner) => runner.poolId === pool.id && runner.kind === "pool" && isMember(runner));
  if (members.length === 0) {
    return { kind: "miss", miss: { step: 0, reason: { code: "no-runner-online" } } };
  }
  // What a runner is, whether or not it's online now.
  const withRegistry = members.filter((runner) => !needsRegistry(runner) || input.registrySet);
  if (withRegistry.length === 0) {
    return { kind: "miss", miss: { step: 1, reason: { code: "needs-registry", poolId: pool.id } } };
  }
  const withServices = task.needsServices ? withRegistry.filter(startsServices) : withRegistry;
  if (withServices.length === 0) {
    return { kind: "miss", miss: { step: 2, reason: { code: "needs-services" } } };
  }
  const withLabels = withServices.filter((runner) => labelsMatch(task.requiredLabels, runner.labels));
  if (withLabels.length === 0) {
    return { kind: "miss", miss: { step: 3, reason: { code: "no-runner-with-labels", labels: [...task.requiredLabels] } } };
  }
  const bigEnough = withLabels.filter((runner) => couldEverFit(runner, need));
  if (bigEnough.length === 0 && task.size !== null) {
    return { kind: "miss", miss: { step: 4, reason: { code: "size-too-large", size: task.size.name } } };
  }
  // The project's share and the pool's cap, counted from `Box` rows.
  if (share !== null && projectUseOfPool(task.projectId, pool.id, input.runners, input.boxes) >= share) {
    return { kind: "miss", miss: { step: 5, reason: { code: "project-share-reached", poolId: pool.id, cap: share } } };
  }
  if (poolUse(pool, input.runners, input.boxes).full) {
    return { kind: "miss", miss: { step: 6, reason: { code: "pool-full", poolId: pool.id } } };
  }
  // Online now, and with room now.
  const online = bigEnough.filter((runner) => runner.state === "online");
  if (online.length === 0) {
    return { kind: "miss", miss: { step: 7, reason: { code: "no-runner-online" } } };
  }
  const candidates = online.map((runner) => ({ runner, room: runnerRoom(runner, input.boxes) })).filter((candidate) => fits(candidate.room, need));
  const best = [...candidates].sort(compareCandidates(input.project.snapshotRunnerId))[0];
  if (best === undefined) {
    return { kind: "miss", miss: { step: 8, reason: { code: "queued", poolId: pool.id, place: input.places?.get(pool.id) ?? 1 } } };
  }
  return { kind: "runner", runnerId: best.runner.id };
};

/** The personal runner a member picked: that runner only. */
const choosePersonal = (input: ChooseInput, runnerId: RunnerId): ChooseResult => {
  const runner = input.runners.find((candidate) => candidate.id === runnerId && candidate.kind === "personal");
  if (runner?.state !== "online") {
    return { kind: "waits", reason: { code: "personal-runner-unavailable" } };
  }
  if (input.task.needsServices && !startsServices(runner)) {
    return { kind: "waits", reason: { code: "needs-services" } };
  }
  return fits(runnerRoom(runner, input.boxes), input.task.size?.footprint ?? null)
    ? { kind: "runner", runnerId: runner.id, poolId: null }
    : { kind: "waits", reason: { code: "personal-runner-unavailable" } };
};

/** Chooses the runner for a queued task, or says why it waits (ADR 0059). */
export const chooseRunner = (input: ChooseInput): ChooseResult => {
  if (input.task.startedByMember && input.task.personalRunnerId !== null) {
    return choosePersonal(input, input.task.personalRunnerId);
  }
  const pools = new Map(input.pools.map((pool) => [pool.id, pool]));
  let nearest: Miss | null = null;
  const ordered = [...input.project.pools].sort((a, b) => a.position - b.position || (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
  for (const entry of ordered) {
    const pool = pools.get(entry.poolId);
    if (pool === undefined) {
      continue;
    }
    const outcome = choosePool(input, pool, entry.maxBoxes);
    if (outcome.kind === "runner") {
      return { kind: "runner", runnerId: outcome.runnerId, poolId: pool.id };
    }
    if (nearest === null || outcome.miss.step > nearest.step) {
      nearest = outcome.miss;
    }
  }
  return { kind: "waits", reason: nearest?.reason ?? { code: "no-runner-online" } };
};
