import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { notifyRunnerInTx, postgresCommandOutbox } from "@ostra/domain";
import {
  closeCodes,
  infoResponseSchema,
  registerResponseSchema,
  runnerLabelSchema,
  runnerPaths,
  sessionIdSchema,
  taskIdSchema,
  tokenResponseSchema,
} from "@ostra/protocol";
import type { OrganizationId, RunnerId, Status } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { connectPeer, makeRunnerKey, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { accessToken, connect, postJson, registerBody, registerPersonal, seedDeviceSession, startGateway } from "../testing/harness.ts";
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
      serverMinor: 0,
      supported: { min: 0, max: 1 },
      serverVersion: "0.0.0",
      panelUrl: "http://localhost:3000",
      deviceClientId: "ostra-runner",
    });
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
    expect(welcome).toMatchObject({ minor: 0, creditFrames: 256, creditBytes: 4 * 1024 * 1024, pingMs: 20_000 });
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
    expect((await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).labels).toEqual(["gpu"]);
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

