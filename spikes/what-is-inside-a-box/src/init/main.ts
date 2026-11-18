// The box's init program: the "small init program" of the base image (ADR
// 0046), in the agent's container. `tini` is PID 1 and reaps zombies; this
// program runs under it, as root, with only the capabilities it needs to
// start processes as the agent's user and kill them (SETUID, SETGID, KILL).
//
// It holds no credential. Its one secret is the box's bridge nonce, in its own
// environment, which the agent's user can't read (/proc/1/environ and this
// process's are root's). It connects out to the sidecar once, then does what
// the sidecar asks: prepare the task's directories, spawn `opencode acp` as
// the agent's user, carry its stdio, list and kill the agent's processes.
//
// It never listens on a port. Every command arrives over the one connection
// it opened itself.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { connect, type Socket } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "../bridge/framing.ts";
import { BRIDGE_VERSION, BoxIdSchema, CHUNK_BYTES, sidecarFrameSchema, type InitFrame, type ProcId, type SidecarFrame } from "../bridge/protocol.ts";
import { descendantsOf, isAlive, killTree, listProcesses, type ProcessInfo } from "../lib/process-tree.ts";

const envSchema = z.object({
  OSTRA_BOX_ID: BoxIdSchema,
  OSTRA_BRIDGE_NONCE: z.string().min(32).max(128),
  /** host:port of the sidecar's bridge, e.g. `sidecar:7101` on Docker, `127.0.0.1:7101` in a pod. */
  OSTRA_BRIDGE_ADDR: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/),
  OSTRA_AGENT_UID: z.coerce.number().int().nonnegative().default(1000),
  OSTRA_AGENT_GID: z.coerce.number().int().nonnegative().default(1000),
  /** How long to keep retrying the first connection. */
  OSTRA_BRIDGE_CONNECT_MS: z.coerce.number().int().positive().default(60_000),
});

const log = (line: Readonly<Record<string, string | number | boolean | null>>): void => {
  // IDs and counts only.
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: "box-init", ...line })}\n`);
};

const env = envSchema.parse(process.env);
const [bridgeHost = "", bridgePortText = "0"] = env.OSTRA_BRIDGE_ADDR.split(":");
const bridgePort = Number(bridgePortText);

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
/** Drop to the agent's user only when we are root (in a box). The loopback rehearsal runs as the developer. */
const asAgent = isRoot ? { uid: env.OSTRA_AGENT_UID, gid: env.OSTRA_AGENT_GID } : {};
const agentUid = isRoot ? env.OSTRA_AGENT_UID : (process.getuid?.() ?? 0);

const connectOnce = async (): Promise<Socket> =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: bridgeHost, port: bridgePort });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });

const connectWithRetry = async (): Promise<Socket> => {
  const deadline = Date.now() + env.OSTRA_BRIDGE_CONNECT_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connectOnce();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(Math.min(50 * attempt, 500));
    }
  }
};

// The prepare step runs as the agent's user, in a child, so the init's root
// powers never touch a path the agent controls (no symlink tricks).
const PREPARE_SCRIPT = `
const fs = require("node:fs/promises");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  const job = JSON.parse(input);
  for (const dir of job.dirs) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const file of job.files) await fs.writeFile(file.path, Buffer.from(file.content, "base64"), { mode: file.mode, flag: "w" });
});
`;

const runPrepare = async (dirs: readonly string[], files: readonly { path: string; content: string; mode: number }[]): Promise<string | undefined> => {
  const child = spawn(process.execPath, ["-e", PREPARE_SCRIPT], { ...asAgent, stdio: ["pipe", "ignore", "pipe"], env: { PATH: process.env["PATH"] ?? "" }, windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });
  child.stdin.end(JSON.stringify({ dirs, files }));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return code === 0 ? undefined : `prepare exited ${String(code)}: ${stderr.split("\n")[0] ?? ""}`;
};

/** PIDs of every process whose real UID is the agent's (Linux only: it reads /proc). */
const agentUidPids = async (): Promise<number[]> => {
  const out: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, "utf8");
      const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (uid !== undefined && Number(uid) === env.OSTRA_AGENT_UID) out.push(Number(entry));
    } catch {
      // Gone while we looked.
    }
  }
  return out;
};

/**
 * The agent's processes still alive. Linux: every process of the agent's UID
 * (orphans included, whatever their parent). Elsewhere (the loopback
 * rehearsal, where the agent runs as the developer and UIDs can't tell it
 * apart): every live descendant of this init. The listing tool itself is a
 * child while it runs, so only processes still alive after the listing count.
 */
const survivors = async (): Promise<ProcessInfo[]> => {
  const all = await listProcesses();
  if (process.platform === "linux") {
    const pids = new Set(await agentUidPids());
    return all.filter((p) => pids.has(p.pid));
  }
  return descendantsOf(process.pid, all).filter((p) => isAlive(p.pid));
};

const main = async (): Promise<void> => {
  const socket = await connectWithRetry();
  const send = (frame: InitFrame): boolean => socket.write(encodeFrame(frame));
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
          socket.once("drain", () => stream.resume());
        }
      }
    });
    stream.once("end", () => send({ t: "eof", procId, stream: name }));
  };

  const handle = async (frame: SidecarFrame): Promise<void> => {
    switch (frame.t) {
      case "welcome":
        welcomed = true;
        log({ event: "bridge_welcomed", boxId: env.OSTRA_BOX_ID });
        return;
      case "prepare": {
        const error = await runPrepare(frame.dirs, frame.files);
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
          send({ t: "spawn_failed", reqId: frame.reqId, procId: frame.procId, message: error.message });
          return;
        }
        children.set(frame.procId, child);
        child.stdin.on("error", () => {
          // EPIPE after the agent died: reported through its exit.
        });
        pumpOut(frame.procId, child.stdout, "stdout");
        pumpOut(frame.procId, child.stderr, "stderr");
        child.once("exit", (code, signal) => {
          children.delete(frame.procId);
          send({ t: "exit", procId: frame.procId, code, signal });
          log({ event: "agent_exit", boxId: env.OSTRA_BOX_ID, procId: frame.procId, code, signal });
        });
        send({ t: "spawned", reqId: frame.reqId, procId: frame.procId, pid });
        log({ event: "agent_spawned", boxId: env.OSTRA_BOX_ID, procId: frame.procId, pid });
        return;
      }
      case "in":
        children.get(frame.procId)?.stdin.write(Buffer.from(frame.data, "base64"));
        return;
      case "in_end":
        children.get(frame.procId)?.stdin.end();
        return;
      case "ps":
        send({ t: "ps_result", reqId: frame.reqId, processes: await listProcesses() });
        return;
      case "kill_tree":
        await killTree(frame.pid);
        send({ t: "done", reqId: frame.reqId });
        return;
      case "kill_one":
        try {
          process.kill(frame.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        send({ t: "done", reqId: frame.reqId });
        return;
      case "reap_all": {
        for (const child of children.values()) if (child.pid !== undefined) await killTree(child.pid);
        for (let round = 0; round < 10; round += 1) {
          const alive = await survivors();
          if (alive.length === 0) break;
          for (const p of alive) await killTree(p.pid);
          await sleep(100);
        }
        // What is still alive after the kills: the leftover the sidecar reports.
        send({ t: "ps_result", reqId: frame.reqId, processes: await survivors() });
        return;
      }
      default:
        frame satisfies never;
    }
  };

  const splitter = createLineSplitter();
  let queue = Promise.resolve();
  socket.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = splitter.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of lines) {
      const parsed = parseFrame(sidecarFrameSchema, line);
      if (!parsed.ok) {
        log({ event: "bridge_bad_frame", boxId: env.OSTRA_BOX_ID, reason: parsed.reason });
        socket.destroy();
        return;
      }
      if (!welcomed && parsed.frame.t !== "welcome") {
        socket.destroy();
        return;
      }
      // Stdio frames keep their order; control frames are handled in order too.
      queue = queue.then(async () => handle(parsed.frame)).catch((error: unknown) => {
        log({ event: "init_error", boxId: env.OSTRA_BOX_ID, message: error instanceof Error ? error.name : "error" });
      });
    }
  });

  await new Promise<void>((resolve) => socket.once("close", () => {
    resolve();
  }));
  log({ event: "bridge_lost", boxId: env.OSTRA_BOX_ID, children: children.size });
  // Without the sidecar nothing may keep running: the box is being torn down.
  for (const child of children.values()) if (child.pid !== undefined) await killTree(child.pid);
};

await main();
