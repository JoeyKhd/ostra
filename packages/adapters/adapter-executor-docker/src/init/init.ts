import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { descendantsOf, isAlive, killTree, listProcesses } from "@ostra/adapter-sdk";
import type { ProcessInfo } from "@ostra/adapter-sdk";
import { z } from "zod";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "../bridge/framing.ts";
import { BRIDGE_VERSION, bridgeBoxIdSchema, CHUNK_BYTES, sidecarFrameSchema } from "../bridge/protocol.ts";
import type { InitFrame, PrepareJob, ProcId, SidecarFrame } from "../bridge/protocol.ts";
import { PREPARE_FAILURE_PREFIX } from "./prepare.ts";

// The box's init program (ADR 0046's "small init" of the base image), in the agent's container.
// `tini` is PID 1 and reaps zombies; this runs under it, as root, with only the capabilities it
// needs to start processes as the agent's user and kill them (SETUID, SETGID, KILL).
//
// It holds no credential. Its one secret is the box's bridge nonce, in its own environment, which
// the agent's user can't read. It connects out to the sidecar once, then does what the sidecar
// asks. It never listens on a port.
//
// Ported from spikes/what-is-inside-a-box/src/init/main.ts.

export const initEnvSchema = z.object({
  OSTRA_BOX_ID: bridgeBoxIdSchema,
  OSTRA_BRIDGE_NONCE: z.string().min(32).max(128),
  /** host:port of the sidecar's bridge: `sidecar:7101` on the box network. */
  OSTRA_BRIDGE_ADDR: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/),
  OSTRA_AGENT_UID: z.coerce.number().int().nonnegative().default(1000),
  OSTRA_AGENT_GID: z.coerce.number().int().nonnegative().default(1000),
  /** How long to keep retrying the first connection. */
  OSTRA_BRIDGE_CONNECT_MS: z.coerce.number().int().positive().default(60_000),
});
export type InitEnv = z.infer<typeof initEnvSchema>;

const log = (line: Readonly<Record<string, string | number | boolean | null>>): void => {
  // IDs and counts only.
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: "box-init", ...line })}\n`);
};

// The prepare step (`prepare-main.ts`) runs as the agent's user, in a child, so the init's root
// powers never touch a path the agent controls (no symlink tricks).
const PREPARE_MAIN = fileURLToPath(new URL("./prepare-main.ts", import.meta.url));

export const runInit = async (env: InitEnv): Promise<void> => {
  const [bridgeHost = "", bridgePortText = "0"] = env.OSTRA_BRIDGE_ADDR.split(":");
  const bridgePort = Number(bridgePortText);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  // Drop to the agent's user only as root (in a box); a test runs the init as the developer.
  const asAgent = isRoot ? { uid: env.OSTRA_AGENT_UID, gid: env.OSTRA_AGENT_GID } : {};
  const agentUid = isRoot ? env.OSTRA_AGENT_UID : (process.getuid?.() ?? 0);

  const connectOnce = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: bridgeHost, port: bridgePort });
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });
  const deadline = Date.now() + env.OSTRA_BRIDGE_CONNECT_MS;
  let socket: Socket | undefined;
  for (let attempt = 1; socket === undefined; attempt += 1) {
    try {
      socket = await connectOnce();
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await sleep(Math.min(50 * attempt, 500));
    }
  }
  const bridge = socket;
  const send = (frame: InitFrame): boolean => bridge.write(encodeFrame(frame));

  const runPrepare = async (job: PrepareJob): Promise<string | undefined> => {
    const child = spawn(process.execPath, [PREPARE_MAIN], { ...asAgent, stdio: ["pipe", "ignore", "pipe"], env: { PATH: process.env["PATH"] ?? "" }, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.stdin.end(JSON.stringify(job));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    if (code === 0) {
      return undefined;
    }
    // The child's one prefixed line names the bad field or the file system's code, never content.
    const reason = stderr.split("\n").findLast((line) => line.startsWith(PREPARE_FAILURE_PREFIX));
    return reason ?? `prepare exited ${String(code)}`;
  };

  /** PIDs of every process whose real UID is the agent's (Linux: it reads /proc). */
  const agentUidPids = async (): Promise<number[]> => {
    const out: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const status = await readFile(`/proc/${entry}/status`, "utf8");
        const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
        if (uid !== undefined && Number(uid) === env.OSTRA_AGENT_UID) {
          out.push(Number(entry));
        }
      } catch {
        // Gone while we looked.
      }
    }
    return out;
  };

  /**
   * The agent's processes still alive. In a box: every process of the agent's UID, orphans
   * included. Elsewhere (a test, where UIDs can't tell the agent apart): every live descendant.
   */
  const survivors = async (): Promise<ProcessInfo[]> => {
    const all = await listProcesses();
    if (process.platform === "linux" && isRoot) {
      const pids = new Set(await agentUidPids());
      return all.filter((item) => pids.has(item.pid));
    }
    return descendantsOf(process.pid, all).filter((item) => isAlive(item.pid));
  };

  send({ t: "hello", version: BRIDGE_VERSION, boxId: env.OSTRA_BOX_ID, nonce: env.OSTRA_BRIDGE_NONCE, initPid: process.pid, agentUid, platform });
  log({ event: "bridge_hello_sent", boxId: env.OSTRA_BOX_ID });

  const children = new Map<ProcId, ChildProcessByStdio<Writable, Readable, Readable>>();
  let welcomed = false;

  const pumpOut = (procId: ProcId, stream: Readable, name: "stdout" | "stderr"): void => {
    stream.on("data", (chunk: Buffer) => {
      for (const data of toBase64Chunks(chunk, CHUNK_BYTES)) {
        // Backpressure: pause the agent's pipe until the bridge drains.
        if (!send({ t: "out", procId, stream: name, data })) {
          stream.pause();
          bridge.once("drain", () => stream.resume());
        }
      }
    });
    stream.once("end", () => send({ t: "eof", procId, stream: name }));
  };

  const handle = async (frame: SidecarFrame): Promise<void> => {
    switch (frame.t) {
      case "welcome":
        // Marked as it arrives, below: the next frame may be in the same chunk.
        return;
      case "prepare": {
        const error = await runPrepare({ dirs: frame.dirs, files: frame.files });
        send(error === undefined ? { t: "prepared", reqId: frame.reqId } : { t: "prepared", reqId: frame.reqId, error });
        return;
      }
      case "spawn": {
        const child = spawn(frame.command, frame.args, {
          ...asAgent,
          cwd: frame.cwd,
          // Exactly what the sidecar built; nothing of the init's own environment.
          env: frame.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        const pid = child.pid;
        if (pid === undefined) {
          const error = await new Promise<Error>((resolve) => child.once("error", resolve));
          send({ t: "spawn_failed", reqId: frame.reqId, procId: frame.procId, message: error.name });
          return;
        }
        children.set(frame.procId, child);
        child.stdin.on("error", () => {
          // EPIPE after the process died: reported through its exit.
        });
        pumpOut(frame.procId, child.stdout, "stdout");
        pumpOut(frame.procId, child.stderr, "stderr");
        child.once("exit", (code, signal) => {
          children.delete(frame.procId);
          send({ t: "exit", procId: frame.procId, code, signal });
        });
        send({ t: "spawned", reqId: frame.reqId, procId: frame.procId, pid });
        return;
      }
      case "in":
        children.get(frame.procId)?.stdin.write(Buffer.from(frame.data, "base64"));
        return;
      case "in_end":
        children.get(frame.procId)?.stdin.end();
        return;
      case "ps":
        send({ t: "ps_result", reqId: frame.reqId, processes: (await listProcesses()).map(({ pid, ppid, name, startedAt }) => ({ pid, ppid, name, startedAt })) });
        return;
      case "kill_tree":
        await killTree(frame.pid);
        send({ t: "done", reqId: frame.reqId });
        return;
      case "reap_all": {
        for (const child of children.values()) {
          if (child.pid !== undefined) {
            await killTree(child.pid);
          }
        }
        for (let round = 0; round < 10; round += 1) {
          const alive = await survivors();
          if (alive.length === 0) {
            break;
          }
          for (const item of alive) {
            await killTree(item.pid);
          }
          await sleep(100);
        }
        const left = await survivors();
        send({ t: "ps_result", reqId: frame.reqId, processes: left.map(({ pid, ppid, name, startedAt }) => ({ pid, ppid, name, startedAt })) });
        return;
      }
      default:
        frame satisfies never;
    }
  };

  const splitter = createLineSplitter();
  let queue = Promise.resolve();
  bridge.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = splitter.push(chunk);
    } catch {
      bridge.destroy();
      return;
    }
    for (const line of lines) {
      const parsed = parseFrame(sidecarFrameSchema, line);
      if (!parsed.ok || (!welcomed && parsed.frame.t !== "welcome")) {
        log({ event: "bridge_bad_frame", boxId: env.OSTRA_BOX_ID });
        bridge.destroy();
        return;
      }
      const frame = parsed.frame;
      // At once, not in the queue: a request sent right after the welcome can arrive with it.
      if (frame.t === "welcome") {
        welcomed = true;
      }
      // Stdio and control frames are handled in order.
      queue = queue
        .then(() => handle(frame))
        .catch((error: unknown) => {
          log({ event: "init_error", boxId: env.OSTRA_BOX_ID, error: error instanceof Error ? error.name : "error" });
        });
    }
  });

  await new Promise<void>((resolve) => {
    bridge.once("close", () => {
      resolve();
    });
  });
  log({ event: "bridge_lost", boxId: env.OSTRA_BOX_ID, children: children.size });
  // Without the sidecar nothing may keep running: the box is being torn down.
  for (const child of children.values()) {
    if (child.pid !== undefined) {
      await killTree(child.pid);
    }
  }
};
