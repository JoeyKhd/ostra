import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createDockerBoxes, createDockerSnapshots, createEngine } from "@ostra/adapter-executor-docker";
import type { SnapshotBuilder, SnapshotGit } from "@ostra/adapter-executor-docker";
import { startFakeEngine, tarOf } from "@ostra/adapter-executor-docker/testing";
import type { FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema, imageDigestSchema, projectIdSchema, repoIdSchema, runnerIdSchema, sha256HexSchema, snapshotCredentialsSchema, snapshotIdSchema } from "@ostra/protocol";
import type { CommandKind, CommandOf, SnapshotCredentials, TaskEvent } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import type { BoxDispatcherOptions } from "./box-dispatcher.ts";
import { makeCommand } from "./testing/fake-gateway.ts";
import { startFakeServer } from "./testing/fake-server.ts";
import type { FakeServer } from "./testing/fake-server.ts";
import { fetchPullCredential, fetchPushCredential } from "./task-host/server-link.ts";

// Milestone 5's ticket 21 (F-120): a `docker` pool runner's snapshot pushes and its boxes' registry
// images, against the fake Engine API and a fake server that issues the registry's credentials as
// core does (ticket 17). The credentials are fetched with the runner's real calls, each for one
// build or one lease, and go to the Engine's call alone: nothing of them lands in the runner's data
// folder. Without a registry, milestone 3's path holds: the runner builds and keeps its own.

const ACCESS_TOKEN = "ostra-runner-registry-access-token";
const TASK_TOKEN = "ostra_tt_registry-images-task-token";
const PULL = { registry: "registry.ostra-test.invalid", username: "ostra-puller", token: "ostra_pull_cred_8c7b6a5f4e3d2c1b", expiresAt: Date.now() + 600_000 };
const PUSH = { registry: "registry.ostra-test.invalid", username: "ostra-pusher", token: "ostra_push_cred_1f2e3d4c5b6a7980", expiresAt: Date.now() + 600_000 };
const projectId = projectIdSchema.parse(taskSpecFixture.projectId);
const snapshotId = snapshotIdSchema.parse("0196f1a0-snapshot-registry");
const imageRef = `registry.ostra-test.invalid/ostra/snapshots/${projectId}`;
const imageDigest = imageDigestSchema.parse(`sha256:${"e".repeat(64)}`);
const gzipped = promisify(gzip);

let root = "";
let engine: FakeEngine;
let server: FakeServer;
const GIT_TOKEN = "ghs_registryImagesGitToken0123456789";
const repoId = repoIdSchema.parse("repo-web");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-registry-images-"));
  engine = await startFakeEngine();
  server = await startFakeServer();
  server.accessTokens.set(ACCESS_TOKEN, runnerIdSchema.parse("runner-registry"));
});

afterEach(async () => {
  await server.close();
  await engine.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const tokens = { get: () => Promise.resolve({ ok: true as const, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined };

const commandOf = <K extends CommandKind>(kind: K, seq: number, body: unknown): CommandOf<K> => {
  const command = makeCommand({ seq, id: `${kind}-${String(seq)}`, notAfter: Date.now() + 60_000, kind, body });
  const isKind = (value: typeof command): value is CommandOf<K> => value.kind === kind;
  if (!isKind(command)) throw new Error(`not a ${kind}`);
  return command;
};

const waitFor = async (ready: () => boolean, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`waited too long for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Every file under the runner's data folder, as text. */
const dataFiles = async (): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(await readFile(path.join(entry.parentPath, entry.name), "utf8").catch(() => ""));
  }
  return out;
};

/** A stand-in for git: a clone makes its folder, and nothing reaches the network. */
const fakeGit: SnapshotGit = async (args, options) => {
  if (args.includes("clone")) {
    await mkdir(path.resolve(options.cwd, args.at(-1) ?? "."), { recursive: true });
  }
  return { code: 0 };
};

/** A stand-in for `docker build`: an image of one layer, with a planted file when the setup leaks. */
const fakeBuild =
  (plant: Readonly<Record<string, string>> = {}): SnapshotBuilder =>
  async (input) => {
    const files: Record<string, string> = { "task/snapshot/workspace/README.md": "# ready\n", ...plant };
    engine.addImage({
      tag: input.tag,
      labels: { "ostra.snapshot": snapshotId, "ostra.project": projectId },
      archive: tarOf([{ name: "blobs/sha256/1", content: await gzipped(tarOf(Object.entries(files).map(([name, content]) => ({ name, content: Buffer.from(content) })))) }]),
    });
    return { exitCode: 0 };
  };

const makeDispatcher = (events: TaskEvent[], extra: Partial<BoxDispatcherOptions> = {}) =>
  createBoxDispatcher({
    boxes: createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } }),
    link: { fetchSpec: () => Promise.resolve({ ok: true, value: taskSpecFixture }), statusChanged: () => undefined },
    taskToken: () => Promise.resolve({ ok: true, value: TASK_TOKEN }),
    dataDir: root,
    serverUrl: "http://ostra-server:8787",
    capacity: 2,
    labels: [],
    logger: silentLogger,
    tokenAccess: { kind: "group", gid: 4242 },
    pullCredential: fetchPullCredential({ serverUrl: server.url, tokens }),
    pushCredential: fetchPushCredential({ serverUrl: server.url, tokens }),
    reportRunnerEvent: (event) => events.push(event),
    ...extra,
  });

const credentials = (): SnapshotCredentials => snapshotCredentialsSchema.parse({ snapshotId, repos: [{ repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 }], secrets: [{ repoId, entries: [{ kind: "variable", name: "API_TOKEN", value: "sk-setup-secret-for-the-scan", availableDuringSetup: true }] }] });

const buildCommand = (push: { readonly ref: string } | null) =>
  commandOf("snapshot-build", 2, {
    snapshotId,
    projectId,
    environment: {
      baseImage: null,
      setupScript: "true\n",
      repos: [
        {
          repoId,
          fullName: "ostra-test/test1",
          cloneUrl: "https://github.com/ostra-test/test1.git",
          defaultBranch: "main",
          checkoutDir: "test1",
          variables: [],
          files: [],
          envFile: ".env",
          setupSecrets: { variables: ["API_TOKEN"], files: [] },
        },
      ],
      inputsHash: sha256HexSchema.parse("f".repeat(64)),
    },
    push,
    builder: "docker",
  });

const dispatchWithImage = (boxId: string) =>
  commandOf("dispatch", 1, {
    taskId: taskSpecFixture.taskId,
    sessionId: taskSpecFixture.sessionId,
    boxId: boxIdSchema.parse(boxId),
    leaseEpoch: taskSpecFixture.leaseEpoch,
    box: { size: { name: "medium", cpuMillis: 2000, memoryMiB: 4096 }, image: { ref: imageRef, digest: imageDigest } },
  });

const boxStarted = (): boolean => [...engine.containers.values()].filter((container) => container.status === "running").length >= 2;

describe("snapshot pushes and image pulls on docker (ticket 21)", () => {
  it("F-120/c2: a build that pushes fetches the push credential for that build, pushes only after the scan passed, and reports the registry's digest", async () => {
    server.registry.pushes.set(snapshotId, PUSH);
    const events: TaskEvent[] = [];
    const snapshots = createDockerSnapshots({ engine: createEngine(engine.address), workDir: root, defaultBaseImage: "ostra/base:test", git: fakeGit, builder: fakeBuild() });
    const dispatcher = makeDispatcher(events, { snapshots, snapshotCredentials: () => Promise.resolve({ ok: true, value: credentials() }) });
    expect(await dispatcher.handlers["snapshot-build"](buildCommand({ ref: `${imageRef}:${snapshotId}` }))).toEqual({ result: "accepted" });
    await dispatcher.builds();
    expect(server.registry.requests).toEqual([{ kind: "push", id: snapshotId, bearer: ACCESS_TOKEN }]);
    expect(engine.pushes).toHaveLength(1);
    expect(engine.pushes[0]).toMatchObject({ ref: `${imageRef}:${snapshotId}`, username: PUSH.username, password: PUSH.token });
    const scanned = engine.calls.findIndex((call) => call.startsWith("GET /images/") && call.endsWith("/get"));
    expect(scanned).toBeGreaterThanOrEqual(0);
    expect(engine.pushes[0]?.atCall).toBeGreaterThan(scanned);
    expect(events).toHaveLength(1);
    const built = events[0];
    expect(built?.kind).toBe("snapshot.built");
    const local = [...engine.images.values()][0]?.id;
    // The registry's digest, which boxes pull by, not the image's ID on this host.
    expect(built?.kind === "snapshot.built" ? built.imageDigest : "").not.toBe(local);
    expect((await dataFiles()).some((text) => text.includes(PUSH.token))).toBe(false);
  }, 60_000);

  it("F-120/c2: a scan hit pushes nothing, though the build had its push credential", async () => {
    server.registry.pushes.set(snapshotId, PUSH);
    const events: TaskEvent[] = [];
    const snapshots = createDockerSnapshots({ engine: createEngine(engine.address), workDir: root, defaultBaseImage: "ostra/base:test", git: fakeGit, builder: fakeBuild({ "task/snapshot/workspace/.env": "API_TOKEN=sk-setup-secret-for-the-scan" }) });
    const dispatcher = makeDispatcher(events, { snapshots, snapshotCredentials: () => Promise.resolve({ ok: true, value: credentials() }) });
    await dispatcher.handlers["snapshot-build"](buildCommand({ ref: `${imageRef}:${snapshotId}` }));
    await dispatcher.builds();
    expect(engine.pushes).toEqual([]);
    expect(events).toMatchObject([{ kind: "snapshot.failed", snapshotId, reason: "secret-found" }]);
  }, 60_000);

  it("F-120/c3: without a registry the runner builds and keeps its own snapshot, and asks for no push credential", async () => {
    const events: TaskEvent[] = [];
    const snapshots = createDockerSnapshots({ engine: createEngine(engine.address), workDir: root, defaultBaseImage: "ostra/base:test", git: fakeGit, builder: fakeBuild() });
    const dispatcher = makeDispatcher(events, { snapshots, snapshotCredentials: () => Promise.resolve({ ok: true, value: credentials() }) });
    await dispatcher.handlers["snapshot-build"](buildCommand(null));
    await dispatcher.builds();
    expect(server.registry.requests).toEqual([]);
    expect(engine.pushes).toEqual([]);
    const kept = await snapshots.hasSnapshot(snapshotId);
    expect(kept.ok && kept.value !== null).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "snapshot.built", snapshotId, imageDigest: kept.ok ? kept.value?.imageDigest : "" });
  }, 60_000);

  it("F-120/c2: a box from the registry pulls its image by digest with the pull credential for its lease, which is in no file of the runner's data folder", async () => {
    server.registry.pulls.set(taskSpecFixture.taskId, { leaseEpoch: taskSpecFixture.leaseEpoch, credential: PULL });
    const dispatcher = makeDispatcher([]);
    expect(await dispatcher.handlers.dispatch(dispatchWithImage("box-from-registry"))).toEqual({ result: "accepted" });
    await waitFor(boxStarted, "the box");
    expect(server.registry.requests).toEqual([{ kind: "pull", id: taskSpecFixture.taskId, bearer: ACCESS_TOKEN }]);
    expect(engine.pulls).toHaveLength(1);
    expect(engine.pulls[0]).toMatchObject({ ref: `${imageRef}@${imageDigest}`, username: PULL.username, password: PULL.token, serverAddress: "registry.ostra-test.invalid" });
    // The agent's container runs exactly that image, with the size's limits; no container holds the credential.
    const agent = [...engine.containers.values()].find((container) => container.name.endsWith("-agent"));
    expect(agent?.body["Image"]).toBe(`${imageRef}@${imageDigest}`);
    expect(JSON.stringify([...engine.containers.values()].map((container) => container.body))).not.toContain(PULL.token);
    // Nothing of it in the runner's data folder, while the box runs or after.
    expect((await dataFiles()).some((text) => text.includes(PULL.token))).toBe(false);
    for (const container of engine.containers.values()) container.status = "exited";
    await Promise.all(dispatcher.boxes());
    expect((await dataFiles()).some((text) => text.includes(PULL.token))).toBe(false);
  }, 60_000);

  it("F-120/c2: when core has no pull credential for the lease (the cluster's own identity), the box's pull goes without one", async () => {
    server.registry.pulls.set(taskSpecFixture.taskId, { leaseEpoch: taskSpecFixture.leaseEpoch, credential: null });
    const dispatcher = makeDispatcher([]);
    await dispatcher.handlers.dispatch(dispatchWithImage("box-node-auth"));
    await waitFor(boxStarted, "the box");
    expect(engine.pulls).toHaveLength(1);
    expect(engine.pulls[0]).toMatchObject({ ref: `${imageRef}@${imageDigest}`, username: null, password: null });
    for (const container of engine.containers.values()) container.status = "exited";
    await Promise.all(dispatcher.boxes());
  }, 60_000);
});
