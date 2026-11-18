// The sidecar's end of the bridge. It listens once, accepts the first
// connection that presents the box's nonce, and then stops listening: the
// port is closed before any agent code runs, so a process the agent starts
// later finds nothing to connect to.
//
// The accepted connection becomes an `AgentHost`: the ACP driver spawns,
// reads, writes and kills through it exactly as it would a local child.

import { timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import type { AgentHost, AgentLaunch, AgentProcess, HostPlatform, ProcessExit } from "../lib/agent-host.ts";
import type { ProcessInfo } from "../lib/process-tree.ts";
import { createLineSplitter, encodeFrame, parseFrame, toBase64Chunks } from "./framing.ts";
import { BRIDGE_VERSION, CHUNK_BYTES, initFrameSchema, toProcId, toReqId, type BoxId, type InitFrame, type ProcId, type ReqId, type SidecarFrame } from "./protocol.ts";

export type BridgeLog = (line: Readonly<Record<string, string | number | boolean | null>>) => void;

export type PreparedFile = { readonly path: string; readonly content: Buffer; readonly mode: number };

export type Bridge = {
  readonly host: AgentHost;
  readonly connectedAt: number;
  readonly remoteAddress: string;
  readonly initPid: number;
  readonly agentUid: number;
  /** Creates directories and writes files in the agent's container, as the agent's user. */
  readonly prepare: (dirs: readonly string[], files: readonly PreparedFile[]) => Promise<void>;
  /** Kills every process of the agent's user and returns what was still alive afterwards (should be empty). */
  readonly reapAll: () => Promise<ProcessInfo[]>;
  readonly closed: Promise<void>;
  readonly close: () => void;
};

export type BridgeListener = {
  readonly port: number;
  /** Resolves with the one accepted connection. */
  readonly connected: Promise<Bridge>;
  /** True once the listening socket is closed (after the accept, or on close()). */
  readonly listening: () => boolean;
  /** Connections refused so far (wrong nonce, bad hello, or after the accept). */
  readonly refused: () => number;
  readonly close: () => Promise<void>;
};

export type BridgeListenOptions = {
  readonly boxId: BoxId;
  readonly nonce: string;
  readonly host: string;
  readonly port: number;
  readonly helloTimeoutMs?: number;
  readonly log?: BridgeLog;
};

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const listenForInit = async (options: BridgeListenOptions): Promise<BridgeListener> => {
  const log = options.log ?? ((): void => undefined);
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
      log({ event: "bridge_refused", boxId: options.boxId, reason: "hello timeout" });
      socket.destroy();
    }, options.helloTimeoutMs ?? 5000);
    const onData = (chunk: Buffer): void => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      const first = lines[0];
      if (first === undefined) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const parsed = parseFrame(initFrameSchema, first);
      if (!parsed.ok || parsed.frame.t !== "hello" || parsed.frame.boxId !== options.boxId || !sameSecret(parsed.frame.nonce, options.nonce) || accepted) {
        refused += 1;
        log({ event: "bridge_refused", boxId: options.boxId, reason: parsed.ok ? "bad hello" : parsed.reason });
        socket.destroy();
        return;
      }
      accepted = true;
      // Stop listening at once: nothing may connect after the init.
      server.close();
      isListening = false;
      const hello = parsed.frame;
      socket.write(encodeFrame({ t: "welcome", version: BRIDGE_VERSION } satisfies SidecarFrame));
      log({ event: "bridge_connected", boxId: options.boxId, initPid: hello.initPid, agentUid: hello.agentUid });
      const bridge = bridgeOverSocket(socket, {
        initPid: hello.initPid,
        agentUid: hello.agentUid,
        platform: hello.platform,
        rest: lines.slice(1),
        log,
        boxId: options.boxId,
      });
      resolveConnected(bridge);
    };
    socket.on("data", onData);
    socket.on("error", () => {
      clearTimeout(timer);
    });
    // A probe that connects and closes before any hello: drop the timer so it
    // doesn't fire a spurious refusal 5 s later.
    socket.on("close", () => {
      if (!accepted) clearTimeout(timer);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : options.port;
  return {
    port,
    connected,
    listening: () => isListening,
    refused: () => refused,
    close: async () => {
      if (!isListening) return;
      isListening = false;
      await new Promise<void>((resolve) => server.close(() => {
        resolve();
      }));
    },
  };
};

type BridgeContext = {
  readonly initPid: number;
  readonly agentUid: number;
  readonly platform: HostPlatform;
  readonly rest: readonly string[];
  readonly log: BridgeLog;
  readonly boxId: BoxId;
};

type RemoteProc = {
  readonly stdout: Readable;
  readonly stderr: Readable;
  status: ProcessExit | undefined;
  readonly resolveExit: (exit: ProcessExit) => void;
};

type Pending = {
  readonly resolve: (frame: InitFrame) => void;
  readonly reject: (error: Error) => void;
};

const bridgeOverSocket = (socket: Socket, context: BridgeContext): Bridge => {
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
      callback?.(new Error("bridge closed"));
      return;
    }
    socket.write(encodeFrame(frame), callback);
  };

  const request = async (build: (reqId: ReqId) => SidecarFrame): Promise<InitFrame> => {
    const reqId = toReqId(nextReq);
    nextReq += 1;
    return new Promise<InitFrame>((resolve, reject) => {
      if (isClosed) {
        reject(new Error("bridge closed"));
        return;
      }
      pending.set(reqId, { resolve, reject });
      send(build(reqId));
    });
  };

  const settle = (reqId: ReqId, frame: InitFrame): void => {
    const waiter = pending.get(reqId);
    if (waiter === undefined) return;
    pending.delete(reqId);
    waiter.resolve(frame);
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
        if (proc === undefined) return;
        const target = frame.stream === "stdout" ? proc.stdout : proc.stderr;
        // Backpressure: stop reading the bridge until the driver catches up.
        if (!target.push(Buffer.from(frame.data, "base64"))) socket.pause();
        return;
      }
      case "eof": {
        const proc = procs.get(frame.procId);
        if (proc === undefined) return;
        (frame.stream === "stdout" ? proc.stdout : proc.stderr).push(null);
        return;
      }
      case "exit": {
        const proc = procs.get(frame.procId);
        if (proc === undefined) return;
        proc.status = { code: frame.code, signal: frame.signal };
        proc.resolveExit(proc.status);
        return;
      }
      default:
        frame satisfies never;
    }
  };

  const feed = (line: string): void => {
    const parsed = parseFrame(initFrameSchema, line);
    if (!parsed.ok) {
      context.log({ event: "bridge_bad_frame", boxId: context.boxId, reason: parsed.reason });
      socket.destroy();
      return;
    }
    onFrame(parsed.frame);
  };
  for (const line of context.rest) feed(line);
  socket.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = splitter.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of lines) feed(line);
  });

  const shutdown = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const waiter of pending.values()) waiter.reject(new Error("bridge closed"));
    pending.clear();
    for (const proc of procs.values()) {
      proc.stdout.push(null);
      proc.stderr.push(null);
      if (proc.status === undefined) {
        proc.status = { code: null, signal: "BRIDGE_CLOSED" };
        proc.resolveExit(proc.status);
      }
    }
    context.log({ event: "bridge_closed", boxId: context.boxId });
    resolveClosed();
  };
  socket.on("close", shutdown);
  socket.on("error", shutdown);

  const unexpected = (frame: InitFrame, wanted: InitFrame["t"]): Error =>
    frame.t === "error" ? new Error(`init: ${frame.message}`) : new Error(`init answered ${frame.t}, expected ${wanted}`);
  const done = async (build: (reqId: ReqId) => SidecarFrame): Promise<void> => {
    const answer = await request(build);
    if (answer.t !== "done") throw unexpected(answer, "done");
  };
  const processList = async (build: (reqId: ReqId) => SidecarFrame): Promise<ProcessInfo[]> => {
    const answer = await request(build);
    if (answer.t !== "ps_result") throw unexpected(answer, "ps_result");
    return answer.processes;
  };

  const spawnRemote = async (launch: AgentLaunch): Promise<AgentProcess> => {
    const procId = toProcId(nextProc);
    nextProc += 1;
    let resolveExit: (exit: ProcessExit) => void = () => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const resume = (): void => {
      if (!isClosed) socket.resume();
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
      throw new Error(`could not spawn the agent: ${answer.message}`);
    }
    if (answer.t !== "spawned") throw unexpected(answer, "spawned");
    const spawned = answer;
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const parts = toBase64Chunks(chunk, CHUNK_BYTES);
        parts.forEach((data, index) => {
          send({ t: "in", procId, data }, index === parts.length - 1 ? callback : undefined);
        });
        if (parts.length === 0) callback();
      },
      final: (callback) => {
        send({ t: "in_end", procId });
        callback();
      },
    });
    return { pid: spawned.pid, stdin, stdout: proc.stdout, stderr: proc.stderr, exited, exitStatus: () => proc.status };
  };

  const host: AgentHost = {
    kind: "bridge",
    platform: context.platform,
    spawn: spawnRemote,
    listProcesses: async () => processList((reqId) => ({ t: "ps", reqId })),
    killTree: async (pid) => done((reqId) => ({ t: "kill_tree", reqId, pid })),
    killOne: async (pid) => done((reqId) => ({ t: "kill_one", reqId, pid })),
  };

  return {
    host,
    connectedAt: Date.now(),
    remoteAddress: socket.remoteAddress ?? "",
    initPid: context.initPid,
    agentUid: context.agentUid,
    prepare: async (dirs, files) => {
      const answer = await request((reqId) => ({
        t: "prepare",
        reqId,
        dirs: [...dirs],
        files: files.map((file) => ({ path: file.path, content: file.content.toString("base64"), mode: file.mode })),
      }));
      if (answer.t !== "prepared") throw unexpected(answer, "prepared");
      if (answer.error !== undefined) throw new Error(`prepare failed: ${answer.error}`);
    },
    reapAll: async () => processList((reqId) => ({ t: "reap_all", reqId })),
    closed,
    close: () => {
      socket.destroy();
    },
  };
};
