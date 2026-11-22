import { rm } from "node:fs/promises";

import { createFakeGitHub } from "@ostra/adapter-github/testing";
import type { FakeGitHub } from "@ostra/adapter-github/testing";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { writeTicketStepsInTx } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { gitShaSchema, leaseEpochSchema, repoIdSchema, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { KillPointName } from "./kill-points.ts";
import { freePort, registerRunnerAt, spawnCore, spoolingRunner, waitFor } from "./testing/restart.ts";
import type { CoreProcess, SpoolingRunner } from "./testing/restart.ts";
import { seedRestartWorld } from "./testing/restart-world.ts";
import { dispatchPayload, seedQueuedTask } from "./testing/world.ts";
import type { QueuedTask, World } from "./testing/world.ts";

// Ticket 38 (F-048, F-046): the failure suite's cases that need core's own processes and the fakes,
// run by `pnpm e2e:m2:failures` and by the Proof workflow's `failure-cases` job at the launch gate
// (OSTRA_FAILURE_SUITE=1), and skipped otherwise, so CI stays quick.
//
// - **Spike 8's three kill points, with a survivor.** Two replicas of core share one database. The
//   first holds the job and is killed with SIGKILL before the job's side effect, after it and
//   before the job completes, or after it completes; the second replica is the survivor, which runs
//   the job again where it must. A fake GitHub counts the PR creates per head branch and the fake
//   Linear its mutations: one side effect per key, every time.
// - **A retry after a write committed.** The fakes apply a write and answer 500 (Linear's
//   `fail-after-write`, the fake GitHub's `afterWrite`): the retry finds the write by its marker,
//   and nothing is doubled.
//
// The first replica runs alone until it holds the job, so the kill lands where the case says; the
// survivor is started as it dies. Either way the job comes back to the survivor only through the
// queue's own recovery (the heartbeat), which is what the case tests.

const enabled = process.env["OSTRA_FAILURE_SUITE"] === "1";
const BRANCHES = Array.from({ length: 20 }, (_unused, index) => `ostra/failure-${String(index)}`);
const LINEAR_WEBHOOK_SECRET = "failure-suite-linear-webhook-secret";
const turnId = turnIdSchema.parse("turn-1");

let test: TestDatabase;
let fixture: IsolationFixture;
let github: FakeGitHub;
let linear: FakeLinear;
let env: NodeJS.ProcessEnv;
let dataDir = "";
let world: World;
let boardId: string;
let linearConnectionId: string;
let jobs: Jobs | null = null;
let runner: SpoolingRunner;
let branchesUsed = 0;
const replicas = new Set<CoreProcess>();

/** A replica on its own port, as two processes of one install on two machines are. */
const startReplica = async (killAt: KillPointName | null): Promise<CoreProcess> => {
  const replica = await spawnCore({ ...env, OSTRA_CORE_PORT: String(await freePort()) }, killAt);
  replicas.add(replica);
  void replica.exited.then(() => replicas.delete(replica));
  return replica;
};

const stopAll = async (): Promise<void> => {
  runner.close();
  await Promise.all([...replicas].map((replica) => replica.kill()));
};

const queue = (): Jobs => {
  if (jobs === null) {
    throw new Error("the queue");
  }
  return jobs;
};

beforeAll(async () => {
  if (!enabled) {
    return;
  }
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  github = await createFakeGitHub({ repos: [{ id: 101, owner: "fake-org", name: "test1", defaultBranch: "main", files: {}, branches: ["main", ...BRANCHES] }] });
  linear = await createFakeLinear();
  ({ world, env, dataDir, linearConnectionId, boardId } = await seedRestartWorld({ test, fixture, github, linear, linearWebhookSecret: LINEAR_WEBHOOK_SECRET }));
  // The first start installs the queue's schema; the runner registers there.
  const first = await startReplica(null);
  jobs = createJobs({ databaseUrl: test.url, role: "enqueue-only" });
  await jobs.start();
  runner = spoolingRunner(await registerRunnerAt(first.url, test.db, fixture.a.member));
  await first.kill();
}, 180_000);

afterAll(async () => {
  if (!enabled) {
    return;
  }
  await stopAll();
  await jobs?.stop({ graceful: false, timeoutMs: 2_000 });
  await github.close();
  await linear.close();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

// ---------- task.open-pull-requests ----------

/** A task of the runner's member, dispatched and accepted, on a fresh branch of the fake repo. */
const acceptedTask = async (): Promise<QueuedTask & { readonly branch: string; readonly epoch: LeaseEpoch }> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const branch = BRANCHES[branchesUsed] ?? `ostra/failure-extra-${String(branchesUsed)}`;
  branchesUsed += 1;
  await test.db.task.update({ where: { id: task.taskId }, data: { branchName: branch } });
  await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { branchName: branch } });
  await test.db.$transaction((tx) => queue().enqueueInTx(tx, "task.dispatch", dispatchPayload(task)));
  await waitFor("the task accepted", async () => (await test.db.lease.findFirst({ where: { taskId: task.taskId, state: "active", acceptedAt: { not: null } } })) !== null, 90_000);
  return { ...task, branch, epoch: leaseEpochSchema.parse(1) };
};

/** The turn's end and its save, as a runner sends them: core enqueues `task.open-pull-requests`. */
const saveTurn = async (task: QueuedTask & { readonly branch: string; readonly epoch: LeaseEpoch }, run: number): Promise<void> => {
  const repoId = repoIdSchema.parse(world.repoId);
  const head = gitShaSchema.parse(String(run).padStart(40, "b"));
  runner.send(
    { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: task.epoch },
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("m"), text: "Done." },
    { kind: "git.pushed", repoId, branch: task.branch, headSha: head, ref: `refs/heads/${task.branch}` },
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    { kind: "session.saved", turnOrdinal: 1, repos: [{ repoId, headSha: head, ahead: true, hiddenRefSha: null }], archive: null },
  );
  await runner.acked(task.sessionId, 5, 90_000);
};

/** The opener's jobs for a task's saved turn, found by the payload core enqueued them with. */
const openJobs = async (task: QueuedTask) => {
  const saved = await test.db.event.findFirst({ where: { taskId: task.taskId, kind: "session.saved" }, select: { seq: true } });
  return saved === null
    ? []
    : queue().find("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq });
};

const openJobDone = async (task: QueuedTask): Promise<boolean> => (await openJobs(task)).some((job) => job.state === "completed");

const creates = (branch: string): number => github.pullCreates.filter((head) => head === branch).length;

// ---------- ticket.sync ----------

/** A ticket task whose start writes its three ticket steps, each a `ticket.sync` job. */
type IssueId = Awaited<ReturnType<FakeLinear["createIssue"]>>["id"];

const ticketTask = async (title: string): Promise<{ readonly taskId: TaskId; readonly issueId: IssueId }> => {
  const issue = await linear.createIssue({ title });
  const ticket = await test.db.ticket.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      boardId,
      connectionId: linearConnectionId,
      externalId: issue.id,
      key: issue.identifier,
      title,
      url: `https://linear.app/${linear.organization.urlKey}/issue/${issue.identifier}`,
      trackerUpdatedAt: new Date(),
    },
  });
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested", ticketId: ticket.id, boardId, ticketKey: issue.identifier } });
  return { taskId: task.taskId, issueId: issue.id };
};

const writeSteps = async (taskId: TaskId): Promise<void> => {
  await test.db.$transaction((tx) =>
    writeTicketStepsInTx({ tx, jobs: queue() }, { taskId, trigger: { kind: "task-started", taskUrl: `http://localhost:3000/tasks/${taskId}`, taskTitle: "Failure suite" } }),
  );
};

const writesDone = async (taskId: TaskId): Promise<boolean> => (await test.db.ticketWrite.count({ where: { taskId, state: { not: "done" } } })) === 0;

/** One comment, one link, and the ticket moved once (from its open state to started). */
const oneOfEach = (issueId: IssueId, movesBefore: number): void => {
  const view = linear.issueView(issueId);
  expect(view.comments).toHaveLength(1);
  expect(view.attachments).toHaveLength(1);
  expect((linear.apiCalls()["issueUpdate"] ?? 0) - movesBefore).toBe(1);
};

describe.runIf(enabled)("spike 8's three kill points, with a survivor (F-048, F-046)", () => {
  for (const point of ["open-pull-requests.before", "open-pull-requests.answered"] as const) {
    it(`F-048/c2: task.open-pull-requests: a replica killed at ${point}; the survivor opens one PR`, async () => {
      const victim = await startReplica(point);
      await runner.connect(victim.url);
      const task = await acceptedTask();
      await saveTurn(task, branchesUsed);
      await victim.exited;
      expect(victim.dead()).toBe(true);
      runner.close();
      const survivor = await startReplica(null);
      await runner.connect(survivor.url);
      await waitFor("the job done on the survivor", () => openJobDone(task), 120_000);
      // The victim is gone: the survivor ran it. One create per key, one PR, one `pr.opened`.
      expect(replicas.has(victim)).toBe(false);
      expect(creates(task.branch)).toBe(1);
      expect(github.pulls.filter((pull) => pull.head === task.branch)).toHaveLength(1);
      expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(1);
      await waitFor("the task in review", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review", 60_000);
      await stopAll();
    }, 300_000);
  }

  it("F-048/c2: task.open-pull-requests: a replica killed after the job completed; the survivor does nothing again", async () => {
    const holder = await startReplica(null);
    await runner.connect(holder.url);
    const task = await acceptedTask();
    await saveTurn(task, branchesUsed);
    await waitFor("the job done", () => openJobDone(task), 120_000);
    const survivor = await startReplica(null);
    await holder.kill();
    runner.close();
    await runner.connect(survivor.url);
    // Past the heartbeat and two supervise passes: a job still active would have come back by now.
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    expect(creates(task.branch)).toBe(1);
    expect(github.pulls.filter((pull) => pull.head === task.branch)).toHaveLength(1);
    expect((await openJobs(task)).map((job) => job.state)).toEqual(["completed"]);
    await stopAll();
  }, 300_000);

  for (const point of ["ticket.sync.before", "ticket.sync.answered"] as const) {
    it(`ticket.sync: a replica killed at ${point}; the survivor writes each step once`, async () => {
      const victim = await startReplica(point);
      const { taskId, issueId } = await ticketTask(`Kill at ${point}`);
      const movesBefore = linear.apiCalls()["issueUpdate"] ?? 0;
      await writeSteps(taskId);
      await victim.exited;
      const survivor = await startReplica(null);
      await waitFor("every ticket write done on the survivor", () => writesDone(taskId), 180_000);
      expect(replicas.has(victim)).toBe(false);
      expect(replicas.has(survivor)).toBe(true);
      oneOfEach(issueId, movesBefore);
      expect(await test.db.ticketWrite.count({ where: { taskId } })).toBe(3);
      await stopAll();
    }, 300_000);
  }

  it("ticket.sync: a replica killed after the jobs completed; the survivor writes nothing again", async () => {
    const holder = await startReplica(null);
    const { taskId, issueId } = await ticketTask("Kill after completion");
    const movesBefore = linear.apiCalls()["issueUpdate"] ?? 0;
    await writeSteps(taskId);
    await waitFor("every ticket write done", () => writesDone(taskId), 180_000);
    await startReplica(null);
    await holder.kill();
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    oneOfEach(issueId, movesBefore);
    await stopAll();
  }, 300_000);
});

describe.runIf(enabled)("a retry after a write committed, on the fakes (F-046)", () => {
  it("Linear applies each write and answers 500: one comment, one link, one move", async () => {
    await startReplica(null);
    const { taskId, issueId } = await ticketTask("Write then 500");
    const movesBefore = linear.apiCalls()["issueUpdate"] ?? 0;
    // Each of the three steps' first mutation commits on Linear and its answer is a 500.
    linear.injectFaults([{ kind: "fail-after-write" }, { kind: "fail-after-write" }, { kind: "fail-after-write" }]);
    await writeSteps(taskId);
    await waitFor("every ticket write done", () => writesDone(taskId), 180_000);
    oneOfEach(issueId, movesBefore);
    await stopAll();
  }, 300_000);

  it("GitHub opens the PR and answers 500: the retry finds it, and there's one PR", async () => {
    const replica = await startReplica(null);
    await runner.connect(replica.url);
    const task = await acceptedTask();
    github.failures.push({ pathPattern: /\/pulls$/, method: "POST", status: 500, afterWrite: true });
    await saveTurn(task, branchesUsed);
    await waitFor("the task in review", async () => (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "in_review", 180_000);
    expect(github.pulls.filter((pull) => pull.head === task.branch)).toHaveLength(1);
    expect(creates(task.branch)).toBe(1);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(1);
    await stopAll();
  }, 300_000);
});

describe.skipIf(enabled)("the failure suite's core cases", () => {
  it("run only in `pnpm e2e:m2:failures` (OSTRA_FAILURE_SUITE=1)", () => {
    expect(enabled).toBe(false);
  });
});
