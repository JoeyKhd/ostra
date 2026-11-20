import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { recordingLogger } from "@ostra/adapter-sdk/testing";
import { memoryJobQueue } from "@ostra/api/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { notifyRunnerInTx, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import {
  closeCodes,
  infoResponseSchema,
  infoResponseSchemaV3,
  PROTOCOL_MINOR,
  registerResponseSchema,
  runnerHeaders,
  runnerHttpErrorSchema,
  runnerIdSchema,
  runnerLabelSchema,
  runnerPaths,
  sessionIdSchema,
  taskIdSchema,
  tokenResponseSchema,
} from "@ostra/protocol";
import type { OrganizationId, RunnerId, Status, TokenAssertion } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { connectPeer, makeRunnerKey, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { accessToken, connect, postJson, registerBody, registeredOs, registerPersonal, seedDeviceSession, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { BOOTSTRAP_JOIN_TOKEN_FILE, ensureBootstrapJoinToken } from "./bootstrap-join-token.ts";

// Ticket 24's cases, against a fake peer (spec section 8). Ported from
// spikes/runner-transport/src/harness/scenarios/versions.ts and authz.ts.

let test: TestDatabase;
let fixture: IsolationFixture;
let harness: GatewayHarness;
const peers: FakePeer[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  harness = await startGateway(test.db, test.url);
});

afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close();
  }
});

afterAll(async () => {
  await harness.stop();
  await test.dispose();
});

const track = (peer: FakePeer): FakePeer => {
  peers.push(peer);
  return peer;
};

const sendCommand = (organizationId: OrganizationId, runnerId: RunnerId, version: string) =>
  test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, organizationId, runnerId, {
      kind: "update-hint",
      body: { version },
      notAfter: Date.now() + 60_000,
      task: null,
    }),
  );

describe("info", () => {
  it("names the version window, the panel and the device client", async () => {
    const response = await fetch(`${harness.url}${runnerPaths.info}`);
    const info = infoResponseSchema.parse(await response.json());
    expect(info).toEqual({
      protocolMajor: 1,
      serverMinor: PROTOCOL_MINOR,
      supported: { min: PROTOCOL_MINOR - 1, max: PROTOCOL_MINOR + 1 },
      serverVersion: "0.0.0",
      panelUrl: "http://localhost:3000",
      deviceClientId: "ostra-runner",
    });
  });

  it("F-061: answers a minor-4 runner with the window and the pin's registry, and a minor-3 one in minor 3's shape", async () => {
    const window = { min: PROTOCOL_MINOR - 1, max: PROTOCOL_MINOR + 1 };
    const atMinor4 = await fetch(`${harness.url}${runnerPaths.info}`, { headers: { [runnerHeaders.minor]: "4" } });
    expect(infoResponseSchema.parse(await atMinor4.json())).toMatchObject({ supported: window, minorWindow: window, npm: null });
    const atMinor3 = await fetch(`${harness.url}${runnerPaths.info}`, { headers: { [runnerHeaders.minor]: "3" } });
    expect(infoResponseSchemaV3.parse(await atMinor3.json())).toMatchObject({ supported: window });
  });
});

describe("register with a device session", () => {
  it("creates a personal runner owned by the member, and revokes the session", async () => {
    const key = await makeRunnerKey();
    const session = await seedDeviceSession(test.db, fixture.a.member);
    const response = await postJson(`${harness.url}${runnerPaths.register}`, registerBody(key), session);
    expect(response.status).toBe(201);
    const registered = registerResponseSchema.parse(response.body);
    expect(registered).toMatchObject({ kind: "personal", poolId: null });

    const runner = await test.db.runner.findUniqueOrThrow({ where: { id: registered.runnerId } });
    expect(runner).toMatchObject({
      organizationId: fixture.a.organization.id,
      kind: "personal",
      ownerMemberId: fixture.a.member.id,
      publicKey: key.publicKey,
      executor: "host",
      state: "joining",
    });
    // Q115: the device session was used once and is gone.
    expect(await test.db.authSession.count({ where: { token: session } })).toBe(0);
    const again = await postJson(`${harness.url}${runnerPaths.register}`, registerBody(await makeRunnerKey()), session);
    expect(again.status).toBe(401);
    const audit = await test.db.auditEntry.findFirst({ where: { action: "runner.registered", entityId: registered.runnerId } });
    expect(audit).toMatchObject({ organizationId: fixture.a.organization.id, actorKind: "member", actorId: fixture.a.member.id });
  });

  it("F-013: a device session is used once, even by registers that race with it: one runner, and the others are refused", async () => {
    const session = await seedDeviceSession(test.db, fixture.a.member);
    const keys = await Promise.all([makeRunnerKey(), makeRunnerKey(), makeRunnerKey()]);
    // The race, made certain: this test holds the session's row, so every register reads the
    // session as valid and then queues on the row; then it lets go.
    const locked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const holder = test.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "auth_session" WHERE "token" = ${session} FOR UPDATE`;
        locked.resolve(undefined);
        await release.promise;
      },
      { timeout: 60_000 },
    );
    try {
      await locked.promise;
      const registers = keys.map((key) => postJson(`${harness.url}${runnerPaths.register}`, registerBody(key), session));
      const waiting = async (): Promise<number> => {
        const rows = await test.db.$queryRaw<readonly { readonly waiting: number }[]>`
          SELECT count(*)::int AS "waiting" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return rows[0]?.waiting ?? 0;
      };
      for (let attempt = 0; attempt < 200 && (await waiting()) < keys.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await waiting()).toBe(keys.length);
      release.resolve(undefined);
      await holder;
      const responses = await Promise.all(registers);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 401, 401]);
      expect(await test.db.runner.count({ where: { publicKey: { in: keys.map((key) => key.publicKey) } } })).toBe(1);
      expect(await test.db.authSession.count({ where: { token: session } })).toBe(0);
    } finally {
      release.resolve(undefined);
      await holder.catch(() => undefined);
    }
  });

  it("puts another organization's member's runner in that organization", async () => {
    const runner = await registerPersonal(harness, test.db, fixture.b.admin);
    const row = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row.organizationId).toBe(fixture.b.organization.id);
    expect(row.organizationId).not.toBe(fixture.a.organization.id);
  });

  it("refuses no session, a bad one, a reused key and the kubernetes executor", async () => {
    const key = await makeRunnerKey();
    expect((await postJson(`${harness.url}${runnerPaths.register}`, registerBody(key))).status).toBe(401);
    expect((await postJson(`${harness.url}${runnerPaths.register}`, registerBody(key), "not-a-session-token-at-all")).status).toBe(401);
    const first = await registerPersonal(harness, test.db, fixture.a.member);
    const reused = await postJson(
      `${harness.url}${runnerPaths.register}`,
      registerBody(first.key),
      await seedDeviceSession(test.db, fixture.a.member),
    );
    expect(reused.status).toBe(409);
    const cluster = await postJson(
      `${harness.url}${runnerPaths.register}`,
      registerBody(await makeRunnerKey(), { executor: "kubernetes" }),
      await seedDeviceSession(test.db, fixture.a.member),
    );
    expect(cluster.status).toBe(400);
  });
});

describe("token", () => {
  it("trades a signed assertion for a 10-minute access token, once per nonce", async () => {
    const runner = await registerPersonal(harness, test.db, fixture.a.member);
    const assertion = signAssertion(runner.key, runner.runnerId);
    const first = await postJson(`${harness.url}${runnerPaths.token}`, assertion);
    expect(first.status).toBe(200);
    const token = tokenResponseSchema.parse(first.body);
    expect(token.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(token.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    // Replayed.
    expect((await postJson(`${harness.url}${runnerPaths.token}`, assertion)).status).toBe(401);
    // Too far from the server's clock.
    const stale = signAssertion(runner.key, runner.runnerId, Date.now() - 5 * 60_000);
    expect((await postJson(`${harness.url}${runnerPaths.token}`, stale)).status).toBe(401);
    // Signed by another key.
    const forged = signAssertion(await makeRunnerKey(), runner.runnerId);
    expect((await postJson(`${harness.url}${runnerPaths.token}`, forged)).status).toBe(401);
  });
});

const HOUR = 3_600_000;

/** `POST /runner/v1/token` as a runner of `minor` sends it; without `minor`, as one before minor 2 (no header). */
const postToken = async (url: string, assertion: TokenAssertion, minor?: number): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(minor === undefined ? {} : { [runnerHeaders.minor]: String(minor) }) },
    body: JSON.stringify(assertion),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
};

/** Minor 1's error body, as strict as a minor-1 runner reads it: no `reason`, no `serverTime`. */
const minor1ErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), currentEpoch: z.number().optional() }),
});

describe("refused tokens", () => {
  it("F-013: say why, and core logs each with the runner ID and the reason only: clock skew with the server's time, one answer for an unknown runner and a bad signature, revoked, and a replayed nonce", async () => {
    const log = recordingLogger();
    let serverAheadMs = 0;
    const clocked = await startGateway(test.db, test.url, {
      logger: log,
      ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock: { now: () => Date.now() + serverAheadMs }, jobs: memoryJobQueue() },
    });
    try {
      const runner = await registerPersonal(clocked, test.db, fixture.a.member);
      const url = `${clocked.url}${runnerPaths.token}`;
      const sent: TokenAssertion[] = [];
      const sign = (key = runner.key, runnerId: RunnerId = runner.runnerId): TokenAssertion => {
        const assertion = signAssertion(key, runnerId);
        sent.push(assertion);
        return assertion;
      };

      // The server's clock jumped an hour ahead of the runner's.
      serverAheadMs = HOUR;
      const early = sign();
      const skewed = await postToken(url, early, 2);
      serverAheadMs = 0;
      expect(skewed.status).toBe(401);
      const skew = runnerHttpErrorSchema.parse(skewed.body).error;
      expect(skew).toMatchObject({ code: "unauthorized", reason: "clock-skew" });
      expect(Math.abs((skew.serverTime ?? 0) - early.issuedAt - HOUR)).toBeLessThan(10_000);

      // An unknown runner and a bad signature get one answer, word for word.
      const unknown = await postToken(url, sign(runner.key, runnerIdSchema.parse("no-such-runner")), 2);
      const forged = await postToken(url, sign(await makeRunnerKey()), 2);
      expect(unknown.status).toBe(401);
      expect(runnerHttpErrorSchema.parse(unknown.body).error).toMatchObject({ code: "unauthorized", reason: "unknown-key" });
      expect(forged).toEqual(unknown);
      expect(runnerHttpErrorSchema.parse(unknown.body).error.serverTime).toBeUndefined();

      // A nonce is good once.
      const once = sign();
      const issued = await postToken(url, once, 2);
      expect(issued.status).toBe(200);
      const { accessToken } = tokenResponseSchema.parse(issued.body);
      const replayed = await postToken(url, once, 2);
      expect(replayed.status).toBe(401);
      expect(runnerHttpErrorSchema.parse(replayed.body).error).toMatchObject({ code: "unauthorized", reason: "replayed" });

      // Revoked: the one 403.
      await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "revoked", revokedAt: new Date() } });
      const revoked = await postToken(url, sign(), 2);
      expect(revoked.status).toBe(403);
      expect(runnerHttpErrorSchema.parse(revoked.body).error).toMatchObject({ code: "unauthorized", reason: "revoked" });

      // Every refusal is logged once, with the runner ID and the reason.
      const refusals = log.records.filter((record) => record.message === "runner.token-refused");
      expect(refusals.map((record) => record.fields["reason"])).toEqual(["clock-skew", "unknown-key", "unknown-key", "replayed", "revoked"]);
      expect(refusals.map((record) => record.fields["runnerId"])).toEqual([
        runner.runnerId,
        "no-such-runner",
        runner.runnerId,
        runner.runnerId,
        runner.runnerId,
      ]);
      expect(refusals.every((record) => record.level === "warn")).toBe(true);
      expect(Math.abs(Number(refusals[0]?.fields["skewMs"]) + HOUR)).toBeLessThan(10_000);
      // Never the assertion, its nonce or signature, or a token.
      const logged = JSON.stringify(log.records);
      for (const assertion of sent) {
        expect(logged).not.toContain(assertion.nonce);
        expect(logged).not.toContain(assertion.signature);
      }
      expect(logged).not.toContain(accessToken);
    } finally {
      await clocked.stop();
    }
  });

  it("F-061: a runner before minor 2 sends no minor and gets minor 1's refusal body, and still gets its token; a server at minor 1 names no reason", async () => {
    const runner = await registerPersonal(harness, test.db, fixture.a.member);
    const url = `${harness.url}${runnerPaths.token}`;
    const stale = (): TokenAssertion => signAssertion(runner.key, runner.runnerId, Date.now() - 5 * 60_000);

    const old = await postToken(url, stale());
    expect(old.status).toBe(401);
    expect(minor1ErrorSchema.parse(old.body)).toEqual({
      error: { code: "unauthorized", message: "the assertion's issuedAt is too far from the server's clock; check this machine's time" },
    });
    const forged = await postToken(url, signAssertion(await makeRunnerKey(), runner.runnerId));
    expect(forged.status).toBe(401);
    expect(minor1ErrorSchema.safeParse(forged.body).success).toBe(true);
    expect((await postToken(url, signAssertion(runner.key, runner.runnerId))).status).toBe(200);
    // The same runner at this minor hears the reason.
    expect(runnerHttpErrorSchema.parse((await postToken(url, stale(), 2)).body).error.reason).toBe("clock-skew");

    // A server at minor 1 speaks minor 1 to a minor-2 runner too.
    const older = await startGateway(test.db, test.url, { serverMinor: 1 });
    try {
      const refused = await postToken(`${older.url}${runnerPaths.token}`, stale(), 2);
      expect(refused.status).toBe(401);
      expect(minor1ErrorSchema.safeParse(refused.body).success).toBe(true);
    } finally {
      await older.stop();
    }
  });
});

describe("the WebSocket", () => {
  let runner: RegisteredRunner;

  beforeAll(async () => {
    runner = await registerPersonal(harness, test.db, fixture.a.member);
  });

  it("refuses an upgrade without a valid access token", async () => {
    await expect(connectPeer(harness.url, "ostra-runner-forged.token", runner.runnerId)).rejects.toThrow("401");
  });

  it("says welcome, marks the runner online and holds its presence", async () => {
    const peer = track(await connect(harness, runner));
    const welcome = await peer.next("welcome");
    expect(welcome).toMatchObject({ minor: PROTOCOL_MINOR, creditFrames: 256, creditBytes: 4 * 1024 * 1024, pingMs: 20_000 });
    const row = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row.state).toBe("online");
    const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } });
    expect(presence).toMatchObject({ connectionEpoch: welcome.connectionEpoch, disconnectedAt: null, carrier: "websocket" });
    expect(harness.gateway.connections.held()).toContain(runner.runnerId);
  });

  it("delivers a command written in another transaction, and an ack advances the cursor", async () => {
    const peer = track(await connect(harness, runner));
    await peer.next("welcome");
    const sent = await sendCommand(fixture.a.organization.id, runner.runnerId, "0.0.1");
    const command = await peer.next("command", 5_000);
    expect(command).toMatchObject({ kind: "update-hint", seq: sent.seq, id: sent.commandId, body: { version: "0.0.1" } });
    peer.send({ type: "command-ack", upTo: sent.seq, results: [{ id: sent.commandId, seq: sent.seq, result: "accepted" }] });
    await waitFor(async () => (await test.db.command.findUniqueOrThrow({ where: { id: sent.commandId } })).ackedAt !== null);
    const row = await test.db.command.findUniqueOrThrow({ where: { id: sent.commandId } });
    expect(row.result).toBe("accepted");
    const runnerRow = await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(runnerRow.ackedCommandSeq).toBe(sent.seq);

    // Reconnecting from the acked seq: nothing is sent again, and a new command is.
    peer.close();
    await peer.closed;
    const again = track(await connect(harness, runner, { lastCommandSeq: sent.seq }));
    await again.next("welcome");
    const next = await sendCommand(fixture.a.organization.id, runner.runnerId, "0.0.2");
    const delivered = await again.next("command");
    expect(delivered.seq).toBe(next.seq);
    const commands = again.frames.flatMap((frame) => (frame.type === "command" ? [frame.seq] : []));
    expect(commands).toEqual([next.seq]);
  });

  it("delivers on the sweep when no NOTIFY arrives", async () => {
    const sweepOnly = await startGateway(test.db, test.url, { listen: false, timers: { sweepMs: 2_000 } });
    try {
      const other = await registerPersonal(sweepOnly, test.db, fixture.a.member);
      const peer = track(await connect(sweepOnly, other));
      await peer.next("welcome");
      const started = Date.now();
      const sent = await sendCommand(fixture.a.organization.id, other.runnerId, "0.0.3");
      const command = await peer.next("command", 5_000);
      expect(command.seq).toBe(sent.seq);
      expect(Date.now() - started).toBeLessThan(4_500);
    } finally {
      await sweepOnly.stop();
    }
  });

  it("a second connection evicts the first with 4409", async () => {
    const first = track(await connect(harness, runner));
    const firstWelcome = await first.next("welcome");
    const second = track(await connect(harness, runner));
    const secondWelcome = await second.next("welcome");
    expect(secondWelcome.connectionEpoch).toBeGreaterThan(firstWelcome.connectionEpoch);
    expect(await first.next("evict")).toEqual({ type: "evict", reason: "replaced" });
    expect(await first.closed).toBe(closeCodes.replaced);
    // The newer connection is untouched, and presence is still held.
    const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } });
    expect(presence).toMatchObject({ connectionEpoch: secondWelcome.connectionEpoch, disconnectedAt: null });
  });

  it("a second replica's connection evicts the first replica's through NOTIFY", async () => {
    const other = await startGateway(test.db, test.url);
    try {
      const first = track(await connect(harness, runner));
      await first.next("welcome");
      const second = track(await connect(other, runner));
      await second.next("welcome");
      expect(await first.next("evict")).toEqual({ type: "evict", reason: "replaced" });
      expect(await first.closed).toBe(closeCodes.replaced);
    } finally {
      await other.stop();
    }
  });

  it("marks the runner offline when its connection closes", async () => {
    const peer = track(await connect(harness, runner));
    await peer.next("welcome");
    peer.close();
    await peer.closed;
    await waitFor(async () => (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).state === "offline");
    const presence = await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } });
    expect(presence.disconnectedAt).not.toBeNull();
  });

  it("acks the sessions a hello reports, and only this runner's", async () => {
    const task = await test.db.task.create({
      data: {
        organizationId: fixture.a.organization.id,
        projectId: fixture.a.openProject.id,
        kind: "code",
        source: "prompt",
        title: "t",
        prompt: "p",
        branchName: "ostra/hello-acks",
        state: "running",
        runnerId: runner.runnerId,
        leaseEpoch: 1,
      },
    });
    const box = await test.db.box.create({
      data: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, runnerId: runner.runnerId, executor: "host" },
    });
    await test.db.lease.create({
      data: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, epoch: 1, runnerId: runner.runnerId, boxId: box.id },
    });
    const session = await test.db.session.create({
      data: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, boxId: box.id, origin: "new", state: "running", ingestedSeq: 5 },
    });
    const otherTask = await test.db.task.create({
      data: { organizationId: fixture.b.organization.id, projectId: fixture.b.project.id, kind: "code", source: "prompt", title: "t", prompt: "p", branchName: "ostra/other" },
    });
    const otherSession = await test.db.session.create({
      data: { organizationId: otherTask.organizationId, projectId: otherTask.projectId, taskId: otherTask.id, origin: "new", ingestedSeq: 9 },
    });
    const peer = track(
      await connect(harness, runner, {
        sessions: [
          { taskId: taskIdSchema.parse(task.id), sessionId: sessionIdSchema.parse(session.id), leaseEpoch: 1, nextSessionSeq: 7 },
          { taskId: taskIdSchema.parse(otherTask.id), sessionId: sessionIdSchema.parse(otherSession.id), leaseEpoch: 1, nextSessionSeq: 10 },
        ],
      }),
    );
    await peer.next("welcome");
    expect(await peer.next("ack")).toEqual({ type: "ack", sessionId: session.id, upTo: 5 });
    await sleep(200);
    expect(peer.frames.filter((frame) => frame.type === "ack")).toHaveLength(1);
  });

  it("refuses a frame that isn't hello first", async () => {
    const peer = track(await connect(harness, runner, { skipHello: true }));
    peer.send({ type: "status", executor: "host", capacity: 1, freeSlots: 1, labels: [], version: "0.0.0", running: [], spoolBytes: 0 });
    expect(await peer.next("error")).toMatchObject({ code: "protocol-violation" });
    expect(await peer.closed).toBe(closeCodes.protocolViolation);
  });

  it("stores a status change once, without a notice per heartbeat", async () => {
    const peer = track(await connect(harness, runner));
    await peer.next("welcome");
    const notices = () => test.db.changeNotice.count({ where: { entity: "runner", entityId: runner.runnerId } });
    const before = await notices();
    const status: Status = {
      type: "status",
      executor: "host",
      capacity: 2,
      freeSlots: 2,
      labels: [runnerLabelSchema.parse("gpu")],
      version: "0.0.0",
      running: [],
      spoolBytes: 0,
    };
    peer.send(status);
    await waitFor(async () => (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capacity === 2);
    peer.send(status);
    peer.send(status);
    await waitFor(() => harness.gateway.connections.status(runner.runnerId)?.capacity === 2);
    await sleep(300);
    expect(await notices()).toBe(before + 1);
    // Milestone 5 (F-069): its own label, with the built-in ones core adds from its registration
    // (the registered machine, not the one the test runs on: CI is Linux, run 44726825275).
    expect((await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).labels).toEqual(
      ["gpu", "executor:host", `os:${registeredOs.platform}`, `arch:${registeredOs.arch}`].sort(),
    );
  });

  it("F-014: stores the containment a runner reports, and keeps it when a status leaves it out", async () => {
    const peer = track(await connect(harness, runner));
    await peer.next("welcome");
    const stored = async () => (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).processContainment;
    const status: Status = { type: "status", executor: "host", capacity: 1, freeSlots: 1, labels: [], version: "0.0.0", running: [], spoolBytes: 0 };
    peer.send({ ...status, processContainment: "process-tree" });
    await waitFor(async () => (await stored()) === "process_tree");
    peer.send({ ...status, processContainment: "job-object" });
    await waitFor(async () => (await stored()) === "job_object");
    expect(await stored()).toBe("job_object");
    // A sidecar's status, or an older runner's, says nothing about it: the row keeps what it had.
    peer.send({ ...status, capacity: 3 });
    await waitFor(async () => (await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).capacity === 3);
    expect(await stored()).toBe("job_object");
  });
});

describe("revoked runners", () => {
  it("are refused a token and an upgrade, and a live one is evicted with 4403", async () => {
    const runner = await registerPersonal(harness, test.db, fixture.a.member);
    const token = await accessToken(harness, runner);
    const peer = track(await connectPeer(harness.url, token.accessToken, runner.runnerId));
    await peer.next("welcome");
    await test.db.$transaction(async (tx) => {
      await tx.runner.update({ where: { id: runner.runnerId }, data: { state: "revoked", revokedAt: new Date() } });
      await notifyRunnerInTx(tx, { kind: "revoked", runnerId: runner.runnerId });
    });
    expect(await peer.next("evict")).toEqual({ type: "evict", reason: "revoked" });
    expect(await peer.closed).toBe(closeCodes.revoked);
    // The token it still holds no longer opens a connection, and it gets no new one.
    await expect(connectPeer(harness.url, token.accessToken, runner.runnerId)).rejects.toThrow("403");
    const refused = await postJson(`${harness.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId));
    expect(refused.status).toBe(403);
  });
});

describe("the version window", () => {
  it("connects runners one minor behind and one ahead, and refuses two ahead with the fix", async () => {
    const newer = await startGateway(test.db, test.url, { serverMinor: 1 });
    try {
      const runner = await registerPersonal(newer, test.db, fixture.a.member);
      for (const minor of [0, 2]) {
        const peer = track(await connect(newer, runner, { minor }));
        const welcome = await peer.next("welcome");
        expect(welcome.minor).toBe(Math.min(1, minor));
        peer.close();
        await peer.closed;
      }
      const tooNew = track(await connect(newer, runner, { minor: 3 }));
      const error = await tooNew.next("error");
      expect(error).toMatchObject({ code: "version-unsupported", supported: { min: 0, max: 2 }, serverMinor: 1 });
      expect(error.message).toContain("Fix:");
      expect(await tooNew.closed).toBe(closeCodes.upgradeRequired);
    } finally {
      await newer.stop();
    }
  });

  it("F-093: refuses a kubernetes runner below minor 4 with its own reason, and welcomes one at minor 4", async () => {
    // A minor-3 runner is inside a minor-4 server's window only: milestone 6's server is at minor 5.
    const older = await startGateway(test.db, test.url, { serverMinor: 4 });
    try {
      const runner = await registerPersonal(older, test.db, fixture.a.member);
      const old = track(await connect(older, runner, { minor: 3, executor: "kubernetes" }));
      const error = await old.next("error");
      expect(error).toMatchObject({ code: "version-unsupported", supported: { min: 4, max: 5 } });
      expect(error.message).toContain("The kubernetes executor needs protocol 1.4");
      expect(error.message).toContain("Fix:");
      expect(await old.closed).toBe(closeCodes.upgradeRequired);
      // The same runner at minor 3 on docker is inside the window.
      const docker = track(await connect(older, runner, { minor: 3, executor: "docker" }));
      expect((await docker.next("welcome")).minor).toBe(3);
      docker.close();
      await docker.closed;
      const current = track(await connect(older, runner, { minor: 4, executor: "kubernetes" }));
      expect((await current.next("welcome")).minor).toBe(4);
      current.close();
      await current.closed;
      // A minor-3 runner's hello names no executor: the one it registered with is refused.
      await test.db.runner.update({ where: { id: runner.runnerId }, data: { executor: "kubernetes" } });
      const registeredOld = track(await connect(older, runner, { minor: 3 }));
      expect(await registeredOld.next("error")).toMatchObject({ code: "version-unsupported" });
      expect(await registeredOld.closed).toBe(closeCodes.upgradeRequired);
    } finally {
      await older.stop();
    }
  });
});

describe("organizations", () => {
  it("a runner of another organization gets nothing: no command, no ack of another's command, no outbox row", async () => {
    const ours = await registerPersonal(harness, test.db, fixture.a.member);
    const theirs = await registerPersonal(harness, test.db, fixture.b.admin);
    const theirPeer = track(await connect(harness, theirs));
    await theirPeer.next("welcome");
    const sent = await sendCommand(fixture.a.organization.id, ours.runnerId, "0.0.9");
    // Their runner acks our command by its ID: nothing changes.
    theirPeer.send({ type: "command-ack", upTo: sent.seq, results: [{ id: sent.commandId, seq: sent.seq, result: "rejected" }] });
    await sleep(500);
    const row = await test.db.command.findUniqueOrThrow({ where: { id: sent.commandId } });
    expect(row).toMatchObject({ ackedAt: null, result: null });
    expect(theirPeer.frames.some((frame) => frame.type === "command")).toBe(false);
    // The outbox refuses a runner named under the wrong organization.
    await expect(sendCommand(fixture.a.organization.id, theirs.runnerId, "0.1.0")).rejects.toThrow("no such runner");
    // And our runner still gets its command.
    const ourPeer = track(await connect(harness, ours));
    expect((await ourPeer.next("command")).id).toBe(sent.commandId);
  });
});

describe("the bootstrap join token", () => {
  it("is stored hashed, joins a pool runner once per name, and is refused when revoked", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-core-"));
    try {
      // The first organization is A: the bootstrap token is for its default pool.
      expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("created");
      expect(await ensureBootstrapJoinToken(test.db, dataDir, silentLogger)).toBe("ready");
      const token = (await readFile(path.join(dataDir, BOOTSTRAP_JOIN_TOKEN_FILE), "utf8")).trim();
      const row = await test.db.joinToken.findFirstOrThrow({ where: { bootstrap: true, revokedAt: null } });
      expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(row.tokenHash).not.toContain(token);
      expect(row.organizationId).toBe(fixture.a.organization.id);

      const join = async (name: string) =>
        postJson(`${harness.url}${runnerPaths.register}`, registerBody(await makeRunnerKey(), { name, executor: "docker", joinToken: token }));
      const first = await join("pool-runner");
      expect(first.status).toBe(201);
      expect(registerResponseSchema.parse(first.body)).toMatchObject({ kind: "pool", poolId: row.poolId });
      expect((await join("pool-runner")).status).toBe(409);
      expect((await join("pool-runner-2")).status).toBe(201);
      expect((await postJson(`${harness.url}${runnerPaths.register}`, registerBody(await makeRunnerKey(), { executor: "docker", joinToken: "ostra-join-wrong" }))).status).toBe(401);

      await test.db.joinToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
      expect((await join("pool-runner-3")).status).toBe(401);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await sleep(50);
  }
};

