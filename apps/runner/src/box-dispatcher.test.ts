import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerBoxes, createEngine } from "@ostra/adapter-executor-docker";
import { startFakeEngine } from "@ostra/adapter-executor-docker/testing";
import type { FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoxDispatcher } from "./box-dispatcher.ts";
import { exitCodes, runCli } from "./cli/cli.ts";
import { createCapturingTerminal } from "./cli/terminal.ts";
import { runSidecarCommand, sidecarEnvSchema } from "./run-sidecar.ts";
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

const ACCESS_TOKEN = "ostra-runner-box-dispatcher-token";

describe("the box dispatcher", () => {
  it("creates a box for a dispatch, keeps a token file for its sidecar, and removes it all when the sidecar exits", async () => {
    const boxes = createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } });
    const dispatcher = createBoxDispatcher({
      boxes,
      link: { fetchSpec: () => Promise.resolve({ ok: true, value: taskSpecFixture }), statusChanged: () => undefined },
      tokens: { get: () => Promise.resolve({ ok: true, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined },
      dataDir: root,
      serverUrl: "http://ostra-server:8787",
      capacity: 1,
      labels: [],
      logger: silentLogger,
    });
    const boxId = boxIdSchema.parse("box-dispatched");
    const dispatch = makeCommand({
      seq: 1,
      id: "dispatch-1",
      notAfter: Date.now() + 60_000,
      kind: "dispatch",
      body: { taskId: taskSpecFixture.taskId, sessionId: taskSpecFixture.sessionId, boxId, leaseEpoch: taskSpecFixture.leaseEpoch },
    });
    if (dispatch.kind !== "dispatch") {
      throw new Error("not a dispatch");
    }
    expect(await dispatcher.handlers.dispatch(dispatch)).toEqual({ result: "accepted" });
    expect(await dispatcher.handlers.dispatch({ ...dispatch, body: { ...dispatch.body, boxId: boxIdSchema.parse("another") } })).toEqual({
      result: "rejected",
      reason: "no-capacity",
    });
    for (let attempt = 0; attempt < 100 && engine.containers.size < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(engine.containers.size).toBe(2);
    expect(dispatcher.status()).toMatchObject({ executor: "docker", freeSlots: 0, running: [taskSpecFixture.sessionId] });
    expect(await readFile(path.join(root, "boxes", boxId, "token"), "utf8")).toBe(ACCESS_TOKEN);
    const agent = [...engine.containers.values()].find((container) => container.name.endsWith("-agent"));
    expect(JSON.stringify(agent?.body)).not.toContain(ACCESS_TOKEN);

    for (const container of engine.containers.values()) {
      container.status = "exited";
    }
    await Promise.all(dispatcher.boxes());
    expect(engine.containers.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
    expect(await readdir(path.join(root, "boxes"))).toEqual([]);
    expect(dispatcher.status().freeSlots).toBe(1);
  }, 30_000);
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
    };
    expect(sidecarEnvSchema.safeParse(good)).toMatchObject({ success: true, data: { OSTRA_LEASE_EPOCH: 2, OSTRA_RUNNER_SHELL: "bash" } });
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_LEASE_EPOCH: "0" }).success).toBe(false);
    expect(sidecarEnvSchema.safeParse({ ...good, OSTRA_BRIDGE_NONCE: "short" }).success).toBe(false);
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
