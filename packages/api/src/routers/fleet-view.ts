import { processContainmentFromDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import {
  DEFAULT_PERSONAL_RUNNER_SLOTS,
  dispatchWaitFromDb,
  olderCapabilities,
  poolQueueInTx,
  runnerMinorOf,
  runnerSlotsOf,
  runnerVersionState,
  slotHoldingBoxStates,
} from "@ostra/domain";
import type { RunnerVersionState } from "@ostra/domain";
import { PROTOCOL_MINOR, poolIdSchema, runnerCapabilitiesSchema, runnerIdSchema } from "@ostra/protocol";
import type { ExecutorKind, OrganizationId, PoolId, RunnerCapabilities, RunnerId } from "@ostra/protocol";

import type { ApiDeps } from "../trpc/context.ts";

// F-092, F-067 (milestone 5's ticket 26): the fleet as the Runners page reads it. Every count is
// from ostra's own rows: a runner's busy boxes are its `Box` rows that hold a slot (`creating`,
// `preparing`, `ready`, `idle`), the same rows admission counts, never a stopped or released box.
// A capability's line is a code the panel words (F-083), never a sentence.

/**
 * The lines a runner's or a pool's capabilities call for: `not-isolated` (the agent runs on the
 * host, `isolation: none`), `direct-internet-access` (`kubernetes`: the agent shares the pod's
 * network, ADR 0060) and `same-user-development` (a `host` pool runner under
 * `OSTRA_DEV_HOST_POOL_SAME_USER`, development only).
 */
export type FleetLine = "not-isolated" | "direct-internet-access" | "same-user-development";

const lineOrder: readonly FleetLine[] = ["not-isolated", "direct-internet-access", "same-user-development"];

/** A large page of a pool's queue: the panel shows its length and every place. */
export const QUEUE_VIEW_MAX = 10_000;

/** The runner columns the fleet view reads. */
export const fleetRunnerSelect = {
  id: true,
  kind: true,
  name: true,
  poolId: true,
  ownerMemberId: true,
  executor: true,
  processContainment: true,
  capacity: true,
  slots: true,
  cpuMillis: true,
  memoryMiB: true,
  capabilities: true,
  labels: true,
  version: true,
  minor: true,
  install: true,
  os: true,
  state: true,
  approvedAt: true,
  revokedAt: true,
  drainedAt: true,
  lastSeenAt: true,
  createdAt: true,
  pool: { select: { id: true, name: true, requiresApproval: true } },
  presence: { select: { carrier: true, minor: true, connectedAt: true, disconnectedAt: true, lastSeenAt: true } },
} as const;

export type FleetRunnerRow = {
  readonly id: string;
  readonly kind: "pool" | "personal";
  readonly name: string;
  readonly poolId: string | null;
  readonly ownerMemberId: string | null;
  readonly executor: ExecutorKind;
  readonly processContainment: keyof typeof processContainmentFromDb | null;
  readonly capacity: number;
  readonly slots: number | null;
  readonly cpuMillis: number | null;
  readonly memoryMiB: number | null;
  readonly capabilities: unknown;
  readonly labels: readonly string[];
  readonly version: string;
  readonly minor: number | null;
  readonly install: "npm" | "image" | "source" | null;
  readonly state: "joining" | "online" | "offline" | "draining" | "revoked";
  readonly approvedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly drainedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly pool: { readonly id: string; readonly name: string; readonly requiresApproval: boolean } | null;
  readonly presence: {
    readonly carrier: string;
    readonly minor: number;
    readonly connectedAt: Date;
    readonly disconnectedAt: Date | null;
    readonly lastSeenAt: Date;
  } | null;
};

/** What a runner's executor can do: what it reported (minor 4), else read from its executor and minor. */
const capabilitiesOf = (row: FleetRunnerRow): RunnerCapabilities => {
  const reported = runnerCapabilitiesSchema.safeParse(row.capabilities);
  return reported.success ? reported.data : olderCapabilities(row.executor, runnerMinorOf(row));
};

/** The lines one runner's capabilities call for. */
export const runnerLines = (row: Pick<FleetRunnerRow, "kind" | "executor" | "capabilities" | "minor" | "presence">, sameUser: boolean): readonly FleetLine[] => {
  const lines: FleetLine[] = [];
  const capabilities = capabilitiesOf({ ...emptyRow, ...row });
  if (capabilities.isolation === "none") {
    lines.push("not-isolated");
  }
  if (row.executor === "kubernetes") {
    lines.push("direct-internet-access");
  }
  if (sameUser && row.kind === "pool" && row.executor === "host") {
    lines.push("same-user-development");
  }
  return lines;
};

const emptyRow: FleetRunnerRow = {
  id: "",
  kind: "pool",
  name: "",
  poolId: null,
  ownerMemberId: null,
  executor: "docker",
  processContainment: null,
  capacity: 0,
  slots: null,
  cpuMillis: null,
  memoryMiB: null,
  capabilities: null,
  labels: [],
  version: "",
  minor: null,
  install: null,
  state: "offline",
  approvedAt: null,
  revokedAt: null,
  drainedAt: null,
  lastSeenAt: null,
  createdAt: new Date(0),
  pool: null,
  presence: null,
};

/** Compares two releases by their numbers (`0.4.10` after `0.4.2`). */
const byRelease = (x: string, y: string): number => x.localeCompare(y, "en", { numeric: true });

/** The busy boxes on each runner: its `Box` rows that hold a slot. */
export const busyBoxesByRunner = async (db: Db, organizationId: OrganizationId, runnerIds: readonly string[]): Promise<ReadonlyMap<string, number>> => {
  if (runnerIds.length === 0) {
    return new Map();
  }
  const rows = await db.box.groupBy({
    by: ["runnerId"],
    where: { organizationId, runnerId: { in: [...runnerIds] }, state: { in: [...slotHoldingBoxStates] } },
    _count: { _all: true },
  });
  return new Map(rows.flatMap((row) => (row.runnerId === null ? [] : [[row.runnerId, row._count._all] as const])));
};

/** Whether a runner waits for an admin's approval. */
const awaitsApprovalOf = (row: FleetRunnerRow): boolean =>
  row.kind === "pool" && row.pool?.requiresApproval === true && row.state === "joining" && row.approvedAt === null && row.revokedAt === null;

/** A runner as the fleet view shows it. */
export const runnerViewOf = (row: FleetRunnerRow, busy: number, settings: { readonly sameUser: boolean; readonly personalSlots: number }) => {
  const minor = runnerMinorOf(row);
  const presence = row.presence?.disconnectedAt === null ? row.presence : null;
  const versionState: RunnerVersionState | null = row.minor === null && row.presence === null ? null : runnerVersionState({ minor: PROTOCOL_MINOR, version: null }, { minor, version: row.version });
  return {
    id: runnerIdSchema.parse(row.id),
    name: row.name,
    kind: row.kind,
    state: row.state,
    /** Whether it waits for an admin's approval (F-091). */
    awaitingApproval: awaitsApprovalOf(row),
    /** Its live connection now: the carrier it's on, or `null` when it isn't connected. */
    connection: presence === null ? null : { carrier: presence.carrier, minor: presence.minor, since: presence.connectedAt.getTime() },
    /** The carrier it last spoke on, connected or not; `null` before its first connection. */
    carrier: row.presence?.carrier ?? null,
    executor: row.executor,
    isolated: capabilitiesOf(row).isolation === "container",
    processContainment: row.processContainment === null ? null : processContainmentFromDb[row.processContainment],
    install: row.install,
    version: row.version,
    minor: row.minor === null && row.presence === null ? null : minor,
    /** Against this server (F-061): `current`, `behind`, `ahead` or `outside`; `null` before it spoke. */
    versionState,
    slots: runnerSlotsOf(row, settings.personalSlots),
    resources: row.cpuMillis === null || row.memoryMiB === null ? null : { cpuMillis: row.cpuMillis, memoryMiB: row.memoryMiB },
    labels: row.labels,
    busy,
    lines: runnerLines(row, settings.sameUser),
    drainedAt: row.drainedAt?.getTime() ?? null,
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
  };
};

export type RunnerView = ReturnType<typeof runnerViewOf>;

export type PoolFleet = {
  readonly runnerCount: number;
  readonly onlineCount: number;
  readonly awaitingApproval: number;
  /** Live boxes on its runners. */
  readonly busy: number;
  /** Slots of its runners that take work or finish it (`online`, `draining`). */
  readonly slots: number;
  readonly queueLength: number;
  readonly executors: readonly ExecutorKind[];
  readonly versions: readonly string[];
  readonly versionRange: { readonly min: string; readonly max: string } | null;
  readonly labels: readonly string[];
  readonly lines: readonly FleetLine[];
};

/** Each pool's runners counted: busy boxes against slots, its queue's length, versions, labels and lines. */
export const poolFleetOf = async (deps: ApiDeps, organizationId: OrganizationId, poolIds: readonly PoolId[]): Promise<ReadonlyMap<PoolId, PoolFleet>> => {
  const rows: readonly FleetRunnerRow[] = await deps.db.runner.findMany({
    where: { organizationId, kind: "pool", poolId: { in: [...poolIds] }, state: { not: "revoked" } },
    select: fleetRunnerSelect,
  });
  const busy = await busyBoxesByRunner(deps.db, organizationId, rows.map((row) => row.id));
  const sameUser = deps.settings.devHostPoolSameUser;
  const result = new Map<PoolId, PoolFleet>();
  for (const poolId of poolIds) {
    const runners = rows.filter((row) => row.poolId === poolId);
    const working = runners.filter((row) => row.state === "online" || row.state === "draining");
    const versions = [...new Set(runners.map((row) => row.version))].sort(byRelease);
    const first = versions[0];
    const last = versions.at(-1);
    const lines = new Set(runners.flatMap((row) => runnerLines(row, sameUser)));
    const queue = await poolQueueInTx(deps.db, organizationId, poolId, QUEUE_VIEW_MAX);
    result.set(poolId, {
      runnerCount: runners.length,
      onlineCount: runners.filter((row) => row.state === "online").length,
      awaitingApproval: runners.filter(awaitsApprovalOf).length,
      busy: runners.reduce((sum, row) => sum + (busy.get(row.id) ?? 0), 0),
      slots: working.reduce((sum, row) => sum + runnerSlotsOf(row, DEFAULT_PERSONAL_RUNNER_SLOTS), 0),
      queueLength: queue.length,
      executors: [...new Set(runners.map((row) => row.executor))].sort((x, y) => x.localeCompare(y)),
      versions,
      versionRange: first === undefined || last === undefined ? null : { min: first, max: last },
      labels: [...new Set(runners.flatMap((row) => row.labels))].sort((x, y) => x.localeCompare(y)),
      lines: lineOrder.filter((line) => lines.has(line)),
    });
  }
  return result;
};

/** The pool IDs of some rows, parsed. */
export const poolIdsOf = (rows: readonly { readonly id: string }[]): readonly PoolId[] => rows.map((row) => poolIdSchema.parse(row.id));

/** A runner's ID, parsed. */
export const runnerIdOf = (id: string): RunnerId => runnerIdSchema.parse(id);

/** Where a queued task waits: the pool, its name, its place and the queue's length. */
export type QueuePlace = { readonly poolId: PoolId; readonly poolName: string; readonly place: number; readonly length: number };

/**
 * Each queued task's place in its pool's queue (F-067), read now from the queue itself, so it's
 * never stale: the pool its wait names when it's in that queue, else the first of its project's
 * pools, in the project's order, that holds it. A task in no pool's queue (a personal runner's, an
 * open offer's, a task that isn't queued) has none.
 */
export const queuePlacesOf = async (
  db: Db,
  organizationId: OrganizationId,
  tasks: readonly { readonly id: string; readonly projectId: string; readonly state: string; readonly dispatchWait: unknown }[],
): Promise<ReadonlyMap<string, QueuePlace>> => {
  const queued = tasks.filter((task) => task.state === "queued");
  if (queued.length === 0) {
    return new Map();
  }
  const projectIds = [...new Set(queued.map((task) => task.projectId))];
  const [links, defaultPool] = await Promise.all([
    db.projectPool.findMany({ where: { organizationId, projectId: { in: projectIds } }, orderBy: [{ position: "asc" }, { poolId: "asc" }], select: { projectId: true, poolId: true } }),
    db.runnerPool.findFirst({ where: { organizationId, isDefault: true }, select: { id: true } }),
  ]);
  const poolsOf = (projectId: string): readonly string[] => {
    const own = links.filter((link) => link.projectId === projectId).map((link) => link.poolId);
    return own.length > 0 || defaultPool === null ? own : [defaultPool.id];
  };
  const poolIds = [...new Set(projectIds.flatMap(poolsOf))];
  const names = new Map((await db.runnerPool.findMany({ where: { organizationId, id: { in: poolIds } }, select: { id: true, name: true } })).map((pool) => [pool.id, pool.name] as const));
  const queues = new Map<string, readonly string[]>();
  for (const poolId of poolIds) {
    queues.set(poolId, (await poolQueueInTx(db, organizationId, poolIdSchema.parse(poolId), QUEUE_VIEW_MAX)).map((entry) => entry.taskId));
  }
  const places = new Map<string, QueuePlace>();
  for (const task of queued) {
    const wait = dispatchWaitFromDb(task.dispatchWait);
    const named = wait !== null && "poolId" in wait ? [wait.poolId] : [];
    for (const poolId of [...named, ...poolsOf(task.projectId)]) {
      const queue = queues.get(poolId) ?? [];
      const index = queue.indexOf(task.id);
      if (index >= 0) {
        places.set(task.id, { poolId: poolIdSchema.parse(poolId), poolName: names.get(poolId) ?? "", place: index + 1, length: queue.length });
        break;
      }
    }
  }
  return places;
};
