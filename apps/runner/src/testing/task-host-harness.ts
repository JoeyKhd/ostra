import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HostExecutor } from "@ostra/adapter-executor-host";
import type { HostExecutorOptions } from "@ostra/adapter-executor-host";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, AgentCommand, AgentLaunch, AgentProcess, BoxRef, ExecutorAdapter, ExportSessionInput, Logger, LogRecord } from "@ostra/adapter-sdk";
import { FakeAgentAdapter, startAnthropicStub, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream, StubBrain, StubServer } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, clientMessageIdSchema, runnerIdSchema, sessionIdSchema, taskCredentialsSchema, taskIdSchema } from "@ostra/protocol";
import type { BoxId, Command, Peer, RunnerEvent, TaskCredentials, TaskEvent, TaskEventOf, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { startConnection } from "../connection/peer.ts";
import type { Carrier } from "../connection/http-carrier.ts";
import type { RunnerConnection } from "../connection/peer.ts";
import { createAgentRegistry } from "../task-host/agents.ts";
import type { AgentFactory, AgentRegistry } from "../task-host/agents.ts";
import { runnerServerLink } from "../task-host/server-link.ts";
import { createTaskHost } from "../task-host/task-host.ts";
import type { TaskHost, TaskHostOptions } from "../task-host/task-host.ts";
import type { TaskTimers } from "../task-host/task-run.ts";
import { makeCommand, startFakeGateway } from "./fake-gateway.ts";
import type { FakeGateway } from "./fake-gateway.ts";
import { startFakeServer } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";

// One runner in one process for milestone 2's task-host tests (tickets 22 to 26): the fake gateway
// and server (with the bulk path), the scripted fake agent, the stub models, the real git proxy and
// key proxy, the host executor and the git upstream stub. As ticket 21's own test does it, in a
// module the new tests share.

export const MODEL_TOKEN = "sk-real-model-token-for-the-m2-task-host-test";
export const GIT_TOKEN = "ghs_realGitTokenForTheM2TaskHostTest0123456789";
/** The token the runner's link sends core: on `host` the runner's own, in a box the task's (ticket 20 searches for it). */
export const ACCESS_TOKEN = "ostra-runner-m2-task-host-access-token";
const MCP_TOKEN = "ostra-mcp-real-runner-mcp-token-m2-0123456789";

/** The fake agent whose export fails: its command exits 4 (ticket 22, a failed export). */
const noExportAgent = (driver: Parameters<AgentFactory>[0]): FakeAgentAdapter => {
  const agent = new FakeAgentAdapter("rich", driver);
  agent.exportSession = (input: ExportSessionInput): Promise<AdapterResult<AgentCommand>> =>
    Promise.resolve({ ok: true, value: { command: process.execPath, args: ["-e", "process.exit(4)"], env: {}, cwd: input.agentDir } });
  return agent;
};

export const harnessAgents: Readonly<Record<string, AgentFactory>> = {
  "fake-acp-agent-rich": (driver) => new FakeAgentAdapter("rich", driver),
  "fake-acp-agent-plain": (driver) => new FakeAgentAdapter("plain", driver),
  "fake-acp-agent-noexport": noExportAgent,
};

/** What every test of a file shares: the git upstream and the stub models. */
export type Shared = {
  readonly root: string;
  readonly upstream: GitUpstream;
  readonly models: StubServer;
  readonly close: () => Promise<void>;
};

/** What a file's tests share can differ: the stub model's brain, for a test on a real agent (OpenCode). */
export type SharedOptions = { readonly brain?: StubBrain };

export const startShared = async (name: string, options: SharedOptions = {}): Promise<Shared> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `ostra-${name}-`));
  const upstream = await startGitUpstream(path.join(root, "upstream"));
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n", "notes.txt": "notes\n" });
  upstream.tokens.set(GIT_TOKEN, Date.now() + 3_600_000);
  const models = await startAnthropicStub({ realKey: MODEL_TOKEN, models: ["stub-model"], brain: options.brain ?? (() => ({ text: "ok" })) });
  return {
    root,
    upstream,
    models,
    close: async () => {
      await models.close();
      await upstream.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
};

export type HarnessOptions = {
  /** The server's protocol minor (default this build's): an older server, inside the window (ADR 0034). */
  readonly serverMinor?: number;
  /** The runner's protocol minor (default this build's): an older runner, for a server it's in the window of. */
  readonly runnerMinor?: number;
  /** Overrides of the task host's options (the idle timer's clock, the temp folder). */
  readonly host?: Partial<Omit<TaskHostOptions, "link" | "executor" | "agents" | "logger">>;
  /** The runner's data folder; a new one by default. Two harnesses with two folders are two runners. */
  readonly dataDir?: string;
  /** The agent adapters, by name. Default: the fake agents. */
  readonly agents?: AgentRegistry;
  /**
   * Who the connection says it is: the runner (default), or a box's sidecar for one task, as
   * `ostra sidecar` connects (ADR 0029, Q129: core sends a box's commands to its sidecar).
   */
  readonly peer?: Peer;
  /** Overrides of the host executor's options (milestone 3: a docker box's services, as its sidecar runs them). */
  readonly executor?: Partial<Omit<HostExecutorOptions, "dataDir">>;
  /**
   * Milestone 8 (ticket 18): the carrier the box's link says it's on, for its browser views: `http`
   * posts their frames as a runner on the HTTP carrier does, while the fake gateway stays on the
   * WebSocket. Default: the connection's own.
   */
  readonly previewCarrier?: Carrier;
  /**
   * Ticket 21 (F-098): another executor in place of the host executor, as a box's sidecar runs the
   * task host (`DockerExecutor` through its bridge), with its kind. Disposed of on close.
   */
  readonly makeExecutor?: (input: { readonly dataDir: string; readonly logger: Logger }) => Promise<{
    readonly executor: ExecutorAdapter;
    readonly kind: TaskHostOptions["executorKind"];
    readonly dispose: () => Promise<void>;
  }>;
};

export type Harness = {
  readonly dataDir: string;
  readonly server: FakeServer;
  readonly gateway: FakeGateway;
  readonly host: TaskHost;
  readonly executor: ExecutorAdapter;
  readonly logs: LogRecord[];
  /** Each agent launch the executor was given, in order. */
  readonly launches: AgentLaunch[];
  /** A task the fake server hands out, from the fixture, with the prompt and spec fields given. */
  readonly taskFor: (prompt: string, patch?: Partial<TaskSpec>) => { readonly spec: TaskSpec; readonly credentials: TaskCredentials };
  readonly dispatch: (spec: TaskSpec, boxId?: BoxId) => BoxId;
  /** Sends a command; its ID, for `ackOf`. */
  readonly command: (kind: Command["kind"], body: unknown) => string;
  readonly steer: (spec: TaskSpec, text: string) => string;
  readonly stop: (spec: TaskSpec, reason?: "requested" | "runaway" | "spend-cap" | "grace-expired") => string;
  readonly ackOf: (id: string) => { readonly result: string; readonly reason?: string | undefined } | undefined;
  readonly waitForAck: (id: string, timeoutMs?: number) => Promise<{ readonly result: string; readonly reason?: string | undefined }>;
  readonly eventsOf: (spec: TaskSpec) => readonly TaskEvent[];
  readonly kinds: (spec: TaskSpec) => readonly TaskEvent["kind"][];
  readonly ofKind: <K extends TaskEvent["kind"]>(spec: TaskSpec, kind: K) => readonly TaskEventOf<K>[];
  /** Waits until the session holds `count` events of the kind. */
  readonly waitForKind: (spec: TaskSpec, kind: TaskEvent["kind"], count?: number, timeoutMs?: number) => Promise<void>;
  readonly everyEventOnce: () => boolean;
  readonly idle: () => Promise<void>;
  readonly close: () => Promise<void>;
};

let counter = 0;

export const startHarness = async (shared: Shared, options: HarnessOptions = {}): Promise<Harness> => {
  counter += 1;
  const run = counter;
  const dataDir = options.dataDir ?? path.join(shared.root, `runner-${String(run)}`);
  const runnerId = runnerIdSchema.parse(`runner-m2-${String(run)}`);
  const server = await startFakeServer();
  server.accessTokens.set(ACCESS_TOKEN, runnerId);
  const gateway = startFakeGateway(server, options.serverMinor === undefined ? {} : { serverMinor: options.serverMinor });
  const tokens = { get: () => Promise.resolve({ ok: true as const, token: ACCESS_TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined };
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const logs: LogRecord[] = [];
  const logger = createLogger((record) => logs.push(record));
  const made = options.makeExecutor === undefined ? undefined : await options.makeExecutor({ dataDir, logger });
  const executor: ExecutorAdapter = made?.executor ?? new HostExecutor({ ...options.executor, dataDir }, { logger, clock: { now: () => Date.now() } });
  const launches: AgentLaunch[] = [];
  const startAgent = executor.startAgent.bind(executor);
  executor.startAgent = (box: BoxRef, launch: AgentLaunch): Promise<AdapterResult<AgentProcess>> => {
    launches.push(launch);
    return startAgent(box, launch);
  };
  const host = createTaskHost({
    link: runnerServerLink({
      serverUrl: server.url,
      tokens,
      connection: {
        openSession: (ref) => {
          if (holder.connection === undefined) {
            throw new Error("not connected");
          }
          return holder.connection.openSession(ref);
        },
        statusChanged: () => {
          holder.connection?.statusChanged();
        },
        carrier: () => options.previewCarrier ?? holder.connection?.report().carrier ?? null,
      },
    }),
    executor,
    agents: options.agents ?? createAgentRegistry(harnessAgents),
    logger,
    listenHost: "127.0.0.1",
    stopGraceMs: 1_000,
    capacity: 4,
    executorKind: made?.kind ?? "host",
    labels: [],
    gitUpstreamUrl: (cloneUrl) => cloneUrl.replace("https://github.com", shared.upstream.origin),
    ...options.host,
  });
  holder.connection = await startConnection({
    serverUrl: server.url,
    peer: options.peer ?? { kind: "runner", runnerId },
    tokens,
    dataDir,
    handlers: host.handlers,
    status: host.status,
    logger: silentLogger,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10, liveTextIntervalMs: 20 },
    hooks: {
      onStaleLease: (sessionId) => {
        host.abandon(sessionId);
      },
    },
    ...(options.runnerMinor === undefined ? {} : { protocolMinor: options.runnerMinor }),
  });
  const connection = holder.connection;
  await gateway.waitFor(() => gateway.connected());

  let seq = run * 1000;
  let tasks = 0;
  const command = (kind: Command["kind"], body: unknown): string => {
    seq += 1;
    const id = `${kind}-${String(run)}-${String(seq)}`;
    gateway.sendCommand(makeCommand({ seq, id, notAfter: Date.now() + 120_000, kind, body }));
    return id;
  };
  const ackOf = (id: string): { readonly result: string; readonly reason?: string | undefined } | undefined =>
    gateway.acks.flatMap((ack) => ack.results).find((item) => item.id === id);
  const eventsOf = (spec: TaskSpec): readonly TaskEvent[] =>
    [...(gateway.stored.get(spec.sessionId)?.values() ?? [])]
      .sort((a: RunnerEvent, b: RunnerEvent) => a.sessionSeq - b.sessionSeq)
      .map((item) => item.event);
  const kinds = (spec: TaskSpec): readonly TaskEvent["kind"][] => eventsOf(spec).map((event) => event.kind);
  const ofKind = <K extends TaskEvent["kind"]>(spec: TaskSpec, kind: K): readonly TaskEventOf<K>[] =>
    eventsOf(spec).filter((event): event is TaskEventOf<K> => event.kind === kind);

  return {
    dataDir,
    server,
    gateway,
    host,
    executor,
    logs,
    launches,
    taskFor: (prompt, patch = {}) => {
      tasks += 1;
      const stamp = `${String(run)}-${String(tasks)}-${String(Date.now())}`;
      const spec: TaskSpec = {
        ...taskSpecFixture,
        taskId: taskIdSchema.parse(`0196f1a0-m2-${stamp}`),
        sessionId: sessionIdSchema.parse(`session-m2-${stamp}`),
        branchName: `ostra/m2-${stamp}-work`,
        prompt,
        title: "Do the work",
        agent: { ...taskSpecFixture.agent, adapter: "fake-acp-agent-rich", apiFormat: "anthropic-messages" },
        environment: { ...taskSpecFixture.environment, setupScript: null },
        limits: { turnMaxMinutes: 30, idleMinutes: 60 },
        ...patch,
      };
      const taskId = spec.taskId;
      const credentials = taskCredentialsSchema.parse({
        taskId,
        leaseEpoch: spec.leaseEpoch,
        model: { baseUrl: shared.models.baseUrl, apiFormat: "anthropic-messages", authScheme: "x-api-key", token: MODEL_TOKEN },
        repos: spec.repos.map((repo) => ({ repoId: repo.repoId, gitToken: GIT_TOKEN, expiresAt: Date.now() + 3_600_000 })),
        secrets: [],
        mcpToken: MCP_TOKEN,
      });
      server.tasks.set(taskId, { spec, credentials });
      return { spec, credentials };
    },
    dispatch: (spec, boxId) => {
      const id = boxId ?? boxIdSchema.parse(`box-m2-${String(run)}-${String(seq + 1)}`);
      command("dispatch", { taskId: spec.taskId, sessionId: spec.sessionId, boxId: id, leaseEpoch: spec.leaseEpoch });
      return id;
    },
    command,
    steer: (spec, text) =>
      command("steer", { sessionId: spec.sessionId, clientMessageId: clientMessageIdSchema.parse(`message-${String(seq + 1)}`), text, delivery: "queue" }),
    stop: (spec, reason = "requested") => command("stop", { taskId: spec.taskId, sessionId: spec.sessionId, leaseEpoch: spec.leaseEpoch, reason }),
    ackOf,
    waitForAck: async (id, timeoutMs = 60_000) => {
      await gateway.waitFor(() => ackOf(id) !== undefined, timeoutMs);
      const ack = ackOf(id);
      if (ack === undefined) {
        throw new Error(`no ack for ${id}`);
      }
      return ack;
    },
    eventsOf,
    kinds,
    ofKind,
    waitForKind: (spec, kind, count = 1, timeoutMs = 60_000) => gateway.waitFor(() => kinds(spec).filter((item) => item === kind).length >= count, timeoutMs),
    everyEventOnce: () => [...gateway.received.values()].every((count) => count === 1),
    idle: () => gateway.waitFor(() => host.running().length === 0, 60_000),
    close: async () => {
      await host.shutdown();
      await connection.stop();
      await gateway.close();
      await server.close();
      await made?.dispose();
    },
  };
};

/** A fake clock for the idle timer (spec section 8): nothing sleeps for real. */
export type ManualTimers = TaskTimers & {
  /** Moves the clock on, firing every timer that comes due, in order. */
  readonly advance: (ms: number) => void;
  /** How many timers are armed now. */
  readonly pending: () => number;
};

export const manualTimers = (): ManualTimers => {
  let now = 0;
  let next = 0;
  const armed = new Map<number, { readonly at: number; readonly fire: () => void }>();
  return {
    after: (ms, fire) => {
      next += 1;
      const id = next;
      armed.set(id, { at: now + ms, fire });
      return () => {
        armed.delete(id);
      };
    },
    advance: (ms) => {
      now += ms;
      const due = [...armed.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        armed.delete(id);
        timer.fire();
      }
    },
    pending: () => armed.size,
  };
};
