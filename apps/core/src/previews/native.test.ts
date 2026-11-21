import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, killTree, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  createPreviewCookies,
  dispatchTask,
  enterNativePreview,
  newPreviewLinkToken,
  postgresChangeNotices,
  postgresCommandOutbox,
  PREVIEW_COOKIE,
  previewCookieValue,
  REPLICA_SIGNATURE_HEADER,
  signReplicaRequest,
  systemClock,
} from "@ostra/domain";
import type { Clock, MemberScope, NativePreviewOpener } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  CLI_TUNNEL_SUBPROTOCOL,
  CORE_CLI_TUNNEL_PATH,
  loginSessionIdSchema,
  mayReach,
  previewKeyFor,
  previewPaths,
  previewSubprotocols,
  previewTargets,
  previewViewIdSchema,
  runnerPaths,
  tokenResponseSchema,
} from "@ostra/protocol";
import type { DownFrame, LoginSessionId, PreviewKey, PreviewListItem, ReservedPorts, RunnerId, TaskId } from "@ostra/protocol";
import { createPreviewViews, openPreviewConnection } from "@ostra/runner";
import type { PreviewViews } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { startPreviewReplica } from "../testing/previews.ts";
import type { PreviewReplica } from "../testing/previews.ts";
import { freePort, registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { NATIVE_FORWARD_PREFIX } from "./native.ts";

// Milestone 8's ticket 25 (F-144, ADR 0068 "The native preview"): core's preview domain, on
// `preview.localhost`, with the runner's real side of the tunnel (`@ostra/runner`'s view registry
// and its HTTP/2 server, with the reach rule on every stream) on `host`, where the box's apps are
// this machine's `localhost`. The apps are the milestone's fixtures: `test-web`'s real Vite with
// `/api` behind its proxy to the Node API, `test-next`'s real Next.js 16, and a small probe app of
// this file's that answers with the headers and the WebSocket `Origin` that reached it. Real
// Postgres and pg-boss; a fake runner peer takes the commands, and the runner's view registry
// opens each view's connection as the task run does. Requests go to core on loopback with a
// preview host in `Host`, as a browser's would after the wildcard record. Three replicas share the
// database and the secrets key: A, which holds the box's connections; B, which forwards to A; and
// one on the panel's own site. A fourth has no preview domain at all.

const fixtureDir = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url));
const nextDir = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-next/", import.meta.url));
const domain = "preview.localhost";
const panelUrl = "http://localhost:3000";
const sameSiteDomain = "preview.ostra.localhost";

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let a: PreviewReplica;
let b: PreviewReplica;
let sameSite: PreviewReplica;
let plain: PreviewReplica;
let runner: RegisteredAt;
let peer: FakePeer;
let views: PreviewViews;
let opener: ReturnType<typeof setInterval> | undefined;
let probe: Server | null = null;
let vitePort = 0;
let apiPort = 0;
let nextPort = 0;
let probePort = 0;
let cacheDir = "";
const apps: ChildProcess[] = [];
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const secret = randomBytes(32).toString("hex");
const sockets: WebSocket[] = [];
const probes: string[] = [];
const restores: (() => Promise<void>)[] = [];
let reserved: ReservedPorts;
let boxPreviews: readonly PreviewListItem[] = [];

const web = previewKeyFor({ process: "web" });
const next = previewKeyFor({ process: "next" });
const api = previewKeyFor({ process: "api" });
const probeKey = previewKeyFor({ process: "probe" });

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });

const runnerToken = (runnerId: RunnerId = runner.runnerId): string => a.gateway.context.tokens.issue(runnerId, fixture.a.organization.id, Date.now()).accessToken;

/** A task whose box runs on the member's runner at lease epoch 1, accepted. */
const boxedTask = async (): Promise<TaskId> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const result = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, personalSlots: 50 }, dispatchPayload(task, 1)),
  );
  if (!result.ok) {
    throw new Error("not dispatched");
  }
  await test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  return task.taskId;
};

/** A panel login session of the member's account, as better-auth keeps it. */
const loginSession = async (member: SeededMember, expiresInMs = 86_400_000): Promise<LoginSessionId> => {
  const row = await test.db.authSession.create({
    data: { id: `login-${randomBytes(6).toString("hex")}`, token: randomBytes(16).toString("hex"), userId: member.userId, expiresAt: new Date(Date.now() + expiresInMs) },
    select: { id: true },
  });
  return loginSessionIdSchema.parse(row.id);
};

const memberOpener = async (member: SeededMember = fixture.a.member, expiresInMs?: number): Promise<NativePreviewOpener> => ({
  kind: "member",
  scope: scopeOf(member),
  loginSessionId: await loginSession(member, expiresInMs),
});

/** A link to one of the task's previews: its token, and the opener that presents it. */
const linkOpener = async (taskId: TaskId, key: PreviewKey, options: { readonly allowInput: boolean; readonly expiresInMs: number }): Promise<{ readonly opener: NativePreviewOpener; readonly linkId: string }> => {
  const { token, tokenHash } = newPreviewLinkToken();
  const row = await test.db.previewLink.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      taskId,
      key,
      kind: "expiring",
      tokenHash,
      allowInput: options.allowInput,
      expiresAt: new Date(Date.now() + options.expiresInMs),
      createdByMemberId: fixture.a.member.id,
    },
    select: { id: true },
  });
  return { opener: { kind: "link", token }, linkId: row.id };
};

type Answer = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string };

/** A request to core on loopback, with `host` in `Host`: what a browser sends a preview host. A fresh connection each time. */
const hit = (base: string, host: string, pathAndQuery: string, init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string } = {}): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const target = new URL(base);
    const call = httpRequest({ host: target.hostname, port: target.port, path: pathAndQuery, method: init.method ?? "GET", headers: { host, ...init.headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    call.on("error", reject);
    call.end(init.body);
  });

type Entered = { readonly host: string; readonly origin: string; readonly answer: Answer; readonly setCookie: string; readonly cookie: string; readonly code: string };

const enterDeps = (replica: PreviewReplica, previewDomain: string = domain, clock: Clock = systemClock) => ({ db: test.db, clock, settings: { domain: previewDomain, warmMinutes: 60 }, corePublicUrl: replica.url });

/** The panel's half of the handshake (`enterNativePreview`), then the browser's: the code on the preview host. */
const enter = async (replica: PreviewReplica, taskId: TaskId, key: PreviewKey, who: NativePreviewOpener, previewDomain: string = domain): Promise<Entered> => {
  const entered = await enterNativePreview(enterDeps(replica, previewDomain), who, { taskId, key });
  if (!entered.ok) {
    throw new Error(`no code: ${entered.error}`);
  }
  const url = new URL(entered.url);
  const answer = await hit(replica.url, url.host, `${url.pathname}${url.search}`);
  const setCookie = answer.headers["set-cookie"]?.[0] ?? "";
  return { host: url.host, origin: entered.origin, answer, setCookie, cookie: setCookie.split(";")[0] ?? "", code: url.searchParams.get("code") ?? "" };
};

/** A preview host of the same task on another port: the host's label with its port swapped. */
const onPort = (host: string, port: number): string => host.replace(/^\d+-/, `${String(port)}-`);

/** An open socket, with every text message it got from the start (one can ride in with the 101). */
type Opened = { readonly ok: true; readonly ws: WebSocket; readonly said: string[] } | { readonly ok: false; readonly status: number };

const textOf = (data: WebSocket.RawData): string => (Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8"));

/** A browser's WebSocket to `host` on core: its cookie and its `Origin`, as a page sends them. */
const openWs = (base: string, host: string, pathAndQuery: string, options: { readonly cookie?: string; readonly origin?: string; readonly protocol?: string; readonly headers?: Readonly<Record<string, string>> } = {}): Promise<Opened> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}${pathAndQuery}`, options.protocol === undefined ? [] : [options.protocol], {
      headers: { host, ...(options.cookie === undefined ? {} : { cookie: options.cookie }), ...options.headers },
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      perMessageDeflate: false,
    });
    const said: string[] = [];
    ws.on("message", (data) => said.push(textOf(data)));
    ws.once("open", () => {
      sockets.push(ws);
      resolve({ ok: true, ws, said });
    });
    ws.once("unexpected-response", (request, response) => {
      response.resume();
      ws.on("error", () => undefined);
      request.destroy();
      resolve({ ok: false, status: response.statusCode ?? 0 });
    });
    ws.once("error", reject);
  });


const runFixture = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): void => {
  const child = spawn(process.execPath, [...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

/** The headers the probe app saw, and the `Origin` and `Host` its WebSocket saw. */
const echoSchema = z.looseObject({ headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])) });
const socketSeenSchema = z.strictObject({ origin: z.string().nullable(), host: z.string().nullable() });
const hmrSchema = z.looseObject({ type: z.string().optional(), action: z.string().optional() });

/** A cookie's attributes, lower-case names. */
const attributesOf = (setCookie: string): ReadonlyMap<string, string> =>
  new Map(
    setCookie
      .split(";")
      .slice(1)
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const [name = "", ...rest] = part.split("=");
        return [name.toLowerCase(), rest.join("=")] as const;
      }),
  );

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);

  vitePort = await freePort();
  apiPort = await freePort();
  nextPort = await freePort();
  probePort = await freePort();
  cacheDir = await mkdtemp(path.join(tmpdir(), "ostra-native-vite-"));
  const env = { TEST_WEB_PORT: String(vitePort), TEST_WEB_API_PORT: String(apiPort), TEST_WEB_CACHE_DIR: cacheDir };
  runFixture(fixtureDir, ["api/server.js"], env);
  runFixture(fixtureDir, [path.join("node_modules", "vite", "bin", "vite.js")], env);
  runFixture(nextDir, [path.join("node_modules", "next", "dist", "bin", "next"), "dev", "--port", String(nextPort)], { NEXT_TELEMETRY_DISABLED: "1" });

  // The probe app: what reached it, a redirect to its own localhost, a page that refuses framing,
  // and a WebSocket that says the Origin and Host it got.
  const probeSockets = new WebSocketServer({ noServer: true });
  probe = createServer((request, response) => {
    const route = (request.url ?? "/").split("?")[0];
    if (route === "/redirect") {
      response.writeHead(302, { location: `http://localhost:${String(probePort)}/next?from=probe` });
      response.end();
      return;
    }
    if (route === "/frame") {
      response.writeHead(200, { "content-type": "text/html", "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" });
      response.end("<!doctype html><p>no frames</p>");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ headers: request.headers }));
  });
  probe.on("upgrade", (request, socket, head) => {
    probeSockets.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify({ origin: request.headers.origin ?? null, host: request.headers.host ?? null }));
    });
  });
  await new Promise<void>((resolve) => {
    probe?.listen(probePort, "localhost", resolve);
  });
  await waitFor(
    "the fixtures' Vite, API and Next.js",
    async () => (await answers(`http://localhost:${String(vitePort)}/`)) && (await answers(`http://localhost:${String(apiPort)}/api/version`)) && (await answers(`http://localhost:${String(nextPort)}/`)),
    90_000,
  );

  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  const processes = [
    { name: "web", port: vitePort, label: "Web", primary: true, hostRewrite: true },
    { name: "next", port: nextPort, label: "Next", primary: false, hostRewrite: true },
    { name: "api", port: apiPort, label: "API", primary: false, hostRewrite: false },
    { name: "probe", port: probePort, label: "Probe", primary: false, hostRewrite: true },
  ];
  for (const [position, process] of processes.entries()) {
    await test.db.appProcess.create({
      data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, command: "pnpm dev", readyKind: "port", readyValue: null, position, ...process },
    });
  }
  const replica = (options: { readonly previewDomain?: string; readonly publicUrl?: string } = {}) =>
    startPreviewReplica(test.db, test.url, { signingKey: randomBytes(32), secret, jobs, logger, nativeHeartbeatMs: 500, nativeRecheckMs: 1_000, ...options });
  a = await replica({ previewDomain: domain, publicUrl: panelUrl });
  b = await replica({ previewDomain: domain, publicUrl: panelUrl });
  sameSite = await replica({ previewDomain: sameSiteDomain, publicUrl: "http://ostra.localhost:3000" });
  plain = await replica();
  runner = await registerRunnerAt(a.url, test.db, fixture.a.member);
  const token = tokenResponseSchema.parse((await postJson(`${a.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId))).body).accessToken;
  peer = await connectPeer(a.url, token, runner.runnerId, { preview: { stream: false, tunnel: true } });
  await peer.next("welcome");

  // The box as the runner's task run holds it on `host`: the environment's processes as its
  // previews, its own ports, and the machine's `localhost` as the way to a port. Each view's
  // connection goes to replica A, under the view's lease epoch.
  reserved = { "key-proxy": await freePort(), "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };
  boxPreviews = previewTargets({ processes: processes.map((item, position) => ({ ...item, position })), services: [], servicesRun: false }, []);
  views = createPreviewViews({
    connect: async (viewId) => {
      const row = await test.db.previewView.findUniqueOrThrow({ where: { id: viewId }, select: { leaseEpoch: true } });
      return openPreviewConnection({ serverUrl: a.url, token: runnerToken(), viewId, leaseEpoch: row.leaseEpoch, mode: "tunnel" });
    },
    mayReach: (port) => mayReach(port, boxPreviews, reserved),
    reachPort: (_target, port) => Promise.resolve({ ok: true, value: { host: "localhost", port, close: () => Promise.resolve() } }),
    settled: () => Promise.resolve(),
    logger: silentLogger,
  });
  // The runner takes each `preview.open` in tunnel mode and each `preview.close`, as its task host does.
  const handled = new Set<DownFrame>();
  const openSchema = z.looseObject({ viewId: previewViewIdSchema, key: z.string(), mode: z.string() });
  opener = setInterval(() => {
    for (const frame of peer.frames) {
      if (handled.has(frame) || frame.type !== "command") {
        continue;
      }
      handled.add(frame);
      const body = openSchema.safeParse(frame.body);
      if (frame.kind === "preview.open" && body.success && body.data.mode === "tunnel") {
        views.open({ viewId: body.data.viewId, key: previewKeyFor({ process: body.data.key.replace(/^app-/, "") }), ready: Promise.resolve(true) });
      }
      const closed = z.looseObject({ viewId: previewViewIdSchema }).safeParse(frame.body);
      if (frame.kind === "preview.close" && closed.success) {
        views.close(closed.data.viewId, "closed");
      }
    }
  }, 25);
}, 180_000);

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.terminate();
  }
  for (const restore of restores.splice(0)) {
    await restore();
  }
  for (const file of probes.splice(0)) {
    await rm(file, { force: true });
  }
});

afterAll(async () => {
  clearInterval(opener);
  views.closeAll("closed");
  peer.close();
  await Promise.all([a.stop(), b.stop(), sameSite.stop(), plain.stop()]);
  await new Promise<void>((resolve) => {
    if (probe === null) {
      resolve();
      return;
    }
    probe.closeAllConnections();
    probe.close(() => {
      resolve();
    });
  });
  for (const app of apps) {
    if (app.pid !== undefined) {
      await killTree(app.pid);
    }
  }
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

describe("routing by host", () => {
  it("F-144/c1: a host under the preview domain reaches the preview proxy alone, a request on core's own host never does, and a host with no matching row answers nothing of an app", async () => {
    const taskId = await boxedTask();
    const own = await enter(a, taskId, web, await memberOpener());
    expect(own.answer.status).toBe(302);
    expect(own.host).toMatch(new RegExp(`^${String(vitePort)}-[a-z2-7]{26}\\.preview\\.localhost:\\d+$`));
    const page = await hit(a.url, own.host, "/", { headers: { cookie: own.cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("/@vite/client");
    // Without the cookie: the small page that says to open it from ostra, and nothing of the app.
    const bare = await hit(a.url, own.host, "/");
    expect(bare.status).toBe(401);
    expect(bare.body).toContain("Open this preview from ostra.");
    expect(bare.body).not.toContain("vite");
    // The same cookie on a host whose preview ID no task has, and on the handshake's path there.
    const unknown = own.host.replace(/^(\d+)-[a-z2-7]{26}/, `$1-${"a".repeat(26)}`);
    const stranger = await hit(a.url, unknown, "/", { headers: { cookie: own.cookie } });
    expect([stranger.status, stranger.body.includes("vite")]).toEqual([401, false]);
    const strangerEnter = await hit(a.url, unknown, `/.ostra/enter?code=${encodeURIComponent(own.code)}`);
    expect([strangerEnter.status, strangerEnter.headers["set-cookie"]]).toEqual([404, undefined]);
    // Core's own routes on a preview host, and names under the domain that aren't a preview's.
    const corePort = new URL(a.url).port;
    for (const [host, route, method] of [
      [own.host, "/healthz", "GET"],
      [own.host, runnerPaths.token, "POST"],
      [own.host, previewPaths.frames, "POST"],
      [`preview.localhost:${corePort}`, "/", "GET"],
      [`foo.bar.preview.localhost:${corePort}`, "/healthz", "GET"],
    ] as const) {
      const answer = await hit(a.url, host, route, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect([host, route, answer.headers["content-type"]]).toEqual([host, route, "text/html; charset=utf-8"]);
      expect(answer.body).not.toContain('"ok":true');
    }
    // On core's own host the proxy's paths are core's 404, and `/healthz` is core's.
    const coreOwn = await fetch(`${a.url}/.ostra/enter?code=${encodeURIComponent(own.code)}`);
    expect([coreOwn.status, await coreOwn.json()]).toEqual([404, { error: { code: "not-found", message: "no such route" } }]);
    expect(await (await fetch(`${a.url}/healthz`)).json()).toEqual({ ok: true });
    // An upgrade on a preview host reaches the proxy, never the runner gateway: no cookie, refused there.
    expect(await openWs(a.url, own.host, runnerPaths.connect, { origin: own.origin, headers: { authorization: `Bearer ${runnerToken()}` } })).toEqual({ ok: false, status: 401 });
  }, 60_000);

  it("F-144/c2: unset, nothing of it listens: a preview host's request is core's own, and no code is minted", async () => {
    expect(plain.previews.native).toBeNull();
    const host = `5173-${"a".repeat(26)}.preview.localhost:${new URL(plain.url).port}`;
    const health = await hit(plain.url, host, "/healthz");
    expect([health.status, JSON.parse(health.body)]).toEqual([200, { ok: true }]);
    const enterPath = await hit(plain.url, host, "/.ostra/enter?code=x");
    expect([enterPath.status, JSON.parse(enterPath.body)]).toEqual([404, { error: { code: "not-found", message: "no such route" } }]);
    const taskId = await boxedTask();
    const refused = await enterNativePreview({ db: test.db, clock: systemClock, settings: { domain: null, warmMinutes: 60 }, corePublicUrl: plain.url }, await memberOpener(), { taskId, key: web });
    expect(refused).toMatchObject({ ok: false, error: "no-preview-domain" });
    expect(await test.db.previewCode.count({ where: { taskId } })).toBe(0);
  }, 60_000);
});

describe("the handshake", () => {
  it("F-144/c3: a code works once, within 60 s, on its own preview's host and port, under the lease it was minted for, and is kept only as its hash", async () => {
    const taskId = await boxedTask();
    const member = await memberOpener();
    const once = await enterNativePreview(enterDeps(a), member, { taskId, key: web });
    if (!once.ok) {
      throw new Error(once.error);
    }
    const url = new URL(once.url);
    const code = url.searchParams.get("code") ?? "";
    expect(code).toMatch(/^ostra-code-[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("path")).toBe("/");
    // Another port's host of the same preview ID, and another task's host: refused, the code unspent.
    const other = await boxedTask();
    const otherHost = (await enter(a, other, web, await memberOpener())).host;
    for (const host of [onPort(url.host, apiPort), otherHost]) {
      const wrong = await hit(a.url, host, `${url.pathname}${url.search}`);
      expect([wrong.status, wrong.headers["set-cookie"]]).toEqual([403, undefined]);
      expect(wrong.body).toContain("Open the preview from ostra again.");
    }
    // Its own host: once, then never again.
    const first = await hit(a.url, url.host, `${url.pathname}${url.search}`);
    expect([first.status, first.headers.location]).toEqual([302, "/"]);
    expect(first.headers["set-cookie"]?.[0]).toMatch(new RegExp(`^${PREVIEW_COOKIE}=ostra-preview-cookie-`));
    const second = await hit(a.url, url.host, `${url.pathname}${url.search}`);
    expect([second.status, second.headers["set-cookie"]]).toEqual([403, undefined]);
    // Past its 60 s, and minted under a lease epoch the task has left.
    const late = await enterNativePreview(enterDeps(a, domain, { now: () => Date.now() - 61_000 }), member, { taskId, key: web });
    const stale = await enterNativePreview(enterDeps(a), member, { taskId, key: web });
    if (!late.ok || !stale.ok) {
      throw new Error("no code");
    }
    const lateUrl = new URL(late.url);
    expect((await hit(a.url, lateUrl.host, `${lateUrl.pathname}${lateUrl.search}`)).status).toBe(403);
    await test.db.task.update({ where: { id: taskId }, data: { leaseEpoch: 2 } });
    const staleUrl = new URL(stale.url);
    expect((await hit(a.url, staleUrl.host, `${staleUrl.pathname}${staleUrl.search}`)).status).toBe(403);
    await test.db.task.update({ where: { id: taskId }, data: { leaseEpoch: 1 } });
    // The cookie names the member and the login session the code was bound to.
    const value = previewCookieValue(first.headers["set-cookie"]?.[0]?.split(";")[0]);
    const claims = value === null ? null : createPreviewCookies(secret).verify(value, Date.now());
    expect(claims).toMatchObject({ taskId, key: web, port: vitePort, viewer: { kind: "member", memberId: fixture.a.member.id, loginSessionId: member.kind === "member" ? member.loginSessionId : "" } });
    // Each code is a hash in its row, bound to the login session, and none reaches a log line.
    const rows = await test.db.previewCode.findMany({ where: { taskId, kind: "enter" }, select: { codeHash: true, authSessionId: true, port: true, memberId: true } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row).toMatchObject({ authSessionId: member.kind === "member" ? member.loginSessionId : "", port: vitePort, memberId: fixture.a.member.id });
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const logged = JSON.stringify(records);
    for (const secretText of [code, value ?? "", late.url, stale.url]) {
      expect(logged).not.toContain(secretText.slice(-30));
    }
  }, 60_000);

  it("F-144/c3: a member who can open the task gets a code, and a link only when it allows input; another organization's admin gets none", async () => {
    const taskId = await boxedTask();
    const watching = await linkOpener(taskId, web, { allowInput: false, expiresInMs: 3_600_000 });
    expect(await enterNativePreview(enterDeps(a), watching.opener, { taskId, key: web })).toMatchObject({ ok: false, error: "watch-only" });
    const input = await linkOpener(taskId, web, { allowInput: true, expiresInMs: 3_600_000 });
    const entered = await enter(a, taskId, web, input.opener);
    expect(entered.answer.status).toBe(302);
    const value = previewCookieValue(entered.cookie);
    expect(value === null ? null : createPreviewCookies(secret).verify(value, Date.now())?.viewer).toEqual({ kind: "link", linkId: input.linkId });
    expect((await hit(a.url, entered.host, "/", { headers: { cookie: entered.cookie } })).status).toBe(200);
    const outsider = await memberOpener(fixture.b.admin);
    expect(await enterNativePreview(enterDeps(a), outsider, { taskId, key: web })).toMatchObject({ ok: false, error: "not-found" });
  }, 60_000);

  it("F-144/c3: the cookie in both site layouts: host-only, Secure and HttpOnly, partitioned across sites and Lax on the panel's, and no longer than the session, the link or 12 hours", async () => {
    const taskId = await boxedTask();
    // Across sites: the panel on `localhost`, previews on `preview.localhost`. The session ends in an hour.
    const cross = await enter(a, taskId, web, await memberOpener(fixture.a.member, 3_600_000));
    const crossAttributes = attributesOf(cross.setCookie);
    expect(cross.setCookie.startsWith(`${PREVIEW_COOKIE}=`)).toBe(true);
    expect([...crossAttributes.keys()].sort()).toEqual(["httponly", "max-age", "partitioned", "path", "samesite", "secure"]);
    expect(crossAttributes.get("path")).toBe("/");
    expect(crossAttributes.get("samesite")).toBe("None");
    expect(Number(crossAttributes.get("max-age"))).toBeGreaterThan(3_590);
    expect(Number(crossAttributes.get("max-age"))).toBeLessThanOrEqual(3_600);
    // On the panel's site: the panel on `ostra.localhost`, previews on `preview.ostra.localhost`. A day's session: 12 hours.
    const same = await enter(sameSite, taskId, web, await memberOpener(), sameSiteDomain);
    expect(same.host).toContain(".preview.ostra.localhost:");
    const sameAttributes = attributesOf(same.setCookie);
    expect([...sameAttributes.keys()].sort()).toEqual(["httponly", "max-age", "path", "samesite", "secure"]);
    expect(sameAttributes.get("samesite")).toBe("Lax");
    expect(Number(sameAttributes.get("max-age"))).toBeGreaterThan(43_190);
    expect(Number(sameAttributes.get("max-age"))).toBeLessThanOrEqual(43_200);
    // A link's cookie lasts no longer than the link.
    const link = await linkOpener(taskId, web, { allowInput: true, expiresInMs: 2 * 3_600_000 });
    const linked = attributesOf((await enter(a, taskId, web, link.opener)).setCookie);
    expect(Number(linked.get("max-age"))).toBeGreaterThan(7_190);
    expect(Number(linked.get("max-age"))).toBeLessThanOrEqual(7_200);
  }, 60_000);
});

describe("the proxy on every request", () => {
  it("F-144/c4: it strips its cookie, every client X-Forwarded-* and any port a client names, passes no member identity, and rewrites Host, Origin and Location to and from localhost", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, probeKey, await memberOpener());
    const echo = await hit(a.url, entered.host, "/echo?x=1", {
      headers: {
        cookie: `theme=dark; ${entered.cookie}; sid=app`,
        origin: entered.origin,
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "10.0.0.1",
        "x-forwarded-proto": "https",
        forwarded: "for=10.0.0.1;host=evil.example",
        "x-ostra-member": fixture.a.member.id,
        "ostra-target-port": String(apiPort),
      },
    });
    expect(echo.status).toBe(200);
    const seen = echoSchema.parse(JSON.parse(echo.body)).headers;
    expect(seen["host"]).toBe(`localhost:${String(probePort)}`);
    expect(seen["origin"]).toBe(`http://localhost:${String(probePort)}`);
    expect(seen["cookie"]).toBe("theme=dark; sid=app");
    for (const name of Object.keys(seen)) {
      expect(name.startsWith("x-forwarded-") || name === "forwarded" || name.startsWith("x-ostra-") || name.startsWith("ostra-"), name).toBe(false);
    }
    expect(echo.body).not.toContain(fixture.a.member.id);
    expect(echo.body).not.toContain(PREVIEW_COOKIE);
    // A redirect to the app's own localhost comes back as the preview host.
    const moved = await hit(a.url, entered.host, "/redirect", { headers: { cookie: entered.cookie } });
    expect([moved.status, moved.headers.location]).toEqual([302, `http://${entered.host}/next?from=probe`]);
  }, 60_000);

  it("F-144/c4: with an app process's hostRewrite off, the app gets the real host in Host and X-Forwarded-Host; on, an app that builds a URL from Host gets localhost", async () => {
    const taskId = await boxedTask();
    const off = await enter(a, taskId, api, await memberOpener());
    const headers = await hit(a.url, off.host, "/api/headers", { headers: { cookie: off.cookie, "x-forwarded-host": "evil.example" } });
    expect(JSON.parse(headers.body)).toEqual({ host: off.host, forwardedHost: off.host });
    const on = await enter(a, taskId, web, await memberOpener());
    const built = await hit(a.url, on.host, "/host-url", { headers: { cookie: on.cookie } });
    expect(built.body).toContain(`http://localhost:${String(vitePort)}/auth/callback`);
  }, 60_000);

  it("F-144/c4: a WebSocket upgrade must come from the preview's own origin: a member's Origin goes to the app as localhost, an outside link's is kept", async () => {
    const taskId = await boxedTask();
    const member = await enter(a, taskId, probeKey, await memberOpener());
    expect(await openWs(a.url, member.host, "/socket", { cookie: member.cookie, origin: "http://evil.example" })).toEqual({ ok: false, status: 403 });
    expect(await openWs(a.url, member.host, "/socket", { cookie: member.cookie })).toEqual({ ok: false, status: 403 });
    expect(await openWs(a.url, member.host, "/socket", { origin: member.origin })).toEqual({ ok: false, status: 401 });
    const opened = await openWs(a.url, member.host, "/socket", { cookie: member.cookie, origin: member.origin });
    if (!opened.ok) {
      throw new Error(`refused: ${String(opened.status)}`);
    }
    const said = opened.said;
    await waitFor("the probe's message", () => said.length > 0, 10_000);
    expect(socketSeenSchema.parse(JSON.parse(said[0] ?? "{}"))).toEqual({ origin: `http://localhost:${String(probePort)}`, host: `localhost:${String(probePort)}` });
    const link = await linkOpener(taskId, probeKey, { allowInput: true, expiresInMs: 3_600_000 });
    const outside = await enter(a, taskId, probeKey, link.opener);
    const kept = await openWs(a.url, outside.host, "/socket", { cookie: outside.cookie, origin: outside.origin });
    if (!kept.ok) {
      throw new Error(`refused: ${String(kept.status)}`);
    }
    const keptSaid = kept.said;
    await waitFor("the probe's message", () => keptSaid.length > 0, 10_000);
    expect(socketSeenSchema.parse(JSON.parse(keptSaid[0] ?? "{}"))).toEqual({ origin: outside.origin, host: `localhost:${String(probePort)}` });
  }, 60_000);

  it("F-144/c4: a page that sent X-Frame-Options: DENY, or frame-ancestors 'none', has the panel's origin as its only frame-ancestor", async () => {
    const taskId = await boxedTask();
    const vite = await enter(a, taskId, web, await memberOpener());
    const deny = await hit(a.url, vite.host, "/frame-deny", { headers: { cookie: vite.cookie } });
    expect(deny.status).toBe(200);
    expect(deny.body).toContain("X-Frame-Options: DENY");
    expect(deny.headers["x-frame-options"]).toBeUndefined();
    expect(deny.headers["content-security-policy"]).toBe(`frame-ancestors ${panelUrl}`);
    const probed = await enter(a, taskId, probeKey, await memberOpener());
    const none = await hit(a.url, probed.host, "/frame", { headers: { cookie: probed.cookie } });
    expect(none.headers["x-frame-options"]).toBeUndefined();
    expect(none.headers["content-security-policy"]).toBe(`default-src 'self'; frame-ancestors ${panelUrl}`);
    // The small page itself shows in the pane's frame and nowhere else.
    expect((await hit(a.url, vite.host, "/")).headers["content-security-policy"]).toContain(`frame-ancestors ${panelUrl}`);
  }, 60_000);
});

describe("the fixtures through it", () => {
  it("F-144/c5: the fixture's Vite loads through the preview host on host, /api through Vite's proxy, and an edit reaches its HMR socket", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, web, await memberOpener());
    const get = (route: string) => hit(a.url, entered.host, route, { headers: { cookie: entered.cookie } });
    const [page, hello, module] = await Promise.all([get("/"), get("/api/hello"), get("/src/main.jsx")]);
    expect(page.body).toContain("/@vite/client");
    expect(JSON.parse(hello.body)).toMatchObject({ message: `hello from the API on ${String(apiPort)}` });
    expect(module.status).toBe(200);
    const token = /const wsToken = "([^"]+)"/.exec((await get("/@vite/client")).body)?.[1] ?? "";
    expect(token).not.toBe("");
    const probe = path.join(fixtureDir, "src", `__native-${randomBytes(4).toString("hex")}.js`);
    probes.push(probe);
    await writeFile(probe, "export const probe = 1;\n");
    const hmr = await openWs(a.url, entered.host, `/?token=${encodeURIComponent(token)}`, { cookie: entered.cookie, origin: entered.origin, protocol: "vite-hmr" });
    if (!hmr.ok) {
      throw new Error(`refused: ${String(hmr.status)}`);
    }
    const said = hmr.said;
    await waitFor("Vite's connected message", () => said.length > 0, 10_000);
    expect(hmrSchema.parse(JSON.parse(said[0] ?? "{}")).type).toBe("connected");
    expect((await get(`/src/${path.basename(probe)}`)).status).toBe(200);
    await writeFile(probe, "export const probe = 2;\n");
    await waitFor("an HMR message after the edit", () => said.slice(1).some((text) => ["update", "full-reload"].includes(hmrSchema.parse(JSON.parse(text)).type ?? "")), 30_000);
    // The API's WebSocket echo, behind Vite's proxy, through the same preview host.
    const echo = await openWs(a.url, entered.host, "/api/ws", { cookie: entered.cookie, origin: entered.origin });
    if (!echo.ok) {
      throw new Error(`refused: ${String(echo.status)}`);
    }
    const echoed = echo.said;
    echo.ws.send("through the preview host");
    await waitFor("the echo", () => echoed.length > 0, 10_000);
    expect(echoed[0]).toBe("echo: through the preview host");
  }, 90_000);

  it("F-144/c5: the fixture's Next.js 16 loads through the preview host on host, with no project change, and an edit reaches its HMR socket", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, next, await memberOpener());
    const page = await hit(a.url, entered.host, "/", { headers: { cookie: entered.cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain("test-next");
    const hmr = await openWs(a.url, entered.host, "/_next/hmr", { cookie: entered.cookie, origin: entered.origin });
    if (!hmr.ok) {
      throw new Error(`refused: ${String(hmr.status)}`);
    }
    const said = hmr.said;
    await waitFor("Next.js's connected message", () => said.some((text) => hmrSchema.parse(JSON.parse(text)).type === "turbopack-connected"), 15_000);
    const pageFile = path.join(nextDir, "app", "page.js");
    const original = await readFile(pageFile, "utf8");
    restores.push(() => writeFile(pageFile, original));
    const before = said.length;
    await writeFile(pageFile, original.replace("<h1>test-next</h1>", `<h1>test-next ${randomBytes(3).toString("hex")}</h1>`));
    await waitFor("an HMR message after the edit", () => said.slice(before).some((text) => ["serverComponentChanges", "built", "building", "turbopack-message", "reloadPage"].includes(hmrSchema.parse(JSON.parse(text)).type ?? hmrSchema.parse(JSON.parse(text)).action ?? "")), 30_000);
  }, 90_000);
});

describe("the checks while it lasts", () => {
  it("F-144/c3: a revoked link's cookie opens nothing on its next connection and is cleared, and its open socket ends at the next check", async () => {
    const taskId = await boxedTask();
    const link = await linkOpener(taskId, probeKey, { allowInput: true, expiresInMs: 3_600_000 });
    const entered = await enter(a, taskId, probeKey, link.opener);
    const opened = await openWs(a.url, entered.host, "/socket", { cookie: entered.cookie, origin: entered.origin });
    if (!opened.ok) {
      throw new Error(`refused: ${String(opened.status)}`);
    }
    const closed = new Promise<number>((resolve) => {
      opened.ws.on("close", resolve);
    });
    await test.db.previewLink.update({ where: { id: link.linkId }, data: { revokedAt: new Date(), revokedByMemberId: fixture.a.member.id } });
    const after = await hit(a.url, entered.host, "/echo", { headers: { cookie: entered.cookie } });
    expect(after.status).toBe(401);
    expect(after.body).toContain("Open this preview from ostra.");
    expect(attributesOf(after.headers["set-cookie"]?.[0] ?? "").get("max-age")).toBe("0");
    expect(await closed).toBeGreaterThan(0);
  }, 60_000);

  it("F-144/c1: a stale lease ends the cookie's view, and the task's next lease is picked up under the same preview host", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, web, await memberOpener());
    expect((await hit(a.url, entered.host, "/", { headers: { cookie: entered.cookie } })).status).toBe(200);
    const first = await test.db.previewView.findFirstOrThrow({ where: { taskId, mode: "native", state: { not: "closed" } }, select: { id: true, leaseEpoch: true } });
    expect(first.leaseEpoch).toBe(1);
    // A reopen: the first lease ends, a fresh box takes the task under epoch 2 on the same runner.
    const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { organizationId: true, projectId: true } });
    await test.db.lease.updateMany({ where: { taskId, epoch: 1 }, data: { state: "ended", endedAt: new Date() } });
    await test.db.session.updateMany({ where: { taskId }, data: { state: "stopped" } });
    const box = await test.db.box.create({ data: { organizationId: task.organizationId, projectId: task.projectId, taskId, runnerId: runner.runnerId, executor: "host", state: "ready" }, select: { id: true } });
    await test.db.lease.create({ data: { organizationId: task.organizationId, projectId: task.projectId, taskId, epoch: 2, runnerId: runner.runnerId, boxId: box.id, acceptedAt: new Date() } });
    await test.db.session.create({ data: { organizationId: task.organizationId, projectId: task.projectId, taskId, boxId: box.id, agentProfileId: world.profileId, origin: "resumed", state: "starting" } });
    await test.db.task.update({ where: { id: taskId }, data: { leaseEpoch: 2 } });
    // Replica A ends the old view's tunnel at its next check; the same cookie on the same host then
    // gets a view under the new lease.
    await waitFor("the old tunnel ended", () => a.previews.tunnels.session(previewViewIdSchema.parse(first.id)) === null, 10_000);
    const again = await hit(a.url, entered.host, "/", { headers: { cookie: entered.cookie } });
    expect(again.status).toBe(200);
    expect(again.body).toContain("/@vite/client");
    const now = await test.db.previewView.findFirstOrThrow({ where: { taskId, mode: "native", state: { not: "closed" } }, select: { id: true, leaseEpoch: true } });
    expect(now.leaseEpoch).toBe(2);
    expect(now.id).not.toBe(first.id);
    expect((await test.db.previewView.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("closed");
  }, 60_000);

  it("F-144/c9: over the HTTP fallback carrier there's no native preview: no code, and a cookie opens nothing", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, probeKey, await memberOpener());
    const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId }, select: { carrier: true } });
    const report = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId }, select: { preview: true } });
    await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { carrier: "http" } });
    await test.db.runner.update({ where: { id: runner.runnerId }, data: { preview: { stream: true, tunnel: true } } });
    restores.push(async () => {
      await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { carrier: presence.carrier } });
      await test.db.runner.update({ where: { id: runner.runnerId }, data: { preview: report.preview ?? { stream: false, tunnel: true } } });
    });
    expect(await enterNativePreview(enterDeps(a), await memberOpener(), { taskId, key: probeKey })).toMatchObject({ ok: false, error: "runner-cannot-tunnel" });
    const refused = await hit(a.url, entered.host, "/echo", { headers: { cookie: entered.cookie } });
    expect(refused.status).toBe(503);
    expect(refused.body).toContain("isn't running now");
  }, 60_000);
});

describe("two replicas", () => {
  it("F-144/c1: a preview host's requests and WebSockets on the replica without the box's connection are forwarded, signed, to the one with it; a forwarded request that doesn't verify is refused", async () => {
    const taskId = await boxedTask();
    const entered = await enter(b, taskId, web, await memberOpener());
    const get = (route: string) => hit(b.url, entered.host, route, { headers: { cookie: entered.cookie } });
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("/@vite/client");
    const view = await test.db.previewView.findFirstOrThrow({ where: { taskId, mode: "native", state: "open" }, select: { id: true, replicaUrl: true } });
    const viewId = previewViewIdSchema.parse(view.id);
    // The box's connection is A's; B holds no session for it, and forwarded the request there.
    expect(view.replicaUrl).toBe(a.url);
    expect(b.previews.tunnels.session(viewId)).toBeNull();
    expect(a.previews.tunnels.session(viewId)).not.toBeNull();
    expect(JSON.parse((await get("/api/hello")).body)).toMatchObject({ message: `hello from the API on ${String(apiPort)}` });
    // Vite's HMR socket through B, to A, to the box.
    const token = /const wsToken = "([^"]+)"/.exec((await get("/@vite/client")).body)?.[1] ?? "";
    const hmr = await openWs(b.url, entered.host, `/?token=${encodeURIComponent(token)}`, { cookie: entered.cookie, origin: entered.origin, protocol: "vite-hmr" });
    if (!hmr.ok) {
      throw new Error(`refused: ${String(hmr.status)}`);
    }
    const said = hmr.said;
    await waitFor("Vite's connected message", () => said.length > 0, 10_000);
    expect(hmrSchema.parse(JSON.parse(said[0] ?? "{}")).type).toBe("connected");
    // A forwarded request is taken on its signature alone: a wrong MAC, another key, another path, and none are refused.
    const authority = Buffer.from(`localhost:${String(vitePort)}`).toString("base64url");
    const forwarded = `${NATIVE_FORWARD_PREFIX}${viewId}/${String(vitePort)}/${authority}/`;
    const signed = (secretText: string, signedPath: string) => signReplicaRequest(secretText, { method: "GET", path: signedPath, viewId, at: Date.now() });
    const coreHost = new URL(a.url).host;
    for (const signature of [`${String(Date.now())}.${"A".repeat(43)}`, signed("not-the-replicas-key", forwarded), signed(secret, `${forwarded}other`), null]) {
      const answer = await hit(a.url, coreHost, forwarded, { headers: signature === null ? {} : { [REPLICA_SIGNATURE_HEADER]: signature } });
      expect(answer.status, String(signature)).toBe(403);
      expect(answer.body).not.toContain("vite");
    }
    // One signed under the shared key is a replica's: A serves it from its own session.
    const good = await hit(a.url, coreHost, forwarded, { headers: { [REPLICA_SIGNATURE_HEADER]: signed(secret, forwarded) } });
    expect(good.status).toBe(200);
    expect(good.body).toContain("/@vite/client");
    // B never serves one from a session it doesn't hold, and never forwards a signed one again.
    const atB = await hit(b.url, new URL(b.url).host, forwarded, { headers: { [REPLICA_SIGNATURE_HEADER]: signed(secret, forwarded) } });
    expect(atB.status).toBe(409);
  }, 60_000);
});

describe("core's own WebSockets", () => {
  it("F-144/c7: every WebSocket core serves on its own host refuses an upgrade from a preview host's origin, a good token or not", async () => {
    const taskId = await boxedTask();
    const entered = await enter(a, taskId, web, await memberOpener());
    expect((await hit(a.url, entered.host, "/", { headers: { cookie: entered.cookie } })).status).toBe(200);
    const coreHost = new URL(a.url).host;
    const fromPreview = { origin: entered.origin, headers: { authorization: `Bearer ${runnerToken()}` } };
    expect(await openWs(a.url, coreHost, runnerPaths.connect, fromPreview)).toEqual({ ok: false, status: 403 });
    const view = await test.db.previewView.findFirstOrThrow({ where: { taskId, mode: "native" }, select: { id: true } });
    expect(await openWs(a.url, coreHost, `${previewPaths.connection}?view=${view.id}&leaseEpoch=1`, { ...fromPreview, protocol: previewSubprotocols.tunnel })).toEqual({ ok: false, status: 400 });
    expect(await openWs(a.url, coreHost, `${CORE_CLI_TUNNEL_PATH}?ticket=ostra_pt_${"a".repeat(43)}`, { origin: entered.origin, protocol: CLI_TUNNEL_SUBPROTOCOL })).toEqual({ ok: false, status: 400 });
  }, 60_000);
});
