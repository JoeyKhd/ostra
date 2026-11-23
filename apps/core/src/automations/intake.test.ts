import { randomUUID } from "node:crypto";

import { JiraFakeAdapter, createJiraSite } from "@ostra/adapter-sdk/testing";
import type { JiraSite } from "@ostra/adapter-sdk/testing";
import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchWaitFromDb, matchIntakeRules, postgresAuditLog, postgresChangeNotices, saveAutomation, systemClock } from "@ostra/domain";
import type { AutomationSettings, IntakeFilter, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { agentProfileIdSchema, taskIdSchema, ticketIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { AgentProfileId, AutomationId, BoardId, ConnectionId, ExternalTicketId, OrganizationId, ProjectId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { automationJobDeps, HOSTILE_TEXT, labelFilter, recordingLogger, scopeOf } from "../testing/automations.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { expectStartGates } from "../testing/start-gates.ts";
import { mappingFor, seedBoard, seedTrackerConnection } from "../testing/tickets.ts";
import { seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import type { ConnectionTrackers } from "../tracker/connections.ts";
import { pollBoard, trackerWebhookHandler } from "../tracker/ingest.ts";
import type { TrackerIngestDeps } from "../tracker/ingest.ts";
import { intakeMatchHandler } from "./automations.ts";

// Ticket 11 (F-011, ADR 0056): intake rules, through milestone 2's real ingest (webhooks and the
// poll) on the Jira fake, and `intake.match` on two pg-boss workers over two database clients, as
// two core replicas run it. Each case reads its tasks, its runs and the queue's jobs back.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let jobsB: Jobs;
let dbB: Db;
let world: World;
let organizationId: OrganizationId;
let projectId: ProjectId;
let admin: MemberScope;
let connectionId: ConnectionId;
let boardId: BoardId;
let secondBoardId: BoardId;
let site: JiraSite;
let secondJiraProject: string;
const { logger, records } = recordingLogger();
/** The hourly limit both workers run with. */
const STARTS_PER_HOUR = 3;

const trackers: Pick<ConnectionTrackers, "forConnection" | "forget"> = {
  forConnection: (_organizationId, connection) => Promise.resolve({ ok: true, value: { connectionId: connection, tracker: new JiraFakeAdapter({ site }), ownUserId: null, kind: "linear", name: "Acme Linear" } }),
  forget: () => undefined,
};

const ingestDeps = (): TrackerIngestDeps => ({ db: test.db, trackers, notices: postgresChangeNotices, clock: systemClock, logger, jobs });

/** A person's change on the Jira site, and its webhook through core's handler. */
const deliver = async (externalId: ExternalTicketId): Promise<void> => {
  const body = site.signedDelivery({ externalId, byAccountId: site.personAccountId, sentAt: Date.now() }).rawBody;
  const payload: unknown = JSON.parse(new TextDecoder().decode(body));
  await trackerWebhookHandler(ingestDeps())({
    organizationId,
    connectionId,
    deliveryId: webhookDeliveryIdSchema.parse(randomUUID()),
    event: "jira:issue_updated",
    payload,
    receivedAt: Date.now(),
    logger,
  });
};

/** A person makes an issue on a Jira project; nothing is delivered yet. */
const issue = (fields: { readonly labels?: readonly string[]; readonly jiraProject?: string; readonly statusId?: string } = {}): ExternalTicketId => {
  const made = site.createIssue(fields.jiraProject ?? site.projects[0]?.id ?? "", { summary: `An issue: ${HOSTILE_TEXT}`, description: HOSTILE_TEXT, labels: [...(fields.labels ?? [])] });
  if (fields.statusId !== undefined) {
    edit(made.externalId, { statusId: fields.statusId });
  }
  return made.externalId;
};

/** A person edits an issue on the site: its labels or status, with a newer update time. */
const edit = (externalId: ExternalTicketId, change: { readonly labels?: readonly string[]; readonly statusId?: string }): void => {
  const found = site.issues.get(externalId);
  if (found === undefined) throw new Error("no such issue");
  site.clock.advance(1_000);
  if (change.labels !== undefined) found.labels = [...change.labels];
  if (change.statusId !== undefined) found.statusId = change.statusId;
  found.updated = site.clock.now();
};

const ticketIdOf = async (externalId: ExternalTicketId, board: BoardId = boardId): Promise<TicketId> =>
  ticketIdSchema.parse((await test.db.ticket.findUniqueOrThrow({ where: { boardId_externalId: { boardId: board, externalId } } })).id);

const jobStatesSchema = z.array(z.looseObject({ state: z.string() }));

/** Waits until every `intake.match` job for the ticket ran, and gives back their states. */
const settled = async (ticketId: TicketId): Promise<readonly string[]> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = jobStatesSchema.parse(await test.db.$queryRaw<readonly unknown[]>`SELECT state FROM pgboss.job WHERE name = 'intake.match' AND data->>'ticketId' = ${ticketId}`);
    const states = rows.map((row) => row.state);
    if (states.length > 0 && states.every((state) => state === "completed" || state === "failed")) {
      return states;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the intake.match jobs did not settle");
};

const rule = async (filter: IntakeFilter, fields: Partial<Omit<Extract<AutomationSettings, { kind: "intake_rule" }>, "kind" | "filter">> = {}): Promise<AutomationId> => {
  const saved = await saveAutomation({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, admin, {
    projectId,
    automationId: null,
    settings: { name: `Rule ${randomUUID().slice(0, 8)}`, taskKind: "code", agentProfileId: null, poolLabels: [], requireApproval: false, kind: "intake_rule", filter, ...fields },
  });
  if (!saved.ok) throw new Error(`save refused: ${saved.error}`);
  return saved.automationId;
};

/** Every rule of the project deleted, so a case sees only its own. */
const clearRules = () => test.db.automation.updateMany({ where: { deletedAt: null }, data: { deletedAt: new Date() } });

const tasksOf = (automationId: AutomationId) => test.db.task.findMany({ where: { automationId }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  dbB = createDb(test.url);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  jobsB = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  await jobsB.start();
  organizationId = fixture.a.organization.id;
  projectId = fixture.a.openProject.id;
  admin = scopeOf(fixture.a.admin, "admin");
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, organizationId, projectId);
  site = createJiraSite({ projectKey: "INT" });
  secondJiraProject = site.addProject("INB", "Second").id;
  connectionId = await seedTrackerConnection(test.db, new FakeSecretStore(), organizationId);
  const statuses = await new JiraFakeAdapter({ site }).listStatuses({ externalId: site.projects[0]?.id ?? "" });
  if (!statuses.ok) throw new Error(statuses.error.message);
  const mapping = mappingFor(statuses.value, "ostra");
  boardId = await seedBoard(test.db, { organizationId, projectId, connectionId, externalId: site.projects[0]?.id ?? "", key: "INT", mapping });
  secondBoardId = await seedBoard(test.db, { organizationId, projectId, connectionId, externalId: secondJiraProject, key: "INB", mapping });
  // Two replicas' workers, each with its own database client.
  await jobs.work("intake.match", intakeMatchHandler(automationJobDeps(test.db, jobs, systemClock, { intakeStartsPerHour: STARTS_PER_HOUR })), { localConcurrency: 4 });
  await jobsB.work("intake.match", intakeMatchHandler(automationJobDeps(dbB, jobsB, systemClock, { intakeStartsPerHour: STARTS_PER_HOUR })), { localConcurrency: 4 });
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await jobsB.stop({ graceful: false, timeoutMs: 2_000 });
  await dbB.$disconnect();
  await test.dispose();
});

describe("intake rules (F-011)", () => {
  it("F-011/c1: each filter field starts what it matches, and a near miss starts nothing", async () => {
    const cases: readonly { readonly name: string; readonly filter: IntakeFilter; readonly hit: () => ExternalTicketId; readonly miss: () => ExternalTicketId; readonly board?: BoardId }[] = [
      { name: "labels, any of", filter: labelFilter(["bug"]), hit: () => issue({ labels: ["Bug"] }), miss: () => issue({ labels: ["bugs"] }) },
      { name: "labels, all of", filter: labelFilter(["bug", "ui"], { labels: { mode: "all", names: ["bug", "ui"] } }), hit: () => issue({ labels: ["ui", "bug"] }), miss: () => issue({ labels: ["bug"] }) },
      { name: "labels kept out", filter: labelFilter(["bug"], { excludeLabels: ["wontfix"] }), hit: () => issue({ labels: ["bug"] }), miss: () => issue({ labels: ["bug", "WontFix"] }) },
      { name: "status by category", filter: { ...labelFilter([]), labels: null, status: { by: "category", categories: ["started"] } }, hit: () => issue({ statusId: "10001" }), miss: () => issue() },
      { name: "status by ID", filter: { ...labelFilter([]), labels: null, status: { by: "id", ids: ["10002"] } }, hit: () => issue({ statusId: "10002" }), miss: () => issue({ statusId: "10001" }) },
      // The Jira fake assigns nobody: an assignee's near miss is the domain's pure case (ticket 06).
      // Here the unassigned match, and a closed ticket, which never matches.
      { name: "assignee: nobody", filter: { ...labelFilter([]), labels: null, assignees: [{ kind: "unassigned" }] }, hit: () => issue(), miss: () => issue({ statusId: "10003" }) },
      { name: "board", filter: { ...labelFilter([]), labels: null, boardIds: [secondBoardId] }, hit: () => issue({ jiraProject: secondJiraProject }), miss: () => issue(), board: secondBoardId },
      // The tracker's own project, which the ingest keeps on the copy: by the name the editor offers, and by its ID.
      { name: "the tracker's project, by name", filter: { ...labelFilter([]), labels: null, trackerProjectIds: ["second"] }, hit: () => issue({ jiraProject: secondJiraProject }), miss: () => issue(), board: secondBoardId },
      { name: "the tracker's project, by ID", filter: { ...labelFilter([]), labels: null, trackerProjectIds: [secondJiraProject] }, hit: () => issue({ jiraProject: secondJiraProject }), miss: () => issue(), board: secondBoardId },
    ];
    for (const entry of cases) {
      await clearRules();
      const automationId = await rule(entry.filter);
      const hit = entry.hit();
      const miss = entry.miss();
      await deliver(hit);
      await deliver(miss);
      const hitTicket = await ticketIdOf(hit, entry.board ?? boardId);
      const missTicket = await ticketIdOf(miss);
      await settled(hitTicket);
      await settled(missTicket);
      const started = (await tasksOf(automationId)).map((task) => task.ticketId);
      expect({ name: entry.name, started }).toEqual({ name: entry.name, started: [hitTicket] });
    }
    // Organization B's rows never move: no run, no task.
    expect(await test.db.automationRun.count({ where: { organizationId: fixture.b.organization.id } })).toBe(0);
  });

  it("F-011/c1: once per ticket per rule, under a replayed webhook, a poll racing the webhook, two workers and a ticket that stops matching and matches again", async () => {
    await clearRules();
    const automationId = await rule(labelFilter(["deps"]));
    const externalId = issue({ labels: ["deps"] });
    // The webhook, then twice more with a poll racing them, and three more edits that keep it
    // matching. (Two first reads of a new ticket at once race on its cache row, and the loser's
    // job retries: milestone 2's ingest. The first read goes alone here.)
    await deliver(externalId);
    await Promise.all([deliver(externalId), deliver(externalId), pollBoard(ingestDeps(), { organizationId, boardId })]);
    for (let index = 0; index < 3; index += 1) {
      edit(externalId, { labels: ["deps", `round-${String(index)}`] });
      await Promise.all([deliver(externalId), pollBoard(ingestDeps(), { organizationId, boardId })]);
    }
    const ticketId = await ticketIdOf(externalId);
    const states = await settled(ticketId);
    // Every match ran to the end: a second match of the same rule and ticket is nothing, not an error.
    expect(states.length).toBeGreaterThan(1);
    expect(states.every((state) => state === "completed")).toBe(true);
    // Two replicas matching the same ticket at once, five times over.
    const matchOn = (db: Db) =>
      db.$transaction((tx) =>
        matchIntakeRules({ tx, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, publicUrl: "https://ostra.example" }, { organizationId, ticketId, trackerUpdatedAt: Date.now() }),
      );
    await Promise.all([test.db, dbB, test.db, dbB, test.db].map(matchOn));
    expect((await tasksOf(automationId)).map((task) => task.ticketId)).toEqual([ticketId]);
    expect(await test.db.automationRun.count({ where: { automationId, kind: "ticket_match" } })).toBe(1);

    // The task is merged; the ticket stops matching, then matches again: the rule starts nothing.
    await test.db.task.updateMany({ where: { automationId }, data: { state: "merged" } });
    edit(externalId, { labels: ["other"] });
    await deliver(externalId);
    edit(externalId, { labels: ["deps"] });
    await deliver(externalId);
    await settled(ticketId);
    expect(await tasksOf(automationId)).toHaveLength(1);
  });

  it("F-011/c2: the rule's kind, profile and pool labels reach the task and admission, and a rule names no repo", async () => {
    await clearRules();
    const model = await test.db.model.create({ data: { organizationId, providerId: world.providerId, endpointModelId: "rule-model" } });
    const profile = await test.db.agentProfile.create({ data: { organizationId, name: "Rule's profile", adapter: "opencode", modelId: model.id } });
    const profileId: AgentProfileId = agentProfileIdSchema.parse(profile.id);
    const coding = await rule(labelFilter(["gpu-work"]), { agentProfileId: profileId, poolLabels: ["gpu", "big"] });
    const refining = await rule(labelFilter(["needs-spec"]), { taskKind: "refine" });
    // A rule names no repo: its task works in every repo of the project.
    const settings: AutomationSettings = {
      name: "No repo",
      taskKind: "code",
      agentProfileId: null,
      poolLabels: [],
      requireApproval: false,
      kind: "intake_rule",
      filter: labelFilter(["x"]),
      // @ts-expect-error a rule has no repo: the project's repos are the task's
      repoId: world.repoId,
    };
    expect(settings.name).toBe("No repo");

    const gpu = issue({ labels: ["gpu-work"] });
    const spec = issue({ labels: ["needs-spec"] });
    await deliver(gpu);
    await deliver(spec);
    await settled(await ticketIdOf(gpu));
    await settled(await ticketIdOf(spec));
    const [codeTask] = await tasksOf(coding);
    const [refineTask] = await tasksOf(refining);
    expect(codeTask).toMatchObject({ kind: "code", agentProfileId: profileId, origin: "automation", poolOnly: false, creatorMemberId: null });
    expect(refineTask).toMatchObject({ kind: "refine", origin: "automation" });
    const repos = await test.db.taskRepo.findMany({ where: { taskId: codeTask?.id ?? "" }, select: { repoId: true } });
    expect(repos.map((repo) => repo.repoId)).toEqual([world.repoId]);
    const session = await test.db.session.findFirstOrThrow({ where: { taskId: codeTask?.id ?? "" } });
    expect(session).toMatchObject({ agentProfileId: profileId, modelId: model.id, providerId: world.providerId });
    // The thread says which rule started it.
    const event = await test.db.event.findFirstOrThrow({ where: { taskId: codeTask?.id ?? "", kind: "automation.started" } });
    expect(event.payload).toMatchObject({ automationId: coding, occurrenceAt: null });
    // The task goes through the budget, admission with the rule's labels, and the project's share of a pool.
    await expectStartGates({ db: test.db, jobs, clock: systemClock, organizationId, projectId }, taskIdSchema.parse(codeTask?.id), ["big", "gpu"]);
  });

  it("F-011/c1: the start over the hourly limit pauses the rule, records the match skipped and tells the project's admins", async () => {
    await clearRules();
    const automationId = await rule(labelFilter(["flood"]));
    const issues = [0, 1, 2, 3].map(() => issue({ labels: ["flood"] }));
    for (const externalId of issues) {
      await deliver(externalId);
      await settled(await ticketIdOf(externalId));
    }
    expect(await tasksOf(automationId)).toHaveLength(STARTS_PER_HOUR);
    const runs = await test.db.automationRun.findMany({ where: { automationId }, orderBy: { createdAt: "asc" } });
    expect(runs.map((run) => [run.state, run.skipReason])).toEqual([
      ["started", null],
      ["started", null],
      ["started", null],
      ["skipped", "hourly_limit"],
    ]);
    const automation = await test.db.automation.findUniqueOrThrow({ where: { id: automationId } });
    expect(automation).toMatchObject({ pausedReason: "hourly_limit" });
    expect(automation.pausedAt).not.toBeNull();
    const notified = await test.db.notification.findMany({ where: { kind: "automation_paused", projectId } });
    expect(notified.map((row) => row.memberId)).toContain(fixture.a.admin.id);
    expect(notified.map((row) => row.memberId)).not.toContain(fixture.a.member.id);
    expect(await test.db.auditEntry.count({ where: { entityId: automationId, action: "automation.paused" } })).toBe(1);
    // Paused, it sees no more tickets.
    const later = issue({ labels: ["flood"] });
    await deliver(later);
    expect(await tasksOf(automationId)).toHaveLength(STARTS_PER_HOUR);
    expect(await test.db.automationRun.count({ where: { automationId } })).toBe(4);
  });

  it("F-011/c1: a rule that waits for approval starts its tasks awaiting a member's approval, whoever made the ticket", async () => {
    await clearRules();
    const automationId = await rule(labelFilter(["careful"]), { requireApproval: true });
    const externalId = issue({ labels: ["careful"] });
    await deliver(externalId);
    await settled(await ticketIdOf(externalId));
    const [task] = await tasksOf(automationId);
    expect(task).toMatchObject({ state: "awaiting_approval", origin: "automation" });
    const item = await test.db.needsYouItem.findFirstOrThrow({ where: { taskId: task?.id ?? "" } });
    expect(item).toMatchObject({ reason: "awaiting_approval", audience: "project_members", state: "open" });
    // Nothing reaches the ticket or a runner until it's approved.
    expect(await test.db.ticketWrite.count({ where: { taskId: task?.id ?? "" } })).toBe(0);
    const fetches = await test.db.$queryRaw<readonly unknown[]>`SELECT id FROM pgboss.job WHERE name = 'ticket.fetch-context' AND data->>'taskId' = ${task?.id ?? ""}`;
    expect(fetches).toEqual([]);
  });

  it("F-135/c11: a rule's match in a project whose list serves no model makes its task, queued with the no-key reason and the admins' needs-you item, and keeps the match", async () => {
    await clearRules();
    const automationId = await rule(labelFilter(["keyless"]));
    // An organization admin gives the project a list of its own, with no provider on it.
    await test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
    await test.db.project.update({ where: { id: projectId }, data: { ownProviders: true } });
    try {
      const externalId = issue({ labels: ["keyless"] });
      await deliver(externalId);
      const ticketId = await ticketIdOf(externalId);
      await settled(ticketId);
      const [task, ...more] = await tasksOf(automationId);
      expect(more).toEqual([]);
      expect(task).toMatchObject({ state: "queued", origin: "automation", ticketId });
      expect(dispatchWaitFromDb(task?.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: "dev-model-1" });
      const session = await test.db.session.findFirstOrThrow({ where: { taskId: task?.id ?? "" } });
      expect([session.providerId, session.modelId]).toEqual([null, null]);
      const items = await test.db.needsYouItem.findMany({ where: { taskId: task?.id ?? "", state: "open" } });
      expect(items.map((item) => [item.reason, item.audience])).toEqual([["no_provider_for_model", "organization_admins"]]);
      // The match is kept with its task: the ticket's next change starts nothing more.
      const runs = await test.db.automationRun.findMany({ where: { automationId, kind: "ticket_match" } });
      expect(runs.map((row) => [row.ticketId, row.state, row.taskId])).toEqual([[ticketId, "started", task?.id]]);
      edit(externalId, { labels: ["keyless", "again"] });
      await deliver(externalId);
      await settled(ticketId);
      expect(await tasksOf(automationId)).toHaveLength(1);
    } finally {
      await test.db.providerListEntry.deleteMany({ where: { organizationId, projectId } });
      await test.db.project.update({ where: { id: projectId }, data: { ownProviders: false } });
    }
  });

  it("F-011: no log line carries a ticket's text", () => {
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain("curl evil");
    expect(JSON.stringify(records)).not.toContain("rm -rf");
  });
});

