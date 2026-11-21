import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger, killTree } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  dispatchTask,
  issueCliTicket,
  postgresChangeNotices,
  postgresCommandOutbox,
  systemClock,
} from "@ostra/domain";
import type { Clock, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { cliSessionIdSchema, cliTunnelCloseCodes, cliTunnelErrorSchema, previewKeyFor, previewViewIdSchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { CliSessionId, DownFrame, PreviewViewId, RunnerId, TaskId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { startPreviewReplica } from "../testing/previews.ts";
import type { PreviewReplica } from "../testing/previews.ts";
import { freePort, registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { connectFakeTunnelBox, openFakeCli, openHostileCli } from "../testing/tunnels.ts";
import type { CliRefused, FakeCli, FakeTunnelBox, HostileCli } from "../testing/tunnels.ts";
import { editUntil, hasMessage, nextMessage, openSocket, skipMessages } from "../testing/websockets.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 23 (F-143, ADR 0068 "`ostra preview`"): core's tunnel for the CLI. Real
// Postgres and pg-boss, core's gateway and previews on a loopback port, a fake runner at minor 7
// that says it can tunnel, a fake box serving HTTP/2 on its preview connection as the sidecar
// does (ticket 22 builds the real one), and a fake `ostra preview` that opens core's tunnel with a
// ticket and carries local connections as CONNECT streams (ticket 24 builds the real one). The app
// is the milestone's own fixture (`e2e/m8-previews-and-library/fixtures/test-web`): a real Vite
// dev server with `/api` behind its proxy to a Node API, run on free ports on this machine (the
// `host` executor's case). The two-replica case is in `replicas.test.ts`. A hostile CLI (one that
// never answers core's close frame, or sends garbage) never takes core down (the fix after ticket 24).

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
const secret = randomBytes(32).toString("hex");
/** Core's clock, which a test moves on to make a ticket old. */
let offset = 0;
const clock: Clock = { now: () => Date.now() + offset };
const opened: { close: () => void }[] = [];
/** The views whose `preview.open` a test already played the runner's part for. */
const taken = new Set<string>();

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });

/** The runner's own access token, for a `host` box's preview connection. */
const runnerToken = (runnerId: RunnerId = runner.runnerId): string => replica.gateway.context.tokens.issue(runnerId, fixture.a.organization.id, Date.now()).accessToken;

/** The next command of `kind` the peer got that `match` takes. */
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

type Boxed = { readonly taskId: TaskId; readonly boxId: string };

/** A prompt task leased to the member's `host` runner, its offer accepted. */
const boxedTask = async (): Promise<Boxed> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const result = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, personalSlots: 50 }, dispatchPayload(task, 1)),
  );
  if (!result.ok) {
    throw new Error("not dispatched");
  }
  await test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  return { taskId: task.taskId, boxId: result.boxId };
};

/** A CLI session of the member, as `ostra login` ends with. */
const cliSession = async (member: SeededMember = fixture.a.member): Promise<CliSessionId> => {
  const row = await test.db.cliSession.create({
    data: { organizationId: member.organizationId, memberId: member.id, userId: member.userId, tokenHash: randomBytes(32).toString("hex"), name: "alex-laptop", expiresAt: new Date(Date.now() + 86_400_000) },
    select: { id: true },
  });
  return cliSessionIdSchema.parse(row.id);
};

/** A ticket for the task's primary (the fixture's Vite), as the web app's CLI route gives it. */
const ticketFor = async (taskId: TaskId, sessionId: CliSessionId, port: number | null = null): Promise<string> => {
  const issued = await issueCliTicket({ db: test.db, clock, coreUrl: replica.url }, scopeOf(fixture.a.member), { taskId, port, cliSessionId: sessionId });
  if (!issued.ok) {
    throw new Error(`no ticket: ${issued.error}`);
  }
  return issued.ticket;
};

const isOpen = (cli: FakeCli | CliRefused): cli is FakeCli => cli.ok;

/** A `preview.open` in `tunnel` mode: its view is all a test reads. */
const tunnelOpenSchema = z.looseObject({ viewId: previewViewIdSchema, mode: z.literal("tunnel") });

/** A Vite HMR message: its kind is all a test reads. */
const hmrMessageSchema = z.looseObject({ type: z.string() });

/** Plays the runner's part for a CLI's new view: its box opens the preview connection in `tunnel` mode once `preview.open` arrives. */
const boxUp = async (taskId: TaskId): Promise<{ readonly box: FakeTunnelBox; readonly viewId: PreviewViewId }> => {
  const open = await commandOf("preview.open", (body) => body["mode"] === "tunnel" && typeof body["viewId"] === "string" && !taken.has(body["viewId"]));
  const viewId = tunnelOpenSchema.parse(open.body).viewId;
  taken.add(viewId);
  expect(await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).toMatchObject({ taskId, mode: "cli", openedByMemberId: fixture.a.member.id, leaseEpoch: 1 });
  const box = await connectFakeTunnelBox(replica.url, viewId, 1, runnerToken(), [vitePort]);
  opened.push(box);
  return { box, viewId };
};

/**
 * Opens the CLI's tunnel with `ticket`, plays the runner's part (the box opens its preview
 * connection in `tunnel` mode once `preview.open` arrives), and resolves once the tunnel is up.
 */
const tunnelUp = async (taskId: TaskId, ticket: string): Promise<{ readonly cli: FakeCli; readonly box: FakeTunnelBox; readonly viewId: PreviewViewId }> => {
  const pending = openFakeCli(replica.url, ticket);
  const { box, viewId } = await boxUp(taskId);
  const cli = await pending;
  if (!isOpen(cli)) {
    throw new Error(`the tunnel was refused: ${JSON.stringify(cli.body)}`);
  }
  opened.push(cli);
  return { cli, box, viewId };
};

/** A hostile CLI's tunnel with `ticket`, the runner's part played as for any: resolves at core's 101. */
const hostileUp = async (taskId: TaskId, ticket: string): Promise<{ readonly cli: HostileCli; readonly box: FakeTunnelBox; readonly viewId: PreviewViewId }> => {
  const pending = openHostileCli(replica.url, ticket);
  const { box, viewId } = await boxUp(taskId);
  const cli = await pending;
  opened.push({ close: cli.destroy });
  return { cli, box, viewId };
};

/** Collects every uncaught exception while `run` runs: a tunnel's must never reach the process. */
const uncaughtDuring = async (run: () => Promise<void>): Promise<readonly unknown[]> => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  try {
    await run();
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  return uncaught;
};

/** Waits for a view's row to close, then checks nothing of its CLI is left on this replica. */
const viewClosed = async (viewId: PreviewViewId): Promise<void> => {
  await waitFor("the hostile CLI's view closed", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).state === "closed", 10_000);
  expect(replica.previews.cliTunnels.open(viewId)).toBe(0);
  expect(replica.previews.tunnels.clis(viewId)).toBe(0);
};

/** One of the fixture's processes, from its folder. */
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


beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);

  // The fixture's app on free ports: Vite (the primary, told `localhost`) and its API behind Vite's proxy.
  vitePort = await freePort();
  apiPort = await freePort();
  const env = { TEST_WEB_PORT: String(vitePort), TEST_WEB_API_PORT: String(apiPort) };
  runFixture(["api/server.js"], env);
  runFixture([path.join("node_modules", "vite", "bin", "vite.js")], env);
  await waitFor("the fixture's Vite and API", async () => (await answers(`http://localhost:${String(vitePort)}/`)) && (await answers(`http://localhost:${String(apiPort)}/api/version`)), 60_000);

  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: vitePort, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  replica = await startPreviewReplica(test.db, test.url, { signingKey: randomBytes(32), secret, jobs, logger, clock, cliRecheckMs: 300, cliCloseWaitMs: 500 });
  runner = await registerRunnerAt(replica.url, test.db, fixture.a.member);
  const token = tokenResponseSchema.parse((await postJson(`${replica.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId))).body).accessToken;
  peer = await connectPeer(replica.url, token, runner.runnerId, { preview: { stream: true, tunnel: true } });
  await peer.next("welcome");
}, 120_000);

afterEach(() => {
  offset = 0;
  for (const connection of opened.splice(0)) {
    connection.close();
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
}, 60_000);

describe("core's tunnel for ostra preview", () => {
  it("F-143/c2: a CONNECT from the CLI carries the fixture's Vite through core to the box on host: the page, /api, a WebSocket and HMR", async () => {
    const task = await boxedTask();
    const { cli, box, viewId } = await tunnelUp(task.taskId, await ticketFor(task.taskId, await cliSession()));
    // The view is open on this replica, and its box's HTTP/2 session is the one ticket 25's proxy sends on.
    // The tunnel carries bytes from the box's SETTINGS on, while the row's `open` and presence
    // (`markViewConnected`) are written beside it, and may land just after the CLI's upgrade.
    await waitFor("the view's presence", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).replicaUrl === replica.url, 10_000);
    expect(await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).toMatchObject({ state: "open", replicaUrl: replica.url });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "preview.opened" } })).toBe(1);
    expect(replica.previews.cliTunnels.open(viewId)).toBe(1);

    // `ostra preview`'s local port: every TCP connection to it is one CONNECT through core.
    const local = await cli.listen(vitePort);
    const base = `http://127.0.0.1:${String(local)}`;
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/@vite/client");
    const client = await (await fetch(`${base}/@vite/client`)).text();
    const token = /const wsToken = "([^"]+)"/.exec(client)?.[1];
    expect(token).toBeDefined();
    // The frontend's `/api`, through Vite's own proxy to the API.
    const hello = await fetch(`${base}/api/hello`);
    expect(await hello.json()).toMatchObject({ message: `hello from the API on ${String(apiPort)}` });
    // Any WebSocket: the API's echo behind Vite's proxy.
    const echo = await openSocket(`ws://127.0.0.1:${String(local)}/api/ws`);
    const echoed = nextMessage(echo);
    echo.send("through the tunnel");
    expect(await echoed).toBe("echo: through the tunnel");
    echo.close();

    // Vite's HMR socket, with the token its client carries, and an edit that reaches it.
    const probe = `__tunnel-probe-${randomBytes(4).toString("hex")}.js`;
    const probePath = path.join(fixtureDir, "src", probe);
    await writeFile(probePath, "export const probe = 1;\n");
    try {
      const hmr = await openSocket(`ws://127.0.0.1:${String(local)}/?token=${encodeURIComponent(token ?? "")}`, "vite-hmr");
      expect(JSON.parse(await nextMessage(hmr))).toMatchObject({ type: "connected" });
      expect((await fetch(`${base}/src/${probe}`)).status).toBe(200);
      // The edit's message, not one from before it.
      skipMessages(hmr);
      await editUntil(probePath, () => hasMessage(hmr));
      expect(["update", "full-reload"]).toContain(hmrMessageSchema.parse(JSON.parse(await nextMessage(hmr))).type);
      hmr.close();
    } finally {
      await rm(probePath, { force: true });
    }

    // The box's session itself carries an extended CONNECT (RFC 8441) to Vite's HMR socket, as the
    // native preview's proxy will send a browser's WebSocket (ticket 25).
    const session = replica.previews.tunnels.session(viewId);
    expect(session).not.toBeNull();
    const upgrade = session?.request({
      ":method": "CONNECT",
      ":protocol": "websocket",
      ":scheme": "http",
      ":path": `/?token=${encodeURIComponent(token ?? "")}`,
      ":authority": `localhost:${String(vitePort)}`,
      "sec-websocket-protocol": "vite-hmr",
    });
    const [status, first] = await new Promise<[number, Buffer]>((resolve, reject) => {
      upgrade?.on("response", (headers) => {
        upgrade.once("data", (chunk: Buffer) => {
          resolve([Number(headers[":status"]), chunk]);
        });
      });
      upgrade?.on("error", reject);
    });
    expect(status).toBe(200);
    // Vite's first frame, unmasked text: `{"type":"connected"}`.
    expect(first[0]).toBe(0x81);
    expect(JSON.parse(first.subarray(2, 2 + (first[1] ?? 0)).toString("utf8"))).toMatchObject({ type: "connected" });
    upgrade?.close();
    expect(box.counts.connects).toBeGreaterThanOrEqual(5);
    expect(box.counts.websockets).toBe(1);

    // The CLI goes: its view closes, and `preview.close` reaches the box's runner.
    cli.close();
    await waitFor("the cli view closed", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).state === "closed", 10_000);
    await commandOf("preview.close", (body) => body["viewId"] === viewId);
    await box.closed;
    expect(replica.previews.tunnels.holds(viewId)).toBe(false);
  }, 120_000);

  it("F-143/c4: a ticket works once, and not after 60 s", async () => {
    const task = await boxedTask();
    const sessionId = await cliSession();
    const ticket = await ticketFor(task.taskId, sessionId);
    // Stored as its hash, bound to the member, the CLI session, the task, the port and the epoch.
    const row = await test.db.previewCode.findFirstOrThrow({ where: { taskId: task.taskId, kind: "cli_ticket" } });
    expect(row).toMatchObject({ memberId: fixture.a.member.id, cliSessionId: sessionId, port: vitePort, key: previewKeyFor({ process: "web" }), leaseEpoch: 1, usedAt: null });
    expect(JSON.stringify(row)).not.toContain(ticket);

    const { cli } = await tunnelUp(task.taskId, ticket);
    expect((await test.db.previewCode.findUniqueOrThrow({ where: { id: row.id } })).usedAt).not.toBeNull();
    // The same ticket again: refused before any upgrade, in the CLI's words.
    const again = await openFakeCli(replica.url, ticket);
    expect(again.ok).toBe(false);
    expect(again.ok ? null : [again.status, cliTunnelErrorSchema.parse(again.body).error.code]).toEqual([403, "ticket-refused"]);
    cli.close();

    // A fresh ticket, 61 s later by core's clock: expired.
    const late = await ticketFor(task.taskId, sessionId);
    offset = 61_000;
    const expired = await openFakeCli(replica.url, late);
    expect(expired.ok ? null : [expired.status, cliTunnelErrorSchema.parse(expired.body).error.code]).toEqual([403, "ticket-refused"]);
    offset = 0;
    // A browser's page never opens it, even with a good ticket.
    const fromPage = await openFakeCli(replica.url, await ticketFor(task.taskId, sessionId), { origin: "https://evil.example" });
    expect(fromPage.ok ? null : [fromPage.status, cliTunnelErrorSchema.parse(fromPage.body).error.code]).toEqual([400, "bad-request"]);
    // Never a ticket in a log line.
    expect(JSON.stringify(records)).not.toContain(ticket);
    expect(JSON.stringify(records)).not.toContain(late);
  }, 60_000);

  it("F-143/c3: a port outside the task's previews is refused, at the ticket and in the tunnel", async () => {
    const task = await boxedTask();
    const sessionId = await cliSession();
    // At the ticket: a port no preview serves, and one below 1024.
    for (const port of [apiPort, 22]) {
      const refused = await issueCliTicket({ db: test.db, clock, coreUrl: replica.url }, scopeOf(fixture.a.member), { taskId: task.taskId, port, cliSessionId: sessionId });
      expect(refused).toMatchObject({ ok: false, error: "port-not-allowed" });
    }
    // In the tunnel: a CONNECT to any port but the ticket's is answered 403 by core, and the box never sees it.
    const { cli, box } = await tunnelUp(task.taskId, await ticketFor(task.taskId, sessionId));
    const before = box.counts.connects;
    expect((await cli.connect(apiPort)).status).toBe(403);
    expect((await cli.connect(22)).status).toBe(403);
    expect(box.counts.connects).toBe(before);
    expect(box.counts.refused).toBe(0);
    // The ticket's own port is carried.
    const own = await cli.connect(vitePort);
    expect(own.status).toBe(200);
    own.stream.close();
    expect(records.some((record) => record.message === "preview.tunnel-refused" && record.fields["reason"] === "port-not-allowed")).toBe(true);
  }, 60_000);

  it("F-143/c4: a revoked CLI session ends the tunnel", async () => {
    const task = await boxedTask();
    const sessionId = await cliSession();
    const { cli, viewId } = await tunnelUp(task.taskId, await ticketFor(task.taskId, sessionId));
    const local = await cli.listen(vitePort);
    expect((await fetch(`http://127.0.0.1:${String(local)}/`)).status).toBe(200);
    // The member signs the machine out in the panel: the next check ends the tunnel with 4401.
    await test.db.cliSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    expect((await cli.closed).code).toBe(cliTunnelCloseCodes["session-ended"]);
    await waitFor("the cli view closed", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).state === "closed", 10_000);
    await expect(fetch(`http://127.0.0.1:${String(local)}/`)).rejects.toThrow();
  }, 60_000);

  it("F-143/c2: a CLI that never answers core's close frame is cut, and core stays up: its view closes, nothing escapes, other tunnels go on", async () => {
    const task = await boxedTask();
    const uncaught = await uncaughtDuring(async () => {
      // A well-behaved CLI on its own view of the same task.
      const { cli: other } = await tunnelUp(task.taskId, await ticketFor(task.taskId, await cliSession()));
      const local = await other.listen(vitePort);
      expect((await fetch(`http://127.0.0.1:${String(local)}/`)).status).toBe(200);

      // The hostile one speaks HTTP/2 and holds a CONNECT to the app open, then goes silent.
      const sessionId = await cliSession();
      const { cli: hostile, box, viewId } = await hostileUp(task.taskId, await ticketFor(task.taskId, sessionId));
      const session = hostile.http2();
      const status = await new Promise<number>((resolve, reject) => {
        const stream = session.request({ ":method": "CONNECT", ":authority": `localhost:${String(vitePort)}` });
        stream.on("response", (headers) => {
          resolve(Number(headers[":status"]));
        });
        stream.on("error", reject);
      });
      expect(status).toBe(200);
      expect(replica.previews.tunnels.clis(viewId)).toBe(1);
      hostile.silence();

      // Core ends the tunnel (the CLI session revoked, 4401) while its HTTP/2 session is live. The
      // CLI never answers the close frame, so core cuts its socket: the view closes.
      await test.db.cliSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
      await viewClosed(viewId);
      expect(records.some((record) => record.message === "preview.cli-closed" && record.fields["viewId"] === viewId && record.fields["code"] === 1006)).toBe(true);
      // The box goes after the cut: the CLI's session is gone with its socket, so nothing writes on it.
      box.close();
      await box.closed;
      await waitFor("the box's tunnel dropped", () => !replica.previews.tunnels.holds(viewId), 10_000);

      // The other tunnel goes on, on the same core.
      expect((await fetch(`http://127.0.0.1:${String(local)}/`)).status).toBe(200);
    });
    expect(uncaught).toEqual([]);
  }, 60_000);

  it("F-143/c2: a CLI that sends garbage after the upgrade is closed, and core stays up: bytes that aren't HTTP/2, and bytes that aren't a WebSocket frame", async () => {
    const task = await boxedTask();
    const uncaught = await uncaughtDuring(async () => {
      const { cli: other } = await tunnelUp(task.taskId, await ticketFor(task.taskId, await cliSession()));
      const local = await other.listen(vitePort);
      expect((await fetch(`http://127.0.0.1:${String(local)}/`)).status).toBe(200);

      // Binary messages, but not HTTP/2's preface: the CLI's session fails, and its socket closes with 1002.
      const notHttp2 = await hostileUp(task.taskId, await ticketFor(task.taskId, await cliSession()));
      notHttp2.cli.sendFrame(Buffer.from("this is not HTTP/2\r\n\r\n".repeat(4)));
      // Bytes that aren't a WebSocket frame at all (RSV2 and RSV3 set): `ws` refuses them.
      const notWebSocket = await hostileUp(task.taskId, await ticketFor(task.taskId, await cliSession()));
      notWebSocket.cli.sendRaw(Buffer.from("this is not a WebSocket frame\r\n"));

      // Neither answers core's close frame: each view closes all the same.
      await viewClosed(notHttp2.viewId);
      await viewClosed(notWebSocket.viewId);
      expect(records.some((record) => record.message === "preview.cli-protocol-error" && record.fields["viewId"] === notHttp2.viewId)).toBe(true);

      expect((await fetch(`http://127.0.0.1:${String(local)}/`)).status).toBe(200);
    });
    expect(uncaught).toEqual([]);
  }, 60_000);
});
