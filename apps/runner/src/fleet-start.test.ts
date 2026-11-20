import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerBoxes, createEngine } from "@ostra/adapter-executor-docker";
import { startFakeEngine } from "@ostra/adapter-executor-docker/testing";
import type { FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { HostExecutor } from "@ostra/adapter-executor-host";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema, runnerIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { CommandKind, CommandOf } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import { exitCodes, runCli } from "./cli/cli.ts";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { startConnection } from "./connection/peer.ts";
import type { PeerStatus, RunnerConnection } from "./connection/peer.ts";
import { DOCKER_CAPABILITIES } from "./pool-approval.ts";
import { detectInstall, hostSlots, PERSONAL_SLOTS, reportedCapabilities } from "./reports.ts";
import { makeCommand, startFakeGateway } from "./testing/fake-gateway.ts";
import type { FakeGateway } from "./testing/fake-gateway.ts";
import { startFakeServer } from "./testing/fake-server.ts";
import type { FakeServer } from "./testing/fake-server.ts";
import { rejectAllHandlers } from "./testing/handlers.ts";

// Milestone 5's ticket 19: what a runner reports (F-092), its slots (F-014), a reserved label
// refused at start, and drain and resume on offers (F-092). The pool runner's whole start, through
// joining and an admin's approval against core's real gateway, is core's
// `src/gateway/runner-pool-start.test.ts` (F-091).

let root = "";
let engine: FakeEngine | undefined;
let server: FakeServer | undefined;
let gateway: FakeGateway | undefined;
const connections: RunnerConnection[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-fleet-start-"));
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.stop()));
  await gateway?.close();
  await server?.close();
  await engine?.close();
  gateway = undefined;
  server = undefined;
  engine = undefined;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TOKEN = "ostra-fleet-start-access-token";
const runnerId = runnerIdSchema.parse("runner-fleet-start");

/** A command of `kind`, as the gateway sends it. */
const commandOf = <K extends CommandKind>(kind: K, seq: number, body: unknown): CommandOf<K> => {
  const command = makeCommand({ seq, id: `${kind}-${String(seq)}`, notAfter: Date.now() + 60_000, kind, body });
  const isKind = (value: typeof command): value is CommandOf<K> => value.kind === kind;
  if (!isKind(command)) throw new Error(`not a ${kind}`);
  return command;
};

const connect = async (peer: "runner" | "sidecar", status: () => PeerStatus): Promise<FakeGateway> => {
  server = await startFakeServer();
  server.accessTokens.set(TOKEN, runnerId);
  gateway = startFakeGateway(server);
  const connection = await startConnection({
    serverUrl: server.url,
    peer: peer === "runner" ? { kind: "runner", runnerId } : { kind: "sidecar", taskId: taskSpecFixture.taskId, boxId: boxIdSchema.parse("box-sidecar"), leaseEpoch: taskSpecFixture.leaseEpoch },
    tokens: { get: () => Promise.resolve({ ok: true, token: TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined },
    dataDir: path.join(root, "peer"),
    handlers: rejectAllHandlers,
    status,
    logger: silentLogger,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10 },
  });
  connections.push(connection);
  const fake = gateway;
  await fake.waitFor(() => fake.connected());
  return fake;
};

describe("what a runner reports (F-092)", () => {
  it("F-092, F-013: hello and each status carry the executor, its capabilities, what it offers, its labels and how it was installed, and the gateway's parser takes them", async () => {
    const resources = { slots: 4, cpuMillis: 7000, memoryMiB: 14_336 };
    const fake = await connect("runner", () => ({
      executor: "docker",
      processContainment: "container",
      capacity: 4,
      freeSlots: 4,
      labels: ["gpu", "tier:fast"],
      running: [],
      resources,
      capabilities: DOCKER_CAPABILITIES,
      install: "image",
    }));
    const hello = fake.hellos[0];
    expect(hello).toMatchObject({ executor: "docker", resources, capabilities: DOCKER_CAPABILITIES, install: "image" });
    expect(fake.statuses[0]).toMatchObject({ executor: "docker", capacity: 4, freeSlots: 4, labels: ["gpu", "tier:fast"], resources, capabilities: DOCKER_CAPABILITIES, install: "image", processContainment: "container" });
    expect(fake.protocolErrors).toEqual([]);
  });

  it("F-092: a host runner reports its executor's capabilities and no resources; a sidecar reports none of it", async () => {
    const host = new HostExecutor({ dataDir: path.join(root, "host") }, { logger: silentLogger, clock: { now: () => Date.now() } });
    const capabilities = reportedCapabilities(host.capabilities);
    expect(capabilities).toEqual({ isolation: "none", services: false, boxSizes: false, snapshots: "host-cache", registry: "none", nodeWait: false });
    const fake = await connect("runner", () => ({ executor: "host", capacity: 2, freeSlots: 2, labels: [], running: [], resources: null, capabilities, install: "npm" }));
    expect(fake.hellos[0]).toMatchObject({ executor: "host", resources: null, capabilities, install: "npm" });
    expect(fake.statuses[0]).toMatchObject({ resources: null, capabilities, install: "npm" });
    await gateway?.close();
    await server?.close();
    const sidecar = await connect("sidecar", () => ({ executor: "docker", capacity: 1, freeSlots: 0, labels: [], running: [], resources: null, capabilities, install: "image" }));
    expect(sidecar.hellos[0]).not.toHaveProperty("executor");
    expect(sidecar.hellos[0]).not.toHaveProperty("capabilities");
    expect(sidecar.hellos[0]).not.toHaveProperty("install");
  });

  it("F-092: how a runner was installed: npm from a node_modules folder, the image by its mark, and source otherwise", () => {
    expect(detectInstall(path.join("/usr", "lib", "node_modules", "ostra", "dist", "ostra.js"), {})).toBe("npm");
    expect(detectInstall("C:\\Users\\me\\.ostra\\runner\\versions\\1.4.1\\node_modules\\ostra\\dist\\ostra.js", {})).toBe("npm");
    expect(detectInstall("/app/apps/runner/src/main.ts", { OSTRA_INSTALL: "image" })).toBe("image");
    expect(detectInstall("/home/me/ostra/apps/runner/src/main.ts", {})).toBe("source");
  });

  it("F-092: a reserved label in OSTRA_RUNNER_LABELS is refused at start, with the reason", async () => {
    const terminal = createCapturingTerminal();
    const code = await runCli(["runner", "--server", "http://127.0.0.1:1", "--data-dir", root, "--labels", "gpu,os:linux,executor:docker"], {
      env: {},
      terminal,
      signal: new AbortController().signal,
      install: "source",
      runSignedIn: () => Promise.resolve(exitCodes.ok),
      runSidecar: () => Promise.resolve(exitCodes.usage),
    });
    expect(code).toBe(exitCodes.usage);
    expect(terminal.lines().join("")).toContain("the labels os:linux, executor:docker are reserved: ostra sets executor:, os:, arch: labels itself");
  });
});

describe("a runner's slots (F-014)", () => {
  it("F-067, F-014: a personal runner holds two tasks at once unless OSTRA_RUNNER_SLOTS says otherwise", () => {
    expect(PERSONAL_SLOTS).toBe(2);
    expect(hostSlots({})).toBe(2);
    expect(hostSlots({ slots: 3 })).toBe(3);
    // The older OSTRA_RUNNER_CAPACITY still counts, and OSTRA_RUNNER_SLOTS wins over it.
    expect(hostSlots({ capacity: 5 })).toBe(5);
    expect(hostSlots({ slots: 3, capacity: 5 })).toBe(3);
  });
});

describe("drain and resume on offers (F-092)", () => {
  const dispatchOf = (seq: number, boxId: string): CommandOf<"dispatch"> =>
    commandOf("dispatch", seq, { taskId: taskSpecFixture.taskId, sessionId: sessionIdSchema.parse(`session-${boxId}`), boxId: boxIdSchema.parse(boxId), leaseEpoch: taskSpecFixture.leaseEpoch });

  it("F-092: a drained runner answers offers with no free slots and refuses them, and resume takes them again", async () => {
    engine = await startFakeEngine();
    const boxes = createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } });
    const dispatcher = createBoxDispatcher({
      boxes,
      link: { fetchSpec: () => Promise.resolve({ ok: true, value: taskSpecFixture }), statusChanged: () => undefined },
      taskToken: () => Promise.resolve({ ok: true, value: "task-token" }),
      dataDir: root,
      serverUrl: "http://ostra-server:8787",
      capacity: 2,
      labels: [],
      logger: silentLogger,
      tokenAccess: { kind: "group", gid: 4242 },
    });
    expect(dispatcher.status().freeSlots).toBe(2);
    expect(await dispatcher.handlers.drain(commandOf("drain", 1, {}))).toEqual({ result: "done" });
    expect(dispatcher.status().freeSlots).toBe(0);
    expect(await dispatcher.handlers.dispatch(dispatchOf(2, "box-while-drained"))).toEqual({ result: "rejected", reason: "draining" });
    expect(engine.containers.size).toBe(0);

    expect(await dispatcher.handlers.resume(commandOf("resume", 3, {}))).toEqual({ result: "done" });
    expect(dispatcher.status().freeSlots).toBe(2);
    expect(await dispatcher.handlers.dispatch(dispatchOf(4, "box-after-resume"))).toEqual({ result: "accepted" });
    expect(dispatcher.status().freeSlots).toBe(1);
    const made = engine;
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const check = (): void => {
        if ([...made.containers.values()].filter((container) => container.status === "running").length >= 2) resolve();
        else if (Date.now() > deadline) reject(new Error("the box didn't start"));
        else setTimeout(check, 20);
      };
      check();
    });
    for (const container of made.containers.values()) container.status = "exited";
    await Promise.all(dispatcher.boxes());
  }, 30_000);
});
