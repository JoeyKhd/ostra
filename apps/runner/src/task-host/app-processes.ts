import { open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { dialApp } from "@ostra/adapter-sdk";
import type { AppPortReach, AppProcessHandle, BoxRef, ExecutorAdapter, Logger } from "@ostra/adapter-sdk";
import {
  appAddresses,
  appToolRefusal,
  appToolRefusalText,
  boxPortRefusal,
  inBoxAppAddress,
  mayReach,
  previewTargets,
  runnerLimits,
  SHOW_PREVIEW_TOOL,
  showPreviewResultText,
  START_APP_TOOL,
  startAppResultText,
} from "@ostra/protocol";
import type {
  AnnouncedPreview,
  AppProcessReason,
  AppToolRefusal,
  AppProcessState,
  BlobId,
  ExecutorKind,
  PreviewListItem,
  Reach,
  RepoSecret,
  RepoId,
  ReservedPorts,
  ShowPreviewInput,
  StartAppProcessResult,
  TaskEventOf,
  TaskSpec,
  TaskSpecAppProcess,
} from "@ostra/protocol";

import { slashed } from "./app-block.ts";

// The app's processes in one box (F-140, ADR 0068, milestone 8's ticket 12): the same code on every
// executor, as the runner's task host drives the box (in the sidecar on `docker` and `kubernetes`,
// in the runner on `host`).
//
// - **Starting them.** Nothing starts until something asks: the agent's `start_app`, an `app.start`
//   command, "Start the app" (`dispatch.purpose: "app"`), and later the after-turn screenshots and an
//   opened preview (tickets 13 and 18). Those that aren't running start in the environment's order,
//   each after the one before it is ready or has failed, one start at a time. Each runs through the
//   executor's argument array as `<setup shell> -lc <command>`: the shell only because the command
//   is the project's own line, run in its repo's folder, never with ticket or agent text in it.
// - **Its environment** is the setup script's: the runner's base variables, then the repo's variables
//   and secrets that the setup gets (`availableDuringSetup`), then every app process's and service's
//   in-box address, `OSTRA_APP_<NAME>_URL` and `OSTRA_SERVICE_<NAME>_URL` (`appAddresses`), and no
//   browser-facing URL.
// - **Ready** when its check passes, tried every 2 s for at most 120 s: an HTTP `GET` of its path
//   answering below 500, its command exiting 0, or its port taking a connection. A port something
//   in the box already holds (the agent's own dev server) isn't started on: `failed` with
//   `port-in-use`.
// - **Its states** go up as `app.process`, as the domain's lifecycle has them: `starting`, then
//   `ready` or `failed`; then `exited` when it ends on its own, or `stopped` when ostra stopped it
//   (`app.stop`, the box's end). A process that exits names the last 64 KiB of its log as an `app-log`
//   blob of the task. Its log is written by the executor at `.ostra/app/<name>.log` in the task's
//   folder, never in a repo; its text, its command and its environment are never in a log line.
// - **A stop wins** over every start asked before it, wherever that start is: one still checking its
//   port starts nothing and sends nothing; one that sent `starting` goes up `stopped` once, and what
//   it spawns is ended; one getting ready never goes up `ready`. A start asked after a stop starts
//   afresh, once the stopped run has ended. Each start checks for a stop after every wait and
//   before every state it sends (`startOne`).
// - **Previews** (F-141): the task's list, primary first (`previewTargets`), with the ports the agent
//   announced with `show_preview`, each checked against the box's own ports first (`boxPortRefusal`,
//   `mayReach`'s rule) and the limit. The list goes up as `preview.list` when the box starts and
//   whenever it changes.

/** How long things take, from the protocol's working values; tests shorten them. */
export type AppTiming = {
  /** How often a ready check is tried. */
  readonly readyIntervalMs: number;
  /** How long a process has to get ready. */
  readonly readyTimeoutMs: number;
  /** How long a process has to exit after a polite signal before its tree is killed. */
  readonly stopGraceMs: number;
  /** How long past a stop's grace its exit may take to go up before the stop goes up without it. */
  readonly stopReportMs: number;
};

export const defaultAppTiming: AppTiming = {
  readyIntervalMs: runnerLimits.appReadyIntervalMs,
  readyTimeoutMs: runnerLimits.appReadyTimeoutSeconds * 1000,
  stopGraceMs: 5_000,
  stopReportMs: 10_000,
};

/** How long one HTTP ready check may take: a dev server compiles on its first request. */
const HTTP_CHECK_MS = 10_000;
/** How long a port takes to answer before the check counts it as closed. */
const DIAL_MS = 2_000;

/**
 * Whether the box's `localhost:<port>` takes a connection, asked inside the box: bash's own
 * `/dev/tcp`, which tries every address `localhost` has, IPv6 and IPv4. For `docker`, whose
 * forwarder takes every connection itself and only then dials the app, so a dial from outside
 * can't tell. The script is fixed and the port is its argument: nothing of a process's goes in.
 */
const IN_BOX_PORT_CHECK = ': </dev/tcp/localhost/"$1"';

/** The app's events, which the task run sends on its channel when its server reads them. */
export type AppEvent = TaskEventOf<"app.process"> | TaskEventOf<"preview.list">;

export type AppProcessesOptions = {
  readonly executor: Pick<ExecutorAdapter, "startAppProcess" | "stopAppProcess" | "reachAppPort" | "runAgentCommand" | "capabilities">;
  readonly box: BoxRef;
  readonly spec: TaskSpec;
  /** Where the box runs: it decides the services' addresses and whether they're previews (`host` runs none). */
  readonly executorKind: ExecutorKind;
  /** The repos side by side, as the box sees them (`CreatedBox.workspaceDir`). */
  readonly workspaceDir: string;
  /** Where the logs go, as the agent reads it (`CreatedBox.appLogDir`): the paths `start_app` gives before a start. */
  readonly logDir: string | null;
  /** The environment's secrets per repo, from the task's credentials. Never logged. */
  readonly secrets: readonly { readonly repoId: RepoId; readonly entries: readonly RepoSecret[] }[];
  /** The variables a program needs to run at all, as the setup script gets them (`baseEnv`). */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** The setup shell, which runs each command line (`OSTRA_RUNNER_SHELL`). */
  readonly shell: string;
  /** The box's own ports by name, which no process and no preview may take. */
  readonly reservedPorts: ReservedPorts;
  /** Every port the box's sidecar (or the runner on `host`) listens on for the task: none is a preview. */
  readonly ownPorts: readonly number[];
  readonly emit: (event: AppEvent) => Promise<void>;
  /** Uploads a log's tail as an `app-log` blob of the task; `null` when it couldn't. Never logged. */
  readonly uploadLog: (bytes: Uint8Array) => Promise<BlobId | null>;
  readonly logger: Logger;
  readonly timing?: Partial<AppTiming>;
};

/** Why ostra ends a process it started. */
type EndingReason = Extract<AppProcessReason, "stopped" | "box-stopped" | "ready-timeout">;
/** Why a stop came: `app.stop`, or the box's end. */
type StopReason = Extract<EndingReason, "stopped" | "box-stopped">;

/**
 * One start of a process: its handle, whether its exit came, why ostra is ending it (if it is),
 * and `done`, resolved once its last state went up (`finish`): at its exit, or when a stop's exit
 * didn't come in time. Every wait for a run's end waits on `done`, which a stop bounds.
 */
type Run = {
  readonly handle: AppProcessHandle;
  exited: boolean;
  ending: EndingReason | undefined;
  readonly done: Promise<void>;
  readonly markDone: () => void;
};

const newRun = (handle: AppProcessHandle): Run => {
  let markDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  return { handle, exited: false, ending: undefined, done, markDone };
};

/** An app process in this box: the domain's lifecycle (`AppProcessLifecycle`), as the runner holds it. */
type Slot =
  | { readonly state: "idle" }
  | { readonly state: "starting"; readonly run: Run | undefined }
  | { readonly state: "ready"; readonly run: Run }
  | { readonly state: "exited" | "failed" | "stopped"; readonly reason: AppProcessReason; readonly exitCode: number | null };

/** One process as `start_app` and the commands read it. */
export type AppProcessView = StartAppProcessResult;

export type AppProcesses = {
  /** Whether the environment declares any app process. */
  readonly any: boolean;
  /** The names the environment declares, in its order. */
  readonly names: readonly string[];
  /**
   * Starts these processes (or all, `null`) that aren't running, in the environment's order, each
   * after the one before it is ready or failed. Resolves with each named process as it is then.
   */
  readonly start: (names: readonly string[] | null) => Promise<readonly AppProcessView[]>;
  /** Stops these (or all) with their trees: `stopped`. Resolves once each has exited. */
  readonly stop: (names: readonly string[] | null) => Promise<void>;
  /** The box is stopping: every running process is stopped now, its end `box-stopped`, before the box's own stop. */
  readonly stopAll: () => Promise<void>;
  readonly views: () => readonly AppProcessView[];
  /** `start_app`: the start, in words for the agent, or its refusal. */
  readonly startForTool: (names: readonly string[] | null) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /** `show_preview`: the port added to the task's previews, or its refusal, in words for the agent. */
  readonly announce: (input: ShowPreviewInput) => Promise<{ readonly text: string; readonly isError: boolean }>;
  readonly previews: () => readonly PreviewListItem[];
  /** Sends the previews' list: at the box's start, and whenever it changes. */
  readonly sendPreviewList: () => Promise<void>;
  /**
   * The reach rule for a view's stream (ticket 22, ADR 0068): `mayReach` against the task's
   * previews and the box's own ports by name, and every port the box listens on for the task.
   */
  readonly reach: (port: number) => Reach;
  /**
   * Resolves once the process isn't starting and no start asked for it is still pending, or after
   * `timeoutMs`: a view's stream to an app that's getting ready waits for it (ticket 22).
   */
  readonly settled: (name: string, timeoutMs: number) => Promise<void>;
  /**
   * Ticket 13: whether a port is the box's own (below 1024, a reserved port by name or number, or
   * one the sidecar listens on for the task), as the app tools refuse it; `null` when it may be an app's.
   */
  readonly refusePort: (port: number) => AppToolRefusal | null;
  /** Ticket 13: how long a process has to get ready, which the after-turn screenshots wait at most. */
  readonly readyTimeoutMs: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** The last `maxBytes` of a file; empty when it can't be read. Its content is never logged. */
export const readTail = async (file: string, maxBytes: number): Promise<Buffer> => {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, size - length);
      return tail;
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.alloc(0);
  }
};

/** Whether a port takes a connection where the runner reaches it at the box's `localhost` (`host`, `kubernetes`). */
const dialAnswers = (reach: Pick<AppPortReach, "host" | "port">): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = dialApp(reach.host, reach.port);
    let settled = false;
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, DIAL_MS);
    socket.once("error", () => {
      finish(false);
    });
    socket.once("connect", () => {
      finish(true);
    });
  });

/** An HTTP `GET` of `path` on the app's port: its status, or `null` when nothing answered. The answer's body is never read. */
const httpStatus = (reach: Pick<AppPortReach, "host" | "port">, port: number, requestPath: string): Promise<number | null> =>
  new Promise((resolve) => {
    const request = httpRequest(
      {
        host: reach.host,
        port: reach.port,
        path: requestPath,
        method: "GET",
        // The app's own name for itself: a dev server checks `Host` (Vite allows `localhost`).
        headers: { host: `localhost:${String(port)}`, accept: "*/*" },
        // `localhost` over IPv6 and IPv4 (spike 08): a dev server told `localhost` may listen on `::1` only.
        createConnection: () => dialApp(reach.host, reach.port),
        timeout: HTTP_CHECK_MS,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.once("timeout", () => {
      request.destroy();
    });
    request.once("error", () => {
      resolve(null);
    });
    request.end();
  });

export const createAppProcesses = (options: AppProcessesOptions): AppProcesses => {
  const log = options.logger.child({ component: "app-processes" });
  const timing: AppTiming = { ...defaultAppTiming, ...options.timing };
  const processes: readonly TaskSpecAppProcess[] = options.spec.environment.appProcesses ?? [];
  const slots = new Map<string, Slot>(processes.map((process) => [process.name, { state: "idle" }]));
  const forwarded = options.executor.capabilities.appReach === "forwarder";
  const ownPorts = new Set(options.ownPorts);
  const announced: AnnouncedPreview[] = [];
  /** How many starts asked for each process haven't run it yet, or are running it: a view's stream waits for them. */
  const pendingStarts = new Map<string, number>();
  /** Streams waiting for a process to be ready or settled: woken at each state it reports. */
  const settledWaiters = new Set<() => void>();
  const wakeSettled = (): void => {
    for (const waiter of [...settledWaiters]) {
      settledWaiters.delete(waiter);
      waiter();
    }
  };
  /**
   * How many stops each process has had (`app.stop`, the box's end), whether anything of it ran or
   * not. A start notes the count when it's asked, and a stop since then wins over it (`startOne`).
   * Ticket 13 counted the box's stops only, and only from the start's first step; a stop that came
   * while a start checked its port was lost, and the process got ready behind it.
   */
  const stopCounts = new Map<string, number>();
  const stopsOf = (name: string): number => stopCounts.get(name) ?? 0;
  /** Starts run one at a time: a second asks after the first, and finds what it started running. */
  let chain: Promise<unknown> = Promise.resolve();

  const services = options.spec.services ?? [];
  const addresses = appAddresses(processes, services, options.executorKind);

  /** The log's path as the agent reads it: the executor's once it started, else the box's folder's. */
  const logPathOf = (process: TaskSpecAppProcess): string => {
    const slot = slots.get(process.name);
    const handle = slot !== undefined && (slot.state === "starting" || slot.state === "ready") ? slot.run?.handle : undefined;
    if (handle !== undefined) {
      return slashed(handle.logPath);
    }
    return options.logDir === null ? `.ostra/app/${process.name}.log` : `${slashed(options.logDir).replace(/\/+$/, "")}/${process.name}.log`;
  };

  /** A process's state for `start_app` and the commands: `stopped` before its first start in the box. */
  const viewOf = (process: TaskSpecAppProcess): AppProcessView => {
    const slot = slots.get(process.name) ?? { state: "idle" };
    const state: AppProcessState = slot.state === "idle" ? "stopped" : slot.state;
    const ended = slot.state === "exited" || slot.state === "failed" || slot.state === "stopped";
    return {
      name: process.name,
      label: process.label,
      state,
      address: inBoxAppAddress(process.port),
      logPath: logPathOf(process).slice(0, 1024),
      reason: ended ? slot.reason : null,
      exitCode: ended ? slot.exitCode : null,
    };
  };

  const report = async (
    process: TaskSpecAppProcess,
    state: AppProcessState,
    detail: { readonly reason: AppProcessReason | null; readonly exitCode: number | null; readonly logBlobId: BlobId | null },
  ): Promise<void> => {
    // Names, states and numbers only: never the command, its environment or its log.
    log.info("app process", { taskId: options.box.taskId, boxId: options.box.boxId, app: process.name, state, reason: detail.reason, exitCode: detail.exitCode, logBlob: detail.logBlobId !== null });
    wakeSettled();
    await options.emit({ kind: "app.process", name: process.name, state, port: process.port, ...detail });
  };

  /** The log's tail as a blob of the task, for a process that ended on its own or failed. */
  const logBlob = async (handle: AppProcessHandle): Promise<BlobId | null> => {
    const tail = await readTail(handle.logPath, runnerLimits.appLogTailMaxBytes);
    if (tail.length === 0) {
      return null;
    }
    return options.uploadLog(tail);
  };

  /**
   * A start's end: the one place a running process's last state goes up, once. Its exit as the
   * executor reports it, or, when a stop's exit didn't come in time, the stop's own end.
   */
  const finish = async (process: TaskSpecAppProcess, run: Run, exitCode: number | null): Promise<void> => {
    try {
      const slot = slots.get(process.name);
      if (slot === undefined || (slot.state !== "starting" && slot.state !== "ready") || slot.run !== run) {
        return;
      }
      switch (run.ending) {
        case "stopped":
        case "box-stopped": {
          slots.set(process.name, { state: "stopped", reason: run.ending, exitCode });
          await report(process, "stopped", { reason: run.ending, exitCode, logBlobId: null });
          return;
        }
        case "ready-timeout": {
          slots.set(process.name, { state: "failed", reason: "ready-timeout", exitCode: null });
          await report(process, "failed", { reason: "ready-timeout", exitCode: null, logBlobId: await logBlob(run.handle) });
          return;
        }
        case undefined: {
          // It ended on its own: before it was ready it failed; after, it exited, whatever its code.
          const state = slot.state === "starting" ? "failed" : "exited";
          slots.set(process.name, { state, reason: "exited", exitCode });
          await report(process, state, { reason: "exited", exitCode, logBlobId: await logBlob(run.handle) });
          return;
        }
        default:
          run.ending satisfies never;
      }
    } finally {
      run.markDone();
    }
  };

  /**
   * Ends a start for `reason`: the executor stops its tree (a polite signal, then a kill after the
   * grace), and its exit goes up. An exit that doesn't come in time (a child that kept its output
   * open) goes up anyway, so a box's end never waits on it; a late one is then ignored.
   */
  const endRun = async (process: TaskSpecAppProcess, run: Run, reason: EndingReason): Promise<void> => {
    run.ending ??= reason;
    const stopping = options.executor.stopAppProcess({ box: options.box, name: process.name, graceMs: timing.stopGraceMs }).then((stopped) => {
      if (!stopped.ok && stopped.error.code !== "not-found") {
        log.warn("an app process didn't stop", { taskId: options.box.taskId, app: process.name, code: stopped.error.code });
      }
    });
    const reported = await Promise.race([run.done.then(() => true), sleep(timing.stopGraceMs + timing.stopReportMs).then(() => false)]);
    if (!reported) {
      log.warn("an app process's exit didn't come after its stop", { taskId: options.box.taskId, app: process.name });
      await finish(process, run, null);
    }
    void stopping.catch(() => undefined);
  };

  const envOf =(process: TaskSpecAppProcess): Record<string, string> => {
    const env: Record<string, string> = { ...options.baseEnv };
    const repo = options.spec.environment.repos.find((entry) => entry.repoId === process.repoId);
    for (const variable of repo?.variables ?? []) {
      if (variable.availableDuringSetup) {
        env[variable.name] = variable.value;
      }
    }
    for (const secret of options.secrets.find((entry) => entry.repoId === process.repoId)?.entries ?? []) {
      if (secret.kind === "variable" && secret.availableDuringSetup) {
        env[secret.name] = secret.value;
      }
    }
    // ostra's own addresses last: no repo variable stands in for them.
    Object.assign(env, addresses);
    return env;
  };

  /**
   * Whether something in the box listens on the port: dialled at `localhost` where the runner
   * shares it, and asked inside the box behind `docker`'s forwarder (`IN_BOX_PORT_CHECK`).
   */
  const portAnswers = async (reach: AppPortReach, port: number): Promise<boolean> => {
    if (!forwarded) {
      return dialAnswers(reach);
    }
    const ran = await options.executor.runAgentCommand({
      box: options.box,
      command: { command: options.shell, args: ["-c", IN_BOX_PORT_CHECK, "ostra-port-check", String(port)], env: { ...options.baseEnv }, cwd: options.workspaceDir },
      timeoutMs: DIAL_MS * 3,
    });
    return ran.ok && ran.value.exitCode === 0;
  };

  const cwdOf = (process: TaskSpecAppProcess): string | null => {
    const repo = options.spec.repos.find((entry) => entry.repoId === process.repoId);
    if (repo === undefined) {
      return null;
    }
    const folder = process.folder === "." ? [] : process.folder.split("/");
    return path.join(options.workspaceDir, repo.checkoutDir, ...folder);
  };

  /** One ready check, through the reach: never logged, nor its command. */
  const readyOnce = async (process: TaskSpecAppProcess, reach: AppPortReach, cwd: string, env: Readonly<Record<string, string>>, remainingMs: number): Promise<boolean> => {
    switch (process.ready.kind) {
      case "http": {
        const status = await httpStatus(reach, process.port, process.ready.path);
        return status !== null && status < 500;
      }
      case "port":
        return portAnswers(reach, process.port);
      case "command": {
        const ran = await options.executor.runAgentCommand({
          box: options.box,
          command: { command: options.shell, args: ["-lc", process.ready.command], env, cwd },
          timeoutMs: Math.max(1_000, Math.min(remainingMs, HTTP_CHECK_MS)),
        });
        return ran.ok && ran.value.exitCode === 0;
      }
      default:
        return process.ready satisfies never;
    }
  };

  /**
   * Whether a run is still getting ready: its exit hasn't come, no stop or timeout is ending it, and
   * it's still the slot's. A function, so each read is fresh across the waits.
   */
  const stillStarting = (process: TaskSpecAppProcess, run: Run): boolean => {
    const slot = slots.get(process.name);
    return !run.exited && run.ending === undefined && slot?.state === "starting" && slot.run === run;
  };

  /** Until it's ready, it ended (on its own, or a stop is ending it), or its time is up. */
  const awaitReady = async (process: TaskSpecAppProcess, run: Run, reach: AppPortReach, cwd: string, env: Readonly<Record<string, string>>): Promise<"ready" | "ended" | "timeout"> => {
    const deadline = Date.now() + timing.readyTimeoutMs;
    for (;;) {
      if (!stillStarting(process, run)) {
        return "ended";
      }
      const passed = await readyOnce(process, reach, cwd, env, deadline - Date.now());
      // A stop or an exit that came while the check ran wins over its answer.
      if (!stillStarting(process, run)) {
        return "ended";
      }
      if (passed) {
        return "ready";
      }
      if (Date.now() >= deadline) {
        return "timeout";
      }
      await Promise.race([sleep(Math.min(timing.readyIntervalMs, Math.max(0, deadline - Date.now()))), run.done]);
    }
  };

  const failNow = async (process: TaskSpecAppProcess, reason: AppProcessReason): Promise<void> => {
    slots.set(process.name, { state: "failed", reason, exitCode: null });
    await report(process, "failed", { reason, exitCode: null, logBlobId: null });
  };

  /**
   * One process's start, asked when the process had had `stopsAsked` stops. A stop since then wins
   * (`stoppedSince`), checked after every wait and before every state this sends: before `starting`
   * goes up it starts nothing and sends nothing; after, its stop went up as `stopped` (`stopRun`),
   * and what the executor spawned is ended; while it gets ready, `ready` never goes up.
   */
  const startOne = async (process: TaskSpecAppProcess, stopsAsked: number): Promise<void> => {
    const stoppedSince = (): boolean => stopsOf(process.name) !== stopsAsked;
    if (stoppedSince()) {
      return;
    }
    // A run a stop is ending: a start asked after that stop starts afresh once it has ended (a restart).
    const current = slots.get(process.name);
    const ending = current?.state === "starting" || current?.state === "ready" ? current.run : undefined;
    if (ending?.ending !== undefined) {
      await ending.done;
      if (stoppedSince()) {
        return;
      }
    }
    const now = slots.get(process.name);
    if (now?.state === "starting" || now?.state === "ready") {
      return;
    }
    const cwd = cwdOf(process);
    // A port the box keeps for itself is never an app's (the environment refuses it when saved, too).
    if (cwd === null || boxPortRefusal(process.port, options.reservedPorts) !== null || ownPorts.has(process.port)) {
      await failNow(process, "start-failed");
      return;
    }
    const reach = await options.executor.reachAppPort({ box: options.box, port: process.port, reserved: options.reservedPorts });
    if (!reach.ok) {
      if (!stoppedSince()) {
        await failNow(process, "start-failed");
      }
      return;
    }
    try {
      // Something in the box holds the port already, such as the agent's own dev server.
      const taken = await portAnswers(reach.value, process.port);
      // A stop (or the box's, ticket 13) came while its port was checked: nothing starts behind it.
      if (stoppedSince()) {
        return;
      }
      if (taken) {
        await failNow(process, "port-in-use");
        return;
      }
      slots.set(process.name, { state: "starting", run: undefined });
      await report(process, "starting", { reason: null, exitCode: null, logBlobId: null });
      // From here a stop goes up as `stopped` itself (`stopRun`), and this start sends nothing more.
      if (stoppedSince()) {
        return;
      }
      const env = envOf(process);
      const started = await options.executor.startAppProcess({
        box: options.box,
        // The project's own command line, one argument of the setup shell: never a line ostra built.
        launch: { name: process.name, command: options.shell, args: ["-lc", process.command], cwd, env },
      });
      if (!started.ok) {
        log.warn("an app process didn't start", { taskId: options.box.taskId, app: process.name, code: started.error.code });
        if (!stoppedSince()) {
          await failNow(process, "start-failed");
        }
        return;
      }
      // A stop came while the executor was starting it, and went up as `stopped`: it ends now, quietly.
      if (stoppedSince()) {
        await Promise.race([
          options.executor.stopAppProcess({ box: options.box, name: process.name, graceMs: timing.stopGraceMs }),
          sleep(timing.stopGraceMs + timing.stopReportMs),
        ]);
        return;
      }
      const run = newRun(started.value);
      slots.set(process.name, { state: "starting", run });
      const exited = (code: number | null): Promise<void> => {
        run.exited = true;
        return finish(process, run, code);
      };
      void started.value.exited
        .then(
          (exit) => exited(exit.code),
          () => exited(null),
        )
        .catch(() => undefined);
      const outcome = await awaitReady(process, run, reach.value, cwd, env);
      // Read again here: a stop or an exit since the check's answer wins over it.
      const settledAs = outcome === "ready" && !stillStarting(process, run) ? "ended" : outcome;
      switch (settledAs) {
        case "ready": {
          slots.set(process.name, { state: "ready", run });
          await report(process, "ready", { reason: null, exitCode: null, logBlobId: null });
          return;
        }
        case "timeout":
          await endRun(process, run, "ready-timeout");
          return;
        case "ended":
          // Its exit, or the stop ending it, sends its last state; `done` is bounded by the stop.
          await run.done;
          return;
        default:
          settledAs satisfies never;
      }
    } finally {
      await reach.value.close();
    }
  };

  const selected = (names: readonly string[] | null): readonly TaskSpecAppProcess[] =>
    names === null ? processes : processes.filter((process) => names.includes(process.name));

  const start = (names: readonly string[] | null): Promise<readonly AppProcessView[]> => {
    // Each process's stops as the start is asked: a stop after this wins over it (`startOne`).
    const asked = selected(names).map((process) => ({ process, stopsAsked: stopsOf(process.name) }));
    for (const { process } of asked) {
      pendingStarts.set(process.name, (pendingStarts.get(process.name) ?? 0) + 1);
    }
    const next = chain.then(async () => {
      log.info("starting the app's processes", { taskId: options.box.taskId, asked: asked.length });
      for (const { process, stopsAsked } of asked) {
        try {
          await startOne(process, stopsAsked);
        } finally {
          pendingStarts.set(process.name, (pendingStarts.get(process.name) ?? 1) - 1);
          wakeSettled();
        }
      }
      return asked.map(({ process }) => viewOf(process));
    });
    chain = next.catch(() => undefined);
    return next;
  };

  /** Whether a process is getting ready: starting now, or not running with a start asked for it still to run. */
  const gettingReady = (name: string): boolean => {
    const state = slots.get(name)?.state;
    return state === "starting" || (state !== "ready" && (pendingStarts.get(name) ?? 0) > 0);
  };

  const settled = async (name: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (gettingReady(name) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          settledWaiters.delete(waiter);
          resolve();
        }, Math.max(0, deadline - Date.now()));
        timer.unref();
        settledWaiters.add(waiter);
      });
    }
  };

  const reachRule = (port: number): Reach => {
    if (ownPorts.has(port)) {
      return { ok: false, refusal: { reason: "reserved", name: "mcp-proxy" } };
    }
    return mayReach(port, previews(), options.reservedPorts);
  };

  const stopRun = async (process: TaskSpecAppProcess, reason: StopReason): Promise<void> => {
    // Counted first, whatever runs: every start asked before it now starts nothing, or ends what it started.
    stopCounts.set(process.name, stopsOf(process.name) + 1);
    const slot = slots.get(process.name);
    if (slot === undefined || (slot.state !== "starting" && slot.state !== "ready")) {
      // Nothing runs. A start still checking its port went up as nothing, and sends nothing now.
      return;
    }
    const run = slot.run;
    if (run === undefined) {
      // `starting` went up and the executor is starting it: it goes up as stopped now, once, and
      // its start ends it the moment it runs (`startOne`).
      slots.set(process.name, { state: "stopped", reason, exitCode: null });
      await report(process, "stopped", { reason, exitCode: null, logBlobId: null });
      return;
    }
    await endRun(process, run, reason);
  };

  const stop = async (names: readonly string[] | null): Promise<void> => {
    await Promise.all(selected(names).map((process) => stopRun(process, "stopped")));
  };

  const stopAll = async (): Promise<void> => {
    await Promise.all(processes.map((process) => stopRun(process, "box-stopped")));
  };

  const previews = (): readonly PreviewListItem[] =>
    previewTargets(
      {
        processes: processes.map((process, position) => ({ name: process.name, port: process.port, label: process.label, primary: process.primary, position })),
        services: services.map((service) => ({ name: service.name, port: service.port, previewLabel: service.preview?.label ?? null })),
        // ADR 0029, difference 1: a `host` runner runs no services, so none is a preview there.
        servicesRun: options.executorKind !== "host",
      },
      announced,
    );

  const sendPreviewList = async (): Promise<void> => {
    await options.emit({ kind: "preview.list", previews: [...previews()] });
  };

  /** `mayReach`'s rule: never below 1024, never one of the box's own ports, by name or by number. */
  const refusePort = (port: number): AppToolRefusal | null => {
    const own = boxPortRefusal(port, options.reservedPorts) ?? (ownPorts.has(port) ? ({ reason: "reserved", name: "mcp-proxy" } as const) : null);
    return own === null ? null : { code: "port-not-allowed", port, why: own.reason };
  };

  const announce = async (input: ShowPreviewInput): Promise<{ readonly text: string; readonly isError: boolean }> => {
    // `mayReach`'s rule first.
    const own = refusePort(input.port);
    if (own !== null) {
      log.info("a preview refused", { taskId: options.box.taskId, port: input.port, reason: own.code === "port-not-allowed" ? own.why : own.code });
      return { text: appToolRefusalText(own), isError: true };
    }
    const listed = previews();
    const refused = appToolRefusal(
      { tool: SHOW_PREVIEW_TOOL, input },
      { reservedPorts: options.reservedPorts, processNames: processes.map((process) => process.name), previews: listed, attachmentsThisTurn: 0, browser: false },
    );
    if (refused !== null) {
      log.info("a preview refused", { taskId: options.box.taskId, port: input.port, reason: refused.code });
      return { text: appToolRefusalText(refused), isError: true };
    }
    const entry: AnnouncedPreview = { port: input.port, label: input.label, path: input.path ?? "/", primary: input.primary === true };
    const index = announced.findIndex((item) => item.port === input.port);
    if (index === -1) {
      announced.push(entry);
    } else {
      announced[index] = entry;
    }
    log.info("a preview announced", { taskId: options.box.taskId, port: input.port, primary: entry.primary, previews: previews().length });
    await sendPreviewList();
    return { text: showPreviewResultText({ label: input.label, port: input.port }), isError: false };
  };

  const startForTool = async (names: readonly string[] | null): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const refused = appToolRefusal(
      { tool: START_APP_TOOL, input: names === null ? {} : { names: [...names] } },
      {
        reservedPorts: options.reservedPorts,
        processNames: processes.map((process) => process.name),
        previews: previews(),
        attachmentsThisTurn: 0,
        browser: false,
      },
    );
    if (refused !== null) {
      return { text: appToolRefusalText(refused), isError: true };
    }
    const views = await start(names);
    return { text: startAppResultText({ processes: [...views] }), isError: views.some((view) => view.state !== "ready") };
  };

  return {
    any: processes.length > 0,
    names: processes.map((process) => process.name),
    start,
    stop,
    stopAll,
    views: () => processes.map(viewOf),
    startForTool,
    announce,
    previews,
    sendPreviewList,
    reach: reachRule,
    settled,
    refusePort,
    readyTimeoutMs: timing.readyTimeoutMs,
  };
};
