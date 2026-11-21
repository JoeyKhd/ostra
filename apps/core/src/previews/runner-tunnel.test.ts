import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ClientHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, killTree, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, issueCliTicket, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  cliSessionIdSchema,
  mayReach,
  previewKeyFor,
  previewSupportSchema,
  previewTargets,
  previewViewIdSchema,
  runnerPaths,
  sessionIdSchema,
  tokenResponseSchema,
} from "@ostra/protocol";
import type { CliSessionId, CommandOf, DownFrame, PreviewListItem, PreviewViewId, ReservedPorts, RunnerId, TaskId } from "@ostra/protocol";
import { createPreviewViews, openPreviewConnection, startConnection, TUNNEL_NEEDS_WEBSOCKET } from "@ostra/runner";
import type { CommandHandlers, PreviewViews, RunnerConnection, Transport } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { startPreviewReplica } from "../testing/previews.ts";
import type { PreviewReplica } from "../testing/previews.ts";
import { freePort, registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { openFakeCli } from "../testing/tunnels.ts";
import type { CliRefused, FakeCli } from "../testing/tunnels.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 22 (F-143, F-144, ADR 0068 "The preview connection"): core's real tunnel
// code (ticket 23: the CLI's endpoint, the box's HTTP/2 client session, the bridge between them)
// against the runner's real side of it (`@ostra/runner`: the preview connection, the view registry
// and its HTTP/2 server, with the reach rule on every stream), on `host`, where the box's app is
// this machine's `localhost`. The app is the milestone's `test-web` fixture: a real Vite with `/api`
// behind its proxy to the Node API. Real Postgres and pg-boss; a fake runner peer takes the
// commands, and the runner's view registry opens the view's connection as the task run does. The
// HTTP carrier's refusal runs the runner's real connection against core's real gateway. The task
// run's own wiring on every executor is `apps/runner/src/task-host/preview-tunnel.*.test.ts`.

const fixtureDir = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url));

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let replica: PreviewReplica;
let runner: RegisteredAt;
let peer: FakePeer;
let vitePort = 0;
let apiPort = 0;
const apps: ChildProcess[] = [];
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const runnerRecords: LogRecord[] = [];
const runnerLogger = createLogger((record) => runnerRecords.push(record));
const secret = randomBytes(32).toString("hex");
const opened: { close: () => void }[] = [];
const taken = new Set<string>();
const probes: string[] = [];
let cacheDir = "";
/** The box's own ports by name, as a `host` box's run holds them: here only the key proxy's. */
let reserved: ReservedPorts;
/** The task's previews as the box holds them: the runner's reach rule reads this list. */
let boxPreviews: readonly PreviewListItem[] = [];
let views: PreviewViews;

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });

const runnerToken = (runnerId: RunnerId = runner.runnerId): string => replica.gateway.context.tokens.issue(runnerId, fixture.a.organization.id, Date.now()).accessToken;

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

const cliSession = async (member: SeededMember = fixture.a.member): Promise<CliSessionId> => {
  const row = await test.db.cliSession.create({
    data: { organizationId: member.organizationId, memberId: member.id, userId: member.userId, tokenHash: randomBytes(32).toString("hex"), name: "alex-laptop", expiresAt: new Date(Date.now() + 86_400_000) },
    select: { id: true },
  });
  return cliSessionIdSchema.parse(row.id);
};

const ticketFor = async (taskId: TaskId): Promise<string> => {
  const issued = await issueCliTicket({ db: test.db, clock: systemClock, coreUrl: replica.url }, scopeOf(fixture.a.member), { taskId, port: null, cliSessionId: await cliSession() });
  if (!issued.ok) {
    throw new Error(`no ticket: ${issued.error}`);
  }
  return issued.ticket;
};

const isOpen = (cli: FakeCli | CliRefused): cli is FakeCli => cli.ok;

const tunnelOpenSchema = z.looseObject({ viewId: previewViewIdSchema, key: z.string(), mode: z.literal("tunnel") });
const hmrMessageSchema = z.looseObject({ type: z.string() });
const helloSchema = z.looseObject({ message: z.string() });

/**
 * `ostra preview`'s tunnel through core, with the runner's real side: the CLI opens core's
 * endpoint with a ticket; the box's runner gets `preview.open` and its view registry opens the
 * preview connection and serves HTTP/2 on it, as the task run does.
 */
const tunnelUp = async (taskId: TaskId): Promise<{ readonly cli: FakeCli; readonly viewId: PreviewViewId }> => {
  const pending = openFakeCli(replica.url, await ticketFor(taskId));
  const open = await commandOf("preview.open", (body) => body["mode"] === "tunnel" && typeof body["viewId"] === "string" && !taken.has(body["viewId"]));
  const body = tunnelOpenSchema.parse(open.body);
  taken.add(body.viewId);
  expect(body.key).toBe(previewKeyFor({ process: "web" }));
  views.open({ viewId: body.viewId, key: previewKeyFor({ process: "web" }), ready: Promise.resolve(true) });
  const cli = await pending;
  if (!isOpen(cli)) {
    throw new Error(`the tunnel was refused: ${JSON.stringify(cli.body)}`);
  }
  opened.push(cli);
  return { cli, viewId: body.viewId };
};

const runFixture = (args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess => {
  const child = spawn(process.execPath, [...args], { cwd: fixtureDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  apps.push(child);
  return child;
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

const nextMessage = (ws: WebSocket, timeoutMs = 20_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("no message"));
    }, timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8"));
    });
  });

const openSocket = (url: string, protocol?: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    ws.once("open", () => {
      resolve(ws);
    });
    ws.once("error", reject);
  });

/** Waits for one of the box session's streams to answer: its status and its first chunk, or its whole body. */
const streamAnswer = (stream: ClientHttp2Stream, whole: boolean): Promise<{ readonly status: number; readonly body: Buffer }> =>
  new Promise((resolve, reject) => {
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (!whole) {
        resolve({ status, body: chunk });
      }
    });
    stream.on("end", () => {
      resolve({ status, body: Buffer.concat(chunks) });
    });
    stream.on("error", reject);
  });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);

  vitePort = await freePort();
  apiPort = await freePort();
  cacheDir = await mkdtemp(path.join(tmpdir(), "ostra-runner-tunnel-vite-"));
  const env = { TEST_WEB_PORT: String(vitePort), TEST_WEB_API_PORT: String(apiPort), TEST_WEB_CACHE_DIR: cacheDir };
  runFixture(["api/server.js"], env);
  runFixture([path.join("node_modules", "vite", "bin", "vite.js")], env);
  await waitFor("the fixture's Vite and API", async () => (await answers(`http://localhost:${String(vitePort)}/`)) && (await answers(`http://localhost:${String(apiPort)}/api/version`)), 60_000);

  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: vitePort, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  replica = await startPreviewReplica(test.db, test.url, { signingKey: randomBytes(32), secret, jobs, logger });
  runner = await registerRunnerAt(replica.url, test.db, fixture.a.member);
  const token = tokenResponseSchema.parse((await postJson(`${replica.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId))).body).accessToken;
  peer = await connectPeer(replica.url, token, runner.runnerId, { preview: { stream: false, tunnel: true } });
  await peer.next("welcome");

  // The box as the runner's task run holds it on `host`: its previews from the environment (the
  // primary, Vite), its own ports, and the machine's `localhost` as the way to a port.
  reserved = { "key-proxy": await freePort(), "git-proxy": null, "mcp-proxy": null, "sidecar-control": null, "agent-loopback": null, browser: null };
  boxPreviews = previewTargets({ processes: [{ name: "web", port: vitePort, label: "Web", primary: true, position: 0 }], services: [], servicesRun: false }, []);
  views = createPreviewViews({
    connect: (viewId) => openPreviewConnection({ serverUrl: replica.url, token: runnerToken(), viewId, leaseEpoch: 1, mode: "tunnel" }),
    mayReach: (port) => mayReach(port, boxPreviews, reserved),
    reachPort: (_target, port) => Promise.resolve({ ok: true, value: { host: "localhost", port, close: () => Promise.resolve() } }),
    settled: () => Promise.resolve(),
    logger: runnerLogger,
  });
}, 120_000);

afterEach(async () => {
  for (const connection of opened.splice(0)) {
    connection.close();
  }
  views.closeAll("closed");
  boxPreviews = previewTargets({ processes: [{ name: "web", port: vitePort, label: "Web", primary: true, position: 0 }], services: [], servicesRun: false }, []);
  for (const probe of probes.splice(0)) {
    await rm(probe, { force: true });
  }
});

afterAll(async () => {
  peer.close();
  await replica.stop();
  for (const app of apps) {
    if (app.pid !== undefined) {
      await killTree(app.pid);
    }
  }
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

describe("core's tunnel to the runner's", () => {
  it("F-143/c2: ostra preview's CONNECTs carry the fixture's Vite through core to the runner's tunnel on host: an HTTP request and a WebSocket at once, /api and HMR", async () => {
    const taskId = await boxedTask();
    const { cli, viewId } = await tunnelUp(taskId);
    const local = await cli.listen(vitePort);
    const base = `http://127.0.0.1:${String(local)}`;
    // A WebSocket (the API's echo behind Vite's proxy) open while HTTP requests go: each its own CONNECT.
    const echo = await openSocket(`ws://127.0.0.1:${String(local)}/api/ws`);
    opened.push(echo);
    const echoed = nextMessage(echo);
    const [page, hello, module] = await Promise.all([fetch(`${base}/`), fetch(`${base}/api/hello`), fetch(`${base}/src/main.jsx`)]);
    echo.send("through core and the runner");
    expect(await echoed).toBe("echo: through core and the runner");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/@vite/client");
    expect(helloSchema.parse(await hello.json()).message).toBe(`hello from the API on ${String(apiPort)}`);
    expect(module.status).toBe(200);
    // Vite's HMR socket, with its client's token, and an edit that reaches it.
    const client = await (await fetch(`${base}/@vite/client`)).text();
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1] ?? "";
    expect(token).not.toBe("");
    const probe = path.join(fixtureDir, "src", `__runner-tunnel-${randomBytes(4).toString("hex")}.js`);
    probes.push(probe);
    await writeFile(probe, "export const probe = 1;\n");
    const hmr = await openSocket(`ws://127.0.0.1:${String(local)}/?token=${encodeURIComponent(token)}`, "vite-hmr");
    opened.push(hmr);
    expect(hmrMessageSchema.parse(JSON.parse(await nextMessage(hmr))).type).toBe("connected");
    expect((await fetch(`${base}/src/${path.basename(probe)}`)).status).toBe(200);
    const update = nextMessage(hmr, 30_000);
    await writeFile(probe, "export const probe = 2;\n");
    expect(["update", "full-reload"]).toContain(hmrMessageSchema.parse(JSON.parse(await update)).type);
    // Each local connection was a CONNECT the runner's tunnel took, and it refused none.
    expect(views.tunnel(viewId)?.counts.connects).toBeGreaterThanOrEqual(3);
    expect(views.tunnel(viewId)?.counts.refused).toBe(0);
    // The CLI goes: core closes the view and its box connection, and the runner's view ends with it.
    cli.close();
    await commandOf("preview.close", (body) => body["viewId"] === viewId);
    await waitFor("the runner's view ended", () => !views.has(viewId), 10_000);
  }, 120_000);

  it("F-143/c3: the runner refuses a port outside the task's previews, or one of the box's own, and its 403 reaches the CLI through core", async () => {
    const taskId = await boxedTask();
    const { cli, viewId } = await tunnelUp(taskId);
    const session = replica.previews.tunnels.session(viewId);
    if (session === null) {
      throw new Error("no box session");
    }
    // On the box's session, as core sends them: the API's port is no preview here, the key proxy's is the box's own, 80 is below 1024.
    for (const port of [apiPort, reserved["key-proxy"] ?? 0, 80]) {
      const connect = session.request({ ":method": "CONNECT", ":authority": `localhost:${String(port)}` });
      expect((await streamAnswer(connect, true)).status, `CONNECT ${String(port)}`).toBe(403);
      const plain = session.request({ ":method": "GET", ":path": "/api/hello", ":authority": `localhost:${String(port)}` });
      plain.end();
      expect((await streamAnswer(plain, true)).status, `GET ${String(port)}`).toBe(403);
    }
    expect(views.tunnel(viewId)?.counts.refused).toBe(6);
    // The ticket's own port, once the box no longer lists it (its list changed): the runner's
    // refusal is the CONNECT's answer the CLI reads.
    expect((await cli.connect(vitePort)).status).toBe(200);
    boxPreviews = [];
    expect((await cli.connect(vitePort)).status).toBe(403);
    expect(records.some((record) => record.message === "preview.tunnel-refused" && record.fields["reason"] === "box" && record.fields["status"] === 403)).toBe(true);
    const reasons = runnerRecords.filter((record) => record.message === "preview.tunnel-refused").map((record) => record.fields["reason"]);
    expect(reasons).toEqual(expect.arrayContaining(["not-a-preview", "reserved", "below-min"]));
  }, 60_000);

  it("F-144/c1,c5: a plain request and an extended CONNECT on the box's session reach the fixture's Vite through the runner's tunnel, HMR included", async () => {
    const taskId = await boxedTask();
    const { viewId } = await tunnelUp(taskId);
    const session = replica.previews.tunnels.session(viewId);
    if (session === null) {
      throw new Error("no box session");
    }
    // The native preview's request (ticket 25's proxy sends it on this session): `:authority` localhost:<port>.
    const page = session.request({ ":method": "GET", ":path": "/", ":authority": `localhost:${String(vitePort)}` });
    page.end();
    const answered = await streamAnswer(page, true);
    expect(answered.status).toBe(200);
    expect(answered.body.toString("utf8")).toContain("/@vite/client");
    const clientStream = session.request({ ":method": "GET", ":path": "/@vite/client", ":authority": `localhost:${String(vitePort)}` });
    clientStream.end();
    const token = /const wsToken = "([^"]+)"/.exec((await streamAnswer(clientStream, true)).body.toString("utf8"))?.[1] ?? "";
    expect(token).not.toBe("");
    // A browser's WebSocket as an extended CONNECT (RFC 8441): Vite's HMR socket, and an edit's message on it.
    const upgrade = session.request({
      ":method": "CONNECT",
      ":protocol": "websocket",
      ":scheme": "http",
      ":path": `/?token=${encodeURIComponent(token)}`,
      ":authority": `localhost:${String(vitePort)}`,
      "sec-websocket-protocol": "vite-hmr",
      "sec-websocket-version": "13",
    });
    const texts: string[] = [];
    let held = Buffer.alloc(0);
    upgrade.on("data", (chunk: Buffer) => {
      held = Buffer.concat([held, chunk]);
      while (held.length >= 2) {
        let length = (held[1] ?? 0) & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (held.length < 4) break;
          length = held.readUInt16BE(2);
          offset = 4;
        }
        if (held.length < offset + length) break;
        if (((held[0] ?? 0) & 0x0f) === 1) {
          texts.push(held.subarray(offset, offset + length).toString("utf8"));
        }
        held = held.subarray(offset + length);
      }
    });
    const status = await new Promise<number>((resolve, reject) => {
      upgrade.once("response", (headers) => {
        resolve(Number(headers[":status"]));
      });
      upgrade.once("error", reject);
    });
    expect(status).toBe(200);
    await waitFor("Vite's connected message", () => texts.length > 0, 10_000);
    expect(hmrMessageSchema.parse(JSON.parse(texts[0] ?? "{}")).type).toBe("connected");
    const probe = path.join(fixtureDir, "src", `__runner-native-${randomBytes(4).toString("hex")}.js`);
    probes.push(probe);
    await writeFile(probe, "export const probe = 1;\n");
    const loaded = session.request({ ":method": "GET", ":path": `/src/${path.basename(probe)}`, ":authority": `localhost:${String(vitePort)}` });
    loaded.end();
    expect((await streamAnswer(loaded, true)).status).toBe(200);
    await writeFile(probe, "export const probe = 2;\n");
    await waitFor("an HMR message after the edit", () => texts.slice(1).some((text) => ["update", "full-reload"].includes(hmrMessageSchema.parse(JSON.parse(text)).type)), 30_000);
    upgrade.close();
    expect(views.tunnel(viewId)?.counts).toMatchObject({ websockets: 1, refused: 0 });
    expect(views.tunnel(viewId)?.counts.requests).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe("the runner on the HTTP carrier", () => {
  /** The runner's real connection on a carrier, recording the views it was handed. */
  const connectRunner = async (transport: Transport, ref: RegisteredAt, handed: CommandOf<"preview.open">[]): Promise<{ readonly connection: RunnerConnection; readonly dataDir: string }> => {
    const dataDir = await mkdtemp(path.join(tmpdir(), `ostra-runner-${transport}-`));
    const refused = (): Promise<{ readonly result: "rejected"; readonly reason: string }> => Promise.resolve({ result: "rejected", reason: "not-in-this-test" });
    const handlers: CommandHandlers = {
      dispatch: refused, steer: refused, interrupt: refused, stop: refused, "approval-answer": refused, drain: refused, "update-hint": refused, release: refused,
      "question-answer": refused, "plan-answer": refused, "snapshot-build": refused, "set-effort": refused, resume: refused, "app.start": refused, "app.stop": refused,
      "screenshot.take": refused, "preview.close": refused, "preview.input": refused,
      "preview.open": (command) => {
        handed.push(command);
        return Promise.resolve({ result: "accepted" });
      },
    };
    const connection = await startConnection({
      serverUrl: replica.url,
      peer: { kind: "runner", runnerId: ref.runnerId },
      transport,
      tokens: {
        get: () => Promise.resolve({ ok: true, token: runnerToken(ref.runnerId), expiresAt: Date.now() + 600_000 }),
        invalidate: () => undefined,
      },
      dataDir,
      handlers,
      // As `ostra runner` reports on `host`: it can tunnel (ticket 22), on the WebSocket.
      status: () => ({ executor: "host", capacity: 1, freeSlots: 1, labels: [], running: [], preview: { stream: false, tunnel: true } }),
      logger: silentLogger,
    });
    return { connection, dataDir };
  };

  const reportedPreview = async (runnerId: RunnerId) => {
    const row = await test.db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { preview: true } });
    return previewSupportSchema.nullable().parse(row.preview);
  };

  const sendOpen = (runnerId: RunnerId, viewId: string) =>
    test.db.$transaction((tx) =>
      postgresCommandOutbox.enqueueInTx(tx, fixture.a.organization.id, runnerId, {
        kind: "preview.open",
        body: { sessionId: sessionIdSchema.parse(`session-${viewId}`), viewId: previewViewIdSchema.parse(viewId), key: previewKeyFor({ process: "web" }), mode: "tunnel", viewport: null },
        notAfter: Date.now() + 60_000,
        task: null,
      }),
    );

  it("F-143/c6: on the HTTP carrier the runner reports no tunnel and refuses a tunnel view with the reason; on the WebSocket it reports one and takes it", async () => {
    const ref = await registerRunnerAt(replica.url, test.db, fixture.a.member);
    const handed: CommandOf<"preview.open">[] = [];
    const http = await connectRunner("http", ref, handed);
    try {
      await waitFor("the runner on the HTTP carrier", () => http.connection.report().carrier === "http", 30_000);
      await waitFor("its report", async () => (await reportedPreview(ref.runnerId)) !== null, 10_000);
      expect(await reportedPreview(ref.runnerId)).toEqual({ stream: false, tunnel: false });
      const viewId = `view-http-${randomBytes(3).toString("hex")}`;
      await sendOpen(ref.runnerId, viewId);
      await waitFor("the open's ack", async () => (await test.db.command.findFirst({ where: { runnerId: ref.runnerId, kind: "preview_open", ackedAt: { not: null } } })) !== null, 30_000);
      expect(await test.db.command.findFirstOrThrow({ where: { runnerId: ref.runnerId, kind: "preview_open" }, select: { result: true, reason: true } })).toEqual({ result: "rejected", reason: TUNNEL_NEEDS_WEBSOCKET });
      expect(handed).toEqual([]);
    } finally {
      await http.connection.stop();
      await rm(http.dataDir, { recursive: true, force: true });
    }
    const ws = await connectRunner("websocket", ref, handed);
    try {
      await waitFor("the runner on the WebSocket", () => ws.connection.report().carrier === "websocket", 30_000);
      await waitFor("its report", async () => (await reportedPreview(ref.runnerId))?.tunnel === true, 10_000);
      expect(await reportedPreview(ref.runnerId)).toEqual({ stream: false, tunnel: true });
      await sendOpen(ref.runnerId, `view-ws-${randomBytes(3).toString("hex")}`);
      await waitFor("the open handed to the runner", () => handed.length === 1, 30_000);
      expect(handed[0]?.body.mode).toBe("tunnel");
    } finally {
      await ws.connection.stop();
      await rm(ws.dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
