import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerBoxes, TASK_ROOT } from "./boxes.ts";
import type { BoxInput, DockerBoxes } from "./boxes.ts";
import { createEngine } from "./engine.ts";
import { startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeEngine } from "./testing/fake-engine.ts";

// F-017 and F-016 on the `docker` executor: a box per task, made of its own resources, against a
// fake Engine API (Docker is the external service here). The live test on a Linux machine with
// Docker is `docker.live.test.ts`.

const boxFor = (n: number): BoxInput => ({
  taskId: taskIdSchema.parse(`0196f1a0-task-${String(n)}`),
  sessionId: sessionIdSchema.parse(`0196f1a0-session-${String(n)}`),
  boxId: boxIdSchema.parse(`0196f1a0-box-${String(n)}`),
  leaseEpoch: leaseEpochSchema.parse(1),
  serverUrl: "http://ostra-server:8787",
  baseImage: null,
  tokenDir: `/var/lib/ostra-runner/boxes/0196f1a0-box-${String(n)}`,
});
const images = { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" };

let engine: FakeEngine;
let boxes: DockerBoxes;

beforeEach(async () => {
  engine = await startFakeEngine();
  boxes = createDockerBoxes(createEngine(engine.address), { images });
});

afterEach(async () => {
  await engine.close();
});

/** What the engine holds for a box: its containers, and the networks and volumes they use. */
const holdingsOf = (input: BoxInput) => {
  const containers = [...engine.containers.values()].filter((container) => container.name.startsWith(`ostra-box-${input.boxId}-`));
  const mounts = containers.flatMap((container) => {
    const hostConfig: unknown = container.body["HostConfig"];
    const list: unknown = Reflect.get(Object(hostConfig), "Mounts");
    return Array.isArray(list) ? list.map((mount: unknown) => String(Reflect.get(Object(mount), "Source"))) : [];
  });
  const labels = containers.map((container): unknown => Reflect.get(Object(container.body["Labels"]), "ostra.task"));
  return { containers, networks: containers.flatMap((container) => container.networks), mounts, labels };
};

describe("a box per task on docker", () => {
  it("F-016, F-017: each task's box is its agent's container and its sidecar on a private network of their own, and two boxes share none of it", async () => {
    const one = boxFor(1);
    const two = boxFor(2);
    expect((await boxes.createBox(one)).ok).toBe(true);
    expect((await boxes.createBox(two)).ok).toBe(true);

    for (const [box, other] of [
      [one, two],
      [two, one],
    ] as const) {
      const held = holdingsOf(box);
      expect(held.containers.map((container) => container.name).sort()).toEqual([`ostra-box-${box.boxId}-agent`, `ostra-box-${box.boxId}-sidecar`]);
      expect(held.labels).toEqual([box.taskId, box.taskId]);
      // The box's own network is internal: no route out but through the sidecar.
      expect(engine.networks.get(`ostra-box-${box.boxId}`)).toMatchObject({ Internal: true });
      const agent = held.containers.find((container) => container.name.endsWith("-agent"));
      expect(agent?.networks).toEqual([`ostra-box-${box.boxId}`]);
      // Nothing of the other box: its network, its volume, its task.
      const theirs = holdingsOf(other);
      expect(held.networks.filter((network) => network !== "ostra-egress").some((network) => theirs.networks.includes(network))).toBe(false);
      expect(held.mounts.some((mount) => theirs.mounts.includes(mount))).toBe(false);
      expect(held.mounts).toContain(`ostra-box-${box.boxId}-task`);
    }
  });

  it("F-016: each task's workspace is its own box's task volume, which the agent's container and the sidecar mount at the same path", async () => {
    const one = boxFor(1);
    expect((await boxes.createBox(one)).ok).toBe(true);
    for (const container of holdingsOf(one).containers) {
      const hostConfig: unknown = container.body["HostConfig"];
      const mounts: unknown = Reflect.get(Object(hostConfig), "Mounts");
      expect(mounts).toEqual(expect.arrayContaining([{ Type: "volume", Source: `ostra-box-${one.boxId}-task`, Target: TASK_ROOT }]));
      expect(container.body["WorkingDir"]).toBe(TASK_ROOT);
    }
  });

  it("F-017: a box serves one task: a box ID in use is refused, and the box that holds it keeps running, whole", async () => {
    const one = boxFor(1);
    expect((await boxes.createBox(one)).ok).toBe(true);
    const before = holdingsOf(one).containers.map((container) => container.id).sort();

    // Another task asking for the same box gets none, and takes nothing from the first.
    const again = await boxes.createBox({ ...one, taskId: taskIdSchema.parse("0196f1a0-task-other") });
    expect(again.ok).toBe(false);
    const after = holdingsOf(one);
    expect(after.containers.map((container) => container.id).sort()).toEqual(before);
    expect(after.labels).toEqual([one.taskId, one.taskId]);
    expect(after.containers.every((container) => container.status === "running")).toBe(true);
    expect(engine.networks.has(`ostra-box-${one.boxId}`)).toBe(true);
    expect(engine.volumes.has(`ostra-box-${one.boxId}-task`)).toBe(true);
    expect(await boxes.boxState(one.boxId)).toBe("ready");
  });

  it("F-017: a released box is gone whole, and the next task's box is made new, never the old one", async () => {
    const one = boxFor(1);
    expect((await boxes.createBox(one)).ok).toBe(true);
    const oldIds = holdingsOf(one).containers.map((container) => container.id);
    expect(await boxes.removeBox(one.boxId)).toEqual({ ok: true, value: undefined });
    expect(await boxes.boxState(one.boxId)).toBe("released");
    expect(engine.networks.has(`ostra-box-${one.boxId}`)).toBe(false);
    expect(engine.volumes.has(`ostra-box-${one.boxId}-task`)).toBe(false);

    const two = boxFor(2);
    expect((await boxes.createBox(two)).ok).toBe(true);
    const held = holdingsOf(two);
    expect(held.containers.some((container) => oldIds.includes(container.id))).toBe(false);
    expect(held.labels).toEqual([two.taskId, two.taskId]);
    expect(engine.containers.size).toBe(2);
  });
});
