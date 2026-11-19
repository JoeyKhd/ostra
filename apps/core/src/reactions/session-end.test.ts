import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { createPromptTask, dispatchTask, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, stopTask, systemClock } from "@ostra/domain";
import type { JobName, JobPayload, MemberScope } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import {
  branchNameSchema,
  commandIdSchema,
  gitShaSchema,
  organizationIdSchema,
  projectIdSchema,
  repoFullNameSchema,
  repoIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  taskIdSchema,
  taskSeqSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { EventsFrame, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyOfferResultsInTx } from "../dispatch/dispatcher.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { applyStopResultsInTx, CODE_HOST_FAILED, openPullRequestsHandler, sessionEndedHandler } from "./session-end.ts";
import type { ReactionDeps } from "./session-end.ts";

// Ticket 27's cases against the fake code host, and the gated live run on ostra-test/test1.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let deps: ReactionDeps;
let runner: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");

const context = <N extends JobName>(job: N, payload: JobPayload<N>): JobContext<N> => ({
  job,
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  retryCount: 0,
  payload,
  logger,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger });
  deps = {
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
    publicUrl: "http://localhost:3000",
    logger,
  };
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 8);
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

/** A task taken as far as running: dispatched, accepted, its turn started. */
const runningTask = async (): Promise<QueuedTask & { readonly next: () => number }> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const offered = await test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, dispatchPayload(task)),
  );
  if (!offered.ok) {
    throw new Error(`dispatch failed: ${offered.message}`);
  }
  const command = await test.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  await test.db.$transaction((tx) =>
    applyOfferResultsInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, runner, [{ commandId: offered.commandId, seq: command.seq, kind: "dispatch", body: command.body, taskId: task.taskId, result: "accepted", reason: null }]),
  );
  let seq = 0;
  const next = (): number => {
    seq += 1;
    return seq;
  };
  await send(task, next, { kind: "turn.started", turnId });
  expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
  return { ...task, next };
};

const send = async (task: QueuedTask, next: () => number, ...events: TaskEvent[]): Promise<void> => {
  const frame: EventsFrame = {
    type: "events",
    events: events.map((event) => ({ sessionId: task.sessionId, sessionSeq: next(), leaseEpoch: 1, at: Date.now(), event })),
  };
  const replies = await ingest(runner, frame);
  expect(replies.every((reply) => reply.type === "ack" && reply.resendFrom === undefined)).toBe(true);
};

/** Runs the `task.session-ended` reaction for the task's stored `session.ended`. */
const reactToEnd = async (task: QueuedTask): Promise<void> => {
  const ended = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.ended" } });
  await sessionEndedHandler(deps)(context("task.session-ended", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: ended.seq }));
};

const openPrs = async (task: QueuedTask): Promise<void> => {
  const ended = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.ended" } });
  await openPullRequestsHandler(deps)(context("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: ended.seq }));
};

const theRepo = (): RepoId => repoIdSchema.parse(world.repoId);

describe("a session that ends with changes", () => {
  it("F-030, F-078: opens one PR per changed repo, once, even when the job runs twice, and the task goes to review", async () => {
    const task = await runningTask();
    await send(
      task,
      task.next,
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I added CONTRIBUTING.md." },
      { kind: "pr.text_set", repoId: theRepo(), title: "ignored: the title comes from the prompt", body: "## What\nAdds CONTRIBUTING.md.\n\n## Why\nSo people can run the tests." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: theRepo(), ahead: true }] },
    );
    await reactToEnd(task);
    const job = await jobs.find("task.open-pull-requests", {
      organizationId: task.organizationId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      eventSeq: (await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.ended" } })).seq,
    });
    expect(job).toHaveLength(1);
    // The host is down once: the job fails and is retried.
    codeHost.failOpens = 1;
    await expect(openPrs(task)).rejects.toThrow(CODE_HOST_FAILED);
    const before = codeHost.pulls.length;
    // Then the host opens it and the answer is lost: the job dies between the PR's creation and its
    // row's update, and its retry finds the open PR on the host instead of opening another.
    codeHost.loseOpenAnswers = 1;
    await expect(openPrs(task)).rejects.toThrow(CODE_HOST_FAILED);
    expect(codeHost.pulls.length).toBe(before + 1);
    await openPrs(task);
    await openPrs(task);
    const pulls = codeHost.pulls.slice(before);
    expect(pulls).toHaveLength(1);
    const [pull] = pulls;
    expect(pull?.title).toBe("Add a short CONTRIBUTING.md");
    expect(pull?.body).toContain("Adds CONTRIBUTING.md.");
    expect(pull?.body).toContain(`http://localhost:3000/tasks/${task.taskId}`);
    expect(pull?.baseBranch).toBe("main");
    const taskRow = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(taskRow).toMatchObject({ state: "in_review", subState: "waiting_for_reviewer" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", prNumber: pull?.number, prUrl: pull?.url, ahead: true });
    const opened = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.opened" } });
    expect(opened).toHaveLength(1);
    expect(await test.db.auditEntry.count({ where: { entityId: task.taskId, action: "pr.opened" } })).toBe(1);
    // The session ended with changes, the lease and the box went.
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "ended", outcome: "with_changes" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "released" });
    // The reaction run twice changes nothing more.
    await reactToEnd(task);
    expect(await jobs.find("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: opened[0]?.seq ?? 0 })).toHaveLength(0);
  });
});

describe("a task with several repos", () => {
  it("F-030: opens one PR for each repo the task changed and none for the one it didn't, each body linking the task and its other PRs", async () => {
    const task = await runningTask();
    const first = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const suffix = randomBytes(3).toString("hex");
    const addRepo = async (name: string): Promise<RepoId> => {
      const fullName = `ostra-test/${name}-${suffix}`;
      const repo = await test.db.repo.create({
        data: {
          organizationId: first.organizationId,
          projectId: first.projectId,
          connectionId: first.connectionId,
          installationId: first.installationId,
          hostRepoId: `host-${fullName}`,
          fullName,
          defaultBranch: "main",
          checkoutDir: `${name}-${suffix}`,
        },
      });
      await test.db.taskRepo.create({
        data: { organizationId: first.organizationId, projectId: first.projectId, taskId: task.taskId, repoId: repo.id, branchName, baseBranch: "main" },
      });
      return repoIdSchema.parse(repo.id);
    };
    const second = await addRepo("api");
    const untouched = await addRepo("docs");
    const before = codeHost.pulls.length;
    await send(
      task,
      task.next,
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I changed the app and its API." },
      { kind: "pr.text_set", repoId: theRepo(), title: "ignored", body: "The app's side of the change." },
      { kind: "pr.text_set", repoId: second, title: "ignored", body: "The API's side of the change." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      {
        kind: "session.ended",
        outcome: "with-changes",
        repos: [
          { repoId: theRepo(), ahead: true },
          { repoId: second, ahead: true },
          { repoId: untouched, ahead: false },
        ],
      },
    );
    await reactToEnd(task);
    await openPrs(task);
    const pulls = codeHost.pulls.slice(before);
    expect(pulls.map((pull) => pull.repo)).toEqual([first.fullName, `ostra-test/api-${suffix}`]);
    const [app, api] = pulls;
    if (app === undefined || api === undefined) {
      throw new Error("two PRs");
    }
    const taskUrl = `http://localhost:3000/tasks/${task.taskId}`;
    expect(app.body).toContain("The app's side of the change.");
    expect(api.body).toContain("The API's side of the change.");
    for (const pull of pulls) {
      expect(pull.title).toBe("Add a short CONTRIBUTING.md");
      expect(pull.body).toContain(taskUrl);
    }
    // Each links the other: the first one too, opened before the second existed.
    expect(app.body).toContain(api.url);
    expect(api.body).toContain(app.url);
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId: untouched } })).toMatchObject({ prNumber: null, ahead: false });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(2);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
  });
});

describe("a prompt task in a project with no tracker (F-097, Q31)", () => {
  it("F-097: goes from a member's prompt to an opened PR with no tracker and no ticket", async () => {
    expect(await test.db.board.count({ where: { projectId: world.projectId } })).toBe(0);
    const scope: MemberScope = { organizationId: fixture.a.organization.id, memberId: fixture.a.member.id, role: "member", projectRoles: new Map() };
    const prompt = "Add a docs/numbers.md that lists one to ten";
    const created = await test.db.$transaction((tx) =>
      createPromptTask({ tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { projectId: projectIdSchema.parse(world.projectId), prompt, runnerId: runner.runnerId }),
    );
    if (!created.ok) {
      throw new Error(`create failed: ${created.message}`);
    }
    const task: QueuedTask = { taskId: created.taskId, sessionId: created.sessionId, organizationId: fixture.a.organization.id };
    const offered = await test.db.$transaction((tx) =>
      dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, dispatchPayload(task)),
    );
    if (!offered.ok) {
      throw new Error(`dispatch failed: ${offered.message}`);
    }
    const command = await test.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
    await test.db.$transaction((tx) =>
      applyOfferResultsInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, runner, [{ commandId: offered.commandId, seq: command.seq, kind: "dispatch", body: command.body, taskId: task.taskId, result: "accepted", reason: null }]),
    );
    let seq = 0;
    const next = (): number => {
      seq += 1;
      return seq;
    };
    const headSha = gitShaSchema.parse("b".repeat(40));
    await send(
      task,
      next,
      { kind: "turn.started", turnId },
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I added docs/numbers.md." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "git.pushed", repoId: theRepo(), branch: created.branchName, headSha, ref: `refs/heads/${created.branchName}` },
      { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: theRepo(), ahead: true }] },
    );
    await reactToEnd(task);
    await openPrs(task);
    const pull = codeHost.pulls.find((item) => item.headBranch === created.branchName);
    expect(pull).toMatchObject({ title: prompt, baseBranch: "main" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ source: "prompt", state: "in_review", ticketKey: null, ticketId: null, boardId: null });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "pr_open", prNumber: pull?.number });
    expect(await test.db.ticket.count({ where: { projectId: world.projectId } })).toBe(0);
    expect(await test.db.ticketWrite.count({ where: { taskId: task.taskId } })).toBe(0);
  });
});

describe("a session that ends without changes", () => {
  it("F-065: opens no PR and puts the task in needs you with the agent's summary", async () => {
    const task = await runningTask();
    const before = codeHost.pulls.length;
    // The agent speaks twice: the summary of what happened is its last message, not its first.
    await send(
      task,
      task.next,
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s0"), text: "Let me look at how the tests run first." },
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "The tests run with pnpm test; nothing needed changing." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "session.ended", outcome: "without-changes", repos: [{ repoId: theRepo(), ahead: false }] },
    );
    await reactToEnd(task);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "no_changes" });
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({
      reason: "no_changes",
      audience: "driver",
      summary: "The tests run with pnpm test; nothing needed changing.",
    });
    await openPrs(task);
    expect(codeHost.pulls.length).toBe(before);
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "ended", outcome: "without_changes" });
  });
});

describe("stop and crash", () => {
  it("a stopped task's runner ends the session: no PR, the lease freed, the task stays stopped", async () => {
    const task = await runningTask();
    const scope: MemberScope = { organizationId: fixture.a.organization.id, memberId: fixture.a.member.id, role: "member", projectRoles: new Map() };
    const stopped = await test.db.$transaction((tx) =>
      stopTask({ tx, scope, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { taskId: task.taskId }),
    );
    if (!stopped.ok || stopped.commandId === null) {
      throw new Error("stop failed");
    }
    const stopCommandId = stopped.commandId;
    const command = await test.db.command.findUniqueOrThrow({ where: { id: stopCommandId } });
    expect(command.body).toMatchObject({ taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: 1, reason: "requested" });
    // The runner pushes what's there (the branch and the hidden ref) and ends the session.
    await send(task, task.next, { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: theRepo(), ahead: true }] });
    await test.db.$transaction((tx) =>
      applyStopResultsInTx(deps, tx, runner, [{ commandId: stopCommandId, seq: command.seq, kind: "stop", body: command.body, taskId: task.taskId, result: "done", reason: null }]),
    );
    const before = codeHost.pulls.length;
    await reactToEnd(task);
    await openPrs(task);
    expect(codeHost.pulls.length).toBe(before);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "requested" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "branch_pushed", ahead: true });
    expect(await test.db.auditEntry.findFirst({ where: { entityId: task.taskId, action: "task.stopped", actorId: fixture.a.member.id } })).not.toBeNull();
  });

  it("F-025: a member's stop, answered as the runner answers it, ends the session stopped with the branch and the hidden ref recorded and no PR", async () => {
    const task = await runningTask();
    const scope: MemberScope = { organizationId: fixture.a.organization.id, memberId: fixture.a.member.id, role: "member", projectRoles: new Map() };
    const stopped = await test.db.$transaction((tx) =>
      stopTask({ tx, scope, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { taskId: task.taskId }),
    );
    if (!stopped.ok || stopped.commandId === null) {
      throw new Error("stop failed");
    }
    const stopCommandId = stopped.commandId;
    const command = await test.db.command.findUniqueOrThrow({ where: { id: stopCommandId } });
    expect(command).toMatchObject({ runnerId: runner.runnerId, kind: "stop" });
    // The runner (apps/runner's task run): the turn ends cancelled, the unfinished work goes to the
    // branch and the hidden ref, and no session.ended follows; then it acks the stop.
    const headSha = gitShaSchema.parse("a".repeat(40));
    const branch = branchNameSchema.parse((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).branchName);
    await send(
      task,
      task.next,
      { kind: "turn.ended", turnId, stopReason: "cancelled" },
      { kind: "git.pushed", repoId: theRepo(), branch, headSha, ref: `refs/heads/${branch}` },
      { kind: "git.pushed", repoId: theRepo(), branch, headSha, ref: `refs/ostra/wip/${task.taskId}` },
    );
    await test.db.$transaction((tx) =>
      applyStopResultsInTx(deps, tx, runner, [{ commandId: stopCommandId, seq: command.seq, kind: "stop", body: command.body, taskId: task.taskId, result: "done", reason: null }]),
    );
    expect(await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).toMatchObject({ state: "stopped" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "requested" });
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "ended", endReason: "released" });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "branch_pushed", ahead: true, headSha });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "git.pushed" } })).toBe(2);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.opened" } })).toBe(0);
    expect(codeHost.pulls.filter((pull) => pull.headBranch === branch)).toEqual([]);
  });

  it("a crash reaches needs you for the driver with the box failed", async () => {
    const task = await runningTask();
    await send(task, task.next, { kind: "session.crashed", error: "the agent exited with code 137" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "crashed" });
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(await test.db.box.findUniqueOrThrow({ where: { id: lease.boxId } })).toMatchObject({ state: "failed" });
  });

  it("another organization's runner can't answer our stop", async () => {
    const task = await runningTask();
    const intruder = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id });
    await test.db.$transaction((tx) =>
      applyStopResultsInTx(deps, tx, intruder, [
        { commandId: commandIdSchema.parse(randomUUID()), seq: 1, kind: "stop", body: { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: 1, reason: "requested" }, taskId: task.taskId, result: "done", reason: null },
      ]),
    );
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "active" });
    expect((await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId } })).state).toBe("running");
  });
});

// Gated: a PR on a test branch of ostra-test/test1, opened by the App, then closed and its branch deleted.
const live = {
  appId: process.env["GITHUB_APP_ID"],
  keyPath: process.env["GITHUB_APP_PRIVATE_KEY_PATH"],
  installationId: process.env["GITHUB_APP_INSTALLATION_ID"],
  org: process.env["GITHUB_TEST_ORG"],
  repo: process.env["GITHUB_TEST_REPO"],
};

describe.skipIf(Object.values(live).some((value) => value === undefined || value === ""))("live: the App opens the PR", () => {
  it("opens it on a test branch of test1 with the title and the footer, then cleans up", async () => {
    const github = new GitHubAdapter({ userAgent: "ostra-core-test" }, { logger, clock: adapterClock });
    const privateKey = await readFile(live.keyPath ?? "", "utf8");
    const fullName = repoFullNameSchema.parse(`${live.org ?? ""}/${live.repo ?? ""}`);
    const access = { app: { appId: live.appId ?? "", privateKey }, installationId: live.installationId ?? "", repo: fullName };
    const minted = await github.mintRepoToken(access, { contents: "write", pull_requests: "write", metadata: "read" });
    if (!minted.ok) {
      throw new Error(`minting failed: ${minted.error.code}`);
    }
    const token = minted.value.token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`https://api.github.com/repos/${fullName}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "user-agent": "ostra-core-test", accept: "application/vnd.github+json", "content-type": "application/json" },
      });
    const json = async (response: Response): Promise<unknown> => {
      const body: unknown = await response.json();
      return body;
    };
    const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => Reflect.get(Object(at), key), value);
    const branch = `ostra-test/core-live-${randomBytes(4).toString("hex")}`;
    const sha = field(await json(await api("/git/ref/heads/main")), "object", "sha");
    if (typeof sha !== "string") {
      throw new Error("no main branch");
    }
    expect((await api("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) })).status).toBe(201);
    let prNumber: number | null = null;
    try {
      const put = await api(`/contents/${branch.replaceAll("/", "-")}.md`, {
        method: "PUT",
        body: JSON.stringify({ message: "test: a file for ostra's live PR test", content: Buffer.from("live test").toString("base64"), branch }),
      });
      expect(put.status).toBe(201);
      // A world on the real repo, in organization B: the App's key in a secret store, the task repo ahead.
      const organizationId = organizationIdSchema.parse(fixture.b.organization.id);
      const liveStore = new FakeSecretStore();
      const keyRef = await liveStore.put({ organizationId, purpose: "github-app.private-key" }, privateKey);
      if (!keyRef.ok) {
        throw new Error("the secret store refused");
      }
      const connection = await test.db.connection.create({
        data: { organizationId, kind: "github", appId: live.appId ?? "", slug: "live", privateKeySecretRef: keyRef.value },
      });
      const repo = await test.db.repo.create({
        data: {
          organizationId,
          projectId: fixture.b.project.id,
          connectionId: connection.id,
          installationId: live.installationId ?? "",
          hostRepoId: "live",
          fullName,
          defaultBranch: "main",
          checkoutDir: "test1",
        },
      });
      const task = await test.db.task.create({
        data: { organizationId, projectId: fixture.b.project.id, kind: "code", source: "prompt", title: "Live test: add a file", prompt: "Live test: add a file", branchName: branch, state: "running" },
      });
      const session = await test.db.session.create({
        data: { organizationId, projectId: task.projectId, taskId: task.id, origin: "new", state: "ended", outcome: "with_changes" },
      });
      await test.db.taskRepo.create({
        data: { organizationId, projectId: task.projectId, taskId: task.id, repoId: repo.id, branchName: branch, baseBranch: "main", state: "branch_pushed", ahead: true, prBody: "A live test of ostra's PR flow." },
      });
      const liveDeps: ReactionDeps = { ...deps, adapters: { codeHost: github, secretStore: liveStore, modelProvider: new FakeModelProvider() } };
      await openPullRequestsHandler(liveDeps)(
        context("task.open-pull-requests", {
          organizationId,
          taskId: taskIdSchema.parse(task.id),
          sessionId: sessionIdSchema.parse(session.id),
          eventSeq: taskSeqSchema.parse(1),
        }),
      );
      const row = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.id } });
      prNumber = row.prNumber;
      expect(row.state).toBe("pr_open");
      const pull = await json(await api(`/pulls/${String(prNumber)}`));
      expect(field(pull, "title")).toBe("Live test: add a file");
      expect(String(field(pull, "body"))).toContain(`http://localhost:3000/tasks/${task.id}`);
      expect(String(field(pull, "user", "login"))).toMatch(/\[bot\]$/);
    } finally {
      if (prNumber !== null) {
        await api(`/pulls/${String(prNumber)}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      }
      await api(`/git/refs/heads/${branch}`, { method: "DELETE" });
    }
  });
});

describe("files left outside every repo (ticket 44)", () => {
  const items = (task: QueuedTask) => test.db.needsYouItem.findMany({ where: { taskId: task.taskId, reason: "files_outside_repos" }, orderBy: { createdAt: "asc" } });

  it("F-016: raises one item for the driver with the names, updates it as the set changes, and closes it when they're gone", async () => {
    const task = await runningTask();
    await send(task, task.next, { kind: "workspace.files_outside_repos", paths: ["notes.md", "plan.txt"], more: 0 });
    expect(await items(task)).toMatchObject([{ state: "open", audience: "driver", summary: "notes.md, plan.txt" }]);
    // The set changes: the same item, never a second one.
    await send(task, task.next, { kind: "workspace.files_outside_repos", paths: ["plan.txt"], more: 2 });
    expect(await items(task)).toMatchObject([{ state: "open", summary: "plan.txt (+2)" }]);
    // A later turn moved them: the item closes.
    await send(task, task.next, { kind: "workspace.files_outside_repos", paths: [], more: 0 });
    const closed = await items(task);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.state).toBe("answered");
    expect(closed[0]?.resolvedAt).not.toBeNull();
    // The event log keeps the names, for the thread.
    const stored = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "workspace.files_outside_repos" }, orderBy: { seq: "asc" } });
    expect(stored.map((row) => row.payload)).toEqual([
      { kind: "workspace.files_outside_repos", paths: ["notes.md", "plan.txt"], more: 0 },
      { kind: "workspace.files_outside_repos", paths: ["plan.txt"], more: 2 },
      { kind: "workspace.files_outside_repos", paths: [], more: 0 },
    ]);
  });

  it("F-016: is for the project's members when the task has no driver", async () => {
    const task = await runningTask();
    await test.db.task.update({ where: { id: task.taskId }, data: { driverMemberId: null } });
    await send(task, task.next, { kind: "workspace.files_outside_repos", paths: ["scratch"], more: 0 });
    expect(await items(task)).toMatchObject([{ state: "open", audience: "project_members" }]);
  });

  it("F-065: a turn that changed nothing needs you for the files, not for no changes", async () => {
    const task = await runningTask();
    const before = codeHost.pulls.length;
    await send(
      task,
      task.next,
      { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse("s1"), text: "I wrote my notes down." },
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "workspace.files_outside_repos", paths: ["notes.md"], more: 0 },
      { kind: "session.ended", outcome: "without-changes", repos: [{ repoId: theRepo(), ahead: false }] },
    );
    await reactToEnd(task);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "needs_you", needsYouReason: "files_outside_repos" });
    expect((await test.db.needsYouItem.findMany({ where: { taskId: task.taskId } })).map((item) => item.reason)).toEqual(["files_outside_repos"]);
    await openPrs(task);
    expect(codeHost.pulls.length).toBe(before);
  });

  it("F-030: a turn that also changed a repo still opens its PR, with the item beside it", async () => {
    const task = await runningTask();
    const before = codeHost.pulls.length;
    await send(
      task,
      task.next,
      { kind: "turn.ended", turnId, stopReason: "end_turn" },
      { kind: "workspace.files_outside_repos", paths: ["plan.txt"], more: 0 },
      { kind: "session.ended", outcome: "with-changes", repos: [{ repoId: theRepo(), ahead: true }] },
    );
    await reactToEnd(task);
    await openPrs(task);
    expect(codeHost.pulls.length).toBe(before + 1);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
    expect(await items(task)).toMatchObject([{ state: "open", summary: "plan.txt" }]);
  });
});
