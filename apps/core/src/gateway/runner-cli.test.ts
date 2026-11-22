import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { silentLogger } from "@ostra/adapter-sdk";
import { recordingLogger } from "@ostra/adapter-sdk/testing";
import { createAuth, ensureFirstAdmin } from "@ostra/api/auth";
import type { OstraAuth } from "@ostra/api/auth";
import { cookieHeaderFrom, memoryJobQueue, TEST_PASSWORD } from "@ostra/api/testing";
import { createTestDatabase } from "@ostra/db/testing";
import { exitCodes } from "@ostra/runner";
import type { TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { organizationIdSchema, replicaIdSchema, runnerIdSchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createCoreServer } from "../server.ts";
import { makeRunnerKey, signAssertion } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import type { CoreServer } from "../server.ts";
import { BOOTSTRAP_JOIN_TOKEN_FILE, ensureBootstrapJoinToken } from "./bootstrap-join-token.ts";
import { postgresDeviceSessions } from "./device-sessions.ts";
import { createGateway } from "./gateway.ts";
import type { Gateway } from "./gateway.ts";
import { testPort } from "@ostra/adapter-sdk/testing/net";

// F-013, end to end on one machine: the real `ostra runner` CLI (apps/runner/src/main.ts, spawned
// as a child process, the way a member runs it), against core's real gateway and the real
// better-auth device flow (packages/api), over a migrated test database. Nothing here is faked:
// the member's approval goes through better-auth's own device routes, as the panel's /device page
// sends it. The browser page itself is the Playwright suite's and the milestone 1 demo's.

const runnerMain = path.join(path.dirname(fileURLToPath(import.meta.resolve("@ostra/runner"))), "main.ts");

const admin = { username: "ada", email: "ada@example.com", password: TEST_PASSWORD, organizationName: "Calculator Co" } as const;

let test: TestDatabase;
let auth: OstraAuth;
let organizationId: string;
/** The member who approves every device code here: the first admin. */
let adminMemberId: string;
const signingKey = randomBytes(32);
/** How far core's clock reads from the real one: a test moves it, as a clock that jumped. */
let coreClockOffsetMs = 0;
const coreClock = { now: (): number => Date.now() + coreClockOffsetMs };
/** What every core of this file logged. */
const coreLog = recordingLogger();

// ---------- core on a fixed port, so it can come back where the runner left it ----------

type Core = { readonly gateway: Gateway; readonly server: CoreServer; readonly sockets: Set<Duplex> };

let port = 0;
let core: Core | undefined;
/** The session tokens better-auth's device route handed out, read off its answers. */
const deviceTokens: string[] = [];

const coreUrl = (): string => `http://127.0.0.1:${String(port)}`;

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

const tokenAnswerSchema = z.looseObject({ access_token: z.string() });

/** better-auth's handler on Node's http server, as apps/web serves `/api/auth/*`. */
const authRoute = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
  if (!url.pathname.startsWith("/api/auth/")) {
    return false;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
  const answer = await auth.handler(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));
  const text = await answer.text();
  if (url.pathname === "/api/auth/device/token" && answer.status === 200) {
    const parsed = tokenAnswerSchema.safeParse(JSON.parse(text));
    if (parsed.success) deviceTokens.push(parsed.data.access_token);
  }
  response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
  response.end(text);
  return true;
};

const startCore = async (key: Buffer = signingKey): Promise<Core> => {
  const gateway = createGateway({
    db: test.db,
    databaseUrl: test.url,
    replicaId: replicaIdSchema.parse(`test:${randomBytes(4).toString("hex")}`),
    serverVersion: "0.0.0",
    panelUrl: coreUrl(),
    signingKey: key,
    deviceSessions: postgresDeviceSessions(test.db),
    ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock: coreClock, jobs: memoryJobQueue() },
    // A ping a second, so a peer core counts dead is found within a second, not twenty.
    timers: { pingMs: 1_000 },
    logger: coreLog,
  });
  // Every upgraded socket, the runner's WebSocket, so a test can cut it as a dropped network does.
  const sockets = new Set<Duplex>();
  const server = createCoreServer({
    routes: [gateway.handleRequest, authRoute],
    upgrade: (request, socket, head) => {
      sockets.add(socket);
      gateway.handleUpgrade(request, socket, head);
    },
    logger: silentLogger,
  });
  await gateway.start();
  await server.listen(port, "127.0.0.1");
  return { gateway, server, sockets };
};

/** Cuts every connection at once, as a dropped network does, and stops core. */
const killCore = async (): Promise<void> => {
  const running = core;
  core = undefined;
  if (running === undefined) return;
  for (const socket of running.sockets) socket.destroy();
  await running.gateway.stop();
  await running.server.close();
};

// ---------- the runner, from its CLI ----------

type CliRunner = {
  readonly child: ChildProcess;
  readonly dataDir: string;
  readonly lines: string[];
  readonly line: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpExecArray>;
  readonly exited: Promise<number | null>;
  /** Ends the process and keeps its data folder, for a start after it. */
  readonly kill: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

const runners: CliRunner[] = [];

const cleanEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // The runner refuses an OSTRA_RUNNER_* variable it doesn't know, and this test sets its own.
    if (!name.startsWith("OSTRA_") && value !== undefined) env[name] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home };
};

const startCliRunner = async (executor: "host" | "docker", ...args: string[]): Promise<CliRunner> =>
  spawnCliRunner(await mkdtemp(path.join(tmpdir(), "ostra-f013-")), executor, args);

const spawnCliRunner = (dataDir: string, executor: "host" | "docker", args: readonly string[]): CliRunner => {
  const child = spawn(process.execPath, [runnerMain, "runner", "--server", coreUrl(), "--data-dir", dataDir, "--executor", executor, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: cleanEnv(dataDir),
  });
  const lines: string[] = [];
  const waiters: { pattern: RegExp; resolve: (match: RegExpExecArray) => void }[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      for (const waiter of [...waiters]) {
        const match = waiter.pattern.exec(line);
        if (match !== null) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(match);
        }
      }
    });
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
  });
  const line = (pattern: RegExp, timeoutMs = 30_000): Promise<RegExpExecArray> => {
    for (const seen of lines) {
      const match = pattern.exec(seen);
      if (match !== null) return Promise.resolve(match);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the runner printed no ${String(pattern)} in ${String(timeoutMs)} ms:\n${lines.join("\n")}`));
      }, timeoutMs);
      waiters.push({
        pattern,
        resolve: (match) => {
          clearTimeout(timer);
          resolve(match);
        },
      });
    });
  };
  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.pid !== undefined) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGINT");
      }
      await exited;
    }
  };
  const stop = async (): Promise<void> => {
    await kill();
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };
  const started: CliRunner = { child, dataDir, lines, line, exited, kill, stop };
  runners.push(started);
  return started;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

const filesUnder = async (folder: string): Promise<string[]> => {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
};

/** The member opens /device signed in, enters the code and approves it: better-auth's routes, as the page calls them. */
const approve = async (userCode: string): Promise<void> => {
  const { headers } = await auth.api.signInUsername({ body: { username: admin.username, password: admin.password }, returnHeaders: true });
  const browser = cookieHeaderFrom(headers);
  const code = userCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  await auth.api.deviceVerify({ query: { user_code: code }, headers: browser });
  await auth.api.deviceApprove({ body: { userCode: code }, headers: browser });
};

/** A personal runner, signed in through the device flow and connected; `extra` are more of its flags. */
const signInPersonal = async (name: string, extra: readonly string[] = []): Promise<{ readonly runner: CliRunner; readonly runnerId: string; readonly deviceToken: string }> => {
  const issuedBefore = deviceTokens.length;
  const runner = await startCliRunner("host", "--name", name, "--capacity", "2", "--labels", "gpu,fast", ...extra);
  const [, userCode = ""] = await runner.line(/^\s+Code\s+(\S+)\s*$/);
  await approve(userCode);
  const [, runnerId = ""] = await runner.line(/Runner (\S+) \(personal, .*\) is connecting to/);
  const deviceToken = deviceTokens[issuedBefore];
  if (deviceToken === undefined) throw new Error("better-auth issued no device session");
  return { runner, runnerId, deviceToken };
};

const runnerRow = (runnerId: string) => test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });

const HOUR = 3_600_000;

/** Core's log lines for the token refusals of `runnerId`, of one `reason` when it's given. */
const tokenRefusals = (runnerId: string, reason?: string) =>
  coreLog.records.filter(
    (record) =>
      record.message === "runner.token-refused" && record.fields["runnerId"] === runnerId && (reason === undefined || record.fields["reason"] === reason),
  );

beforeAll(async () => {
  test = await createTestDatabase();
  port = await testPort();
  auth = createAuth({ db: test.db, baseUrl: coreUrl(), secret: randomBytes(32).toString("hex"), deviceInterval: "1s", logLevel: "error" });
  const context = await auth.$context;
  const seeded = await ensureFirstAdmin({
    db: test.db,
    settings: { firstAdmin: admin },
    hashPassword: (password) => context.password.hash(password),
    ports: { audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock },
    logger: silentLogger,
  });
  if (seeded === null) throw new Error("the first admin wasn't seeded");
  organizationId = seeded.organizationId;
  adminMemberId = seeded.memberId;
  core = await startCore();
});

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  coreClockOffsetMs = 0;
  core ??= await startCore();
});

afterAll(async () => {
  await killCore();
  await test.dispose();
});

describe("ostra runner against core", () => {
  it("F-013/c1,c2,c3,c6, F-014/c1: a member runs ostra runner on their own machine on host: a personal runner signs in with a device code the member approves, connects out over a WebSocket, and reports its executor, capacity, labels and version", async () => {
    const { runnerId } = await signInPersonal("laptop");
    const id = runnerIdSchema.parse(runnerId);

    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    const row = await runnerRow(runnerId);
    // The member's own: personal, on `host`, owned by the member who approved its code, in no pool.
    expect(row).toMatchObject({ organizationId, kind: "personal", name: "laptop", executor: "host", capacity: 2, ownerMemberId: adminMemberId, poolId: null });
    // Milestone 5 (F-069): its own labels, with the built-in ones core adds from what it knows.
    expect(row.labels).toEqual(["fast", "gpu", "executor:host", `os:${process.platform}`, `arch:${process.arch}`].sort());
    const pkg = z.looseObject({ version: z.string() }).parse(JSON.parse(await readFile(path.join(path.dirname(runnerMain), "..", "package.json"), "utf8")));
    expect(row.version).toBe(pkg.version);

    // It dialled out: core holds its WebSocket, and its status frame carries the same facts.
    const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });
    expect(presence).toMatchObject({ carrier: "websocket", disconnectedAt: null });
    await waitFor("the runner's status", () => Promise.resolve(core?.gateway.connections.status(id) !== null));
    expect(core?.gateway.connections.status(id)).toMatchObject({ executor: "host", capacity: 2, labels: ["gpu", "fast"], version: pkg.version });
  });

  it("F-013/c7: the device session is used once, traded for the runner's own key and revoked, and the runner still connects and takes its commands", async () => {
    const { runner, runnerId, deviceToken } = await signInPersonal("desk");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");

    // The session better-auth handed the runner is gone: no row, no session behind it, and the
    // runner kept no copy of it in its data folder.
    expect(await test.db.authSession.count({ where: { token: deviceToken } })).toBe(0);
    expect(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${deviceToken}` }) })).toBeNull();
    for (const file of await filesUnder(runner.dataDir)) {
      expect(await readFile(file, "utf8")).not.toContain(deviceToken);
    }
    expect(runner.lines.join("\n")).not.toContain(deviceToken);

    // What it holds instead is its own key. The access token that key earns at core is no
    // member's session: better-auth, which every panel route checks, knows nothing of it.
    const privateKey = createPrivateKey(await readFile(path.join(runner.dataDir, "identity", "runner.key"), "utf8"));
    const issued = await postJson(`${coreUrl()}${runnerPaths.token}`, signAssertion({ publicKey: "", privateKey }, runnerIdSchema.parse(runnerId)));
    expect(issued.status).toBe(200);
    const { accessToken } = tokenResponseSchema.parse(issued.body);
    expect(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${accessToken}` }) })).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: `better-auth.session_token=${accessToken}` }) })).toBeNull();

    // And core takes it for the runner's own connection: a command written for it is delivered
    // and acked.
    const sent = await test.db.$transaction((tx) =>
      postgresCommandOutbox.enqueueInTx(tx, organizationIdSchema.parse(organizationId), runnerIdSchema.parse(runnerId), {
        kind: "update-hint",
        body: { version: "9.9.9" },
        notAfter: Date.now() + 60_000,
        task: null,
      }),
    );
    await waitFor("the command acked", async () => (await test.db.command.findUniqueOrThrow({ where: { id: sent.commandId } })).ackedAt !== null);
    expect((await runnerRow(runnerId)).ackedCommandSeq).toBeGreaterThanOrEqual(sent.seq);
  });

  it("F-013/c2, F-015/c1: a pool runner an admin starts joins with its pool's join token, with no device code", async () => {
    const coreData = await mkdtemp(path.join(tmpdir(), "ostra-f013-core-"));
    try {
      await ensureBootstrapJoinToken(test.db, coreData, silentLogger);
      const token = (await readFile(path.join(coreData, BOOTSTRAP_JOIN_TOKEN_FILE), "utf8")).trim();
      const before = deviceTokens.length;
      // A pool runner runs boxes: `docker`. It registers before it looks for a Docker Engine, so
      // the join is the same on a machine without one, where it then stops.
      const runner = await startCliRunner("docker", "--name", "pool-1", "--join-token", token);
      await waitFor("the pool runner registered", async () => (await test.db.runner.count({ where: { name: "pool-1" } })) === 1);
      const row = await test.db.runner.findFirstOrThrow({ where: { name: "pool-1" } });
      const pool = await test.db.joinToken.findFirstOrThrow({ where: { bootstrap: true, revokedAt: null } });
      expect(row).toMatchObject({ organizationId, kind: "pool", poolId: pool.poolId, ownerMemberId: null, executor: "docker" });
      // No device code was asked for or printed, and no member session was issued.
      expect(runner.lines.some((line) => /^\s+Code\s+/.test(line))).toBe(false);
      expect(deviceTokens.length).toBe(before);
      // A wrong token joins nothing.
      const refused = await startCliRunner("docker", "--name", "pool-2", "--join-token", "ostra-join-not-a-real-token");
      expect(await refused.exited).not.toBe(0);
      expect(await test.db.runner.count({ where: { name: "pool-2" } })).toBe(0);
    } finally {
      await rm(coreData, { recursive: true, force: true });
    }
  });

  it("F-013/c5: it reconnects on its own when its connection drops, and comes back online", async () => {
    const { runnerId } = await signInPersonal("roamer");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    const first = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });

    // The network drops: every socket cut, core gone for a moment.
    await killCore();
    await test.db.runner.update({ where: { id: runnerId }, data: { state: "offline" } });
    await sleep(1_500);
    core = await startCore();

    await waitFor("the runner back online", async () => (await runnerRow(runnerId)).state === "online", 45_000);
    const again = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });
    expect(again.connectionEpoch).toBeGreaterThan(first.connectionEpoch);
    expect(again.disconnectedAt).toBeNull();
  });

  it("F-013/c5: when core's clock and its own disagree, it says by how much, keeps asking, and connects once they agree", async () => {
    const { runner, runnerId } = await signInPersonal("clock");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    const first = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });

    // Core's clock jumps an hour ahead of the runner's (2026-11-19): core counts the peer dead and
    // drops it, the token the runner holds has expired by core's clock, and its new assertion is an
    // hour old by core's.
    coreClockOffsetMs = HOUR;
    await runner.line(/this machine's clock is 3600 s behind the server's/);
    await waitFor("a second clock-skew refusal", () => Promise.resolve(tokenRefusals(runnerId, "clock-skew").length >= 2));
    // It keeps asking: no exit, and nothing calls it revoked or says to delete its identity.
    expect(runner.child.exitCode).toBeNull();
    const output = runner.lines.join("\n");
    expect(output).not.toContain("To sign in again");
    expect(output).not.toContain("revoked");

    // The clocks agree again: it connects by itself, with the identity it had.
    coreClockOffsetMs = 0;
    await waitFor(
      "the runner connected again",
      async () => {
        const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });
        return presence.connectionEpoch > first.connectionEpoch && presence.disconnectedAt === null;
      },
      45_000,
    );
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    expect(runner.child.exitCode).toBeNull();
    expect(tokenRefusals(runnerId).every((record) => record.fields["reason"] === "clock-skew")).toBe(true);
  });

  it("F-013: a revoked runner stops with the refused exit code and the advice to sign in again", async () => {
    const { runner, runnerId } = await signInPersonal("revoked");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    await runner.kill();
    await test.db.runner.update({ where: { id: runnerId }, data: { state: "revoked", revokedAt: new Date() } });

    // Its next start asks for a token with the identity it kept.
    const again = spawnCliRunner(runner.dataDir, "host", ["--name", "revoked"]);
    expect(await again.exited).toBe(exitCodes.refused);
    const output = again.lines.join("\n");
    expect(output).toContain("The server refused this runner's key: it was revoked in the panel.");
    expect(output).toContain(`To sign in again, delete ${path.join(runner.dataDir, "identity")} and start the runner again.`);
    expect(output).not.toContain("doesn't know");
    expect(tokenRefusals(runnerId).map((record) => record.fields["reason"])).toEqual(["revoked"]);
  });

  it("F-013: a key core doesn't know ends the runner with its own message, not as revoked", async () => {
    const { runner, runnerId } = await signInPersonal("forgotten");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");

    // Core comes back after a reset: a new token key, and another key on this runner's row.
    await killCore();
    await test.db.runner.update({ where: { id: runnerId }, data: { publicKey: (await makeRunnerKey()).publicKey } });
    core = await startCore(randomBytes(32));

    // The connection asks for a token, and stops for good.
    expect(await runner.exited).toBe(exitCodes.refused);
    const output = runner.lines.join("\n");
    expect(output).toContain("The server doesn't know this runner's key");
    expect(output).toContain(`To sign in again, delete ${path.join(runner.dataDir, "identity")} and start the runner again.`);
    expect(output).not.toContain("revoked");
    expect(tokenRefusals(runnerId).map((record) => record.fields["reason"])).toEqual(["unknown-key"]);
  });
});

// ADR 0034, amended 2026-11-20: four runners with one identity on one machine took the connection
// from each other every few seconds, and each takeover restarted the task's agent.
describe("one process per runner", () => {
  const presenceOf = (runnerId: string) => test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId } });
  const evictions = (runnerId: string) => coreLog.records.filter((record) => record.message === "gateway.evicted" && record.fields["runnerId"] === runnerId);

  it("F-013: a second ostra runner on the same data folder refuses to start with exit code 4, naming the first one's pid, which keeps its connection; after a crash the next one starts", async () => {
    const { runner: first, runnerId } = await signInPersonal("one-process");
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    const connected = await presenceOf(runnerId);

    const second = spawnCliRunner(first.dataDir, "host", ["--name", "one-process"]);
    expect(await second.exited).toBe(exitCodes.duplicate);
    expect(second.lines.join("\n")).toContain(`Another ostra runner (pid ${String(first.child.pid)}) is running with this data folder, ${first.dataDir}`);
    // The first never lost its connection: the same one, nothing evicted, still running.
    expect(await presenceOf(runnerId)).toMatchObject({ connectionEpoch: connected.connectionEpoch, disconnectedAt: null });
    expect(evictions(runnerId)).toEqual([]);
    expect(first.child.exitCode).toBeNull();

    // A crash leaves the lock behind, naming a pid that's gone: the next start takes it over.
    first.child.kill("SIGKILL");
    await first.exited;
    const third = spawnCliRunner(first.dataDir, "host", ["--name", "one-process"]);
    await third.line(/Runner \S+ \(personal, .*\) is connecting to/);
    await waitFor("the next runner connected", async () => {
      const presence = await presenceOf(runnerId);
      return presence.connectionEpoch > connected.connectionEpoch && presence.disconnectedAt === null;
    });
    expect(third.child.exitCode).toBeNull();
  });

  /** Two runners with one identity on `carrier`: the first stops, the other keeps the connection, and core logs one eviction. */
  const anotherProcessTakesIt = async (name: string, carrier: "websocket" | "http"): Promise<void> => {
    const transport = carrier === "http" ? ["--transport", "http"] : [];
    const { runner: first, runnerId } = await signInPersonal(name, transport);
    await waitFor("the runner online", async () => (await runnerRow(runnerId)).state === "online");
    const before = await presenceOf(runnerId);
    expect(before.carrier).toBe(carrier);

    // Another machine with a copy of its identity: its own data folder, so its own lock.
    const copy = await mkdtemp(path.join(tmpdir(), "ostra-f013-copy-"));
    await cp(path.join(first.dataDir, "identity"), path.join(copy, "identity"), { recursive: true });
    const other = spawnCliRunner(copy, "host", ["--name", name, ...transport]);

    expect(await first.exited).toBe(exitCodes.duplicate);
    expect(first.lines.join("\n")).toContain("Another process connected as this runner, and the server closed this one's connection for it");
    expect(first.lines.join("\n")).not.toContain("To sign in again");
    const status: unknown = JSON.parse(await readFile(path.join(first.dataDir, "status.json"), "utf8"));
    expect(status).toMatchObject({ lastRefusal: { reason: "replaced" } });

    // The other keeps the connection: the same one, three seconds on, and still running.
    await waitFor("the other runner connected", async () => {
      const presence = await presenceOf(runnerId);
      return presence.connectionEpoch > before.connectionEpoch && presence.disconnectedAt === null;
    });
    const held = await presenceOf(runnerId);
    await sleep(3_000);
    expect(await presenceOf(runnerId)).toMatchObject({ connectionEpoch: held.connectionEpoch, carrier, disconnectedAt: null });
    expect(other.child.exitCode).toBeNull();
    // Both connections were on this one core process: the eviction is logged all the same, once.
    expect(evictions(runnerId).map((record) => record.fields["reason"])).toEqual(["replaced"]);
  };

  it("F-013: a runner whose connection another process took stops with exit code 4 and says why, and doesn't take it back", async () => {
    await anotherProcessTakesIt("copied", "websocket");
  });

  it("F-013/c4: on the HTTP carrier too, a runner whose connection another process took stops with exit code 4 instead of taking turns with it", async () => {
    await anotherProcessTakesIt("copied-http", "http");
  });
});
