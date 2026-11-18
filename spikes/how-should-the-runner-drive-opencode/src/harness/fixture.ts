// Shared setup for the T-cases: the model side (both stubs, or the real
// endpoint) and a task (its own dirs, git workspace on a task branch, key
// proxy, OpenCode config, explicit env and ACP driver).

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { startAcpDriver, type AcpDriver, type AgentLaunch, type DriverEvent, type ElicitationResponder, type PermissionDecider } from "../lib/acp-driver.ts";
import { allowOnce, declineQuestions } from "../lib/deciders.ts";
import { taskId, type SessionId, type TaskId } from "../lib/ids.ts";
import { listProcesses } from "../lib/process-tree.ts";
import { startKeyProxy, type KeyProxy } from "../lib/key-proxy.ts";
import {
  buildAgentEnv,
  buildOpenCodeConfig,
  buildOpenCodeV1Config,
  createTaskDirs,
  openCodeAcpLaunch,
  resolveOpenCodeBinary,
  writeOpenCodeConfig,
  type OpenCodeBinary,
  type OpenCodeLine,
  type PermissionRule,
  type ProviderSpec,
  type TaskDirs,
} from "../lib/opencode.ts";
import { createScenarioBrain } from "../lib/stub-models/scenario.ts";
import { startStubModelServer, type StubServer } from "../lib/stub-models/server.ts";
import type { StubFormat } from "../lib/stub-models/types.ts";
import type { Inputs, ModelEndpoint } from "./inputs.ts";
import { auxiliary, intercept, scenarios } from "./scenarios.ts";
import type { Job } from "./runner-child.ts";

const run = promisify(execFile);

// Every process this run spawns and that may still be alive, for the final
// sweep: it kills only its own, so two runs can share the machine. Each PID
// carries its spawn time, and the sweep kills a PID only if the live process
// was created at that time: a PID reused by another program is left alone.
// A process that exited is dropped.
export type TrackedProcess = { readonly pid: number; readonly spawnedAt: number };
const spawned = new Map<number, TrackedProcess>();
export const trackPid = (pid: number, spawnedAt = Date.now()): void => {
  if (pid > 0) spawned.set(pid, { pid, spawnedAt });
};
export const untrackPid = (pid: number): void => {
  spawned.delete(pid);
};
export const trackedProcesses = (): readonly TrackedProcess[] => [...spawned.values()];

export { allowOnce, declineQuestions };

export const STUB_MODEL = "stub-coder";
export const STUB_MODEL_ALT = "stub-coder-alt";
export const KEY_ENV = "OSTRA_MODEL_API_KEY";

export type ModelSide = {
  readonly stubs: Readonly<Record<StubFormat, StubServer>>;
  /** Random per run; only the proxies hold them. */
  readonly stubKeys: Readonly<Record<StubFormat, string>>;
  readonly close: () => Promise<void>;
};

export const startModelSide = async (): Promise<ModelSide> => {
  const brain = createScenarioBrain(scenarios, { auxiliary, intercept });
  const stubKeys = { openai: `stub-real-${randomBytes(16).toString("hex")}`, anthropic: `stub-real-${randomBytes(16).toString("hex")}` };
  const openai = await startStubModelServer({ format: "openai", realKey: stubKeys.openai, models: [STUB_MODEL, STUB_MODEL_ALT], brain });
  const anthropic = await startStubModelServer({ format: "anthropic", realKey: stubKeys.anthropic, models: [STUB_MODEL, STUB_MODEL_ALT], brain });
  return {
    stubs: { openai, anthropic },
    stubKeys,
    close: async () => {
      await openai.close();
      await anthropic.close();
    },
  };
};

export type Upstream =
  | { readonly kind: "stub"; readonly format: StubFormat }
  | { readonly kind: "endpoint"; readonly endpoint: ModelEndpoint; readonly format: StubFormat };

export type CaseContext = {
  readonly runRoot: string;
  readonly inputs: Inputs;
  readonly modelSide: ModelSide;
  readonly binary: (line: OpenCodeLine) => Promise<OpenCodeBinary>;
  /** Writes a per-case artifact into the run folder (gitignored). */
  readonly save: (name: string, data: unknown) => Promise<void>;
};

export const createCaseContext = (runRoot: string, inputs: Inputs, modelSide: ModelSide): CaseContext => {
  const cache = new Map<OpenCodeLine, Promise<OpenCodeBinary>>();
  return {
    runRoot,
    inputs,
    modelSide,
    binary: async (line) => {
      const hit = cache.get(line);
      if (hit !== undefined) return hit;
      const next = resolveOpenCodeBinary(line);
      cache.set(line, next);
      return next;
    },
    save: async (name, data) => {
      await writeFile(path.join(runRoot, name), typeof data === "string" ? data : JSON.stringify(data, null, 2));
    },
  };
};

export type TaskOptions = {
  readonly name: string;
  readonly upstream: Upstream;
  readonly line?: OpenCodeLine;
  readonly permissions?: readonly PermissionRule[];
  readonly decidePermission?: PermissionDecider;
  readonly answerElicitation?: ElicitationResponder;
  readonly advertiseElicitation?: boolean;
  /** Replaces the default custom provider, e.g. a catalog provider. */
  readonly provider?: (proxy: KeyProxy) => { readonly spec: ProviderSpec; readonly model: string };
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly experimental?: Readonly<Record<string, boolean>>;
  readonly onEvent?: (event: DriverEvent) => void;
  readonly reapOnCancel?: boolean;
};

export type Task = {
  readonly id: TaskId;
  readonly dirs: TaskDirs;
  readonly branch: string;
  readonly proxy: KeyProxy;
  readonly env: Readonly<Record<string, string>>;
  readonly binary: OpenCodeBinary;
  readonly model: string;
  readonly realKey: string;
  readonly createdAt: number;
  readonly launch: AgentLaunch;
  driver: AcpDriver;
  /** A new driver and agent process on the same task dirs (a runner restart). */
  readonly restart: () => Promise<AcpDriver>;
  readonly close: () => Promise<void>;
};

export const initWorkspace = async (dirs: TaskDirs, branch: string): Promise<void> => {
  const git = async (...args: string[]): Promise<void> => {
    await run("git", ["-C", dirs.workspace, ...args], { windowsHide: true });
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "ostra spike");
  await git("config", "user.email", "spike@ostra.invalid");
  await git("config", "core.autocrlf", "false");
  await writeFile(path.join(dirs.workspace, "README.md"), "hello\n");
  await writeFile(path.join(dirs.workspace, "notes.txt"), "notes\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");
  await git("checkout", "-q", "-b", branch);
};

const stubSpec = (format: StubFormat, proxy: KeyProxy, cost: boolean): ProviderSpec => ({
  kind: "custom",
  id: `ostra-${format}`,
  format,
  baseUrl: proxy.agentBaseUrl,
  keyEnv: KEY_ENV,
  models: [
    { id: STUB_MODEL, ...(cost ? { cost: { input: 3, output: 15 } } : {}) },
    { id: STUB_MODEL_ALT, ...(cost ? { cost: { input: 1, output: 5 } } : {}) },
  ],
});

export const startTask = async (ctx: CaseContext, options: TaskOptions): Promise<Task> => {
  const createdAt = Date.now();
  const id = taskId(`${options.name}-${randomBytes(3).toString("hex")}`);
  const dirs = await createTaskDirs(path.join(ctx.runRoot, id));
  const branch = `ostra/${options.name}`;
  await initWorkspace(dirs, branch);

  const { upstream } = options;
  const upstreamBaseUrl = upstream.kind === "stub" ? ctx.modelSide.stubs[upstream.format].baseUrl : upstream.endpoint.baseUrl;
  const realKey = upstream.kind === "stub" ? ctx.modelSide.stubKeys[upstream.format] : upstream.endpoint.apiKey;
  const proxy = await startKeyProxy({
    upstreamBaseUrl,
    realKey,
    upstreamAuth: upstream.format === "anthropic" ? "x-api-key" : "bearer",
    taskId: id,
  });
  try {
    return await buildTask(ctx, options, { id, dirs, branch, proxy, realKey, createdAt });
  } catch (error) {
    // Nothing of a task that failed to start may stay behind: the agent is
    // killed by the driver itself, the proxy here.
    await proxy.close();
    throw error;
  }
};

type TaskParts = { readonly id: TaskId; readonly dirs: TaskDirs; readonly branch: string; readonly proxy: KeyProxy; readonly realKey: string; readonly createdAt: number };

const buildTask = async (ctx: CaseContext, options: TaskOptions, parts: TaskParts): Promise<Task> => {
  const { id, dirs, branch, proxy, realKey, createdAt } = parts;
  const { upstream } = options;

  const line = options.line ?? "v2";
  const binary = await ctx.binary(line);
  const chosen =
    options.provider?.(proxy) ??
    (upstream.kind === "stub"
      ? { spec: stubSpec(upstream.format, proxy, true), model: `ostra-${upstream.format}/${STUB_MODEL}` }
      : {
          spec: {
            kind: "custom",
            id: `ostra-${upstream.format}`,
            format: upstream.format,
            baseUrl: proxy.agentBaseUrl,
            keyEnv: KEY_ENV,
            models: [{ id: upstream.endpoint.modelId }],
          } satisfies ProviderSpec,
          model: `ostra-${upstream.format}/${upstream.endpoint.modelId}`,
        });
  const configInput = {
    providers: [chosen.spec],
    model: chosen.model,
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.experimental === undefined ? {} : { experimental: options.experimental }),
  };
  await writeOpenCodeConfig(dirs, line === "v2" ? buildOpenCodeConfig(configInput) : buildOpenCodeV1Config(configInput));

  const env = buildAgentEnv({ dirs, fakeKeys: { [KEY_ENV]: proxy.fakeKey }, ...(options.extraEnv === undefined ? {} : { extra: options.extraEnv }) });
  const launch = openCodeAcpLaunch(binary, dirs, env);
  const spawnDriver = async (): Promise<AcpDriver> => {
    const driver = await startAcpDriver({
      taskId: id,
      launch,
      decidePermission: options.decidePermission ?? allowOnce,
      answerElicitation: options.answerElicitation ?? declineQuestions,
      onSpawn: (pid) => {
        trackPid(pid);
      },
      ...(options.advertiseElicitation === undefined ? {} : { advertiseElicitation: options.advertiseElicitation }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.reapOnCancel === undefined ? {} : { reapOnCancel: options.reapOnCancel }),
    });
    void driver.exited.then(() => {
      untrackPid(driver.pid);
    });
    return driver;
  };

  const task: Task = {
    id,
    dirs,
    branch,
    proxy,
    env,
    binary,
    model: chosen.model,
    realKey,
    createdAt,
    launch,
    driver: await spawnDriver(),
    restart: async () => {
      task.driver = await spawnDriver();
      return task.driver;
    },
    close: async () => {
      await task.driver.stop();
      await writeFile(path.join(dirs.root, "agent-stderr.txt"), task.driver.stderrTail()).catch(() => undefined);
      await proxy.close();
    },
  };
  return task;
};

/** Runs `work` with a task, always closing it. */
export const withTask = async <T,>(ctx: CaseContext, options: TaskOptions, work: (task: Task) => Promise<T>): Promise<T> => {
  const task = await startTask(ctx, options);
  try {
    return await work(task);
  } finally {
    await task.close();
  }
};

export const newSession = async (task: Task): Promise<SessionId> => (await task.driver.newSession({ cwd: task.dirs.workspace, mcpServers: [] })).sessionId;

export const elapsed = (from: number): number => Date.now() - from;

export const withTimeout = async <T,>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${what} did not finish within ${String(ms)} ms`));
      }, ms).unref();
    }),
  ]);

export const gitHead = async (dirs: TaskDirs): Promise<{ branch: string; clean: boolean }> => {
  const branch = (await run("git", ["-C", dirs.workspace, "rev-parse", "--abbrev-ref", "HEAD"], { windowsHide: true })).stdout.trim();
  const status = (await run("git", ["-C", dirs.workspace, "status", "--porcelain"], { windowsHide: true })).stdout.trim();
  return { branch, clean: status === "" };
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
};

/** Stub calls made since the task started. Cases run one at a time, so these are the task's. */
export const stubCallsFor = (ctx: CaseContext, task: Task, format: StubFormat): StubServer["calls"] =>
  ctx.modelSide.stubs[format].calls.filter((c) => c.at >= task.createdAt);

/** Polls a driver's event log until `predicate` holds. */
export const waitForEvent = async (driver: AcpDriver, predicate: (event: DriverEvent) => boolean, ms: number, what: string): Promise<DriverEvent> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = driver.events.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`${what}: not seen within ${String(ms)} ms`);
    if (!driver.isRunning()) throw new Error(`${what}: the agent exited first`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

export const isToolCall = (event: DriverEvent): boolean => event.kind === "session_update" && event.update.sessionUpdate === "tool_call";

/** A marker unique to this run and purpose, for finding processes by command line. */
export const marker = (ctx: CaseContext, purpose: string): string => `ostra-marker-${path.basename(ctx.runRoot).slice(-13)}-${purpose}-${randomBytes(2).toString("hex")}`;

export const processesWithMarker = async (mark: string): Promise<number[]> =>
  (await listProcesses()).filter((p) => p.commandLine.includes(mark) && p.pid !== process.pid).map((p) => p.pid);

export type ChildRunner = {
  readonly pid: number;
  readonly lines: readonly Record<string, unknown>[];
  readonly waitFor: (event: string, ms: number) => Promise<Record<string, unknown>>;
  readonly exited: Promise<number | null>;
  readonly kill: () => void;
};

/** Starts `runner-child.ts` on a job, in its own Node process. */
export const startChildRunner = async (ctx: CaseContext, name: string, job: Job): Promise<ChildRunner> => {
  const file = path.join(ctx.runRoot, `${name}-job.json`);
  await writeFile(file, JSON.stringify(job));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "runner-child.ts"), file], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines: Record<string, unknown>[] = [];
  const line = z.record(z.string(), z.unknown());
  const spawnedLine = z.looseObject({ event: z.literal("spawned"), pid: z.number().int().positive(), at: z.number() });
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const raw: unknown = JSON.parse(text);
        const parsed = line.safeParse(raw);
        if (parsed.success) lines.push(parsed.data);
        // The child's own agents, so the final sweep can find them if the child dies first.
        const agent = spawnedLine.safeParse(raw);
        if (agent.success) trackPid(agent.data.pid, agent.data.at);
      } catch {
        // Not a result line.
      }
      newline = buffer.indexOf("\n");
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8000);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      if (child.pid !== undefined) untrackPid(child.pid);
      void writeFile(path.join(ctx.runRoot, `${name}-stderr.txt`), stderr).catch(() => undefined);
      resolve(code);
    });
  });
  const pid = child.pid ?? -1;
  trackPid(pid);
  return {
    pid,
    lines,
    exited,
    kill: () => {
      child.kill("SIGKILL");
    },
    waitFor: async (event, ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = lines.find((l) => l["event"] === event);
        if (found !== undefined) return found;
        const failed = lines.find((l) => l["event"] === "error");
        if (failed !== undefined) throw new Error(`child runner failed: ${String(failed["message"])}`);
        if (Date.now() > deadline) throw new Error(`child runner: no ${event} within ${String(ms)} ms`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
};
