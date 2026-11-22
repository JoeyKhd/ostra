import { rm } from "node:fs/promises";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { writeTicketStepsInTx } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { gitShaSchema, leaseEpochSchema, repoIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, RepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KillPointName } from "./kill-points.ts";
import { registerRunnerAt, spawnCore, spoolingRunner, waitFor } from "./testing/restart.ts";
import type { CoreProcess, SpoolingRunner } from "./testing/restart.ts";
import { seedRestartWorld } from "./testing/restart-world.ts";
import { dispatchPayload, seedQueuedTask } from "./testing/world.ts";
import type { QueuedTask, World } from "./testing/world.ts";

// Ticket 21 (F-043): a server killed at any moment and started again loses nothing, and every
// running task carries on. Core runs in its own process (`src/testing/restart-child.ts`) and is
// killed with SIGKILL at the named points of `src/kill-points.ts`; a runner that spools and resends
// as the real one does reconnects each time. After each kill: every event stored exactly once, the
// command applied once by its ID, the job finished once, and the code host saw one write.
//
// Each point runs OSTRA_RESTART_RUNS times (1 by default, so the suite stays quick; ticket 21's
// "ten times in a row" is OSTRA_RESTART_RUNS=10, recorded in the ticket).

const RUNS = Math.max(1, Number.parseInt(process.env["OSTRA_RESTART_RUNS"] ?? "1", 10) || 1);
const IN_A_ROW = RUNS === 1 ? "once" : `${String(RUNS)} times in a row`;
/** A test's time: each run's budget, as many runs as are asked for, and a margin for the starts. */
const budget = (perRunMs: number): number => RUNS * perRunMs + 120_000;
const BRANCHES = Array.from({ length: 40 }, (_unused, index) => `ostra/restart-${String(index)}`);

let test: TestDatabase;
let fixture: IsolationFixture;
let github: FakeGitHub;
let linear: FakeLinear;
let linearConnectionId: string;
let boardId: string;
const LINEAR_WEBHOOK_SECRET = "restart-linear-webhook-secret";
let dataDir: string;
let env: NodeJS.ProcessEnv;
let jobs: Jobs | null = null;
let world: World;
let runner: SpoolingRunner;
let connected: SpoolingRunner | null = null;
let core: CoreProcess | null = null;
let branchesUsed = 0;
const turnId = turnIdSchema.parse("turn-1");

const start = async (killAt: KillPointName | null): Promise<CoreProcess> => {
  core = await spawnCore(env, killAt);
  return core;
};

/** Kills the running core, if any, as a crash would. */
const crash = async (): Promise<void> => {
  await core?.kill();
  core = null;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "test1", defaultBranch: "main", files: {}, branches: ["main", ...BRANCHES] }] });
  linear = await createFakeLinear();
  const seeded = await seedRestartWorld({ test, fixture, github, linear, linearWebhookSecret: LINEAR_WEBHOOK_SECRET });
  ({ world, env, dataDir, linearConnectionId, boardId } = seeded);

  // The first start installs the queue's schema; the runner registers and connects.
  const first = await start(null);
  jobs = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
  await jobs.start();
  runner = spoolingRunner(await registerRunnerAt(first.url, test.db, fixture.a.member));
  await runner.connect(first.url);
  connected = runner;
}, 180_000);

afterAll(async () => {
  connected?.close();
  await crash();
  await jobs?.stop({ graceful: false, timeoutMs: 2_000 });
  await github.close();
  await linear.close();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

const repoId = (): RepoId => repoIdSchema.parse(world.repoId);

/** A queued task of the runner's member, on one of the fake repo's branches, dispatched by core's own worker. */
const dispatchedTask = async (): Promise<QueuedTask & { readonly branch: string; readonly epoch: LeaseEpoch }> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const branch = BRANCHES[branchesUsed] ?? `ostra/restart-extra-${String(branchesUsed)}`;
  branchesUsed += 1;
  await test.db.task.update({ where: { id: task.taskId }, data: { branchName: branch } });
  await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { branchName: branch } });
  const queue = jobs;
  if (queue === null) {
    throw new Error("the queue");
  }
  await test.db.$transaction((tx) => queue.enqueueInTx(tx, "task.dispatch", dispatchPayload(task)));
  return { ...task, branch, epoch: leaseEpochSchema.parse(1) };
};

const dispatchCommands = async (task: QueuedTask) =>
  (await test.db.command.findMany({ where: { taskId: task.taskId, kind: "dispatch" } })).map((row) => row.id);

const accepted = (task: QueuedTask) =>
  waitFor("the task accepted", async () => (await test.db.lease.findFirst({ where: { taskId: task.taskId, state: "active", acceptedAt: { not: null } } })) !== null, 90_000);

/** Restarts core after it died at its kill point, and reconnects the runner to it. */
const restartAfterKill = async (): Promise<void> => {
  const died = core;
  if (died === null) {
    throw new Error("no core");
  }
  await died.exited;
  await runner.lost();
  core = null;
  const again = await start(null);
  await runner.connect(again.url);
};

/** A core running without a kill point, with the runner connected to it. */
const plain = async (): Promise<CoreProcess> => {
  if (core !== null) {
    return core;
  }
  const fresh = await start(null);
  await runner.connect(fresh.url);
  return fresh;
};

/** Restarts core armed at `point`, with the runner connected. */
const armed = async (point: KillPointName): Promise<void> => {
  await crash();
  await runner.lost();
  const next = await start(point);
  await runner.connect(next.url);
};

const storedSeqs = async (task: QueuedTask): Promise<readonly number[]> =>
  (await test.db.event.findMany({ where: { sessionId: task.sessionId, sessionSeq: { not: null } }, orderBy: { seq: "asc" }, select: { sessionSeq: true } })).map((row) => row.sessionSeq ?? 0);

const thought = (text: string) => ({ kind: "agent.thought" as const, turnId, segmentId: segmentIdSchema.parse(`t-${text}`), text });

describe("a server killed mid-flight (F-043)", () => {
  for (const point of ["ingest.batch-open", "ingest.batch-committed"] as const) {
    it(`loses no event and stores none twice when killed at ${point}, ${IN_A_ROW}`, async () => {
      for (let run = 0; run < RUNS; run += 1) {
        await plain();
        const task = await dispatchedTask();
        await accepted(task);
        const session = { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.epoch };
        runner.send(session, { kind: "turn.started", turnId });
        await runner.acked(task.sessionId, 1);
        await armed(point);
        runner.send(session, thought("a"), thought("b"), thought("c"));
        await restartAfterKill();
        await runner.acked(task.sessionId, 4);
        // Every event once, in order; the runner carried on and the next batch is stored too.
        expect(await storedSeqs(task)).toEqual([1, 2, 3, 4]);
        runner.send(session, thought("d"));
        await runner.acked(task.sessionId, 5);
        expect(await storedSeqs(task)).toEqual([1, 2, 3, 4, 5]);
        expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).ingestedSeq).toBe(5);
      }
    }, budget(60_000));
  }

  it(`applies a dispatch once when killed with it in the outbox and unacked, ${IN_A_ROW}`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await armed("dispatch.offered");
      const task = await dispatchedTask();
      await waitFor("core to die at its kill point", () => core?.dead() ?? true, 120_000);
      await restartAfterKill();
      await accepted(task);
      // The job that was running when core died is retried, and finds the task moved on.
      const queue = jobs;
      if (queue === null) {
        throw new Error("the queue");
      }
      await waitFor(
        "the dispatch job to finish",
        async () => (await queue.find("task.dispatch", dispatchPayload(task))).some((job) => job.state === "completed"),
        90_000,
      );
      const commands = await dispatchCommands(task);
      expect(commands).toHaveLength(1);
      const [commandId] = commands;
      expect(runner.applied.get(commandId ?? "")).toBe(1);
      expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(1);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).leaseEpoch).toBe(1);
    }
  }, budget(150_000));

  it(`acts on a webhook once when killed inside webhook.process, ${IN_A_ROW}`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const issue = await linear.createIssue({ title: `A ticket for run ${String(run)}` });
      await armed("webhook.process");
      const running = core;
      if (running === null) {
        throw new Error("no core");
      }
      const delivery = linear.signedDelivery({ issueId: issue.id, byUserId: linear.admin.id, sentAt: Date.now(), secret: LINEAR_WEBHOOK_SECRET });
      const answer = await fetch(`${running.url}/webhooks/linear/${linearConnectionId}`, {
        method: "POST",
        headers: { ...delivery.headers, "content-type": "application/json" },
        body: Buffer.from(delivery.rawBody),
      });
      expect(answer.status).toBe(200);
      await waitFor("core to die at its kill point", () => core?.dead() ?? true, 120_000);
      await restartAfterKill();
      await waitFor(
        "the delivery to be processed",
        async () => (await test.db.webhookDelivery.findFirst({ where: { connectionId: linearConnectionId, ticketKey: issue.identifier, status: "processed" } })) !== null,
        120_000,
      );
      // One delivery, one cached ticket, acted on once.
      expect(await test.db.ticket.count({ where: { boardId, externalId: issue.id } })).toBe(1);
      const deliveries = await test.db.webhookDelivery.findMany({ where: { connectionId: linearConnectionId, ticketKey: issue.identifier } });
      expect(deliveries.map((row) => row.status)).toEqual(["processed"]);
    }
  }, budget(150_000));

  it(`writes to the ticket once when killed after the tracker answered, ${IN_A_ROW}`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const issue = await linear.createIssue({ title: `Sync run ${String(run)}` });
      const ticket = await test.db.ticket.create({
        data: {
          organizationId: world.organizationId,
          projectId: world.projectId,
          boardId,
          connectionId: linearConnectionId,
          externalId: issue.id,
          key: issue.identifier,
          title: `Sync run ${String(run)}`,
          url: `https://linear.app/${linear.organization.urlKey}/issue/${issue.identifier}`,
          trackerUpdatedAt: new Date(),
        },
      });
      await armed("ticket.sync.answered");
      const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested", ticketId: ticket.id, boardId, ticketKey: issue.identifier } });
      const queue = jobs;
      if (queue === null) {
        throw new Error("the queue");
      }
      // Ticket 29's start: the status move, the progress comment and the task's link, each a job.
      await test.db.$transaction((tx) =>
        writeTicketStepsInTx({ tx, jobs: queue }, { taskId: task.taskId, trigger: { kind: "task-started", taskUrl: `http://localhost:3000/tasks/${task.taskId}`, taskTitle: "Sync" } }),
      );
      await waitFor("core to die at its kill point", () => core?.dead() ?? true, 120_000);
      await restartAfterKill();
      await waitFor(
        "every ticket write done",
        async () => (await test.db.ticketWrite.count({ where: { taskId: task.taskId, state: { not: "done" } } })) === 0,
        180_000,
      );
      const view = linear.issueView(issue.id);
      expect(view.comments).toHaveLength(1);
      expect(view.attachments).toHaveLength(1);
      expect(await test.db.ticketWrite.count({ where: { taskId: task.taskId } })).toBe(3);
    }
  }, budget(180_000));

  it(`F-046/c1: opens one PR when killed after GitHub answered, and the retried job finds it, ${IN_A_ROW}`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await armed("open-pull-requests.answered");
      const task = await dispatchedTask();
      await accepted(task);
      const session = { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.epoch };
      const head = gitShaSchema.parse(String(run).padStart(40, "a"));
      runner.send(
        session,
        { kind: "turn.started", turnId },
        { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("m"), text: "Done." },
        { kind: "git.pushed", repoId: repoId(), branch: task.branch, headSha: head, ref: `refs/heads/${task.branch}` },
        { kind: "turn.ended", turnId, stopReason: "end_turn" },
        { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId: repoId(), headSha: head, ahead: true, hiddenRefSha: null }], archive: null },
      );
      await runner.acked(task.sessionId, 5);
      await waitFor("core to die at its kill point", () => core?.dead() ?? true, 120_000);
      await restartAfterKill();
      // The opener records the PR, then moves the task in its own transaction: wait for the move.
      await waitFor("the task in review", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review", 120_000);
      expect(await test.db.taskRepo.findFirst({ where: { taskId: task.taskId, state: "pr_open" } })).not.toBeNull();
      expect(github.pulls.filter((pull) => pull.head === task.branch)).toHaveLength(1);
      // GitHub was asked to create it once: the retry after the kill found it by its head branch.
      expect(github.pullCreates.filter((head) => head === task.branch)).toHaveLength(1);
      expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(1);
      expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("in_review");
    }
  }, budget(180_000));
});
