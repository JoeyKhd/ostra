import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BoxImage } from "@ostra/adapter-sdk";
import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerBoxes, DEFAULT_FIXED_LIMITS, dockerCapacity } from "./boxes.ts";
import type { BoxInput, DockerBoxes } from "./boxes.ts";
import type { Bridge } from "./bridge/bridge-server.ts";
import { DockerExecutor } from "./docker-executor.ts";
import { createEngine } from "./engine.ts";
import { startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeEngine } from "./testing/fake-engine.ts";

// Milestone 5's ticket 09 against the fake Engine API: a box's size as its containers' limits, read
// back from the Engine's inspect; the runner's offer from the Engine's `info`; a registry image
// pulled by digest with its credential in the Engine call's header only; and the task token in a
// folder only the sidecar's container mounts. The live run (limits from the cgroup, a real
// registry) is `docker.live.test.ts`, run by ticket 35's Linux job.

const images = { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" };
const PULL_TOKEN = "ostra_pull_cred_9a8b7c6d5e4f3a2b";
const TASK_TOKEN = "ostra_tt_fleet_boxes_4d3c2b1a0f9e";
const image: BoxImage = {
  ref: "registry.ostra-test.invalid/ostra/project-a",
  digest: `sha256:${"e".repeat(64)}`,
  pull: { username: "ostra-puller", token: PULL_TOKEN },
};

let engine: FakeEngine;
let boxes: DockerBoxes;
let root = "";

beforeEach(async () => {
  engine = await startFakeEngine();
  boxes = createDockerBoxes(createEngine(engine.address), { images });
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-fleet-boxes-"));
});

afterEach(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const boxInput = (name: string, extra: Partial<BoxInput> = {}): BoxInput => ({
  taskId: taskIdSchema.parse(`task-${name}`),
  sessionId: sessionIdSchema.parse(`session-${name}`),
  boxId: boxIdSchema.parse(`box-${name}`),
  leaseEpoch: leaseEpochSchema.parse(1),
  serverUrl: "http://ostra-server:8787",
  baseImage: null,
  tokenDir: path.join(root, "boxes", `box-${name}`),
  ...extra,
});

/** Every file under the runner's folder, as text. */
const allFiles = async (dir: string): Promise<{ readonly file: string; readonly text: string }[]> => {
  const found: { file: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      found.push({ file, text: await readFile(file, "latin1") });
    }
  }
  return found;
};

/** A bridge with no init behind it: this file's cases never start a process in the box. */
const idleBridge: Bridge = {
  initPid: 1,
  agentUid: 1000,
  platform: "linux",
  spawn: () => Promise.reject(new Error("no init in this test")),
  prepare: () => Promise.resolve(),
  listProcesses: () => Promise.resolve([]),
  killTree: () => Promise.resolve(),
  reapAll: () => Promise.resolve([]),
  closed: new Promise(() => undefined),
  close: () => undefined,
  features: [],
  spawnApp: () => Promise.reject(new Error("no init in this test")),
  startBrowser: () => Promise.reject(new Error("no init in this test")),
  openForward: () => Promise.reject(new Error("no init in this test")),
};

describe("a box's size on Docker (F-095)", () => {
  it("F-095/c4: the agent's container gets exactly the size, with swap equal to memory and a pids cap; the sidecar and each service get their fixed limits", async () => {
    const size = { cpuMillis: 2000, memoryMiB: 4096 };
    const input = boxInput("sized", {
      size,
      services: [{ name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: null }],
    });
    const created = await boxes.createBox(input);
    if (!created.ok) throw new Error(created.error.message);
    const limits = await boxes.limitsOf(input.boxId);
    const byRole = (role: string) => limits.filter((each) => each.role === role);
    expect(byRole("agent")).toEqual([
      { role: "agent", name: `ostra-box-${input.boxId}-agent`, cpuMillis: 2000, memoryMiB: 4096, memorySwapMiB: 4096, pidsLimit: 4096 },
    ]);
    const { sidecar, service } = DEFAULT_FIXED_LIMITS;
    expect(byRole("sidecar")).toEqual([
      { role: "sidecar", name: `ostra-box-${input.boxId}-sidecar`, cpuMillis: sidecar.cpuMillis, memoryMiB: sidecar.memoryMiB, memorySwapMiB: sidecar.memoryMiB, pidsLimit: 4096 },
    ]);
    expect(byRole("service")).toEqual([
      { role: "service", name: `ostra-box-${input.boxId}-svc-postgres`, cpuMillis: service.cpuMillis, memoryMiB: service.memoryMiB, memorySwapMiB: service.memoryMiB, pidsLimit: 4096 },
    ]);
  });

  it("F-095/c4: the fixed limits are the runner's settings, and a box with no size limits only the sidecar and the services", async () => {
    const tuned = createDockerBoxes(createEngine(engine.address), {
      images,
      limits: { sidecar: { cpuMillis: 500, memoryMiB: 128 }, service: { cpuMillis: 750, memoryMiB: 512 } },
    });
    const input = boxInput("unsized", { services: [{ name: "redis", image: "redis:8", port: 6379, variables: [], healthCheck: null }] });
    const created = await tuned.createBox(input);
    if (!created.ok) throw new Error(created.error.message);
    const limits = await tuned.limitsOf(input.boxId);
    expect(limits.find((each) => each.role === "agent")).toMatchObject({ cpuMillis: null, memoryMiB: null, pidsLimit: 4096 });
    expect(limits.find((each) => each.role === "sidecar")).toMatchObject({ cpuMillis: 500, memoryMiB: 128, memorySwapMiB: 128 });
    expect(limits.find((each) => each.role === "service")).toMatchObject({ cpuMillis: 750, memoryMiB: 512, memorySwapMiB: 512 });
  });

  it("F-095/c4: the executor takes box sizes, and its offer is the Engine's CPUs and memory less the reserve, with the slots setting or half the CPUs", async () => {
    engine.info.cpus = 16;
    engine.info.memoryBytes = 32 * 1024 * 1024 * 1024;
    const executor = (slots?: number) =>
      new DockerExecutor({
        taskRoot: path.join(root, "task"),
        bridge: idleBridge,
        pool: {
          boxes,
          tokenRoot: path.join(root, "boxes"),
          tokenOwner: { kind: "group", gid: 0 },
          boxInput: () => ({ sessionId: sessionIdSchema.parse("s"), leaseEpoch: leaseEpochSchema.parse(1), serverUrl: "http://ostra-server:8787", baseImage: null }),
          capacity: { reserveCpuMillis: 1000, reserveMemoryMiB: 2048, ...(slots === undefined ? {} : { slots }) },
        },
      });
    const plain = executor();
    expect(plain.capabilities.boxSizes).toBe(true);
    // Nothing read yet: no offer, as the contract says, until the first reading.
    expect(plain.capacity()).toBeNull();
    await plain.refreshCapacity();
    expect(plain.capacity()).toEqual({ slots: 8, cpuMillis: 15_000, memoryMiB: 30_720 });
    const pinned = executor(3);
    await pinned.refreshCapacity();
    expect(pinned.capacity()).toEqual({ slots: 3, cpuMillis: 15_000, memoryMiB: 30_720 });
    // A reserve larger than the host offers nothing, never a negative.
    expect(dockerCapacity({ cpus: 1, memoryBytes: 1024 * 1024 * 1024 }, { reserveCpuMillis: 1000, reserveMemoryMiB: 2048 })).toEqual({ slots: 1, cpuMillis: 0, memoryMiB: 0 });
  });
});

describe("a box from the registry (F-120)", () => {
  it("F-120/c2: pulls ref@digest before anything of the box is made, with the credential in the Engine call's header only; the credential is in no container and no file", async () => {
    const input = boxInput("from-registry", { image });
    const callsBefore = engine.calls.length;
    const created = await boxes.createBox(input);
    if (!created.ok) throw new Error(created.error.message);
    // One pull, by digest, with the lease's credential, before any network, volume or container.
    expect(engine.pulls).toHaveLength(1);
    expect(engine.pulls[0]).toMatchObject({ ref: `${image.ref}@${image.digest}`, username: "ostra-puller", password: PULL_TOKEN, serverAddress: "registry.ostra-test.invalid" });
    const firstCreate = engine.calls.findIndex((call, index) => index >= callsBefore && /^POST \/(networks|volumes|containers)\/create$/.test(call));
    expect(engine.pulls[0]?.atCall).toBeLessThan(firstCreate);
    // The agent's container runs exactly that digest.
    expect(created.value.resources.agent.body.Image).toBe(`${image.ref}@${image.digest}`);
    // The credential reached no container's spec and no file of the runner's.
    for (const container of engine.containers.values()) {
      expect(JSON.stringify(container.body), container.name).not.toContain(PULL_TOKEN);
    }
    for (const { file, text } of await allFiles(root)) {
      expect(text, file).not.toContain(PULL_TOKEN);
    }
  });

  it("F-120/c2: a refused pull makes nothing of the box, and its words carry no credential", async () => {
    engine.failNext.set("pull", 401);
    const input = boxInput("refused-pull", { image });
    const created = await boxes.createBox(input);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.message).toContain("pulling the box's image failed");
    expect(created.error.message).not.toContain(PULL_TOKEN);
    expect(engine.containers.size).toBe(0);
    expect(engine.networks.has(`ostra-box-${input.boxId}`)).toBe(false);
    expect(engine.volumes.size).toBe(0);
  });

  it("F-120/c3: with no registry image, the host's own snapshot stays the path, and nothing is pulled", async () => {
    const input = boxInput("local-snapshot", { snapshotImage: "ostra-snapshot/project-a:snap-1" });
    const created = await boxes.createBox(input);
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value.resources.agent.body.Image).toBe("ostra-snapshot/project-a:snap-1");
    expect(engine.pulls).toEqual([]);
  });
});

describe("the task token on Docker (F-015)", () => {
  it("F-015/c4: the executor writes the task token into a folder that only the sidecar's container mounts, read-only, and nowhere else", async () => {
    const executor = new DockerExecutor({
      taskRoot: path.join(root, "task"),
      bridge: idleBridge,
      pool: {
        boxes,
        tokenRoot: path.join(root, "boxes"),
        tokenOwner: { kind: "group", gid: 0 },
        boxInput: () => ({ sessionId: sessionIdSchema.parse("s"), leaseEpoch: leaseEpochSchema.parse(1), serverUrl: "http://ostra-server:8787", baseImage: null }),
        capacity: { reserveCpuMillis: 1000, reserveMemoryMiB: 2048 },
      },
    });
    const box = { taskId: taskIdSchema.parse("task-token"), boxId: boxIdSchema.parse("box-token") };
    const proxies = { gitBaseUrl: "http://127.0.0.1:9/git", modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
    const created = await executor.create({ ...box, spec: taskSpecFixture, proxies, taskToken: TASK_TOKEN, size: { cpuMillis: 1000, memoryMiB: 2048 }, image });
    if (!created.ok) throw new Error(created.error.message);
    const tokenDir = path.join(root, "boxes", box.boxId);
    expect(await readFile(path.join(tokenDir, "token"), "utf8")).toBe(TASK_TOKEN);
    const mountsOf = (role: string): readonly unknown[] => {
      const container = [...engine.containers.values()].find((each) => each.name === `ostra-box-${box.boxId}-${role}`);
      const mounts: unknown = Reflect.get(Object(container?.body["HostConfig"]), "Mounts");
      return Array.isArray(mounts) ? mounts : [];
    };
    const tokenMounts = (role: string) => mountsOf(role).filter((mount) => Reflect.get(Object(mount), "Source") === tokenDir);
    expect(tokenMounts("sidecar")).toEqual([{ Type: "bind", Source: tokenDir, Target: "/run/ostra", ReadOnly: true }]);
    expect(tokenMounts("agent")).toEqual([]);
    // The token is in no container's spec: not an environment variable, an argument or a label.
    for (const container of engine.containers.values()) {
      expect(JSON.stringify(container.body), container.name).not.toContain(TASK_TOKEN);
    }
    // And in no other file of the runner's or the task's.
    for (const { file, text } of await allFiles(root)) {
      if (path.dirname(file) !== tokenDir) {
        expect(text, file).not.toContain(TASK_TOKEN);
      }
    }
    // Release takes the box and its token folder.
    expect(await executor.release(box, "requested")).toEqual({ ok: true, value: undefined });
    expect(engine.containers.size).toBe(0);
    await expect(readdir(tokenDir)).rejects.toThrow();
  });
});
