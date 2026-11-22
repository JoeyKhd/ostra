import { BOX_START_WITHIN_MS, defaultAdapterContext } from "@ostra/adapter-sdk";
import type { BoxRef, BoxWaitChange, TaskProxies } from "@ostra/adapter-sdk";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import type { ContainerView } from "./kube-api.ts";
import { KubernetesExecutor } from "./kubernetes-executor.ts";
import type { KubernetesExecutorOptions } from "./kubernetes-executor.ts";
import { boxNames } from "./pod.ts";
import { containerStatus, crashLooping, memoryKubeApi, steppedClock } from "./testing/memory-kube-api.ts";
import type { MemoryKube } from "./testing/memory-kube-api.ts";

// Ticket 08: waiting for a node and for an image's pull (F-093), on the `KubeApi` port's in-memory
// double with a clock the test moves, so a 15-minute wait takes no time. The scheduler's condition
// and the autoscaler's `TriggeredScaleUp` against ticket 06's fake API are in
// `kubernetes-executor.test.ts` and the contract suite.

const proxies: TaskProxies = { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
const box: BoxRef = { taskId: taskIdSchema.parse("task-wait"), boxId: boxIdSchema.parse("box-wait") };
const POD = boxNames(box).pod;
const MINUTE = 60_000;

const unschedulable = { status: "False", reason: "Unschedulable" } as const;
const scheduled = { status: "True", reason: null } as const;
const sidecarReady = { phase: "Running", ready: true, initContainers: [containerStatus("sidecar", "running")], containers: [containerStatus("agent", "running")] } as const;

/** A box made on the double, with the script that moves its pod along the clock. */
const boxOn = async (
  script: (kube: MemoryKube, now: number) => void,
  options: Partial<KubernetesExecutorOptions> = {},
): Promise<{
  readonly kube: MemoryKube;
  readonly executor: KubernetesExecutor;
  readonly heard: BoxWaitChange[];
  readonly prepared: Awaited<ReturnType<KubernetesExecutor["prepare"]>>;
  /** The clock's time when `prepare` answered. */
  readonly at: number;
}> => {
  const kube = memoryKubeApi();
  const clock = steppedClock((now) => {
    script(kube, now);
  });
  const executor = new KubernetesExecutor(
    { kube, namespace: "ostra-boxes", images: { runner: "r", base: "b" }, serverUrl: "https://ostra.example", pollMs: 1000, clock, ...options },
    defaultAdapterContext,
  );
  const heard: BoxWaitChange[] = [];
  const created = await executor.create({ ...box, spec: taskSpecFixture, proxies, onWaiting: (change) => heard.push(change) });
  if (!created.ok) throw new Error(created.error.message);
  script(kube, 0);
  const prepared = await executor.prepare({ box, spec: taskSpecFixture, secrets: [], onSetupOutput: () => undefined });
  return { kube, executor, heard, prepared, at: clock.now() };
};

const kinds = (heard: readonly BoxWaitChange[]): string[] => heard.map((change) => (change.kind === "waiting" ? `waiting:${change.reason}` : `scheduled:${String(change.afterMs)}`));

describe("waiting for a node and an image (ticket 08)", () => {
  it("F-093/c3: an unschedulable pod with a scale-up under way waits for its node, says so, and says when it's scheduled with how long it took", async () => {
    const { heard, prepared, executor } = await boxOn((kube, now) => {
      if (now === 0) {
        kube.setPod(POD, { scheduled: unschedulable });
        kube.addEvent(POD, "FailedScheduling");
        kube.addEvent(POD, "TriggeredScaleUp");
      }
      if (now === 4 * MINUTE) kube.setPod(POD, { scheduled, ...sidecarReady });
    });
    expect(prepared.ok).toBe(true);
    expect(kinds(heard)).toEqual(["waiting:node", `scheduled:${String(4 * MINUTE)}`]);
    expect(executor.failureOf(box)).toBeNull();
  });

  it("F-093/c3: past OSTRA_K8S_NODE_WAIT_MINUTES with no node the box fails as no-node, for core to queue again, and its pod is deleted", async () => {
    const { heard, prepared, executor, kube } = await boxOn((pods, now) => {
      if (now === 0) {
        pods.setPod(POD, { scheduled: unschedulable });
        pods.addEvent(POD, "TriggeredScaleUp");
      }
    });
    expect(prepared).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(prepared.ok ? "" : prepared.error.message).toContain("No node joined within 15 minutes");
    expect(kinds(heard)).toEqual(["waiting:node"]);
    expect(executor.failureOf(box)).toBe("no-node");
    expect(await executor.state(box)).toEqual({ ok: true, value: "failed" });
    expect(kube.deleted).toEqual([POD]);
  });

  it("F-093/c3: the node wait is OSTRA_K8S_NODE_WAIT_MINUTES: a node at 4 minutes is too late for a 3-minute wait", async () => {
    const { prepared, executor } = await boxOn(
      (kube, now) => {
        if (now === 0) {
          kube.setPod(POD, { scheduled: unschedulable });
          kube.addEvent(POD, "TriggeredScaleUp");
        }
        if (now === 4 * MINUTE) kube.setPod(POD, { scheduled, ...sidecarReady });
      },
      { nodeWaitMinutes: 3 },
    );
    expect(prepared.ok).toBe(false);
    expect(executor.failureOf(box)).toBe("no-node");
  });

  it("F-093/c3: unschedulable with no scale-up fails at once as no-room, after the autoscaler's grace, not after the node wait", async () => {
    const { heard, prepared, executor } = await boxOn((kube, now) => {
      if (now === 0) {
        kube.setPod(POD, { scheduled: unschedulable });
        kube.addEvent(POD, "FailedScheduling");
      }
    });
    expect(prepared.ok ? "" : prepared.error.message).toContain("no room");
    expect(executor.failureOf(box)).toBe("no-room");
    expect(heard).toEqual([]);
  });

  it("F-093/c3: a pull still under way past 10 s says the box waits for its image, then that it's ready; a quick pull says nothing", async () => {
    const slow = await boxOn((kube, now) => {
      if (now === 0) {
        kube.setPod(POD, { scheduled, initContainers: [containerStatus("sidecar", "waiting", "PodInitializing")] });
        kube.addEvent(POD, "Scheduled");
        kube.addEvent(POD, "Pulling");
      }
      if (now === 90_000) {
        kube.addEvent(POD, "Pulled");
        kube.setPod(POD, sidecarReady);
      }
    });
    expect(slow.prepared.ok).toBe(true);
    expect(kinds(slow.heard)).toEqual(["waiting:image-pull", "scheduled:90000"]);

    const quick = await boxOn((kube, now) => {
      if (now === 0) {
        kube.setPod(POD, { scheduled, initContainers: [containerStatus("sidecar", "waiting", "PodInitializing")] });
        kube.addEvent(POD, "Pulling");
      }
      if (now === 5000) {
        kube.addEvent(POD, "Pulled");
        kube.setPod(POD, sidecarReady);
      }
    });
    expect(quick.prepared.ok).toBe(true);
    expect(quick.heard).toEqual([]);
  });

  it("F-094/c4: a service still not ready when the services' wait ends is reported failed; one that got ready is healthy", async () => {
    const services = [
      { name: "postgres", image: "postgres:18.6-bookworm", port: 5432, variables: [], healthCheck: "pg_isready" },
      { name: "redis", image: "redis:8.2", port: 6379, variables: [], healthCheck: null },
    ];
    const kube = memoryKubeApi();
    const clock = steppedClock((now) => {
      if (now === 3000) kube.setPod(POD, { initContainers: [containerStatus("sidecar", "running"), containerStatus("svc-postgres", "running"), containerStatus("svc-redis", "running", null, false)] });
    });
    const executor = new KubernetesExecutor({ kube, namespace: "ostra-boxes", images: { runner: "r", base: "b" }, serverUrl: "https://ostra.example", pollMs: 1000, clock }, defaultAdapterContext);
    const spec = { ...taskSpecFixture, services };
    const created = await executor.create({ ...box, spec, proxies });
    expect(created.ok).toBe(true);
    expect(kube.made[0]?.spec?.initContainers?.map((container) => container.name)).toEqual(["sidecar", "svc-postgres", "svc-redis"]);
    kube.setPod(POD, { scheduled, ...sidecarReady, initContainers: [containerStatus("sidecar", "running"), containerStatus("svc-postgres", "waiting", "PodInitializing"), containerStatus("svc-redis", "waiting", "PodInitializing")] });
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared.ok && prepared.value.services).toEqual([
      { name: "postgres", outcome: "healthy", afterMs: 3000 },
      { name: "redis", outcome: "failed", reason: "The service wasn't healthy within 120 s." },
    ]);
  });

  it("F-093, F-120: an image that can't be pulled fails the box as image-pull", async () => {
    const { prepared, executor } = await boxOn((kube, now) => {
      if (now === 0) kube.setPod(POD, { scheduled, containers: [containerStatus("agent", "waiting", "ImagePullBackOff")] });
    });
    expect(prepared.ok).toBe(false);
    expect(executor.failureOf(box)).toBe("image-pull");
  });
});

// A sidecar that never gets ready (amended 2026-11-22, ADR 0029's parity): `prepare` waited for its
// readiness for ever. Now it fails as a `docker` box that doesn't start does: at once when the
// sidecar ends first (a `docker` sidecar's exit is seen at once), and at `BOX_START_WITHIN_MS` after
// its start when it runs and isn't ready (a `docker` sidecar gives the box's init that long).
describe("a box whose sidecar doesn't start (F-047)", () => {
  const ended = (exitCode: number): ContainerView => ({ ...containerStatus("sidecar", "terminated", "Error"), exitCode });
  const agentRuns = { phase: "Running", containers: [containerStatus("agent", "running")] } as const;

  it("F-047/c1: a sidecar that ends before it's ready fails the box at once, with its exit code, and its pod is deleted", async () => {
    const { prepared, executor, kube, at } = await boxOn((pods, now) => {
      if (now === 0) pods.setPod(POD, { scheduled, ...agentRuns, initContainers: [ended(1)] });
    });
    expect(prepared).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(prepared.ok ? "" : prepared.error.message).toContain("The box's sidecar ended before it was ready (exit 1)");
    expect(at).toBe(0);
    expect(executor.failureOf(box)).toBe("sidecar-ended");
    expect(executor.sidecarExitCodeOf(box)).toBe(1);
    expect(await executor.state(box)).toEqual({ ok: true, value: "failed" });
    expect(kube.deleted).toEqual([POD]);
  });

  it("F-047/c1: a crash-looping sidecar fails the box at once with its last exit code, backing off or started again", async () => {
    const backingOff = await boxOn((pods, now) => {
      if (now === 0) pods.setPod(POD, { scheduled, ...agentRuns, initContainers: [crashLooping("sidecar", 2)] });
    });
    expect(backingOff.prepared.ok).toBe(false);
    expect(backingOff.at).toBe(0);
    expect(backingOff.executor.failureOf(box)).toBe("sidecar-ended");
    expect(backingOff.executor.sidecarExitCodeOf(box)).toBe(2);
    expect(backingOff.kube.deleted).toEqual([POD]);
    // Caught between two runs: running again, not ready, after an exit.
    const again = await boxOn((pods, now) => {
      if (now === 0) pods.setPod(POD, { scheduled, ...agentRuns, initContainers: [{ ...containerStatus("sidecar", "running", null, false), restarts: 1, lastExitCode: 137 }] });
    });
    expect(again.prepared.ok).toBe(false);
    expect(again.executor.failureOf(box)).toBe("sidecar-ended");
    expect(again.executor.sidecarExitCodeOf(box)).toBe(137);
  });

  it("F-047/c1: a sidecar that runs and is never ready fails the box at BOX_START_WITHIN_MS after its start, its image's pull not counted", async () => {
    const neverReady = containerStatus("sidecar", "running", null, false);
    const { prepared, executor, kube, at } = await boxOn((pods, now) => {
      if (now === 0) pods.setPod(POD, { scheduled, initContainers: [containerStatus("sidecar", "waiting", "ContainerCreating")] });
      // Its image took five minutes; then it runs, and its readiness never passes.
      if (now === 5 * MINUTE) pods.setPod(POD, { ...agentRuns, initContainers: [neverReady] });
    });
    expect(BOX_START_WITHIN_MS).toBe(2 * MINUTE);
    expect(prepared.ok ? "" : prepared.error.message).toContain("The box's sidecar wasn't ready within 120 s of its start.");
    expect(at).toBe(5 * MINUTE + BOX_START_WITHIN_MS);
    expect(executor.failureOf(box)).toBe("not-ready");
    expect(executor.sidecarExitCodeOf(box)).toBeNull();
    expect(kube.deleted).toEqual([POD]);
    // Ready a second before the time is up, it runs.
    const late = await boxOn((pods, now) => {
      if (now === 0) pods.setPod(POD, { scheduled, ...agentRuns, initContainers: [neverReady] });
      if (now === BOX_START_WITHIN_MS - 1000) pods.setPod(POD, sidecarReady);
    });
    expect(late.prepared.ok).toBe(true);
  });
});
