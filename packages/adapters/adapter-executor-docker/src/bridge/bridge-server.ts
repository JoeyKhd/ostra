import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import type { BrowserProcessEnds, Logger, ProcessExit } from "@ostra/adapter-sdk";
import type { BoxId } from "@ostra/protocol";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "./framing.ts";
import { BRIDGE_VERSION, browserIdSchema, CHUNK_BYTES, forwardIdSchema, initFrameSchema, procIdSchema, REQUEST_DEADLINE_MS, reqIdSchema } from "./protocol.ts";
import type { BridgeFeature, BridgeProcess, BrowserId, InitFrame, ProcId, ReqId, SidecarFrame } from "./protocol.ts";

/** Milestone 8 (F-140): one of the app's processes in the agent's container, through the init. */
export type BridgedApp = {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ProcessExit>;
  /** The init's polite signal to its group, then the tree after `graceMs`; resolves once it exited. */
  readonly stop: (graceMs: number) => Promise<void>;
};

/** Milestone 8 (F-121): the image's browser in the agent's container, or why there's none. */
export type BridgedBrowser =
  | { readonly available: true; readonly pid: number; readonly program: string; readonly profileDir: string; readonly ends: BrowserProcessEnds }
  | { readonly available: false; readonly reason: "not-in-image" | "failed-to-start" };

/** Milestone 8 (F-143): the init's forwarder, on the box network, for the sidecar's address only. */
export type BridgedForward = { readonly host: string; readonly port: number; readonly close: () => Promise<void> };

// The sidecar's end of the bridge. It listens once, accepts the first connection that presents the
// box's nonce, and then stops listening: the port is closed before any agent code runs, so a
// process the agent starts later finds nothing to connect to. The accepted connection spawns,
// reads, writes and kills in the agent's container, as a local child would.
//
// Ported from spikes/what-is-inside-a-box/src/bridge/bridge-server.ts, with a deadline on every
// request (the spike's recommendation 9).

export type BridgeLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The whole environment. Nothing of the init's own is inherited. */
  readonly env: Readonly<Record<string, string>>;
};

export type BridgedProcess = {
  /** The PID in the agent container's PID namespace. */
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<ProcessExit>;
};

export type PreparedFile = { readonly path: string; readonly content: Buffer; readonly mode: number };

export type Bridge = {
  readonly initPid: number;
  readonly agentUid: number;
  readonly platform: "linux" | "darwin" | "win32";
  readonly spawn: (launch: BridgeLaunch) => Promise<BridgedProcess>;
  /** Makes folders and writes files in the agent's container, as the agent's user. */
  readonly prepare: (dirs: readonly string[], files: readonly PreparedFile[]) => Promise<void>;
  readonly listProcesses: () => Promise<readonly BridgeProcess[]>;
  readonly killTree: (pid: number) => Promise<void>;
  /** Kills every process of the agent's user; returns what was still alive after (should be none). */
  readonly reapAll: () => Promise<readonly BridgeProcess[]>;
  readonly closed: Promise<void>;
  readonly close: () => void;
  // ---- milestone 8 (ADR 0068): each needs its feature in `features`, or it's refused before a frame is sent ----
  /** What the init does beyond milestone 5's frames, as its hello said. */
  readonly features: readonly BridgeFeature[];
  readonly spawnApp: (launch: BridgeLaunch) => Promise<BridgedApp>;
  readonly startBrowser: () => Promise<BridgedBrowser>;
  readonly openForward: (port: number) => Promise<BridgedForward>;
};

/** Why a box's init can't do what milestone 8 asks: it's older than its sidecar. */
export const initTooOld = (feature: BridgeFeature): Error =>
  new Error(`the box's init is older than its runner and has no ${feature}: rebuild the environment's snapshot from the current base image`);

export type BridgeListener = {
  readonly port: number;
  /** Resolves with the one accepted connection. */
  readonly connected: Promise<Bridge>;
  readonly listening: () => boolean;
  /** Connections refused so far: a wrong nonce, a bad hello, or one after the accept. */
  readonly refused: () => number;
  readonly close: () => Promise<void>;
};

export type BridgeListenOptions = {
  readonly boxId: BoxId;
  readonly nonce: string;
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
  readonly helloTimeoutMs?: number;
  readonly requestDeadlineMs?: number;
};

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

type Context = {
  readonly initPid: number;
  readonly agentUid: number;
  readonly platform: "linux" | "darwin" | "win32";
  readonly features: readonly BridgeFeature[];
  readonly rest: readonly string[];
  readonly logger: Logger;
  readonly deadlineMs: number;
};

type RemoteProc = {
  readonly stdout: Readable;
  readonly stderr: Readable;
  status: ProcessExit | undefined;
  readonly resolveExit: (exit: ProcessExit) => void;
};

type Pending = { readonly resolve: (frame: InitFrame) => void; readonly reject: (error: Error) => void };

/** A browser the init started: who hears its pipe, and its end (exited, profile removed). */
type RemoteBrowser = { readonly listeners: Set<(bytes: Buffer) => void>; readonly resolveGone: () => void; readonly gone: Promise<void> };

const bridgeOverSocket = (socket: Socket, context: Context): Bridge => {
  const splitter = createLineSplitter();
  const pending = new Map<ReqId, Pending>();
  const procs = new Map<ProcId, RemoteProc>();
  const browsers = new Map<BrowserId, RemoteBrowser>();
  let nextReq = 1;
  let nextProc = 1;
  let nextBrowser = 1;
  let nextForward = 1;
  let isClosed = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const send = (frame: SidecarFrame, callback?: (error?: Error | null) => void): void => {
    if (isClosed) {
      callback?.(new Error("the bridge is closed"));
      return;
    }
    socket.write(encodeFrame(frame), callback);
  };

  const request = (build: (reqId: ReqId) => SidecarFrame): Promise<InitFrame> => {
    const reqId = reqIdSchema.parse(nextReq);
    nextReq += 1;
    return new Promise<InitFrame>((resolve, reject) => {
      if (isClosed) {
        reject(new Error("the bridge is closed"));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error("the box's init didn't answer in time"));
      }, context.deadlineMs);
      timer.unref();
      pending.set(reqId, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send(build(reqId));
    });
  };

  const settle = (reqId: ReqId, frame: InitFrame): void => {
    const waiter = pending.get(reqId);
    if (waiter !== undefined) {
      pending.delete(reqId);
      waiter.resolve(frame);
    }
  };

  const onFrame = (frame: InitFrame): void => {
    switch (frame.t) {
      case "hello":
        // Only the first frame may be a hello.
        socket.destroy();
        return;
      case "prepared":
      case "spawned":
      case "spawn_failed":
      case "ps_result":
      case "done":
      case "error":
      case "browser_started":
      case "browser_unavailable":
      case "forward_opened":
        settle(frame.reqId, frame);
        return;
      case "browser_out": {
        // The pipe's own channel: handed on at once, never held behind a request's answer.
        const bytes = Buffer.from(frame.data, "base64");
        for (const listener of browsers.get(frame.browserId)?.listeners ?? []) {
          listener(bytes);
        }
        return;
      }
      case "browser_gone":
        browsers.get(frame.browserId)?.resolveGone();
        browsers.delete(frame.browserId);
        return;
      case "out": {
        const proc = procs.get(frame.procId);
        const target = frame.stream === "stdout" ? proc?.stdout : proc?.stderr;
        // Backpressure: stop reading the bridge until the reader catches up.
        if (target !== undefined && !target.push(Buffer.from(frame.data, "base64"))) {
          socket.pause();
        }
        return;
      }
      case "eof": {
        const proc = procs.get(frame.procId);
        (frame.stream === "stdout" ? proc?.stdout : proc?.stderr)?.push(null);
        return;
      }
      case "exit": {
        const proc = procs.get(frame.procId);
        if (proc !== undefined) {
          proc.status = { code: frame.code, signal: frame.signal };
          proc.resolveExit(proc.status);
        }
        return;
      }
      default:
        frame satisfies never;
    }
  };

  const feed = (line: string): void => {
    const parsed = parseFrame(initFrameSchema, line);
    if (!parsed.ok) {
      context.logger.warn("the box's init sent a frame the bridge refuses", { reason: parsed.reason });
      socket.destroy();
      return;
    }
    onFrame(parsed.frame);
  };
  for (const line of context.rest) {
    feed(line);
  }
  socket.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = splitter.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of lines) {
      feed(line);
    }
  });

  const shutdown = (): void => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    for (const waiter of pending.values()) {
      waiter.reject(new Error("the bridge is closed"));
    }
    pending.clear();
    for (const proc of procs.values()) {
      proc.stdout.push(null);
      proc.stderr.push(null);
      if (proc.status === undefined) {
        proc.status = { code: null, signal: "BRIDGE_CLOSED" };
        proc.resolveExit(proc.status);
      }
    }
    // Without the bridge the init ends every browser and removes its profile (`init.ts`).
    for (const browser of browsers.values()) {
      browser.resolveGone();
    }
    browsers.clear();
    context.logger.info("bridge closed");
    resolveClosed();
  };
  socket.on("close", shutdown);
  socket.on("error", shutdown);

  const unexpected = (frame: InitFrame, wanted: InitFrame["t"]): Error =>
    frame.t === "error" ? new Error(`the box's init refused: ${frame.message}`) : new Error(`the box's init answered ${frame.t}, not ${wanted}`);

  const spawnRemote = async (launch: BridgeLaunch): Promise<BridgedProcess> => {
    const procId = procIdSchema.parse(nextProc);
    nextProc += 1;
    let resolveExit: (exit: ProcessExit) => void = () => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const resume = (): void => {
      if (!isClosed) {
        socket.resume();
      }
    };
    const proc: RemoteProc = {
      stdout: new Readable({ read: resume, highWaterMark: 1024 * 1024 }),
      stderr: new Readable({ read: resume, highWaterMark: 1024 * 1024 }),
      status: undefined,
      resolveExit,
    };
    procs.set(procId, proc);
    const answer = await request((reqId) => ({
      t: "spawn",
      reqId,
      procId,
      command: launch.command,
      args: [...launch.args],
      cwd: launch.cwd,
      env: { ...launch.env },
    }));
    if (answer.t === "spawn_failed") {
      procs.delete(procId);
      throw new Error(`the box's init couldn't start it: ${answer.message}`);
    }
    if (answer.t !== "spawned") {
      throw unexpected(answer, "spawned");
    }
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const parts = toBase64Chunks(chunk, CHUNK_BYTES);
        parts.forEach((data, index) => {
          send({ t: "in", procId, data }, index === parts.length - 1 ? callback : undefined);
        });
        if (parts.length === 0) {
          callback();
        }
      },
      final: (callback) => {
        send({ t: "in_end", procId });
        callback();
      },
    });
    return { pid: answer.pid, stdin, stdout: proc.stdout, stderr: proc.stderr, exited };
  };

  const needs = (feature: BridgeFeature): void => {
    if (!context.features.includes(feature)) {
      throw initTooOld(feature);
    }
  };

  const spawnApp = async (launch: BridgeLaunch): Promise<BridgedApp> => {
    needs("app");
    const procId = procIdSchema.parse(nextProc);
    nextProc += 1;
    let resolveExit: (exit: ProcessExit) => void = () => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const resume = (): void => {
      if (!isClosed) {
        socket.resume();
      }
    };
    const proc: RemoteProc = {
      stdout: new Readable({ read: resume, highWaterMark: 1024 * 1024 }),
      stderr: new Readable({ read: resume, highWaterMark: 1024 * 1024 }),
      status: undefined,
      resolveExit,
    };
    procs.set(procId, proc);
    const answer = await request((reqId) => ({ t: "app_spawn", reqId, procId, command: launch.command, args: [...launch.args], cwd: launch.cwd, env: { ...launch.env } }));
    if (answer.t === "spawn_failed") {
      procs.delete(procId);
      throw new Error(`the box's init couldn't start it: ${answer.message}`);
    }
    if (answer.t !== "spawned") {
      procs.delete(procId);
      throw unexpected(answer, "spawned");
    }
    void exited.then(() => procs.delete(procId));
    return {
      pid: answer.pid,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited,
      stop: async (graceMs) => {
        if (proc.status === undefined) {
          const stopped = await request((reqId) => ({ t: "app_stop", reqId, procId, graceMs }));
          if (stopped.t !== "done") {
            throw unexpected(stopped, "done");
          }
        }
        await exited;
      },
    };
  };

  const startBrowser = async (): Promise<BridgedBrowser> => {
    needs("browser");
    const browserId = browserIdSchema.parse(nextBrowser);
    nextBrowser += 1;
    let resolveGone: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      resolveGone = resolve;
    });
    const remote: RemoteBrowser = { listeners: new Set(), resolveGone, gone };
    // Heard before the answer: the browser may write as soon as it runs.
    browsers.set(browserId, remote);
    const answer = await request((reqId) => ({ t: "browser_start", reqId, browserId })).catch((error: unknown) => {
      browsers.delete(browserId);
      throw error;
    });
    if (answer.t === "browser_unavailable") {
      browsers.delete(browserId);
      return { available: false, reason: answer.reason };
    }
    if (answer.t !== "browser_started") {
      browsers.delete(browserId);
      throw unexpected(answer, "browser_started");
    }
    return {
      available: true,
      pid: answer.pid,
      program: answer.program,
      profileDir: answer.profileDir,
      ends: {
        write: (bytes) => {
          for (const data of toBase64Chunks(bytes, CHUNK_BYTES)) {
            send({ t: "browser_in", browserId, data });
          }
        },
        onBytes: (listener) => {
          remote.listeners.add(listener);
        },
        gone,
        kill: async () => {
          if (!browsers.has(browserId)) {
            return;
          }
          const killed = await request((reqId) => ({ t: "browser_kill", reqId, browserId })).catch(() => null);
          if (killed !== null && killed.t !== "done") {
            throw unexpected(killed, "done");
          }
        },
      },
    };
  };

  const openForward = async (port: number): Promise<BridgedForward> => {
    needs("forward");
    const forwardId = forwardIdSchema.parse(nextForward);
    nextForward += 1;
    const answer = await request((reqId) => ({ t: "forward_open", reqId, forwardId, port }));
    if (answer.t !== "forward_opened") {
      throw unexpected(answer, "forward_opened");
    }
    return {
      host: answer.host,
      port: answer.port,
      close: async () => {
        if (isClosed) {
          return;
        }
        const closedAnswer = await request((reqId) => ({ t: "forward_close", reqId, forwardId }));
        if (closedAnswer.t !== "done") {
          throw unexpected(closedAnswer, "done");
        }
      },
    };
  };

  const processList = async (build: (reqId: ReqId) => SidecarFrame): Promise<readonly BridgeProcess[]> => {
    const answer = await request(build);
    if (answer.t !== "ps_result") {
      throw unexpected(answer, "ps_result");
    }
    return answer.processes;
  };

  return {
    initPid: context.initPid,
    agentUid: context.agentUid,
    platform: context.platform,
    spawn: spawnRemote,
    prepare: async (dirs, files) => {
      const answer = await request((reqId) => ({
        t: "prepare",
        reqId,
        dirs: [...dirs],
        files: files.map((file) => ({ path: file.path, content: file.content.toString("base64"), mode: file.mode })),
      }));
      if (answer.t !== "prepared") {
        throw unexpected(answer, "prepared");
      }
      if (answer.error !== undefined) {
        throw new Error(`preparing the agent's folders failed: ${answer.error}`);
      }
    },
    listProcesses: () => processList((reqId) => ({ t: "ps", reqId })),
    killTree: async (pid) => {
      const answer = await request((reqId) => ({ t: "kill_tree", reqId, pid }));
      if (answer.t !== "done") {
        throw unexpected(answer, "done");
      }
    },
    reapAll: () => processList((reqId) => ({ t: "reap_all", reqId })),
    features: context.features,
    spawnApp,
    startBrowser,
    openForward,
    closed,
    close: () => {
      socket.destroy();
    },
  };
};

export const listenForInit = async (options: BridgeListenOptions): Promise<BridgeListener> => {
  const log = options.logger.child({ boxId: options.boxId, component: "bridge" });
  let accepted = false;
  let refused = 0;
  let isListening = true;
  let resolveConnected: (bridge: Bridge) => void = () => undefined;
  const connected = new Promise<Bridge>((resolve) => {
    resolveConnected = resolve;
  });

  const server = createServer((socket) => {
    if (accepted) {
      refused += 1;
      socket.destroy();
      return;
    }
    const splitter = createLineSplitter();
    const timer = setTimeout(() => {
      refused += 1;
      log.warn("bridge refused a connection", { reason: "no hello in time" });
      socket.destroy();
    }, options.helloTimeoutMs ?? 5_000);
    const onData = (chunk: Buffer): void => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      const first = lines[0];
      if (first === undefined) {
        return;
      }
      clearTimeout(timer);
      socket.off("data", onData);
      const parsed = parseFrame(initFrameSchema, first);
      if (!parsed.ok || parsed.frame.t !== "hello" || parsed.frame.boxId !== options.boxId || !sameSecret(parsed.frame.nonce, options.nonce) || accepted) {
        refused += 1;
        log.warn("bridge refused a connection", { reason: parsed.ok ? "a bad hello" : parsed.reason });
        socket.destroy();
        return;
      }
      accepted = true;
      // Stop listening at once: nothing may connect after the init.
      server.close();
      isListening = false;
      const hello = parsed.frame;
      socket.write(encodeFrame({ t: "welcome", version: BRIDGE_VERSION } satisfies SidecarFrame));
      log.info("bridge connected", { initPid: hello.initPid, agentUid: hello.agentUid });
      resolveConnected(
        bridgeOverSocket(socket, {
          initPid: hello.initPid,
          agentUid: hello.agentUid,
          platform: hello.platform,
          features: hello.features ?? [],
          rest: lines.slice(1),
          logger: log,
          deadlineMs: options.requestDeadlineMs ?? REQUEST_DEADLINE_MS,
        }),
      );
    };
    socket.on("data", onData);
    socket.on("error", () => {
      clearTimeout(timer);
    });
    socket.on("close", () => {
      if (!accepted) {
        clearTimeout(timer);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    connected,
    listening: () => isListening,
    refused: () => refused,
    close: async () => {
      if (!isListening) {
        return;
      }
      isListening = false;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
