import { boxIdSchema, leaseEpochSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerBoxes, TASK_ROOT } from "./boxes.ts";
import type { BoxInput, DockerBoxes } from "./boxes.ts";
import { createEngine } from "./engine.ts";
import { startFakeEngine } from "./testing/fake-engine.ts";
import type { FakeContainer, FakeEngine } from "./testing/fake-engine.ts";

// Milestone 3's ticket 14 on the pool runner's side, against the fake Engine API: a box started from
// a snapshot image (F-051, Q153), and the environment's services on the box's private network
// (F-094), started before the agent, polled until healthy, and removed with the box. The live run
// waits for a Linux host with Docker (`docker.live.test.ts`).

const input: BoxInput = {
  taskId: taskIdSchema.parse("0196f1a0-task-m3"),
  sessionId: sessionIdSchema.parse("0196f1a0-session-m3"),
  boxId: boxIdSchema.parse("0196f1a0-box-m3"),
  leaseEpoch: leaseEpochSchema.parse(1),
  serverUrl: "http://ostra-server:8787",
  baseImage: "node:24-bookworm",
  tokenDir: "/var/lib/ostra-runner/boxes/0196f1a0-box-m3",
};
const images = { base: "ghcr.io/ostra/base:0.0.0", runner: "ghcr.io/ostra/runner:0.0.0" };
const SNAPSHOT = "ostra-snapshot/project-a:snapshot-17";

let engine: FakeEngine;
let boxes: DockerBoxes;

beforeEach(async () => {
  engine = await startFakeEngine();
  boxes = createDockerBoxes(createEngine(engine.address), { images });
});

afterEach(async () => {
  await engine.close();
});

const named = (suffix: string): FakeContainer | undefined => [...engine.containers.values()].find((container) => container.name === `ostra-box-${input.boxId}-${suffix}`);
const hostConfig = (container: FakeContainer | undefined): Record<string, unknown> => {
  const config: unknown = container?.body["HostConfig"];
  return typeof config === "object" && config !== null ? Object.fromEntries(Object.entries(config)) : {};
};
const envOf = (container: FakeContainer | undefined): readonly string[] => {
  const env: unknown = container?.body["Env"];
  return Array.isArray(env) ? env.map(String) : [];
};

const postgres = {
  name: "postgres",
  image: "postgres:17",
  port: 5432,
  variables: [
    { name: "POSTGRES_USER", value: "app" },
    { name: "POSTGRES_PASSWORD", value: "service-secret-from-the-credentials" },
  ],
  healthCheck: "pg_isready -U app",
} as const;
const cache = { name: "cache", image: "redis:7", port: 6379, variables: [], healthCheck: null } as const;

describe("a box from a snapshot (F-051)", () => {
  it("F-051/c7: the agent's container starts from the snapshot image, made before the sidecar so the image fills the new task volume, and nothing is mounted over the workspace", async () => {
    const created = await boxes.createBox({ ...input, snapshotImage: SNAPSHOT });
    if (!created.ok) throw new Error(created.error.message);
    const agent = named("agent");
    expect(agent?.body["Image"]).toBe(SNAPSHOT);
    // Docker copies an image's files into an empty volume when the first container that mounts it
    // is made: the agent's, from the snapshot, so the checkouts are on the volume (Q153).
    const creates = engine.calls.filter((call) => call === "POST /containers/create");
    expect(creates).toHaveLength(2);
    const order = [...engine.containers.values()].map((container) => container.name);
    expect(order).toEqual([`ostra-box-${input.boxId}-agent`, `ostra-box-${input.boxId}-sidecar`]);
    const mounts = hostConfig(agent)["Mounts"];
    expect(mounts).toEqual([{ Type: "volume", Source: `ostra-box-${input.boxId}-task`, Target: TASK_ROOT }]);
    expect(JSON.stringify(mounts)).not.toContain("NoCopy");
    expect(hostConfig(agent)["Tmpfs"]).toBeUndefined();
    expect(agent?.body["Labels"]).toMatchObject({ "ostra.snapshot-image": SNAPSHOT });
  });

  it("F-051/c7: without a snapshot the sidecar's image seeds the volume first, as milestone 1 does, on the environment's base image", async () => {
    const created = await boxes.createBox(input);
    if (!created.ok) throw new Error(created.error.message);
    expect([...engine.containers.values()].map((container) => container.name)).toEqual([`ostra-box-${input.boxId}-sidecar`, `ostra-box-${input.boxId}-agent`]);
    expect(named("agent")?.body["Image"]).toBe("node:24-bookworm");
  });
});

describe("services (F-094)", () => {
  it("F-094/c2: each service is a container on the box's private network by its name, with its variables and health check, started before the agent and removed with the box", async () => {
    const created = await boxes.createBox({ ...input, services: [postgres, cache] });
    if (!created.ok) throw new Error(created.error.message);
    const db = named("svc-postgres");
    const redis = named("svc-cache");
    expect(db?.body["Image"]).toBe("postgres:17");
    expect(envOf(db)).toEqual(["POSTGRES_USER=app", "POSTGRES_PASSWORD=service-secret-from-the-credentials"]);
    expect(db?.body["Labels"]).toMatchObject({ "ostra.box": input.boxId, "ostra.role": "service", "ostra.service": "postgres" });
    // Only the box's network, which is internal: the egress baseline holds for services too.
    expect(hostConfig(db)).toMatchObject({ NetworkMode: `ostra-box-${input.boxId}`, SecurityOpt: ["no-new-privileges:true"] });
    expect(db?.body["NetworkingConfig"]).toEqual({ EndpointsConfig: { [`ostra-box-${input.boxId}`]: { Aliases: ["postgres"] } } });
    expect(db?.networks).toEqual([`ostra-box-${input.boxId}`]);
    expect(engine.networks.get(`ostra-box-${input.boxId}`)).toMatchObject({ Internal: true });
    // Docker runs the health check in the service's container.
    expect(db?.body["Healthcheck"]).toMatchObject({ Test: ["CMD-SHELL", "pg_isready -U app"] });
    expect(redis?.body["Healthcheck"]).toBeUndefined();
    // No service's variable reaches the agent's or the sidecar's container.
    expect(envOf(named("agent")).join("\n")).not.toContain("service-secret");
    expect(envOf(named("sidecar")).join("\n")).not.toContain("service-secret");
    // Started before the agent, which may need them at once.
    const starts = engine.calls.filter((call) => /^POST \/containers\/[^/]+\/start$/.test(call)).map((call) => call.split("/")[2]);
    const ids = (suffix: string): string | undefined => named(suffix)?.id;
    expect(starts.indexOf(ids("svc-postgres"))).toBeLessThan(starts.indexOf(ids("agent")));
    expect(starts.indexOf(ids("svc-cache"))).toBeLessThan(starts.indexOf(ids("agent")));
    // The box's removal takes the services with it.
    expect(await boxes.removeBox(input.boxId)).toEqual({ ok: true, value: undefined });
    expect(engine.containers.size).toBe(0);
    expect(engine.networks.has(`ostra-box-${input.boxId}`)).toBe(false);
  });

  it("F-094/c3: the services' health is polled until each is healthy: Docker's health check, or the port reached from the box's sidecar", async () => {
    const created = await boxes.createBox({ ...input, services: [postgres, cache] });
    if (!created.ok) throw new Error(created.error.message);
    let probes = 0;
    engine.exec = (container, cmd) => {
      // The port probe runs in the sidecar, which is on the box's network, as the sidecar's user.
      expect(container.name).toBe(`ostra-box-${input.boxId}-sidecar`);
      expect(cmd.slice(-2)).toEqual(["cache", "6379"]);
      probes += 1;
      return { exitCode: probes < 3 ? 1 : 0, output: "" };
    };
    setTimeout(() => {
      const db = named("svc-postgres");
      if (db !== undefined) db.health = "healthy";
    }, 150);
    const health = await boxes.waitForServices(input.boxId, [postgres, cache], { timeoutMs: 10_000, pollMs: 20 });
    expect(health.map((item) => [item.name, item.outcome])).toEqual([
      ["postgres", "healthy"],
      ["cache", "healthy"],
    ]);
    expect(probes).toBe(3);
    expect(engine.execs.every((each) => each.user === "1000:1000")).toBe(true);
  });

  it("F-094/c3: a service that exits, or isn't healthy in time, failed, with words and never its output", async () => {
    const created = await boxes.createBox({ ...input, services: [postgres, cache] });
    if (!created.ok) throw new Error(created.error.message);
    engine.exec = () => ({ exitCode: 1, output: "connection refused" });
    const db = named("svc-postgres");
    if (db === undefined) throw new Error("no service container");
    db.status = "exited";
    db.exitCode = 2;
    const health = await boxes.waitForServices(input.boxId, [postgres, cache], { timeoutMs: 300, pollMs: 20 });
    expect(health).toEqual([
      { name: "postgres", outcome: "failed", reason: "The service's container exited (exit 2) before it was healthy." },
      { name: "cache", outcome: "failed", reason: "The service wasn't healthy within 1 s." },
    ]);
  });
});
