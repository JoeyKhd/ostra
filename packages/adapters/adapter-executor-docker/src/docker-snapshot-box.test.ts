import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { killTree, silentLogger } from "@ostra/adapter-sdk";
import type { BoxRef, TaskProxies } from "@ostra/adapter-sdk";
import { startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, snapshotIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskSpec, TaskSpecService } from "@ostra/protocol";
import { commandFixtures, snapshotCredentialsFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenForInit } from "./bridge/bridge-server.ts";
import type { Bridge } from "./bridge/bridge-server.ts";
import { DockerExecutor } from "./docker-executor.ts";
import { writeServicesFile } from "./services-file.ts";
import { SNAPSHOT_MARKER_FILE } from "./snapshot/dockerfile.ts";

// Milestone 3's ticket 14 inside a box, as its sidecar drives it: the real bridge, and the box's init
// as a child of this test (as in docker-executor.contract.test.ts). A box from a snapshot finds the
// snapshot's checkouts on its task volume (here, a folder the test fills as Docker would from the
// image), moves them in, fetches and runs the incremental setup; a box without it falls back to a
// full setup and says so (F-051). The services' health comes from the pool runner's file (F-094).

const run = promisify(execFile);
const INIT = fileURLToPath(new URL("./init/main.ts", import.meta.url));
const snapshotId = snapshotIdSchema.parse("0196f1a0-snapshot-box");

let root = "";
let upstream: GitUpstream;
let init: ChildProcess;
let bridge: Bridge;
let proxies: TaskProxies;
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-docker-snapshot-box-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  const boxId = boxIdSchema.parse("snapshot-box");
  const nonce = randomBytes(32).toString("base64url");
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  init = spawn(process.execPath, [INIT], {
    env: { ...process.env, OSTRA_BOX_ID: boxId, OSTRA_BRIDGE_NONCE: nonce, OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}` },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  bridge = await listener.connected;
  proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
}, 60_000);

afterAll(async () => {
  bridge.close();
  if (init.pid !== undefined && init.exitCode === null && init.signalCode === null) {
    await killTree(init.pid);
  }
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

const SETUP = 'if [ -f node_modules/installed ]; then echo "setup: incremental"; else echo "setup: full"; mkdir -p node_modules; touch node_modules/installed; fi\n';

const newBox = (): BoxRef => {
  counter += 1;
  return { taskId: taskIdSchema.parse(`task-snapshot-box-${String(counter)}`), boxId: boxIdSchema.parse(`box-snapshot-box-${String(counter)}`) };
};

const specFor = (box: BoxRef, extra: Partial<TaskSpec>): TaskSpec => ({
  ...taskSpecFixture,
  taskId: box.taskId,
  branchName: `ostra/${box.taskId}-work`,
  environment: { ...taskSpecFixture.environment, setupScript: SETUP },
  ...extra,
});

/** What Docker does with the snapshot image: the task volume filled with its checkouts and its ID. */
const fillVolumeFromSnapshot = async (taskRoot: string, id: string): Promise<void> => {
  const workspace = path.join(taskRoot, "snapshot", "workspace");
  await mkdir(workspace, { recursive: true });
  await run("git", ["clone", "--quiet", "--single-branch", "--branch", "main", `${upstream.origin}/ostra-test/test1.git`, path.join(workspace, "test1")]);
  // The setup's result in the snapshot: installed dependencies, ignored by git.
  await mkdir(path.join(workspace, "test1", "node_modules"), { recursive: true });
  await writeFile(path.join(workspace, "test1", "node_modules", "installed"), "yes");
  await writeFile(path.join(taskRoot, "snapshot", SNAPSHOT_MARKER_FILE), `${id}\n`);
};

/** A commit on `main` after the snapshot was built: the box must start from it. */
const commitUpstream = async (file: string): Promise<string> => {
  const clone = path.join(root, `push-${String(counter)}`);
  await run("git", ["clone", "--quiet", `${upstream.origin}/ostra-test/test1.git`, clone]);
  await writeFile(path.join(clone, file), "after the snapshot\n");
  await run("git", ["-C", clone, "add", "."]);
  await run("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "after the snapshot"]);
  await run("git", ["-C", clone, "push", "--quiet", "origin", "main"]);
  return (await run("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
};

const exists = async (file: string): Promise<boolean> => (await stat(file).catch(() => null)) !== null;

describe("a docker box from a snapshot (F-051)", () => {
  it("F-051/c3,c7: a box whose volume came from its snapshot starts from the checkouts, at the default branch's current head, with an incremental setup; one without it falls back to a full setup and says so", async () => {
    const taskRoot = path.join(root, "task-a");
    const executor = new DockerExecutor({ taskRoot, bridge });
    await fillVolumeFromSnapshot(taskRoot, snapshotId);
    const head = await commitUpstream("after.md");
    const snapshot = { kind: "image" as const, snapshotId, imageRef: "ostra-snapshot/project:snap", digest: `sha256:${"d".repeat(64)}` };

    const box = newBox();
    const spec = specFor(box, { snapshot });
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    let output = "";
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: (_stream, text) => (output += text) });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.snapshot).toBe("used");
    expect(output).toContain("setup: incremental");
    const checkout = path.join(created.value.workspaceDir, "test1");
    // The checkouts moved in: the task's branch, on main's head after the snapshot, with the setup's result.
    expect(await readFile(path.join(checkout, "after.md"), "utf8")).toBe("after the snapshot\n");
    expect((await run("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await run("git", ["-C", checkout, "branch", "--show-current"])).stdout.trim()).toBe(spec.branchName);
    expect(await exists(path.join(checkout, "node_modules", "installed"))).toBe(true);
    expect(await exists(path.join(taskRoot, "snapshot"))).toBe(false);
    await executor.release(box, "requested");

    // A box whose volume holds no copy of the snapshot: the full clone and setup, said in its result.
    const other = newBox();
    const otherSpec = specFor(other, { snapshot });
    const made = await executor.create({ ...other, spec: otherSpec, proxies });
    if (!made.ok) throw new Error(made.error.message);
    let full = "";
    const fellBack = await executor.prepare({ box: other, spec: otherSpec, secrets: [], onSetupOutput: (_stream, text) => (full += text) });
    if (!fellBack.ok) throw new Error(fellBack.error.message);
    expect(fellBack.value.snapshot).toBe("fell-back");
    expect(full).toContain("setup: full");
    expect(await readFile(path.join(made.value.workspaceDir, "test1", "README.md"), "utf8")).toBe("# test1\n");
    await executor.release(other, "requested");
  }, 120_000);

  it("F-051/c3: a volume filled from another snapshot isn't used: the box falls back", async () => {
    const taskRoot = path.join(root, "task-b");
    const executor = new DockerExecutor({ taskRoot, bridge });
    await fillVolumeFromSnapshot(taskRoot, "an-older-snapshot");
    const box = newBox();
    const spec = specFor(box, { snapshot: { kind: "image", snapshotId, imageRef: "ostra-snapshot/project:snap", digest: `sha256:${"d".repeat(64)}` } });
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared.ok && prepared.value.snapshot).toBe("fell-back");
    await executor.release(box, "requested");
  }, 120_000);

  it("F-120/c2,c3: the executor hands a build's push to the runner's snapshots, and without one builds as milestone 3 did", async () => {
    const pushes: (string | null)[] = [];
    const executor = new DockerExecutor({
      taskRoot: path.join(root, "task-push"),
      bridge,
      snapshots: {
        buildSnapshot: (input) => {
          pushes.push(input.push?.ref ?? null);
          return Promise.resolve({ ok: true, value: { outcome: "built", imageRef: "ostra-snapshot/p:s", imageDigest: `sha256:${"a".repeat(64)}`, durationMs: 1 } });
        },
        hasSnapshot: () => Promise.resolve({ ok: true, value: null }),
      },
    });
    const { body } = commandFixtures["snapshot-build"];
    const input = { snapshotId: body.snapshotId, projectId: body.projectId, environment: body.environment, credentials: snapshotCredentialsFixture, onOutput: () => undefined };
    expect((await executor.buildSnapshot({ ...input, push: { ref: "registry.example/ostra/p:s", credential: { username: "push", token: "push-token" } } })).ok).toBe(true);
    expect((await executor.buildSnapshot({ ...input, push: null })).ok).toBe(true);
    expect(pushes).toEqual(["registry.example/ostra/p:s", null]);
  });
});

describe("a docker box's services (F-094)", () => {
  const db: TaskSpecService = { name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: "pg_isready" };

  it("F-094/c3: the sidecar waits for the pool runner's report of each service before the setup, and a failed service stops the setup", async () => {
    const taskRoot = path.join(root, "task-c");
    const servicesFile = path.join(root, "token-c", "services.json");
    await mkdir(path.dirname(servicesFile), { recursive: true });
    const executor = new DockerExecutor({ taskRoot, bridge, servicesFile, servicesWaitMs: 10_000 });
    expect(executor.capabilities).toMatchObject({ services: true, snapshots: "image" });
    const box = newBox();
    const spec = specFor(box, { services: [db] });
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    setTimeout(() => {
      void writeServicesFile(servicesFile, [{ name: "postgres", outcome: "healthy", afterMs: 1200 }]);
    }, 300);
    let output = "";
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: (_stream, text) => (output += text) });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.services).toEqual([{ name: "postgres", outcome: "healthy", afterMs: 1200 }]);
    expect(output).toContain("setup: full");
    await executor.release(box, "requested");

    await rm(servicesFile, { force: true });
    const failing = newBox();
    const failingSpec = specFor(failing, { services: [db] });
    await writeServicesFile(servicesFile, [{ name: "postgres", outcome: "failed", reason: "The service's container exited (exit 1) before it was healthy." }]);
    const made = await executor.create({ ...failing, spec: failingSpec, proxies });
    if (!made.ok) throw new Error(made.error.message);
    let none = "";
    const stopped = await executor.prepare({ box: failing, spec: failingSpec, secrets: [], onSetupOutput: (_stream, text) => (none += text) });
    if (!stopped.ok) throw new Error(stopped.error.message);
    expect(stopped.value).toMatchObject({ setup: null, services: [{ name: "postgres", outcome: "failed" }] });
    expect(none).toBe("");
    await executor.release(failing, "requested");
  }, 120_000);

  it("F-094/c3: with no report in time, the service failed with the reason ostra shows", async () => {
    const taskRoot = path.join(root, "task-d");
    const executor = new DockerExecutor({ taskRoot, bridge, servicesFile: path.join(root, "token-d", "services.json"), servicesWaitMs: 500 });
    const box = newBox();
    const spec = specFor(box, { services: [db] });
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    expect(prepared.ok && prepared.value.services).toEqual([{ name: "postgres", outcome: "failed", reason: "The box's runner didn't report the service's health in time." }]);
    await executor.release(box, "requested");
  }, 60_000);
});
