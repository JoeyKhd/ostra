import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import type { Logger, ProcessExit } from "@ostra/adapter-sdk";
import type { BoxId } from "@ostra/protocol";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "./framing.ts";
import { BRIDGE_VERSION, CHUNK_BYTES, initFrameSchema, procIdSchema, REQUEST_DEADLINE_MS, reqIdSchema } from "./protocol.ts";
import type { BridgeProcess, InitFrame, ProcId, ReqId, SidecarFrame } from "./protocol.ts";

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
};

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

const bridgeOverSocket = (socket: Socket, context: Context): Bridge => {
  const splitter = createLineSplitter();
  const pending = new Map<ReqId, Pending>();
  const procs = new Map<ProcId, RemoteProc>();
  let nextReq = 1;
  let nextProc = 1;
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
        settle(frame.reqId, frame);
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
