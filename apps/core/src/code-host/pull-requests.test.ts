import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord, RepoAccess } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { jobPayloadSchemas, parseServerSettings, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, pullRequestsOutcome, systemClock } from "@ostra/domain";
import type { BoardMapping } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { connectionIdSchema, externalTicketIdSchema, releaseBodySchema, repoFullNameSchema, taskIdSchema, ticketKeySchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { boxReleaseHandler } from "../cleanup/cleanup.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedBoard, seedTicketRow, seedTrackerConnection } from "../testing/tickets.ts";
import { jobContext } from "../testing/turns.ts";
import { APP_ID, APP_PRIVATE_KEY, INSTALLATION_ID, seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { createReconcileSchedules, ensureBehindSchedule, githubWebhookHandler, reconcileHandler, reconcilePullRequests } from "./pull-requests.ts";
import type { PullRequestStateDeps } from "./pull-requests.ts";

// Ticket 16's cases, against the fake code host: a merge by webhook and by reconcile give the same
// result, once; a replayed delivery changes nothing, and a control handler without the state
// lookup acts twice (F-046, ADR 0037); closing every PR stops the task; one merged and one closed
// gives merged, in both orders; a reopened PR moves the repo back and the task to review; another
// organization's PR with the same number is untouched. Then, gated on github.env and
// github-test.env, a PR merged on test1 reaches its task through the reconcile alone.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
let world: World;
let otherWorld: World;
let githubA: ConnectionId;
let githubB: ConnectionId;
let boardId: BoardId;

const deps = (overrides: Partial<PullRequestStateDeps> = {}): PullRequestStateDeps => ({
  db: test.db,
  jobs,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: systemClock,
  codeHost,
  secretStore,
  logger,
  ...overrides,
});

const MAPPING: BoardMapping = { open: ["s-open"], started: "s-started", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes" };

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id);
  const connectionOf = async (organizationId: string): Promise<ConnectionId> =>
    connectionIdSchema.parse((await test.db.connection.findFirstOrThrow({ where: { organizationId, kind: "github" } })).id);
  githubA = await connectionOf(world.organizationId);
  githubB = await connectionOf(otherWorld.organizationId);
  const linear = await seedTrackerConnection(test.db, secretStore, world.organizationId);
  boardId = await seedBoard(test.db, { organizationId: world.organizationId, projectId: world.projectId, connectionId: linear, externalId: "team-1", mapping: MAPPING });
});

afterAll(async () => {
  await jobs.stop({ graceful: false });
  await test.dispose();
});

type Seeded = { readonly taskId: TaskId; readonly prs: readonly { readonly repo: string; readonly number: number }[] };

/** A ticket task in review with a PR open on each of `repoCount` repos, and a box on a runner. */
const taskInReview = async (target: World, repoCount: number): Promise<Seeded> => {
  const organizationId: OrganizationId = target.organizationId;
  const projectId: ProjectId = target.projectId;
  const repoIds = [target.repoId];
  const base = await test.db.repo.findUniqueOrThrow({ where: { id: target.repoId } });
  for (let index = 1; index < repoCount; index += 1) {
    const fullName = `ostra-test/extra-${randomUUID().slice(0, 6)}`;
    await seedInstallation(test.db, { organizationId, connectionId: base.connectionId, installationId: INSTALLATION_ID });
    const repo = await test.db.repo.create({
      data: { organizationId, projectId, connectionId: base.connectionId, installationId: INSTALLATION_ID, hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", checkoutDir: fullName.split("/")[1] ?? "x" },
    });
    repoIds.push(repo.id);
  }
  const isA = organizationId === world.organizationId;
  const ticketId = isA
    ? await seedTicketRow(test.db, {
        organizationId,
        projectId,
        boardId,
        connectionId: connectionIdSchema.parse((await test.db.board.findUniqueOrThrow({ where: { id: boardId } })).connectionId),
        ticket: {
          externalId: externalTicketIdSchema.parse(randomUUID()),
          key: ticketKeySchema.parse(`OST-${String(Math.floor(Math.random() * 1e6))}`),
          title: "Fix it",
          description: null,
          status: { id: "s-review", name: "In Review", category: "started" },
          url: "https://linear.example/OST-1",
          priority: null,
          parentKey: null,
          parentExternalId: null,
          labels: [],
          updatedAt: Date.now(),
        },
      })
    : null;
  const branch = `ostra/${randomUUID().slice(0, 8)}-fix-it`;
  const task = await test.db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: ticketId === null ? "prompt" : "ticket",
      title: "Fix it",
      prompt: ticketId === null ? "Fix it" : null,
      branchName: branch,
      state: "in_review",
      subState: "waiting_for_reviewer",
      ...(ticketId === null ? {} : { ticketId, boardId, ticketKey: "OST-1" }),
    },
  });
  const prs: { repo: string; number: number }[] = [];
  for (const repoId of repoIds) {
    const repo = await test.db.repo.findUniqueOrThrow({ where: { id: repoId } });
    const access: RepoAccess = { app: { appId: APP_ID, privateKey: APP_PRIVATE_KEY }, installationId: INSTALLATION_ID, repo: repoFullNameSchema.parse(repo.fullName) };
    const opened = await codeHost.openPullRequest({ access, head: branch, base: "main", title: "Fix it", body: "", draft: false });
    if (!opened.ok) throw new Error(opened.error.message);
    await test.db.taskRepo.create({
      data: { organizationId, projectId, taskId: task.id, repoId, branchName: branch, baseBranch: "main", state: "pr_open", prNumber: opened.value.number, prUrl: opened.value.url },
    });
    prs.push({ repo: repo.fullName, number: opened.value.number });
  }
  const runner = await seedOnlineRunner(test.db, organizationId, { kind: "personal", memberId: isA ? fixture.a.admin.id : fixture.b.admin.id });
  await test.db.box.create({ data: { organizationId, projectId, taskId: task.id, runnerId: runner.runnerId, executor: "host", state: "idle" } });
  return { taskId: taskIdSchema.parse(task.id), prs };
};

const deliver = async (connectionId: ConnectionId, organizationId: OrganizationId, pr: { readonly repo: string; readonly number: number }, action: string, deliveryId = randomUUID()) => {
  const delivery = codeHost.pullRequestDelivery(pr.repo, pr.number, action, { deliveryId });
  const payload: unknown = JSON.parse(delivery.body);
  const context: WebhookDeliveryContext = {
    organizationId,
    connectionId,
    deliveryId: webhookDeliveryIdSchema.parse(deliveryId),
    event: "pull_request",
    payload,
    receivedAt: Date.now(),
    logger,
  };
  return { outcome: await githubWebhookHandler(deps())(context), context };
};

const stateOf = async (taskId: TaskId) => {
  const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const repos = await test.db.taskRepo.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
  return { state: task.state, stoppedReason: task.stoppedReason, repos: repos.map((repo) => repo.state) };
};
const releases = (taskId: TaskId) => test.db.$queryRaw<readonly unknown[]>`SELECT id FROM pgboss.job WHERE name = 'box.release' AND data->>'taskId' = ${taskId}`;
const doneWrites = (taskId: TaskId) => test.db.ticketWrite.count({ where: { taskId, kind: "move", idempotencyKey: { endsWith: ":move:done" } } });

describe("the Q107 rule", () => {
  it("follows the set of a task's PRs, whatever order they ended in", () => {
    expect(pullRequestsOutcome([{ state: "pr_open" }, { state: "merged" }])).toBe("in-review");
    expect(pullRequestsOutcome([{ state: "merged" }, { state: "closed_unmerged" }])).toBe("merged");
    expect(pullRequestsOutcome([{ state: "closed_unmerged" }, { state: "closed_unmerged" }])).toBe("stopped");
    expect(pullRequestsOutcome([{ state: "branch_pushed" }])).toBe("no-pr");
  });
});

describe("the box's release (F-079)", () => {
  /** The `box.release` jobs the webhooks left for the task, as the queue holds them. */
  const releaseJobs = async (taskId: TaskId) =>
    z
      .array(z.object({ data: z.unknown() }))
      .parse(await test.db.$queryRaw`SELECT data FROM pgboss.job WHERE name = 'box.release' AND data->>'taskId' = ${taskId}`)
      .map((row) => jobPayloadSchemas["box.release"].parse(row.data));

  /** Runs those jobs as core's worker does, and returns the `release` commands the task's runner gets. */
  const runReleases = async (taskId: TaskId) => {
    const cleanup = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore }, logger, retentionDays: null, releaseAfterIdleMs: 14 * 86_400_000 };
    for (const payload of await releaseJobs(taskId)) {
      await boxReleaseHandler(cleanup)(jobContext("box.release", payload, logger));
    }
    const boxIds = new Set((await test.db.box.findMany({ where: { taskId }, select: { id: true } })).map((box) => box.id));
    return (await test.db.command.findMany({ where: { kind: "release" }, orderBy: { seq: "asc" } })).map((row) => releaseBodySchema.parse(row.body)).filter((body) => boxIds.has(body.boxId));
  };

  const boxOf = (taskId: TaskId) => test.db.box.findFirstOrThrow({ where: { taskId } });

  /** A task in review whose box's runner speaks protocol minor 1, which takes `release`. */
  const inReviewOnMinorOne = async (repoCount: number): Promise<Seeded> => {
    const seeded = await taskInReview(world, repoCount);
    const { runnerId } = await boxOf(seeded.taskId);
    await test.db.runnerPresence.updateMany({ where: { runnerId: runnerId ?? "" }, data: { minor: 1 } });
    return seeded;
  };

  it("F-079/c1: a task's box is released when its last PR merges or closes, and not while one is still open", async () => {
    // Two PRs: the first merge leaves the box, the last one releases it.
    const merged = await inReviewOnMinorOne(2);
    const [first, second] = merged.prs;
    if (first === undefined || second === undefined) throw new Error("no PRs");
    codeHost.changePull(first.repo, first.number, "merge");
    await deliver(githubA, world.organizationId, first, "closed");
    expect(await releaseJobs(merged.taskId)).toEqual([]);
    expect(await runReleases(merged.taskId)).toEqual([]);
    expect(await boxOf(merged.taskId)).toMatchObject({ state: "idle" });
    codeHost.changePull(second.repo, second.number, "merge");
    await deliver(githubA, world.organizationId, second, "closed");
    const mergedBox = await boxOf(merged.taskId);
    expect(await runReleases(merged.taskId)).toEqual([{ taskId: merged.taskId, boxId: mergedBox.id, reason: "prs-closed" }]);
    expect(await boxOf(merged.taskId)).toMatchObject({ state: "released", releaseReason: "prs_closed" });

    // Every PR closed unmerged: the same release.
    const closed = await inReviewOnMinorOne(2);
    for (const pr of closed.prs) {
      expect(await releaseJobs(closed.taskId)).toEqual([]);
      codeHost.changePull(pr.repo, pr.number, "close");
      await deliver(githubA, world.organizationId, pr, "closed");
    }
    const closedBox = await boxOf(closed.taskId);
    expect(await runReleases(closed.taskId)).toEqual([{ taskId: closed.taskId, boxId: closedBox.id, reason: "prs-closed" }]);
    expect(await boxOf(closed.taskId)).toMatchObject({ state: "released", releaseReason: "prs_closed" });
    // A replayed close releases nothing twice.
    const [last] = closed.prs.slice(-1);
    if (last === undefined) throw new Error("no PR");
    await deliver(githubA, world.organizationId, last, "closed");
    expect(await runReleases(closed.taskId)).toHaveLength(1);
  });
});

describe("PR states", () => {
  it("a merge by webhook and by the reconcile give the same result, once", async () => {
    for (const first of ["webhook", "reconcile"] as const) {
      const seeded = await taskInReview(world, 1);
      const [pr] = seeded.prs;
      if (pr === undefined) throw new Error("no PR");
      codeHost.changePull(pr.repo, pr.number, "merge");
      if (first === "webhook") {
        expect((await deliver(githubA, world.organizationId, pr, "closed")).outcome).toEqual({ outcome: "processed" });
        expect(await reconcilePullRequests(deps(), { organizationId: world.organizationId, connectionId: githubA })).toMatchObject({ stoppedEarly: null });
      } else {
        await reconcilePullRequests(deps(), { organizationId: world.organizationId, connectionId: githubA });
        await deliver(githubA, world.organizationId, pr, "closed");
      }
      expect(await stateOf(seeded.taskId)).toEqual({ state: "merged", stoppedReason: null, repos: ["merged"] });
      expect(await doneWrites(seeded.taskId)).toBe(1);
      expect(await releases(seeded.taskId)).toHaveLength(1);
      expect(await test.db.auditEntry.count({ where: { entityId: seeded.taskId, action: "pr.merged" } })).toBe(1);
    }
  });

  it("F-046/c1: a replayed delivery changes nothing, and a control handler without the state lookup acts twice", async () => {
    const seeded = await taskInReview(world, 1);
    const [pr] = seeded.prs;
    if (pr === undefined) throw new Error("no PR");
    codeHost.changePull(pr.repo, pr.number, "merge");
    const deliveryId = randomUUID();
    await deliver(githubA, world.organizationId, pr, "closed", deliveryId);
    await deliver(githubA, world.organizationId, pr, "closed", deliveryId);
    await deliver(githubA, world.organizationId, pr, "closed");
    expect(await test.db.auditEntry.count({ where: { entityId: seeded.taskId, action: "pr.merged" } })).toBe(1);
    expect(await doneWrites(seeded.taskId)).toBe(1);
    expect(await test.db.ticketWrite.count({ where: { taskId: seeded.taskId, kind: "comment_update" } })).toBe(2);

    // The control: acts on every delivery it's handed, without looking at what's recorded.
    const control = await taskInReview(world, 1);
    const [controlPr] = control.prs;
    if (controlPr === undefined) throw new Error("no PR");
    const naive = async (): Promise<void> => {
      await test.db.$transaction(async (tx) => {
        await postgresAuditLog.recordInTx(tx, { organizationId: world.organizationId, projectId: world.projectId, actor: { kind: "system", id: null }, action: "pr.merged", entity: "task", entityId: control.taskId });
      });
    };
    await naive();
    await naive();
    expect(await test.db.auditEntry.count({ where: { entityId: control.taskId, action: "pr.merged" } })).toBe(2);
  });

  it("closing every PR stops the task as prs_closed, and releases its box", async () => {
    const seeded = await taskInReview(world, 2);
    for (const pr of seeded.prs) {
      codeHost.changePull(pr.repo, pr.number, "close");
      await deliver(githubA, world.organizationId, pr, "closed");
    }
    expect(await stateOf(seeded.taskId)).toEqual({ state: "stopped", stoppedReason: "prs_closed", repos: ["closed_unmerged", "closed_unmerged"] });
    expect(await releases(seeded.taskId)).toHaveLength(1);
    expect(await doneWrites(seeded.taskId)).toBe(0);
  });

  it("one PR merged and one closed unmerged gives merged, in both orders", async () => {
    for (const order of [["merge", "close"], ["close", "merge"]] as const) {
      const seeded = await taskInReview(world, 2);
      const [first, second] = seeded.prs;
      if (first === undefined || second === undefined) throw new Error("no PRs");
      codeHost.changePull(first.repo, first.number, order[0]);
      await deliver(githubA, world.organizationId, first, "closed");
      expect((await stateOf(seeded.taskId)).state).toBe("in_review");
      codeHost.changePull(second.repo, second.number, order[1]);
      await deliver(githubA, world.organizationId, second, "closed");
      const state = await stateOf(seeded.taskId);
      expect(state.state).toBe("merged");
      expect([...state.repos].sort()).toEqual(["closed_unmerged", "merged"]);
    }
  });

  it("a reopened PR moves its repo back to open, and the stopped task back to review", async () => {
    const seeded = await taskInReview(world, 1);
    const [pr] = seeded.prs;
    if (pr === undefined) throw new Error("no PR");
    codeHost.changePull(pr.repo, pr.number, "close");
    await deliver(githubA, world.organizationId, pr, "closed");
    expect((await stateOf(seeded.taskId)).state).toBe("stopped");
    codeHost.changePull(pr.repo, pr.number, "reopen");
    await deliver(githubA, world.organizationId, pr, "reopened");
    expect(await stateOf(seeded.taskId)).toEqual({ state: "in_review", stoppedReason: null, repos: ["pr_open"] });
    const task = await test.db.task.findUniqueOrThrow({ where: { id: seeded.taskId } });
    expect(task.subState).toBe("waiting_for_reviewer");
    // A report older than the close changes nothing: stale, ignored.
    const late = await deliver(githubA, world.organizationId, pr, "synchronize");
    expect(late.outcome.outcome).toBe("processed");
  });

  it("F-108/c2: the PR's own row follows a merge, a close and a reopen, with its time, for Insights", async () => {
    const seeded = await taskInReview(world, 2);
    const repos = await test.db.taskRepo.findMany({ where: { taskId: seeded.taskId }, orderBy: { createdAt: "asc" } });
    for (const repo of repos) {
      if (repo.prNumber === null) throw new Error("no PR number");
      await test.db.taskPullRequest.create({
        data: { organizationId: repo.organizationId, projectId: repo.projectId, taskRepoId: repo.id, number: repo.prNumber, url: repo.prUrl ?? "", branchName: repo.branchName },
      });
    }
    const rows = () => test.db.taskPullRequest.findMany({ where: { taskRepoId: { in: repos.map((repo) => repo.id) } }, orderBy: { createdAt: "asc" } });
    const [merged, closed] = seeded.prs;
    if (merged === undefined || closed === undefined) throw new Error("no PRs");
    codeHost.changePull(merged.repo, merged.number, "merge");
    await deliver(githubA, world.organizationId, merged, "closed");
    codeHost.changePull(closed.repo, closed.number, "close");
    await deliver(githubA, world.organizationId, closed, "closed");
    const after = await rows();
    expect(after.map((row) => row.state)).toEqual(["merged", "closed_unmerged"]);
    expect(after.every((row) => row.closedAt !== null)).toBe(true);
    codeHost.changePull(closed.repo, closed.number, "reopen");
    await deliver(githubA, world.organizationId, closed, "reopened");
    const reopened = await rows();
    expect(reopened.map((row) => row.state)).toEqual(["merged", "open"]);
    expect(reopened[1]?.closedAt).toBeNull();
  });

  it("another organization's PR with the same number is untouched", async () => {
    const ours = await taskInReview(world, 1);
    const theirs = await taskInReview(otherWorld, 1);
    const [ourPr] = ours.prs;
    const [theirPr] = theirs.prs;
    if (ourPr === undefined || theirPr === undefined) throw new Error("no PRs");
    codeHost.changePull(theirPr.repo, theirPr.number, "merge");
    // Organization B's delivery, as if it came on organization A's connection: A has no such task repo.
    const crossed = codeHost.pullRequestDelivery(theirPr.repo, theirPr.number, "closed", { hostRepoId: `host-${theirPr.repo}` });
    const payload: unknown = JSON.parse(crossed.body);
    await githubWebhookHandler(deps())({ organizationId: world.organizationId, connectionId: githubA, deliveryId: webhookDeliveryIdSchema.parse(randomUUID()), event: "pull_request", payload, receivedAt: Date.now(), logger });
    expect((await stateOf(ours.taskId)).state).toBe("in_review");
    // On its own connection, only B's task moves.
    await deliver(githubB, otherWorld.organizationId, theirPr, "closed");
    expect((await stateOf(theirs.taskId)).state).toBe("merged");
    expect((await stateOf(ours.taskId)).state).toBe("in_review");
  });

  it("ignores a PR the App didn't open for a task, and an event that isn't a PR's", async () => {
    const stray = { repo: "ostra-test/test1", number: 9999 };
    expect((await deliver(githubA, world.organizationId, stray, "closed")).outcome).toMatchObject({ outcome: "ignored" });
    const ping = await githubWebhookHandler(deps())({ organizationId: world.organizationId, connectionId: githubA, deliveryId: webhookDeliveryIdSchema.parse(randomUUID()), event: "ping", payload: { zen: "hi" }, receivedAt: Date.now(), logger });
    expect(ping.outcome).toBe("ignored");
  });

  it("the reconcile reads only open PRs, stops at the App's rate limit, and has a schedule per connection", async () => {
    const seeded = await taskInReview(world, 1);
    const reads = codeHost.prReads.length;
    await reconcilePullRequests(deps(), { organizationId: world.organizationId, connectionId: githubA });
    const open = await test.db.taskRepo.count({ where: { organizationId: world.organizationId, state: "pr_open" } });
    expect(codeHost.prReads.length - reads).toBe(open);
    expect((await stateOf(seeded.taskId)).state).toBe("in_review");
    const scheduled: string[] = [];
    await createReconcileSchedules({
      db: test.db,
      jobs: {
        schedule: (_job, key) => {
          scheduled.push(key);
          return Promise.resolve();
        },
      },
      reconcileMinutes: 5,
    }).ensure();
    expect(scheduled).toEqual(expect.arrayContaining([githubA, githubB]));
  });

  it("F-044/c1: with no webhook, a merge and a close reach their tasks by the reconcile, which runs every 5 minutes by default", async () => {
    // A fresh install's settings, and the schedules core makes from them, read back from pg-boss.
    const parsed = parseServerSettings({});
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.settings.reconcileMinutes).toBe(5);
    await createReconcileSchedules({ db: test.db, jobs, reconcileMinutes: parsed.settings.reconcileMinutes }).ensure();
    await ensureBehindSchedule({ jobs, reconcileMinutes: parsed.settings.reconcileMinutes });
    const schedules = z
      .array(z.object({ name: z.string(), key: z.string(), cron: z.string() }))
      .parse(await test.db.$queryRaw`SELECT name, key, cron FROM pgboss.schedule WHERE name IN ('github.reconcile-prs', 'task.reconcile-behind') ORDER BY name, key`);
    expect(schedules).toEqual(
      expect.arrayContaining([
        { name: "github.reconcile-prs", key: githubA, cron: "*/5 * * * *" },
        { name: "github.reconcile-prs", key: githubB, cron: "*/5 * * * *" },
        { name: "task.reconcile-behind", key: "all", cron: "*/5 * * * *" },
      ]),
    );

    // GitHub sends nothing: one task's PR merges, another's closes, and the next tick moves both.
    const merging = await taskInReview(world, 1);
    const closing = await taskInReview(world, 1);
    const [merged] = merging.prs;
    const [closed] = closing.prs;
    if (merged === undefined || closed === undefined) throw new Error("no PR");
    codeHost.changePull(merged.repo, merged.number, "merge");
    codeHost.changePull(closed.repo, closed.number, "close");
    const deliveries = await test.db.webhookDelivery.count({ where: { connectionId: githubA } });
    await reconcileHandler(deps())(jobContext("github.reconcile-prs", { organizationId: world.organizationId, connectionId: githubA }, logger));
    expect(await stateOf(merging.taskId)).toEqual({ state: "merged", stoppedReason: null, repos: ["merged"] });
    expect(await stateOf(closing.taskId)).toEqual({ state: "stopped", stoppedReason: "prs_closed", repos: ["closed_unmerged"] });
    expect(await test.db.auditEntry.count({ where: { entityId: merging.taskId, action: "pr.merged" } })).toBe(1);
    expect(await test.db.webhookDelivery.count({ where: { connectionId: githubA } })).toBe(deliveries);
    // The next tick finds nothing more to change.
    await reconcileHandler(deps())(jobContext("github.reconcile-prs", { organizationId: world.organizationId, connectionId: githubA }, logger));
    expect(await test.db.auditEntry.count({ where: { entityId: merging.taskId, action: "pr.merged" } })).toBe(1);
    expect(await doneWrites(merging.taskId)).toBe(1);
  });

  it("F-044/c1: with no webhook, a closed PR reopened on GitHub reaches its task within one tick, a stopped task's and a merged task's sibling alike", async () => {
    // A host that reads its open PRs for the reconcile (F-044, Q344), as the GitHub adapter does.
    codeHost.reconcileReads = true;
    const tick = () => reconcileHandler(deps())(jobContext("github.reconcile-prs", { organizationId: world.organizationId, connectionId: githubA }, logger));
    const reopenedBy = async (taskId: TaskId) =>
      (await test.db.auditEntry.findMany({ where: { entityId: taskId, action: "pr.reopened" }, select: { data: true } })).map((row) => z.looseObject({ source: z.string() }).parse(row.data).source);
    try {
      // Every PR closed: the task stops as prs_closed, by the reconcile too.
      const stopped = await taskInReview(world, 1);
      const [closed] = stopped.prs;
      // One PR merged and the other closed: the task is merged.
      const merged = await taskInReview(world, 2);
      const [mergedPr, sibling] = merged.prs;
      if (closed === undefined || mergedPr === undefined || sibling === undefined) throw new Error("no PRs");
      codeHost.changePull(closed.repo, closed.number, "close");
      codeHost.changePull(mergedPr.repo, mergedPr.number, "merge");
      codeHost.changePull(sibling.repo, sibling.number, "close");
      await tick();
      expect(await stateOf(stopped.taskId)).toEqual({ state: "stopped", stoppedReason: "prs_closed", repos: ["closed_unmerged"] });
      expect((await stateOf(merged.taskId)).state).toBe("merged");

      // GitHub sends nothing: both closed PRs are reopened, and the next tick moves both tasks back to review.
      const deliveries = await test.db.webhookDelivery.count({ where: { connectionId: githubA } });
      const listed = codeHost.openPullReads.length;
      codeHost.changePull(closed.repo, closed.number, "reopen");
      codeHost.changePull(sibling.repo, sibling.number, "reopen");
      await tick();
      expect(await stateOf(stopped.taskId)).toEqual({ state: "in_review", stoppedReason: null, repos: ["pr_open"] });
      expect((await test.db.task.findUniqueOrThrow({ where: { id: stopped.taskId } })).subState).toBe("waiting_for_reviewer");
      expect(await stateOf(merged.taskId)).toMatchObject({ state: "in_review", stoppedReason: null });
      expect([...(await stateOf(merged.taskId)).repos].sort()).toEqual(["merged", "pr_open"]);
      expect(await reopenedBy(stopped.taskId)).toEqual(["reconcile"]);
      expect(await reopenedBy(merged.taskId)).toEqual(["reconcile"]);
      // One read of each repo's open PRs, not one per closed PR; and the inbox holds nothing new.
      const reads = codeHost.openPullReads.slice(listed);
      expect(reads.filter((read) => read.repo === closed.repo)).toHaveLength(1);
      expect(new Set(reads.map((read) => read.repo)).size).toBe(reads.length);
      expect(await test.db.webhookDelivery.count({ where: { connectionId: githubA } })).toBe(deliveries);

      // The next tick finds nothing more to change.
      await tick();
      expect(await reopenedBy(stopped.taskId)).toEqual(["reconcile"]);
      expect(await reopenedBy(merged.taskId)).toEqual(["reconcile"]);
    } finally {
      codeHost.reconcileReads = false;
    }
  });
});

// ---------- live, gated on github.env and github-test.env ----------

const live = {
  appId: process.env["GITHUB_APP_ID"],
  keyPath: process.env["GITHUB_APP_PRIVATE_KEY_PATH"],
  installationId: process.env["GITHUB_APP_INSTALLATION_ID"],
  org: process.env["GITHUB_TEST_ORG"],
  repo: process.env["GITHUB_TEST_REPO"],
};

describe.skipIf(Object.values(live).some((value) => value === undefined || value === ""))("live: a PR merged on test1", () => {
  it("moves its task to merged through the reconcile, with no webhook", { timeout: 300_000 }, async () => {
    const github = new GitHubAdapter({ userAgent: "ostra-core-test" }, { logger, clock: adapterClock });
    const privateKey = await readFile(live.keyPath ?? "", "utf8");
    const fullName = repoFullNameSchema.parse(`${live.org ?? ""}/${live.repo ?? ""}`);
    const access: RepoAccess = { app: { appId: live.appId ?? "", privateKey }, installationId: live.installationId ?? "", repo: fullName };
    const minted = await github.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!minted.ok) throw new Error(minted.error.code);
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`https://api.github.com/repos/${fullName}${path}`, {
        method,
        headers: { authorization: `Bearer ${minted.value.token}`, accept: "application/vnd.github+json", "user-agent": "ostra-core-test" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} to ${method} ${path.split("?")[0] ?? ""}`);
      return response.status === 204 ? null : response.json();
    };
    const repoInfo = await api("GET", "");
    const hostRepoId = String(Reflect.get(Object(repoInfo), "id"));
    const main = await api("GET", "/git/ref/heads/main");
    const sha = String(Reflect.get(Object(Reflect.get(Object(main), "object")), "sha"));
    const branch = `ostra/live-reconcile-${randomUUID().slice(0, 8)}`;
    await api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
    try {
      await api("PUT", `/contents/ostra-live/reconcile-${branch.slice(-8)}.md`, {
        message: "ostra live reconcile test",
        content: Buffer.from("A file the reconcile test merges.\n").toString("base64"),
        branch,
      });
      const opened = await github.openPullRequest({ access, head: branch, base: "main", title: "ostra live reconcile test", body: "Merged by ostra's test of the reconcile.", draft: false });
      if (!opened.ok) throw new Error(opened.error.code);
      // The task, on a connection holding the real App's key.
      const keyRef = await secretStore.put({ organizationId: fixture.b.organization.id, purpose: "github-app.private-key" }, privateKey);
      if (!keyRef.ok) throw new Error("refused");
      // Organization B's App connection and repo, pointed at the real App's key and test1's ID.
      const connection = await test.db.connection.update({ where: { id: githubB }, data: { appId: live.appId ?? "", privateKeySecretRef: keyRef.value } });
      await seedInstallation(test.db, { organizationId: fixture.b.organization.id, connectionId: githubB, installationId: live.installationId ?? "" });
      const repo = await test.db.repo.update({ where: { id: otherWorld.repoId }, data: { installationId: live.installationId ?? "", hostRepoId, fullName } });
      const task = await test.db.task.create({
        data: { organizationId: fixture.b.organization.id, projectId: fixture.b.project.id, kind: "code", source: "prompt", title: "live", prompt: "live", branchName: branch, state: "in_review", subState: "waiting_for_reviewer" },
      });
      await test.db.taskRepo.create({
        data: { organizationId: fixture.b.organization.id, projectId: fixture.b.project.id, taskId: task.id, repoId: repo.id, branchName: branch, baseBranch: "main", state: "pr_open", prNumber: opened.value.number, prUrl: opened.value.url },
      });
      await api("PUT", `/pulls/${String(opened.value.number)}/merge`, { merge_method: "squash" });
      const started = Date.now();
      const liveDeps = deps({ codeHost: github });
      let state = "in_review";
      while (state !== "merged" && Date.now() - started < 5 * 60_000) {
        await reconcilePullRequests(liveDeps, { organizationId: fixture.b.organization.id, connectionId: connectionIdSchema.parse(connection.id) });
        state = (await test.db.task.findUniqueOrThrow({ where: { id: task.id } })).state;
        if (state !== "merged") await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      expect(state).toBe("merged");
      expect(Date.now() - started).toBeLessThan(5 * 60_000);
    } finally {
      await api("DELETE", `/git/refs/heads/${branch}`).catch(() => undefined);
    }
  });
});
