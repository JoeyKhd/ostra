import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { boxIdSchema, clientMessageIdSchema, projectIdSchema, runnerLimits, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { CommandOf, Peer, TaskEvent } from "@ostra/protocol";
import { startConnection } from "@ostra/runner";
import type { CommandHandlers, RunnerConnection } from "@ostra/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cancelGraceInTx, cancelSidecarGraceInTx, startGraceInTx, startSidecarGraceInTx } from "../ingest/grace.ts";
import type { GraceDeps } from "../ingest/grace.ts";
import { createIngest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import type { RunnerRef } from "./context.ts";

// F-045 (ADR 0034, Q38): a runner, or a box's sidecar, that drops out for less than the grace
// reconnects, and its task carries on without losing an event. The real runner connection
// (`apps/runner`'s `startConnection`) against core's real gateway, ingest and task grace, at the
// grace's own 10 minutes, through a loopback front that cuts the network: open sockets are reset
// and new ones refused until it's back. The runner keeps emitting while it's cut off, into its
// spool; its clock moves on 9 minutes in the cut, so its self-fence (9.5 minutes) is what a real
// cut that long would meet.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let liveText: LiveTextWriter;
let core: GatewayHarness;
let front: Front;
const cleanups: (() => Promise<void>)[] = [];

// ---------- a front that cuts the network ----------

type Front = {
  readonly url: string;
  /** Resets every connection open now, and refuses new ones until `restore`. */
  readonly cut: () => void;
  readonly restore: () => void;
  readonly close: () => Promise<void>;
};

const startFront = async (corePort: number): Promise<Front> => {
  const sockets = new Set<net.Socket>();
  let down = false;
  const server = net.createServer((client) => {
    if (down) {
      client.resetAndDestroy();
      return;
    }
    const upstream = net.connect(corePort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
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
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    cut: () => {
      down = true;
      for (const socket of sockets) socket.resetAndDestroy();
    },
    restore: () => {
      down = false;
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
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const logger = createLogger(() => undefined);
  liveText = createLiveTextWriter({ db: test.db, logger, intervalMs: 50 });
  // The grace at its own length: no `graceMs`, so `runnerLimits.graceMs` (10 minutes).
  const graceDeps: GraceDeps = { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger };
  core = await startGateway(test.db, test.url, {
    signingKey: randomBytes(32),
    hooks: {
      ingest: createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger }),
      liveText: liveText.write,
      onConnectedInTx: (tx, runner) => cancelGraceInTx(graceDeps, tx, runner),
      onDisconnectedInTx: (tx, runner) => startGraceInTx(graceDeps, tx, runner),
      onSidecarConnectedInTx: (tx, lease) => cancelSidecarGraceInTx(graceDeps, tx, lease),
      onSidecarDisconnectedInTx: (tx, lease) => startSidecarGraceInTx(graceDeps, tx, lease),
    },
  });
  front = await startFront(Number(new URL(core.url).port));
}, 60_000);

afterEach(async () => {
  front.restore();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

afterAll(async () => {
  await front.close();
  await core.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

// ---------- the peer ----------

type Connected = {
  readonly connection: RunnerConnection;
  readonly steers: CommandOf<"steer">[];
  readonly fenced: string[];
  /** Moves the peer's own clock on: the self-fence and the dead check read it. */
  readonly advance: (ms: number) => void;
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

const connect = async (ref: RunnerRef, peer: Peer, token: () => string): Promise<Connected> => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-drop-"));
  const steers: CommandOf<"steer">[] = [];
  const fenced: string[] = [];
  let shiftMs = 0;
  const connection = await startConnection({
    serverUrl: front.url,
    peer,
    tokens: {
      get: () => Promise.resolve({ ok: true, token: token(), expiresAt: Date.now() + shiftMs + 600_000 }),
      invalidate: () => undefined,
    },
    dataDir,
    handlers: handlersRecording(steers),
    status: () => ({ executor: "host", capacity: 1, freeSlots: 0, labels: [], running: [] }),
    logger: silentLogger,
    hooks: {
      onSelfFence: (sessions) => {
        fenced.push(...sessions);
      },
    },
    transport: "websocket",
    now: () => Date.now() + shiftMs,
    // The backoff at its floor, so the reconnect comes a second after the network does.
    random: () => 0,
    timers: { checkMs: 100 },
  });
  cleanups.push(async () => {
    await connection.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    connection,
    steers,
    fenced,
    advance: (ms) => {
      shiftMs += ms;
    },
  };
};

const until = async (what: string, check: () => boolean | Promise<boolean>, withinMs: number): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > withinMs) throw new Error(`not within ${String(withinMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const thought = (index: number): TaskEvent => ({ kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse(`s-${String(index)}`), text: `step ${String(index)}` });

const graceJobs = (task: LeasedTask) => jobs.find("task.grace", { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch });

const steer = (ref: RunnerRef, task: LeasedTask, text: string) =>
  test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, ref.organizationId, ref.runnerId, {
      kind: "steer",
      body: { sessionId: task.sessionId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queue" },
      notAfter: Date.now() + 60_000,
      task: { taskId: task.taskId, projectId: task.projectId },
    }),
  );

describe("a runner or a sidecar offline for less than the grace (F-045)", () => {
  for (const kind of ["runner", "sidecar"] as const) {
    it(`F-045/c1: a ${kind} cut off for 9 minutes reconnects, its task carries on, and every event it sent or spooled is stored once`, async () => {
      const ref = await seedRunner(test.db, fixture.a.organization.id, fixture.a.member.id);
      const task = await seedLeasedTask(test.db, ref, projectIdSchema.parse(fixture.a.openProject.id), { state: "running" });
      // A sidecar holds a `docker` box's task (Q129): its own connection, with the task's token.
      const peer: Peer = kind === "runner" ? { kind: "runner", runnerId: ref.runnerId } : { kind: "sidecar", taskId: task.taskId, boxId: boxIdSchema.parse(task.boxId), leaseEpoch: task.leaseEpoch };
      if (kind === "sidecar") {
        await test.db.box.update({ where: { id: task.boxId }, data: { executor: "docker" } });
      }
      const token =
        kind === "runner"
          ? () => core.gateway.context.tokens.issue(ref.runnerId, ref.organizationId, Date.now()).accessToken
          : () => core.gateway.context.taskTokens.issue({ organizationId: ref.organizationId, taskId: task.taskId, leaseEpoch: task.leaseEpoch, boxId: boxIdSchema.parse(task.boxId), runnerId: ref.runnerId });
      const peerOf = await connect(ref, peer, token);
      await until("connected", () => peerOf.connection.report().connected, 15_000);
      const channel = await peerOf.connection.openSession({ taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.leaseEpoch });
      for (let index = 1; index <= 5; index += 1) await channel.emit(thought(index));
      await channel.drained();

      // The network goes. Core sees the connection close and starts the task's grace, due at 10 minutes.
      const cutAt = Date.now();
      front.cut();
      await until("the grace started", async () => (await graceJobs(task)).some((job) => job.state === "created"), 15_000);
      const [grace] = (await graceJobs(task)).filter((job) => job.state === "created");
      const startAfter = await test.db.$queryRaw<readonly { readonly start_after: Date }[]>`SELECT start_after FROM pgboss.job WHERE id = ${grace?.id ?? ""}::uuid`;
      expect((startAfter[0]?.start_after.getTime() ?? 0) - cutAt).toBeGreaterThanOrEqual(runnerLimits.graceMs - 5_000);
      // The agent carries on meanwhile: what it emits waits in the spool.
      for (let index = 6; index <= 15; index += 1) await channel.emit(thought(index));
      expect(peerOf.connection.report().connected).toBe(false);
      // Nine minutes pass on the peer's clock: short of its 9.5-minute self-fence.
      peerOf.advance(9 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(peerOf.fenced).toEqual([]);

      // The network is back: the peer reconnects, the grace is cancelled, the spool is resent.
      front.restore();
      await until("reconnected", () => peerOf.connection.report().connected, 30_000);
      await channel.drained();
      await until("the grace cancelled", async () => (await graceJobs(task)).every((job) => job.state === "cancelled"), 15_000);
      const rows = await test.db.event.findMany({ where: { taskId: task.taskId, sessionId: task.sessionId, sessionSeq: { not: null } }, select: { sessionSeq: true, payload: true }, orderBy: { sessionSeq: "asc" } });
      expect(rows.map((row) => row.sessionSeq)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
      expect(rows.map((row) => JSON.stringify(row.payload)).filter((payload) => payload.includes("step 15"))).toHaveLength(1);
      // The task carries on, on its lease: nothing was stopped or fenced.
      expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "running", leaseEpoch: task.leaseEpoch });
      expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "active", epoch: task.leaseEpoch });
      expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "stop" } })).toBe(0);
      expect(peerOf.fenced).toEqual([]);
      // And the runner's next command reaches it: a member's message, after the cut.
      if (kind === "runner") {
        await steer(ref, task, "carry on with the tests");
        await until("the steer", () => peerOf.steers.length === 1, 15_000);
        expect(peerOf.steers[0]?.body.text).toBe("carry on with the tests");
      }
      await channel.emit(thought(16));
      await channel.drained();
      expect(await test.db.event.count({ where: { taskId: task.taskId, sessionSeq: 16 } })).toBe(1);
    }, 90_000);
  }
});
