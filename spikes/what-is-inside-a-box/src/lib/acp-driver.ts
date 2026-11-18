// ostra's own ACP driver (ADR 0032), on the official @agentclientprotocol/sdk,
// over stdio. Copied from spike 1 (spikes/how-should-the-runner-drive-opencode),
// with one change: the agent's process comes from an `AgentHost`, so the same
// driver runs the agent as its own child or, in a box, through the bridge to
// the agent's container (src/bridge/).
// One agent process per task, spawned with an explicit
// environment (never the runner's own), advertising `elicitation.form` so
// questions reach ostra instead of being cancelled.
//
// Every message from the agent is numbered on the wire, before the SDK sees
// it, so a gap or a drop between the wire and ostra's event log is visible.
//
// Processes: the driver snapshots the agent's tree, so descendants can be
// reaped after the agent dies. A cancelled turn reaps every descendant born
// during that turn (a cancel leaves no process behind). Each recorded process
// is identified by PID, name and creation time, so a reused PID is never
// killed.

import type { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { rpcId, sessionId as toSessionId, type RpcId, type SessionId, type TaskId } from "./ids.ts";
import { descendantsOf, sameProcess, type ProcessInfo, type ProcessKey } from "./process-tree.ts";
import type { AgentHost, AgentLaunch, HostPlatform } from "./agent-host.ts";

export type { AgentLaunch } from "./agent-host.ts";

export type AgentExit = {
  readonly code: number | null;
  readonly signal: string | null;
  /** True when ostra asked it to stop. */
  readonly expected: boolean;
  readonly at: number;
};

type EventBody =
  | { readonly kind: "session_update"; readonly sessionId: SessionId; readonly update: acp.SessionUpdate }
  | { readonly kind: "permission_requested"; readonly rpcId: RpcId; readonly request: acp.RequestPermissionRequest }
  | { readonly kind: "permission_resolved"; readonly rpcId: RpcId; readonly response: acp.RequestPermissionResponse }
  | { readonly kind: "elicitation_requested"; readonly rpcId: RpcId; readonly request: acp.CreateElicitationRequest }
  | { readonly kind: "elicitation_resolved"; readonly rpcId: RpcId; readonly response: acp.CreateElicitationResponse }
  | { readonly kind: "prompt_finished"; readonly sessionId: SessionId; readonly response: acp.PromptResponse }
  | { readonly kind: "prompt_failed"; readonly sessionId: SessionId; readonly message: string }
  /** After a cancelled turn: the descendants born during it that the driver killed (PIDs and image names only). */
  | { readonly kind: "cancel_reaped"; readonly sessionId: SessionId; readonly pids: readonly number[]; readonly names: readonly string[] }
  | { readonly kind: "agent_exited"; readonly exit: AgentExit };

export type DriverEvent = EventBody & {
  /** Contiguous per driver, from 1. */
  readonly seq: number;
  readonly at: number;
  readonly taskId: TaskId;
};

export type PermissionDecider = (
  request: acp.RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse>;

export type ElicitationResponder = (
  request: acp.CreateElicitationRequest,
  signal: AbortSignal,
) => Promise<acp.CreateElicitationResponse>;

export type WireStats = {
  /** Messages read from the agent's stdout, in order. */
  readonly inbound: number;
  readonly inboundNotifications: number;
  readonly inboundSessionUpdates: number;
  readonly inboundRequests: number;
  readonly inboundBytes: number;
};

export type AcpDriverOptions = {
  readonly taskId: TaskId;
  readonly launch: AgentLaunch;
  /** Where the agent runs: a local child, or the agent's container through the bridge. */
  readonly host: AgentHost;
  readonly decidePermission: PermissionDecider;
  readonly answerElicitation: ElicitationResponder;
  readonly onEvent?: (event: DriverEvent) => void;
  /** Called with the agent's PID right after the spawn, before anything can fail. */
  readonly onSpawn?: (pid: number) => void;
  /** Advertise `elicitation.form`. Default true; false shows what happens without it. */
  readonly advertiseElicitation?: boolean;
  readonly initializeTimeoutMs?: number;
  /**
   * How often to snapshot the agent's process tree, so its descendants can be
   * reaped after the agent dies (Windows doesn't reparent orphans to anything
   * killable, and a POSIX tool can leave the process group). Default 2 s; 0 is off.
   */
  readonly treeSnapshotMs?: number;
  /** After a turn ends `cancelled`, kill the descendants born during it. Default true. */
  readonly reapOnCancel?: boolean;
};

/** The error every call rejects with once the agent process is gone. */
export type AgentExitedError = Error & { readonly name: "AgentExitedError"; readonly exit: AgentExit };

export const agentExitedError = (exit: AgentExit): AgentExitedError =>
  Object.assign(new Error(`agent exited (code ${String(exit.code)}, signal ${String(exit.signal)})`), { name: "AgentExitedError" as const, exit });

export const isAgentExitedError = (error: unknown): error is AgentExitedError =>
  error instanceof Error && error.name === "AgentExitedError" && "exit" in error;

export type NewSessionResult = Omit<acp.NewSessionResponse, "sessionId"> & { readonly sessionId: SessionId };

export type AcpDriver = {
  readonly taskId: TaskId;
  readonly pid: number;
  readonly spawnedAt: number;
  readonly initialize: acp.InitializeResponse;
  readonly events: readonly DriverEvent[];
  readonly wire: () => WireStats;
  readonly stderrTail: () => string;
  readonly exited: Promise<AgentExit>;
  readonly isRunning: () => boolean;
  readonly newSession: (request: acp.NewSessionRequest) => Promise<NewSessionResult>;
  readonly loadSession: (request: acp.LoadSessionRequest & { readonly sessionId: SessionId }) => Promise<acp.LoadSessionResponse>;
  readonly prompt: (sessionId: SessionId, prompt: readonly acp.ContentBlock[]) => Promise<acp.PromptResponse>;
  readonly cancel: (sessionId: SessionId) => Promise<void>;
  readonly setConfigOption: (sessionId: SessionId, configId: string, value: string) => Promise<acp.SetSessionConfigOptionResponse>;
  readonly setMode: (sessionId: SessionId, modeId: string) => Promise<void>;
  /**
   * Mid-turn steering through the `_session/steering` extension, which an agent
   * may advertise as `_meta.steering.supported` on initialize. Optional: check
   * `steeringAdvertised` first. Resolves with the agent's raw answer.
   */
  readonly steer: (sessionId: SessionId, prompt: readonly acp.ContentBlock[]) => Promise<unknown>;
  readonly steeringAdvertised: boolean;
  /** Closes stdin, waits up to `graceMs`, then kills the whole tree, descendants seen before the stop included. */
  readonly stop: (graceMs?: number) => Promise<AgentExit>;
  /** Kills only the agent process at once, as a crash would (`kill -9`). */
  readonly crash: () => void;
  /** Records the agent's current descendants, to reap them later. */
  readonly snapshotTree: () => Promise<void>;
  /** Kills every descendant ever seen that is still alive (same PID, name and creation time). Returns how many it killed. */
  readonly reap: () => Promise<number>;
};

const STDERR_TAIL_BYTES = 64 * 1024;

const readableFromNode = (stream: Readable): ReadableStream<Uint8Array> => {
  let closed = false;
  return new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        stream.on("data", (chunk: Buffer) => {
          if (closed) return;
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          // Backpressure: stop reading the pipe; the agent blocks on its own write.
          if ((controller.desiredSize ?? 0) <= 0) stream.pause();
        });
        stream.on("end", () => {
          if (closed) return;
          closed = true;
          controller.close();
        });
        stream.on("error", (error) => {
          if (closed) return;
          closed = true;
          controller.error(error);
        });
      },
      pull: () => {
        stream.resume();
      },
      cancel: () => {
        closed = true;
        stream.destroy();
      },
    },
    { highWaterMark: 64 },
  );
};

const writableFromNode = (stream: Writable): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    write: async (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    close: () => {
      stream.end();
    },
    abort: () => {
      stream.destroy();
    },
  });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The SDK's errors once its transport is gone. */
const CLOSED_CONNECTION = /ACP (connection|outbound channel)( is)? closed/;

/** Creation times on POSIX have second precision: compare from the start of the prompt's second. */
const bornSince = (p: ProcessInfo, since: number, platform: HostPlatform): boolean =>
  p.startedAt !== 0 && p.startedAt >= (platform === "win32" ? since - 50 : Math.floor(since / 1000) * 1000);

export const startAcpDriver = async (options: AcpDriverOptions): Promise<AcpDriver> => {
  const { taskId, launch, host } = options;
  const { listProcesses, killTree } = host;
  const events: DriverEvent[] = [];
  let seq = 0;
  const emit = (body: EventBody): void => {
    seq += 1;
    const event: DriverEvent = { ...body, seq, at: Date.now(), taskId };
    events.push(event);
    options.onEvent?.(event);
  };

  const spawnedAt = Date.now();
  const child = await host.spawn(launch);
  const pid = child.pid;
  options.onSpawn?.(pid);

  let stopping = false;
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  let stdoutClosed = false;
  child.stdout.once("close", () => {
    stdoutClosed = true;
  });

  // Every descendant ever seen, by PID, with its name and creation time.
  const known = new Map<number, ProcessKey>();
  const remember = (list: readonly ProcessInfo[]): ProcessInfo[] => {
    const below = descendantsOf(pid, list);
    for (const p of below) known.set(p.pid, { pid: p.pid, name: p.name, startedAt: p.startedAt });
    return below;
  };
  const snapshotTree = async (): Promise<void> => {
    remember(await listProcesses().catch((): ProcessInfo[] => []));
  };
  const reap = async (): Promise<number> => {
    if (known.size === 0) return 0;
    const alive = await listProcesses().catch((): ProcessInfo[] => []);
    let killed = 0;
    for (const p of alive) {
      const seen = known.get(p.pid);
      if (seen !== undefined && sameProcess(seen, p)) {
        await killTree(p.pid);
        killed += 1;
      }
    }
    return killed;
  };
  /** Kills the descendants born since `since`: live ones under the agent, and orphans seen in earlier snapshots. */
  const reapBornSince = async (since: number): Promise<ProcessInfo[]> => {
    const alive = await listProcesses().catch((): ProcessInfo[] => []);
    const below = remember(alive);
    const targets = new Map<number, ProcessInfo>();
    for (const p of below) if (bornSince(p, since, host.platform)) targets.set(p.pid, p);
    for (const p of alive) {
      const seen = known.get(p.pid);
      if (seen !== undefined && sameProcess(seen, p) && bornSince(p, since, host.platform)) targets.set(p.pid, p);
    }
    for (const p of targets.values()) await killTree(p.pid);
    return [...targets.values()];
  };

  const snapshotMs = options.treeSnapshotMs ?? 2000;
  let snapshotting = false;
  const timer =
    snapshotMs > 0
      ? setInterval(() => {
          if (snapshotting) return;
          snapshotting = true;
          void snapshotTree().finally(() => {
            snapshotting = false;
          });
        }, snapshotMs)
      : undefined;
  timer?.unref();

  let exitInfo: AgentExit | undefined;
  const exited = new Promise<AgentExit>((resolve) => {
    void child.exited.then(({ code, signal }) => {
      exitInfo = { code, signal, expected: stopping, at: Date.now() };
      if (timer !== undefined) clearInterval(timer);
      emit({ kind: "agent_exited", exit: exitInfo });
      resolve(exitInfo);
    });
  });
  child.stdin.on("error", () => {
    // EPIPE after the agent died: surfaced through `exited`.
  });

  const killEverything = async (): Promise<void> => {
    stopping = true;
    if (timer !== undefined) clearInterval(timer);
    await snapshotTree();
    await killTree(pid);
    await reap();
  };

  try {
    const wire = { inbound: 0, inboundNotifications: 0, inboundSessionUpdates: 0, inboundRequests: 0, inboundBytes: 0 };
    const byteCounter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        wire.inboundBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const stream = acp.ndJsonStream(writableFromNode(child.stdin), readableFromNode(child.stdout).pipeThrough(byteCounter));
    const counted = stream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform: (message, controller) => {
          wire.inbound += 1;
          if ("method" in message) {
            if ("id" in message) wire.inboundRequests += 1;
            else {
              wire.inboundNotifications += 1;
              if (message.method === acp.methods.client.session.update) wire.inboundSessionUpdates += 1;
            }
          }
          controller.enqueue(message);
        },
      }),
    );

    const app = acp
      .client({ name: "ostra-runner" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        emit({ kind: "session_update", sessionId: toSessionId(ctx.params.sessionId), update: ctx.params.update });
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const id = rpcId(String(ctx.requestId));
        emit({ kind: "permission_requested", rpcId: id, request: ctx.params });
        const response = await options.decidePermission(ctx.params, ctx.signal);
        emit({ kind: "permission_resolved", rpcId: id, response });
        return response;
      })
      .onRequest(acp.methods.client.elicitation.create, async (ctx) => {
        const id = rpcId(String(ctx.requestId));
        emit({ kind: "elicitation_requested", rpcId: id, request: ctx.params });
        const response = await options.answerElicitation(ctx.params, ctx.signal);
        emit({ kind: "elicitation_resolved", rpcId: id, response });
        return response;
      });

    const connection = app.connect({ writable: stream.writable, readable: counted });
    void exited.then(() => {
      connection.close(agentExitedError(exitInfo ?? { code: null, signal: null, expected: stopping, at: Date.now() }));
    });

    // A dead agent can close stdout a moment before its exit event. When a call
    // fails because the connection is gone, wait briefly for the exit so the
    // caller sees one typed error. An ordinary error reply passes straight through.
    const exitWithin = async (ms: number): Promise<AgentExit | undefined> =>
      Promise.race([
        exited,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, ms).unref();
        }),
      ]);
    const isClosedConnection = (error: unknown): boolean =>
      stdoutClosed || child.exitStatus() !== undefined || (error instanceof Error && CLOSED_CONNECTION.test(error.message));
    const untilExit = async <T,>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work.catch(async (error: unknown): Promise<never> => {
          const exit = exitInfo ?? (isClosedConnection(error) ? await exitWithin(1000) : undefined);
          if (exit !== undefined) throw agentExitedError(exit);
          throw error;
        }),
        exited.then((exit): never => {
          throw agentExitedError(exit);
        }),
      ]);

    const initTimeout = options.initializeTimeoutMs ?? 60_000;
    const initialize = await untilExit(
      Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(options.advertiseElicitation === false ? {} : { elicitation: { form: {} } }),
            session: { compaction: {} },
            plan: {},
          },
          clientInfo: { name: "ostra-runner", title: "ostra", version: "0.0.0-spike" },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`initialize timed out after ${String(initTimeout)} ms`));
          }, initTimeout).unref();
        }),
      ]),
    );

    const stop = async (graceMs = 3000): Promise<AgentExit> => {
      if (exitInfo !== undefined) {
        await reap();
        return exitInfo;
      }
      stopping = true;
      // Windows has no process groups: remember the tree before the root goes.
      await snapshotTree();
      child.stdin.end();
      const graceful = await Promise.race([
        exited,
        new Promise<undefined>((resolve) => {
          setTimeout(() => {
            resolve(undefined);
          }, graceMs).unref();
        }),
      ]);
      // killTree kills the process group on POSIX, so orphans that left the
      // tree but not the group go too.
      if (graceful === undefined) await killTree(pid);
      await reap();
      return exited;
    };

    const reapOnCancel = options.reapOnCancel ?? true;

    return {
      taskId,
      pid,
      spawnedAt,
      initialize,
      events,
      wire: () => ({ ...wire }),
      stderrTail: () => stderrTail,
      exited,
      isRunning: () => exitInfo === undefined,
      newSession: async (request) => {
        const response = await untilExit(connection.agent.request(acp.methods.agent.session.new, request));
        return { ...response, sessionId: toSessionId(response.sessionId) };
      },
      loadSession: async (request) => untilExit(connection.agent.request(acp.methods.agent.session.load, request)),
      prompt: async (sessionId, prompt) => {
        const startedAt = Date.now();
        try {
          const response = await untilExit(connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [...prompt] }));
          if (response.stopReason === "cancelled" && reapOnCancel && exitInfo === undefined) {
            const killed = await reapBornSince(startedAt);
            emit({ kind: "cancel_reaped", sessionId, pids: killed.map((p) => p.pid), names: [...new Set(killed.map((p) => p.name))] });
          }
          emit({ kind: "prompt_finished", sessionId, response });
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : isObject(error) && typeof error["message"] === "string" ? error["message"] : "error";
          emit({ kind: "prompt_failed", sessionId, message });
          throw error;
        }
      },
      cancel: async (sessionId) => {
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
      },
      setConfigOption: async (sessionId, configId, value) =>
        untilExit(connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value })),
      setMode: async (sessionId, modeId) => {
        await untilExit(connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId }));
      },
      steer: async (sessionId, prompt) => untilExit(connection.agent.request("_session/steering", { sessionId, prompt: [...prompt] })),
      steeringAdvertised: (() => {
        const meta = initialize._meta;
        const steering = isObject(meta) ? meta["steering"] : undefined;
        return isObject(steering) && steering["supported"] === true;
      })(),
      stop,
      crash: () => {
        void host.killOne(pid);
      },
      snapshotTree,
      reap,
    };
  } catch (error) {
    // initialize failed or timed out: the agent must not outlive the attempt.
    await killEverything();
    throw error;
  }
};

/** Text of a prompt block list, for building prompts. */
export const textPrompt = (text: string): acp.ContentBlock[] => [{ type: "text", text }];

/** Concatenated agent message text from a driver's events, for one session. */
export const agentText = (events: readonly DriverEvent[], sessionId: SessionId, sinceSeq = 0): string =>
  events
    .filter((event) => event.seq > sinceSeq)
    .map((event) =>
      event.kind === "session_update" &&
      event.sessionId === sessionId &&
      event.update.sessionUpdate === "agent_message_chunk" &&
      event.update.content.type === "text"
        ? event.update.content.text
        : "",
    )
    .join("");
