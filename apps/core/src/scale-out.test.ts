import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { postgresCommandOutbox } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { clientMessageIdSchema, leaseEpochSchema, projectIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { CommandId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freePort, registerRunnerAt, spawnCore, spoolingRunner, waitFor } from "./testing/restart.ts";
import type { CoreProcess, SpoolingRunner } from "./testing/restart.ts";
import { seedRestartWorld } from "./testing/restart-world.ts";
import { dispatchPayload, seedQueuedTask } from "./testing/world.ts";
import type { QueuedTask, World } from "./testing/world.ts";

// F-117/c1 (ADR 0016): every server process is stateless, and any number of core replicas share
// one Postgres, which does the routing. Three core processes (`src/testing/restart-child.ts`, which
// starts core as `src/main.ts` does) run on one database, each on its own port, as replicas on
// three machines do. A runner registers with one and connects to another; the queue's worker that
// dispatches its task, and the steers written as the panel writes them (a web process, here the
// test's), reach it through Postgres alone. Its replica is then killed with SIGKILL: the runner
// connects to a third, resends what wasn't acked, and gets what was written while it was away.
// Nothing a replica held is missed: every event is stored once, every command applied once.
//
// The web replicas' side, two panel processes on one database woken by Postgres's NOTIFY, is
// `packages/api/src/stream/stream.test.ts`. The image's `web`, `core` and `all` roles as containers
// wait for the launch gate's run.

const BRANCHES = Array.from({ length: 4 }, (_unused, index) => `ostra/scale-out-${String(index)}`);

let test: TestDatabase;
let fixture: IsolationFixture;
let github: FakeGitHub;
let linear: FakeLinear;
let dataDir: string;
let env: NodeJS.ProcessEnv;
let world: World;
let jobs: Jobs | null = null;
let runner: SpoolingRunner | undefined;
let branchesUsed = 0;
const replicas: CoreProcess[] = [];
const turnId = turnIdSchema.parse("turn-1");

/** A core replica on its own port, as one process of the install on its own machine. */
const startReplica = async (): Promise<CoreProcess> => {
  const replica = await spawnCore({ ...env, OSTRA_CORE_PORT: String(await freePort()) }, null);
  replicas.push(replica);
  return replica;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "test1", defaultBranch: "main", files: {}, branches: ["main", ...BRANCHES] }] });
  linear = await createFakeLinear();
  ({ world, env, dataDir } = await seedRestartWorld({ test, fixture, github, linear, linearWebhookSecret: "scale-out-linear-webhook-secret" }));
  // The first replica installs the queue's schema; the other two start beside it.
  await startReplica();
  await Promise.all([startReplica(), startReplica()]);
  jobs = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
  await jobs.start();
  // The runner registers with the second replica.
  runner = spoolingRunner(await registerRunnerAt(replica(1).url, test.db, fixture.a.member));
}, 240_000);

afterAll(async () => {
  await Promise.all(replicas.map((replica) => replica.kill()));
  runner?.close();
  await jobs?.stop({ graceful: false, timeoutMs: 2_000 });
  await github.close();
  await linear.close();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

const replica = (index: number): CoreProcess => {
  const found = replicas[index];
  if (found === undefined) throw new Error(`no replica ${String(index)}`);
  return found;
};

const theRunner = (): SpoolingRunner => {
  if (runner === undefined) throw new Error("no runner yet");
  return runner;
};

/** A queued task of the runner's member, dispatched by whichever replica's queue worker takes the job. */
const dispatchedTask = async (): Promise<QueuedTask> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, theRunner().runnerId);
  const branch = BRANCHES[branchesUsed] ?? `ostra/scale-out-extra-${String(branchesUsed)}`;
  branchesUsed += 1;
  await test.db.task.update({ where: { id: task.taskId }, data: { branchName: branch } });
  await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { branchName: branch } });
  const queue = jobs;
  if (queue === null) throw new Error("the queue");
  await test.db.$transaction((tx) => queue.enqueueInTx(tx, "task.dispatch", dispatchPayload(task)));
  return task;
};

const accepted = (task: QueuedTask) =>
  waitFor("the task accepted", async () => (await test.db.lease.findFirst({ where: { taskId: task.taskId, state: "active", acceptedAt: { not: null } } })) !== null, 90_000);

/** A steer, written as the panel's send writes it: in a transaction of its own, to the outbox, with its NOTIFY. */
const steer = async (task: QueuedTask, text: string): Promise<CommandId> => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId }, select: { projectId: true } });
  const written = await test.db.$transaction((tx) =>
    postgresCommandOutbox.enqueueInTx(tx, task.organizationId, theRunner().runnerId, {
      kind: "steer",
      body: { sessionId: task.sessionId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text, delivery: "queue" },
      notAfter: Date.now() + 120_000,
      task: { taskId: task.taskId, projectId: projectIdSchema.parse(row.projectId) },
    }),
  );
  return written.commandId;
};

const storedSeqs = async (task: QueuedTask): Promise<readonly number[]> =>
  (await test.db.event.findMany({ where: { sessionId: task.sessionId, sessionSeq: { not: null } }, orderBy: { seq: "asc" }, select: { sessionSeq: true } })).map((row) => row.sessionSeq ?? 0);

const thought = (text: string) => ({ kind: "agent.thought" as const, turnId, segmentId: segmentIdSchema.parse(`t-${text}`), text });

describe("core as several replicas on one Postgres (F-117)", () => {
  it("F-117/c1: three core replicas hand a runner its dispatches and steers through Postgres whichever holds it, and when its replica dies it carries on on another, losing nothing", async () => {
    // Registered with the second replica, it connects to the first: its row is in Postgres, not in a replica.
    const runner = theRunner();
    await runner.connect(replica(0).url);

    // A dispatch, written by whichever replica's worker takes the job, reaches the runner on the first.
    const first = await dispatchedTask();
    await accepted(first);
    const session = { taskId: first.taskId, sessionId: first.sessionId, leaseEpoch: leaseEpochSchema.parse(1) };
    runner.send(session, { kind: "turn.started", turnId });
    await runner.acked(first.sessionId, 1);
    // A steer written outside every replica, as a web process writes it, is woken there by NOTIFY.
    const before = await steer(first, "use the staging config");
    await waitFor("the steer at the runner", () => runner.received.has(before), 30_000);

    // The runner's replica dies at once. What it was sent meanwhile waits in Postgres.
    runner.send(session, thought("sent-as-it-died"));
    await replica(0).kill();
    await runner.lost();
    const whileAway = await steer(first, "keep the cursor where it was");

    // It connects to the third replica, which never saw it: the unacked event is stored once, and
    // the steer written while it was away arrives.
    await runner.connect(replica(2).url);
    await runner.acked(first.sessionId, 2);
    await waitFor("the steer written while it was away", () => runner.received.has(whileAway), 30_000);
    runner.send(session, thought("after"));
    await runner.acked(first.sessionId, 3);

    // The next task is dispatched to it there, whichever of the two left takes the job.
    const second = await dispatchedTask();
    await accepted(second);

    // Nothing lost, nothing twice: every event stored once, in order, and every command applied once.
    expect(await storedSeqs(first)).toEqual([1, 2, 3]);
    expect((await test.db.session.findUniqueOrThrow({ where: { id: first.sessionId } })).ingestedSeq).toBe(3);
    const dispatches = await test.db.command.findMany({ where: { taskId: { in: [first.taskId, second.taskId] }, kind: "dispatch" }, select: { id: true } });
    expect(dispatches).toHaveLength(2);
    for (const commandId of [before, whileAway, ...dispatches.map((row) => row.id)]) {
      expect(runner.applied.get(commandId)).toBe(1);
    }
    expect(await test.db.lease.count({ where: { taskId: { in: [first.taskId, second.taskId] } } })).toBe(2);
    // The two replicas left run on.
    expect([replica(1).dead(), replica(2).dead()]).toEqual([false, false]);
  }, 240_000);
});
