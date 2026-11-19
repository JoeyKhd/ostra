import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  addProjectRepo,
  jobPayloadSchemas,
  linkRelatedPullRequests,
  openPullRequests,
  postgresAuditLog,
  postgresChangeNotices,
  RELATED_END,
  RELATED_START,
  removeProjectRepo,
  reopenTask,
  reorderProjectRepos,
  systemClock,
} from "@ostra/domain";
import type { JobName, JobQueue, MemberScope, ProjectReposDeps, SessionTimers } from "@ostra/domain";
import { clientMessageIdSchema, connectionIdSchema, gitShaSchema, leaseEpochSchema, memberIdSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { ProjectId, RepoId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { jobContext } from "../testing/turns.ts";
import { INSTALLATION_ID, recordSessionModel, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { linkRelatedHandler } from "./related-prs.ts";

// Milestone 4's ticket 17 (F-098): a project's several repos, a task across them, and the
// "Related" sections of its PRs, against Postgres and the fake code host.

let test: TestDatabase;
let fixture: IsolationFixture;
let world: World;
let projectId: ProjectId;
let secondRepoId: RepoId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const enqueued: { readonly job: JobName; readonly payload: unknown }[] = [];
const jobs: JobQueue = {
  enqueueInTx: (_tx, job, payload) => {
    enqueued.push({ job, payload });
    return Promise.resolve();
  },
};
const FIRST = repoFullNameSchema.parse("ostra-test/test1");
const SECOND = repoFullNameSchema.parse("ostra-test/test2");

/** Repos the App's installation lists on the fake host, beside the world's `test1`. */
const listOnHost = (fullName: string) => {
  codeHost.repos.set(INSTALLATION_ID, [
    ...(codeHost.repos.get(INSTALLATION_ID) ?? []),
    { hostRepoId: `host-${fullName}`, fullName, defaultBranch: fullName.endsWith("test2") ? "trunk" : "main", private: true, cloneUrl: `https://github.example/${fullName}.git` },
  ]);
};

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});
const admin = () => scopeOf(fixture.a.admin, "admin");

const repoDeps = (overrides: Partial<ProjectReposDeps> = {}): ProjectReposDeps => ({
  db: test.db,
  audit: postgresAuditLog,
  notices: postgresChangeNotices,
  clock: systemClock,
  adapters: { codeHost, secretStore },
  ...overrides,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  projectId = world.projectId;
  listOnHost(SECOND);
  const added = await addProjectRepo(repoDeps(), admin(), { projectId, fullName: SECOND });
  if (!added.ok) throw new Error(`not added: ${added.error}`);
  secondRepoId = added.repoId;
  // The project's order: test2 first, then test1.
  const reordered = await reorderProjectRepos(repoDeps(), admin(), { projectId, repoIds: [secondRepoId, repoIdSchema.parse(world.repoId)] });
  if (!reordered.ok) throw new Error("not reordered");
});

afterAll(async () => {
  await test.dispose();
});

beforeEach(() => {
  enqueued.length = 0;
  records.length = 0;
});

const runner = async () => seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, 10);

/** A task (both repos, as `createPromptTask` makes them) whose given repos are ahead, running. */
const taskAhead = async (ahead: readonly string[]): Promise<QueuedTask> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
  // `seedQueuedTask` gives the world's one repo; the project's other repo joins the same branch.
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  await test.db.taskRepo.create({ data: { organizationId: world.organizationId, projectId, taskId: task.taskId, repoId: secondRepoId, branchName, baseBranch: "trunk" } });
  for (const repoId of ahead) {
    await test.db.taskRepo.updateMany({ where: { taskId: task.taskId, repoId }, data: { ahead: true, state: "branch_pushed", headSha: gitShaSchema.parse(randomUUID().replace(/-/g, "").padEnd(40, "0")) } });
  }
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "running" } });
  return task;
};

const open = async (task: QueuedTask) => {
  const result = await openPullRequests(
    { db: test.db, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() }, publicUrl: "https://ostra.example", jobs },
    { organizationId: world.organizationId, taskId: task.taskId, sessionId: sessionIdSchema.parse(task.sessionId), eventSeq: 1 },
  );
  if (!result.ok) throw new Error(`no PRs: ${result.error}`);
  return result;
};

const prsOf = (taskId: TaskId) =>
  test.db.taskRepo.findMany({ where: { taskId, prNumber: { not: null } }, select: { repoId: true, prNumber: true, prUrl: true, repo: { select: { fullName: true } } }, orderBy: { repo: { position: "asc" } } });

const bodyOf = (fullName: string, number: number | null) => codeHost.pulls.find((pull) => pull.repo === fullName && pull.number === number)?.body ?? "";

const linkDeps = () => ({ db: test.db, clock: systemClock, notices: postgresChangeNotices, adapters: { codeHost, secretStore }, logger });

describe("F-098: a project's repos", () => {
  it("F-098: the spec holds both repos in the project's order, each with its folder and base, on one branch name", async () => {
    const task = await taskAhead([]);
    const runnerRef = await runner();
    const box = await test.db.box.create({ data: { organizationId: world.organizationId, projectId, taskId: task.taskId, runnerId: runnerRef.runnerId, executor: "host", state: "preparing" } });
    await test.db.lease.create({ data: { organizationId: world.organizationId, projectId, taskId: task.taskId, epoch: 1, runnerId: runnerRef.runnerId, boxId: box.id, state: "active" } });
    await test.db.task.update({ where: { id: task.taskId }, data: { runnerId: runnerRef.runnerId, leaseEpoch: 1, state: "preparing" } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { boxId: box.id } });
    // The session's start records its provider and model row (F-135); this lease skips the dispatch.
    await recordSessionModel(test.db, world, task.sessionId);
    const spec = await buildTaskSpec(
      { db: test.db, codeHost, secretStore, agentMemory: () => "mcp" },
      { taskId: task.taskId, runnerId: runnerRef.runnerId, leaseEpoch: leaseEpochSchema.parse(1), minor: 3 },
    );
    if (!spec.ok) throw new Error(spec.error);
    expect(spec.spec.repos.map((repo) => [repo.fullName, repo.checkoutDir, repo.defaultBranch])).toEqual([
      [SECOND, "test2", "trunk"],
      [FIRST, "test1", "main"],
    ]);
    const branches = await test.db.taskRepo.findMany({ where: { taskId: task.taskId }, select: { branchName: true } });
    expect(branches).toHaveLength(2);
    expect(new Set(branches.map((row) => row.branchName)).size).toBe(1);
    // The agent is told where each repo is.
    expect(spec.spec.agent.instructions ?? "").toContain("`test2/`: ostra-test/test2 (base: trunk)");
  });

  it("F-098: adding is a project admin's, within the limit, of a repo the App reaches, at the next position, with its audit entry", async () => {
    const member = scopeOf(fixture.a.member, "member");
    const THIRD = repoFullNameSchema.parse("ostra-test/test3");
    expect(await addProjectRepo(repoDeps(), member, { projectId, fullName: THIRD })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await addProjectRepo(repoDeps(), scopeOf(fixture.b.admin, "admin"), { projectId, fullName: THIRD })).toMatchObject({ ok: false, error: "not-found" });
    expect(await addProjectRepo(repoDeps(), admin(), { projectId, fullName: THIRD })).toMatchObject({ ok: false, error: "no-access" });
    expect(await addProjectRepo(repoDeps(), admin(), { projectId, fullName: SECOND })).toMatchObject({ ok: false, error: "already-added" });
    listOnHost(THIRD);
    expect(await addProjectRepo(repoDeps({ maxRepos: 2 }), admin(), { projectId, fullName: THIRD })).toMatchObject({ ok: false, error: "limit-reached" });
    expect(await test.db.repo.count({ where: { projectId } })).toBe(2);
    expect(await test.db.auditEntry.count({ where: { action: "project.repo-added", entityId: projectId } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { action: "project.repos-reordered", entityId: projectId } })).toBe(1);
    expect((await test.db.repo.findUniqueOrThrow({ where: { id: secondRepoId } })).position).toBe(0);
  });

  it("F-098: a repo an unfinished task has a branch in can't be removed, and the refusal names the task", async () => {
    const task = await taskAhead([secondRepoId]);
    await test.db.task.update({ where: { id: task.taskId }, data: { title: "Print the release" } });
    const refused = await removeProjectRepo(repoDeps(), admin(), { projectId, repoId: secondRepoId });
    expect(refused).toMatchObject({ ok: false, error: "in-use", tasks: [{ taskId: task.taskId, title: "Print the release" }] });
    expect(refused.ok ? "" : refused.message).toContain("Print the release");
    expect(await removeProjectRepo(repoDeps(), scopeOf(fixture.a.member, "member"), { projectId, repoId: secondRepoId })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await test.db.repo.count({ where: { id: secondRepoId } })).toBe(1);
    // A stopped task doesn't hold it; a removal then goes through, with its audit entry, and the
    // last repo stays.
    await test.db.task.updateMany({ where: { projectId, state: { notIn: ["stopped", "merged", "done"] } }, data: { state: "stopped", stoppedReason: "requested", subState: null } });
    expect(await removeProjectRepo(repoDeps(), admin(), { projectId, repoId: secondRepoId })).toEqual({ ok: true, removed: true });
    expect(await test.db.auditEntry.count({ where: { action: "project.repo-removed", entityId: projectId } })).toBe(1);
    expect(await removeProjectRepo(repoDeps(), admin(), { projectId, repoId: repoIdSchema.parse(world.repoId) })).toMatchObject({ ok: false, error: "last-repo" });
    // Put it back for the cases below.
    const again = await addProjectRepo(repoDeps(), admin(), { projectId, fullName: SECOND });
    if (!again.ok) throw new Error(again.error);
    secondRepoId = again.repoId;
    // After the project's last position: positions order the repos, gaps and all.
    expect(again.position).toBe(2);
    await reorderProjectRepos(repoDeps(), admin(), { projectId, repoIds: [secondRepoId, repoIdSchema.parse(world.repoId)] });
  });
});

describe("F-098: a task across several repos", () => {
  it("F-098: a task that changes one repo opens one PR", async () => {
    const task = await taskAhead([world.repoId]);
    const result = await open(task);
    expect(result.opened.filter((pr) => !pr.reused)).toHaveLength(1);
    expect((await prsOf(task.taskId)).map((pr) => pr.repo.fullName)).toEqual([FIRST]);
  });

  it("F-098: two PRs each list the other in a Related section, after a replayed webhook too, keeping the rest of each body", async () => {
    const task = await taskAhead([world.repoId, secondRepoId]);
    await open(task);
    const prs = await prsOf(task.taskId);
    expect(prs).toHaveLength(2);
    // Each opened PR enqueued its `pr.link-related`, keyed by the task and the PR.
    const linkJobs = enqueued.filter((entry) => entry.job === "pr.link-related");
    expect(linkJobs).toHaveLength(2);
    // A person edits the first PR's text on the host; the section leaves it as it is.
    const [first, second] = prs;
    if (first === undefined || second === undefined) throw new Error("two PRs");
    const edited = `${bodyOf(first.repo.fullName, first.prNumber)}\n\nA reviewer's note.`;
    const index = codeHost.pulls.findIndex((pull) => pull.repo === first.repo.fullName && pull.number === first.prNumber);
    const pull = codeHost.pulls[index];
    if (pull === undefined) throw new Error("no such PR on the host");
    codeHost.pulls[index] = { ...pull, body: edited };
    for (const entry of linkJobs) {
      await linkRelatedHandler(linkDeps())(jobContext("pr.link-related", jobPayloadSchemas["pr.link-related"].parse(entry.payload), logger));
    }
    const firstBody = bodyOf(first.repo.fullName, first.prNumber);
    const secondBody = bodyOf(second.repo.fullName, second.prNumber);
    expect(firstBody).toContain("A reviewer's note.");
    expect(firstBody).toContain(`${RELATED_START}\n### Related`);
    expect(firstBody).toContain(`- ${second.repo.fullName}#${String(second.prNumber)}: ${second.prUrl ?? ""}`);
    expect(firstBody).not.toContain(`- ${first.repo.fullName}#${String(first.prNumber)}:`);
    expect(secondBody).toContain(`- ${first.repo.fullName}#${String(first.prNumber)}: ${first.prUrl ?? ""}`);
    expect(secondBody.split(RELATED_END)).toHaveLength(2);
    const events = await test.db.event.findMany({ where: { taskId: task.taskId, kind: "pr.related_updated" } });
    expect(events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: first.repoId, prNumber: first.prNumber, related: [{ repoId: second.repoId, prNumber: second.prNumber }] }),
        expect.objectContaining({ repoId: second.repoId, prNumber: second.prNumber, related: [{ repoId: first.repoId, prNumber: first.prNumber }] }),
      ]),
    );
    expect(events).toHaveLength(2);

    // GitHub delivers the PR's `opened` again, and the job runs again: nothing changes.
    const connection = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId }, select: { connectionId: true } });
    for (let replay = 0; replay < 2; replay += 1) {
      const delivery = codeHost.pullRequestDelivery(first.repo.fullName, first.prNumber ?? 0, "opened");
      const payload: unknown = JSON.parse(delivery.body);
      await githubWebhookHandler({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost, secretStore, logger })({
        organizationId: world.organizationId,
        connectionId: connectionIdSchema.parse(connection.connectionId),
        deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
        event: "pull_request",
        payload,
        receivedAt: Date.now(),
        logger,
      });
    }
    expect(await linkRelatedPullRequests(linkDeps(), { organizationId: world.organizationId, taskId: task.taskId })).toEqual({ updated: 0 });
    expect(bodyOf(first.repo.fullName, first.prNumber)).toBe(firstBody);
    expect(bodyOf(second.repo.fullName, second.prNumber)).toBe(secondBody);
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "pr.related_updated" } })).toBe(2);
  });

  it("F-098: a ticket task's ticket links both PRs", async () => {
    const task = await taskAhead([world.repoId, secondRepoId]);
    const connection = await test.db.connection.create({ data: { organizationId: world.organizationId, kind: "linear", appId: `client-${randomUUID().slice(0, 8)}`, state: "active", webhookMode: "polling" } });
    const board = await test.db.board.create({ data: { organizationId: world.organizationId, projectId, connectionId: connection.id, externalId: `team-${randomUUID()}`, name: "Board", statusMap: {} } });
    const ticket = await test.db.ticket.create({
      data: {
        organizationId: world.organizationId,
        projectId,
        boardId: board.id,
        connectionId: connection.id,
        externalId: randomUUID(),
        key: "OST-1",
        title: "Print the release",
        description: null,
        statusId: "s1",
        statusName: "Todo",
        statusCategory: "open",
        url: "https://linear.example/OST-1",
        labels: [],
        trackerUpdatedAt: new Date(),
      },
    });
    await test.db.task.update({ where: { id: task.taskId }, data: { ticketId: ticket.id, boardId: board.id, ticketKey: "OST-1", source: "ticket", prompt: null } });
    await open(task);
    const links = await test.db.ticketWrite.findMany({ where: { taskId: task.taskId, kind: "link_pr" } });
    const prs = await prsOf(task.taskId);
    expect(links).toHaveLength(2);
    expect(prs).toHaveLength(2);
    for (const pr of prs) {
      expect(links.some((row) => {
        const payload = JSON.stringify(row.payload);
        return payload.includes(`"repoId":"${pr.repoId}"`) && payload.includes(`"url":"${pr.prUrl ?? "none"}"`);
      })).toBe(true);
    }
  });

  it("F-098: one PR merged and the other closed unmerged gives a merged task, in both orders; both closed unmerged gives stopped", async () => {
    const connection = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId }, select: { connectionId: true } });
    const cases = [
      [["merge", "close"], "merged"],
      [["close", "merge"], "merged"],
      [["close", "close"], "stopped"],
    ] as const;
    for (const [order, final] of cases) {
      const task = await taskAhead([world.repoId, secondRepoId]);
      await open(task);
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
      const prs = await prsOf(task.taskId);
      for (const [index, change] of order.entries()) {
        const pr = prs[index];
        if (pr === undefined || pr.prNumber === null) throw new Error("two PRs");
        codeHost.changePull(pr.repo.fullName, pr.prNumber, change);
        const delivery = codeHost.pullRequestDelivery(pr.repo.fullName, pr.prNumber, "closed");
        const payload: unknown = JSON.parse(delivery.body);
        await githubWebhookHandler({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost, secretStore, logger })({
          organizationId: world.organizationId,
          connectionId: connectionIdSchema.parse(connection.connectionId),
          deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
          event: "pull_request",
          payload,
          receivedAt: Date.now(),
          logger,
        });
        const state = (await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state;
        expect(state).toBe(index === 0 ? "in_review" : final);
      }
    }
  });

  it("F-098: a repo added joins the task's next session with no branch, never its open one", async () => {
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    await test.db.taskRepo.create({ data: { organizationId: world.organizationId, projectId, taskId: task.taskId, repoId: secondRepoId, branchName, baseBranch: "trunk" } });
    await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { ahead: true, state: "pr_open", headSha: gitShaSchema.parse("f".repeat(40)) } });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "idle" } });
    const FOURTH = repoFullNameSchema.parse("ostra-test/test4");
    listOnHost(FOURTH);
    const added = await addProjectRepo(repoDeps(), admin(), { projectId, fullName: FOURTH });
    if (!added.ok) throw new Error(added.error);
    try {
      // The open session keeps its two repos.
      expect(await test.db.taskRepo.count({ where: { taskId: task.taskId } })).toBe(2);
      const timers: SessionTimers = { sessionMaxMs: 60_000, boxReleaseIdleMs: 60_000, cancelInTx: () => Promise.resolve(false) };
      const scope = scopeOf(fixture.a.member, "member");
      const reopened = await test.db.$transaction((tx) =>
        reopenTask(
          { tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, spendCap: { capMicroUsd: 25_000_000, capTokens: 10_000_000 }, timers },
          { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Also update the docs." },
        ),
      );
      expect(reopened.ok).toBe(true);
      const repos = await test.db.taskRepo.findMany({ where: { taskId: task.taskId }, select: { repoId: true, state: true, branchName: true, headSha: true } });
      expect(repos).toHaveLength(3);
      expect(repos.find((row) => row.repoId === added.repoId)).toEqual({ repoId: added.repoId, state: "no_branch", branchName, headSha: null });
    } finally {
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested", subState: null } });
      await test.db.taskRepo.deleteMany({ where: { repoId: added.repoId } });
      await test.db.repo.delete({ where: { id: added.repoId } });
    }
  });
});
