import { randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord, TrackerAdapter } from "@ostra/adapter-sdk";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear, JiraSite } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  moveTaskInTx,
  postgresChangeNotices,
  postgresIdempotencyStore,
  postgresRateBudgetStore,
  retryTicketSyncInTx,
  systemClock,
  writeTicketStepsInTx,
} from "@ostra/domain";
import type { TicketSyncTrigger } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { mapTask } from "@ostra/db";
import { connectionIdSchema, externalTicketIdSchema, organizationIdSchema, repoIdSchema, ticketWriteIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, TaskId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeSecretStore } from "../testing/fake-adapters.ts";
import { mappingFor, seedBoard, seedTicketRow, seedTicketTask, seedTrackerConnection } from "../testing/tickets.ts";
import { createConnectionTrackers } from "./connections.ts";
import { drainTicketWrites, taskUrlOf, ticketSyncHandler } from "./writer.ts";
import type { TicketWriterDeps } from "./writer.ts";

// Ticket 15's cases, against the Jira fake and the fake Linear server: each step writes once; a
// write applied and then answered 500 isn't repeated, and the control without the lookup repeats
// it (F-046, ADR 0037); a replayed change writes nothing new; "in review" moves at the first PR
// only; "done" only with `doneBy: ostra`; the progress comment is edited, never added again; a
// failed write leaves the task running.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => {
  records.push(record);
});
const PUBLIC_URL = "https://ostra.example";

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
});

afterAll(async () => {
  await jobs.stop({ graceful: false });
  await test.dispose();
});

type Bench = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly connectionId: ConnectionId;
  readonly boardId: BoardId;
  readonly deps: (overrides?: Partial<TicketWriterDeps>) => TicketWriterDeps;
};

/** A board on organization A's open project, on a connection whose tracker `tracker` builds. */
const bench = async (
  tracker: TrackerAdapter,
  board: { readonly externalId: string; readonly mappingFrom: TrackerAdapter; readonly doneBy: "ostra" | "integration" },
  options: { readonly appUserId?: string | null; readonly connectionId?: ConnectionId; readonly where?: "a-open" | "a-restricted" | "b" } = {},
): Promise<Bench> => {
  const where = options.where ?? "a-open";
  const organizationId = where === "b" ? fixture.b.organization.id : fixture.a.organization.id;
  const projectId = where === "b" ? fixture.b.project.id : where === "a-restricted" ? fixture.a.restrictedProject.id : fixture.a.openProject.id;
  const connectionId = options.connectionId ?? (await seedTrackerConnection(test.db, secretStore, organizationId, { appUserId: options.appUserId ?? null }));
  const statuses = await board.mappingFrom.listStatuses({ externalId: board.externalId });
  if (!statuses.ok) throw new Error(statuses.error.message);
  const boardId = await seedBoard(test.db, {
    organizationId,
    projectId,
    connectionId,
    externalId: board.externalId,
    mapping: mappingFor(statuses.value, board.doneBy),
  });
  const trackers = createConnectionTrackers({ db: test.db, secretStore, clock: systemClock, logger, build: () => tracker });
  return {
    organizationId,
    projectId,
    connectionId,
    boardId,
    deps: (overrides = {}) => ({ db: test.db, trackers, clock: systemClock, publicUrl: PUBLIC_URL, logger, attemptDeadlineMs: 1500, ...overrides }),
  };
};

const ticketTask = async (b: Bench, ticket: Awaited<ReturnType<TrackerAdapter["getTicket"]>>, state: "running" | "queued" = "running") => {
  if (!ticket.ok) throw new Error(ticket.error.message);
  const ticketId = await seedTicketRow(test.db, { organizationId: b.organizationId, projectId: b.projectId, boardId: b.boardId, connectionId: b.connectionId, ticket: ticket.value });
  const taskId = await seedTicketTask(test.db, { organizationId: b.organizationId, projectId: b.projectId, boardId: b.boardId, ticketId, ticketKey: ticket.value.key, state });
  return { taskId, ticketId };
};

const write = (taskId: TaskId, trigger: TicketSyncTrigger) => test.db.$transaction((tx) => writeTicketStepsInTx({ tx }, { taskId, trigger }));
const started = (taskId: TaskId): TicketSyncTrigger => ({ kind: "task-started", taskUrl: taskUrlOf(PUBLIC_URL, taskId), taskTitle: "Fix the login page" });

/** Runs `ticket.sync` for every pending write of the task as the queue would: retried until it's marked. */
const syncAll = async (deps: TicketWriterDeps, taskId: TaskId): Promise<void> => {
  const handler = ticketSyncHandler(deps);
  const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { organizationId: true } });
  for (let pass = 0; pass < 20; pass += 1) {
    const pending = await test.db.ticketWrite.findMany({ where: { taskId, state: "pending" }, orderBy: { createdAt: "asc" } });
    if (pending.length === 0) return;
    for (const row of pending) {
      const retryCount = row.attempts;
      await handler({
        job: "ticket.sync",
        jobId: jobIdSchema.parse(randomUUID()),
        key: null,
        retryCount,
        payload: { organizationId: organizationIdSchema.parse(task.organizationId), ticketWriteId: ticketWriteIdSchema.parse(row.id) },
        logger,
      }).catch(() => undefined);
    }
  }
};

const writesOf = (taskId: TaskId) => test.db.ticketWrite.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });

const addPullRequest = async (b: Bench, taskId: TaskId, name: string, state: "pr_open" | "merged" | "closed_unmerged" = "pr_open") => {
  const connection = await test.db.connection.create({ data: { organizationId: b.organizationId, kind: "github", appId: String(Math.floor(Math.random() * 1e9)) } });
  await seedInstallation(test.db, { organizationId: b.organizationId, connectionId: connection.id, installationId: "1" });
  const repo = await test.db.repo.create({
    data: { organizationId: b.organizationId, projectId: b.projectId, connectionId: connection.id, installationId: "1", hostRepoId: randomUUID(), fullName: `ostra-test/${name}`, defaultBranch: "main", checkoutDir: name },
  });
  const url = `https://github.example/ostra-test/${name}/pull/1`;
  await test.db.taskRepo.create({
    data: { organizationId: b.organizationId, projectId: b.projectId, taskId, repoId: repo.id, branchName: "ostra/x", baseBranch: "main", state, prNumber: 1, prUrl: url },
  });
  return { repoId: repoIdSchema.parse(repo.id), url };
};

describe("the tracker writer, on the Jira fake", () => {
  let site: JiraSite;
  let jira: JiraFakeAdapter;
  let b: Bench;
  const projectId = (): string => site.projects[0]?.id ?? "";
  const newTicket = async () => {
    const issue = site.createIssue(projectId(), { summary: "Login page is broken" });
    return ticketTask(b, await jira.getTicket({ externalId: projectId() }, { externalId: issue.externalId }));
  };
  const issueOf = (ticketId: TicketId) => test.db.ticket.findUniqueOrThrow({ where: { id: ticketId } }).then((row) => site.issues.get(externalTicketIdSchema.parse(row.externalId)));

  beforeAll(async () => {
    site = createJiraSite();
    jira = new JiraFakeAdapter({ site });
    b = await bench(jira, { externalId: site.projects[0]?.id ?? "", mappingFrom: jira, doneBy: "ostra" }, { appUserId: site.appAccountId });
  });

  it("the start moves the ticket to started, makes one comment with the task's link, and links the task, once each", async () => {
    const { taskId, ticketId } = await newTicket();
    expect(await write(taskId, started(taskId))).toHaveLength(3);
    // The same start replayed writes nothing new.
    expect(await write(taskId, started(taskId))).toHaveLength(0);
    await syncAll(b.deps(), taskId);
    const issue = await issueOf(ticketId);
    expect(issue?.statusId).toBe("10001");
    expect(issue?.comments).toHaveLength(1);
    expect(issue?.remoteLinks.map((link) => link.url)).toEqual([taskUrlOf(PUBLIC_URL, taskId)]);
    const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.progressCommentId).toBe(issue?.comments[0]?.id);
    expect((await writesOf(taskId)).every((row) => row.state === "done")).toBe(true);
    // Run every row's job again (a replayed job): nothing more on the ticket.
    await test.db.ticketWrite.updateMany({ where: { taskId }, data: { state: "pending" } });
    await syncAll(b.deps(), taskId);
    expect((await issueOf(ticketId))?.comments).toHaveLength(1);
    expect((await issueOf(ticketId))?.remoteLinks).toHaveLength(1);
  });

  it("a PR links, moves to in review at the first PR only, and the comment is edited in place, never added", async () => {
    const { taskId, ticketId } = await newTicket();
    await write(taskId, started(taskId));
    await syncAll(b.deps(), taskId);
    const first = await addPullRequest(b, taskId, `repo-${randomUUID().slice(0, 6)}`);
    expect((await write(taskId, { kind: "pr-opened", repoId: first.repoId, number: 1, url: first.url })).map((row) => row.kind).sort()).toEqual(["comment_update", "link_pr", "move"]);
    await syncAll(b.deps(), taskId);
    let issue = await issueOf(ticketId);
    expect(issue?.statusId).toBe("10002");
    expect(issue?.comments).toHaveLength(1);
    expect(JSON.stringify(issue?.comments[0]?.body)).toContain(first.url);
    // A second PR: its link and an edit, no second move.
    const second = await addPullRequest(b, taskId, `repo-${randomUUID().slice(0, 6)}`);
    expect((await write(taskId, { kind: "pr-opened", repoId: second.repoId, number: 1, url: second.url })).map((row) => row.kind).sort()).toEqual(["comment_update", "link_pr"]);
    await syncAll(b.deps(), taskId);
    issue = await issueOf(ticketId);
    expect(issue?.comments).toHaveLength(1);
    expect(JSON.stringify(issue?.comments[0]?.body)).toContain(second.url);
    expect((await writesOf(taskId)).filter((row) => row.kind === "move")).toHaveLength(2);
  });

  it("moves to done on a merge only when the board's doneBy is ostra", async () => {
    const { taskId, ticketId } = await newTicket();
    await write(taskId, started(taskId));
    const pr = await addPullRequest(b, taskId, `repo-${randomUUID().slice(0, 6)}`);
    await write(taskId, { kind: "pr-opened", repoId: pr.repoId, number: 1, url: pr.url });
    await syncAll(b.deps(), taskId);
    const merged = await write(taskId, { kind: "pr-merged", repoId: pr.repoId, changedAt: 1 });
    expect(merged.map((row) => row.kind).sort()).toEqual(["comment_update", "move"]);
    await syncAll(b.deps(), taskId);
    expect((await issueOf(ticketId))?.statusId).toBe("10003");

    // The same on a board whose tracker integration moves tickets to done itself.
    const integrationBench = await bench(jira, { externalId: projectId(), mappingFrom: jira, doneBy: "integration" }, { connectionId: b.connectionId, where: "a-restricted" });
    const issue = site.createIssue(projectId(), { summary: "Another" });
    const other = await ticketTask(integrationBench, await jira.getTicket({ externalId: projectId() }, { externalId: issue.externalId }));
    const otherPr = await addPullRequest(integrationBench, other.taskId, `repo-${randomUUID().slice(0, 6)}`);
    const writes = await write(other.taskId, { kind: "pr-merged", repoId: otherPr.repoId, changedAt: 1 });
    expect(writes.map((row) => row.kind)).toEqual(["comment_update"]);
  });

  it("F-046/c1,c2: a comment applied and then answered 500 isn't made again; the control without the lookup makes it twice", async () => {
    for (const lookupBeforeRetry of [true, false]) {
      const { taskId, ticketId } = await newTicket();
      await test.db.$transaction((tx) =>
        tx.ticketWrite.create({
          data: {
            organizationId: b.organizationId,
            projectId: b.projectId,
            taskId,
            boardId: b.boardId,
            ticketId,
            kind: "comment",
            payload: { kind: "comment", markdown: "ostra: started" },
            idempotencyKey: `ticket-write:${taskId}:comment`,
          },
        }),
      );
      site.injectFault({ kind: "fail-after-write" });
      await syncAll(b.deps({ lookupBeforeRetry }), taskId);
      const comments = (await issueOf(ticketId))?.comments ?? [];
      expect(comments).toHaveLength(lookupBeforeRetry ? 1 : 2);
      const [row] = await writesOf(taskId);
      expect(row?.state).toBe("done");
      expect(row?.attempts).toBe(2);
    }
  });

  // No F-046 key: the move's own lookup is the Jira fake's (`moveTicket` writes nothing when the
  // ticket is already there), not ostra's, so this can't show ostra's guard. Linear's case below
  // counts the real adapter's writes.
  it("a status move applied and then answered 500 is retried on the Jira fake, and the ticket's status changes once", async () => {
    const { taskId, ticketId } = await newTicket();
    await write(taskId, started(taskId));
    // The move alone: the comment and the link have their own cases.
    await test.db.ticketWrite.deleteMany({ where: { taskId, kind: { not: "move" } } });
    const externalId = externalTicketIdSchema.parse((await test.db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).externalId);
    const changes: string[] = [];
    let calls = 0;
    const move = jira.moveTicket.bind(jira);
    jira.moveTicket = async (...args) => {
      calls += 1;
      const before = site.statusOf(externalId);
      const result = await move(...args);
      if (site.statusOf(externalId) !== before) changes.push(site.statusOf(externalId));
      return result;
    };
    try {
      site.injectFault({ kind: "fail-after-write" });
      await syncAll(b.deps(), taskId);
    } finally {
      jira.moveTicket = move;
    }
    // Jira applied the first call and answered 500; the retry found the ticket already there.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(changes).toEqual(["10001"]);
    expect((await writesOf(taskId)).map((row) => [row.kind, row.state])).toEqual([["move", "done"]]);
  });

  it("a replayed state change writes nothing new: a move the lifecycle refuses edits nothing", async () => {
    const { taskId } = await newTicket();
    const stop = async (): Promise<boolean> =>
      test.db.$transaction(async (tx) => moveTaskInTx({ tx, notices: postgresChangeNotices, jobs }, mapTask(await tx.task.findUniqueOrThrow({ where: { id: taskId } })), { type: "stop", reason: "requested" }));
    expect(await stop()).toBe(true);
    const after = await writesOf(taskId);
    expect(after.filter((row) => row.kind === "comment_update")).toHaveLength(1);
    expect(await stop()).toBe(false);
    expect(await writesOf(taskId)).toHaveLength(after.length);
  });

  it("a write that keeps failing is marked failed with its reason, the task keeps running, and Retry sync sends it again", async () => {
    const { taskId } = await newTicket();
    // A mapping whose started status the ticket can't reach: the move fails for good.
    await test.db.board.update({ where: { id: b.boardId }, data: { statusMap: {} } });
    await write(taskId, started(taskId));
    await syncAll(b.deps(), taskId);
    const move = (await writesOf(taskId)).find((row) => row.kind === "move");
    expect(move).toMatchObject({ state: "failed", error: "the board has no status mapping" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: taskId } })).state).toBe("running");
    const statuses = await jira.listStatuses({ externalId: projectId() });
    if (!statuses.ok) throw new Error("no statuses");
    await test.db.board.update({ where: { id: b.boardId }, data: { statusMap: mappingFor(statuses.value, "ostra") } });
    expect(await test.db.$transaction((tx) => retryTicketSyncInTx({ tx, jobs }, taskId))).toBe(1);
    expect(await jobs.find("ticket.sync", { organizationId: b.organizationId, ticketWriteId: ticketWriteIdSchema.parse(move?.id) })).toHaveLength(1);
    await syncAll(b.deps(), taskId);
    expect((await writesOf(taskId)).every((row) => row.state === "done")).toBe(true);
  });

  it("a rate limit is retried and then applied; a connection that isn't active fails its writes visibly", async () => {
    const { taskId, ticketId } = await newTicket();
    await write(taskId, { kind: "task-started", taskUrl: taskUrlOf(PUBLIC_URL, taskId), taskTitle: "x" });
    site.injectFault({ kind: "rate-limited", retryAfterSeconds: 0 });
    await syncAll(b.deps(), taskId);
    expect((await issueOf(ticketId))?.statusId).toBe("10001");

    const failedConnection = await bench(jira, { externalId: projectId(), mappingFrom: jira, doneBy: "ostra" }, { where: "b" });
    const issue = site.createIssue(projectId(), { summary: "Stranded" });
    const stranded = await ticketTask(failedConnection, await jira.getTicket({ externalId: projectId() }, { externalId: issue.externalId }));
    // Written while the connection was active, applied after it failed: each fails, visibly.
    await write(stranded.taskId, started(stranded.taskId));
    await test.db.connection.update({ where: { id: failedConnection.connectionId }, data: { state: "failed" } });
    await syncAll(failedConnection.deps(), stranded.taskId);
    const rows = await writesOf(stranded.taskId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.state === "failed" && (row.error ?? "").includes("the connection is failed"))).toBe(true);
    // Milestone 11 (ADR 0071): its board is paused now, and ticket sync writes nothing more to it.
    expect(await write(stranded.taskId, { kind: "progress", reason: "state", revision: "paused:1" })).toEqual([]);
    expect(await writesOf(stranded.taskId)).toHaveLength(rows.length);
  });

  it("Create ticket makes one ticket holding the task's link, caches it, links the task, and survives a 500 after the create", async () => {
    const taskId = await seedTicketTask(test.db, { organizationId: b.organizationId, projectId: b.projectId, boardId: null, ticketId: null });
    const writes = await write(taskId, { kind: "create-ticket", boardId: b.boardId, title: "Made from a prompt", description: "Untrusted text" });
    expect(writes.map((row) => row.kind)).toEqual(["create"]);
    site.injectFault({ kind: "fail-after-write" });
    const before = site.issues.size;
    await syncAll(b.deps(), taskId);
    expect(site.issues.size).toBe(before + 1);
    const task = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.ticketId).not.toBeNull();
    expect(task.boardId).toBe(b.boardId);
    const made = [...site.issues.values()].at(-1);
    expect(made?.remoteLinks.map((link) => link.url)).toEqual([taskUrlOf(PUBLIC_URL, taskId)]);
    expect(made?.comments).toHaveLength(1);
  });

  it("the drain sends every pending write's job once", async () => {
    const { taskId } = await newTicket();
    const written = await write(taskId, started(taskId));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await drainTicketWrites({ db: test.db, jobs, clock: systemClock })).toBeGreaterThanOrEqual(written.length);
    await drainTicketWrites({ db: test.db, jobs, clock: systemClock });
    for (const row of written) {
      expect(await jobs.find("ticket.sync", { organizationId: b.organizationId, ticketWriteId: row.id })).toHaveLength(1);
    }
  });

  it("logs IDs and kinds, never a comment's or a ticket's text", () => {
    const text = JSON.stringify(records);
    expect(text).not.toContain("Untrusted text");
    expect(text).not.toContain("ostra is working on this");
  });
});

describe("the tracker writer, on the fake Linear server", () => {
  let fake: FakeLinear;
  let linear: LinearAdapter;
  let b: Bench;

  beforeAll(async () => {
    fake = await createFakeLinear();
    fake.createApp({ name: "ostra", redirectUris: ["https://ostra.example/callback"], webhookUrl: null });
    const token = fake.mintToken("app");
    const organizationId = fixture.a.organization.id;
    linear = new LinearAdapter(
      { auth: { kind: "oauth", token: token.accessToken }, apiUrl: fake.apiUrl },
      { logger, clock: systemClock, rateBudgets: postgresRateBudgetStore(test.db, organizationId), idempotency: postgresIdempotencyStore(test.db, organizationId) },
    );
    // Organization A already has its Linear connection: this board is on the restricted project, on it.
    const jiraBoard = await test.db.board.findFirstOrThrow({ where: { projectId: fixture.a.openProject.id } });
    // Its own user is the fake's app user now: the marker lookup checks a comment's author.
    await test.db.connection.update({ where: { id: jiraBoard.connectionId }, data: { appUserId: fake.appUser()?.id ?? null } });
    b = await bench(linear, { externalId: fake.team.id, mappingFrom: linear, doneBy: "ostra" }, { connectionId: connectionIdSchema.parse(jiraBoard.connectionId), where: "a-restricted" });
  });

  afterAll(async () => {
    await fake.close();
  });

  const newTicket = async () => {
    const issue = await fake.createIssue({ title: "Login page is broken" });
    return { ...(await ticketTask(b, await linear.getTicket({ externalId: fake.team.id }, { externalId: issue.id }))), issueId: issue.id };
  };

  it("writes the start, a PR and a merge once each, editing one comment", async () => {
    const { taskId, issueId } = await newTicket();
    await write(taskId, started(taskId));
    await syncAll(b.deps(), taskId);
    const inProgress = fake.states(fake.team.id).find((state) => state.name === "In Progress")?.id;
    expect(fake.issueView(issueId).stateId).toBe(inProgress);
    expect(fake.issueView(issueId).comments).toHaveLength(1);
    expect(fake.issueView(issueId).attachments.map((attachment) => attachment.url)).toContain(taskUrlOf(PUBLIC_URL, taskId));
    const pr = await addPullRequest(b, taskId, `repo-${randomUUID().slice(0, 6)}`);
    await write(taskId, { kind: "pr-opened", repoId: pr.repoId, number: 1, url: pr.url });
    await syncAll(b.deps(), taskId);
    await write(taskId, { kind: "pr-merged", repoId: pr.repoId, changedAt: 5 });
    await syncAll(b.deps(), taskId);
    const view = fake.issueView(issueId);
    expect(view.stateId).toBe(fake.states(fake.team.id).find((state) => state.name === "Done")?.id);
    expect(view.comments).toHaveLength(1);
    expect(view.comments[0]?.body).toContain(pr.url);
    expect(view.attachments.filter((attachment) => attachment.url === pr.url)).toHaveLength(1);
  });

  it("F-046/c1,c2: a comment applied and answered 500 is found by its marker, and the control makes it twice", async () => {
    for (const lookupBeforeRetry of [true, false]) {
      const { taskId, issueId } = await newTicket();
      await write(taskId, started(taskId));
      await test.db.ticketWrite.deleteMany({ where: { taskId, kind: { not: "comment" } } });
      fake.injectFaults([{ kind: "fail-after-write" }]);
      await syncAll(b.deps({ lookupBeforeRetry }), taskId);
      expect(fake.issueView(issueId).comments).toHaveLength(lookupBeforeRetry ? 1 : 2);
    }
  });

  it("F-046/c1: a status move applied and answered 500 is retried, and Linear's issue is updated once", async () => {
    const { taskId, issueId } = await newTicket();
    await write(taskId, started(taskId));
    await test.db.ticketWrite.deleteMany({ where: { taskId, kind: { not: "move" } } });
    let calls = 0;
    const move = linear.moveTicket.bind(linear);
    linear.moveTicket = (...args) => {
      calls += 1;
      return move(...args);
    };
    const updates = fake.apiCalls()["issueUpdate"] ?? 0;
    try {
      fake.injectFaults([{ kind: "fail-after-write" }]);
      await syncAll(b.deps(), taskId);
    } finally {
      linear.moveTicket = move;
    }
    // Linear applied the first update and answered 500; the retry read the issue, already there.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((fake.apiCalls()["issueUpdate"] ?? 0) - updates).toBe(1);
    expect(fake.issueView(issueId).stateId).toBe(fake.states(fake.team.id).find((state) => state.name === "In Progress")?.id);
    expect((await writesOf(taskId)).map((row) => [row.kind, row.state])).toEqual([["move", "done"]]);
  });
});
