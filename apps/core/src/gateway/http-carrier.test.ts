import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, revokeRunner, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { clientMessageIdSchema, memberIdSchema, PROTOCOL_MINOR, projectIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { DownFrame, EventsFrame, TaskEvent } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createIngest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { connectPeer } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { httpHelloFrame, httpPeer, postHello } from "../testing/fake-http-peer.ts";
import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { runnerEvent, seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import type { RunnerRef } from "./context.ts";

// Milestone 5's ticket 11 (F-013, F-045, F-061, ADR 0034): the HTTP carrier against a fake peer
// over HTTP, on two replicas of the real gateway with the real ingest, sharing one database. The
// first batch of a case can be made to fail before its transaction commits, to show the acks wait
// for the commit.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let liveText: LiveTextWriter;
let a: GatewayHarness;
let b: GatewayHarness;
let failNextIngest = false;
const signingKey = randomBytes(32);
const sockets: FakePeer[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger(() => undefined);
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  const ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger });
  const hooks = {
    ingest: async (...args: Parameters<typeof ingest>): Promise<readonly DownFrame[]> => {
      if (failNextIngest) {
        failNextIngest = false;
        throw new Error("the batch's transaction failed");
      }
      return ingest(...args);
    },
    liveText: liveText.write,
  };
  a = await startGateway(test.db, test.url, { signingKey, hooks, timers: { longPollMs: 3_000 } });
  b = await startGateway(test.db, test.url, { signingKey, hooks, timers: { longPollMs: 3_000 } });
});

afterEach(() => {
  failNextIngest = false;
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
});

afterAll(async () => {
  await a.stop();
  await b.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const thought = (text: string): TaskEvent => ({ kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`t-${text}`), text });

const batch = (task: LeasedTask, from: number, to: number): EventsFrame => ({
  type: "events",
  events: Array.from({ length: to - from + 1 }, (_, index) => runnerEvent(task, from + index, thought(`e${String(from + index)}`))),
});

/** A runner of member a's, its access token (valid on both replicas) and a task leased to it. */
const world = async (): Promise<{ readonly runner: RunnerRef; readonly token: string; readonly task: LeasedTask }> => {
  const runner = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
  const token = a.gateway.context.tokens.issue(runner.runnerId, runner.organizationId, Date.now()).accessToken;
  const task = await seedLeasedTask(test.db, runner, projectIdSchema.parse(fixture.a.openProject.id), { state: "running" });
  return { runner, token, task };
};

const steer = (runner: RunnerRef, task: LeasedTask, text: string) =>
  test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, runner.organizationId, runner.runnerId, {
      kind: "steer",
      body: { sessionId: task.sessionId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queue" },
      notAfter: Date.now() + 60_000,
      task: { taskId: task.taskId, projectId: task.projectId },
    }),
  );

const stored = (task: LeasedTask) => test.db.event.count({ where: { taskId: task.taskId, sessionId: task.sessionId } });

const commands = (frames: readonly DownFrame[]) => frames.flatMap((frame) => (frame.type === "command" ? [frame] : []));

describe("the HTTP carrier", () => {
  it("F-013: over HTTP, a batch whose commit failed has no ack, and sent again it's stored once and acked", async () => {
    const { runner, token, task } = await world();
    const peer = await httpPeer(a.url, token, runner.runnerId);
    expect(await test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } })).toMatchObject({ carrier: "http", connectionEpoch: peer.connectionEpoch });

    failNextIngest = true;
    const failed = await peer.up([batch(task, 1, 3)]);
    expect(failed.status).toBe(500);
    expect(failed.frames).toEqual([]);
    expect(await stored(task)).toBe(0);

    const sent = await peer.up([batch(task, 1, 3)]);
    expect(sent.status).toBe(200);
    expect(sent.frames).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    expect(await stored(task)).toBe(3);
    // Its answer lost, the runner sends it again, to another replica: stored once, acked again.
    const again = await peer.up([batch(task, 1, 3)], { baseUrl: b.url });
    expect(again.frames).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 3 }]);
    expect(await stored(task)).toBe(3);
  });

  it("F-013: over HTTP, a batch past a gap is answered resendFrom, and nothing past the gap is stored", async () => {
    const { runner, token, task } = await world();
    const peer = await httpPeer(a.url, token, runner.runnerId);
    expect((await peer.up([batch(task, 1, 2)])).frames).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2 }]);
    const gap = await peer.up([batch(task, 5, 6)]);
    expect(gap.frames).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2, resendFrom: 3 }]);
    expect(await stored(task)).toBe(2);
    // The hello of a new connection says what was stored.
    const next = await httpPeer(a.url, token, runner.runnerId, { sessions: [{ sessionId: task.sessionId, taskId: task.taskId, leaseEpoch: task.leaseEpoch, nextSessionSeq: 7 }] });
    expect(next.helloFrames).toEqual([{ type: "ack", sessionId: task.sessionId, upTo: 2 }]);
  });

  it("F-013: a held down poll is woken by a command within 500 ms, and the commands up to after are acked", async () => {
    const { runner, token, task } = await world();
    const peer = await httpPeer(a.url, token, runner.runnerId);
    const started = Date.now();
    const held = peer.down(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const at = Date.now();
    await steer(runner, task, "use the staging config");
    const woken = await held;
    expect(Date.now() - at).toBeLessThan(500);
    expect(at - started).toBeGreaterThanOrEqual(400);
    expect(woken.status).toBe(200);
    const [command] = commands(woken.frames);
    expect(command).toMatchObject({ kind: "steer", body: { text: "use the staging config" } });
    if (command === undefined) {
      throw new Error("no command");
    }
    // The next poll after its seq acks it, and holds until the hold's end: nothing again.
    const idle = await peer.down(command.seq);
    expect(idle.status).toBe(204);
    expect((await test.db.command.findUniqueOrThrow({ where: { id: command.id } })).ackedAt).not.toBeNull();
    expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ ackedCommandSeq: command.seq });
  });

  it("F-013: a steer from another replica reaches the HTTP peer held on this one", async () => {
    const { runner, token, task } = await world();
    // Hello on replica a; the poll lands on replica b; the steer is written by neither.
    const peer = await httpPeer(a.url, token, runner.runnerId);
    const held = peer.down(0, { baseUrl: b.url });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const at = Date.now();
    await steer(runner, task, "from the other replica");
    const woken = await held;
    expect(Date.now() - at).toBeLessThan(500);
    expect(commands(woken.frames).map((command) => command.kind)).toEqual(["steer"]);
  });

  it("F-013: a superseded epoch is refused with 409 on up and down, its held poll ends, and a newer connection on either carrier wins", async () => {
    const { runner, token, task } = await world();
    const first = await httpPeer(a.url, token, runner.runnerId);
    const held = first.down(0, { baseUrl: b.url });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await httpPeer(a.url, token, runner.runnerId);
    expect(second.connectionEpoch).toBeGreaterThan(first.connectionEpoch);
    const ended = await held;
    expect(ended.status).toBe(409);
    expect(ended.body).toEqual({ code: "superseded" });
    expect((await first.up([batch(task, 1, 1)])).status).toBe(409);
    expect((await first.down(0)).status).toBe(409);
    expect(await stored(task)).toBe(0);

    // A WebSocket connection supersedes the HTTP one, and an HTTP hello the WebSocket's.
    const socket = await connectPeer(a.url, token, runner.runnerId);
    sockets.push(socket);
    await socket.next("welcome");
    expect((await second.up([batch(task, 1, 1)])).status).toBe(409);
    const third = await httpPeer(b.url, token, runner.runnerId);
    expect(await socket.next("evict")).toEqual({ type: "evict", reason: "replaced" });
    expect((await third.up([batch(task, 1, 1)])).status).toBe(200);
  });

  it("F-013: a revoked runner's still-valid access token is refused on every HTTP call, and its held poll ends", async () => {
    const { runner, token } = await world();
    const peer = await httpPeer(a.url, token, runner.runnerId);
    const held = peer.down(0, { baseUrl: b.url });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const scope = { organizationId: runner.organizationId, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member" as const, projectRoles: new Map() };
    expect(await test.db.$transaction((tx) => revokeRunner({ tx, scope, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { runnerId: runner.runnerId }))).toMatchObject({
      ok: true,
    });
    expect((await held).status).toBe(403);
    expect((await peer.up([])).status).toBe(403);
    expect((await peer.down(0)).status).toBe(403);
    expect((await postHello(a.url, token, httpHelloFrame(runner.runnerId))).status).toBe(403);
  });

  it("F-013: a runner minor outside the window is refused at hello with the fix", async () => {
    const { runner, token } = await world();
    const refused = await postHello(a.url, token, httpHelloFrame(runner.runnerId, { minor: PROTOCOL_MINOR + 2 }));
    expect(refused.status).toBe(426);
    const [error] = refused.frames;
    expect(error).toMatchObject({ type: "error", code: "version-unsupported" });
    expect(error?.type === "error" ? error.message : "").toContain("Fix: install the runner version this server names");
    expect(await test.db.runnerPresence.findUnique({ where: { runnerId: runner.runnerId } })).toBeNull();
    // One minor behind is inside the window, and is answered in its own minor.
    const behind = await httpPeer(a.url, token, runner.runnerId, { minor: PROTOCOL_MINOR - 1 });
    expect(behind.minor).toBe(PROTOCOL_MINOR - 1);
  });

  it("F-013: an HTTP connection is alive while a down poll is open or ended under the dead time, and then goes offline", async () => {
    const { runner, token } = await world();
    // A replica with short timers: dead after 1.5 s without a poll, presence written every 200 ms.
    const quick = await startGateway(test.db, test.url, { signingKey, timers: { deadMs: 1_500, presenceMs: 200, sweepMs: 200, longPollMs: 2_500 } });
    try {
      const peer = await httpPeer(quick.url, token, runner.runnerId);
      const presence = () => test.db.runnerPresence.findUniqueOrThrow({ where: { runnerId: runner.runnerId } });
      // A poll held longer than the dead time keeps it connected and online.
      expect((await peer.down(0, { baseUrl: quick.url })).status).toBe(204);
      expect((await presence()).disconnectedAt).toBeNull();
      expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online" });
      // Quiet past the dead time: gone, as a WebSocket that stopped answering, and its next request is refused.
      const until = Date.now() + 5_000;
      while ((await presence()).disconnectedAt === null && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await presence()).disconnectedAt).not.toBeNull();
      expect(await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "offline" });
      expect((await peer.down(0, { baseUrl: quick.url })).status).toBe(409);
    } finally {
      await quick.stop();
    }
  });
});
