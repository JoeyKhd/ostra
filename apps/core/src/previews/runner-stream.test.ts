import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { baseEnv, HostExecutor, localShellProbe, machineBrowserSource, resolveMachineBrowser, resolveSetupShell } from "@ostra/adapter-executor-host";
import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { fakeBrowserProgram, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  closeView,
  createPanelPreviewTokens,
  dispatchTask,
  newPreviewLinkToken,
  openView,
  panelPreviewPaths,
  postgresChangeNotices,
  postgresCommandOutbox,
  systemClock,
  takeMemberScreenshot,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { APP_RECORDING_CONTENT_TYPE, APP_SCREENSHOT_CONTENT_TYPE, boxIdSchema, inBoxAppAddress, leaseEpochSchema, previewKeySchema, previewSupportSchema, runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { BoxId, PreviewInputEvent, PreviewKey, PreviewPageControl, PreviewViewId, RunnerId, SessionId, TaskId, TaskSpec } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { boxBrowser, createAppPictures, createAppProcesses, createPreviewViews, createSharedPages, RUNNER_PREVIEW_SUPPORT, runnerServerLink, startConnection } from "@ostra/runner";
import type {
  AppPictures,
  AppProcesses,
  BoxBrowserHolder,
  CommandHandlers,
  CommandOutcome,
  PreviewViews,
  RunnerConnection,
  ServerLink,
  SessionChannel,
  SharedPages,
  StreamAim,
  Transport,
} from "@ostra/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createBlobService } from "../blobs/blob-service.ts";
import { createIngest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { handleBlobEndpoint } from "../blobs/endpoints.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { openPanelStream, startPreviewReplica } from "../testing/previews.ts";
import type { PanelStream, PreviewReplica } from "../testing/previews.ts";
import { registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 18 (F-141, F-121, ADR 0068 "The browser view"): core's real preview code
// (ticket 19: the box's preview connection, the HTTP carrier's frames, the panel's stream and input
// routes, the domain's views and a member's screenshot) against the runner's real side of the
// browser view (`@ostra/runner`: its connection on either carrier, its own link to core, the view
// registry, the shared pages in the box's browser, its app processes and its pictures), on `host`:
// a real `HostExecutor` box running the milestone's `test-web` fixture (Vite and React, `/api`
// behind Vite's proxy to its Node API) as the task's app processes, and this machine's browser
// (Edge here) as the box's; on a Linux CI machine without OSTRA_RUNNER_BROWSER, the fake box
// browser over the same pipe, whose page counts the input it gets. Real Postgres and pg-boss. The
// runner's own wiring of the same pieces on every executor is
// `apps/runner/src/task-host/preview-stream.*.test.ts`.

const fixtureDir = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url));
/** A path in a command line: `/` between its parts, quoted, as bash reads it on every machine. */
const fixturePath = (...parts: readonly string[]): string => `"${path.join(fixtureDir, ...parts).replaceAll("\\", "/")}"`;
/** Whether the box's browser is the machine's (pixels, a click that counts) or the fake one (a Linux CI machine). */
const live = process.platform !== "linux" || (process.env["OSTRA_RUNNER_BROWSER"] ?? "") !== "";

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let replica: PreviewReplica;
let liveText: LiveTextWriter;
let upstream: GitUpstream;
let root = "";
let webPort = 0;
let apiPort = 0;
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const runnerRecords: LogRecord[] = [];
const runnerLogger = createLogger((record) => runnerRecords.push(record));
const secret = randomBytes(32).toString("hex");
const panelTokens = createPanelPreviewTokens(secret);
const WEB: PreviewKey = previewKeySchema.parse("app-web");
const opened: { close: () => void }[] = [];

/** One runner of the test: its real connection to core on its carrier, its link, and its box's views and pages. */
type RunnerSide = {
  readonly ref: RegisteredAt;
  readonly connection: RunnerConnection;
  readonly link: ServerLink;
  readonly views: PreviewViews;
  readonly pages: SharedPages;
  readonly task: Boxed;
};

type Boxed = { readonly taskId: TaskId; readonly sessionId: SessionId };

/** The box the runners' views show: one `host` box running the fixture, with its browser. */
let executor: HostExecutor;
let box: { readonly taskId: TaskId; readonly boxId: BoxId };
let app: AppProcesses;
let browser: BoxBrowserHolder;
let pictures: AppPictures;
let channel: SessionChannel;
let onWs: RunnerSide;
let onHttp: RunnerSide;

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });
const viewDeps = () => ({ db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, settings: { warmMinutes: 60 }, panelTokens });

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A prompt task leased to `runnerId` (a `host` box), its offer accepted. */
const boxedTask = async (runnerId: RunnerId): Promise<Boxed> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runnerId);
  const result = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, personalSlots: 50 }, dispatchPayload(task, 1)),
  );
  if (!result.ok) {
    throw new Error("not dispatched");
  }
  await test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  return { taskId: task.taskId, sessionId: task.sessionId };
};

/** Where the box's browser opens a preview, as the task run aims it: the app's port at the box's `localhost`. */
const aimOf = (key: PreviewKey): StreamAim | null => {
  const item = app.previews().find((each) => each.key === key);
  return item === undefined || !app.reach(item.port).ok || "service" in item.target ? null : { origin: inBoxAppAddress(item.port), path: item.path, target: item.target };
};

/** A runner's commands as its task host takes them, for the box's views and a member's screenshot. */
const handlersOf = (side: () => RunnerSide | undefined): CommandHandlers => {
  const refused = (): Promise<CommandOutcome> => Promise.resolve({ result: "rejected", reason: "not-in-this-test" });
  return {
    // The box is the test's own: the dispatch is taken, and nothing more runs for it.
    dispatch: () => Promise.resolve({ result: "accepted" }),
    steer: refused,
    interrupt: refused,
    stop: refused,
    "approval-answer": refused,
    drain: refused,
    "update-hint": refused,
    release: refused,
    "question-answer": refused,
    "plan-answer": refused,
    "snapshot-build": refused,
    "set-effort": refused,
    resume: refused,
    "app.start": refused,
    "app.stop": refused,
    "preview.open": (command) => {
      const views = side()?.views;
      if (views === undefined) {
        return refused();
      }
      if (command.body.mode === "stream" && !views.mayStream(command.body.key)) {
        return Promise.resolve({ result: "rejected", reason: "too-many-pages" });
      }
      views.open({ viewId: command.body.viewId, key: command.body.key, mode: command.body.mode, viewport: command.body.viewport, ready: Promise.resolve(true) });
      return Promise.resolve({ result: "accepted" });
    },
    "preview.close": (command) => Promise.resolve(side()?.views.close(command.body.viewId, "closed") === true ? { result: "done" } : { result: "done", reason: "unknown-view" }),
    "preview.input": (command) => {
      const views = side()?.views;
      const body = command.body;
      const taken = views !== undefined && ("events" in body ? views.input(body.viewId, body.events) : views.control(body.viewId, body.control));
      return Promise.resolve(taken ? { result: "accepted" } : { result: "rejected", reason: "unknown-view" });
    },
    "screenshot.take": (command) => {
      const refusal = pictures.memberRefusal(command.body);
      if (refusal !== null) {
        return Promise.resolve({ result: "rejected", reason: refusal });
      }
      void pictures.memberScreenshot(command.body);
      return Promise.resolve({ result: "accepted" });
    },
  };
};

/** A runner's real connection on its carrier, and its link to core with its own access token. */
const connectRunner = async (transport: Transport, side: () => RunnerSide | undefined): Promise<{ readonly ref: RegisteredAt; readonly connection: RunnerConnection; readonly link: ServerLink }> => {
  const ref = await registerRunnerAt(replica.url, test.db, fixture.a.member);
  const tokens = {
    get: () => Promise.resolve({ ok: true as const, token: replica.gateway.context.tokens.issue(ref.runnerId, fixture.a.organization.id, Date.now()).accessToken, expiresAt: Date.now() + 600_000 }),
    invalidate: () => undefined,
  };
  const holder: { connection: RunnerConnection | undefined } = { connection: undefined };
  const link = runnerServerLink({
    serverUrl: replica.url,
    tokens,
    connection: {
      openSession: (sessionRef) => {
        if (holder.connection === undefined) {
          throw new Error("not connected yet");
        }
        return holder.connection.openSession(sessionRef);
      },
      statusChanged: () => {
        holder.connection?.statusChanged();
      },
      carrier: () => holder.connection?.report().carrier ?? null,
    },
  });
  const dataDir = await mkdtemp(path.join(root, `runner-${transport}-`));
  holder.connection = await startConnection({
    serverUrl: replica.url,
    peer: { kind: "runner", runnerId: ref.runnerId },
    transport,
    tokens,
    dataDir,
    handlers: handlersOf(side),
    // As `ostra runner` reports on `host` (ticket 18): the browser view, and the tunnel on the WebSocket.
    status: () => ({ executor: "host", capacity: 1, freeSlots: 1, labels: [], running: [], preview: RUNNER_PREVIEW_SUPPORT }),
    logger: runnerLogger,
  });
  const connection = holder.connection;
  await waitFor(`the runner on the ${transport} carrier`, () => connection.report().carrier === transport, 30_000);
  return { ref, connection, link };
};

/** The views and pages of one runner's box, as its task run builds them (`task-run.ts`). */
const boxSide = (link: ServerLink, task: Boxed, ref: RegisteredAt, connection: RunnerConnection): RunnerSide => {
  const framesPerSecond = (): number => (link.previewCarrier() === "http" ? runnerLimits.httpCarrierFramesPerSecond : runnerLimits.browserViewFramesPerSecond);
  const pages = createSharedPages({ browser: () => browser.open(), framesPerSecond, mayLoad: () => true, logger: runnerLogger });
  const leaseEpoch = leaseEpochSchema.parse(1);
  const views = createPreviewViews({
    connect: (viewId, mode) => link.openPreview(viewId, leaseEpoch, mode),
    mayReach: (port) => app.reach(port),
    reachPort: (_target, port) => Promise.resolve({ ok: true, value: { host: "localhost", port, close: () => Promise.resolve() } }),
    settled: (target) => ("process" in target ? app.settled(target.process, 60_000) : Promise.resolve()),
    logger: runnerLogger,
    stream: {
      pages,
      browser: () => browser.open(),
      carrier: () => link.previewCarrier(),
      postFrames: (viewId, frames) => link.postPreviewFrames(viewId, leaseEpoch, frames),
      aim: aimOf,
    },
    // A view the box drops is `previews.test.ts`'s (core) and `preview-stream-cases.ts`'s (the runner).
    dropped: () => undefined,
  });
  return { ref, connection, link, views, pages, task };
};

/** A member's (or a link's) view of the primary in the browser view, through the domain's `openView`. */
const openStreamView = async (task: Boxed, opener: Parameters<typeof openView>[1] = { kind: "member", scope: scopeOf(fixture.a.member) }) => {
  const view = await openView(viewDeps(), opener, { taskId: task.taskId, key: WEB, mode: "stream", viewport: null });
  if (!view.ok) {
    throw new Error(`the view didn't open: ${view.error}`);
  }
  return view;
};

const stream = async (viewId: PreviewViewId, panelToken: string): Promise<PanelStream> => {
  const panel = await openPanelStream(replica.url, viewId, { authorization: `Bearer ${panelToken}` });
  opened.push({ close: panel.abort });
  return panel;
};

const postInput = (viewId: PreviewViewId, panelToken: string, events: readonly PreviewInputEvent[]) =>
  fetch(`${replica.url}${panelPreviewPaths.input(viewId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });

/** One of the pane's controls (the width preset, the path field, reload), through core's input route. */
const postControl = (viewId: PreviewViewId, panelToken: string, control: PreviewPageControl) =>
  fetch(`${replica.url}${panelPreviewPaths.input(viewId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
    body: JSON.stringify({ control }),
  });

/** The most frames in any one second of `times`. */
const mostInOneSecond = (times: readonly number[]): number => {
  let most = 0;
  for (const [index, start] of times.entries()) {
    most = Math.max(most, times.slice(index).filter((time) => time - start < 1_000).length);
  }
  return most;
};

/** Keeps when each frame reached the panel's stream, from now. */
const clockFrames = (panel: PanelStream): { readonly times: number[]; readonly stop: () => void } => {
  const times: number[] = [];
  let seen = panel.messages.length;
  const timer = setInterval(() => {
    for (const message of panel.messages.slice(seen)) {
      if (message.type === "frame") {
        times.push(Date.now());
      }
    }
    seen = panel.messages.length;
  }, 5);
  return {
    times,
    stop: () => {
      clearInterval(timer);
    },
  };
};

/** The page's `expression`, in the box's browser: what a member's input did to it. */
const pageSays = async (pages: SharedPages, expression: string, want: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let said = "";
  while (Date.now() < deadline) {
    said = await pages.evaluate(WEB, expression, z.string());
    if (said === want) {
      return;
    }
    await sleep(100);
  }
  expect(said).toBe(want);
};

const pointSchema = z.object({ x: z.number(), y: z.number() });
const middleOf = (selector: string): string =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
const counterText = "document.querySelector('#counter')?.textContent ?? ''";
/** A page that changes every frame, so the screencast sends as fast as its acks let it. */
const ANIMATE = "(() => { const tick = document.createElement('div'); document.body.appendChild(tick); let n = 0; window.ostraTick = setInterval(() => { tick.textContent = String(n++); }, 8); return true; })()";
const STILL = "(() => { clearInterval(window.ostraTick); return true; })()";

const clickAt = (point: { readonly x: number; readonly y: number }): PreviewInputEvent[] => [
  { kind: "mouse", action: "move", x: point.x, y: point.y, button: "none", clickCount: 0, modifiers: 0 },
  { kind: "mouse", action: "down", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: 0 },
  { kind: "mouse", action: "up", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: 0 },
];

/** How the page last loaded (`navigate` or `reload`), and where it is: the fake browser answers both as the machine's does. */
const loadedHow = "performance.getEntriesByType('navigation')[0]?.type ?? ''";
const pathOf = async (pages: SharedPages): Promise<string> => new URL(await pages.evaluate(WEB, "location.href", z.string())).pathname;

/**
 * The pane's width preset, path field and reload on `side`'s carrier, through core's input route:
 * the phone's width resizes the shared page's frames, the path loads `/history` on the preview's
 * origin, and reload loads it again (live, the counter's count goes back to 0).
 */
const controlsReachThePage = async (side: RunnerSide, view: { readonly viewId: PreviewViewId; readonly panelToken: string }, panel: PanelStream): Promise<void> => {
  const phone = viewportPresetSizes.phone;
  expect((await postControl(view.viewId, view.panelToken, { kind: "viewport", viewport: phone })).status).toBe(204);
  await waitFor("a frame at the phone's width", () => panel.messages.some((message) => message.type === "frame" && message.header.width === phone.width && message.header.height === phone.height), 30_000);
  if (live) {
    await pageSays(side.pages, "String(window.innerWidth)", String(phone.width));
  }
  expect((await postControl(view.viewId, view.panelToken, { kind: "navigate", path: "/history" })).status).toBe(204);
  await waitFor("the page at /history", async () => (await pathOf(side.pages)) === "/history", 20_000);
  await pageSays(side.pages, loadedHow, "navigate");
  if (live) {
    await pageSays(side.pages, counterText, "Count: 0", 30_000);
    expect((await postInput(view.viewId, view.panelToken, clickAt(await counterPoint(side.pages)))).status).toBe(204);
    await pageSays(side.pages, counterText, "Count: 1");
  }
  expect((await postControl(view.viewId, view.panelToken, { kind: "reload" })).status).toBe(204);
  await pageSays(side.pages, loadedHow, "reload", 30_000);
  expect(await pathOf(side.pages)).toBe("/history");
  if (live) {
    await pageSays(side.pages, counterText, "Count: 0", 30_000);
  }
};

/** Where the counter is on the page: live, its middle; with the fake browser, any point. */
const counterPoint = async (pages: SharedPages) => (live ? pages.evaluate(WEB, middleOf("#counter"), pointSchema) : { x: 40, y: 40 });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);
  root = await mkdtemp(path.join(tmpdir(), "ostra-runner-stream-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
  webPort = await freePort();
  apiPort = await freePort();
  // The environment's app as core knows it: the frontend, the primary preview.
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: webPort, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  // Core with its bulk path, for the box's pictures.
  const blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 16 * 1024 * 1024 }, context: { logger: silentLogger, clock: systemClock } });
  // Core's real ingest, so the box's events (its app's processes, its browser, a picture) are stored.
  liveText = createLiveTextWriter({ db: test.db, logger: silentLogger, intervalMs: 50 });
  const ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger: silentLogger });
  replica = await startPreviewReplica(test.db, test.url, {
    signingKey: randomBytes(32),
    secret,
    jobs,
    logger,
    gateway: { hooks: { ingest, liveText: liveText.write } },
    routes: (gateway) => [handleBlobEndpoint({ db: test.db, tokens: gateway.context.tokens, taskTokens: gateway.context.taskTokens, blobs, clock: systemClock, logger: silentLogger })],
  });

  // Two of the member's personal runners on `host`: one on the WebSocket, one on the HTTP carrier, each with a task.
  const ws = await connectRunner("websocket", () => onWs);
  const http = await connectRunner("http", () => onHttp);
  const wsTask = await boxedTask(ws.ref.runnerId);
  const httpTask = await boxedTask(http.ref.runnerId);

  // The box: the fixture's API and Vite as the task's app processes, and the box's browser.
  const dataDir = path.join(root, "box");
  const browserProgram = live ? machineBrowserSource(() => resolveMachineBrowser({ named: process.env["OSTRA_RUNNER_BROWSER"], download: false, dataDir })) : fakeBrowserProgram();
  executor = await HostExecutor.start({ dataDir, browser: browserProgram }, { logger: silentLogger, clock: { now: () => Date.now() } });
  const [repo] = taskSpecFixture.repos;
  const [repoEnvironment] = taskSpecFixture.environment.repos;
  if (repo === undefined || repoEnvironment === undefined) {
    throw new Error("the spec fixture has a repo");
  }
  const variables = { TEST_WEB_PORT: String(webPort), TEST_WEB_API_PORT: String(apiPort), TEST_WEB_CACHE_DIR: path.join(root, "vite").replaceAll("\\", "/") };
  const spec: TaskSpec = {
    ...taskSpecFixture,
    taskId: wsTask.taskId,
    sessionId: wsTask.sessionId,
    leaseEpoch: leaseEpochSchema.parse(1),
    environment: {
      ...taskSpecFixture.environment,
      setupScript: "echo ready\n",
      repos: [{ ...repoEnvironment, variables: Object.entries(variables).map(([name, value]) => ({ name, value, availableDuringSetup: true })) }],
      appProcesses: [
        { name: "api", repoId: repo.repoId, folder: ".", command: `node ${fixturePath("api", "server.js")}`, port: apiPort, ready: { kind: "http", path: "/api/hello" }, label: "API", primary: false, hostRewrite: true },
        {
          name: "web",
          repoId: repo.repoId,
          folder: ".",
          command: `node ${fixturePath("node_modules", "vite", "bin", "vite.js")} --config ${fixturePath("vite.config.js")}`,
          port: webPort,
          ready: { kind: "http", path: "/" },
          label: "Web",
          primary: true,
          hostRewrite: true,
        },
      ],
    },
    tools: ["pr-text", "app"],
  };
  box = { taskId: spec.taskId, boxId: boxIdSchema.parse(`box-stream-${randomBytes(3).toString("hex")}`) };
  const created = await executor.create({ ...box, spec, proxies: { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" } });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  channel = await ws.link.openSession({ taskId: wsTask.taskId, sessionId: wsTask.sessionId, leaseEpoch: spec.leaseEpoch });
  const shell = await resolveSetupShell("bash", localShellProbe(baseEnv(), root));
  app = createAppProcesses({
    executor,
    box,
    spec,
    executorKind: "host",
    workspaceDir: created.value.workspaceDir,
    logDir: created.value.appLogDir ?? null,
    secrets: [],
    baseEnv: baseEnv(),
    shell: shell.kind === "found" ? shell.command : "bash",
    reservedPorts: { "key-proxy": null, "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null },
    ownPorts: [],
    emit: async (event) => {
      await channel.emit(event);
    },
    uploadLog: () => Promise.resolve(null),
    logger: runnerLogger,
    timing: { readyIntervalMs: 200, readyTimeoutMs: 90_000, stopGraceMs: 1_000 },
  });
  browser = boxBrowser({
    start: () => executor.startBrowser(box),
    report: (report) => {
      void channel.emit({ kind: "app.browser", browser: report });
    },
  });
  pictures = createAppPictures({
    browser,
    app,
    spec,
    executorKind: "host",
    upload: async (kind, bytes) => {
      const uploaded = await ws.link.uploadBlob({ taskId: spec.taskId, leaseEpoch: spec.leaseEpoch, ...(kind === "screenshot" ? { purpose: "app-screenshot", contentType: APP_SCREENSHOT_CONTENT_TYPE } : { purpose: "app-recording", contentType: APP_RECORDING_CONTENT_TYPE }), bytes });
      return uploaded.ok ? uploaded.value.blobId : null;
    },
    emit: async (event) => {
      await channel.emit(event);
    },
    logger: runnerLogger,
    timing: { quietMs: 200, settleMaxMs: 5_000 },
  });
  onWs = boxSide(ws.link, wsTask, ws.ref, ws.connection);
  onHttp = boxSide(http.link, httpTask, http.ref, http.connection);
  const started = await app.start(null);
  expect(started.map((process) => `${process.name}:${process.state}`)).toEqual(["api:ready", "web:ready"]);
}, 240_000);

afterAll(async () => {
  for (const connection of opened.splice(0)) {
    connection.close();
  }
  for (const side of [onWs, onHttp]) {
    side.views.closeAll("box-stopping");
    await side.pages.closeAll();
  }
  await browser.close();
  await app.stopAll();
  channel.close();
  for (const side of [onWs, onHttp]) {
    await side.connection.stop();
  }
  await executor.stop({ box, graceMs: 1_000 });
  await executor.release(box, "requested");
  await replica.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 120_000);

describe(`the browser view through core (${live ? "the machine's browser" : "the fake browser"})`, () => {
  it("F-141/c2, c9: the box's browser streams the fixture app through core to the panel's stream, at most 15 frames a second, and the screencast waits on core's acks", async () => {
    // The runner said what it can show, and core keeps it.
    expect(previewSupportSchema.parse((await test.db.runner.findUniqueOrThrow({ where: { id: onWs.ref.runnerId } })).preview)).toEqual({ stream: true, tunnel: true });
    const view = await openStreamView(onWs.task);
    // The box's connection reaches core, but no panel stream is open: core holds the first frame's
    // ack, so the box's browser sends no more, however the page changes.
    await waitFor("the box's connection", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).replicaUrl === replica.url, 60_000);
    await waitFor("the box's first frame", () => (onWs.pages.counts(WEB)?.frames ?? 0) >= 1, 60_000);
    if (live) {
      await pageSays(onWs.pages, counterText, "Count: 0", 30_000);
      await onWs.pages.evaluate(WEB, ANIMATE, z.boolean());
    }
    await sleep(1_500);
    expect(onWs.pages.counts(WEB)).toMatchObject({ frames: 1, taken: 0 });
    // The pane opens its stream: the newest frame at once, then as fast as core takes them, capped.
    const panel = await stream(view.viewId, view.panelToken);
    const first = await panel.next("frame", 10_000);
    expect([first.jpeg[0], first.jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(first.header).toMatchObject({ width: 1440, height: 900 });
    const clock = clockFrames(panel);
    await sleep(3_000);
    clock.stop();
    expect(clock.times.length).toBeGreaterThanOrEqual(live ? 20 : 15);
    // The cap holds the browser's acks 1/15 s apart; the network's jitter may bunch one or two arrivals.
    expect(mostInOneSecond(clock.times)).toBeLessThanOrEqual(runnerLimits.browserViewFramesPerSecond + 2);
    const seqs = panel.messages.flatMap((message) => (message.type === "frame" ? [message.header.seq] : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    if (live) {
      await onWs.pages.evaluate(WEB, STILL, z.boolean());
    }
    // The pane closes the view: core sends `preview.close`, the box's view ends, and the page goes.
    expect(await closeView(viewDeps(), { viewId: view.viewId, reason: "closed" })).toEqual({ ok: true, closed: true });
    await waitFor("the box's view ended", () => !onWs.views.has(view.viewId), 30_000);
    await waitFor("the shared page closed", () => !onWs.pages.hasPage(WEB), 10_000);
    // Never a token or a frame in core's log lines: IDs and reasons.
    expect(JSON.stringify(records)).not.toContain(view.panelToken);
  }, 180_000);

  it("F-141/c2, c3, F-142/c1: a member's click through core counts the counter and typing lands, and a watch-only link's input stops at core and leaves the shared page as it was", async () => {
    const member = await openStreamView(onWs.task);
    const panel = await stream(member.viewId, member.panelToken);
    await panel.next("frame", 60_000);
    if (live) {
      await pageSays(onWs.pages, counterText, "Count: 0", 30_000);
    }
    const counter = await counterPoint(onWs.pages);
    expect((await postInput(member.viewId, member.panelToken, clickAt(counter))).status).toBe(204);
    if (live) {
      await pageSays(onWs.pages, counterText, "Count: 1");
      const field = await onWs.pages.evaluate(WEB, middleOf("#field"), pointSchema);
      const typing: PreviewInputEvent[] = [...clickAt(field), ...Array.from("ostra").flatMap((char): PreviewInputEvent[] => [
        { kind: "key", action: "down", key: char, code: `Key${char.toUpperCase()}`, modifiers: 0 },
        { kind: "key", action: "up", key: char, code: `Key${char.toUpperCase()}`, modifiers: 0 },
      ]), { kind: "text", text: " été" }];
      expect((await postInput(member.viewId, member.panelToken, typing)).status).toBe(204);
      await pageSays(onWs.pages, "document.querySelector('#typed')?.textContent ?? ''", "ostra été");
    } else {
      await waitFor("the input on the page", () => onWs.pages.counts(WEB)?.inputs === 3, 20_000);
    }
    // A watch-only link watches the same page (Q314), and its click stops at core.
    const made = newPreviewLinkToken();
    await test.db.previewLink.create({
      data: { organizationId: world.organizationId, projectId: world.projectId, taskId: onWs.task.taskId, key: WEB, kind: "expiring", tokenHash: made.tokenHash, allowInput: false, expiresAt: new Date(Date.now() + 3_600_000), createdByMemberId: fixture.a.member.id },
    });
    const watching = await openStreamView(onWs.task, { kind: "link", token: made.token });
    expect(watching.input).toBe(false);
    const watchPanel = await stream(watching.viewId, watching.panelToken);
    await watchPanel.next("frame", 60_000);
    expect(onWs.pages.counts(WEB)?.views).toBe(2);
    const inputsBefore = onWs.pages.counts(WEB)?.inputs ?? 0;
    const refused = await postInput(watching.viewId, watching.panelToken, clickAt(counter));
    expect(refused.status).toBe(403);
    await sleep(800);
    expect(onWs.pages.counts(WEB)?.inputs).toBe(inputsBefore);
    if (live) {
      expect(await onWs.pages.evaluate(WEB, counterText, z.string())).toBe("Count: 1");
    }
    expect(JSON.stringify(runnerRecords)).not.toContain("été");
    for (const viewId of [member.viewId, watching.viewId]) {
      await closeView(viewDeps(), { viewId, reason: "closed" });
    }
    await waitFor("the shared page closed", () => !onWs.pages.hasPage(WEB), 30_000);
  }, 180_000);

  it("F-141/c8: on the HTTP carrier the runner's frames reach the panel's stream at most 2 a second, and a member's input comes down the long poll to the page", async () => {
    // On the HTTP carrier the runner reports the browser view and no tunnel, and core keeps that.
    await waitFor("the HTTP runner's report", async () => (await test.db.runner.findUniqueOrThrow({ where: { id: onHttp.ref.runnerId } })).preview !== null, 30_000);
    expect(previewSupportSchema.parse((await test.db.runner.findUniqueOrThrow({ where: { id: onHttp.ref.runnerId } })).preview)).toEqual({ stream: true, tunnel: false });
    const view = await openStreamView(onHttp.task);
    const panel = await stream(view.viewId, view.panelToken);
    await panel.next("frame", 90_000);
    await waitFor("the view's frames posted", () => onHttp.views.streaming(view.viewId) === "http", 10_000);
    if (live) {
      await pageSays(onHttp.pages, counterText, "Count: 0", 30_000);
      await onHttp.pages.evaluate(WEB, ANIMATE, z.boolean());
    }
    const clock = clockFrames(panel);
    await sleep(4_000);
    clock.stop();
    expect(clock.times.length).toBeGreaterThanOrEqual(5);
    expect(mostInOneSecond(clock.times)).toBeLessThanOrEqual(runnerLimits.httpCarrierFramesPerSecond + 1);
    if (live) {
      await onHttp.pages.evaluate(WEB, STILL, z.boolean());
    }
    // The member's click: no preview connection to carry it, so core sends `preview.input` down the long poll.
    const before = onHttp.pages.counts(WEB)?.inputs ?? 0;
    expect((await postInput(view.viewId, view.panelToken, clickAt(await counterPoint(onHttp.pages)))).status).toBe(204);
    await waitFor("the input down the long poll", () => onHttp.pages.counts(WEB)?.inputs === before + 3, 30_000);
    if (live) {
      await pageSays(onHttp.pages, counterText, "Count: 1");
    }
    await waitFor("the input's ack", async () => (await test.db.command.count({ where: { runnerId: onHttp.ref.runnerId, kind: "preview_input", result: "accepted" } })) === 1, 30_000);
    await closeView(viewDeps(), { viewId: view.viewId, reason: "closed" });
    await waitFor("the box's view ended", () => !onHttp.views.has(view.viewId), 30_000);
  }, 180_000);

  it("F-141/c3, F-142/c1: the pane's width preset, path and reload go through core to the shared page on the box's connection, and a watch-only link's controls stop at core", async () => {
    const member = await openStreamView(onWs.task);
    const panel = await stream(member.viewId, member.panelToken);
    await panel.next("frame", 60_000);
    await controlsReachThePage(onWs, member, panel);
    // A watch-only link on the same page: its controls stop at core, and the shared page stays as it is.
    const made = newPreviewLinkToken();
    await test.db.previewLink.create({
      data: { organizationId: world.organizationId, projectId: world.projectId, taskId: onWs.task.taskId, key: WEB, kind: "expiring", tokenHash: made.tokenHash, allowInput: false, expiresAt: new Date(Date.now() + 3_600_000), createdByMemberId: fixture.a.member.id },
    });
    const watching = await openStreamView(onWs.task, { kind: "link", token: made.token });
    expect(watching.input).toBe(false);
    const watchPanel = await stream(watching.viewId, watching.panelToken);
    await watchPanel.next("frame", 60_000);
    // It opened at the desktop's width, the last one chosen (Q314): the shared page moved to it.
    const desktop = viewportPresetSizes.desktop.width;
    await waitFor("the page at the desktop's width", () => watchPanel.messages.filter((message) => message.type === "frame").at(-1)?.header.width === desktop, 30_000);
    const seen = watchPanel.messages.length;
    const refusals: PreviewPageControl[] = [{ kind: "viewport", viewport: viewportPresetSizes.phone }, { kind: "navigate", path: "/" }, { kind: "reload" }];
    for (const control of refusals) {
      const refused = await postControl(watching.viewId, watching.panelToken, control);
      expect([refused.status, await refused.json()]).toEqual([403, { error: { code: "watch-only", message: "this view is watch-only" } }]);
    }
    // The page the member's reload left: still at `/history`, loaded by that reload, at the desktop's width.
    await sleep(1_000);
    expect(await pathOf(onWs.pages)).toBe("/history");
    expect(await onWs.pages.evaluate(WEB, loadedHow, z.string())).toBe("reload");
    expect(watchPanel.messages.slice(seen).flatMap((message) => (message.type === "frame" && message.header.width !== desktop ? [message.header.width] : []))).toEqual([]);
    // A path reaches no log line of core's or the runner's.
    expect(JSON.stringify([...records, ...runnerRecords])).not.toContain("/history");
    for (const viewId of [member.viewId, watching.viewId]) {
      await closeView(viewDeps(), { viewId, reason: "closed" });
    }
    await waitFor("the shared page closed", () => !onWs.pages.hasPage(WEB), 30_000);
  }, 180_000);

  it("F-141/c3, c8: on the HTTP carrier the pane's width preset, path and reload come down the long poll to the shared page", async () => {
    const view = await openStreamView(onHttp.task);
    const panel = await stream(view.viewId, view.panelToken);
    await panel.next("frame", 90_000);
    await waitFor("the view's frames posted", () => onHttp.views.streaming(view.viewId) === "http", 10_000);
    const before = await test.db.command.count({ where: { runnerId: onHttp.ref.runnerId, kind: "preview_input" } });
    await controlsReachThePage(onHttp, view, panel);
    // Each control went down the long poll as `preview.input`, in order, and the runner took it.
    const sent = await test.db.command.findMany({ where: { runnerId: onHttp.ref.runnerId, kind: "preview_input" }, orderBy: { seq: "asc" }, skip: before, select: { body: true } });
    const controls = sent.flatMap((row) => {
      const body: unknown = row.body;
      return typeof body === "object" && body !== null && "control" in body ? [body.control] : [];
    });
    expect(controls).toEqual([{ kind: "viewport", viewport: viewportPresetSizes.phone }, { kind: "navigate", path: "/history" }, { kind: "reload" }]);
    await waitFor("the controls' acks", async () => (await test.db.command.count({ where: { runnerId: onHttp.ref.runnerId, kind: "preview_input", result: "accepted" } })) === before + sent.length, 30_000);
    await closeView(viewDeps(), { viewId: view.viewId, reason: "closed" });
    await waitFor("the box's view ended", () => !onHttp.views.has(view.viewId), 30_000);
    await waitFor("the shared page closed", () => !onHttp.pages.hasPage(WEB), 30_000);
  }, 180_000);

  it("F-121/c7: a member's screenshot from the pane goes through core to the runner that reports the browser view, and comes back as the task's attachment", async () => {
    const asked = await takeMemberScreenshot({ db: test.db, outbox: postgresCommandOutbox, clock: systemClock, logger }, scopeOf(fixture.a.member), { taskId: onWs.task.taskId, key: WEB, path: "/", width: "phone" });
    if (!asked.ok) {
      throw new Error(`the screenshot wasn't asked: ${asked.error}`);
    }
    await waitFor("the member's screenshot", async () => (await test.db.taskAttachment.count({ where: { taskId: onWs.task.taskId, source: "member" } })) === 1, 90_000);
    const attachment = await test.db.taskAttachment.findFirstOrThrow({ where: { taskId: onWs.task.taskId, source: "member" } });
    expect(attachment).toMatchObject({ kind: "screenshot", memberId: fixture.a.member.id, targetKind: "process", targetName: "web", path: "/", width: 390, height: 844, turnId: null });
    expect(attachment.browserName.length).toBeGreaterThan(0);
    const blob = await test.db.blob.findUniqueOrThrow({ where: { id: attachment.blobId } });
    expect(blob).toMatchObject({ taskId: onWs.task.taskId, purpose: "app-screenshot", contentType: APP_SCREENSHOT_CONTENT_TYPE });
    const added = await test.db.event.findFirstOrThrow({ where: { taskId: onWs.task.taskId, kind: "attachment.added" } });
    expect(added.payload).toMatchObject({ source: "member", requestId: asked.requestId, memberId: fixture.a.member.id });
  }, 180_000);
});
