import { randomBytes } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord, Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { acceptOffer, DEFAULT_ROUND_LIMITS, dispatchTask, jobKey, jobPayloadSchemas, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox } from "@ostra/domain";
import type { Clock, EnqueueOptions, JobName, JobPayload, JobQueue, RoundLimits, SessionTimers } from "@ostra/domain";
import { commandSeqSchema, gitShaSchema, leaseEpochSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, taskRepoIdSchema, turnIdSchema } from "@ostra/protocol";
import type { GitSha, RepoFullName, RepoId, RunnerId, TaskEvent, TaskRepoId } from "@ostra/protocol";

import { createBlobService } from "../blobs/blob-service.ts";
import type { BlobService } from "../blobs/blob-service.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { blobCiLogStore, ciEvaluateHandler } from "../review-loop/ci.ts";
import { reviewPostHandler, reviewStartHandler } from "../review-loop/review.ts";
import { roundStartHandler } from "../review-loop/rounds.ts";
import { reviewersRefreshHandler } from "../review-loop/reviewers.ts";
import { changesReopenHandler } from "../review-loop/changes-requested.ts";
import { reviewEvaluateHandler } from "../reactions/review-check.ts";
import { FakeCodeHost, FakeSecretStore } from "./fake-adapters.ts";
import { drive, jobContext } from "./turns.ts";
import type { DrivenTask } from "./turns.ts";
import { recordSessionModel, seedOnlineRunner, seedQueuedTask, seedWorld } from "./world.ts";
import type { QueuedTask, World } from "./world.ts";

// Milestone 6's review loop (tickets 16 to 18), against Postgres and the fake code host with its CI
// and comment-type reviews on: a code task in review on a runner at minor 5, its PRs open on the
// fake host, core's real ingest for the agent's turns, and the loop's jobs (`ci.evaluate`,
// `round.start`, `review.start`, `review.post`; ticket 19's `reviewers.refresh` and milestone 4's `review.evaluate`) run from a recorded queue by `drain`, so a test
// steps through the loop one job at a time. The clock is the test's.

export type LoopHarness = {
  readonly test: TestDatabase;
  readonly db: Db;
  readonly fixture: IsolationFixture;
  readonly world: World;
  readonly codeHost: FakeCodeHost;
  readonly secretStore: FakeSecretStore;
  readonly jobs: RecordingQueue;
  readonly blobs: BlobService;
  readonly ingest: Ingest;
  readonly runner: RunnerRef;
  readonly records: LogRecord[];
  readonly logger: Logger;
  readonly clock: Clock & { advance: (ms: number) => void };
  /** The round caps the `round.start` and `review.start` jobs run with; a test may change them. */
  limits: RoundLimits;
  /** Runs the recorded jobs of these names, in order, until none is left; returns the names run. */
  readonly drain: (names: readonly LoopJob[], options?: { readonly delayed?: boolean }) => Promise<readonly string[]>;
  readonly stop: () => Promise<void>;
};

export type LoopJob = "ci.evaluate" | "round.start" | "review.start" | "review.post" | "reviewers.refresh" | "review.evaluate" | "changes.reopen";

const loopJobs: readonly string[] = ["ci.evaluate", "round.start", "review.start", "review.post", "reviewers.refresh", "review.evaluate", "changes.reopen"] satisfies readonly LoopJob[];
const isLoopJob = (name: string): name is LoopJob => loopJobs.includes(name);

export type RecordedJob = { readonly job: JobName; readonly key: string; readonly payload: unknown; readonly options: EnqueueOptions | undefined };

/** A job queue that records what was enqueued, one job per key while it waits, as the real queue keeps it. */
export type RecordingQueue = JobQueue & { readonly jobs: RecordedJob[]; readonly record: <N extends JobName>(job: N, payload: JobPayload<N>, options?: EnqueueOptions) => void };

export const recordingQueue = (): RecordingQueue => {
  const jobs: RecordedJob[] = [];
  const record = <N extends JobName>(job: N, payload: JobPayload<N>, options?: EnqueueOptions): void => {
    const key = jobKey(job, payload);
    if (!jobs.some((existing) => existing.key === key)) {
      jobs.push({ job, key, payload, options });
    }
  };
  return {
    jobs,
    record,
    enqueueInTx: (_tx, job, payload, options) => {
      record(job, payload, options);
      return Promise.resolve();
    },
  };
};

export const REPO = repoFullNameSchema.parse("ostra-test/test1");
export const SECOND_REPO = repoFullNameSchema.parse("ostra-test/test2");
export const BASE_SHA = gitShaSchema.parse("b".repeat(40));

/** A fresh head, its compare on the fake host set, so a review can read its merge base. */
export const newHead = (codeHost: FakeCodeHost, repo: RepoFullName): GitSha => {
  const head = gitShaSchema.parse(randomBytes(20).toString("hex"));
  codeHost.setCompare(repo, head, { aheadBy: 1, behindBy: 0, mergeBase: BASE_SHA, files: [], filesTruncated: false, limits: { maxFiles: 300, maxPatchBytes: 1_000_000 } });
  return head;
};

export const startLoopHarness = async (options: { readonly codeHost?: FakeCodeHost } = {}): Promise<LoopHarness> => {
  const test = await createTestDatabase();
  const fixture = await seedIsolationFixture(test.db);
  const codeHost = options.codeHost ?? new FakeCodeHost();
  codeHost.reviewLoop = true;
  const secretStore = new FakeSecretStore();
  const world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const records: LogRecord[] = [];
  const logger = createLogger((record) => records.push(record));
  let now = Date.now();
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const jobs = recordingQueue();
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: () => Promise.resolve(false) };
  const liveText: LiveTextWriter = createLiveTextWriter({ db: test.db, logger });
  const ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock, liveText, logger, timers, outbox: postgresCommandOutbox, reviewLoop: codeHost.capabilities });
  const blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 4 * 1024 * 1024 }, context: { logger, clock } });
  const runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: await seedPool(test.db, fixture.a.organization.id, world) }, 20);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 5 } });
  // Priced, so the budget gate and the spend cap count money (F-037, F-068).
  const profile = await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId }, select: { modelId: true } });
  await test.db.model.updateMany({ where: { id: profile.modelId ?? "" }, data: { inputPricePerMTok: 3, outputPricePerMTok: 15 } });
  const adapters = { codeHost, secretStore };
  const ports = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock, timers };
  const harness: LoopHarness = {
    test,
    db: test.db,
    fixture,
    world,
    codeHost,
    secretStore,
    jobs,
    blobs,
    ingest,
    runner,
    records,
    logger,
    clock,
    limits: DEFAULT_ROUND_LIMITS,
    drain: async (names, drainOptions = {}) => {
      const ran: string[] = [];
      for (let guard = 0; guard < 200; guard += 1) {
        const index = jobs.jobs.findIndex(
          (job) => names.some((name) => name === job.job) && (drainOptions.delayed === true || (job.options?.startAfterMs ?? 0) <= 10_000),
        );
        const job = jobs.jobs[index];
        if (job === undefined) {
          return ran;
        }
        jobs.jobs.splice(index, 1);
        ran.push(job.job);
        if (isLoopJob(job.job)) {
          await runJob(job.job, job.payload);
        }
      }
      throw new Error("the loop's jobs never ran out");
    },
    stop: async () => {
      await liveText.stop();
      await test.dispose();
    },
  };
  const runJob = async (job: LoopJob, payload: unknown): Promise<void> => {
    switch (job) {
      case "ci.evaluate":
        await ciEvaluateHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock, adapters, logs: blobCiLogStore(blobs) })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      case "round.start":
        await roundStartHandler({ ...ports, limits: harness.limits, spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 } })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      case "review.start":
        await reviewStartHandler({ ...ports, adapters, limits: harness.limits })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      case "review.post":
        await reviewPostHandler({ ...ports, adapters })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      // Milestone 6 (ticket 19): the PR's reviewers, and milestone 4's check that keeps each one's review.
      case "reviewers.refresh":
        await reviewersRefreshHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock, adapters })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      // Milestone 6 (ticket 20): a linked member's "changes requested", with the harness's spend cap.
      case "changes.reopen":
        await changesReopenHandler({ ...ports, adapters, spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 } })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      case "review.evaluate":
        await reviewEvaluateHandler({ db: test.db, jobs, notices: postgresChangeNotices, clock, adapters })(jobContext(job, jobPayloadSchemas[job].parse(payload), logger));
        return;
      default:
        job satisfies never;
    }
  };
  return harness;
};

/** A pool the project uses, for the harness's runner. */
const seedPool = async (db: Db, organizationId: string, world: World): Promise<string> => {
  const pool = await db.runnerPool.create({ data: { organizationId, name: `pool-${randomBytes(3).toString("hex")}` } });
  await db.projectPool.create({ data: { organizationId, projectId: world.projectId, poolId: pool.id } });
  return pool.id;
};

export type LoopPr = { readonly repo: RepoFullName; readonly repoId: RepoId; readonly taskRepoId: TaskRepoId; readonly number: number; head: GitSha };

export type LoopTask = QueuedTask & {
  readonly prs: LoopPr[];
  readonly boxId: string;
  /** The coding agent's session on its warm box: its events go through core's real ingest. */
  driven: DrivenTask;
};

/** A second repo in the harness's project, on the fake host too. */
export const seedSecondRepo = async (h: LoopHarness): Promise<RepoId> => {
  const first = await h.db.repo.findUniqueOrThrow({ where: { id: h.world.repoId } });
  const existing = await h.db.repo.findFirst({ where: { projectId: h.world.projectId, fullName: SECOND_REPO } });
  if (existing !== null) return repoIdSchema.parse(existing.id);
  const repo = await h.db.repo.create({
    data: {
      organizationId: first.organizationId,
      projectId: first.projectId,
      connectionId: first.connectionId,
      installationId: first.installationId,
      hostRepoId: `host-${SECOND_REPO}`,
      fullName: SECOND_REPO,
      defaultBranch: "main",
      checkoutDir: "test2",
      position: 1,
    },
  });
  return repoIdSchema.parse(repo.id);
};

/**
 * A code task in review as its first turn leaves it with the review loop on: each repo's PR open on
 * the fake host at a head of its own, the task in "CI running", its session idle on a warm box
 * leased to the harness's minor-5 runner, and one `ci.evaluate` per PR recorded.
 */
export const seedTaskInCi = async (h: LoopHarness, options: { readonly repos?: 1 | 2 } = {}): Promise<LoopTask> => {
  const task = await seedQueuedTask(h.db, h.world, h.fixture.a.member, null);
  const row = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  if (options.repos === 2) {
    const second = await seedSecondRepo(h);
    await h.db.taskRepo.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId: row.id, repoId: second, branchName: row.branchName, baseBranch: "main" } });
  }
  const taskRepos = await h.db.taskRepo.findMany({ where: { taskId: task.taskId }, orderBy: { createdAt: "asc" }, include: { repo: true } });
  const app = h.codeHost.apps.keys().next().value ?? "";
  const prs: LoopPr[] = [];
  for (const taskRepo of taskRepos) {
    const repo = repoFullNameSchema.parse(taskRepo.repo.fullName);
    const opened = await h.codeHost.openPullRequest({
      access: { app: { appId: app, privateKey: h.codeHost.apps.get(app)?.privateKey ?? "" }, installationId: "777", repo },
      head: taskRepo.branchName,
      base: "main",
      title: "Add a short CONTRIBUTING.md",
      body: "Body.",
      draft: false,
    });
    if (!opened.ok) throw new Error("the fake host refused the PR");
    const head = newHead(h.codeHost, repo);
    h.codeHost.pushHead(repo, opened.value.number, head);
    await h.db.taskRepo.update({ where: { id: taskRepo.id }, data: { state: "pr_open", prNumber: opened.value.number, prUrl: opened.value.url, headSha: head, ahead: true } });
    await h.db.taskPullRequest.create({
      data: { organizationId: row.organizationId, projectId: row.projectId, taskRepoId: taskRepo.id, number: opened.value.number, url: opened.value.url, branchName: taskRepo.branchName, state: "open" },
    });
    prs.push({ repo, repoId: repoIdSchema.parse(taskRepo.repoId), taskRepoId: taskRepoIdSchema.parse(taskRepo.id), number: opened.value.number, head });
  }
  const box = await h.db.box.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId: row.id, runnerId: h.runner.runnerId, executor: "docker", state: "ready" } });
  await h.db.lease.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId: row.id, epoch: 1, runnerId: h.runner.runnerId, boxId: box.id, state: "active" } });
  await h.db.task.update({ where: { id: row.id }, data: { state: "in_review", subState: "ci_running", leaseEpoch: 1 } });
  await h.db.session.update({ where: { id: task.sessionId }, data: { boxId: box.id, state: "idle" } });
  await recordSessionModel(h.db, h.world, task.sessionId);
  for (const pr of prs) {
    h.jobs.record("ci.evaluate", { organizationId: task.organizationId, taskRepoId: pr.taskRepoId, headSha: pr.head });
  }
  return { ...task, prs, boxId: box.id, driven: drive(h.ingest, task, h.runner, 1) };
};

/** A check run on a PR's head from another app (or ostra's own, by its slug). */
export const checkRun = (
  h: LoopHarness,
  pr: LoopPr,
  name: string,
  outcome: "success" | "failure" | "in_progress",
  options: { readonly appSlug?: string; readonly log?: string; readonly head?: GitSha } = {},
): void => {
  h.codeHost.ci.addCheckRun(pr.repo, {
    headSha: options.head ?? pr.head,
    name,
    appSlug: options.appSlug ?? "github-actions",
    status: outcome === "in_progress" ? "in_progress" : "completed",
    conclusion: outcome === "in_progress" ? null : outcome,
    ...(options.log === undefined ? {} : { log: { text: options.log } }),
  });
};

/**
 * The coding agent's fixing turn on its session: it pushes a new head to each PR and its work is
 * saved, through core's real ingest. Returns the new heads, which the PRs now hold.
 */
export const agentPushes = async (h: LoopHarness, task: LoopTask): Promise<void> => {
  const { branchName } = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const turnId = turnIdSchema.parse(`turn-${randomBytes(3).toString("hex")}`);
  const events: TaskEvent[] = [{ kind: "turn.started", turnId }];
  for (const pr of task.prs) {
    pr.head = newHead(h.codeHost, pr.repo);
    h.codeHost.pushHead(pr.repo, pr.number, pr.head);
    events.push({ kind: "git.pushed", repoId: pr.repoId, branch: branchName, headSha: pr.head, ref: `refs/heads/${branchName}` });
  }
  events.push({ kind: "turn.ended", turnId, stopReason: "end_turn" });
  events.push({ kind: "session.saved", turnOrdinal: 1, repos: task.prs.map((pr) => ({ repoId: pr.repoId, headSha: pr.head, ahead: true, hiddenRefSha: null })), archive: null });
  await task.driven.send(...events);
};

/**
 * A fresh-box turn's new session (a round on a fresh box, or a reopen): its recorded dispatch run
 * through the domain's dispatch, accepted by the runner it chose, then its events go through ingest.
 */
export const followFreshSession = async (h: LoopHarness, task: LoopTask): Promise<{ readonly runnerId: RunnerId; readonly boxId: string; readonly automatic: boolean }> => {
  const session = await h.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  const index = h.jobs.jobs.findIndex((job) => job.job === "task.dispatch" && jobPayloadSchemas["task.dispatch"].parse(job.payload).sessionId === session.id);
  const recordedJob = h.jobs.jobs[index];
  if (recordedJob === undefined) throw new Error("the session has no dispatch");
  h.jobs.jobs.splice(index, 1);
  const payload = jobPayloadSchemas["task.dispatch"].parse(recordedJob.payload);
  const deps = { jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock };
  const offered = await h.db.$transaction((tx) => dispatchTask({ tx, ...deps }, payload));
  if (!offered.ok) throw new Error(`the dispatch failed: ${offered.message}`);
  const command = await h.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  const runner: RunnerRef = { runnerId: offered.runnerId, organizationId: task.organizationId };
  const accepted = await h.db.$transaction((tx) => acceptOffer({ tx, ...deps, logger: h.logger }, { runnerId: offered.runnerId, commandId: offered.commandId, seq: commandSeqSchema.parse(command.seq), result: "accepted" }));
  if (!accepted.ok) throw new Error(`the offer wasn't accepted: ${accepted.error}`);
  task.driven = drive(h.ingest, { ...task, sessionId: sessionIdSchema.parse(session.id) }, runner, offered.leaseEpoch);
  const body = command.body;
  return { runnerId: offered.runnerId, boxId: offered.boxId, automatic: typeof body === "object" && body !== null && !Array.isArray(body) && body["automatic"] === true };
};

/** The task's state and sub-state, as the panel reads them. */
export const stateOf = async (h: LoopHarness, taskId: string): Promise<string> => {
  const row = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
  return row.state === "in_review" ? `in_review/${row.subState ?? ""}` : row.state === "needs_you" ? `needs_you/${row.needsYouReason ?? ""}` : row.state;
};

/** The payloads of the jobs of a name the queue holds now. */
export const recorded = (h: LoopHarness, job: JobName): readonly unknown[] => h.jobs.jobs.filter((one) => one.job === job).map((one) => one.payload);

export const runnerIdOf = (h: LoopHarness): RunnerId => h.runner.runnerId;
export const leaseEpochOne = leaseEpochSchema.parse(1);
