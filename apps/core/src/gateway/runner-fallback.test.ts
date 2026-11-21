import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import { issueTestCert, makeTestCa, startConnectProxy, startNginxDefaults, startTlsInspectingProxy } from "@ostra/adapter-sdk/testing/net";
import type { RunningProxy, TestCa, TestCert } from "@ostra/adapter-sdk/testing/net";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { clientMessageIdSchema, projectIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { CommandOf, TaskEvent } from "@ostra/protocol";
import { startConnection } from "@ostra/runner";
import type { Carrier, CommandHandlers, FallbackReason, NetworkOptions, RunnerConnection, Transport } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createIngest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import type { RunnerRef } from "./context.ts";

// Milestone 5's ticket 18 (F-013, ADR 0034, "Networks"): the real runner connection
// (`apps/runner`'s `startConnection`) falling back to core's real HTTP carrier (ticket 11) by
// itself, through ticket 06's proxies, over a migrated database with the real ingest. Core speaks
// plain HTTP here, so a TLS front stands where a real install's TLS ends, with a certificate from a
// per-run CA; the runner reaches it through each proxy as `ostra.test`. The triggers run on the
// runner's real timers (10 s for a missing welcome and for a quick death), and each test counts the
// time from the runner's start to its fallback against the condition's 30 s.

const HOST = "ostra.test";
const SERVER_URL = `https://${HOST}`;

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let liveText: LiveTextWriter;
let core: GatewayHarness;
let serverCa: TestCa;
let corporateCa: TestCa;
let serverCert: TestCert;
let front: TlsFront;
const cleanups: (() => Promise<void>)[] = [];

// ---------- a TLS front for core, with the WebSocket's faults ----------

/** `pass`; `kill`: an upgraded connection is cut after `afterMs`; `silence`: the server's bytes on it stop after `afterMs`. */
type FrontMode = { readonly kind: "pass" } | { readonly kind: "kill" | "silence"; readonly afterMs: number };

type TlsFront = {
  readonly port: number;
  mode: FrontMode;
  upgrades: number;
  /** Cuts every upgraded connection open now, as a network that starts failing does. */
  readonly dropUpgraded: () => void;
  readonly close: () => Promise<void>;
};

const startTlsFront = async (cert: TestCert, corePort: number): Promise<TlsFront> => {
  const sockets = new Set<net.Socket>();
  const upgraded = new Set<net.Socket>();
  const state: TlsFront = {
    port: 0,
    mode: { kind: "pass" },
    upgrades: 0,
    dropUpgraded: () => {
      for (const socket of upgraded) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
  const server = tls.createServer({ cert: cert.cert, key: cert.key }, (client) => {
    const upstream = net.connect(corePort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    let silenced = false;
    let first = true;
    client.on("data", (chunk: Buffer) => {
      if (first) {
        first = false;
        const mode = state.mode;
        if (/\r\nupgrade:\s*websocket/i.test(chunk.toString("latin1"))) {
          upgraded.add(client);
          state.upgrades += 1;
          if (mode.kind !== "pass") {
            setTimeout(() => {
              if (mode.kind === "kill") {
                client.destroy();
                upstream.destroy();
              } else {
                silenced = true;
              }
            }, mode.afterMs).unref();
          }
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!silenced) client.write(chunk);
    });
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
      upgraded.delete(client);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  return Object.assign(state, { port: typeof address === "object" && address !== null ? address.port : 0 });
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger(() => undefined);
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  const ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger });
  core = await startGateway(test.db, test.url, { signingKey: randomBytes(32), hooks: { ingest, liveText: liveText.write }, timers: { longPollMs: 3_000 } });
  serverCa = await makeTestCa("ostra test server CA");
  corporateCa = await makeTestCa("Example Corp inspection CA");
  serverCert = await issueTestCert(serverCa, [HOST, "localhost", "127.0.0.1"]);
  front = await startTlsFront(serverCert, Number(new URL(core.url).port));
}, 60_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  front.mode = { kind: "pass" };
});

afterAll(async () => {
  await front.close();
  await core.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

// ---------- the runner ----------

type Runner = {
  readonly ref: RunnerRef;
  readonly connection: RunnerConnection;
  readonly carriers: { readonly carrier: Carrier; readonly fallback: FallbackReason | null; readonly at: number }[];
  readonly steers: CommandOf<"steer">[];
  readonly startedAt: number;
};

const done = (): Promise<{ readonly result: "done" }> => Promise.resolve({ result: "done" });

const handlersRecording = (steers: CommandOf<"steer">[]): CommandHandlers => ({
  dispatch: () => Promise.resolve({ result: "rejected", reason: "no-capacity" }),
  steer: (command) => {
    steers.push(command);
    return done();
  },
  interrupt: done,
  stop: done,
  "approval-answer": done,
  drain: done,
  "update-hint": done,
  release: done,
  "question-answer": done,
  "plan-answer": done,
  "snapshot-build": () => Promise.resolve({ result: "rejected", reason: "not-supported" }),
  "set-effort": done,
  resume: done,
  "app.start": done,
  "app.stop": done,
  "screenshot.take": done,
  "preview.open": done,
  "preview.close": done,
  "preview.input": done,
});

const startRunner = async (input: {
  readonly network: NetworkOptions;
  readonly transport?: Transport;
  readonly ref?: RunnerRef;
  readonly timers?: Parameters<typeof startConnection>[0]["timers"];
}): Promise<Runner> => {
  const ref = input.ref ?? (await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id));
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-fallback-"));
  const carriers: Runner["carriers"][number][] = [];
  const steers: CommandOf<"steer">[] = [];
  const startedAt = Date.now();
  const connection = await startConnection({
    serverUrl: SERVER_URL,
    peer: { kind: "runner", runnerId: ref.runnerId },
    tokens: {
      get: () => {
        const issued = core.gateway.context.tokens.issue(ref.runnerId, ref.organizationId, Date.now());
        return Promise.resolve({ ok: true, token: issued.accessToken, expiresAt: issued.expiresAt });
      },
      invalidate: () => undefined,
    },
    dataDir,
    handlers: handlersRecording(steers),
    status: () => ({ executor: "host", capacity: 1, freeSlots: 1, labels: [], running: [] }),
    logger: silentLogger,
    hooks: {
      onCarrier: (carrier, fallback) => {
        carriers.push({ carrier, fallback, at: Date.now() });
      },
    },
    transport: input.transport ?? "auto",
    network: input.network,
    // The backoff at its floor (1 s), so the counts below are the triggers' and not the jitter's.
    random: () => 0,
    ...(input.timers === undefined ? {} : { timers: input.timers }),
  });
  cleanups.push(async () => {
    await connection.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ref, connection, carriers, steers, startedAt };
};

const viaProxy = (proxy: RunningProxy, auth?: { readonly user: string; readonly pass: string }): NetworkOptions => ({
  proxyEnv: { HTTPS_PROXY: `http://${auth === undefined ? "" : `${auth.user}:${auth.pass}@`}127.0.0.1:${String(proxy.port)}` },
  ca: [serverCa.cert, corporateCa.cert],
});

const connectProxyTo = async (port: number, auth?: { readonly user: string; readonly pass: string }): Promise<RunningProxy> => {
  const proxy = await startConnectProxy(new Map([[HOST, { host: "127.0.0.1", port }]]), auth);
  cleanups.push(() => proxy.close());
  return proxy;
};

const inspectingProxy = async (mode: "pass" | "block" | "hold") => {
  const leaf = await issueTestCert(corporateCa, [HOST]);
  const proxy = await startTlsInspectingProxy({
    hosts: new Map([[HOST, { host: "127.0.0.1", port: front.port }]]),
    leafCert: leaf.cert,
    leafKey: leaf.key,
    upstreamCa: serverCa.cert,
    mode,
  });
  cleanups.push(() => proxy.close());
  return proxy;
};

const until = async (what: string, check: () => boolean | Promise<boolean>, withinMs: number): Promise<number> => {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > withinMs) throw new Error(`not within ${String(withinMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const onHttp = (runner: Runner) => (): boolean => runner.connection.report().carrier === "http";
const onWebSocket = (runner: Runner) => (): boolean => runner.connection.report().carrier === "websocket";

const presence = (runner: Runner) => test.db.runnerPresence.findUnique({ where: { runnerId: runner.ref.runnerId }, select: { carrier: true, disconnectedAt: true } });

const thought = (index: number): TaskEvent => ({ kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`s-${String(index)}`), text: `step ${String(index)}` });

const steer = (runner: Runner, task: LeasedTask, text: string) =>
  test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, runner.ref.organizationId, runner.ref.runnerId, {
      kind: "steer",
      body: { sessionId: task.sessionId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queue" },
      notAfter: Date.now() + 60_000,
      task: { taskId: task.taskId, projectId: task.projectId },
    }),
  );

describe("the runner's HTTP fallback", () => {
  it("F-013/c4: through a CONNECT proxy, with and without Basic auth, the runner stays on the WebSocket", async () => {
    const open = await connectProxyTo(front.port);
    const auth = { user: "runner", pass: "s3cret-proxy" };
    const guarded = await connectProxyTo(front.port, auth);
    const plain = await startRunner({ network: viaProxy(open) });
    const withAuth = await startRunner({ network: viaProxy(guarded, auth) });
    await until("both connected", () => onWebSocket(plain)() && onWebSocket(withAuth)(), 15_000);
    expect(open.stats.tunnels).toBeGreaterThan(0);
    expect(guarded.stats.tunnels).toBeGreaterThan(0);
    expect(guarded.stats.refusedAuth).toBe(0);
    // A few seconds on: still the WebSocket, never a fallback.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    for (const runner of [plain, withAuth]) {
      expect(runner.carriers.map((each) => each.carrier)).toEqual(["websocket"]);
      expect(await presence(runner)).toEqual({ carrier: "websocket", disconnectedAt: null });
    }
  }, 30_000);

  it("F-013/c4: a proxy that refuses the WebSocket upgrade with its own page makes the runner fall back to HTTP within 30 s", async () => {
    const proxy = await inspectingProxy("block");
    const runner = await startRunner({ network: viaProxy(proxy) });
    await until("on HTTP", onHttp(runner), 30_000);
    expect(Date.now() - runner.startedAt).toBeLessThan(30_000);
    expect(proxy.stats.blockedUpgrades).toBeGreaterThan(0);
    expect(runner.connection.report().fallback).toBe("upgrade-refused");
    expect(await presence(runner)).toEqual({ carrier: "http", disconnectedAt: null });
  }, 40_000);

  it("F-013/c4: a TLS-inspecting proxy that answers 101 and holds the frames makes the runner fall back on the missing welcome within 30 s", async () => {
    const proxy = await inspectingProxy("hold");
    const runner = await startRunner({ network: viaProxy(proxy) });
    await until("on HTTP", onHttp(runner), 30_000);
    const tookMs = Date.now() - runner.startedAt;
    expect(tookMs).toBeLessThan(30_000);
    // The 10 s handshake timeout passed first: it's the missing welcome that moved it.
    expect(tookMs).toBeGreaterThanOrEqual(9_000);
    expect(proxy.stats.heldBytes).toBeGreaterThan(0);
    expect(runner.connection.report().fallback).toBe("no-welcome");
    expect(runner.carriers.map(({ carrier, fallback }) => ({ carrier, fallback }))).toEqual([{ carrier: "http", fallback: "no-welcome" }]);
  }, 40_000);

  it("F-013/c4: a WebSocket that dies within 10 s of opening three times in a row makes the runner fall back to HTTP within 30 s", async () => {
    front.mode = { kind: "kill", afterMs: 1_000 };
    const proxy = await connectProxyTo(front.port);
    const runner = await startRunner({ network: viaProxy(proxy) });
    await until("on HTTP", onHttp(runner), 30_000);
    expect(Date.now() - runner.startedAt).toBeLessThan(30_000);
    expect(runner.connection.report().fallback).toBe("quick-deaths");
    // Welcomed each time, and cut each time: three WebSockets, then HTTP.
    expect(runner.carriers.map((each) => each.carrier)).toEqual(["websocket", "websocket", "websocket", "http"]);
    expect(front.upgrades).toBeGreaterThanOrEqual(3);
  }, 40_000);

  it("F-013/c4: behind nginx's defaults, which drop the Upgrade header, the runner falls back to HTTP and its long poll gets through", async () => {
    const nginxCert = await issueTestCert(serverCa, [HOST, "localhost"]);
    const nginx = await startNginxDefaults({ upstream: () => ({ host: "127.0.0.1", port: Number(new URL(core.url).port) }), cert: nginxCert.cert, key: nginxCert.key, upstreamCa: null });
    cleanups.push(() => nginx.close());
    const proxy = await connectProxyTo(nginx.port);
    const runner = await startRunner({ network: viaProxy(proxy) });
    await until("on HTTP", onHttp(runner), 30_000);
    expect(runner.connection.report().fallback).toBe("upgrade-refused");
    expect(nginx.stats.inspectedRequests.some((line) => line.includes("(upgrade stripped)"))).toBe(true);
    // The 3 s hold of this core comes back whole through nginx's buffering: still connected after two.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(runner.connection.report().carrier).toBe("http");
    expect(await presence(runner)).toEqual({ carrier: "http", disconnectedAt: null });
  }, 45_000);

  it("F-013/c4: a connection that goes silent after its welcome reconnects on the WebSocket and never falls back", async () => {
    front.mode = { kind: "silence", afterMs: 500 };
    const proxy = await connectProxyTo(front.port);
    const runner = await startRunner({ network: viaProxy(proxy), timers: { deadMs: 1_500, checkMs: 100 } });
    // Three silent connections, each counted dead and dropped by the runner well within 10 s.
    await until("three welcomed connections", () => runner.carriers.length >= 3, 25_000);
    front.mode = { kind: "pass" };
    await until("connected again", () => runner.carriers.length >= 4 && onWebSocket(runner)(), 15_000);
    expect(runner.carriers.every((each) => each.carrier === "websocket")).toBe(true);
    expect(runner.connection.report().fallback).toBeNull();
  }, 50_000);

  it("F-013/c4: on HTTP, an auto runner tries the WebSocket again after its retry time and goes back to it once the proxy lets it through", async () => {
    const proxy = await inspectingProxy("block");
    const runner = await startRunner({ network: viaProxy(proxy), timers: { wsRetryMs: 3_000 } });
    await until("on HTTP", onHttp(runner), 30_000);
    // Still refused at the first retry: straight back to HTTP.
    await until("a second fallback", () => runner.carriers.filter((each) => each.carrier === "http").length >= 2, 15_000);
    proxy.setMode("pass");
    await until("back on the WebSocket", onWebSocket(runner), 15_000);
    expect(runner.carriers.at(-1)).toMatchObject({ carrier: "websocket", fallback: null });
    expect(await presence(runner)).toEqual({ carrier: "websocket", disconnectedAt: null });
  }, 60_000);

  it("F-013/c4: every event is stored once across a switch from the WebSocket to HTTP", async () => {
    const proxy = await connectProxyTo(front.port);
    const ref = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
    const task = await seedLeasedTask(test.db, ref, projectIdSchema.parse(fixture.a.openProject.id), { state: "running" });
    const runner = await startRunner({ network: viaProxy(proxy), ref });
    await until("on the WebSocket", onWebSocket(runner), 15_000);
    const channel = await runner.connection.openSession({ taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.leaseEpoch });
    for (let index = 1; index <= 5; index += 1) await channel.emit(thought(index));
    // The WebSocket starts dying within a second, every time: the runner falls back mid-session,
    // emitting all along, and resends from its spool what wasn't acked.
    front.mode = { kind: "kill", afterMs: 1_000 };
    front.dropUpgraded();
    const emitting = (async () => {
      for (let index = 6; index <= 40; index += 1) {
        await channel.emit(thought(index));
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();
    await until("on HTTP", onHttp(runner), 30_000);
    await emitting;
    await channel.drained();
    const rows = await test.db.event.findMany({ where: { taskId: task.taskId, sessionId: task.sessionId, sessionSeq: { not: null } }, select: { sessionSeq: true }, orderBy: { sessionSeq: "asc" } });
    expect(rows.map((row) => row.sessionSeq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  }, 60_000);

  it("F-013/c4: a steer arrives over HTTP within a second, and its ack reaches core", async () => {
    const proxy = await connectProxyTo(front.port);
    const ref = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
    const task = await seedLeasedTask(test.db, ref, projectIdSchema.parse(fixture.a.openProject.id), { state: "running" });
    const runner = await startRunner({ network: viaProxy(proxy), ref, transport: "http" });
    await until("on HTTP", onHttp(runner), 15_000);
    // Into the held poll.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const at = Date.now();
    await steer(runner, task, "use the staging config");
    await until("the steer", () => runner.steers.length === 1, 5_000);
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(runner.steers[0]?.body.text).toBe("use the staging config");
    await until(
      "the ack",
      async () => (await test.db.command.findFirst({ where: { runnerId: ref.runnerId, kind: "steer" }, select: { ackedAt: true } }))?.ackedAt instanceof Date,
      10_000,
    );
    expect(runner.carriers.map((each) => each.carrier)).toEqual(["http"]);
    expect(runner.connection.report().fallback).toBeNull();
  }, 30_000);
});
