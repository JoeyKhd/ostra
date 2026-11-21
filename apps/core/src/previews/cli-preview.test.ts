import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, killTree } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { handleCliRequest } from "@ostra/api";
import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import { closeView, dispatchTask, postgresChangeNotices, postgresCommandOutbox, startCliSession, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  cliPreviewTunnelRefusalWords,
  cliTunnelCloseWords,
  mayReach,
  memberIdSchema,
  previewKeyFor,
  previewTargets,
  previewViewIdSchema,
  runnerPaths,
  tokenResponseSchema,
  userIdSchema,
} from "@ostra/protocol";
import type { DownFrame, PreviewListItem, PreviewViewId, ReservedPorts, RunnerId, TaskId } from "@ostra/protocol";
import { cliSessionPath, createCapturingTerminal, createPreviewViews, exitCodes, openPreviewConnection, runCli, saveCliSession } from "@ostra/runner";
import type { PreviewViews } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { z } from "zod";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { startPreviewReplica } from "../testing/previews.ts";
import type { PreviewReplica } from "../testing/previews.ts";
import { freePort, registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { nextMessage, openSocket as openTestSocket, skipMessages } from "../testing/websockets.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 24 (F-143, ADR 0068 "`ostra preview`"): the CLI's real `ostra preview`
// against the web app's real CLI route (`handleCliRequest`, on a loopback port), core's real tunnel
// (ticket 23) and the runner's real side of it (ticket 22: the preview connection and the view
// registry's HTTP/2 server, with the reach rule on every stream), on `host`, where the box's app is
// this machine's: the milestone's `test-web` fixture, a real Vite with `/api` behind its proxy to the
// Node API. Real Postgres and pg-boss; a fake runner peer takes the commands, and the runner's view
// registry opens each tunnel view's connection as the task run does. A browser-free HTTP and
// WebSocket client hits the CLI's local port. The CLI reaches core through a TCP relay, so a test
// can drop that connection as a network would. The command on its own is
// `apps/runner/src/cli/preview.test.ts`.

const fixtureDir = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url));

let harness: ApiHarness;
let jobs: Jobs;
let world: World;
let replica: PreviewReplica;
let runner: RegisteredAt;
let peer: FakePeer;
let views: PreviewViews;
let web: HttpServer;
let webUrl = "";
let relay: Server;
let vitePort = 0;
let apiPort = 0;
let cacheDir = "";
let configDir = "";
let env: Record<string, string | undefined> = {};
let sessionId = "";
let opener: ReturnType<typeof setInterval> | undefined;
const apps: ChildProcess[] = [];
const relayed = new Set<Socket>();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const secret = randomBytes(32).toString("hex");
const opened: PreviewViewId[] = [];
const sockets: WebSocket[] = [];
const runs: { readonly stop: () => void; readonly done: Promise<number> }[] = [];
const probes: string[] = [];
/** The box's own ports by name, as a `host` box's run holds them: here only the key proxy's. */
let reserved: ReservedPorts;
/** The task's previews as the box holds them: the runner's reach rule reads this list. */
let boxPreviews: readonly PreviewListItem[] = [];

const tunnelOpenSchema = z.looseObject({ viewId: previewViewIdSchema, key: z.string(), mode: z.literal("tunnel") });
const hmrMessageSchema = z.looseObject({ type: z.string() });
const helloSchema = z.looseObject({ message: z.string() });

const runnerToken = (runnerId: RunnerId = runner.runnerId): string => replica.gateway.context.tokens.issue(runnerId, harness.fixture.a.organization.id, Date.now()).accessToken;

const portOf = (server: Server | HttpServer): number => {
  const address: AddressInfo | string | null = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const boxedTask = async (): Promise<TaskId> => {
  const task = await seedQueuedTask(harness.test.db, world, harness.fixture.a.member, runner.runnerId);
  const result = await harness.test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, personalSlots: 50 }, dispatchPayload(task, 1)),
  );
  if (!result.ok) {
    throw new Error("not dispatched");
  }
  await harness.test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  return task.taskId;
};

/** The runner's task run, cut down: each `preview.open` in tunnel mode core sends opens its view, as `TaskRun.previewOpen` does. */
const openViewsAsTheRunner = (): void => {
  const seen = new Set<string>();
  opener = setInterval(() => {
    for (const frame of peer.frames) {
      if (frame.type !== "command" || frame.kind !== "preview.open" || seen.has(frame.id)) {
        continue;
      }
      seen.add(frame.id);
      const body = tunnelOpenSchema.safeParse(frame.body);
      if (body.success) {
        opened.push(body.data.viewId);
        views.open({ viewId: body.data.viewId, key: previewKeyFor({ process: "web" }), ready: Promise.resolve(true) });
      }
    }
  }, 25);
};

const commandOf = async (kind: string, match: (body: Record<string, unknown>) => boolean): Promise<Extract<DownFrame, { type: "command" }>> => {
  let found: Extract<DownFrame, { type: "command" }> | undefined;
  await waitFor(`a ${kind} command`, () => {
    found = peer.frames.find((frame): frame is Extract<DownFrame, { type: "command" }> => frame.type === "command" && frame.kind === kind && match(frame.body));
    return found !== undefined;
  }, 10_000);
  if (found === undefined) {
    throw new Error(`no ${kind} command`);
  }
  return found;
};

type Run = { readonly out: () => string; readonly stop: () => void; readonly done: Promise<number> };

/** `ostra preview …` as a member runs it on their machine, until it ends or the test stops it. */
const preview = (args: readonly string[]): Run => {
  const terminal = createCapturingTerminal();
  const controller = new AbortController();
  const done = runCli(["preview", ...args], {
    env,
    terminal,
    signal: controller.signal,
    runSignedIn: () => Promise.reject(new Error("ostra preview starts no runner")),
    runSidecar: () => Promise.reject(new Error("ostra preview starts no sidecar")),
    local: { sleep: () => Promise.resolve() },
  });
  const run = {
    out: () => terminal.lines().join(""),
    stop: () => {
      controller.abort();
    },
    done,
  };
  runs.push(run);
  return run;
};

/** The local port from the line `ostra preview` prints once it serves. */
const servedPort = async (run: Run): Promise<number> => {
  await waitFor("the preview's address", () => /is on http:\/\/localhost:\d+/.test(run.out()), 30_000);
  return Number(/is on http:\/\/localhost:(\d+)/.exec(run.out())?.[1]);
};

const runFixture = (args: readonly string[], fixtureEnv: NodeJS.ProcessEnv): void => {
  const child = spawn(process.execPath, [...args], { cwd: fixtureDir, env: { ...process.env, ...fixtureEnv }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  apps.push(child);
};

const answers = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url);
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
};

/** A socket that keeps its messages from its first frame (`testing/websockets.ts`), closed with the test. */
const openSocket = async (url: string, protocol?: string): Promise<WebSocket> => {
  const ws = await openTestSocket(url, protocol);
  sockets.push(ws);
  return ws;
};

/** The web app's CLI routes, as its catch-all route passes them on: a Node request in, `handleCliRequest`'s answer out. */
const toRequest = async (request: IncomingMessage, base: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const body = Buffer.concat(chunks);
  return new Request(new URL(request.url ?? "/", base), { method: request.method ?? "GET", headers, ...(body.length > 0 ? { body } : {}) });
};

const listen = (server: Server | HttpServer): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(portOf(server));
    });
  });

beforeAll(async () => {
  harness = await createApiHarness();
  const { db } = harness.test;
  const member = harness.fixture.a.member;
  jobs = createJobs({ databaseUrl: harness.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, harness.fixture.a.organization.id, harness.fixture.a.openProject.id);

  vitePort = await freePort();
  apiPort = await freePort();
  cacheDir = await mkdtemp(path.join(tmpdir(), "ostra-cli-preview-vite-"));
  const fixtureEnv = { TEST_WEB_PORT: String(vitePort), TEST_WEB_API_PORT: String(apiPort), TEST_WEB_CACHE_DIR: cacheDir };
  runFixture(["api/server.js"], fixtureEnv);
  runFixture([path.join("node_modules", "vite", "bin", "vite.js")], fixtureEnv);
  await waitFor("the fixture's Vite and API", async () => (await answers(`http://localhost:${String(vitePort)}/`)) && (await answers(`http://localhost:${String(apiPort)}/api/version`)), 60_000);

  const environment = await db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: vitePort, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  replica = await startPreviewReplica(db, harness.test.url, { signingKey: randomBytes(32), secret, jobs, logger, cliRecheckMs: 300 });
  runner = await registerRunnerAt(replica.url, db, member);
  const token = tokenResponseSchema.parse((await postJson(`${replica.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId))).body).accessToken;
  peer = await connectPeer(replica.url, token, runner.runnerId, { preview: { stream: false, tunnel: true } });
  await peer.next("welcome");

  // The member's machine reaches core through a relay the test can cut, as a network drops.
  const replicaPort = Number(new URL(replica.url).port);
  relay = createNetServer((client) => {
    const upstream = netConnect({ host: "127.0.0.1", port: replicaPort });
    for (const socket of [client, upstream]) {
      relayed.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => {
        relayed.delete(socket);
      });
    }
    client.pipe(upstream).pipe(client);
  });
  const relayUrl = `http://127.0.0.1:${String(await listen(relay))}`;

  // The web app's CLI routes, with core's public address at the relay.
  const deps = { ...harness.deps, settings: { ...harness.deps.settings, corePublicUrl: relayUrl } };
  web = createHttpServer((request, response) => {
    void toRequest(request, webUrl)
      .then((cliRequest) => handleCliRequest(deps, cliRequest))
      .then(async (answer) => {
        response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
        response.end(Buffer.from(await answer.arrayBuffer()));
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  webUrl = `http://127.0.0.1:${String(await listen(web))}`;

  // The member signed in with `ostra login`: their CLI session's file in their own config folder.
  const started = await startCliSession({ db, ...harness.deps.ports }, { userId: userIdSchema.parse(member.userId), memberId: memberIdSchema.parse(member.id), machineName: "alex-laptop", sessionDays: 30 });
  if (!started.ok) {
    throw new Error("no CLI session");
  }
  sessionId = started.sessionId;
  configDir = await mkdtemp(path.join(tmpdir(), "ostra-cli-preview-config-"));
  const proxies = new Set(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]);
  env = Object.fromEntries(Object.entries({ ...process.env, APPDATA: configDir, XDG_CONFIG_HOME: configDir }).filter(([name]) => !proxies.has(name)));
  await saveCliSession(cliSessionPath(env), { serverUrl: webUrl, sessionId: started.sessionId, token: started.token, expiresAt: started.expiresAt, username: "alex" });

  // The box as the runner's task run holds it on `host`: its previews from the environment (the
  // primary, Vite), its own ports, and the machine's `localhost` as the way to a port.
  reserved = { "key-proxy": await freePort(), "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };
  boxPreviews = previewTargets({ processes: [{ name: "web", port: vitePort, label: "Web", primary: true, position: 0 }], services: [], servicesRun: false }, []);
  views = createPreviewViews({
    connect: (viewId) => openPreviewConnection({ serverUrl: replica.url, token: runnerToken(), viewId, leaseEpoch: 1, mode: "tunnel" }),
    mayReach: (port) => mayReach(port, boxPreviews, reserved),
    reachPort: (_target, port) => Promise.resolve({ ok: true, value: { host: "localhost", port, close: () => Promise.resolve() } }),
    settled: () => Promise.resolve(),
    logger,
  });
  openViewsAsTheRunner();
}, 180_000);

afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.stop();
    await run.done;
  }
  for (const ws of sockets.splice(0)) {
    ws.terminate();
  }
  views.closeAll("closed");
  for (const probe of probes.splice(0)) {
    await rm(probe, { force: true });
  }
}, 30_000);

afterAll(async () => {
  clearInterval(opener);
  peer.close();
  for (const socket of relayed) {
    socket.destroy();
  }
  relay.close();
  web.closeAllConnections();
  web.close();
  await replica.stop();
  for (const app of apps) {
    if (app.pid !== undefined) {
      await killTree(app.pid);
    }
  }
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await harness.dispose();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

describe("ostra preview through core to the runner's tunnel", () => {
  it("F-143/c2: it serves the fixture's Vite on this machine's localhost through the web app's ticket, core's tunnel and the runner's: the page, /api, the API's WebSocket echo at once, and HMR", async () => {
    const taskId = await boxedTask();
    const run = preview([taskId]);
    const local = await servedPort(run);
    // Vite holds its own port on this machine, so the preview is on the next free one, and says so.
    expect(local).not.toBe(vitePort);
    expect(run.out()).toContain(`Port ${String(vitePort)} is taken on this machine, so the preview is on ${String(local)}.`);
    expect(run.out()).toContain(`Web (the task's port ${String(vitePort)}) is on http://localhost:${String(local)}`);
    const base = `http://127.0.0.1:${String(local)}`;
    // The printed address itself, as a browser opens it.
    expect((await fetch(`http://localhost:${String(local)}/`)).status).toBe(200);
    // A WebSocket (the API's echo behind Vite's proxy) open while requests go: each its own CONNECT.
    const echo = await openSocket(`ws://127.0.0.1:${String(local)}/api/ws`);
    const echoed = nextMessage(echo);
    const [page, hello, module] = await Promise.all([fetch(`${base}/`), fetch(`${base}/api/hello`), fetch(`${base}/src/main.jsx`)]);
    echo.send("through ostra preview");
    expect(await echoed).toBe("echo: through ostra preview");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/@vite/client");
    expect(helloSchema.parse(await hello.json()).message).toBe(`hello from the API on ${String(apiPort)}`);
    expect(module.status).toBe(200);
    // Vite's HMR socket, with its client's token, and an edit that reaches it.
    const client = await (await fetch(`${base}/@vite/client`)).text();
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1] ?? "";
    expect(token).not.toBe("");
    const probe = path.join(fixtureDir, "src", `__cli-preview-${randomBytes(4).toString("hex")}.js`);
    probes.push(probe);
    await writeFile(probe, "export const probe = 1;\n");
    const hmr = await openSocket(`ws://127.0.0.1:${String(local)}/?token=${encodeURIComponent(token)}`, "vite-hmr");
    expect(hmrMessageSchema.parse(JSON.parse(await nextMessage(hmr))).type).toBe("connected");
    expect((await fetch(`${base}/src/${path.basename(probe)}`)).status).toBe(200);
    // The edit's message, not one from before it.
    skipMessages(hmr);
    const update = nextMessage(hmr, 30_000);
    await writeFile(probe, "export const probe = 2;\n");
    expect(["update", "full-reload"]).toContain(hmrMessageSchema.parse(JSON.parse(await update)).type);
    const viewId = opened.at(-1);
    if (viewId === undefined) {
      throw new Error("no view");
    }
    expect(views.tunnel(viewId)?.counts.connects).toBeGreaterThanOrEqual(4);
    expect(views.tunnel(viewId)?.counts.refused).toBe(0);
    // Ctrl+C: it ends cleanly, and core closes the view and the box's connection with it.
    run.stop();
    expect(await run.done).toBe(exitCodes.ok);
    expect(run.out()).toContain("Stopped.");
    await commandOf("preview.close", (body) => body["viewId"] === viewId);
    await waitFor("the runner's view ended", () => !views.has(viewId), 10_000);
  }, 120_000);

  it("F-143/c2: when the box's connection drops, or the member's to core, it reconnects with a new ticket and the same local port serves again", async () => {
    const taskId = await boxedTask();
    const run = preview([taskId]);
    const local = await servedPort(run);
    const base = `http://127.0.0.1:${String(local)}`;
    expect((await fetch(`${base}/api/hello`)).status).toBe(200);
    // The box's preview connection drops: core ends the CLI's tunnel with 4404, and a new ticket opens a new view.
    const first = opened.at(-1);
    if (first === undefined) {
      throw new Error("no view");
    }
    views.close(first, "closed");
    await waitFor("the reconnect", () => run.out().includes("Reconnected:"), 30_000);
    expect(run.out()).toContain(cliTunnelCloseWords("box-gone"));
    expect(run.out()).toContain("Reconnecting with a new ticket (1 of 3)...");
    expect(opened.at(-1)).not.toBe(first);
    expect(helloSchema.parse(await (await fetch(`${base}/api/hello`)).json()).message).toBe(`hello from the API on ${String(apiPort)}`);
    // The member's network to core drops, with a connection to the app open through it.
    const echo = await openSocket(`ws://127.0.0.1:${String(local)}/api/ws`);
    const echoed = nextMessage(echo);
    echo.send("before the drop");
    expect(await echoed).toBe("echo: before the drop");
    for (const socket of relayed) {
      socket.destroy();
    }
    await waitFor("the second reconnect", () => run.out().split("Reconnected:").length === 3, 30_000);
    expect(run.out()).toContain("The connection to the server dropped.");
    expect((await fetch(`${base}/`)).status).toBe(200);
    // Core lived through it: it still answers.
    expect(await answers(`${replica.url}/healthz`)).toBe(true);
  }, 120_000);

  it("F-143/c3: a port that isn't one of the task's previews is refused in the CLI's words: 22, and the API's own port", async () => {
    const taskId = await boxedTask();
    for (const port of [22, apiPort]) {
      const run = preview([taskId, String(port)]);
      expect(await run.done).toBe(exitCodes.failed);
      expect(run.out()).toContain(`ostra preview: ${cliPreviewTunnelRefusalWords({ code: "port-not-allowed" }, port)}`);
    }
  }, 60_000);

  it("F-143/c4: a CLI session revoked while its tunnel is open ends it with 4401, and it says so without a new ticket", async () => {
    const taskId = await boxedTask();
    const run = preview([taskId]);
    await servedPort(run);
    const tickets = await harness.test.db.previewCode.count({ where: { kind: "cli_ticket", cliSessionId: sessionId } });
    await harness.test.db.cliSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    try {
      expect(await run.done).toBe(exitCodes.failed);
      expect(run.out()).toContain(`ostra preview: ${cliTunnelCloseWords("session-ended")}`);
      expect(run.out()).not.toContain("Reconnecting");
      expect(await harness.test.db.previewCode.count({ where: { kind: "cli_ticket", cliSessionId: sessionId } })).toBe(tickets);
    } finally {
      await harness.test.db.cliSession.update({ where: { id: sessionId }, data: { revokedAt: null } });
    }
  }, 60_000);

  it("F-143/c2: a view core closes (its box past the warm cap) ends the tunnel with 4410, and it says so", async () => {
    const taskId = await boxedTask();
    const run = preview([taskId]);
    await servedPort(run);
    const viewId = opened.at(-1);
    if (viewId === undefined) {
      throw new Error("no view");
    }
    await closeView({ db: harness.test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, { viewId, reason: "warm-cap" });
    expect(await run.done).toBe(exitCodes.failed);
    expect(run.out()).toContain(`ostra preview: ${cliTunnelCloseWords("view-closed")}`);
    expect(run.out()).not.toContain("Reconnecting");
  }, 60_000);

  it("F-143/c6: a runner on the HTTP fallback carrier can't tunnel, and it says so", async () => {
    const taskId = await boxedTask();
    await harness.test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { carrier: "http" } });
    try {
      const run = preview([taskId]);
      expect(await run.done).toBe(exitCodes.failed);
      expect(run.out()).toContain(`ostra preview: ${cliPreviewTunnelRefusalWords({ code: "runner-cannot-tunnel" }, null)}`);
    } finally {
      await harness.test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { carrier: "websocket" } });
    }
  }, 60_000);
});
