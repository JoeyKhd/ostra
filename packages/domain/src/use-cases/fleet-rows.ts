import type { Tx } from "@ostra/db";
import { boxSizeNameSchema, poolIdSchema, projectIdSchema, runnerCapabilitiesSchema, runnerIdSchema, runnerLimits } from "@ostra/protocol";
import type { BoxSizeName, OrganizationId, PoolId, ProjectId, RunnerCapabilities, RunnerId } from "@ostra/protocol";

import { boxFootprint, slotHoldingBoxStates } from "../fleet/capacity.ts";
import type { FleetBox, FleetBoxState, FleetRunner, Resources } from "../fleet/capacity.ts";
import type { ChoosePool, ChooseProject } from "../fleet/choose.ts";
import { runnerStartsServices } from "../environment/services.ts";
import { awaitsApproval } from "./runner-approval.ts";

// The rows capacity and the choice read (F-067, F-069, F-095, ADR 0059), read in the admitting
// transaction. The pure functions in `../fleet/` decide; these only read and lock.
//
// - A pool's admission takes its row `FOR NO KEY UPDATE` before it counts, so two admissions of
//   one pool, from any replica, count and grant one after the other: a share or a cap is never
//   exceeded. Pools are locked in ID order, so two tasks of projects with the same pools in another
//   order can't deadlock.
// - A personal runner's admission takes the runner's row instead: its slots are its own.

/** The default `OSTRA_PERSONAL_RUNNER_CAPACITY`. */
export const DEFAULT_PERSONAL_RUNNER_SLOTS = 2;

/** The minor from which a runner reports its slots, resources and capabilities. */
export const FLEET_REPORT_MINOR = 4;

const slotHolding = [...slotHoldingBoxStates];

/** Takes each pool's row in ID order, for the rest of the transaction. */
export const lockPoolsInTx = async (tx: Tx, organizationId: OrganizationId, poolIds: readonly PoolId[]): Promise<void> => {
  for (const poolId of [...new Set(poolIds)].sort()) {
    await tx.$queryRaw`SELECT 1 FROM "runner_pool" WHERE "id" = ${poolId} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`;
  }
};

/** Takes a runner's row for the rest of the transaction (a personal runner's admission). */
export const lockRunnerInTx = async (tx: Tx, organizationId: OrganizationId, runnerId: RunnerId): Promise<void> => {
  await tx.$queryRaw`SELECT 1 FROM "runner" WHERE "id" = ${runnerId} AND "organizationId" = ${organizationId} FOR NO KEY UPDATE`;
};

/**
 * The project's pools in its order, each with its share. A project that lists none uses the
 * organization's default pool, with no share, as milestone 1 did.
 */
export const projectPoolsInTx = async (tx: Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<ChooseProject["pools"]> => {
  const listed = await tx.projectPool.findMany({
    where: { organizationId, projectId },
    select: { poolId: true, position: true, maxBoxes: true },
    orderBy: [{ position: "asc" }, { poolId: "asc" }],
  });
  if (listed.length > 0) {
    return listed.map((row) => ({ poolId: poolIdSchema.parse(row.poolId), position: row.position, maxBoxes: row.maxBoxes }));
  }
  const fallback = await tx.runnerPool.findFirst({ where: { organizationId, isDefault: true }, select: { id: true } });
  return fallback === null ? [] : [{ poolId: poolIdSchema.parse(fallback.id), position: 0, maxBoxes: null }];
};

/** The pools' rows as the choice reads them. */
export const poolsInTx = async (tx: Tx, organizationId: OrganizationId, poolIds: readonly PoolId[]): Promise<readonly ChoosePool[]> => {
  const rows = await tx.runnerPool.findMany({ where: { organizationId, id: { in: [...poolIds] } }, select: { id: true, maxBoxes: true } });
  return rows.map((row) => ({ id: poolIdSchema.parse(row.id), maxBoxes: row.maxBoxes }));
};

/** What reading the fleet needs beyond the rows. */
export type FleetReadOptions = {
  readonly now: number;
  /** A runner below this minor is read as offline: the task needs a later protocol. */
  readonly minMinor?: number;
  /** `OSTRA_PERSONAL_RUNNER_CAPACITY`. */
  readonly personalSlots?: number;
};

const runnerSelect = {
  id: true,
  kind: true,
  poolId: true,
  executor: true,
  state: true,
  revokedAt: true,
  approvedAt: true,
  capacity: true,
  slots: true,
  cpuMillis: true,
  memoryMiB: true,
  labels: true,
  capabilities: true,
  minor: true,
  lastOfferedAt: true,
  pool: { select: { requiresApproval: true } },
  presence: { select: { minor: true, disconnectedAt: true, lastSeenAt: true } },
} as const;

type RunnerRow = {
  readonly id: string;
  readonly kind: "pool" | "personal";
  readonly poolId: string | null;
  readonly executor: FleetRunner["executor"];
  readonly state: FleetRunner["state"];
  readonly revokedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly capacity: number;
  readonly slots: number | null;
  readonly cpuMillis: number | null;
  readonly memoryMiB: number | null;
  readonly labels: readonly string[];
  readonly capabilities: unknown;
  readonly minor: number | null;
  readonly lastOfferedAt: Date | null;
  readonly pool: { readonly requiresApproval: boolean } | null;
  readonly presence: { readonly minor: number; readonly disconnectedAt: Date | null; readonly lastSeenAt: Date } | null;
};

/** The protocol minor a runner speaks: its live connection's, else the one it last reported. */
export const runnerMinorOf = (row: Pick<RunnerRow, "minor" | "presence">): number => row.presence?.minor ?? row.minor ?? 0;

/**
 * A runner's slots (ADR 0059): what it last reported (its offer's slots, or its capacity). A
 * personal runner at minor 4 that hasn't reported yet takes `OSTRA_PERSONAL_RUNNER_CAPACITY` (2);
 * one below minor 4 runs what its own `--capacity` says, and refuses more.
 */
export const runnerSlotsOf = (row: Pick<RunnerRow, "kind" | "slots" | "capacity" | "minor" | "presence">, personalSlots: number): number => {
  if (row.kind === "pool") {
    return row.slots ?? row.capacity;
  }
  return runnerMinorOf(row) >= FLEET_REPORT_MINOR ? (row.slots ?? personalSlots) : row.capacity;
};

/**
 * What a runner below minor 4 can do, which it never reports: read from its executor and minor.
 * Services from minor 2 and never on `host` (milestone 3's rule), no sizes, no registry.
 */
export const olderCapabilities = (executor: FleetRunner["executor"], minor: number): RunnerCapabilities => ({
  isolation: executor === "host" ? "none" : "container",
  services: runnerStartsServices({ executor, minor }),
  boxSizes: false,
  snapshots: executor === "docker" ? "image" : executor === "host" ? "host-cache" : "none",
  registry: "none",
  nodeWait: false,
});

/** A runner's row as capacity and the choice read it. */
export const fleetRunnerOf = (row: RunnerRow, options: FleetReadOptions): FleetRunner => {
  const presence = row.presence;
  const connected = presence !== null && presence.disconnectedAt === null && presence.lastSeenAt.getTime() > options.now - runnerLimits.offlineMs;
  const minor = runnerMinorOf(row);
  const state: FleetRunner["state"] =
    row.revokedAt !== null ? "revoked" : row.state === "online" && (!connected || minor < (options.minMinor ?? 0)) ? "offline" : row.state;
  const reported = minor >= FLEET_REPORT_MINOR ? runnerCapabilitiesSchema.safeParse(row.capabilities) : null;
  return {
    id: runnerIdSchema.parse(row.id),
    poolId: row.poolId === null ? null : poolIdSchema.parse(row.poolId),
    kind: row.kind,
    executor: row.executor,
    state,
    approved: !awaitsApproval({ kind: row.kind, approvedAt: row.approvedAt, poolRequiresApproval: row.pool?.requiresApproval ?? false }),
    slots: runnerSlotsOf(row, options.personalSlots ?? DEFAULT_PERSONAL_RUNNER_SLOTS),
    resources: row.cpuMillis === null || row.memoryMiB === null ? null : { cpuMillis: row.cpuMillis, memoryMiB: row.memoryMiB },
    labels: row.labels,
    capabilities: reported?.success === true ? reported.data : olderCapabilities(row.executor, minor),
    lastOfferedAt: row.lastOfferedAt?.getTime() ?? null,
  };
};

/** The live boxes on some runners, each with its whole footprint where sizes apply. */
export const liveBoxesInTx = async (tx: Tx, organizationId: OrganizationId, runnerIds: readonly RunnerId[]): Promise<readonly FleetBox[]> => {
  if (runnerIds.length === 0) {
    return [];
  }
  const rows = await tx.box.findMany({
    where: { organizationId, runnerId: { in: [...runnerIds] }, state: { in: slotHolding } },
    select: { runnerId: true, projectId: true, state: true, cpuMillis: true, memoryMiB: true },
  });
  const sized = [...new Set(rows.filter((row) => row.cpuMillis !== null).map((row) => row.projectId))];
  const services = sized.length === 0 ? [] : await tx.service.groupBy({ by: ["projectId"], where: { organizationId, projectId: { in: sized } }, _count: { _all: true } });
  const servicesOf = new Map(services.map((row) => [row.projectId, row._count._all]));
  return rows.map(
    (row): FleetBox => ({
      runnerId: row.runnerId === null ? null : runnerIdSchema.parse(row.runnerId),
      projectId: projectIdSchema.parse(row.projectId),
      state: row.state satisfies FleetBoxState,
      footprint:
        row.cpuMillis === null || row.memoryMiB === null
          ? null
          : boxFootprint({ cpuMillis: row.cpuMillis, memoryMiB: row.memoryMiB }, Array.from({ length: servicesOf.get(row.projectId) ?? 0 }, () => null)),
    }),
  );
};

/** The runners of some pools, or some runners by ID, with their live boxes. */
export const fleetInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  scope: { readonly poolIds: readonly PoolId[] } | { readonly runnerIds: readonly RunnerId[] },
  options: FleetReadOptions,
): Promise<{ readonly runners: readonly FleetRunner[]; readonly boxes: readonly FleetBox[] }> => {
  const rows = await tx.runner.findMany({
    where: { organizationId, ...("poolIds" in scope ? { kind: "pool" as const, poolId: { in: [...scope.poolIds] } } : { id: { in: [...scope.runnerIds] } }) },
    select: runnerSelect,
  });
  const runners = rows.map((row) => fleetRunnerOf(row, options));
  const boxes = await liveBoxesInTx(
    tx,
    organizationId,
    runners.map((runner) => runner.id),
  );
  return { runners, boxes };
};

/** The project's default size with its limits, as the organization sets them; `null` for none. */
export const projectSizeInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  projectId: ProjectId,
): Promise<{ readonly name: BoxSizeName; readonly limits: Resources } | null> => {
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { defaultBoxSize: true } });
  const name = boxSizeNameSchema.safeParse(project?.defaultBoxSize);
  if (!name.success) {
    return null;
  }
  const size = await tx.boxSize.findFirst({ where: { organizationId, name: name.data }, select: { cpuMillis: true, memoryMiB: true } });
  return size === null ? null : { name: name.data, limits: { cpuMillis: size.cpuMillis, memoryMiB: size.memoryMiB } };
};

/** The runner that holds the project's newest ready snapshot (milestone 3's rule), if one does. */
export const snapshotRunnerInTx = async (tx: Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<RunnerId | null> => {
  const snapshot = await tx.snapshot.findFirst({
    where: { organizationId, projectId, state: "ready", runnerId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { runnerId: true },
  });
  const runnerId = snapshot?.runnerId ?? null;
  return runnerId === null ? null : runnerIdSchema.parse(runnerId);
};
