import { DockerExecutor } from "@ostra/adapter-executor-docker";
import { silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, AgentCommandResult, AppPortReach, AppProcessHandle, ExecutorAdapter, ProcessExit, StartAppProcessInput } from "@ostra/adapter-sdk";
import { boxIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ExecutorKind, ReservedPorts, TaskSpec, TaskSpecAppProcess } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { createAppProcesses } from "./app-processes.ts";
import type { AppEvent } from "./app-processes.ts";

// The app's processes against a fake executor (milestone 8's ticket 12): the rules that need no
// running app. A service as a preview by the executor (ADR 0029's first difference on `host`), the
// services' in-box addresses in each process's environment, and a stop that comes while the
// executor is still starting a process. The executors' own runs are `app-processes.{host,docker,
// kubernetes}.test.ts`.

const repoId = repoIdSchema.parse("repo-app");
const box = { taskId: taskIdSchema.parse("0196f1a0-app-unit"), boxId: boxIdSchema.parse("box-app-unit") };

const reserved: ReservedPorts = { "key-proxy": 41_001, "git-proxy": 41_002, "mcp-proxy": 41_003, "sidecar-control": null, "agent-loopback": null, browser: null };

const processOf = (name: string, port: number, primary = false): TaskSpecAppProcess => ({
  name,
  repoId,
  folder: ".",
  command: `run ${name}`,
  port,
  ready: { kind: "command", command: "true" },
  label: name.toUpperCase(),
  primary,
  hostRewrite: true,
});

const specOf = (processes: readonly TaskSpecAppProcess[]): TaskSpec => {
  const [repo] = taskSpecFixture.repos;
  if (repo === undefined) throw new Error("the fixture has a repo");
  return {
    ...taskSpecFixture,
    repos: [{ ...repo, repoId, checkoutDir: "app" }],
    environment: { ...taskSpecFixture.environment, repos: [{ repoId, variables: [], files: [], envFile: ".env" }], appProcesses: [...processes] },
    services: [
      { name: "mailpit", image: "axllent/mailpit:v1.21", port: 8025, variables: [], healthCheck: null, preview: { label: "Mail" } },
      { name: "postgres", image: "postgres:17", port: 5432, variables: [], healthCheck: null, preview: null },
    ],
  };
};

/** An executor whose processes run until stopped, and whose ready commands pass; `hold` keeps a start pending until released. */
const fakeExecutor = (options: { readonly hold?: Promise<void> } = {}) => {
  const launches: StartAppProcessInput["launch"][] = [];
  const exits = new Map<string, (exit: ProcessExit) => void>();
  const executor: Pick<ExecutorAdapter, "startAppProcess" | "stopAppProcess" | "reachAppPort" | "runAgentCommand" | "capabilities"> = {
    // A pod's: the app at its `localhost`, so a port check dials it.
    capabilities: { ...DockerExecutor.defaultCapabilities, appReach: "loopback" },
    startAppProcess: async (input): Promise<AdapterResult<AppProcessHandle>> => {
      launches.push(input.launch);
      await options.hold;
      const exited = new Promise<ProcessExit>((resolve) => {
        exits.set(input.launch.name, resolve);
      });
      return { ok: true, value: { name: input.launch.name, pid: 4242, logPath: `/task/.ostra/app/${input.launch.name}.log`, exited } };
    },
    stopAppProcess: (input): Promise<AdapterResult<ProcessExit>> => {
      exits.get(input.name)?.({ code: null, signal: "SIGTERM" });
      return Promise.resolve({ ok: true, value: { code: null, signal: "SIGTERM" } });
    },
    // No app listens here: a port check finds it free, and the ready checks are commands.
    reachAppPort: (input): Promise<AdapterResult<AppPortReach>> => Promise.resolve({ ok: true, value: { host: "localhost", port: input.port === 0 ? 1 : 9, close: () => Promise.resolve() } }),
    runAgentCommand: (): Promise<AdapterResult<AgentCommandResult>> => Promise.resolve({ ok: true, value: { exitCode: 0, stdout: "" } }),
  };
  return { executor, launches };
};

const appOn = (executorKind: ExecutorKind, processes: readonly TaskSpecAppProcess[], executor = fakeExecutor().executor) => {
  const events: AppEvent[] = [];
  const app = createAppProcesses({
    executor,
    box,
    spec: specOf(processes),
    executorKind,
    workspaceDir: "/task/workspace",
    logDir: "/task/.ostra/app",
    secrets: [],
    baseEnv: { PATH: "/usr/bin" },
    shell: "bash",
    reservedPorts: reserved,
    ownPorts: [41_001, 41_002, 41_003, 41_004],
    emit: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    uploadLog: () => Promise.resolve(null),
    logger: silentLogger,
    timing: { readyIntervalMs: 10, readyTimeoutMs: 2_000, stopGraceMs: 10 },
  });
  return { app, events };
};

describe("the app's processes, by their rules (F-140, F-141)", () => {
  it("F-140/c3,c12: a service marked as a preview is listed after the processes on docker and kubernetes, and never on host, which runs no services", () => {
    const processes = [processOf("api", 3001), processOf("web", 5173, true)];
    for (const executor of ["docker", "kubernetes"] as const) {
      expect(appOn(executor, processes).app.previews().map((item) => [item.key, item.label, item.port, item.primary])).toEqual([
        ["app-web", "WEB", 5173, true],
        ["app-api", "API", 3001, false],
        ["service-mailpit", "Mail", 8025, false],
      ]);
    }
    expect(appOn("host", processes).app.previews().map((item) => item.key)).toEqual(["app-web", "app-api"]);
  });

  it("F-140/c6: each process gets every app process's address at localhost, and each service's by its name on docker, at localhost on kubernetes, none on host", async () => {
    const processes = [processOf("api", 3001), processOf("web", 5173, true)];
    const expected = {
      docker: { OSTRA_SERVICE_MAILPIT_URL: "http://mailpit:8025", OSTRA_SERVICE_POSTGRES_URL: "http://postgres:5432" },
      kubernetes: { OSTRA_SERVICE_MAILPIT_URL: "http://localhost:8025", OSTRA_SERVICE_POSTGRES_URL: "http://localhost:5432" },
      host: {},
    } as const;
    for (const kind of ["docker", "kubernetes", "host"] as const) {
      const fake = fakeExecutor();
      const { app } = appOn(kind, processes, fake.executor);
      await app.start(null);
      for (const launch of fake.launches) {
        expect(launch.command).toBe("bash");
        expect(launch.args).toEqual(["-lc", `run ${launch.name}`]);
        expect(launch.cwd.replaceAll("\\", "/")).toBe("/task/workspace/app");
        const ostra = Object.fromEntries(Object.entries(launch.env).filter(([name]) => name.startsWith("OSTRA_")));
        expect(ostra).toEqual({ OSTRA_APP_API_URL: "http://localhost:3001", OSTRA_APP_WEB_URL: "http://localhost:5173", ...expected[kind] });
      }
      await app.stopAll();
    }
  });

  it("F-140/c4: a stop that comes while the executor is still starting a process goes up once as stopped, and the process is ended when it starts", async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeExecutor({ hold });
    const { app, events } = appOn("docker", [processOf("api", 3001)], fake.executor);
    const started = app.start(["api"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.stop(["api"]);
    release();
    const views = await started;
    expect(views.map((view) => [view.name, view.state, view.reason])).toEqual([["api", "stopped", "stopped"]]);
    const states = events.flatMap((event) => (event.kind === "app.process" ? [event.state] : []));
    expect(states).toEqual(["starting", "stopped"]);
  });

  it("F-140/c9, F-141/c4: show_preview refuses each of the box's own ports, by name or by its number, and one the box keeps at a fixed number", async () => {
    const { app, events } = appOn("docker", [processOf("web", 5173, true)]);
    for (const port of [41_001, 41_002, 41_003, 41_004, 7101]) {
      const answer = await app.announce({ port, label: "Own" });
      expect(answer, String(port)).toEqual({ text: `Port ${String(port)} isn't allowed: it's one of this box's own ports, not the app's.`, isError: true });
    }
    expect(events).toEqual([]);
    expect((await app.announce({ port: 4100, label: "Docs", primary: true })).text).toBe("Another preview is already the primary. Show this one without primary.");
    expect((await app.announce({ port: 4100, label: "Docs" })).isError).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "preview.list" });
  });
});
