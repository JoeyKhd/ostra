import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, stopTask, systemClock } from "@ostra/domain";
import type { JobName, JobPayload, MemberScope } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import {
  commandIdSchema,
  organizationIdSchema,
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
  it("opens one PR per changed repo, once, even when the job runs twice, and the task goes to review", async () => {
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

describe("a session that ends without changes", () => {
  it("opens no PR and puts the task in needs you with the agent's summary", async () => {
    const task = await runningTask();
    const before = codeHost.pulls.length;
    await send(
      task,
      task.next,
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
