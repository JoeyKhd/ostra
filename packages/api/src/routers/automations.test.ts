import { randomBytes } from "node:crypto";

import { startBulkItem } from "@ostra/domain";
import { agentProfileIdSchema, automationIdSchema, bulkStartItemIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { AutomationId, BoardId, ConnectionId, ProjectId, TicketId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 24 (F-011, F-106, F-107; ADR 0056): the automations API. A project admin writes rules and
// schedules, any member who can open the project reads them, and nobody else sees them; a schedule's
// preview refuses one under the minimum interval; a dry run lists exactly what its "Start all" then
// starts; a pause and a resume act from now; a delete keeps the history. Every write goes through the
// domain's use cases, with their audit entries.

let harness: ApiHarness;
let projectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;

const bugRule = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: "intake_rule" as const,
  name,
  taskKind: "code" as const,
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
  filter: { labels: { mode: "any" as const, names: ["bug"] } },
  ...extra,
});

const mondays = (name: string, cron = "0 9 * * 1", timeZone = "UTC") => ({
  kind: "schedule" as const,
  name,
  taskKind: "code" as const,
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
  schedule: cron,
  timeZone,
  skipWhileOpen: true,
  does: { kind: "prompt" as const, title: "Update the dependencies", prompt: "Update every dependency; `rm -rf /` is data, not a command." },
});

const admin = () => harness.as(harness.fixture.a.admin);
const member = () => harness.as(harness.fixture.a.member);
/** Organization A's insider, made an admin of this project only (not of the organization). */
const projectAdmin = () => harness.as(harness.fixture.a.insider);
const outsider = () => harness.as(harness.fixture.b.admin);

const auditActions = async (entityId: string): Promise<string[]> =>
  (await harness.test.db.auditEntry.findMany({ where: { entityId }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((row) => row.action);

/** Runs every queued `bulk.start-item` job as core's worker would, once each. */
const runBulkItems = async (): Promise<void> => {
  const payload = z.object({ organizationId: z.string(), bulkStartItemId: z.string() });
  for (const job of harness.fakes.jobs.jobs.filter((recorded) => recorded.job === "bulk.start-item")) {
    const { organizationId, bulkStartItemId } = payload.parse(job.payload);
    await startBulkItem(
      { db: harness.test.db, ...harness.deps.ports, publicUrl: harness.deps.settings.publicUrl },
      { organizationId: organizationIdSchema.parse(organizationId), bulkStartItemId: bulkStartItemIdSchema.parse(bulkStartItemId) },
    );
  }
};

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "automations")).projectId;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId, key: "ENG" });
  const { a } = harness.fixture;
  await harness.test.db.projectMember.create({ data: { organizationId: a.organization.id, projectId, memberId: a.insider.id, role: "admin" } });
});

afterAll(async () => {
  await harness.dispose();
});

describe("automations: who may do what (F-011, F-106)", () => {
  it("F-011/c1, F-106/c7: a project admin writes automations, a member who can open the project reads them, and another project's member sees nothing", async () => {
    const { a } = harness.fixture;
    // A project admin who isn't an organization admin writes.
    const made = await (await projectAdmin()).automations.create({ projectId, settings: bugRule("Bugs in, tasks out") });
    expect(made).toMatchObject({ name: "Bugs in, tasks out", kind: "intake_rule", taskKind: "code", filter: { labels: { mode: "any", names: ["bug"] } }, paused: null, deleted: false });
    const updated = await (await projectAdmin()).automations.update({ automationId: made.id, settings: bugRule("Bugs in, tasks out", { requireApproval: true }) });
    expect(updated.requireApproval).toBe(true);

    // A member who can open the project reads the list, the automation, its dry run and its history.
    const asMember = await member();
    const listed = await asMember.automations.list({ projectId });
    expect(listed.canEdit).toBe(false);
    expect(listed.automations.map((row) => row.id)).toContain(made.id);
    expect(await asMember.automations.get({ automationId: made.id })).toMatchObject({ id: made.id, canEdit: false });
    expect((await asMember.automations.dryRun({ projectId, automationId: made.id })).rows).toEqual([]);
    expect((await asMember.automations.history({ automationId: made.id })).runs).toEqual([]);
    expect((await (await projectAdmin()).automations.list({ projectId })).canEdit).toBe(true);

    // ...and writes nothing.
    for (const call of [
      () => asMember.automations.create({ projectId, settings: bugRule("A member's rule") }),
      () => asMember.automations.update({ automationId: made.id, settings: bugRule("Renamed by a member") }),
      () => asMember.automations.pause({ automationId: made.id }),
      () => asMember.automations.resume({ automationId: made.id }),
      () => asMember.automations.delete({ automationId: made.id }),
      () => asMember.automations.startAll({ automationId: made.id, requestKey: "member-press" }),
    ]) {
      expect((await trpcFailure(call())).code).toBe("FORBIDDEN");
    }

    // Another organization's admin sees nothing of it, by the project or by the automation.
    const other = await outsider();
    for (const call of [
      () => other.automations.list({ projectId }),
      () => other.automations.get({ automationId: made.id }),
      () => other.automations.history({ automationId: made.id }),
      () => other.automations.dryRun({ projectId, automationId: made.id }),
      () => other.automations.pause({ automationId: made.id }),
      () => other.automations.delete({ automationId: made.id }),
      () => other.automations.create({ projectId, settings: bugRule("Somebody else's rule") }),
    ]) {
      expect((await trpcFailure(call())).code).toBe("NOT_FOUND");
    }

    // A restricted project's automation: hidden from a member who isn't on it, read-only to one who is.
    const hidden = await (await admin()).automations.create({ projectId: a.restrictedProject.id, settings: bugRule("Restricted bugs") });
    expect((await trpcFailure(asMember.automations.list({ projectId: a.restrictedProject.id }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure(asMember.automations.get({ automationId: hidden.id }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure(asMember.automations.history({ automationId: hidden.id }))).code).toBe("NOT_FOUND");
    const insider = await projectAdmin();
    expect((await insider.automations.list({ projectId: a.restrictedProject.id })).canEdit).toBe(false);
    expect((await trpcFailure(insider.automations.pause({ automationId: hidden.id }))).code).toBe("FORBIDDEN");

    // Each write is an audit entry; the refused ones wrote none.
    expect(await auditActions(made.id)).toEqual(["automation.created", "automation.updated"]);
    expect(await harness.test.db.automation.count({ where: { projectId, name: { in: ["A member's rule", "Somebody else's rule"] } } })).toBe(0);
  });

  it("F-011/c2: a rule names a kind, a profile every member of the project may use and pool labels, and never a repo", async () => {
    const { a } = harness.fixture;
    const asAdmin = await admin();
    // A repo is no field of a rule: the input is refused before anything is read.
    // @ts-expect-error -- deliberately a rule naming a repo: the strict schema refuses it at run time.
    const withRepo = trpcFailure(asAdmin.automations.create({ projectId, settings: { ...bugRule("With a repo"), repoId: "repo-1" } }));
    expect((await withRepo).code).toBe("BAD_REQUEST");
    expect(await harness.test.db.automation.count({ where: { name: "With a repo" } })).toBe(0);

    // A listed profile that a member of the project isn't on is refused; on everyone's list, it's taken.
    const listed = await harness.test.db.agentProfile.create({ data: { organizationId: a.organization.id, name: "Listed", adapter: "opencode", access: "listed" } });
    const profileId = agentProfileIdSchema.parse(listed.id);
    await harness.test.db.agentProfileMember.create({ data: { organizationId: a.organization.id, profileId, memberId: a.member.id } });
    const refused = await trpcFailure(asAdmin.automations.create({ projectId, settings: bugRule("Listed profile", { agentProfileId: profileId }) }));
    expect(refused.code).toBe("BAD_REQUEST");
    expect(refused.message).toContain("Not every member of this project");
    await harness.test.db.agentProfileMember.create({ data: { organizationId: a.organization.id, profileId, memberId: a.insider.id } });
    const taken = await asAdmin.automations.create({ projectId, settings: bugRule("Listed profile", { agentProfileId: profileId, taskKind: "refine", poolLabels: ["tier:gpu", "zone:eu"] }) });
    expect(taken).toMatchObject({ taskKind: "refine", agentProfile: { id: profileId, name: "Listed" }, poolLabels: ["tier:gpu", "zone:eu"] });
    // A restricted project's members are only its own: the insider is on the list, so the rule is taken there.
    await harness.test.db.agentProfileMember.deleteMany({ where: { profileId, memberId: a.member.id } });
    expect((await asAdmin.automations.create({ projectId: a.restrictedProject.id, settings: bugRule("Listed, restricted", { agentProfileId: profileId }) })).agentProfile?.id).toBe(profileId);
    // An archived profile runs no new task.
    await harness.test.db.agentProfile.update({ where: { id: profileId }, data: { archivedAt: new Date() } });
    expect((await trpcFailure(asAdmin.automations.update({ automationId: taken.id, settings: bugRule("Listed profile", { agentProfileId: profileId }) }))).code).toBe("BAD_REQUEST");

    // The pool labels are checked against the project's pools: one no runner of them carries is named.
    expect(taken.labelsNoRunnerHas).toEqual(["tier:gpu", "zone:eu"]);
    const pool = await harness.test.db.runnerPool.create({ data: { organizationId: a.organization.id, name: `gpu-${randomBytes(3).toString("hex")}` } });
    await harness.test.db.projectPool.create({ data: { organizationId: a.organization.id, projectId, poolId: pool.id } });
    await harness.test.db.runner.create({
      data: { organizationId: a.organization.id, kind: "pool", poolId: pool.id, name: "gpu-1", publicKey: `k${randomBytes(21).toString("hex")}`, executor: "docker", capacity: 1, labels: ["executor:docker", "tier:gpu"], version: "0.0.0", state: "online" },
    });
    expect((await asAdmin.automations.get({ automationId: taken.id })).labelsNoRunnerHas).toEqual(["zone:eu"]);
    // A runner of another organization's or another project's pool doesn't count.
    expect((await asAdmin.automations.list({ projectId: a.restrictedProject.id })).automations.every((row) => row.labelsNoRunnerHas.length === row.poolLabels.length)).toBe(true);
  });
});

describe("automations: schedules (F-106)", () => {
  it("F-106/c1: the schedule preview gives the sentence and the next three occurrences, and refuses a schedule under the minimum interval", async () => {
    const asMember = await member();
    const preview = await asMember.automations.previewSchedule({ cron: "0 9 * * 1", timeZone: "Europe/Amsterdam" });
    expect(preview).toMatchObject({ sentence: "Every Monday at 09:00, Amsterdam time", described: true, refusal: null, minIntervalMinutes: 60 });
    expect(preview.next).toHaveLength(3);
    const now = Date.now();
    const wall = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    for (const [index, at] of preview.next.entries()) {
      expect(at).toBeGreaterThan(index === 0 ? now : (preview.next[index - 1] ?? 0));
      expect(wall.format(at)).toBe("Mon 09:00");
    }

    const often = await asMember.automations.previewSchedule({ cron: "*/30 * * * *", timeZone: "UTC" });
    expect(often).toMatchObject({ sentence: null, next: [], refusal: { code: "too-often", message: "Occurrences must be at least 60 minutes apart." } });
    expect((await asMember.automations.previewSchedule({ cron: "0 25 * * *", timeZone: "UTC" })).refusal?.code).toBe("invalid-cron");
    expect((await asMember.automations.previewSchedule({ cron: "0 9 * * *", timeZone: "Mars/Olympus" })).refusal?.code).toBe("invalid-time-zone");
    // Saving one is refused the same way.
    expect((await trpcFailure((await admin()).automations.create({ projectId, settings: mondays("Too often", "*/30 * * * *") }))).code).toBe("BAD_REQUEST");
    expect(await harness.test.db.automation.count({ where: { name: "Too often" } })).toBe(0);
  });

  it("F-106/c7: a pause stops a schedule at once, and a resume acts from now, never firing a time it missed", async () => {
    const asAdmin = await admin();
    const made = await asAdmin.automations.create({ projectId, settings: mondays("Monday deps") });
    expect(made.schedule).toMatchObject({ cron: "0 9 * * 1", timeZone: "UTC", sentence: "Every Monday at 09:00, UTC", does: "prompt", title: "Update the dependencies" });
    expect(made.nextOccurrenceAt).toBeGreaterThan(Date.now());

    const paused = await asAdmin.automations.pause({ automationId: made.id });
    expect(paused.paused?.reason).toBe("member");
    expect(paused.paused?.byName).toBe((await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).name);
    expect((await trpcFailure(asAdmin.automations.pause({ automationId: made.id }))).code).toBe("CONFLICT");
    // While paused, its due time passed.
    await harness.test.db.automation.update({ where: { id: made.id }, data: { nextOccurrenceAt: new Date(Date.now() - 3 * 86_400_000) } });

    const before = Date.now();
    const resumed = await asAdmin.automations.resume({ automationId: made.id });
    expect(resumed.paused).toBeNull();
    // The next occurrence is the next Monday 09:00 after now, not the one it missed.
    expect(resumed.nextOccurrenceAt).toBeGreaterThan(before);
    expect(resumed.nextOccurrenceAt).toBe((await (await member()).automations.previewSchedule({ cron: "0 9 * * 1", timeZone: "UTC" })).next[0]);
    expect((await trpcFailure(asAdmin.automations.resume({ automationId: made.id }))).code).toBe("CONFLICT");
    expect(await auditActions(made.id)).toEqual(["automation.created", "automation.paused", "automation.resumed"]);
  });
});

describe("automations: the dry run, Start all and the history (F-011, F-107)", () => {
  let ruleId: AutomationId;
  let fresh: TicketId;
  let withTask: TicketId;
  let parent: TicketId;

  beforeAll(async () => {
    fresh = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-101", title: "Cart total is wrong", labels: ["bug"] });
    withTask = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-102", title: "Checkout fails", labels: ["bug"] });
    parent = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-103", title: "Billing epic", labels: ["Bug"] });
    const child = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-104", title: "Billing part one", labels: ["design"] });
    const parentRow = await harness.test.db.ticket.findUniqueOrThrow({ where: { id: parent } });
    await harness.test.db.ticket.update({ where: { id: child }, data: { parentExternalId: parentRow.externalId } });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-105", title: "Dark mode", labels: ["design"] });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-106", title: "Closed bug", labels: ["bug"], statusCategory: "done", statusId: "s-done", open: false });
    // A member's own task holds one of the matching tickets.
    await (await member()).tasks.startFromTicket({ projectId, ticketId: withTask });
    ruleId = (await (await admin()).automations.create({ projectId, settings: bugRule("Bug sweep") })).id;
  });

  it("F-011/c3, F-107/c1: a dry run lists what Start all then starts, exactly, and a second press starts nothing twice", async () => {
    const dry = await (await member()).automations.dryRun({ projectId, automationId: ruleId });
    const byKey = new Map(dry.rows.map((row) => [row.key, row.outcome] as const));
    expect([...byKey.keys()].sort()).toEqual(["ENG-101", "ENG-102", "ENG-103"]);
    expect(byKey.get("ENG-101")).toEqual({ kind: "would-start" });
    const held = await harness.test.db.task.findFirstOrThrow({ where: { ticketId: withTask, kind: "code" }, select: { id: true } });
    expect(byKey.get("ENG-102")).toMatchObject({ kind: "would-skip", reason: "has-task", taskId: held.id });
    expect(byKey.get("ENG-103")).toEqual({ kind: "would-skip", reason: "has-sub-issues", subIssues: 1 });
    expect(dry).toMatchObject({ total: 3, wouldStart: 1 });
    // The editor's unsaved filter gives the same rows.
    const unsaved = await (await member()).automations.dryRun({ projectId, filter: { labels: { mode: "any", names: ["bug"] } } });
    expect(unsaved.rows.map((row) => [row.key, row.outcome.kind])).toEqual(dry.rows.map((row) => [row.key, row.outcome.kind]));

    harness.fakes.jobs.clear();
    const pressed = await (await admin()).automations.startAll({ automationId: ruleId, requestKey: "press-1" });
    expect(pressed.tickets).toBe(1);
    await runBulkItems();
    const items = await harness.test.db.bulkStartItem.findMany({ where: { bulkStartId: pressed.bulkStartId }, include: { ticket: { select: { key: true } } } });
    // Exactly the dry run's would-start rows, each started.
    expect(items.map((item) => [item.ticket.key, item.state])).toEqual(dry.rows.filter((row) => row.outcome.kind === "would-start").map((row) => [row.key, "started"]));
    const started = await harness.test.db.task.findFirstOrThrow({ where: { ticketId: fresh, kind: "code" } });
    expect(started).toMatchObject({ automationId: ruleId, bulkStartId: pressed.bulkStartId });
    expect(await harness.test.db.task.count({ where: { ticketId: parent } })).toBe(0);

    // The same press again answers the first; a new one finds nothing left to start.
    expect(await (await admin()).automations.startAll({ automationId: ruleId, requestKey: "press-1" })).toEqual(pressed);
    expect(await harness.test.db.bulkStart.count({ where: { automationId: ruleId } })).toBe(1);
    expect((await trpcFailure((await admin()).automations.startAll({ automationId: ruleId, requestKey: "press-2" }))).code).toBe("PRECONDITION_FAILED");
    const after = await (await member()).automations.dryRun({ projectId, automationId: ruleId });
    expect(after.wouldStart).toBe(0);
    expect(after.rows.find((row) => row.key === "ENG-101")?.outcome).toMatchObject({ kind: "would-skip", reason: "has-task", taskId: started.id });

    // The history has the press and the ticket it matched, with its task.
    const history = await (await member()).automations.history({ automationId: ruleId });
    expect(history.runs.map((run) => run.kind).sort()).toEqual(["start_all", "ticket_match"]);
    expect(history.runs.find((run) => run.kind === "ticket_match")).toMatchObject({ state: "started", ticket: { key: "ENG-101" }, task: { id: started.id }, bulkStartId: pressed.bulkStartId });

    // The list says what the screen's row and panel show: the counts, this hour's starts, the last start's key.
    const listed = (await (await member()).automations.list({ projectId })).automations.find((row) => row.id === ruleId);
    expect(listed?.counts).toEqual({ started: 1, skipped: 0, missed: 0, lastHour: 1 });
    const runs = await harness.test.db.automationRun.findMany({ where: { automationId: ruleId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { ticket: { select: { key: true } } } });
    expect(listed?.lastRun?.ticketKey).toBe(runs[0]?.ticket?.key ?? null);
  });

  it("F-011/c1: Home lists a rule its hourly limit paused to the project's admins only, and resuming it clears the row", async () => {
    const paused = await (await admin()).automations.create({ projectId, settings: bugRule("Limit reached") });
    await harness.test.db.automation.update({ where: { id: paused.id }, data: { pausedAt: new Date(), pausedReason: "hourly_limit" } });
    const byMember = await (await admin()).automations.pause({ automationId: (await (await admin()).automations.create({ projectId, settings: bugRule("Paused by hand") })).id });
    const forAdmin = await (await projectAdmin()).automations.pausedByLimit();
    expect(forAdmin.map((row) => row.name)).toEqual(["Limit reached"]);
    expect(forAdmin[0]).toMatchObject({ id: paused.id, projectId, projectName: "automations" });
    expect(forAdmin.map((row) => row.id)).not.toContain(byMember.id);
    // A member who isn't the project's admin, and another organization, see none.
    expect(await (await member()).automations.pausedByLimit()).toEqual([]);
    expect(await (await outsider()).automations.pausedByLimit()).toEqual([]);
    await (await admin()).automations.resume({ automationId: paused.id });
    expect(await (await projectAdmin()).automations.pausedByLimit()).toEqual([]);
    expect((await (await member()).automations.list({ projectId })).limits).toEqual({ startsPerHour: 20, bulkStartMax: 50, missedHours: 6, minIntervalMinutes: 60 });
  });

  it("F-011, F-106/c7: a delete is soft: the automation leaves the list and starts nothing, and its history and tasks stay", async () => {
    const asAdmin = await admin();
    const before = await (await member()).automations.history({ automationId: ruleId });
    expect(before.runs.length).toBeGreaterThan(0);
    const deleted = await asAdmin.automations.delete({ automationId: ruleId });
    expect(deleted.deletedAt).toBeLessThanOrEqual(Date.now());
    expect((await asAdmin.automations.list({ projectId })).automations.map((row) => row.id)).not.toContain(ruleId);
    for (const call of [() => asAdmin.automations.get({ automationId: ruleId }), () => asAdmin.automations.pause({ automationId: ruleId }), () => asAdmin.automations.delete({ automationId: ruleId }), () => asAdmin.automations.startAll({ automationId: ruleId, requestKey: "press-3" })]) {
      expect((await trpcFailure(call())).code).toBe("NOT_FOUND");
    }
    const history = await (await member()).automations.history({ automationId: ruleId });
    expect(history.deleted).toBe(true);
    expect(history.runs).toEqual(before.runs);
    expect(await harness.test.db.task.count({ where: { automationId: ruleId } })).toBe(1);
    expect(await auditActions(ruleId)).toContain("automation.deleted");
    // Another organization still sees nothing of it, deleted or not.
    expect((await trpcFailure((await outsider()).automations.history({ automationId: automationIdSchema.parse(ruleId) }))).code).toBe("NOT_FOUND");
  });
});
