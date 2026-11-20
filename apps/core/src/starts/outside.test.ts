import { randomUUID } from "node:crypto";

import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  admitQueued,
  approveOutsideTask,
  dispatchTask,
  ensureBoxSizes,
  fanOutNotification,
  poolQueueInTx,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  rejectOutsideTask,
  setOutsideApproval,
  systemClock,
} from "@ostra/domain";
import type { JobQueue, MemberScope, Ports, ProjectRole } from "@ostra/domain";
import { seedPool, seedRunner } from "@ostra/domain/testing";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { agentSessionIdSchema, externalTicketIdSchema, leaseEpochSchema, memberIdSchema, needsYouItemIdSchema, projectIdSchema, sessionIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { AgentSessionId, ConnectionId, MemberId, OrganizationId, ProjectId, RunnerCapabilities, RunnerId, TaskId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { seedBoard, seedTicketRow, seedTrackerConnection } from "../testing/tickets.ts";
import { seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { matchStarterInTx, startFromTrackerInTx } from "./outside.ts";
import type { TrackerStartResult } from "./outside.ts";

// Milestone 6's ticket 14 (F-040, ADR 0057): a task a tracker user outside the project started
// waits for a member's approval, runs the project's default profile, and only ever on a pool. Every
// case runs the real start, the real answers and the real admission against Postgres.

const PUBLIC_URL = "https://ostra.example";

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let organizationId: OrganizationId;
let openProject: ProjectId;
let restrictedProject: ProjectId;
let connectionId: ConnectionId;
const boards = new Map<ProjectId, Awaited<ReturnType<typeof seedBoard>>>();
const enqueued: { readonly name: string; readonly payload: unknown }[] = [];
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();

const recordingJobs: JobQueue = {
  enqueueInTx: async (tx, name, payload, options) => {
    enqueued.push({ name, payload });
    await jobs.enqueueInTx(tx, name, payload, options);
  },
};

const ports = (): Ports => ({
  jobs: recordingJobs,
  outbox: postgresCommandOutbox,
  notices: postgresChangeNotices,
  audit: postgresAuditLog,
  clock: systemClock,
  adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
});

const deps = (db: Db = test.db) => ({ db, ...ports(), publicUrl: PUBLIC_URL });

const dockerCapabilities: RunnerCapabilities = { isolation: "container", services: true, boxSizes: true, snapshots: "image", registry: "optional", nodeWait: false };

const scopeOf = (member: SeededMember, role: "admin" | "member", projectRoles: ReadonlyMap<ProjectId, ProjectRole> = new Map()): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles,
});

const actor = { externalId: "lin-user-outside", name: "Sam Outside" };

/** A cached ticket on the project's board, and the agent session a delegation of it made. */
const delegated = async (projectId: ProjectId): Promise<{ readonly ticketId: TicketId; readonly agentSessionId: AgentSessionId }> => {
  const boardId = boards.get(projectId);
  if (boardId === undefined) throw new Error("no board");
  const suffix = randomUUID().slice(0, 6);
  const ticketId = await seedTicketRow(test.db, {
    organizationId,
    projectId,
    boardId,
    connectionId,
    ticket: {
      externalId: externalTicketIdSchema.parse(`ext-${suffix}`),
      key: ticketKeySchema.parse(`OST-${String(Math.floor(Math.random() * 90_000) + 1000)}`),
      title: "Make the login page faster",
      description: "It's slow. `rm -rf /` would not help.",
      status: { id: "st-todo", name: "Todo", category: "open" },
      url: `https://linear.example/OST-${suffix}`,
      labels: [],
      updatedAt: Date.now(),
      priority: null,
      parentKey: null,
      parentExternalId: null,
    },
  });
  const session = await test.db.agentSession.create({
    data: { organizationId, connectionId, externalSessionId: `ses-${suffix}`, projectId, ticketId, boardId, state: "awaiting_approval", creatorExternalId: actor.externalId, creatorName: actor.name },
  });
  return { ticketId, agentSessionId: agentSessionIdSchema.parse(session.id) };
};

const start = async (projectId: ProjectId, matchedMemberId: MemberId | null = null): Promise<Extract<TrackerStartResult, { readonly ok: true }> & { readonly agentSessionId: AgentSessionId }> => {
  const { ticketId, agentSessionId } = await delegated(projectId);
  const result = await test.db.$transaction(async (tx) => {
    const started = await startFromTrackerInTx({ tx, ...ports(), publicUrl: PUBLIC_URL }, { organizationId, projectId, ticketId, actor, matchedMemberId, agentSessionId });
    if (started.ok) {
      await tx.agentSession.update({ where: { id: agentSessionId }, data: { taskId: started.taskId, state: started.awaitingApproval ? "awaiting_approval" : "active" } });
    }
    return started;
  });
  if (!result.ok) throw new Error(`the start refused: ${result.error} ${result.message}`);
  return { ...result, agentSessionId };
};

const taskRow = (taskId: TaskId) => test.db.task.findUniqueOrThrow({ where: { id: taskId } });

const jobsFor = (taskId: TaskId): readonly string[] =>
  enqueued.flatMap((job) => (typeof job.payload === "object" && job.payload !== null && Reflect.get(job.payload, "taskId") === taskId ? [job.name] : []));

/** A runner online now, at protocol minor 4: a pool's, or a member's personal one. */
const online = async (input: Parameters<typeof seedRunner>[1]): Promise<RunnerId> => {
  const { runnerId } = await seedRunner(test.db, input);
  await test.db.runnerPresence.create({ data: { runnerId, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 4 } });
  return runnerId;
};

/** The dispatch `ticket.fetch-context` sends once it has rendered the ticket's prompt. */
const renderAndDispatch = async (taskId: TaskId) => {
  await test.db.task.update({ where: { id: taskId }, data: { prompt: "The rendered ticket." } });
  const task = await taskRow(taskId);
  const session = await test.db.session.findFirstOrThrow({ where: { taskId, state: "starting" } });
  return test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs: recordingJobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock },
      { organizationId, taskId, sessionId: sessionIdSchema.parse(session.id), leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) },
    ),
  );
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  organizationId = fixture.a.organization.id;
  openProject = fixture.a.openProject.id;
  restrictedProject = fixture.a.restrictedProject.id;
  world = await seedWorld(test.db, { codeHost, secretStore }, organizationId, openProject);
  // The restricted project: its own repo on the same installation, and the same default profile.
  const repo = await test.db.repo.findFirstOrThrow({ where: { projectId: openProject } });
  await test.db.repo.create({
    data: { organizationId, projectId: restrictedProject, connectionId: repo.connectionId, installationId: repo.installationId, hostRepoId: "host-restricted", fullName: "ostra-test/test2", defaultBranch: "main", checkoutDir: "test2" },
  });
  await test.db.project.update({ where: { id: restrictedProject }, data: { defaultCodeProfileId: world.profileId } });
  connectionId = await seedTrackerConnection(test.db, secretStore, organizationId);
  boards.set(openProject, await seedBoard(test.db, { organizationId, projectId: openProject, connectionId, externalId: "team-open", mapping: null }));
  boards.set(restrictedProject, await seedBoard(test.db, { organizationId, projectId: restrictedProject, connectionId, externalId: "team-restricted", mapping: null }));
  await test.db.$transaction((tx) => ensureBoxSizes(tx, organizationId));
});

beforeEach(async () => {
  enqueued.length = 0;
  // Each case starts with no runner online, no pool, and every project's switch on.
  await test.db.task.updateMany({ where: { organizationId, state: { in: ["queued", "awaiting_approval"] } }, data: { state: "stopped", stoppedReason: "requested" } });
  await test.db.runner.updateMany({ where: { organizationId }, data: { state: "offline" } });
  await test.db.projectPool.deleteMany({ where: { organizationId } });
  await test.db.project.updateMany({ where: { organizationId }, data: { outsideApproval: true } });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("outside tasks wait for a member's approval (F-040)", () => {
  it("F-040/c1: an unmatched starter's task waits for approval, and nothing runs before it", async () => {
    const started = await start(openProject);
    expect(started.awaitingApproval).toBe(true);
    expect(started.rule).toEqual({ outside: true, needsApproval: true, poolOnly: true, profile: "project-default" });
    const task = await taskRow(started.taskId);
    expect(task).toMatchObject({ state: "awaiting_approval", poolOnly: true, origin: "tracker", trackerActorId: actor.externalId, trackerActorName: actor.name, driverMemberId: null, creatorMemberId: null, prompt: null });
    // Nothing is owed that would run it or touch the ticket: no prompt render, no dispatch, no ticket write.
    expect(jobsFor(started.taskId)).toEqual([]);
    expect(enqueued.some((job) => job.name === "ticket.sync" || job.name === "task.dispatch" || job.name === "ticket.fetch-context")).toBe(false);
    // A pool with a free runner doesn't see it, and a dispatch finds nothing to do.
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: openProject }] });
    await online({ organizationId, poolId, executor: "docker", slots: 2, capabilities: dockerCapabilities });
    expect((await poolQueueInTx(test.db, organizationId, poolId)).map((entry) => entry.taskId)).not.toContain(started.taskId);
    expect(await renderAndDispatch(started.taskId)).toMatchObject({ ok: false, error: "stale" });
    expect(await test.db.lease.count({ where: { taskId: started.taskId } })).toBe(0);
    // Its needs-you item is the project's members', and each of them is notified of it.
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: started.taskId, state: "open" } });
    expect(item).toMatchObject({ reason: "awaiting_approval", audience: "project_members" });
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: started.taskId, kind: "task.approval_requested" } });
    expect(event.payload).toMatchObject({ by: { kind: "tracker-user", name: actor.name } });
    const fanned = await fanOutNotification({ db: test.db, ...ports() }, { organizationId, itemId: needsYouItemIdSchema.parse(item.id), change: "created" });
    expect(fanned).toMatchObject({ ok: true, notifications: 3 });
    const notified = await test.db.notification.findMany({ where: { needsYouItemId: item.id }, select: { memberId: true, kind: true } });
    expect(new Set(notified.map((row) => row.kind))).toEqual(new Set(["task_approval"]));
    expect(new Set(notified.map((row) => row.memberId))).toEqual(new Set([fixture.a.admin.id, fixture.a.member.id, fixture.a.insider.id]));
  });

  it("F-040/c1: an outside task runs the project's default profile for its kind, and only on one of the project's pools", async () => {
    // The project's default for code is a second profile, not the organization's built-in one.
    const model = await test.db.model.findFirstOrThrow({ where: { organizationId } });
    const projectDefault = await test.db.agentProfile.create({ data: { organizationId, name: `Project default ${randomUUID().slice(0, 4)}`, adapter: "opencode", modelId: model.id } });
    await test.db.project.update({ where: { id: openProject }, data: { defaultCodeProfileId: projectDefault.id } });
    try {
      const started = await start(openProject);
      expect((await taskRow(started.taskId)).agentProfileId).toBe(projectDefault.id);
      expect((await test.db.session.findFirstOrThrow({ where: { taskId: started.taskId } })).agentProfileId).toBe(projectDefault.id);

      const approved = await approveOutsideTask(deps(), scopeOf(fixture.a.member, "member"), { taskId: started.taskId });
      expect(approved.ok).toBe(true);
      expect(await taskRow(started.taskId)).toMatchObject({ state: "queued", poolOnly: true, approvedByMemberId: fixture.a.member.id });
      // The approval owes the ticket's "started" writes and the prompt's render, which dispatches.
      expect(jobsFor(started.taskId)).toContain("ticket.fetch-context");
      expect(enqueued.filter((job) => job.name === "ticket.sync").length).toBe(3);

      // The approving member's own personal runner is online, and gets nothing.
      const personal = await online({ organizationId, ownerMemberId: memberIdSchema.parse(fixture.a.member.id), executor: "host", slots: 2 });
      expect(await renderAndDispatch(started.taskId)).toMatchObject({ ok: false, error: "no-runner" });
      expect(await test.db.lease.count({ where: { taskId: started.taskId, runnerId: personal } })).toBe(0);

      // One of the project's pools has a runner: the admission gives it there.
      const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: openProject }] });
      const poolRunner = await online({ organizationId, poolId, executor: "docker", slots: 2, capabilities: dockerCapabilities });
      const admitted = await admitQueued({ db: test.db, jobs: recordingJobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, { organizationId, poolId });
      expect(admitted.admitted).toContainEqual(expect.objectContaining({ taskId: started.taskId, runnerId: poolRunner }));
    } finally {
      await test.db.project.update({ where: { id: openProject }, data: { defaultCodeProfileId: world.profileId } });
    }
  });

  it("F-040/c1: admission never offers a poolOnly task to a personal runner, whatever its row names", async () => {
    const started = await start(openProject);
    expect((await approveOutsideTask(deps(), scopeOf(fixture.a.admin, "admin"), { taskId: started.taskId })).ok).toBe(true);
    // Even a row that names a member and their personal runner (as a member's own start would) stays on pools.
    const personal = await online({ organizationId, ownerMemberId: memberIdSchema.parse(fixture.a.insider.id), executor: "host", slots: 2 });
    await test.db.task.update({ where: { id: started.taskId }, data: { creatorMemberId: fixture.a.insider.id, runnerId: personal } });
    expect(await renderAndDispatch(started.taskId)).toMatchObject({ ok: false, error: "no-runner" });
    expect(await test.db.lease.count({ where: { taskId: started.taskId } })).toBe(0);
    // It waits in the project's pool's queue instead, and a pool runner takes it.
    const { poolId } = await seedPool(test.db, { organizationId, projects: [{ projectId: openProject }] });
    expect((await poolQueueInTx(test.db, organizationId, poolId)).map((entry) => entry.taskId)).toContain(started.taskId);
    const poolRunner = await online({ organizationId, poolId, executor: "docker", slots: 2, capabilities: dockerCapabilities });
    const admitted = await admitQueued({ db: test.db, jobs: recordingJobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, { organizationId, poolId });
    expect(admitted.admitted).toContainEqual(expect.objectContaining({ taskId: started.taskId, runnerId: poolRunner }));
  });

  it("F-040/c1: any member who can open the project approves or rejects it, and someone without access can't", async () => {
    const insiderScope = scopeOf(fixture.a.insider, "member", new Map([[restrictedProject, "member"]]));
    // A member who isn't on the restricted project can't see the task, so can't answer it.
    const waiting = await start(restrictedProject);
    expect(await approveOutsideTask(deps(), scopeOf(fixture.a.member, "member"), { taskId: waiting.taskId })).toMatchObject({ ok: false, error: "not-found" });
    expect(await rejectOutsideTask(deps(), scopeOf(fixture.a.member, "member"), { taskId: waiting.taskId, reason: null })).toMatchObject({ ok: false, error: "not-found" });
    // Another organization's admin sees nothing of it either.
    expect(await approveOutsideTask(deps(), scopeOf(fixture.b.admin, "admin"), { taskId: waiting.taskId })).toMatchObject({ ok: false, error: "not-found" });
    expect((await taskRow(waiting.taskId)).state).toBe("awaiting_approval");

    // The listed member approves it: queued, and the Linear session hears it in ostra's words.
    expect(await approveOutsideTask(deps(), insiderScope, { taskId: waiting.taskId })).toMatchObject({ ok: true });
    expect(await taskRow(waiting.taskId)).toMatchObject({ state: "queued", approvedByMemberId: fixture.a.insider.id });
    expect(await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: waiting.taskId, reason: "awaiting_approval" } })).toMatchObject({ state: "answered", resolvedByMemberId: fixture.a.insider.id });
    expect(await test.db.event.count({ where: { taskId: waiting.taskId, kind: "task.approved" } })).toBe(1);
    expect(await test.db.agentSession.findUniqueOrThrow({ where: { id: waiting.agentSessionId } })).toMatchObject({ state: "active" });
    const approvedPost = await test.db.agentActivity.findFirstOrThrow({ where: { agentSessionId: waiting.agentSessionId } });
    expect(approvedPost).toMatchObject({ kind: "thought", state: "pending" });
    expect(approvedPost.body).toContain(`${PUBLIC_URL}/tasks/${waiting.taskId}`);
    expect(enqueued.some((job) => job.name === "linear.activity.send")).toBe(true);

    // Another one, rejected with a reason: stopped `rejected`, its session ended with one final response.
    const rejected = await start(restrictedProject);
    expect(await rejectOutsideTask(deps(), insiderScope, { taskId: rejected.taskId, reason: "  Not ours to do  " })).toMatchObject({ ok: true });
    expect(await taskRow(rejected.taskId)).toMatchObject({ state: "stopped", stoppedReason: "rejected", rejectedReason: "Not ours to do" });
    expect(await test.db.session.findFirstOrThrow({ where: { taskId: rejected.taskId } })).toMatchObject({ state: "stopped" });
    const rejectedEvent = await test.db.event.findFirstOrThrow({ where: { taskId: rejected.taskId, kind: "task.rejected" } });
    expect(rejectedEvent.payload).toMatchObject({ memberId: fixture.a.insider.id, reason: "Not ours to do" });
    expect(await test.db.agentSession.findUniqueOrThrow({ where: { id: rejected.agentSessionId } })).toMatchObject({ state: "ended" });
    const finalPosts = await test.db.agentActivity.findMany({ where: { agentSessionId: rejected.agentSessionId } });
    expect(finalPosts.map((post) => post.kind)).toEqual(["response"]);
    expect(jobsFor(rejected.taskId).filter((name) => name === "ticket.fetch-context" || name === "task.dispatch")).toEqual([]);
  });

  it("F-040/c1: the first answer wins", async () => {
    const started = await start(openProject);
    const [approve, reject] = await Promise.all([
      approveOutsideTask(deps(), scopeOf(fixture.a.admin, "admin"), { taskId: started.taskId }),
      rejectOutsideTask(deps(), scopeOf(fixture.a.member, "member"), { taskId: started.taskId, reason: "no" }),
    ]);
    expect([approve.ok, reject.ok].filter(Boolean)).toHaveLength(1);
    const loser = approve.ok ? reject : approve;
    expect(loser).toMatchObject({ ok: false, error: "not-awaiting-approval" });
    const task = await taskRow(started.taskId);
    expect(task.state).toBe(approve.ok ? "queued" : "stopped");
    // A late click changes nothing, and adds no second answer anywhere.
    expect(await approveOutsideTask(deps(), scopeOf(fixture.a.insider, "member"), { taskId: started.taskId })).toMatchObject({ ok: false, error: "not-awaiting-approval" });
    expect(await test.db.event.count({ where: { taskId: started.taskId, kind: { in: ["task.approved", "task.rejected"] } } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { entityId: started.taskId, action: { in: ["task.approved", "task.rejected"] } } })).toBe(1);
    expect(await test.db.agentActivity.count({ where: { agentSessionId: started.agentSessionId } })).toBe(1);
  });

  it("F-040/c2: each answer and each change of the switch is an audit entry naming the member", async () => {
    const approved = await start(openProject);
    await approveOutsideTask(deps(), scopeOf(fixture.a.member, "member"), { taskId: approved.taskId });
    const rejected = await start(openProject);
    await rejectOutsideTask(deps(), scopeOf(fixture.a.insider, "member"), { taskId: rejected.taskId, reason: "a reason nobody logs" });
    await setOutsideApproval(deps(), scopeOf(fixture.a.admin, "admin"), { projectId: openProject, on: false });
    const entries = await test.db.auditEntry.findMany({
      where: { organizationId, action: { in: ["task.approved", "task.rejected", "project.outside-approval-changed"] }, entityId: { in: [approved.taskId, rejected.taskId, openProject] } },
      select: { action: true, actorKind: true, actorId: true, entityId: true, data: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toEqual([
      expect.objectContaining({ action: "task.approved", actorKind: "member", actorId: fixture.a.member.id, entityId: approved.taskId }),
      expect.objectContaining({ action: "task.rejected", actorKind: "member", actorId: fixture.a.insider.id, entityId: rejected.taskId, data: { withReason: true } }),
      expect.objectContaining({ action: "project.outside-approval-changed", actorKind: "member", actorId: fixture.a.admin.id, entityId: openProject, data: { on: false } }),
    ]);
    // The reason is the members' to read on the task, never the audit log's.
    expect(JSON.stringify(entries)).not.toContain("a reason nobody logs");
  });

  it("F-040/c2: the approval is on by default, and only an organization admin switches it off", async () => {
    const fresh = await test.db.project.create({ data: { organizationId, name: `Fresh ${randomUUID().slice(0, 4)}`, slug: `fresh-${randomUUID().slice(0, 8)}`, access: "open" }, select: { id: true, outsideApproval: true } });
    expect(fresh.outsideApproval).toBe(true);
    const projectId = projectIdSchema.parse(fresh.id);
    // A project admin of a restricted project, and a plain member, are refused.
    const projectAdmin = scopeOf(fixture.a.insider, "member", new Map([[projectId, "admin"]]));
    expect(await setOutsideApproval(deps(), projectAdmin, { projectId, on: false })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await setOutsideApproval(deps(), scopeOf(fixture.a.member, "member"), { projectId, on: false })).toMatchObject({ ok: false, error: "forbidden" });
    // Another organization's admin can't find it.
    expect(await setOutsideApproval(deps(), scopeOf(fixture.b.admin, "admin"), { projectId, on: false })).toMatchObject({ ok: false, error: "not-found" });
    expect((await test.db.project.findUniqueOrThrow({ where: { id: projectId } })).outsideApproval).toBe(true);
    // The organization's admin switches it off, and on again.
    expect(await setOutsideApproval(deps(), scopeOf(fixture.a.admin, "admin"), { projectId, on: false })).toMatchObject({ ok: true, on: false });
    expect(await test.db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ outsideApproval: false, outsideApprovalChangedByMemberId: fixture.a.admin.id });
    expect(await setOutsideApproval(deps(), scopeOf(fixture.a.admin, "admin"), { projectId, on: true })).toMatchObject({ ok: true, on: true });
  });

  it("F-040/c2: with the switch off an outside task starts at once, still only on a pool, on the default profile", async () => {
    await setOutsideApproval(deps(), scopeOf(fixture.a.admin, "admin"), { projectId: openProject, on: false });
    const started = await start(openProject);
    expect(started.awaitingApproval).toBe(false);
    expect(await taskRow(started.taskId)).toMatchObject({ state: "queued", poolOnly: true, agentProfileId: world.profileId, driverMemberId: null });
    expect(await test.db.needsYouItem.count({ where: { taskId: started.taskId } })).toBe(0);
    expect(jobsFor(started.taskId)).toContain("ticket.fetch-context");
    const personal = await online({ organizationId, ownerMemberId: memberIdSchema.parse(fixture.a.admin.id), executor: "host", slots: 2 });
    await test.db.task.update({ where: { id: started.taskId }, data: { creatorMemberId: fixture.a.admin.id, runnerId: personal } });
    expect(await renderAndDispatch(started.taskId)).toMatchObject({ ok: false, error: "no-runner" });
  });

  it("F-040/c1: a matched member's start never waits, and is theirs", async () => {
    // Linear gives the member's address in another case, with spaces: the folded compare matches it.
    const member = await test.db.member.findUniqueOrThrow({ where: { id: fixture.a.member.id }, select: { user: { select: { email: true } } } });
    const match = await test.db.$transaction((tx) =>
      matchStarterInTx(tx, organizationId, openProject, { userId: "lin-user-member", name: "Member A", email: `  ${member.user.email.toUpperCase()} ` }),
    );
    expect(match).toEqual({ kind: "member", memberId: fixture.a.member.id });
    // The same address can't open the restricted project: there it's someone outside.
    expect(
      await test.db.$transaction((tx) => matchStarterInTx(tx, organizationId, restrictedProject, { userId: "lin-user-member", name: "Member A", email: member.user.email })),
    ).toEqual({ kind: "outside", reason: "no-access" });
    if (match.kind !== "member") throw new Error("no match");
    const started = await start(openProject, match.memberId);
    expect(started.awaitingApproval).toBe(false);
    expect(started.rule.outside).toBe(false);
    expect(await taskRow(started.taskId)).toMatchObject({
      state: "queued",
      poolOnly: false,
      origin: "tracker",
      creatorMemberId: fixture.a.member.id,
      driverMemberId: fixture.a.member.id,
      trackerActorName: actor.name,
    });
    expect(await test.db.needsYouItem.count({ where: { taskId: started.taskId } })).toBe(0);
    expect(jobsFor(started.taskId)).toContain("ticket.fetch-context");
  });
});
