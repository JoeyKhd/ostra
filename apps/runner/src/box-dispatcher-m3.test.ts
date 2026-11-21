import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerBoxes, createEngine, servicesFileSchema } from "@ostra/adapter-executor-docker";
import type { DockerSnapshots } from "@ostra/adapter-executor-docker";
import { startFakeEngine } from "@ostra/adapter-executor-docker/testing";
import type { FakeContainer, FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { adapterError, ok, silentLogger } from "@ostra/adapter-sdk";
import type { SnapshotBuildResult } from "@ostra/adapter-sdk";
import { boxIdSchema, imageDigestSchema, projectIdSchema, repoIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema, taskSpecSchema } from "@ostra/protocol";
import type { LeaseEpoch, ServiceSecrets, SnapshotCredentials, SnapshotId, TaskEvent, TaskId, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import type { BoxDispatcherOptions } from "./box-dispatcher.ts";
import type { LinkResult } from "./task-host/server-link.ts";
import { makeCommand } from "./testing/fake-gateway.ts";

// Milestone 3's ticket 14 on the pool runner (F-094, F-051), against the fake Engine API: a box's
// services get their secrets with the box's task token and start on its network, their health goes
// to the sidecar in the token folder; a box starts from the snapshot this host keeps; and a
// `snapshot-build` is accepted at once and its result goes up as a runner event.

let root = "";
let engine: FakeEngine;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-box-dispatcher-m3-"));
  engine = await startFakeEngine();
});

afterEach(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const TASK_TOKEN = "ostra-task-token-for-the-box";
const SERVICE_SECRET = "service-password-from-the-secret-store";
const DIGEST = imageDigestSchema.parse(`sha256:${"d".repeat(64)}`);
const snapshotId = snapshotIdSchema.parse("0196f1a0-snapshot-ready");

const specWith = (extra: Partial<Pick<TaskSpec, "services" | "snapshot">>): TaskSpec => taskSpecSchema.parse({ ...taskSpecFixture, ...extra });

const servicesSpec = specWith({
  services: [
    {
      name: "postgres",
      image: "postgres:17",
      port: 5432,
      variables: [
        { name: "POSTGRES_USER", value: "app" },
        { name: "POSTGRES_PASSWORD", value: "a plain value the secret replaces" },
      ],
      healthCheck: "pg_isready -U app",
    },
    { name: "cache", image: "redis:7", port: 6379, variables: [], healthCheck: null },
  ],
});

const secrets: readonly ServiceSecrets[] = [{ name: "postgres", variables: [{ name: "POSTGRES_PASSWORD", value: SERVICE_SECRET }] }] as const satisfies readonly ServiceSecrets[];

const dispatchOf = (boxId: string) => {
  const dispatch = makeCommand({
    seq: 1,
    id: `dispatch-${boxId}`,
    notAfter: Date.now() + 60_000,
    kind: "dispatch",
    body: { taskId: taskSpecFixture.taskId, sessionId: taskSpecFixture.sessionId, boxId: boxIdSchema.parse(boxId), leaseEpoch: taskSpecFixture.leaseEpoch },
  });
  if (dispatch.kind !== "dispatch") {
    throw new Error("not a dispatch");
  }
  return dispatch;
};

const waitFor = async (ready: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      throw new Error(`the condition didn't hold within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const named = (suffix: string): FakeContainer | undefined => [...engine.containers.values()].find((container) => container.name.endsWith(`-${suffix}`));
const envOf = (container: FakeContainer | undefined): readonly string[] => {
  const env: unknown = container?.body["Env"];
  return Array.isArray(env) ? env.map(String) : [];
};

const exitAll = (): void => {
  for (const container of engine.containers.values()) {
    container.status = "exited";
  }
};

type Asked = { taskId: TaskId; leaseEpoch: LeaseEpoch; taskToken: string };

const makeDispatcher = (spec: TaskSpec, extra: Partial<BoxDispatcherOptions> = {}) =>
  createBoxDispatcher({
    boxes: createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } }),
    link: { fetchSpec: () => Promise.resolve({ ok: true, value: spec }), statusChanged: () => undefined },
    taskToken: () => Promise.resolve({ ok: true, value: TASK_TOKEN }),
    dataDir: root,
    serverUrl: "http://ostra-server:8787",
    capacity: 2,
    labels: [],
    logger: silentLogger,
    tokenAccess: { kind: "group", gid: 4242 },
    servicesPollMs: 20,
    ...extra,
  });

describe("a pool runner's box with services (F-094)", () => {
  it("F-094/c2: the services get their secrets with the box's task token, start on the box's network with them, and their health reaches the sidecar in the token folder", async () => {
    const asked: Asked[] = [];
    const dispatcher = makeDispatcher(servicesSpec, {
      serviceSecrets: (taskId, leaseEpoch, taskToken) => {
        asked.push({ taskId, leaseEpoch, taskToken });
        return Promise.resolve({ ok: true, value: secrets });
      },
    });
    expect(await dispatcher.handlers.dispatch(dispatchOf("box-services"))).toEqual({ result: "accepted" });
    await waitFor(() => named("svc-postgres")?.status === "running" && named("sidecar")?.status === "running");
    expect(asked).toEqual([{ taskId: taskSpecFixture.taskId, leaseEpoch: taskSpecFixture.leaseEpoch, taskToken: TASK_TOKEN }]);
    // The secret is the service's own: on its container, with the plain one of that name replaced, and nowhere else.
    expect(envOf(named("svc-postgres"))).toEqual(["POSTGRES_USER=app", `POSTGRES_PASSWORD=${SERVICE_SECRET}`]);
    for (const other of ["agent", "sidecar", "svc-cache"]) {
      expect(JSON.stringify(named(other)?.body)).not.toContain(SERVICE_SECRET);
    }
    // Docker's health check says healthy; the cache has none, so its port is reached from the sidecar.
    const postgres = named("svc-postgres");
    if (postgres !== undefined) {
      postgres.health = "healthy";
    }
    const file = path.join(root, "boxes", "box-services", "services.json");
    await waitFor(async () => (await readFile(file, "utf8").catch(() => null)) !== null);
    const report = servicesFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(report.services.map((service) => [service.name, service.outcome])).toEqual([
      ["postgres", "healthy"],
      ["cache", "healthy"],
    ]);
    expect(await readFile(file, "utf8")).not.toContain(SERVICE_SECRET);
    expect(engine.execs.some((exec) => exec.container.endsWith("-sidecar") && exec.cmd.includes("cache") && exec.cmd.includes("6379"))).toBe(true);

    exitAll();
    await Promise.all(dispatcher.boxes());
    expect(engine.containers.size).toBe(0);
    expect(await readdir(path.join(root, "boxes"))).toEqual([]);
  }, 30_000);

  it("F-094/c3: a service that isn't healthy in time is reported failed to the sidecar, with words", async () => {
    const dispatcher = makeDispatcher(servicesSpec, { serviceSecrets: () => Promise.resolve({ ok: true, value: secrets }), servicesWithinMs: 300 });
    await dispatcher.handlers.dispatch(dispatchOf("box-slow"));
    const file = path.join(root, "boxes", "box-slow", "services.json");
    await waitFor(async () => (await readFile(file, "utf8").catch(() => null)) !== null);
    const report = servicesFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
    expect(report.services[0]).toEqual({ name: "postgres", outcome: "failed", reason: "The service wasn't healthy within 1 s." });
    exitAll();
    await Promise.all(dispatcher.boxes());
  }, 30_000);

  it("F-094/c2: no box when the services' secrets can't be read, or there's no way to read them", async () => {
    for (const serviceSecrets of [
      (): Promise<LinkResult<readonly ServiceSecrets[]>> => Promise.resolve({ ok: false, failure: { kind: "stale-lease", message: "stale" } }),
      undefined,
    ]) {
      const dispatcher = makeDispatcher(servicesSpec, serviceSecrets === undefined ? {} : { serviceSecrets });
      await dispatcher.handlers.dispatch(dispatchOf("box-no-secrets"));
      await Promise.all(dispatcher.boxes());
      expect(engine.containers.size).toBe(0);
    }
  }, 30_000);

  it("F-094/c2: a spec without services asks for no secrets and writes no report", async () => {
    let asked = 0;
    const dispatcher = makeDispatcher(taskSpecFixture, {
      serviceSecrets: () => {
        asked += 1;
        return Promise.resolve({ ok: true, value: [] });
      },
    });
    await dispatcher.handlers.dispatch(dispatchOf("box-plain"));
    await waitFor(() => named("sidecar")?.status === "running");
    expect(asked).toBe(0);
    expect(await readdir(path.join(root, "boxes", "box-plain"))).toEqual(["token"]);
    exitAll();
    await Promise.all(dispatcher.boxes());
  }, 30_000);
});

/** A host's snapshots: one kept image, and builds answered by `build`. */
const fakeSnapshots = (build: () => Promise<SnapshotBuildResult>, built: SnapshotId[] = []): DockerSnapshots => ({
  hasSnapshot: (id) => Promise.resolve(ok(id === snapshotId ? { imageRef: "ostra-snapshot/project:ready", imageDigest: DIGEST } : null)),
  buildSnapshot: async (input) => {
    built.push(input.snapshotId);
    return ok(await build());
  },
});

describe("a pool runner's box from a snapshot (F-051)", () => {
  it("F-051/c3: the agent's container starts from the snapshot this host keeps, by its digest; one it doesn't keep, or of another digest, starts from the base image", async () => {
    const cases = [
      { spec: specWith({ snapshot: { kind: "image", snapshotId, imageRef: "ostra-snapshot/project:ready", digest: DIGEST } }), image: DIGEST },
      { spec: specWith({ snapshot: { kind: "image", snapshotId, imageRef: "ostra-snapshot/project:ready", digest: imageDigestSchema.parse(`sha256:${"e".repeat(64)}`) } }), image: "ostra/base:test" },
      { spec: specWith({ snapshot: { kind: "image", snapshotId: snapshotIdSchema.parse("not-here"), imageRef: "x", digest: DIGEST } }), image: "ostra/base:test" },
    ] as const;
    for (const [index, each] of cases.entries()) {
      const dispatcher = makeDispatcher({ ...each.spec, environment: { ...each.spec.environment, baseImage: null } }, { snapshots: fakeSnapshots(() => Promise.reject(new Error("no build"))) });
      await dispatcher.handlers.dispatch(dispatchOf(`box-snap-${String(index)}`));
      await waitFor(() => named("agent")?.status === "running" && named("sidecar")?.status === "running");
      expect(named("agent")?.body["Image"]).toBe(each.image);
      exitAll();
      await Promise.all(dispatcher.boxes());
    }
  }, 60_000);
});

describe("a snapshot build on a pool runner (F-051)", () => {
  const credentials: SnapshotCredentials = snapshotCredentialsSchema.parse({ snapshotId, repos: [], secrets: [] });
  const buildCommand = (id: SnapshotId = snapshotId, seq = 2) => {
    const command = makeCommand({
      seq,
      id: `build-${id}`,
      notAfter: Date.now() + 60_000,
      kind: "snapshot-build",
      body: {
        snapshotId: id,
        projectId: projectIdSchema.parse(taskSpecFixture.projectId),
        environment: {
          baseImage: null,
          setupScript: "pnpm install\n",
          repos: [
            {
              repoId: repoIdSchema.parse("repo-web"),
              fullName: "ostra-test/test1",
              cloneUrl: "https://github.com/ostra-test/test1.git",
              defaultBranch: "main",
              checkoutDir: "test1",
              variables: [],
              files: [],
              envFile: ".env",
              setupSecrets: { variables: [], files: [] },
            },
          ],
          inputsHash: sha256HexSchema.parse("f".repeat(64)),
        },
      },
    });
    if (command.kind !== "snapshot-build") {
      throw new Error("not a build");
    }
    return command;
  };

  it("F-051/c1: a build is accepted at once, built once however often it's sent, and its result goes up as a runner event", async () => {
    const events: TaskEvent[] = [];
    const built: SnapshotId[] = [];
    let finish: (result: SnapshotBuildResult) => void = () => undefined;
    const dispatcher = makeDispatcher(taskSpecFixture, {
      snapshots: fakeSnapshots(() => new Promise((resolve) => (finish = resolve)), built),
      snapshotCredentials: () => Promise.resolve({ ok: true, value: credentials }),
      reportRunnerEvent: (event) => events.push(event),
    });
    expect(await dispatcher.handlers["snapshot-build"](buildCommand())).toEqual({ result: "accepted" });
    // A dispatch isn't held behind the build.
    expect(await dispatcher.handlers.dispatch(dispatchOf("box-during-build"))).toEqual({ result: "accepted" });
    await waitFor(() => built.length === 1);
    expect(await dispatcher.handlers["snapshot-build"](buildCommand())).toEqual({ result: "accepted" });
    finish({ outcome: "built", imageRef: "ostra-snapshot/project:ready", imageDigest: DIGEST, durationMs: 1_500 });
    await dispatcher.builds();
    expect(built).toEqual([snapshotId]);
    expect(events).toEqual([{ kind: "snapshot.built", snapshotId, imageDigest: DIGEST, durationMs: 1_500 }]);
    await waitFor(() => named("sidecar")?.status === "running");
    exitAll();
    await Promise.all(dispatcher.boxes());
  }, 30_000);

  it("F-051: a failed build reports its reason and words; a build core took back reports nothing; unreadable credentials or a crash report build-failed", async () => {
    const events: TaskEvent[] = [];
    const answers: (() => Promise<LinkResult<SnapshotCredentials>>)[] = [
      () => Promise.resolve({ ok: true, value: credentials }),
      () => Promise.resolve({ ok: false, failure: { kind: "stale-lease", message: "the build is another runner's" } }),
      () => Promise.resolve({ ok: false, failure: { kind: "unavailable", message: "down" } }),
    ];
    const ids = ["build-a", "build-b", "build-c"].map((id) => snapshotIdSchema.parse(id));
    const dispatcher = makeDispatcher(taskSpecFixture, {
      snapshots: fakeSnapshots(() => Promise.resolve({ outcome: "failed", reason: "secret-found", detail: "The setup secret API_TOKEN was found in the image, so the image was deleted." })),
      snapshotCredentials: (id) => (answers[ids.indexOf(id)] ?? answers[0] ?? (() => Promise.reject(new Error("none"))))(),
      reportRunnerEvent: (event) => events.push(event),
    });
    for (const [index, id] of ids.entries()) {
      await dispatcher.handlers["snapshot-build"](buildCommand(id, index + 2));
    }
    await dispatcher.builds();
    expect(events).toEqual([
      { kind: "snapshot.failed", snapshotId: ids[0], reason: "secret-found", detail: "The setup secret API_TOKEN was found in the image, so the image was deleted." },
      { kind: "snapshot.failed", snapshotId: ids[2], reason: "build-failed", detail: "The runner couldn't read the build's credentials from the server." },
    ]);

    const crashed: TaskEvent[] = [];
    const crashing = makeDispatcher(taskSpecFixture, {
      snapshots: { hasSnapshot: () => Promise.resolve(ok(null)), buildSnapshot: () => Promise.reject(new Error("boom")) },
      snapshotCredentials: () => Promise.resolve({ ok: true, value: credentials }),
      reportRunnerEvent: (event) => crashed.push(event),
    });
    await crashing.handlers["snapshot-build"](buildCommand());
    await crashing.builds();
    expect(crashed).toEqual([{ kind: "snapshot.failed", snapshotId, reason: "build-failed", detail: "The runner's build stopped on an unexpected error." }]);

    const unsupported = makeDispatcher(taskSpecFixture, {
      snapshots: { hasSnapshot: () => Promise.resolve(ok(null)), buildSnapshot: () => Promise.resolve(adapterError("unsupported", "no")) },
    });
    expect(await unsupported.handlers["snapshot-build"](buildCommand())).toEqual({ result: "rejected", reason: "not-supported" });
  }, 30_000);
});
