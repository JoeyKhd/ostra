import { randomUUID } from "node:crypto";

import { createLogger, silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { LinearAdapter } from "@ostra/adapter-linear";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { attachBoard, isProgressComment, postgresAuditLog, postgresChangeNotices, saveBoardMapping, startTicketTask, systemClock } from "@ostra/domain";
import type { BoardMapping, ConnectionTracker, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { boardIdSchema, connectionIdSchema, organizationIdSchema, repoIdSchema, taskSeqSchema, ticketWriteIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ExternalTicketId, RepoId, SessionId, TaskId, TicketKey } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { githubWebhookHandler } from "../code-host/pull-requests.ts";
import { openPullRequestsHandler } from "../reactions/session-end.ts";
import { scopeOf } from "../testing/automations.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedTicketRow, seedTrackerConnection } from "../testing/tickets.ts";
import { jobContext, sha } from "../testing/turns.ts";
import { INSTALLATION_ID, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { createConnectionTrackers } from "./connections.ts";
import { taskUrlOf, ticketSyncHandler } from "./writer.ts";

// F-031 (ticket sync) on the shipped Linear adapter against the fake Linear server, through the real
// paths: boards attached by `attachBoard` (the mapping drafted from the team's status types and
// Linear's GitHub integration check), tasks started by `startTicketTask`, PRs opened by the
// `task.open-pull-requests` job, merges from the GitHub App's webhook, and every ticket write
// applied by `ticket.sync`. Only the session between the start and its PR is skipped: the task is
// set running with its branch pushed, as a session's end leaves it.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let fake: FakeLinear;
let linear: LinearAdapter;
let connectionId: ConnectionId;
let secondRepoId: RepoId;
let ownBoard: { readonly boardId: BoardId; readonly mapping: BoardMapping; readonly integrationInstalled: boolean };
let integratedBoard: { readonly boardId: BoardId; readonly mapping: BoardMapping; readonly integrationInstalled: boolean };
let integratedTeam: { readonly id: string; readonly key: string };
let admin: MemberScope;
let member: MemberScope;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const PUBLIC_URL = "http://localhost:3000";

const tracker = (): ConnectionTracker => ({ connectionId, kind: "linear", name: "Acme Linear", tracker: linear, ownUserId: fake.appUser()?.id ?? null });
const boardDeps = () => ({ scope: admin, tracker: tracker(), notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock });

const attach = async (teamExternalId: string) => {
  const attached = await test.db.$transaction((tx) => attachBoard({ tx, ...boardDeps() }, { projectId: world.projectId, connectionId, externalId: teamExternalId }));
  if (!attached.ok) throw new Error(`attach: ${attached.message}`);
  return { boardId: attached.boardId, mapping: attached.mapping, integrationInstalled: attached.integrationInstalled };
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The project's second repo, which the App's installation lists too.
  const first = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
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
  codeHost.repos.set(INSTALLATION_ID, [
    ...(codeHost.repos.get(INSTALLATION_ID) ?? []),
    { hostRepoId: "host-ostra-test/test2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" },
  ]);
  admin = scopeOf(fixture.a.admin, "admin");
  member = scopeOf(fixture.a.member, "member");

  // Organization A's Linear app on the fake Linear server, and two of its teams as the project's boards:
  // the first attached while Linear's GitHub integration isn't installed, the second once it is.
  fake = await createFakeLinear();
  fake.createApp({ name: "ostra", redirectUris: [`${PUBLIC_URL}/api/linear/callback`], webhookUrl: null });
  const token = fake.mintToken("app");
  connectionId = await seedTrackerConnection(test.db, secretStore, world.organizationId, { token: token.accessToken, appUserId: fake.appUser()?.id ?? null });
  linear = new LinearAdapter({ auth: { kind: "oauth", token: token.accessToken }, apiUrl: fake.apiUrl }, { logger: silentLogger, clock: adapterClock });
  const other = fake.addTeam("WEB", "Website");
  integratedTeam = { id: other.id, key: other.key };
  ownBoard = await attach(fake.team.id);
  fake.setGithubIntegration(true);
  integratedBoard = await attach(integratedTeam.id);
});

afterAll(async () => {
  await fake.close();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

/** A status of a team on the fake Linear, by its name. */
const stateId = (teamId: string, name: string): string => {
  const found = fake.states(teamId).find((state) => state.name === name);
  if (found === undefined) throw new Error(`no status ${name}`);
  return found.id;
};

/** Applies every pending write of the task through `ticket.sync`, as the queue would, oldest first. */
const syncTicket = async (taskId: TaskId): Promise<void> => {
  const trackers = createConnectionTrackers({
    db: test.db,
    secretStore,
    clock: systemClock,
    logger,
    build: (input) => new LinearAdapter({ auth: { kind: "oauth", token: input.token }, apiUrl: fake.apiUrl }, input.context),
  });
  const handler = ticketSyncHandler({ db: test.db, trackers, clock: systemClock, publicUrl: PUBLIC_URL, logger, attemptDeadlineMs: 1500 });
  for (let round = 0; round < 4; round += 1) {
    const pending = await test.db.ticketWrite.findMany({ where: { taskId, state: "pending" }, orderBy: { createdAt: "asc" } });
    if (pending.length === 0) break;
    for (const row of pending) {
      await handler(jobContext("ticket.sync", { organizationId: world.organizationId, ticketWriteId: ticketWriteIdSchema.parse(row.id) }, logger)).catch(() => undefined);
    }
  }
  expect(await test.db.ticketWrite.count({ where: { taskId, state: { not: "done" } } })).toBe(0);
};

type Started = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly issueId: ExternalTicketId; readonly key: TicketKey };

/** A person files an issue on the team, ostra caches it, and a member starts its task from the Inbox. */
const startOn = async (board: { readonly boardId: BoardId }, teamId: string, title: string): Promise<Started> => {
  const issue = await fake.createIssue({ teamId, title });
  const read = await linear.getTicket({ externalId: teamId }, { externalId: issue.id });
  if (!read.ok) throw new Error(read.error.message);
  const ticketId = await seedTicketRow(test.db, { organizationId: world.organizationId, projectId: world.projectId, boardId: board.boardId, connectionId, ticket: read.value });
  const started = await test.db.$transaction((tx) =>
    startTicketTask({ tx, scope: member, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, publicUrl: PUBLIC_URL }, { projectId: world.projectId, ticketId }),
  );
  if (!started.ok) throw new Error(`start: ${started.message}`);
  return { taskId: started.taskId, sessionId: started.sessionId, issueId: issue.id, key: issue.identifier };
};

/** The session pushed the repo's branch and ended with changes; then the PR job runs, as its reaction sends it. */
const openPr = async (task: Started, repoId: RepoId, word: string): Promise<{ readonly number: number; readonly url: string; readonly fullName: string }> => {
  await test.db.task.updateMany({ where: { id: task.taskId, state: "queued" }, data: { state: "running" } });
  await test.db.taskRepo.updateMany({ where: { taskId: task.taskId, repoId }, data: { state: "branch_pushed", ahead: true, headSha: sha(word), prBody: `The ${word} change.` } });
  await openPullRequestsHandler({
    db: test.db,
    jobs,
    notices: postgresChangeNotices,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
    publicUrl: PUBLIC_URL,
    logger,
  })(jobContext("task.open-pull-requests", { organizationId: world.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: taskSeqSchema.parse(1) }, logger));
  const row = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId, repoId }, include: { repo: { select: { fullName: true } } } });
  if (row.prNumber === null || row.prUrl === null) throw new Error("no PR");
  return { number: row.prNumber, url: row.prUrl, fullName: row.repo.fullName };
};

/** The PR merges on the host, and the App's webhook says so. */
const mergePr = async (pr: { readonly number: number; readonly fullName: string }): Promise<void> => {
  codeHost.changePull(pr.fullName, pr.number, "merge");
  const github = await test.db.connection.findFirstOrThrow({ where: { organizationId: world.organizationId, kind: "github" } });
  const handled = await githubWebhookHandler({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost, secretStore, logger })({
    organizationId: organizationIdSchema.parse(world.organizationId),
    connectionId: connectionIdSchema.parse(github.id),
    deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
    event: "pull_request",
    payload: JSON.parse(codeHost.pullRequestDelivery(pr.fullName, pr.number, "closed").body),
    receivedAt: Date.now(),
    logger,
  });
  expect(handled).toEqual({ outcome: "processed" });
};

const movesOf = async (taskId: TaskId): Promise<readonly string[]> =>
  (await test.db.ticketWrite.findMany({ where: { taskId, kind: "move" }, orderBy: { createdAt: "asc" }, select: { idempotencyKey: true } })).map((row) => row.idempotencyKey.split(":move:")[1] ?? "");

describe("ticket sync's mapping (F-031)", () => {
  it("F-031/c3,c4: each board's mapping is drafted from its team's status types, with done left to Linear's GitHub integration only where it's installed", () => {
    const team = fake.team.id;
    expect(ownBoard.mapping).toEqual({
      open: [stateId(team, "Triage"), stateId(team, "Backlog"), stateId(team, "Todo")],
      started: stateId(team, "In Progress"),
      inReview: stateId(team, "In Review"),
      done: stateId(team, "Done"),
      doneBy: "ostra",
      magicWord: "Closes",
    });
    expect(ownBoard.integrationInstalled).toBe(false);
    expect(integratedBoard).toMatchObject({ integrationInstalled: true, mapping: { started: stateId(integratedTeam.id, "In Progress"), done: stateId(integratedTeam.id, "Done"), doneBy: "integration" } });
  });
});

describe("ticket sync through a task's life (F-031)", () => {
  it("F-031/c1,c2: the start moves the ticket to started; the first PR links it and moves it to in review; the task's next PR is linked and moves it no more", async () => {
    const task = await startOn(ownBoard, fake.team.id, "Add a pricing page");
    await syncTicket(task.taskId);
    let view = fake.issueView(task.issueId);
    expect(view.stateId).toBe(ownBoard.mapping.started);
    expect(view.attachments.map((attachment) => attachment.url)).toContain(taskUrlOf(PUBLIC_URL, task.taskId));
    expect(view.comments.filter((comment) => isProgressComment(comment.body))).toHaveLength(1);

    const first = await openPr(task, repoIdSchema.parse(world.repoId), "pricing-app");
    await syncTicket(task.taskId);
    view = fake.issueView(task.issueId);
    expect(view.stateId).toBe(ownBoard.mapping.inReview);
    expect(view.attachments.filter((attachment) => attachment.url === first.url)).toHaveLength(1);

    // A person moves the ticket back while the work goes on; the task's second PR doesn't move it again.
    const back = await linear.updateStatus({ externalId: fake.team.id }, task.key, ownBoard.mapping.started);
    expect(back.ok).toBe(true);
    const second = await openPr(task, secondRepoId, "pricing-api");
    await syncTicket(task.taskId);
    view = fake.issueView(task.issueId);
    expect(view.stateId).toBe(ownBoard.mapping.started);
    expect(view.attachments.filter((attachment) => attachment.url === second.url)).toHaveLength(1);
    // Its progress: one comment, edited in place, listing both PRs.
    const progress = view.comments.filter((comment) => isProgressComment(comment.body));
    expect(progress).toHaveLength(1);
    expect(progress[0]?.body).toContain(`ostra-test/test1: ${first.url} (open)`);
    expect(progress[0]?.body).toContain(`ostra-test/test2: ${second.url} (open)`);
    expect(await movesOf(task.taskId)).toEqual(["started", "in-review"]);
  });

  it("F-031/c3: on a merge ostra moves the ticket to done only on the board without Linear's GitHub integration; on the other, done is left to it", async () => {
    const own = await startOn(ownBoard, fake.team.id, "Add an about page");
    const integrated = await startOn(integratedBoard, integratedTeam.id, "Add a contact page");
    const ownPr = await openPr(own, repoIdSchema.parse(world.repoId), "about");
    const integratedPr = await openPr(integrated, repoIdSchema.parse(world.repoId), "contact");
    await syncTicket(own.taskId);
    await syncTicket(integrated.taskId);
    expect(fake.issueView(integrated.issueId).stateId).toBe(integratedBoard.mapping.inReview);

    await mergePr(ownPr);
    await mergePr(integratedPr);
    await syncTicket(own.taskId);
    await syncTicket(integrated.taskId);
    expect((await test.db.task.findUniqueOrThrow({ where: { id: own.taskId } })).state).toBe("merged");
    expect((await test.db.task.findUniqueOrThrow({ where: { id: integrated.taskId } })).state).toBe("merged");
    expect(fake.issueView(own.issueId).stateId).toBe(ownBoard.mapping.done);
    expect(await movesOf(own.taskId)).toEqual(["started", "in-review", "done"]);
    // Linear's integration moves this one when it sees the merge: ostra writes no move and leaves it in review.
    expect(fake.issueView(integrated.issueId).stateId).toBe(integratedBoard.mapping.inReview);
    expect(await movesOf(integrated.taskId)).toEqual(["started", "in-review"]);
    // Both comments say it merged.
    for (const task of [own, integrated]) {
      expect(fake.issueView(task.issueId).comments.find((comment) => isProgressComment(comment.body))?.body).toContain("(merged)");
    }
  });

  it("F-031/c4: a board's mapping changed by its admin is what ticket sync then does: done by ostra, and Refs in place of Closes", async () => {
    const changed: BoardMapping = { ...integratedBoard.mapping, doneBy: "ostra", magicWord: "Refs" };
    const saved = await test.db.$transaction((tx) => saveBoardMapping({ tx, ...boardDeps() }, { boardId: boardIdSchema.parse(integratedBoard.boardId), mapping: changed }));
    expect(saved).toMatchObject({ ok: true, mapping: changed });
    // A member can't change it.
    const refused = await test.db.$transaction((tx) => saveBoardMapping({ tx, ...boardDeps(), scope: member }, { boardId: integratedBoard.boardId, mapping: integratedBoard.mapping }));
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });

    const task = await startOn(integratedBoard, integratedTeam.id, "Add a careers page");
    const pr = await openPr(task, repoIdSchema.parse(world.repoId), "careers");
    const body = codeHost.pulls.find((pull) => pull.repo === pr.fullName && pull.number === pr.number)?.body ?? "";
    expect(body).toContain(`Refs ${task.key}`);
    expect(body).not.toContain(`Closes ${task.key}`);
    await mergePr(pr);
    await syncTicket(task.taskId);
    expect(fake.issueView(task.issueId).stateId).toBe(changed.done);
    expect(await movesOf(task.taskId)).toEqual(["started", "in-review", "done"]);
  });
});
