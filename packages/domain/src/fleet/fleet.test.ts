import { randomUUID } from "node:crypto";

import { PROTOCOL_MINOR, poolIdSchema, projectIdSchema, runnerIdSchema, snapshotIdSchema, taskIdSchema } from "@ostra/protocol";
import type { PoolId, ProjectId, RunnerCapabilities, RunnerId } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { boxFootprint, couldEverFit, defaultFootprintLimits, fits, poolUse, projectUseOfPool, runnerRoom } from "./capacity.ts";
import type { FleetBox, FleetRunner, Resources } from "./capacity.ts";
import { chooseRunner } from "./choose.ts";
import type { ChooseInput, ChooseTask } from "./choose.ts";
import { builtInLabels, labelsMatch, missingLabels, runnerLabels } from "./labels.ts";
import { placeInQueue, poolQueue, queueOrder, queuePriorityFor } from "./queue.ts";
import type { QueuedTask } from "./queue.ts";
import { registryCheckFromDb, registryImageByDigest, registryImageRef } from "./registry.ts";
import { runnerVersionState } from "./versions.ts";

// Milestone 5's fleet (spec section 5.4, ADR 0059): the room arithmetic, the queue's order,
// labels, choosing a runner with every wait reason and a near miss for each, versions at the
// window's edges, and the registry's names. Pure: no database.

const runnerId = (): RunnerId => runnerIdSchema.parse(randomUUID());
const poolA: PoolId = poolIdSchema.parse(randomUUID());
const poolB: PoolId = poolIdSchema.parse(randomUUID());
const project: ProjectId = projectIdSchema.parse(randomUUID());
const otherProject: ProjectId = projectIdSchema.parse(randomUUID());

const dockerCapabilities: RunnerCapabilities = {
  isolation: "container",
  services: true,
  boxSizes: true,
  snapshots: "image",
  registry: "optional",
  nodeWait: false,
};
const kubernetesCapabilities: RunnerCapabilities = { ...dockerCapabilities, registry: "required", nodeWait: true };
const hostCapabilities: RunnerCapabilities = {
  isolation: "none",
  services: false,
  boxSizes: false,
  snapshots: "host-cache",
  registry: "none",
  nodeWait: false,
};

/** A `docker` pool runner in pool A, online and approved, with 4 slots, 16 vCPU and 32 GiB. */
const runner = (overrides: Partial<FleetRunner> = {}): FleetRunner => ({
  id: runnerId(),
  poolId: poolA,
  kind: "pool",
  executor: "docker",
  state: "online",
  approved: true,
  slots: 4,
  resources: { cpuMillis: 16_000, memoryMiB: 32_768 },
  labels: ["executor:docker", "os:linux", "arch:x64"],
  capabilities: dockerCapabilities,
  lastOfferedAt: null,
  ...overrides,
});

/** A live box of the project on a runner, with the medium size's footprint. */
const box = (on: FleetRunner, overrides: Partial<FleetBox> = {}): FleetBox => ({
  runnerId: on.id,
  projectId: project,
  state: "ready",
  footprint: boxFootprint({ cpuMillis: 4000, memoryMiB: 8192 }, []),
  ...overrides,
});

const medium = { name: "medium", footprint: boxFootprint({ cpuMillis: 4000, memoryMiB: 8192 }, []) } as const;

const task = (overrides: Partial<ChooseTask> = {}): ChooseTask => ({
  id: taskIdSchema.parse(randomUUID()),
  projectId: project,
  personalRunnerId: null,
  startedByMember: true,
  requiredLabels: [],
  needsServices: false,
  size: medium,
  ...overrides,
});

const input = (overrides: Partial<ChooseInput> & { readonly runners: readonly FleetRunner[] }): ChooseInput => ({
  task: task(),
  project: {
    id: project,
    pools: [
      { poolId: poolA, position: 0, maxBoxes: null },
      { poolId: poolB, position: 1, maxBoxes: null },
    ],
    snapshotRunnerId: null,
  },
  pools: [
    { id: poolA, maxBoxes: null },
    { id: poolB, maxBoxes: null },
  ],
  boxes: [],
  registrySet: false,
  ...overrides,
});

describe("the room arithmetic", () => {
  it("F-095: counts a box's size, its sidecar and each service, with a service's own limits or the default", () => {
    const size: Resources = { cpuMillis: 2000, memoryMiB: 4096 };
    expect(boxFootprint(size, [])).toEqual({ cpuMillis: 3000, memoryMiB: 4352 });
    // One service with its own limits, one with the default 1 vCPU and 1 GiB.
    expect(boxFootprint(size, [{ cpuMillis: 500, memoryMiB: 512 }, null])).toEqual({
      cpuMillis: 2000 + defaultFootprintLimits.sidecar.cpuMillis + 500 + 1000,
      memoryMiB: 4096 + defaultFootprintLimits.sidecar.memoryMiB + 512 + 1024,
    });
  });

  it("F-067: a runner's room is its offer less its live boxes; stopped, released and failed boxes hold nothing", () => {
    const r = runner({ slots: 3, resources: { cpuMillis: 10_000, memoryMiB: 20_000 } });
    const footprint = { cpuMillis: 3000, memoryMiB: 5000 };
    const boxes: FleetBox[] = [
      box(r, { state: "creating", footprint }),
      box(r, { state: "idle", footprint }),
      box(r, { state: "stopped", footprint }),
      box(r, { state: "released", footprint }),
      box(r, { state: "failed", footprint }),
      // Another runner's box doesn't count here.
      box(runner(), { footprint }),
    ];
    expect(runnerRoom(r, boxes)).toEqual({ slots: 1, resources: { cpuMillis: 4000, memoryMiB: 10_000 } });
    // `host` counts slots only.
    const host = runner({ executor: "host", resources: null, slots: 2, capabilities: hostCapabilities });
    expect(runnerRoom(host, [box(host, { footprint: null })])).toEqual({ slots: 1, resources: null });
  });

  it("F-095: a box fits only with a free slot and, where sizes apply, its whole footprint; one MiB more doesn't", () => {
    const need = { cpuMillis: 4000, memoryMiB: 8192 };
    expect(fits({ slots: 1, resources: need }, need)).toBe(true);
    expect(fits({ slots: 1, resources: need }, { ...need, memoryMiB: need.memoryMiB + 1 })).toBe(false);
    expect(fits({ slots: 1, resources: need }, { ...need, cpuMillis: need.cpuMillis + 1 })).toBe(false);
    expect(fits({ slots: 0, resources: need }, need)).toBe(false);
    // Slots only, on either side.
    expect(fits({ slots: 1, resources: null }, need)).toBe(true);
    expect(fits({ slots: 1, resources: need }, null)).toBe(true);
  });

  it("F-067: a pool's capacity and use, and a project's use of a pool, count only live boxes on the pool's runners", () => {
    const one = runner();
    const two = runner({ state: "offline" });
    const elsewhere = runner({ poolId: poolB });
    const boxes = [box(one), box(one, { projectId: otherProject }), box(two), box(one, { state: "stopped" }), box(elsewhere)];
    expect(poolUse({ id: poolA, maxBoxes: 3 }, [one, two, elsewhere], boxes)).toEqual({ slots: 4, boxes: 3, freeSlots: 2, maxBoxes: 3, full: true });
    expect(poolUse({ id: poolA, maxBoxes: 4 }, [one, two, elsewhere], boxes).full).toBe(false);
    expect(projectUseOfPool(project, poolA, [one, two, elsewhere], boxes)).toBe(2);
    expect(projectUseOfPool(otherProject, poolA, [one, two, elsewhere], boxes)).toBe(1);
  });
});

describe("the queue", () => {
  const at = (minute: number): number => Date.UTC(2026, 10, 20, 10, minute);
  const queued = (id: string, queuePriority: number, minute: number, projectId: ProjectId = project): QueuedTask => ({
    id: taskIdSchema.parse(id),
    projectId,
    queuePriority,
    queuedAt: at(minute),
  });

  it("F-067: orders by priority, then the time queued, then the ID", () => {
    const tasks = [
      queued("0196f1a0-0000-7000-8000-00000000000c", 4, 0),
      queued("0196f1a0-0000-7000-8000-00000000000b", 3, 2),
      queued("0196f1a0-0000-7000-8000-00000000000a", 3, 2),
      queued("0196f1a0-0000-7000-8000-000000000009", 3, 1),
      queued("0196f1a0-0000-7000-8000-000000000008", 1, 5),
      queued("0196f1a0-0000-7000-8000-000000000007", 2, 9),
    ];
    expect([...tasks].sort(queueOrder).map((item) => item.id.slice(-2))).toEqual(["08", "07", "09", "0a", "0b", "0c"]);
  });

  it("F-067: ranks a ticket by its priority and a prompt or a ticket without one as Medium", () => {
    expect([1, 2, 3, 4].map(queuePriorityFor)).toEqual([1, 2, 3, 4]);
    expect([0, null, undefined, 5, -1].map(queuePriorityFor)).toEqual([3, 3, 3, 3, 3]);
  });

  it("F-067: a pool's queue holds the tasks whose project may use it, in order, and says each one's place", () => {
    const first = queued("0196f1a0-0000-7000-8000-000000000001", 3, 0);
    const urgentElsewhere = queued("0196f1a0-0000-7000-8000-000000000002", 1, 1, otherProject);
    const urgent = queued("0196f1a0-0000-7000-8000-000000000003", 1, 2);
    const queue = poolQueue(poolA, [first, urgentElsewhere, urgent], [
      { projectId: project, poolId: poolA },
      { projectId: otherProject, poolId: poolB },
    ]);
    expect(queue.map((item) => item.id)).toEqual([urgent.id, first.id]);
    expect(placeInQueue(queue, first.id)).toBe(2);
    expect(placeInQueue(queue, urgentElsewhere.id)).toBeNull();
  });
});

describe("labels", () => {
  it("F-069: a runner fits when it carries every label, compared exactly", () => {
    expect(labelsMatch(["gpu", "tier:fast"], ["gpu", "tier:fast", "os:linux"])).toBe(true);
    expect(labelsMatch([], [])).toBe(true);
    // One label short, or a near spelling: no.
    expect(labelsMatch(["gpu", "tier:fast"], ["gpu"])).toBe(false);
    expect(labelsMatch(["gpu"], ["GPU", "gpus"])).toBe(false);
    expect(missingLabels(["gpu", "tier:fast"], ["gpu"])).toEqual(["tier:fast"]);
  });

  it("F-069: core adds the built-in labels and drops a reserved one the runner set itself", () => {
    expect(builtInLabels({ executor: "kubernetes", os: "linux", arch: "arm64" })).toEqual(["executor:kubernetes", "os:linux", "arch:arm64"]);
    expect(runnerLabels(["gpu", "executor:host", "os:windows", "tier:fast"], { executor: "docker", os: "linux", arch: null })).toEqual({
      labels: ["executor:docker", "gpu", "os:linux", "tier:fast"],
      dropped: ["executor:host", "os:windows"],
    });
  });
});

describe("choosing a runner", () => {
  /** Each wait reason, from the rows that cause it, and the near miss one step away that runs. */
  const cases: readonly {
    readonly name: string;
    readonly waits: () => ChooseInput;
    readonly reason: unknown;
    readonly nearMiss: () => ChooseInput;
  }[] = [
    {
      name: "one label short",
      waits: () => input({ task: task({ requiredLabels: ["gpu", "tier:fast"] }), runners: [runner({ labels: ["gpu"] })] }),
      reason: { code: "no-runner-with-labels", labels: ["gpu", "tier:fast"] },
      nearMiss: () => input({ task: task({ requiredLabels: ["gpu", "tier:fast"] }), runners: [runner({ labels: ["gpu", "tier:fast"] })] }),
    },
    {
      name: "one slot short",
      waits: () => {
        const full = runner({ slots: 1 });
        return input({ runners: [full], boxes: [box(full, { projectId: otherProject })], places: new Map([[poolA, 3]]) });
      },
      reason: { code: "queued", poolId: poolA, place: 3 },
      nearMiss: () => {
        const roomy = runner({ slots: 2 });
        return input({ runners: [roomy], boxes: [box(roomy, { projectId: otherProject })] });
      },
    },
    {
      name: "a size one MiB too large",
      waits: () => input({ runners: [runner({ resources: { cpuMillis: medium.footprint.cpuMillis, memoryMiB: medium.footprint.memoryMiB - 1 } })] }),
      reason: { code: "size-too-large", size: "medium" },
      nearMiss: () => input({ runners: [runner({ resources: medium.footprint })] }),
    },
    {
      name: "a share at its cap",
      waits: () => {
        const r = runner();
        return input({ runners: [r], boxes: [box(r), box(r)], project: { id: project, pools: [{ poolId: poolA, position: 0, maxBoxes: 2 }], snapshotRunnerId: null } });
      },
      reason: { code: "project-share-reached", poolId: poolA, cap: 2 },
      nearMiss: () => {
        const r = runner();
        return input({ runners: [r], boxes: [box(r)], project: { id: project, pools: [{ poolId: poolA, position: 0, maxBoxes: 2 }], snapshotRunnerId: null } });
      },
    },
    {
      name: "a pool at its cap",
      waits: () => {
        const r = runner();
        return input({ runners: [r], boxes: [box(r, { projectId: otherProject })], pools: [{ id: poolA, maxBoxes: 1 }] });
      },
      reason: { code: "pool-full", poolId: poolA },
      nearMiss: () => {
        const r = runner();
        return input({ runners: [r], boxes: [box(r, { projectId: otherProject })], pools: [{ id: poolA, maxBoxes: 2 }] });
      },
    },
    {
      name: "a pool needing a registry",
      waits: () => input({ runners: [runner({ executor: "kubernetes", capabilities: kubernetesCapabilities })], registrySet: false }),
      reason: { code: "needs-registry", poolId: poolA },
      nearMiss: () => input({ runners: [runner({ executor: "kubernetes", capabilities: kubernetesCapabilities })], registrySet: true }),
    },
    {
      name: "a task with services and only host online",
      waits: () => input({ task: task({ needsServices: true, size: null }), runners: [runner({ executor: "host", resources: null, capabilities: hostCapabilities })] }),
      reason: { code: "needs-services" },
      nearMiss: () => input({ task: task({ needsServices: true, size: null }), runners: [runner()] }),
    },
    {
      name: "no runner online",
      waits: () => input({ runners: [runner({ state: "offline" }), runner({ state: "draining" })] }),
      reason: { code: "no-runner-online" },
      nearMiss: () => input({ runners: [runner({ state: "offline" }), runner()] }),
    },
  ];

  it.each(cases.map((item) => [item.name, item] as const))("F-069: %s waits with its reason, and its near miss runs", (_name, item) => {
    expect(chooseRunner(item.waits())).toEqual({ kind: "waits", reason: item.reason });
    expect(chooseRunner(item.nearMiss())).toMatchObject({ kind: "runner", poolId: poolA });
  });

  it("F-069: a pool with no runner, a runner still joining or one revoked is no runner online", () => {
    expect(chooseRunner(input({ runners: [] }))).toEqual({ kind: "waits", reason: { code: "no-runner-online" } });
    expect(chooseRunner(input({ runners: [runner({ state: "joining", approved: false }), runner({ state: "revoked" })] }))).toEqual({
      kind: "waits",
      reason: { code: "no-runner-online" },
    });
  });

  it("F-069: takes the project's pools in its order, and the next pool when the first has no room", () => {
    const inA = runner();
    const inB = runner({ poolId: poolB });
    expect(chooseRunner(input({ runners: [inA, inB] }))).toEqual({ kind: "runner", runnerId: inA.id, poolId: poolA });
    // The project's order, not the pools' list order.
    const reversed = input({
      runners: [inA, inB],
      project: {
        id: project,
        pools: [
          { poolId: poolA, position: 1, maxBoxes: null },
          { poolId: poolB, position: 0, maxBoxes: null },
        ],
        snapshotRunnerId: null,
      },
    });
    expect(chooseRunner(reversed)).toEqual({ kind: "runner", runnerId: inB.id, poolId: poolB });
    const fullA = runner({ slots: 1 });
    expect(chooseRunner(input({ runners: [fullA, inB], boxes: [box(fullA, { projectId: otherProject })] }))).toEqual({
      kind: "runner",
      runnerId: inB.id,
      poolId: poolB,
    });
    // A pool the project may not use is never chosen.
    const elsewhere = runner({ poolId: poolIdSchema.parse(randomUUID()) });
    expect(chooseRunner(input({ runners: [elsewhere] }))).toEqual({ kind: "waits", reason: { code: "no-runner-online" } });
  });

  it("F-069: says the nearest miss across the pools", () => {
    // Pool A's runner lacks the label; pool B's has it and is busy: the task waits its turn in B.
    const busy = runner({ poolId: poolB, slots: 1, labels: ["gpu"] });
    const result = chooseRunner(
      input({
        task: task({ requiredLabels: ["gpu"] }),
        runners: [runner(), busy],
        boxes: [box(busy, { projectId: otherProject })],
        places: new Map([[poolB, 2]]),
      }),
    );
    expect(result).toEqual({ kind: "waits", reason: { code: "queued", poolId: poolB, place: 2 } });
  });

  it("F-069: a member's own personal runner only for a task they started and picked it for", () => {
    const personal = runner({ kind: "personal", poolId: null, executor: "host", resources: null, slots: 2, capabilities: hostCapabilities });
    const pooled = runner();
    const picked = task({ personalRunnerId: personal.id, startedByMember: true, size: null });
    expect(chooseRunner(input({ task: picked, runners: [personal, pooled] }))).toEqual({ kind: "runner", runnerId: personal.id, poolId: null });
    // Picked and busy (two at once by default): it waits for that runner, never a pool.
    expect(chooseRunner(input({ task: picked, runners: [personal, pooled], boxes: [box(personal), box(personal)] }))).toEqual({
      kind: "waits",
      reason: { code: "personal-runner-unavailable" },
    });
    expect(chooseRunner(input({ task: picked, runners: [{ ...personal, state: "offline" }, pooled] }))).toEqual({
      kind: "waits",
      reason: { code: "personal-runner-unavailable" },
    });
    // A task no member started goes to pools only, even with a personal runner named.
    const noMember = task({ personalRunnerId: personal.id, startedByMember: false, size: null });
    expect(chooseRunner(input({ task: noMember, runners: [personal, pooled] }))).toEqual({ kind: "runner", runnerId: pooled.id, poolId: poolA });
    expect(chooseRunner(input({ task: noMember, runners: [personal] }))).toEqual({ kind: "waits", reason: { code: "no-runner-online" } });
    // A personal runner is never a pool's runner.
    expect(chooseRunner(input({ task: task({ size: null }), runners: [{ ...personal, poolId: poolA }] }))).toEqual({
      kind: "waits",
      reason: { code: "no-runner-online" },
    });
  });

  it("F-069: services never go to host, on a pool or a personal runner", () => {
    const host = runner({ executor: "host", resources: null, capabilities: hostCapabilities });
    const docker = runner({ poolId: poolB });
    const services = task({ needsServices: true, size: null });
    expect(chooseRunner(input({ task: services, runners: [host, docker] }))).toEqual({ kind: "runner", runnerId: docker.id, poolId: poolB });
    // A minor-3 host runner that declares nothing is still `host`.
    expect(chooseRunner(input({ task: services, runners: [{ ...host, capabilities: null }] }))).toEqual({ kind: "waits", reason: { code: "needs-services" } });
    const personal = runner({ kind: "personal", poolId: null, executor: "host", resources: null, capabilities: hostCapabilities });
    expect(chooseRunner(input({ task: { ...services, personalRunnerId: personal.id }, runners: [personal, docker] }))).toEqual({
      kind: "waits",
      reason: { code: "needs-services" },
    });
  });

  it("F-069: picks the most free room, then the runner with the project's snapshot, then the least recently offered", () => {
    const roomy = runner({ slots: 4 });
    const tight = runner({ slots: 4 });
    expect(chooseRunner(input({ runners: [tight, roomy], boxes: [box(tight)] }))).toMatchObject({ runnerId: roomy.id });
    // Equal room: the snapshot's runner.
    const plain = runner();
    const holder = runner();
    expect(
      chooseRunner(input({ runners: [plain, holder], project: { id: project, pools: [{ poolId: poolA, position: 0, maxBoxes: null }], snapshotRunnerId: holder.id } })),
    ).toMatchObject({ runnerId: holder.id });
    // Equal room, no snapshot: the one offered least recently; never offered comes first.
    const recent = runner({ lastOfferedAt: 2000 });
    const earlier = runner({ lastOfferedAt: 1000 });
    const never = runner({ lastOfferedAt: null });
    expect(chooseRunner(input({ runners: [recent, earlier] }))).toMatchObject({ runnerId: earlier.id });
    expect(chooseRunner(input({ runners: [recent, earlier, never] }))).toMatchObject({ runnerId: never.id });
  });

  it("F-095: a minor-3 runner without resources counts slots only, and the size can't be too large for it", () => {
    const old = runner({ resources: null, capabilities: null });
    expect(couldEverFit(old, medium.footprint)).toBe(true);
    expect(chooseRunner(input({ runners: [old] }))).toMatchObject({ kind: "runner", runnerId: old.id });
  });
});

describe("versions", () => {
  const server = { minor: PROTOCOL_MINOR, version: "0.5.0" };

  it("F-061: says current, behind, ahead and outside at the window's edges", () => {
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR, version: "0.5.0" })).toBe("current");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR - 1, version: "0.4.2" })).toBe("behind");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR + 1, version: "0.6.0" })).toBe("ahead");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR - 2, version: "0.3.0" })).toBe("outside");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR + 2, version: "0.7.0" })).toBe("outside");
    // The same minor, another release.
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR, version: "0.4.9" })).toBe("behind");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR, version: "0.5.1" })).toBe("ahead");
    expect(runnerVersionState(server, { minor: PROTOCOL_MINOR, version: null })).toBe("current");
    // A server at minor 0 has no minor below it.
    expect(runnerVersionState({ minor: 0, version: "0.1.0" }, { minor: 1, version: "0.2.0" })).toBe("ahead");
  });
});

describe("the registry's names", () => {
  it("F-120: names a snapshot's image under the prefix, and pulls it by digest", () => {
    const registry = { url: "https://registry.ostra-test.dev/", repositoryPrefix: "/ostra-dev/" };
    const projectId = projectIdSchema.parse("0196f1a0-0000-7000-8000-000000000001");
    const snapshotId = snapshotIdSchema.parse("0196f1a0-0000-7000-8000-000000000002");
    expect(registryImageRef(registry, projectId, snapshotId)).toBe(`registry.ostra-test.dev/ostra-dev/${projectId}:${snapshotId}`);
    const digest = `sha256:${"a".repeat(64)}`;
    expect(registryImageByDigest(registry, projectId, digest)).toBe(`registry.ostra-test.dev/ostra-dev/${projectId}@${digest}`);
    expect(() => registryImageByDigest(registry, projectId, "latest")).toThrow();
    expect(registryCheckFromDb({ result: "pull-only", status: 403, detail: "push refused for ostra-dev/" })).toEqual({
      result: "pull-only",
      status: 403,
      detail: "push refused for ostra-dev/",
    });
    expect(registryCheckFromDb({ result: "maybe" })).toBeNull();
  });
});
