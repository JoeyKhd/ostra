// Shared setup: the model side (a stub, or the endpoint in model.env), the
// "GitHub" stand-in (a local bare repo), the server's blob store, and boxes.
//
// A box is one of two kinds:
//   directory  a directory tree: a workspace cloned from the remote, and its
//              own HOME, XDG and temp dirs, so OpenCode's data (its session
//              database) lives inside the box and dies with it. A fresh box at
//              the same path stands in for a fresh container's fixed /workspace.
//   container  a fresh container per box (src/lib/docker-box.ts), the tree
//              mounted at /box, OpenCode's data inside the container. Needs
//              Docker; SKIPPED without it.
// Destroying a box stops its agent, removes its container, closes its key
// proxy and deletes the whole tree.
//
// Every box's agent runs with OpenCode permission rules that ask for every
// tool and deny external directories, and a decider that approves a tool call
// only inside the box's workspace (src/lib/deciders.ts). The question turns
// reject every tool call: answers come from memory.

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startAcpDriver, type AcpDriver, type AgentLaunch, type DriverEvent, type PermissionDecider } from "../lib/acp-driver.ts";
import { startBlobStore, type BlobStore } from "../lib/blob-store.ts";
import { declineQuestions, newScopeTally, rejectOnce, withinWorkspace, type ScopeTally } from "../lib/deciders.ts";
import { BOX_MOUNT, containerAgentEnv, containerPath, containersOfRun, dockerEnv, ensureBoxImage, removeContainer, startContainer, stopAgentsIn } from "../lib/docker-box.ts";
import { git } from "../lib/git.ts";
import type { TaskId } from "../lib/ids.ts";
import { startKeyProxy, type KeyProxy } from "../lib/key-proxy.ts";
import {
  buildAgentEnv,
  buildOpenCodeConfig,
  createTaskDirs,
  openCodeAcpLaunch,
  resolveOpenCodeBinary,
  writeOpenCodeConfig,
  type OpenCodeBinary,
  type OpenCodeVersion,
  type PermissionRule,
  type ProviderSpec,
  type TaskDirs,
} from "../lib/opencode.ts";
import { killTree, listProcesses, type ProcessInfo } from "../lib/process-tree.ts";
import type { CliTarget } from "../lib/session-archive.ts";
import { createScenarioBrain } from "../lib/stub-models/scenario.ts";
import { startStubModelServer, type StubServer } from "../lib/stub-models/server.ts";
import type { Inputs, ModelEndpoint } from "./inputs.ts";
import { auxiliary, compactionSummary, isCompactionCall, scenarios } from "./scenarios.ts";

export const STUB_MODEL = "stub-coder";
export const KEY_ENV = "OSTRA_MODEL_API_KEY";

export type Upstream =
  | { readonly kind: "stub" }
  | { readonly kind: "endpoint"; readonly endpoint: ModelEndpoint; readonly format: "openai" | "anthropic" };

export type Executor = "directory" | "container";

export type RunContext = {
  readonly runRoot: string;
  readonly runStartedAt: number;
  /** In every slow check's command line and on every container, so the sweep can find them. */
  readonly marker: string;
  readonly inputs: Inputs;
  readonly stub: StubServer;
  readonly stubKey: string;
  readonly blobs: BlobStore;
  readonly binary: (version: OpenCodeVersion) => Promise<OpenCodeBinary>;
  /** The container image for one OpenCode version, built once per run (Docker caches it). */
  readonly image: (version: OpenCodeVersion) => Promise<string>;
  /** OpenCode compaction calls the stub answered. */
  readonly compactions: { count: number };
  /** Writes an artifact into the run folder (gitignored). */
  readonly save: (name: string, data: unknown) => Promise<void>;
};

const cached = <K, V>(make: (key: K) => Promise<V>): ((key: K) => Promise<V>) => {
  const cache = new Map<K, Promise<V>>();
  return async (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const next = make(key);
    cache.set(key, next);
    return next;
  };
};

export const startRunContext = async (runRoot: string, inputs: Inputs): Promise<RunContext> => {
  const stubKey = `stub-real-${randomBytes(16).toString("hex")}`;
  const compactions = { count: 0 };
  const intercept = (request: Parameters<typeof compactionSummary>[0]): ReturnType<typeof compactionSummary> | undefined => {
    if (!isCompactionCall(request)) return undefined;
    compactions.count += 1;
    return compactionSummary(request);
  };
  const stub = await startStubModelServer({ format: "openai", realKey: stubKey, models: [STUB_MODEL], brain: createScenarioBrain(scenarios, { auxiliary, intercept }) });
  const blobs = await startBlobStore(path.join(runRoot, "blobs"));
  return {
    runRoot,
    runStartedAt: Date.now(),
    marker: `ostra-marker-${path.basename(runRoot).slice(-13)}`,
    inputs,
    stub,
    stubKey,
    blobs,
    binary: cached(resolveOpenCodeBinary),
    image: cached(ensureBoxImage),
    compactions,
    save: async (name, data) => {
      await writeFile(path.join(runRoot, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
    },
  };
};

export const closeRunContext = async (ctx: RunContext): Promise<void> => {
  await ctx.stub.close();
  await ctx.blobs.close();
};

// --- the remote ("GitHub") ------------------------------------------------

export type Remote = { readonly url: string; readonly defaultBranch: string };

/** A ~24 KB source file, for turns that read something sizeable. */
const bigFile = (): string => Array.from({ length: 600 }, (_, i) => `export const value${String(i).padStart(3, "0")} = "${String(i * 7919).padStart(12, "0")}";\n`).join("");

/** A bare repo standing in for GitHub, seeded with the files the turns touch. */
export const createLocalRemote = async (ctx: RunContext, name: string): Promise<Remote> => {
  const bare = path.join(ctx.runRoot, `${name}.git`);
  const seed = path.join(ctx.runRoot, `${name}-seed`);
  await mkdir(seed, { recursive: true });
  await git(["init", "-q", "--bare", "-b", "main", bare], { cwd: ctx.runRoot });
  await git(["init", "-q", "-b", "main"], { cwd: seed });
  await git(["config", "core.autocrlf", "false"], { cwd: seed });
  await writeFile(path.join(seed, "README.md"), "hello\n");
  await writeFile(path.join(seed, "notes.txt"), "notes\n");
  await writeFile(path.join(seed, "old.txt"), "this file goes away\n");
  await writeFile(path.join(seed, ".gitignore"), "*.log\nnode_modules/\n");
  await mkdir(path.join(seed, "src"), { recursive: true });
  await writeFile(path.join(seed, "src", "big.ts"), bigFile());
  await git(["add", "-A"], { cwd: seed });
  await git(["commit", "-q", "-m", "initial"], { cwd: seed });
  await git(["push", "-q", bare, "main"], { cwd: seed });
  await rm(seed, { recursive: true, force: true });
  return { url: bare, defaultBranch: "main" };
};

/**
 * The task's branch, made from the default branch inside the bare repo. Runs
 * with the bare repo as its cwd: the run folder sits inside the ostra
 * checkout, so a git command run there would act on ostra's own repo.
 */
export const createTaskBranch = async (remote: Remote, branch: string): Promise<void> => {
  await git(["update-ref", `refs/heads/${branch}`, `refs/heads/${remote.defaultBranch}`], { cwd: remote.url });
};

// --- processes ----------------------------------------------------------

/** The PIDs this run spawned (agents and OpenCode CLI calls), with their spawn time. */
const spawned = new Map<number, number>();
const trackPid = (pid: number): void => {
  spawned.set(pid, Date.now());
};
const untrackPid = (pid: number): void => {
  spawned.delete(pid);
};

/**
 * This run's processes, and nothing else: a tracked PID whose creation time
 * matches its spawn (PIDs are reused), or anything with the run's folder or
 * marker in its command line (the slow checks). Another run's processes match
 * neither. Throws when the process list can't be read.
 */
const findOurs = async (ctx: Pick<RunContext, "runRoot" | "marker">): Promise<ProcessInfo[]> =>
  (await listProcesses()).filter((p) => {
    if (p.pid === process.pid) return false;
    if (p.commandLine.includes(ctx.runRoot) || p.commandLine.includes(ctx.marker)) return true;
    const at = spawned.get(p.pid);
    return at !== undefined && p.startedAt !== 0 && Math.abs(p.startedAt - at) < 5000;
  });

export type SweepResult = {
  /** Processes of this run found alive and killed. */
  readonly killed: number;
  /** This run's containers found and removed. */
  readonly containers: number;
  /** Processes of this run still alive after the kills. */
  readonly survivors: number;
  /** Set when the sweep couldn't look: then nothing is known. */
  readonly error: string | undefined;
};

/** Kills what this run left behind, then looks again. */
export const sweep = async (ctx: Pick<RunContext, "runRoot" | "marker" | "inputs">): Promise<SweepResult> => {
  try {
    const ours = await findOurs(ctx);
    for (const p of ours) await killTree(p.pid);
    let containers = 0;
    if (ctx.inputs.docker) {
      const left = await containersOfRun(ctx.marker);
      for (const id of left) await removeContainer(id);
      containers = left.length;
    }
    let survivors = ours.length === 0 ? [] : await findOurs(ctx);
    for (let tries = 0; survivors.length > 0 && tries < 10; tries += 1) {
      await sleep(300);
      survivors = await findOurs(ctx);
    }
    return { killed: ours.length, containers, survivors: survivors.length, error: undefined };
  } catch (error) {
    return { killed: 0, containers: 0, survivors: 0, error: errorMessage(error) };
  }
};

/** Whether the sweep shows a clean run: it could look, nothing was left, nothing survived. */
export const sweepClean = (result: SweepResult): boolean => result.error === undefined && result.killed === 0 && result.containers === 0 && result.survivors === 0;

// --- boxes --------------------------------------------------------------

export type BoxOptions = {
  readonly name: string;
  /** The box's root. A fresh box at an old box's path stands in for a fresh container's fixed /workspace. */
  readonly root: string;
  readonly taskId: TaskId;
  readonly version: OpenCodeVersion;
  readonly upstream: Upstream;
  readonly remote: Remote;
  readonly branch: string;
  /** Default `directory`. */
  readonly executor?: Executor;
  readonly onEvent?: (event: DriverEvent) => void;
  /** For the long session: no auto-compaction and a large context, so turn 1 stays in the context. */
  readonly noCompaction?: boolean;
};

export type Box = {
  readonly name: string;
  readonly taskId: TaskId;
  readonly executor: Executor;
  readonly version: OpenCodeVersion;
  /** The box's tree on the host: git and the checks work here. */
  readonly dirs: TaskDirs;
  /** The workspace as the agent sees it: the session's `cwd`. */
  readonly agentWorkspace: string;
  /** A host path inside the box's tree, as the agent sees it. */
  readonly agentPath: (hostPath: string) => string;
  readonly proxy: KeyProxy;
  readonly cli: CliTarget;
  readonly remote: Remote;
  readonly branch: string;
  /** Setup phases, ms: the clone, and the container's start for a container box. */
  readonly setup: Readonly<Record<string, number>>;
  /** What the workspace-bound decider approved and rejected. */
  readonly tally: ScopeTally;
  /** While on, every tool call is rejected (the question turns). Returns how many were rejected while it was on. */
  readonly blockTools: (on: boolean) => number;
  /** Spawns `opencode acp` and initializes it. */
  readonly start: () => Promise<AcpDriver>;
  readonly driver: () => AcpDriver | undefined;
  /** Stops the agent, removes the container, closes the proxy and deletes the box. */
  readonly destroy: () => Promise<void>;
};

/**
 * OpenCode's rules: ask for everything, so every tool call reaches the
 * decider; deny external directories outright. The last matching rule wins.
 */
export const BOX_PERMISSIONS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

const providerFor = (upstream: Upstream, baseUrl: string, bigContext: boolean): { spec: ProviderSpec; model: string } =>
  upstream.kind === "stub"
    ? {
        spec: { kind: "custom", id: "ostra-openai", format: "openai", baseUrl, keyEnv: KEY_ENV, models: [{ id: STUB_MODEL, ...(bigContext ? { context: 10_000_000 } : {}) }] },
        model: `ostra-openai/${STUB_MODEL}`,
      }
    : {
        spec: { kind: "custom", id: `ostra-${upstream.format}`, format: upstream.format, baseUrl, keyEnv: KEY_ENV, models: [{ id: upstream.endpoint.modelId }] },
        model: `ostra-${upstream.format}/${upstream.endpoint.modelId}`,
      };

const containerName = (box: string): string => `ostra-s2-${box.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`.slice(0, 63);

/** How the agent and the CLI run in this box. */
type Placement = {
  readonly launch: AgentLaunch;
  readonly cli: CliTarget;
  readonly agentWorkspace: string;
  readonly agentPath: (hostPath: string) => string;
  readonly setup: Record<string, number>;
  readonly stopInside: () => Promise<void>;
  readonly remove: () => Promise<void>;
};

const placeOnHost = async (ctx: RunContext, options: BoxOptions, dirs: TaskDirs, fakeKey: string): Promise<Placement> => {
  const binary = await ctx.binary(options.version);
  const env = buildAgentEnv({ dirs, fakeKeys: { [KEY_ENV]: fakeKey } });
  return {
    launch: openCodeAcpLaunch(binary, dirs, env),
    cli: { kind: "host", binary, cwd: dirs.workspace, env, onSpawn: trackPid, onExit: untrackPid },
    agentWorkspace: dirs.workspace,
    agentPath: (hostPath) => hostPath,
    setup: {},
    stopInside: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
};

const placeInContainer = async (ctx: RunContext, options: BoxOptions, dirs: TaskDirs, fakeKey: string): Promise<Placement> => {
  const image = await ctx.image(options.version);
  const container = await startContainer({ name: containerName(options.name), image, boxRoot: dirs.root, runLabel: ctx.marker });
  const env = containerAgentEnv({ fakeKeys: { [KEY_ENV]: fakeKey } });
  const workspace = `${BOX_MOUNT}/workspace`;
  const byName = Object.keys(env).flatMap((name) => ["-e", name]);
  return {
    launch: { command: "docker", args: ["exec", "-i", "-w", workspace, ...byName, container.name, "opencode", "acp"], cwd: dirs.root, env: { ...dockerEnv(), ...env } },
    cli: { kind: "container", container: container.name, workdir: workspace, env, dockerEnv: dockerEnv(), hostCwd: dirs.root, onSpawn: trackPid, onExit: untrackPid },
    agentWorkspace: workspace,
    agentPath: (hostPath) => containerPath(dirs.root, hostPath),
    setup: { containerStart: container.startMs },
    stopInside: async () => stopAgentsIn(container.name),
    remove: async () => removeContainer(container.name),
  };
};

export const createBox = async (ctx: RunContext, options: BoxOptions): Promise<Box> => {
  const executor = options.executor ?? "directory";
  await rm(options.root, { recursive: true, force: true, maxRetries: 5 });
  const cloneStarted = Date.now();
  const dirs = await createTaskDirs(options.root);
  await git(["clone", "-q", "-c", "core.autocrlf=false", "--branch", options.branch, options.remote.url, dirs.workspace], { cwd: options.root });
  await git(["config", "user.name", "ostra"], { cwd: dirs.workspace });
  await git(["config", "user.email", "ostra@ostra.invalid"], { cwd: dirs.workspace });
  const cloneMs = Date.now() - cloneStarted;

  const { upstream } = options;
  // A container reaches the proxy through the host's gateway, so the proxy listens beyond loopback (it still needs the fake key).
  const proxy = await startKeyProxy({
    upstreamBaseUrl: upstream.kind === "stub" ? ctx.stub.baseUrl : upstream.endpoint.baseUrl,
    realKey: upstream.kind === "stub" ? ctx.stubKey : upstream.endpoint.apiKey,
    upstreamAuth: upstream.kind === "endpoint" && upstream.format === "anthropic" ? "x-api-key" : "bearer",
    taskId: options.taskId,
    ...(executor === "container" ? { host: "0.0.0.0" } : {}),
  });
  let placement: Placement | undefined;
  try {
    const agentBaseUrl = executor === "container" ? proxy.agentBaseUrl.replace(/^http:\/\/0\.0\.0\.0:/, "http://host.docker.internal:") : proxy.agentBaseUrl;
    const chosen = providerFor(upstream, agentBaseUrl, options.noCompaction === true);
    await writeOpenCodeConfig(dirs, buildOpenCodeConfig({ providers: [chosen.spec], model: chosen.model, permissions: BOX_PERMISSIONS, ...(options.noCompaction === true ? { compactionAuto: false } : {}) }));
    placement = executor === "container" ? await placeInContainer(ctx, options, dirs, proxy.fakeKey) : await placeOnHost(ctx, options, dirs, proxy.fakeKey);
    const placed = placement;
    const tally = newScopeTally();
    const scoped = withinWorkspace({ workspace: placed.agentWorkspace, posix: executor === "container" }, tally);
    const blocked = { on: false, count: 0 };
    const decide: PermissionDecider = async (request, signal) => {
      if (!blocked.on) return scoped(request, signal);
      blocked.count += 1;
      return rejectOnce(request, signal);
    };
    let driver: AcpDriver | undefined;
    const stopDriver = async (): Promise<void> => {
      if (driver === undefined) return;
      await driver.stop();
      await placed.stopInside();
    };
    const box: Box = {
      name: options.name,
      taskId: options.taskId,
      executor,
      version: options.version,
      dirs,
      agentWorkspace: placed.agentWorkspace,
      agentPath: placed.agentPath,
      proxy,
      cli: placed.cli,
      remote: options.remote,
      branch: options.branch,
      setup: { clone: cloneMs, ...placed.setup },
      tally,
      blockTools: (on) => {
        const count = blocked.count;
        blocked.on = on;
        blocked.count = 0;
        return count;
      },
      start: async () => {
        if (driver?.isRunning() === true) await stopDriver();
        driver = await startAcpDriver({
          taskId: options.taskId,
          launch: placed.launch,
          decidePermission: decide,
          answerElicitation: declineQuestions,
          onSpawn: trackPid,
          ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        });
        const pid = driver.pid;
        void driver.exited.then(() => {
          untrackPid(pid);
        });
        return driver;
      },
      driver: () => driver,
      destroy: async () => {
        if (driver !== undefined) {
          await stopDriver();
          await writeFile(path.join(ctx.runRoot, `${options.name}-agent-stderr.txt`), driver.stderrTail()).catch(() => undefined);
        }
        await placed.remove();
        await proxy.close();
        await rm(options.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      },
    };
    return box;
  } catch (error) {
    await placement?.remove();
    await proxy.close();
    throw error;
  }
};

// --- small helpers --------------------------------------------------------

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
};

export const withTimeout = async <T,>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} did not finish within ${String(ms)} ms`));
      }, ms).unref();
    }),
  ]);

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const randomWord = (prefix: string): string => `${prefix}${randomBytes(3).toString("hex")}`;
