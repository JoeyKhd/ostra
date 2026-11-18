// The loopback box rehearsal: everything a real box has except the two
// containers and the kernel boundary, on one machine.
//
//   harness (server stand-in)                sidecar (runSidecar)
//     ├─ sends the handoff   ───────────────▶ handoff port
//     ├─ drives the control API ─────────────▶ control port
//     └─ spawns the init (localhost bridge) ─▶ bridge port
//                                               ├─ key proxy ── stub model
//                                               └─ git proxy ── stub upstream
//
// On a real box the sidecar and the init are in separate containers; here the
// init is a child process that connects to the sidecar's bridge port, and the
// agent (`opencode acp`) is its child. This exercises the whole protocol: the
// handoff, the bridge framing, prepare, spawn, stdio, approvals, cancel and
// stop. It can't test the kernel boundary or the egress policy — those need
// Docker and are SKIPPED. On Windows it uses native paths for the agent dirs.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boxId as toBoxId, type BoxId } from "../bridge/protocol.ts";
import { handoffSchema, type Handoff } from "../sidecar/handoff.ts";
import { runSidecar, sidecarEnvSchema } from "../sidecar/main.ts";
import { resolveOpenCodeBinary } from "../lib/opencode.ts";
import { killTree } from "../lib/process-tree.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const initEntry = path.resolve(here, "..", "init", "main.ts");
const attackCli = path.resolve(here, "..", "attack", "cli.ts");

const freePort = async (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });

export type BoxHandle = {
  readonly boxId: BoxId;
  readonly controlAddr: string;
  readonly handoffAddr: string;
  readonly bridgeAddr: string;
  readonly controlToken: string;
  readonly modelMarker: string;
  readonly gitMarker: string;
  readonly taskRoot: string;
  /** The init's PID: the agent and everything it starts run below it. */
  readonly initPid: number;
  /** When the fixture started, ms since the epoch (to tell this run's processes from older ones). */
  readonly startedAt: number;
  readonly sidecarDone: Promise<void>;
  readonly control: (method: string, pathname: string, body?: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly waitFor: (predicate: (status: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  readonly dispose: () => Promise<void>;
};

const sendHandoff = async (addr: string, handoff: Handoff): Promise<void> => {
  const [host = "", portText = "0"] = addr.split(":");
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port: Number(portText) }, () => {
      socket.write(`${JSON.stringify(handoff)}\n`);
    });
    socket.setTimeout(5000);
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) {
        socket.end();
        resolve();
      }
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("handoff timed out"));
    });
    socket.once("error", reject);
  });
};

export type StartBoxOptions = {
  readonly modelFormat?: "openai" | "anthropic";
  readonly repo?: string;
  readonly taskBranch?: string;
  /** Extra env for the init (e.g. to point OSTRA_BRIDGE_ADDR at a wrong host for a negative test). */
  readonly initEnv?: Readonly<Record<string, string>>;
  readonly log?: boolean;
  /**
   * A real model endpoint (from model.env) instead of the stub. Its key goes
   * to the sidecar in the handoff only; the agent gets the proxy's fake key.
   */
  readonly endpoint?: { readonly baseUrl: string; readonly apiKey: string; readonly modelId: string; readonly format: "openai" | "anthropic" };
};

export const startLoopbackBox = async (options: StartBoxOptions = {}): Promise<BoxHandle> => {
  const startedAt = Date.now();
  const boxId = toBoxId(`box-${randomBytes(4).toString("hex")}`);
  const handoffNonce = randomBytes(24).toString("base64url");
  const bridgeNonce = randomBytes(24).toString("base64url");
  const controlToken = randomBytes(24).toString("base64url");
  const modelMarker = `OSTRA-MODEL-SECRET-${randomBytes(6).toString("hex")}`;
  const gitMarker = `OSTRA-GIT-SECRET-${randomBytes(6).toString("hex")}`;
  const taskRoot = await mkdtemp(path.join(tmpdir(), "ostra-box-"));
  const [handoffPort, bridgePort, controlPort, keyPort, gitPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);

  const binary = await resolveOpenCodeBinary("v2");

  const sidecarEnv = sidecarEnvSchema.parse({
    OSTRA_BOX_ID: boxId,
    OSTRA_HANDOFF_NONCE: handoffNonce,
    OSTRA_SIDECAR_LISTEN: "127.0.0.1",
    OSTRA_HANDOFF_PORT: String(handoffPort),
    OSTRA_BRIDGE_PORT: String(bridgePort),
    OSTRA_CONTROL_PORT: String(controlPort),
    OSTRA_KEY_PROXY_PORT: String(keyPort),
    OSTRA_GIT_PROXY_PORT: String(gitPort),
    // Loopback rehearsal: the server stand-in, the sidecar and the agent are
    // all on 127.0.0.1, so the address-based "inside the box" refusal can't be
    // exercised here (it needs the two-container network; it is unit-tested in
    // box-network.test.ts and enforced on the real box). The handoff and
    // control ports still stand on their other guards: the one-time nonce, the
    // port closing after the first handoff, and the control bearer token.
    OSTRA_SHARED_NETNS: "0",
    OSTRA_BOX_CIDRS: "",
    OSTRA_SIDECAR_HOST_FOR_AGENT: "127.0.0.1",
    OSTRA_AGENT_TASK_ROOT: taskRoot,
    OSTRA_OPENCODE_COMMAND: binary.path,
    OSTRA_AGENT_PATH_STYLE: "native",
    // The attack checklist runs as the init's child, like the agent.
    OSTRA_AGENT_NODE: process.execPath,
    OSTRA_ATTACK_CLI: attackCli,
  });
  const sidecarDone = runSidecar(sidecarEnv);

  // Wait for the handoff port, then hand over the credentials.
  await waitForPort(handoffPort);
  const handoff = handoffSchema.parse({
    version: 1,
    nonce: handoffNonce,
    taskId: `t-${randomBytes(4).toString("hex")}`,
    bridgeNonce,
    controlToken,
    model:
      options.endpoint === undefined
        ? { kind: "stub", apiKey: `${modelMarker}-${randomBytes(12).toString("hex")}`, format: options.modelFormat ?? "openai" }
        : { kind: "endpoint", baseUrl: options.endpoint.baseUrl, apiKey: options.endpoint.apiKey, modelId: options.endpoint.modelId, format: options.endpoint.format },
    git: { upstream: "stub", token: `${gitMarker}-${randomBytes(12).toString("hex")}`, repo: options.repo ?? "ostra-test/box-fixture", taskBranch: options.taskBranch ?? "ostra/t-fixture" },
  });
  await sendHandoff(`127.0.0.1:${String(handoffPort)}`, handoff);

  // The init: a child that connects to the sidecar's bridge, as the box's
  // init would. It retries the connection itself (connectWithRetry), so there
  // is no probe of the bridge port here. Not root in the rehearsal, so it
  // spawns the agent as the developer.
  const initProcess: ChildProcess = spawn(process.execPath, [initEntry], {
    env: {
      PATH: process.env["PATH"] ?? "",
      SystemRoot: process.env["SystemRoot"] ?? "",
      OSTRA_BOX_ID: boxId,
      OSTRA_BRIDGE_NONCE: bridgeNonce,
      OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(bridgePort)}`,
      ...options.initEnv,
    },
    stdio: ["ignore", "ignore", options.log === true ? "inherit" : "ignore"],
    windowsHide: true,
  });
  const initPid = initProcess.pid;
  if (initPid === undefined) throw new Error("the init did not start");

  const control = async (method: string, pathname: string, body?: unknown): Promise<{ readonly status: number; readonly body: unknown }> => {
    const response = await fetch(`http://127.0.0.1:${String(controlPort)}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  };

  const statusSchema = z.record(z.string(), z.unknown());
  const waitFor = async (predicate: (status: Record<string, unknown>) => boolean, timeoutMs = 60_000): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const { body } = await control("GET", "/status");
        const parsed = statusSchema.parse(body);
        if (predicate(parsed)) return parsed;
        if (parsed["phase"] === "failed") throw new Error(`box failed: ${String(parsed["failure"])}`);
      } catch (error) {
        if (Date.now() > deadline) throw error instanceof Error ? error : new Error("waitFor failed");
      }
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await control("POST", "/stop").catch(() => undefined);
    await Promise.race([sidecarDone, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    // The whole tree: on Windows a single-PID kill would leave the init's
    // children (opencode) running.
    if (initProcess.exitCode === null) await killTree(initPid);
    await rm(taskRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
      process.stderr.write(`${JSON.stringify({ component: "box-fixture", event: "cleanup_failed", boxId })}\n`);
    });
  };

  return {
    boxId,
    controlAddr: `127.0.0.1:${String(controlPort)}`,
    handoffAddr: `127.0.0.1:${String(handoffPort)}`,
    bridgeAddr: `127.0.0.1:${String(bridgePort)}`,
    controlToken,
    modelMarker,
    gitMarker,
    taskRoot,
    initPid,
    startedAt,
    sidecarDone,
    control,
    waitFor,
    dispose,
  };
};

const waitForPort = async (port: number, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`port ${String(port)} did not open`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};
