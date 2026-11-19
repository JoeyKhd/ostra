import type { BoxSizeName, ExecutorKind, PoolId, ProjectId, RunnerCapabilities, RunnerId } from "@ostra/protocol";

// Capacity (F-067, F-095, ADR 0059): what a runner offers, what its boxes hold, and the room
// left. Pure functions over rows, with no I/O: core reads the rows in the admitting transaction
// and passes them in, so the count and the choice see the same snapshot (ADR 0037).
//
// - A runner offers slots everywhere, and CPU and memory where sizes apply (`docker`,
//   `kubernetes`). What it reports is its whole offer: the engine's or the quota's, less its
//   reserve. The boxes ostra placed on it are subtracted here, from `Box` rows, never from the
//   runner's own count, so two admissions in a row can't both see the same room.
// - A box takes a slot and, where sizes apply, its whole footprint: the agent's size, the
//   sidecar's limit and each service's limit (`boxFootprint`).
// - A box holds its slot while it's `creating`, `preparing`, `ready` or `idle`. A `stopped`,
//   `released` or `failed` box holds none.

/** A box's state, as the schema names it. */
export type FleetBoxState = "creating" | "preparing" | "ready" | "idle" | "stopped" | "released" | "failed";

/** A runner's state, as the schema names it. */
export type FleetRunnerState = "joining" | "online" | "offline" | "draining" | "revoked";

/** The states in which a box holds a slot on its runner and counts toward a share or a cap. */
export const slotHoldingBoxStates: ReadonlySet<FleetBoxState> = new Set<FleetBoxState>(["creating", "preparing", "ready", "idle"]);

/** Whether a box in this state holds a slot. */
export const holdsSlot = (state: FleetBoxState): boolean => slotHoldingBoxStates.has(state);

/** CPU and memory, as a box needs or a runner offers. */
export type Resources = { readonly cpuMillis: number; readonly memoryMiB: number };

/** A named size with its limits (an organization's `BoxSize` row). */
export type BoxSizeLimits = Resources & { readonly name: BoxSizeName };

/** The fixed limits beside the agent's container (ADR 0059's working values, from the settings). */
export type FootprintLimits = {
  /** The sidecar's limit (`OSTRA_SIDECAR_CPU_MILLIS`, `OSTRA_SIDECAR_MEMORY_MIB`). */
  readonly sidecar: Resources;
  /** A service's limit when it names none (`OSTRA_SERVICE_CPU_MILLIS`, `OSTRA_SERVICE_MEMORY_MIB`). */
  readonly service: Resources;
};

/** ADR 0059's working values: the sidecar 1 vCPU and 256 MiB, a service 1 vCPU and 1 GiB. */
export const defaultFootprintLimits: FootprintLimits = {
  sidecar: { cpuMillis: 1000, memoryMiB: 256 },
  service: { cpuMillis: 1000, memoryMiB: 1024 },
};

/**
 * A box's whole footprint where sizes apply: the agent's size, the sidecar's limit, and each
 * service's own limit or the default one. `services` lists each service's limits, `null` for one
 * that names none.
 */
export const boxFootprint = (
  size: Resources,
  services: readonly (Resources | null)[],
  limits: FootprintLimits = defaultFootprintLimits,
): Resources =>
  services.reduce<Resources>(
    (sum, service) => {
      const own = service ?? limits.service;
      return { cpuMillis: sum.cpuMillis + own.cpuMillis, memoryMiB: sum.memoryMiB + own.memoryMiB };
    },
    { cpuMillis: size.cpuMillis + limits.sidecar.cpuMillis, memoryMiB: size.memoryMiB + limits.sidecar.memoryMiB },
  );

/** A runner as capacity and the choice read it: its row's columns, already parsed. */
export type FleetRunner = {
  readonly id: RunnerId;
  /** `null` for a personal runner. */
  readonly poolId: PoolId | null;
  readonly kind: "pool" | "personal";
  readonly executor: ExecutorKind;
  readonly state: FleetRunnerState;
  /** A pool runner in a pool that requires approval, not yet approved, stays `joining`. */
  readonly approved: boolean;
  /** The slots it runs at once: `slots` from its last report, or its `capacity` column. */
  readonly slots: number;
  /** What it offers where sizes apply, or `null` (`host`, or a minor-3 runner: slots only). */
  readonly resources: Resources | null;
  /** Its labels, the built-in `executor:`, `os:` and `arch:` ones included. */
  readonly labels: readonly string[];
  /** What its executor can do; `null` for a runner below minor 4, read from its executor. */
  readonly capabilities: RunnerCapabilities | null;
  /** Epoch ms of its last offer, or `null` for never. */
  readonly lastOfferedAt: number | null;
};

/** A box as capacity reads it. */
export type FleetBox = {
  readonly runnerId: RunnerId | null;
  readonly projectId: ProjectId;
  readonly state: FleetBoxState;
  /** Its whole footprint where sizes apply (`boxFootprint`), or `null` (slots only). */
  readonly footprint: Resources | null;
};

/** A runner's free room: its free slots, and its free CPU and memory where sizes apply. */
export type Room = {
  readonly slots: number;
  /** `null`: sizes don't apply on this runner, so only slots count. */
  readonly resources: Resources | null;
};

/** The boxes that hold a slot on a runner. */
const liveBoxesOn = (runnerId: RunnerId, boxes: readonly FleetBox[]): readonly FleetBox[] =>
  boxes.filter((box) => box.runnerId === runnerId && holdsSlot(box.state));

/**
 * A runner's free room: its slots less its live boxes, and where sizes apply its CPU and memory
 * less their footprints. Never below zero.
 */
export const runnerRoom = (runner: FleetRunner, boxes: readonly FleetBox[]): Room => {
  const live = liveBoxesOn(runner.id, boxes);
  const slots = Math.max(0, runner.slots - live.length);
  if (runner.resources === null) {
    return { slots, resources: null };
  }
  const used = live.reduce<Resources>(
    (sum, box) => ({
      cpuMillis: sum.cpuMillis + (box.footprint?.cpuMillis ?? 0),
      memoryMiB: sum.memoryMiB + (box.footprint?.memoryMiB ?? 0),
    }),
    { cpuMillis: 0, memoryMiB: 0 },
  );
  return {
    slots,
    resources: {
      cpuMillis: Math.max(0, runner.resources.cpuMillis - used.cpuMillis),
      memoryMiB: Math.max(0, runner.resources.memoryMiB - used.memoryMiB),
    },
  };
};

/**
 * Whether a box fits in a room: a free slot, and where both sides count resources, its whole
 * footprint. `need` `null`: a task with no size (slots only). A room without resources (`host`,
 * a minor-3 runner) counts slots only, as milestone 1 did.
 */
export const fits = (room: Room, need: Resources | null): boolean => {
  if (room.slots < 1) {
    return false;
  }
  if (need === null || room.resources === null) {
    return true;
  }
  return need.cpuMillis <= room.resources.cpuMillis && need.memoryMiB <= room.resources.memoryMiB;
};

/** Whether a footprint could ever fit a runner: its whole offer, with no box on it. */
export const couldEverFit = (runner: FleetRunner, need: Resources | null): boolean =>
  need === null ||
  runner.resources === null ||
  (need.cpuMillis <= runner.resources.cpuMillis && need.memoryMiB <= runner.resources.memoryMiB);

/** A pool's capacity and use, for the fleet view and the admission. */
export type PoolUse = {
  /** The slots of its runners that take tasks (`online` and approved). */
  readonly slots: number;
  /** Its live boxes, on any of its runners. */
  readonly boxes: number;
  /** Its free slots, on runners that take tasks. */
  readonly freeSlots: number;
  /** Its cap on boxes at once, or `null` for none. */
  readonly maxBoxes: number | null;
  /** Whether the cap is reached. */
  readonly full: boolean;
};

/** Whether a runner may be offered a task now: online and approved. */
export const takesOffers = (runner: FleetRunner): boolean => runner.state === "online" && runner.approved;

/** A pool's capacity and use, counted from its runners and their `Box` rows. */
export const poolUse = (
  pool: { readonly id: PoolId; readonly maxBoxes: number | null },
  runners: readonly FleetRunner[],
  boxes: readonly FleetBox[],
): PoolUse => {
  const members = runners.filter((runner) => runner.poolId === pool.id);
  const ids = new Set(members.map((runner) => runner.id));
  const live = boxes.filter((box) => box.runnerId !== null && ids.has(box.runnerId) && holdsSlot(box.state));
  const taking = members.filter(takesOffers);
  return {
    slots: taking.reduce((sum, runner) => sum + runner.slots, 0),
    boxes: live.length,
    freeSlots: taking.reduce((sum, runner) => sum + runnerRoom(runner, boxes).slots, 0),
    maxBoxes: pool.maxBoxes,
    full: pool.maxBoxes !== null && live.length >= pool.maxBoxes,
  };
};

/** A project's live boxes on a pool's runners: what its share counts (ADR 0059). */
export const projectUseOfPool = (
  projectId: ProjectId,
  poolId: PoolId,
  runners: readonly FleetRunner[],
  boxes: readonly FleetBox[],
): number => {
  const ids = new Set(runners.filter((runner) => runner.poolId === poolId).map((runner) => runner.id));
  return boxes.filter((box) => box.projectId === projectId && box.runnerId !== null && ids.has(box.runnerId) && holdsSlot(box.state)).length;
};

/**
 * A personal runner's slots: what its member set on the runner, or the setting's default
 * (`OSTRA_PERSONAL_RUNNER_CAPACITY`, 2).
 */
export const personalRunnerSlots = (memberSet: number | null, settingDefault: number): number => memberSet ?? settingDefault;
