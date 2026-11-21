import { spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BOX_BROWSER_PROFILE_PREFIX, boxBrowserFlags, descendantsOf, dialApp, isAlive, killTree, listProcesses, spliceStreams } from "@ostra/adapter-sdk";
import type { ProcessInfo } from "@ostra/adapter-sdk";
import { runnerLimits } from "@ostra/protocol";
import { z } from "zod";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "../bridge/framing.ts";
import { BRIDGE_FEATURES, BRIDGE_VERSION, bridgeBoxIdSchema, bridgeFeatureSchema, CHUNK_BYTES, sidecarFrameSchema } from "../bridge/protocol.ts";
import type { BrowserId, ForwardId, InitFrame, PrepareJob, ProcId, SidecarFrame } from "../bridge/protocol.ts";
import { PREPARE_FAILURE_PREFIX } from "./prepare.ts";

// The box's init program (ADR 0046's "small init" of the base image), in the agent's container.
// `tini` is PID 1 and reaps zombies; this runs under it, as root, with only the capabilities it
// needs to start processes as the agent's user and kill them (SETUID, SETGID, KILL).
//
// It holds no credential. Its one secret is the box's bridge nonce, in its own environment, which
// the agent's user can't read. It connects out to the sidecar once, then does what the sidecar
// asks. It never listens on a port, except a forwarder the sidecar opens (milestone 8), which takes
// connections from the sidecar's address only.
//
// Milestone 8 (ADR 0068): the app's processes (`app_spawn`, `app_stop`), the image's browser with
// its DevTools pipe on a channel of its own (`browser_*`: its bytes are handled as they come, never
// in the queue behind a control frame), and the forwarder (`forward_*`), each only when the
// sidecar named its feature in `OSTRA_BRIDGE_FEATURES`.
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
  /**
   * Milestone 8: the features the sidecar reads (`bridgeFeatureSchema`), comma-separated, which the
   * pool runner sets. The hello lists those this init has too; unset, it lists none, as an older
   * sidecar's hello schema wants.
   */
  OSTRA_BRIDGE_FEATURES: z
    .string()
    .default("")
    .transform((text) => text.split(",").map((each) => each.trim()).filter((each) => each !== ""))
    .pipe(z.array(z.string())),
  /** Milestone 8 (ADR 0068): the image's browser. Ticket 11 puts Debian's Chromium there; an image without one has no browser. */
  OSTRA_BOX_BROWSER: z.string().min(1).default("/usr/bin/chromium"),
});
export type InitEnv = z.infer<typeof initEnvSchema>;

/** Milestone 8: what a test gives the init instead of the image's (the fake browser over the same pipe). */
export type InitOptions = { readonly browser?: { readonly command: string; readonly args: readonly string[] } };

/** The address the sidecar connects from, as a socket names it, with an IPv4-mapped prefix taken off. */
const plainAddress = (address: string | undefined): string => (address ?? "").replace(/^::ffff:/, "");

/** Removes a browser's profile as the agent's user, who made it and owns what's in it, retrying while its helpers let go. */
const REMOVE_SCRIPT = "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 50, retryDelay: 300 })";

const log = (line: Readonly<Record<string, string | number | boolean | null>>): void => {
  // IDs and counts only.
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: "box-init", ...line })}\n`);
};

// The prepare step (`prepare-main.ts`) runs as the agent's user, in a child, so the init's root
// powers never touch a path the agent controls (no symlink tricks).
const PREPARE_MAIN = fileURLToPath(new URL("./prepare-main.ts", import.meta.url));

export const runInit = async (env: InitEnv, options: InitOptions = {}): Promise<void> => {
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
  // Nothing goes out once the bridge is gone (a browser's last bytes, its `browser_gone`).
  const send = (frame: InitFrame): boolean => !bridge.destroyed && bridge.write(encodeFrame(frame));

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

  // Milestone 8: the features this init has that its sidecar reads, and none for an older sidecar.
  const features = BRIDGE_FEATURES.filter((feature) => env.OSTRA_BRIDGE_FEATURES.includes(feature));
  send({
    t: "hello",
    version: BRIDGE_VERSION,
    boxId: env.OSTRA_BOX_ID,
    nonce: env.OSTRA_BRIDGE_NONCE,
    initPid: process.pid,
    agentUid,
    platform,
    ...(features.length === 0 ? {} : { features: features.map((feature) => bridgeFeatureSchema.parse(feature)) }),
  });
  log({ event: "bridge_hello_sent", boxId: env.OSTRA_BOX_ID, features: features.join(",") });

  const children = new Map<ProcId, ChildProcessByStdio<Writable, Readable, Readable>>();
  // Milestone 8: the app's processes (no stdin), the browsers and the forwarders.
  const apps = new Map<ProcId, ChildProcess>();
  const browsers = new Map<BrowserId, { readonly child: ChildProcess; readonly gone: Promise<void> }>();
  const forwards = new Map<ForwardId, { readonly server: Server; readonly sockets: Set<Socket> }>();
  let welcomed = false;

  /** Every process this init started and still holds, for a reap and the bridge's loss. */
  const heldPids = (): number[] =>
    [...children.values(), ...apps.values(), ...[...browsers.values()].map((browser) => browser.child)].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));

  const removeAsAgent = async (dir: string): Promise<void> => {
    const child = spawn(process.execPath, ["-e", REMOVE_SCRIPT, dir], { ...asAgent, stdio: "ignore", env: { PATH: process.env["PATH"] ?? "" }, windowsHide: true });
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
      child.once("error", () => {
        resolve();
      });
    });
  };

  /** A spawned child's start: its PID, or that it never started. */
  const started = (child: ChildProcess): Promise<number | null> =>
    new Promise((resolve) => {
      child.once("spawn", () => {
        resolve(child.pid ?? null);
      });
      child.once("error", () => {
        resolve(null);
      });
    });

  const startBrowser = async (browserId: BrowserId, reqId: Extract<SidecarFrame, { t: "browser_start" }>["reqId"]): Promise<void> => {
    const program = options.browser ?? { command: env.OSTRA_BOX_BROWSER, args: [] };
    const there = await access(program.command).then(
      () => true,
      () => false,
    );
    if (!there) {
      send({ t: "browser_unavailable", reqId, browserId, reason: "not-in-image" });
      return;
    }
    // A fresh profile in a temporary folder, made as the agent's user, who runs the browser (ADR 0068).
    const profileDir = path.join(tmpdir(), `${BOX_BROWSER_PROFILE_PREFIX}${randomBytes(8).toString("hex")}`);
    if ((await runPrepare({ dirs: [profileDir], files: [] })) !== undefined) {
      send({ t: "browser_unavailable", reqId, browserId, reason: "failed-to-start" });
      return;
    }
    const browserEnv: Record<string, string> = {};
    for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"]) {
      const value = process.env[name];
      if (value !== undefined) browserEnv[name] = value;
    }
    if (process.platform !== "win32") browserEnv["HOME"] = profileDir;
    const child = spawn(program.command, [...program.args, ...boxBrowserFlags(profileDir)], {
      ...asAgent,
      env: browserEnv,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    const pid = await started(child);
    const toBrowser = child.stdio[3];
    const fromBrowser = child.stdio[4];
    if (pid === null || !(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
      if (pid !== null) await killTree(pid);
      await removeAsAgent(profileDir);
      send({ t: "browser_unavailable", reqId, browserId, reason: "failed-to-start" });
      return;
    }
    toBrowser.on("error", () => {
      // EPIPE once the browser is gone: reported through `browser_gone`.
    });
    fromBrowser.on("data", (chunk: Buffer) => {
      for (const data of toBase64Chunks(chunk, CHUNK_BYTES)) {
        send({ t: "browser_out", browserId, data });
      }
    });
    // However it ends, its profile goes, and then the sidecar hears it's gone.
    const gone = exited.then(async () => {
      await removeAsAgent(profileDir);
      browsers.delete(browserId);
      send({ t: "browser_gone", browserId });
    });
    browsers.set(browserId, { child, gone });
    send({ t: "browser_started", reqId, browserId, pid, program: path.basename(program.command).slice(0, 200), profileDir });
    log({ event: "browser_started", boxId: env.OSTRA_BOX_ID, browserId, pid });
  };

  const openForward = async (frame: Extract<SidecarFrame, { t: "forward_open" }>): Promise<void> => {
    if (frame.port < runnerLimits.appPortMin) {
      send({ t: "error", reqId: frame.reqId, message: `port ${String(frame.port)} isn't an app's` });
      return;
    }
    // Only the sidecar may connect: the address the bridge came from, on the box network.
    const sidecar = plainAddress(bridge.remoteAddress);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      if (plainAddress(socket.remoteAddress) !== sidecar) {
        log({ event: "forward_refused", boxId: env.OSTRA_BOX_ID, forwardId: frame.forwardId });
        socket.destroy();
        return;
      }
      // `localhost` over IPv6 and IPv4: a dev server told `localhost` may listen on `::1` only (spike 08).
      const app = dialApp("localhost", frame.port);
      sockets.add(socket).add(app);
      socket.once("close", () => sockets.delete(socket));
      app.once("close", () => sockets.delete(app));
      spliceStreams(socket, app);
    });
    const listenOn = plainAddress(bridge.localAddress);
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => {
        resolve(false);
      });
      server.listen(0, listenOn, () => {
        resolve(true);
      });
    });
    const address: AddressInfo | string | null = server.address();
    if (!listening || address === null || typeof address === "string") {
      server.close();
      send({ t: "error", reqId: frame.reqId, message: "the forwarder couldn't listen" });
      return;
    }
    forwards.set(frame.forwardId, { server, sockets });
    send({ t: "forward_opened", reqId: frame.reqId, forwardId: frame.forwardId, host: listenOn, port: address.port });
  };

  const closeForward = (forwardId: ForwardId): Promise<void> =>
    new Promise((resolve) => {
      const forward = forwards.get(forwardId);
      forwards.delete(forwardId);
      if (forward === undefined) {
        resolve();
        return;
      }
      forward.server.close(() => {
        resolve();
      });
      // A forwarder's live connections end with it.
      for (const socket of forward.sockets) socket.destroy();
    });

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
        // The agent's, the app's processes and the browsers: each browser's profile goes as it exits.
        for (const pid of heldPids()) {
          await killTree(pid);
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
      // ---- milestone 8 ----
      case "app_spawn": {
        const child = spawn(frame.command, frame.args, {
          ...asAgent,
          cwd: frame.cwd,
          // Exactly what the sidecar built; nothing of the init's own environment.
          env: frame.env,
          stdio: ["ignore", "pipe", "pipe"],
          // A group of its own, so `app_stop`'s signal reaches the dev server's children too.
          detached: process.platform !== "win32",
          windowsHide: true,
        });
        const pid = await started(child);
        const { stdout, stderr } = child;
        if (pid === null) {
          send({ t: "spawn_failed", reqId: frame.reqId, procId: frame.procId, message: "the process didn't start" });
          return;
        }
        apps.set(frame.procId, child);
        pumpOut(frame.procId, stdout, "stdout");
        pumpOut(frame.procId, stderr, "stderr");
        child.once("exit", (code, signal) => {
          apps.delete(frame.procId);
          send({ t: "exit", procId: frame.procId, code, signal });
        });
        send({ t: "spawned", reqId: frame.reqId, procId: frame.procId, pid });
        return;
      }
      case "app_stop": {
        const child = apps.get(frame.procId);
        if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => {
            child.once("exit", () => {
              resolve();
            });
          });
          if (process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              // Gone already.
            }
          }
          const quit = await Promise.race([exited.then(() => true), sleep(process.platform === "win32" ? 0 : frame.graceMs).then(() => false)]);
          if (!quit) {
            await killTree(child.pid);
            await exited;
          }
        }
        send({ t: "done", reqId: frame.reqId });
        return;
      }
      case "browser_start":
        await startBrowser(frame.browserId, frame.reqId);
        return;
      case "browser_in": {
        const pipe = browsers.get(frame.browserId)?.child.stdio[3];
        if (pipe instanceof Writable && !pipe.destroyed) pipe.write(Buffer.from(frame.data, "base64"));
        return;
      }
      case "browser_kill": {
        const browser = browsers.get(frame.browserId);
        if (browser?.child.pid !== undefined) {
          await killTree(browser.child.pid);
          await browser.gone;
        }
        send({ t: "done", reqId: frame.reqId });
        return;
      }
      case "forward_open":
        await openForward(frame);
        return;
      case "forward_close":
        await closeForward(frame.forwardId);
        send({ t: "done", reqId: frame.reqId });
        return;
      default:
        frame satisfies never;
    }
  };

  /** Frames of their own channel: handled as they come, never in the queue behind a control frame (ADR 0068). */
  const ownChannel = new Set<SidecarFrame["t"]>(["app_spawn", "app_stop", "browser_start", "browser_in", "browser_kill", "forward_open", "forward_close"]);

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
      if (ownChannel.has(frame.t)) {
        void handle(frame).catch((error: unknown) => {
          log({ event: "init_error", boxId: env.OSTRA_BOX_ID, error: error instanceof Error ? error.name : "error" });
        });
        continue;
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
  for (const forwardId of [...forwards.keys()]) {
    await closeForward(forwardId);
  }
  const gone = [...browsers.values()].map((browser) => browser.gone);
  for (const pid of heldPids()) {
    await killTree(pid);
  }
  // The browsers' profiles go before the init does.
  await Promise.all(gone);
};
