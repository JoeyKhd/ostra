import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_DEADLINE_MISSED, BRIDGE_FEATURES, createDockerBoxes, createEngine, DockerExecutor, listenForInit } from "@ostra/adapter-executor-docker";
import { startFakeEngine } from "@ostra/adapter-executor-docker/testing";
import type { FakeEngine } from "@ostra/adapter-executor-docker/testing";
import { descendantsOf, killTree, listProcesses, silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { boxIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoxDispatcher } from "../box-dispatcher.ts";
import { makeCommand } from "../testing/fake-gateway.ts";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Shared } from "../testing/task-host-harness.ts";

// F-017 (ADR 0029, Q154): a stop of a `docker` box whose init stops answering. Both halves, each on
// its real code: the box's sidecar runs the task host with `DockerExecutor` over the real bridge to
// the real init (a child of this test, as `docker-box.ts` runs it), and the pool runner's dispatcher
// made the box's containers on the fake Engine API. Between the init and the sidecar sits a link
// that goes silent mid-turn, both ways, as an init that hangs or a reader stalled behind a full
// buffer does: nothing it is asked is answered. The stop still ends, as a stop and not a crash, each
// bridge request at its deadline (the reap of the agent's processes too), so the sidecar's run is
// over and its process exits (`run-sidecar.ts`), and the runner then removes the box: the agent's
// container, which still runs on the Engine, by force.

const INIT = fileURLToPath(new URL("./init/main.ts", import.meta.resolve("@ostra/adapter-executor-docker")));
/** The bridge's deadline here: the default is 30 s, a stop's worth of them would outlast the case. */
const DEADLINE_MS = 1_000;

/** A link from the init to the sidecar's listener that forwards every byte until `freeze`, then none. */
const freezableLink = async (target: number): Promise<{ readonly port: number; readonly freeze: () => void; readonly close: () => Promise<void> }> => {
  let frozen = false;
  const sockets: Socket[] = [];
  const server = createServer((init) => {
    const sidecar = connect(target, "127.0.0.1");
    sockets.push(init, sidecar);
    init.on("data", (chunk: Buffer) => {
      if (!frozen) sidecar.write(chunk);
    });
    sidecar.on("data", (chunk: Buffer) => {
      if (!frozen) init.write(chunk);
    });
    init.on("error", () => undefined);
    sidecar.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    freeze: () => {
      frozen = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

const boxId = boxIdSchema.parse(`hung-init-box-${randomBytes(4).toString("hex")}`);
let shared: Shared;
let engine: FakeEngine;
let runnerDir = "";
const held: { init?: ChildProcess; link?: Awaited<ReturnType<typeof freezableLink>> } = {};

beforeAll(async () => {
  shared = await startShared("stop-hung-init");
  engine = await startFakeEngine();
  runnerDir = await mkdtemp(path.join(os.tmpdir(), "ostra-hung-init-runner-"));
}, 60_000);

afterAll(async () => {
  await held.link?.close();
  const init = held.init;
  if (init?.pid !== undefined && init.exitCode === null && init.signalCode === null) {
    await killTree(init.pid);
  }
  await engine.close();
  await shared.close();
  await rm(runnerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

/** The sidecar's side: `DockerExecutor` over the real bridge, with its deadline, to the real init behind the link. */
const hungBox = async (input: { readonly dataDir: string; readonly logger: Logger }) => {
  const nonce = randomBytes(32).toString("base64url");
  // The bridge's logger carries the box's ID, as `run-sidecar.ts`'s does (with the task's).
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: input.logger.child({ boxId }), requestDeadlineMs: DEADLINE_MS });
  const link = await freezableLink(listener.port);
  held.link = link;
  held.init = spawn(process.execPath, [INIT], {
    env: {
      ...process.env,
      OSTRA_BOX_ID: boxId,
      OSTRA_BRIDGE_NONCE: nonce,
      OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(link.port)}`,
      OSTRA_BRIDGE_FEATURES: BRIDGE_FEATURES.join(","),
      OSTRA_BOX_BROWSER: path.join(input.dataDir, "no-browser", "chromium"),
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const bridge = await listener.connected;
  return {
    executor: new DockerExecutor({ taskRoot: path.join(input.dataDir, "task"), bridge }, { logger: input.logger, clock: { now: () => Date.now() } }),
    kind: "docker" as const,
    dispose: async () => {
      bridge.close();
      await link.close();
    },
  };
};

describe("a stop when a docker box's init doesn't answer (F-017)", () => {
  it("F-017/c6: a stop mid-turn ends though the init answers nothing, each bridge request at its deadline, and the runner then removes the box, its still-running agent container by force", async () => {
    const h = await startHarness(shared, { makeExecutor: hungBox });
    try {
      const { spec } = h.taskFor(fakeMarker("silent"));
      // The pool runner's half: the box's containers on the Engine, for this task and box.
      const dispatcher = createBoxDispatcher({
        boxes: createDockerBoxes(createEngine(engine.address), { images: { base: "ostra/base:test", runner: "ostra/runner:test" } }),
        link: { fetchSpec: () => Promise.resolve({ ok: true, value: spec }), statusChanged: () => undefined },
        taskToken: () => Promise.resolve({ ok: true, value: "ostra-task-hung-init-token" }),
        dataDir: runnerDir,
        serverUrl: "http://ostra-server:8787",
        capacity: 1,
        labels: [],
        logger: silentLogger,
        tokenAccess: { kind: "group", gid: 4242 },
      });
      const made = makeCommand({
        seq: 1,
        id: "dispatch-hung-init",
        notAfter: Date.now() + 60_000,
        kind: "dispatch",
        body: { taskId: spec.taskId, sessionId: spec.sessionId, boxId, leaseEpoch: spec.leaseEpoch },
      });
      if (made.kind !== "dispatch") throw new Error("not a dispatch");
      expect(await dispatcher.handlers.dispatch(made)).toEqual({ result: "accepted" });
      await h.gateway.waitFor(() => [...engine.containers.values()].filter((container) => container.status === "running").length === 2, 20_000);
      const container = (role: "agent" | "sidecar") => [...engine.containers.values()].find((each) => each.name === `ostra-box-${boxId}-${role}`);

      // The sidecar's half: the task in the box, its agent at work on a turn that runs on.
      h.dispatch(spec, boxId);
      await h.waitForKind(spec, "turn.started");
      // The init goes silent: from here it answers nothing, and hears nothing.
      held.link?.freeze();
      if (process.platform === "win32" && held.init?.pid !== undefined) {
        // This machine's stand-in only: a running process holds its working folder on Windows, so
        // the agent's would keep the sidecar from removing the workspace. In a box the task volume
        // is on Linux, which removes what a process holds. The init stays, silent; the sidecar
        // can't hear of the agent's end.
        for (const child of descendantsOf(held.init.pid, await listProcesses())) {
          await killTree(child.pid);
        }
      }
      const started = Date.now();
      const stop = h.stop(spec);
      const ack = await h.waitForAck(stop, 120_000);
      expect(ack).toMatchObject({ result: "done" });
      expect(ack.reason).not.toBe("stop-still-pushing");
      // The sidecar's run is over, so `ostra sidecar` exits and its container with it.
      await h.idle();
      expect(Date.now() - started).toBeLessThan(90_000);
      // A stop, not a crash: the reap the init never answered didn't fail it.
      expect(h.kinds(spec)).not.toContain("session.crashed");
      expect(h.logs.filter((record) => record.message === "task run failed")).toEqual([]);
      // The reap the init never answered leaves its line all the same, with the box's ID.
      expect(h.logs.filter((record) => record.message === BRIDGE_DEADLINE_MISSED).map((record) => record.fields)).toContainEqual(
        expect.objectContaining({ boxId, request: "reap_all", deadlineMs: DEADLINE_MS }),
      );
      const sidecar = container("sidecar");
      if (sidecar === undefined) throw new Error("no sidecar container");
      sidecar.status = "exited";
      // The agent's container still runs on the Engine: its init never stopped anything.
      expect(container("agent")?.status).toBe("running");

      // The runner sees the sidecar gone and removes the box whole, the agent's container by force.
      await Promise.all(dispatcher.boxes());
      expect([...engine.containers.values()].filter((each) => each.name.startsWith(`ostra-box-${boxId}-`))).toEqual([]);
      expect(engine.networks.has(`ostra-box-${boxId}`)).toBe(false);
      expect(engine.volumes.has(`ostra-box-${boxId}-task`)).toBe(false);
      expect(dispatcher.status().freeSlots).toBe(1);
    } finally {
      await h.close();
    }
  }, 240_000);
});
