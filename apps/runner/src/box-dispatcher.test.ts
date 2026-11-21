import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerBoxes, createEngine } from "@ostra/adapter-executor-docker";
import { startFakeEngine } from "@ostra/adapter-executor-docker/testing";
import type { FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoxDispatcher, detectTokenAccess } from "./box-dispatcher.ts";
import type { TokenAccess } from "./box-dispatcher.ts";
import { exitCodes, runCli } from "./cli/cli.ts";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { runSidecarCommand, sidecarAppReach, sidecarEnvSchema } from "./run-sidecar.ts";
import { makeCommand } from "./testing/fake-gateway.ts";

// The runner's side of the `docker` executor (ticket 22), against a fake Engine API: a dispatch
// makes a box with a token file for its sidecar, and the box goes when the sidecar exits.

let root = "";
let engine: FakeEngine;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-box-dispatcher-"));
  engine = await startFakeEngine();
});

afterEach(async () => {
  await engine.close();
  await rm(root, { recursive: true, force: true });
});

const ACCESS_TOKEN = "ostra-task-box-dispatcher-token";

const posix = process.platform !== "win32";
const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

const dispatchOf = (boxId: string) => {
  const dispatch = makeCommand({
    seq: 1,
    id: "dispatch-1",
    notAfter: Date.now() + 60_000,
    kind: "dispatch",
    body: { taskId: taskSpecFixture.taskId, sessionId: taskSpecFixture.sessionId, boxId: boxIdSchema.parse(boxId), leaseEpoch: taskSpecFixture.leaseEpoch },
  });
  if (dispatch.kind !== "dispatch") {
    throw new Error("not a dispatch");
  }
  return dispatch;
};

// Until the condition holds. It used to give up after 2 s and carry on as if it held: on a busy
// machine the box's containers came later, `exitAll` missed them, and the case hung on a sidecar
// that never exited. Now a condition that never holds fails here, and says so.
const waitFor = async (ready: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      throw new Error(`the condition didn't hold within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

type DispatcherExtra = {
  readonly tokenAccess: TokenAccess;
  readonly chown?: (path: string, uid: number, gid: number) => Promise<void>;
  readonly nextToken?: () => string;
  readonly asked?: { taskId: string; leaseEpoch: number }[];
};

const makeDispatcher = (extra: DispatcherExtra) => {
  const boxes = createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } });
  return createBoxDispatcher({
    boxes,
    link: { fetchSpec: () => Promise.resolve({ ok: true, value: taskSpecFixture }), statusChanged: () => undefined },
    taskToken: (taskId, leaseEpoch) => {
      extra.asked?.push({ taskId, leaseEpoch });
      return Promise.resolve({ ok: true, value: extra.nextToken?.() ?? ACCESS_TOKEN });
    },
    dataDir: root,
    serverUrl: "http://ostra-server:8787",
    capacity: 1,
    labels: [],
    logger: silentLogger,
    tokenAccess: extra.tokenAccess,
    ...(extra.chown === undefined ? {} : { chown: extra.chown }),
  });
};

const sidecarBody = (): string => JSON.stringify([...engine.containers.values()].find((container) => container.name.endsWith("-sidecar"))?.body);

/**
 * Both of the box's containers started, not only made: `exitAll` before the sidecar's start would
 * be undone by it, and the case would wait for an exit that never comes.
 */
const boxStarted = (): boolean => [...engine.containers.values()].filter((container) => container.status === "running").length >= 2;

const exitAll = (): void => {
  for (const container of engine.containers.values()) {
    container.status = "exited";
  }
};

describe("the box dispatcher", () => {
  it("creates a box for a dispatch, keeps a token file for its sidecar, and removes it all when the sidecar exits", async () => {
    const dispatcher = makeDispatcher({ tokenAccess: { kind: "group", gid: 4242 } });
    const boxId = "box-dispatched";
    const dispatch = dispatchOf(boxId);
    expect(await dispatcher.handlers.dispatch(dispatch)).toEqual({ result: "accepted" });
    expect(await dispatcher.handlers.dispatch({ ...dispatch, body: { ...dispatch.body, boxId: boxIdSchema.parse("another") } })).toEqual({
      result: "rejected",
      reason: "no-capacity",
    });
    await waitFor(boxStarted);
    expect(engine.containers.size).toBe(2);
    expect(dispatcher.status()).toMatchObject({ executor: "docker", freeSlots: 0, running: [taskSpecFixture.sessionId] });
    expect(await readFile(path.join(root, "boxes", boxId, "token"), "utf8")).toBe(ACCESS_TOKEN);
    const agent = [...engine.containers.values()].find((container) => container.name.endsWith("-agent"));
    expect(JSON.stringify(agent?.body)).not.toContain(ACCESS_TOKEN);

    exitAll();
    await Promise.all(dispatcher.boxes());
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
    expect(await readdir(path.join(root, "boxes"))).toEqual([]);
    expect(dispatcher.status().freeSlots).toBe(1);
  }, 30_000);

  it("F-141/c6: a dispatch to start the app hands its purpose to the box's sidecar, which starts the task itself", async () => {
    const dispatcher = makeDispatcher({ tokenAccess: { kind: "group", gid: 4242 } });
    const dispatch = dispatchOf("box-app-only");
    expect(await dispatcher.handlers.dispatch({ ...dispatch, body: { ...dispatch.body, purpose: "app" } })).toEqual({ result: "accepted" });
    await waitFor(boxStarted);
    expect(sidecarBody()).toContain("OSTRA_DISPATCH_PURPOSE=app");
    exitAll();
    await Promise.all(dispatcher.boxes());
  }, 30_000);

  it.skipIf(!posix)("keeps the token readable by its group alone: 0440 in a 0750 folder, and the sidecar joins the group", async () => {
    const dispatcher = makeDispatcher({ tokenAccess: { kind: "group", gid: 4242 } });
    await dispatcher.handlers.dispatch(dispatchOf("box-group"));
    await waitFor(boxStarted);
    const folder = path.join(root, "boxes", "box-group");
    expect(await modeOf(path.join(folder, "token"))).toBe(0o440);
    expect(await modeOf(folder)).toBe(0o750);
    expect(await modeOf(path.join(root, "boxes"))).toBe(0o700);
    expect(sidecarBody()).toContain('"GroupAdd":["4242"]');
    expect(await readdir(folder)).toEqual(["token"]);
    exitAll();
    await Promise.all(dispatcher.boxes());
  }, 30_000);

  // As root the runner hands the file to the sidecar's uid and closes the folder to everyone else.
  // A runner that isn't root can't write into that folder, so only root (and Windows, which has no
  // such modes) runs this one.
  it.skipIf(posix && process.getuid?.() !== 0)("hands the token file and folder to the sidecar's uid when it can: 0400 in a 0500 folder", async () => {
    const handed: { readonly path: string; readonly uid: number; readonly gid: number }[] = [];
    const dispatcher = makeDispatcher({
      tokenAccess: { kind: "owner", uid: 1000, gid: 1000 },
      chown: (target, uid, gid) => {
        handed.push({ path: path.relative(root, target).split(path.sep).join("/"), uid, gid });
        return Promise.resolve();
      },
    });
    await dispatcher.handlers.dispatch(dispatchOf("box-owner"));
    await waitFor(boxStarted);
    expect(handed).toEqual([
      { path: "boxes/box-owner", uid: 1000, gid: 1000 },
      { path: "boxes/box-owner/token.next", uid: 1000, gid: 1000 },
    ]);
    expect(sidecarBody()).not.toContain("GroupAdd");
    if (posix) {
      expect(await modeOf(path.join(root, "boxes", "box-owner", "token"))).toBe(0o400);
      expect(await modeOf(path.join(root, "boxes", "box-owner"))).toBe(0o500);
    }
    exitAll();
    await Promise.all(dispatcher.boxes());
    expect(await readdir(path.join(root, "boxes"))).toEqual([]);
  }, 30_000);

  it("makes no box when the token file can't be kept from other users", async () => {
    const dispatcher = makeDispatcher({ tokenAccess: { kind: "none" } });
    await dispatcher.handlers.dispatch(dispatchOf("box-none"));
    await Promise.all(dispatcher.boxes());
    expect(engine.containers.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(dispatcher.status().freeSlots).toBe(1);
  });

  it("F-015/c3: asks for the box's task token once, with its lease epoch, and never rewrites the token file", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      let issued = 0;
      const asked: { taskId: string; leaseEpoch: number }[] = [];
      const dispatcher = makeDispatcher({
        tokenAccess: { kind: "group", gid: 4242 },
        asked,
        nextToken: () => {
          issued += 1;
          return `${ACCESS_TOKEN}-${String(issued)}`;
        },
      });
      await dispatcher.handlers.dispatch(dispatchOf("box-once"));
      await waitFor(boxStarted);
      const file = path.join(root, "boxes", "box-once", "token");
      expect(await readFile(file, "utf8")).toBe(`${ACCESS_TOKEN}-1`);
      const written = (await stat(file)).mtimeMs;
      // An hour on the box: the old runner rewrote its 10-minute token every 4 minutes.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(await readFile(file, "utf8")).toBe(`${ACCESS_TOKEN}-1`);
      expect((await stat(file)).mtimeMs).toBe(written);
      expect(issued).toBe(1);
      expect(asked).toEqual([{ taskId: taskSpecFixture.taskId, leaseEpoch: taskSpecFixture.leaseEpoch }]);
      if (posix) {
        expect(await modeOf(file)).toBe(0o440);
      }
      expect(await readdir(path.dirname(file))).toEqual(["token"]);
      exitAll();
      await Promise.all(dispatcher.boxes());
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("F-015/c3: makes no box when core gives no task token", async () => {
    const boxes = createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } });
    const dispatcher = createBoxDispatcher({
      boxes,
      link: { fetchSpec: () => Promise.resolve({ ok: true, value: taskSpecFixture }), statusChanged: () => undefined },
      taskToken: () => Promise.resolve({ ok: false, failure: { kind: "stale-lease", message: "stale" } }),
      dataDir: root,
      serverUrl: "http://ostra-server:8787",
      capacity: 1,
      labels: [],
      logger: silentLogger,
      tokenAccess: { kind: "group", gid: 4242 },
    });
    await dispatcher.handlers.dispatch(dispatchOf("box-no-token"));
    await Promise.all(dispatcher.boxes());
    expect(engine.containers.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("detectTokenAccess", () => {
  it("is the runner's own group unless it is root, which hands the file to the sidecar's uid", () => {
    const access = detectTokenAccess();
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === 0) {
      expect(access).toEqual({ kind: "owner", uid: 1000, gid: 1000 });
    } else if (gid === undefined) {
      expect(access).toEqual({ kind: "none" });
    } else {
      expect(access).toEqual({ kind: "group", gid });
    }
  });
});

describe("ostra sidecar", () => {
  it("refuses to start outside a box, and its settings are strict", async () => {
    const terminal = createCapturingTerminal();
    expect(await runSidecarCommand({ env: {}, terminal, signal: new AbortController().signal })).toBe(exitCodes.usage);
    expect(terminal.lines().join("")).toContain("inside a docker box");
    const good = {
      OSTRA_SERVER_URL: "http://ostra-server:8787",
      OSTRA_SIDECAR_TOKEN_FILE: "/run/ostra/token",
      OSTRA_TASK_ID: "task-1",
      OSTRA_SESSION_ID: "session-1",
      OSTRA_BOX_ID: "box-1",
      OSTRA_LEASE_EPOCH: "2",
      OSTRA_BRIDGE_NONCE: "n".repeat(43),
      OSTRA_BRIDGE_PORT: "7101",
      OSTRA_SIDECAR_HOST: "sidecar",
      OSTRA_TASK_ROOT: "/task",
      OSTRA_SIDECAR_DATA_DIR: "/var/lib/ostra-sidecar",
    };
    expect(sidecarEnvSchema.safeParse(good)).toMatchObject({ success: true, data: { OSTRA_LEASE_EPOCH: 2, OSTRA_RUNNER_SHELL: "bash" } });
    // The sidecar's state is out of the agent's reach: required, and never inside the shared task root.
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_SIDECAR_DATA_DIR: undefined }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_SIDECAR_DATA_DIR: "/task/.sidecar" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_SIDECAR_DATA_DIR: "/task" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_SIDECAR_DATA_DIR: "/task/../task/x" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_SIDECAR_DATA_DIR: "/taskdata" }).success).toBe(true);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_LEASE_EPOCH: "0" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_BRIDGE_NONCE: "short" }).success).toBe(false);
  });

  it("F-140/c12, F-141/c6: a sidecar reads its box's executor, which decides how it reaches the app, and \"Start the app\"'s purpose", () => {
    const good = {
      OSTRA_SERVER_URL: "http://ostra-server:8787",
      OSTRA_SIDECAR_TOKEN_FILE: "/run/ostra/token",
      OSTRA_TASK_ID: "task-1",
      OSTRA_SESSION_ID: "session-1",
      OSTRA_BOX_ID: "box-1",
      OSTRA_LEASE_EPOCH: "2",
      OSTRA_BRIDGE_NONCE: "n".repeat(43),
      OSTRA_BRIDGE_PORT: "7101",
      OSTRA_SIDECAR_HOST: "sidecar",
      OSTRA_TASK_ROOT: "/task",
      OSTRA_SIDECAR_DATA_DIR: "/var/lib/ostra-sidecar",
    };
    // A docker box's unless the pod says otherwise; a turn's when no purpose is given.
    expect(sidecarEnvSchema.safeParse(good)).toMatchObject({ success: true, data: { OSTRA_BOX_EXECUTOR: "docker" } });
    expect(sidecarEnvSchema.safeParse(good).data?.OSTRA_DISPATCH_PURPOSE).toBeUndefined();
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_BOX_EXECUTOR: "kubernetes", OSTRA_DISPATCH_PURPOSE: "app" })).toMatchObject({
      success: true,
      data: { OSTRA_BOX_EXECUTOR: "kubernetes", OSTRA_DISPATCH_PURPOSE: "app" },
    });
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_BOX_EXECUTOR: "host" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_DISPATCH_PURPOSE: "agent" }).success).toBe(false);
    // A pod's sidecar dials the pod's localhost; a docker box's goes through the init's forwarder.
    expect([sidecarAppReach("docker"), sidecarAppReach("kubernetes")]).toEqual(["forwarder", "loopback"]);
  });
});

describe("OSTRA_JOIN_TOKEN_FILE", () => {
  it("is read when no join token is given, and a missing file is a usage error", async () => {
    const file = path.join(root, "join-token");
    await writeFile(file, "ostra-join-from-a-file\n");
    const seen: string[] = [];
    const run = (env: Readonly<Record<string, string>>): Promise<number> =>
      runCli(["runner", "--server", "http://127.0.0.1:1", "--data-dir", path.join(root, "runner")], {
        env,
        terminal: createCapturingTerminal(),
        signal: new AbortController().signal,
        runSignedIn: () => Promise.resolve(exitCodes.ok),
        runSidecar: () => Promise.resolve(exitCodes.ok),
        deviceFlow: { sleep: () => Promise.resolve() },
      }).then((code) => {
        seen.push(String(code));
        return code;
      });
    // The server isn't there: the run fails reaching it, not on the token file.
    expect(await run({ OSTRA_JOIN_TOKEN_FILE: file })).toBe(exitCodes.failed);
    expect(await run({ OSTRA_JOIN_TOKEN_FILE: path.join(root, "missing") })).toBe(exitCodes.usage);
    expect(seen).toHaveLength(2);
  });
});
