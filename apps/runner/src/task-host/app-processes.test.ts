import { DockerExecutor } from "@ostra/adapter-executor-docker";
import { silentLogger } from "@ostra/adapter-sdk";
import type { AdapterResult, AgentCommandResult, AppPortReach, AppProcessHandle, ExecutorAdapter, ProcessExit, StartAppProcessInput } from "@ostra/adapter-sdk";
import { boxIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ExecutorKind, ReservedPorts, TaskSpec, TaskSpecAppProcess } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it, vi } from "vitest";

import { createAppProcesses } from "./app-processes.ts";
import type { AppEvent, AppProcessView, AppTiming } from "./app-processes.ts";

// The app's processes against a fake executor (milestone 8's ticket 12): the rules that need no
// running app. A service as a preview by the executor (ADR 0029's first difference on `host`), the
// services' in-box addresses in each process's environment, and a stop at each step of a start
// (its port check, the executor's spawn, its ready check, a restart), each put there by a gate the
// fake waits on, never by a fixed time. The executors' own runs are `app-processes.{host,docker,
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

/** A gate a test opens: the fake waits on it at one step, so the test puts a stop exactly there. */
const gate = (): { readonly opened: Promise<void>; readonly open: () => void } => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

type FakeOptions = {
  /** Keeps each start with the executor until it resolves. */
  readonly hold?: Promise<void>;
  /** Runs at each port check (`reachAppPort`), which waits for it. */
  readonly portCheck?: () => Promise<void>;
  /** Runs at each ready check (a command), which passes when it answers `true`. */
  readonly readyCheck?: () => Promise<boolean>;
  /** When a stop's exit comes: at once (the default), once this resolves, or never. */
  readonly exitOnStop?: Promise<void> | "never";
};

/** An executor whose processes run until stopped, and whose ready commands pass, unless the test says otherwise at each step. */
const fakeExecutor = (options: FakeOptions = {}) => {
  const launches: StartAppProcessInput["launch"][] = [];
  const stops: string[] = [];
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
      stops.push(input.name);
      const exit = exits.get(input.name);
      if (options.exitOnStop === undefined) {
        exit?.({ code: null, signal: "SIGTERM" });
      } else if (options.exitOnStop !== "never") {
        void options.exitOnStop.then(() => exit?.({ code: null, signal: "SIGTERM" }));
      }
      return Promise.resolve({ ok: true, value: { code: null, signal: "SIGTERM" } });
    },
    // No app listens here: a port check finds it free, and the ready checks are commands.
    reachAppPort: async (input): Promise<AdapterResult<AppPortReach>> => {
      await options.portCheck?.();
      return { ok: true, value: { host: "localhost", port: input.port === 0 ? 1 : 9, close: () => Promise.resolve() } };
    },
    runAgentCommand: async (): Promise<AdapterResult<AgentCommandResult>> => {
      const passed = options.readyCheck === undefined ? true : await options.readyCheck();
      return { ok: true, value: { exitCode: passed ? 0 : 1, stdout: "" } };
    },
  };
  /** The process ends on its own with its code, as a crash. */
  const crash = (name: string, code: number): void => {
    exits.get(name)?.({ code, signal: null });
  };
  return { executor, launches, stops, crash };
};

/** Waits for what the fake saw, a few milliseconds at a time: never a fixed time, which a loaded machine outlasts. */
const until = (what: () => void): Promise<void> => vi.waitFor(what, { timeout: 10_000, interval: 2 });

const appOn = (executorKind: ExecutorKind, processes: readonly TaskSpecAppProcess[], executor = fakeExecutor().executor, timing: Partial<AppTiming> = {}) => {
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
    timing: { readyIntervalMs: 10, readyTimeoutMs: 2_000, stopGraceMs: 10, ...timing },
  });
  /** Each process's states in the order they went up. */
  const states = (): readonly string[] => events.flatMap((event) => (event.kind === "app.process" ? [`${event.name}:${event.state}`] : []));
  return { app, events, states };
};

/** Each process as `start` resolved with it: its name, state and reason. */
const shown = (views: readonly AppProcessView[]) => views.map((view) => [view.name, view.state, view.reason]);

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
    const hold = gate();
    const fake = fakeExecutor({ hold: hold.opened });
    const { app, states } = appOn("docker", [processOf("api", 3001)], fake.executor);
    const started = app.start(["api"]);
    // With the executor: `starting` went up, and its spawn waits for the gate.
    await until(() => {
      expect(fake.launches).toHaveLength(1);
    });
    await app.stop(["api"]);
    hold.open();
    expect(shown(await started)).toEqual([["api", "stopped", "stopped"]]);
    expect(states()).toEqual(["api:starting", "api:stopped"]);
    // Ended the moment it ran.
    expect(fake.stops).toEqual(["api"]);
  });

  it("F-140/c4: a stop that comes while a start still checks the process's port starts nothing and sends nothing", async () => {
    const checking = gate();
    const answer = gate();
    const fake = fakeExecutor({
      portCheck: () => {
        checking.open();
        return answer.opened;
      },
    });
    const { app, events } = appOn("docker", [processOf("api", 3001)], fake.executor);
    const started = app.start(["api"]);
    await checking.opened;
    await app.stop(["api"]);
    answer.open();
    expect(shown(await started)).toEqual([["api", "stopped", null]]);
    expect(fake.launches).toEqual([]);
    expect(events).toEqual([]);
  });

  it("F-140/c4: a stop that comes while a process's ready check runs wins over the check's late pass: stopped once, never ready", async () => {
    const checking = gate();
    const pass = gate();
    const exit = gate();
    const fake = fakeExecutor({
      readyCheck: async () => {
        checking.open();
        await pass.opened;
        return true;
      },
      // The executor's stop signals it, and its exit comes after the check passed.
      exitOnStop: exit.opened,
    });
    const { app, states } = appOn("docker", [processOf("api", 3001)], fake.executor);
    const started = app.start(["api"]);
    await checking.opened;
    const stopping = app.stop(["api"]);
    pass.open();
    await until(() => {
      expect(fake.stops).toEqual(["api"]);
    });
    exit.open();
    await stopping;
    expect(shown(await started)).toEqual([["api", "stopped", "stopped"]]);
    expect(states()).toEqual(["api:starting", "api:stopped"]);
  });

  it("F-140/c4: a process that exits on its own while its ready check runs fails with its code, and the check's late pass never makes it ready", async () => {
    const checking = gate();
    const pass = gate();
    const fake = fakeExecutor({
      readyCheck: async () => {
        checking.open();
        await pass.opened;
        return true;
      },
    });
    const { app, events, states } = appOn("docker", [processOf("api", 3001)], fake.executor);
    const started = app.start(["api"]);
    await checking.opened;
    fake.crash("api", 1);
    await until(() => {
      expect(states()).toEqual(["api:starting", "api:failed"]);
    });
    pass.open();
    expect(shown(await started)).toEqual([["api", "failed", "exited"]]);
    expect(states()).toEqual(["api:starting", "api:failed"]);
    expect(events.at(-1)).toMatchObject({ kind: "app.process", reason: "exited", exitCode: 1 });
  });

  it("F-140/c4: the box's stop during one process's ready check stops it, and the processes after it in the same start never start", async () => {
    const checking = gate();
    const pass = gate();
    const fake = fakeExecutor({
      readyCheck: async () => {
        checking.open();
        await pass.opened;
        return true;
      },
    });
    const { app, states } = appOn("docker", [processOf("api", 3001), processOf("web", 5173, true)], fake.executor);
    const started = app.start(null);
    await checking.opened;
    await app.stopAll();
    pass.open();
    expect(shown(await started)).toEqual([
      ["api", "stopped", "box-stopped"],
      ["web", "stopped", null],
    ]);
    expect(fake.launches.map((launch) => launch.name)).toEqual(["api"]);
    expect(states()).toEqual(["api:starting", "api:stopped"]);
    // A start asked after the box's stop (the box made ready again) starts as asked.
    expect(shown(await app.start(["web"]))).toEqual([["web", "ready", null]]);
  });

  it("F-140/c4: a start asked while a stop is still ending the process starts it again once it has exited", async () => {
    const exit = gate();
    const fake = fakeExecutor({ exitOnStop: exit.opened });
    const { app, states } = appOn("docker", [processOf("api", 3001)], fake.executor);
    expect(shown(await app.start(["api"]))).toEqual([["api", "ready", null]]);
    const stopping = app.stop(["api"]);
    const restarted = app.start(["api"]);
    await until(() => {
      expect(fake.stops).toEqual(["api"]);
    });
    exit.open();
    await stopping;
    expect(shown(await restarted)).toEqual([["api", "ready", null]]);
    expect(fake.launches).toHaveLength(2);
    expect(states()).toEqual(["api:starting", "api:ready", "api:stopped", "api:starting", "api:ready"]);
  });

  it("F-140/c4: a stop whose exit never comes goes up after its bound, and the next start still runs", async () => {
    // The first run never gets ready; the second does.
    const ready = { now: false, checks: 0 };
    const fake = fakeExecutor({
      exitOnStop: "never",
      readyCheck: () => {
        ready.checks += 1;
        return Promise.resolve(ready.now);
      },
    });
    const { app, states } = appOn("docker", [processOf("api", 3001)], fake.executor, { stopReportMs: 50 });
    const started = app.start(["api"]);
    await until(() => {
      expect(ready.checks).toBeGreaterThan(0);
    });
    await app.stop(["api"]);
    expect(shown(await started)).toEqual([["api", "stopped", "stopped"]]);
    ready.now = true;
    expect(shown(await app.start(["api"]))).toEqual([["api", "ready", null]]);
    expect(states()).toEqual(["api:starting", "api:stopped", "api:starting", "api:ready"]);
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
