import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { CompareResult, LogRecord } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  freshBranchName,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  reconcileBehind,
  reopenTask,
  requestUpdateBranch,
  systemClock,
} from "@ostra/domain";
import type { M3Deps, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  clientMessageIdSchema,
  connectionIdSchema,
  gitShaSchema,
  leaseEpochSchema,
  memberIdSchema,
  repoIdSchema,
  segmentIdSchema,
  sessionIdSchema,
  taskEventSchema,
  taskSpecNeedsMinor3,
  turnIdSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import type { OrganizationId, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { INSTALLATION_ID, seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";
import { openPullRequestsHandler } from "./session-end.ts";
import type { ReactionDeps } from "./session-end.ts";

// Ticket 24 (F-070, F-066, ADR 0052): behind, "Update branch", and after the merge. A push to a
// base branch recomputes each live task repo's `behind` from the compare; "Update branch" sends one
// member message naming the repos behind; a reopen after a merge gives the merged repo a fresh
// branch (`-2`, then `-3`) from its base, keeps its merged PR, and leaves the other repos alone.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let reactionDeps: ReactionDeps;
let prDeps: PullRequestStateDeps;
let deps: M3Deps;
let runner: RunnerRef;
let secondRepoId: RepoId;
let driver: MemberScope;
let outsider: MemberScope;
let timers: SessionTimers;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const scopeOf = (organizationId: MemberScope["organizationId"], memberId: string, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId,
  memberId: memberIdSchema.parse(memberId),
  role,
  projectRoles: new Map(),
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  const first = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
  await seedInstallation(test.db, { organizationId: world.organizationId, connectionId: first.connectionId, installationId: INSTALLATION_ID });
  const second = await test.db.repo.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      connectionId: first.connectionId,
      installationId: INSTALLATION_ID,
      hostRepoId: "host-ostra-test/test2",
      fullName: "ostra-test/test2",
      defaultBranch: "main",
      checkoutDir: "test2",
    },
  });
  secondRepoId = repoIdSchema.parse(second.id);
  timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  const adapters = { codeHost, secretStore, modelProvider: new FakeModelProvider() };
  reactionDeps = { db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters, publicUrl: "http://localhost:3000", logger, timers };
  prDeps = { db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost, secretStore, logger };
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters };
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 2 } });
  driver = scopeOf(fixture.a.organization.id, fixture.a.member.id);
  outsider = scopeOf(fixture.b.organization.id, fixture.b.admin.id, "admin");
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repo = (): RepoId => repoIdSchema.parse(world.repoId);

const compareOf = (behindBy: number): CompareResult => ({
  aheadBy: 1,
  behindBy,
  mergeBase: "e".repeat(40),
  files: [],
  filesTruncated: false,
  limits: { maxFiles: 300, maxPatchBytes: 1024 * 1024 },
});

/** A running task on one repo or both, its first turn started. */
const runningTask = async (repos: readonly RepoId[] = [repo()]): Promise<DrivenTask> => {
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  for (const repoId of repos.filter((id) => id !== repo())) {
    await test.db.taskRepo.create({ data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, repoId, branchName: row.branchName, baseBranch: "main" } });
  }
  return task;
};

/** One turn that pushes `heads` and saves; then the PR opener runs for the save, as its job would. */
const turn = async (task: DrivenTask, ordinal: number, heads: readonly { readonly repoId: RepoId; readonly head: string }[]): Promise<void> => {
  const turnId = turnIdSchema.parse(`turn-${String(ordinal)}`);
  const all = await test.db.taskRepo.findMany({ where: { taskId: task.taskId } });
  const events: TaskEvent[] = [
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`s${String(ordinal)}`), text: `turn ${String(ordinal)}` },
    ...heads.map((head): TaskEvent => {
      const branch = all.find((row) => row.repoId === head.repoId)?.branchName ?? "";
      return { kind: "git.pushed", repoId: head.repoId, branch, headSha: sha(head.head), ref: `refs/heads/${branch}` };
    }),
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
    {
      kind: "session.saved",
      turnOrdinal: ordinal,
      repos: all.map((row) => {
        const pushed = heads.find((head) => head.repoId === row.repoId);
        const headSha = pushed === undefined ? gitShaSchema.nullable().parse(row.headSha) : sha(pushed.head);
        return { repoId: repoIdSchema.parse(row.repoId), headSha, ahead: headSha !== null, hiddenRefSha: sha(`wip-${String(ordinal)}`) };
      }),
      archive: null,
    },
  ];
  await task.send(...events);
  const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "desc" } });
  const payload = { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq };
  if ((await jobs.find("task.open-pull-requests", payload)).length > 0) {
    await openPullRequestsHandler(reactionDeps)(jobContext("task.open-pull-requests", payload, logger));
  }
};

const connectionOf = async (organizationId: string) =>
  connectionIdSchema.parse((await test.db.connection.findFirstOrThrow({ where: { organizationId, kind: "github" } })).id);

const delivery = async (event: string, body: string, organizationId: OrganizationId = world.organizationId): Promise<WebhookDeliveryContext> => ({
  organizationId,
  connectionId: await connectionOf(organizationId),
  deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
  event,
  payload: JSON.parse(body),
  receivedAt: Date.now(),
  logger,
});

const pushToMain = async (fullName: string, organizationId: OrganizationId = world.organizationId) =>
  githubWebhookHandler(prDeps)(await delivery("push", codeHost.pushDelivery(fullName, { branch: "main", before: "1".repeat(40), after: "2".repeat(40) }).body, organizationId));

const behindOf = async (task: DrivenTask, repoId: RepoId = repo()) => (await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId } })).behindBy;

const messagesOf = async (taskId: string, intent: string) =>
  (await test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
    const parsed = taskEventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "user.message" && parsed.data.intent === intent ? [parsed.data] : [];
  });

/** The PR of a repo on the host merges, and the App's webhook says so. */
const merge = async (task: DrivenTask, repoId: RepoId, fullName: string): Promise<void> => {
  const row = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId } });
  if (row.prNumber === null) {
    throw new Error("no PR to merge");
  }
  codeHost.changePull(fullName, row.prNumber, "merge");
  await githubWebhookHandler(prDeps)(await delivery("pull_request", codeHost.pullRequestDelivery(fullName, row.prNumber, "closed").body));
};

const reopen = (task: DrivenTask, text: string) =>
  test.db.$transaction((tx) =>
    reopenTask(
      { tx, scope: driver, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, timers },
      { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(`reopen-${randomUUID()}`), text },
    ),
  );

/** The task's next session, accepted by the runner, as the dispatch would leave it. */
const nextSession = async (task: DrivenTask): Promise<DrivenTask> => {
  const session = await test.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: { startedAt: "desc" } });
  return acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner, { taskId: task.taskId, sessionId: sessionIdSchema.parse(session.id), organizationId: task.organizationId });
};

describe("behind (F-070)", () => {
  it("F-070: a push to main updates behindBy once, for this organization's task repos only", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "behind-1" }]);
    codeHost.setCompare("ostra-test/test1", sha("behind-1"), compareOf(3), "main");
    const before = codeHost.compareCalls.length;
    expect(await pushToMain("ostra-test/test1")).toEqual({ outcome: "processed" });
    expect(await behindOf(task)).toBe(3);
    expect(codeHost.compareCalls.slice(before)).toContainEqual({ repo: "ostra-test/test1", base: "main", head: sha("behind-1") });
    const changed = records.filter((record) => record.message === "push.behind").at(-1);
    expect(changed?.fields).toMatchObject({ changed: 1 });
    // The same push again: compared again, nothing changes.
    await pushToMain("ostra-test/test1");
    expect(records.filter((record) => record.message === "push.behind").at(-1)?.fields).toMatchObject({ changed: 0 });
    expect(await behindOf(task)).toBe(3);
    // Another organization's push to a repo of the same name moves nothing here.
    codeHost.setCompare("ostra-test/test1", sha("behind-1"), compareOf(9), "main");
    expect(await pushToMain("ostra-test/other", otherWorld.organizationId)).toMatchObject({ outcome: "ignored" });
    expect(await behindOf(task)).toBe(3);
    // The reconcile pass catches up when no webhook came.
    await reconcileBehind({ db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore } });
    expect(await behindOf(task)).toBe(9);
  });
});

describe("Update branch (F-070)", () => {
  it("F-070: update branch sends one message naming only the repos behind; nothing behind refuses it", async () => {
    const task = await runningTask([repo(), secondRepoId]);
    await turn(task, 1, [
      { repoId: repo(), head: "upd-1a" },
      { repoId: secondRepoId, head: "upd-1b" },
    ]);
    expect(await requestUpdateBranch(deps, driver, { taskId: task.taskId })).toMatchObject({ ok: false, error: "nothing-behind" });
    codeHost.setCompare("ostra-test/test1", sha("upd-1a"), compareOf(2), "main");
    codeHost.setCompare("ostra-test/test2", sha("upd-1b"), compareOf(0), "main");
    await pushToMain("ostra-test/test1");
    await pushToMain("ostra-test/test2");
    const sent = await requestUpdateBranch(deps, driver, { taskId: task.taskId });
    expect(sent).toMatchObject({ ok: true, repos: 1 });
    // Pressed twice: the same message, answered as sent.
    expect(await requestUpdateBranch(deps, driver, { taskId: task.taskId })).toMatchObject({ ok: true, repos: 1 });
    const messages = await messagesOf(task.taskId, "update-branch");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("ostra-test/test1: merge `main` into");
    expect(messages[0]?.text).not.toContain("ostra-test/test2");
    expect(messages[0]?.text).toContain("never rebase");
    expect(await requestUpdateBranch(deps, outsider, { taskId: task.taskId })).toMatchObject({ ok: false, error: "not-found" });
  });
});

describe("after the merge (F-066)", () => {
  it("F-066: a reopen after a merge makes -2 from the base, keeps the merged PR, and leaves an unmerged repo's branch alone", async () => {
    const task = await runningTask([repo(), secondRepoId]);
    await turn(task, 1, [
      { repoId: repo(), head: "am-1a" },
      { repoId: secondRepoId, head: "am-1b" },
    ]);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const firstPr = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId: repo() } });
    await merge(task, repo(), "ostra-test/test1");
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { id: firstPr.id } })).toMatchObject({ state: "merged" });
    // The other PR is open: the task is still in review, and reopens with a message.
    const reopened = await reopen(task, "Add a second line to the changelog.");
    expect(reopened).toMatchObject({ ok: true, freshBranches: [{ taskRepoId: firstPr.id, branchName: `${branchName}-2` }] });
    const fresh = await test.db.taskRepo.findFirstOrThrow({ where: { id: firstPr.id } });
    expect(fresh).toMatchObject({ branchName: `${branchName}-2`, generation: 2, state: "no_branch", headSha: null, prNumber: null, hiddenRefSha: null });
    expect(await test.db.taskPullRequest.findMany({ where: { taskRepoId: firstPr.id }, select: { number: true, state: true, branchName: true } })).toEqual([
      { number: firstPr.prNumber, state: "merged", branchName },
    ]);
    // The unmerged repo keeps its branch and its PR; the task keeps its own branch name for it.
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId: secondRepoId } })).toMatchObject({ branchName, state: "pr_open" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).branchName).toBe(branchName);
  });

  it("F-066: after a partial merge the task spec gives the merged repo its fresh branch, and the other repo the task's", async () => {
    const task = await runningTask([repo(), secondRepoId]);
    await turn(task, 1, [
      { repoId: repo(), head: "ps-1a" },
      { repoId: secondRepoId, head: "ps-1b" },
    ]);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await merge(task, repo(), "ostra-test/test1");
    expect(await reopen(task, "Add a second line.")).toMatchObject({ ok: true });
    await nextSession(task);
    // The fake code host lists the second repo too, as the real one does for its installation.
    codeHost.repos.set(INSTALLATION_ID, [
      ...(codeHost.repos.get(INSTALLATION_ID) ?? []).filter((each) => each.fullName !== "ostra-test/test2"),
      { hostRepoId: "host-ostra-test/test2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" },
    ]);
    const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const built = await buildTaskSpec({ db: test.db, codeHost, secretStore }, { taskId: task.taskId, runnerId: runner.runnerId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch) });
    if (!built.ok) throw new Error(`spec: ${built.error}`);
    const { spec } = built;
    // The task keeps its own name; the merged repo names its fresh one, and the other names none.
    expect(spec.branchName).toBe(branchName);
    expect(spec.repos.map((each) => [each.fullName, each.branchName])).toEqual([
      ["ostra-test/test1", `${branchName}-2`],
      ["ostra-test/test2", undefined],
    ]);
    // A runner below minor 3 would push both to the task's name, so core offers it to a minor-3 one only.
    expect(taskSpecNeedsMinor3(spec)).toBe(true);
    // The agent is told the merged repo's branch too.
    expect(spec.agent.instructions).toContain(`branch: \`${branchName}-2\``);
  });

  it("F-066: a merged task reopens on -2, its first push opens a new PR, and a second merge and reopen makes -3", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "mm-1" }]);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await merge(task, repo(), "ostra-test/test1");
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("merged");
    expect(await reopen(task, "One more thing.")).toMatchObject({ ok: true, freshBranches: [{ branchName: `${branchName}-2` }] });
    const reopenedTask = mapTask(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } }));
    expect(reopenedTask).toMatchObject({ state: "queued", branchName: `${branchName}-2` });

    // The next session pushes the fresh branch: a new PR, beside the merged one.
    const second = await nextSession(task);
    await turn(second, 1, [{ repoId: repo(), head: "mm-2" }]);
    const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(taskRepo).toMatchObject({ state: "pr_open", branchName: `${branchName}-2` });
    expect(codeHost.pulls.find((pull) => pull.repo === "ostra-test/test1" && pull.number === taskRepo.prNumber)?.headBranch).toBe(`${branchName}-2`);
    expect((await test.db.taskPullRequest.findMany({ where: { taskRepoId: taskRepo.id }, orderBy: { openedAt: "asc" } })).map((pr) => [pr.state, pr.branchName])).toEqual([
      ["merged", branchName],
      ["open", `${branchName}-2`],
    ]);

    // Merged again, reopened again: -3, and both earlier PRs kept.
    await merge(second, repo(), "ostra-test/test1");
    expect(await reopen(task, "And another.")).toMatchObject({ ok: true, freshBranches: [{ branchName: `${branchName}-3` }] });
    expect(await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ branchName: `${branchName}-3`, generation: 3, state: "no_branch" });
    expect((await test.db.taskPullRequest.findMany({ where: { taskRepoId: taskRepo.id } })).map((pr) => pr.state)).toEqual(["merged", "merged"]);
    expect(freshBranchName(`${branchName}-3`, 3)).toBe(`${branchName}-4`);
  });
});
