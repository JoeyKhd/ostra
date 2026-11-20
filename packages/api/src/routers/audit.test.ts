import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import type { AuditInput } from "@ostra/domain";
import { approvalIdSchema, memberIdSchema, poolIdSchema, taskIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import { minor2FieldFixtures } from "@ostra/protocol/testing";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditCsvRow, AUDIT_CSV_COLUMNS, csvField, serveAuditExport } from "../services/audit-log.ts";
import type { AuditEntryView } from "../services/audit-log.ts";
import { appendEvent, createApiHarness, seedTask, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// F-073 (ADR 0054, ticket 25): the audit log's viewer and export, and the task's event log, on a real
// database. Entries are written through the one port (`recordInTx`), as every writer does.

let harness: ApiHarness;
let orgA: OrganizationId;
let admin: AppCaller;
let projectAdmin: SeededMember;

const record = (entry: AuditInput) => harness.test.db.$transaction((tx) => harness.deps.ports.audit.recordInTx(tx, entry));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every page of the list, for a filter. */
const listAll = async (caller: AppCaller, filter: Parameters<AppCaller["audit"]["list"]>[0], limit = 3): Promise<AuditEntryView[]> => {
  const all: AuditEntryView[] = [];
  let cursor: { createdAt: number; id: string } | null = null;
  for (;;) {
    const page = await caller.audit.list({ ...filter, limit, ...(cursor === null ? {} : { cursor }) });
    all.push(...page.entries);
    if (page.next === null) return all;
    cursor = page.next;
  }
};

let boundary = 0;
let restrictedId: ProjectId;
let openId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  admin = await harness.as(harness.fixture.a.admin);
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: "Pat", email: `pat-${randomUUID()}@example.com`, username: `pat-${randomUUID().slice(0, 8)}` } });
  projectAdmin = mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: orgA, userId: user.id, role: "member", createdAt: new Date() } }));
  restrictedId = harness.fixture.a.restrictedProject.id;
  openId = harness.fixture.a.openProject.id;
  await harness.test.db.projectMember.create({ data: { organizationId: orgA, projectId: restrictedId, memberId: projectAdmin.id, role: "admin" } });

  const { a, b } = harness.fixture;
  const member = (who: SeededMember) => ({ kind: "member" as const, id: who.id });
  // Before the boundary: three entries.
  await record({ organizationId: orgA, projectId: null, actor: member(a.admin), action: "organization.renamed", entity: "organization", entityId: orgA });
  await record({ organizationId: orgA, projectId: restrictedId, actor: member(projectAdmin), action: "project.access-changed", entity: "project", entityId: restrictedId, data: { access: "restricted" } });
  await record({ organizationId: orgA, projectId: null, actor: member(a.admin), action: "budget.set", entity: "budget", entityId: null, data: { monthlyMicroUsd: "5000000" } });
  await pause(30);
  boundary = Date.now();
  await pause(30);
  // After it: five more, two of them about tasks.
  const taskId = taskIdSchema.parse(randomUUID());
  await record({ organizationId: orgA, projectId: restrictedId, actor: member(a.insider), action: "task.created", entity: "task", entityId: taskId });
  await record({ organizationId: orgA, projectId: openId, actor: member(a.member), action: "task.stopped", entity: "task", entityId: taskIdSchema.parse(randomUUID()) });
  await record({ organizationId: orgA, projectId: null, actor: member(a.admin), action: "budget.cleared", entity: "budget", entityId: null });
  await record({ organizationId: orgA, projectId: restrictedId, actor: { kind: "system", id: null }, action: "pr.merged", entity: "task", entityId: taskId });
  await record({ organizationId: orgA, projectId: null, actor: { kind: "runner", id: null }, action: "runner.registered", entity: "runner", entityId: null });
  // Another organization's.
  await record({ organizationId: b.organization.id, projectId: b.project.id, actor: member(b.admin), action: "task.created", entity: "task", entityId: taskIdSchema.parse(randomUUID()) });
  await record({ organizationId: b.organization.id, projectId: null, actor: member(b.admin), action: "budget.set", entity: "budget", entityId: null });
});

afterAll(async () => {
  await harness.dispose();
});

const actions = (entries: readonly AuditEntryView[]) => entries.map((entry) => entry.action);

describe("audit.list", () => {
  it("F-073/c2,c3: an organization admin sees every entry, newest first across pages, and filters each way", async () => {
    const all = await listAll(admin, {});
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.map((entry) => entry.at)).toEqual([...all.map((entry) => entry.at)].sort((x, y) => y - x));
    expect(new Set(all.map((entry) => entry.id)).size).toBe(all.length);
    const { a } = harness.fixture;
    expect(actions(await listAll(admin, { actorId: a.insider.id }))).toEqual(["task.created"]);
    expect(actions(await listAll(admin, { action: "task.stopped" }))).toEqual(["task.stopped"]);
    expect(actions(await listAll(admin, { action: "budget." }))).toEqual(["budget.cleared", "budget.set"]);
    expect(actions(await listAll(admin, { projectId: restrictedId }))).toEqual(["pr.merged", "task.created", "project.access-changed"]);
    const taskEntry = all.find((entry) => entry.action === "task.created");
    expect(taskEntry?.taskId).toBe(taskEntry?.entityId);
    expect(actions(await listAll(admin, { entity: "task", entityId: taskEntry?.entityId ?? "" }))).toEqual(["pr.merged", "task.created"]);
    expect(actions(await listAll(admin, { from: boundary, action: "budget." }))).toEqual(["budget.cleared"]);
    expect(actions(await listAll(admin, { to: boundary, action: "budget." }))).toEqual(["budget.set"]);
    // The actor's name, the project's name, and an entry about a task links its task.
    expect(taskEntry).toMatchObject({ actor: { kind: "member", id: a.insider.id, removed: false }, project: { id: restrictedId, name: harness.fixture.a.restrictedProject.name } });
    expect(all.find((entry) => entry.action === "runner.registered")?.actor).toMatchObject({ kind: "runner" });
    // An action that isn't on the list is refused, not read as no filter.
    expect(await trpcFailure(admin.audit.list({ action: "made.up" }))).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("F-073/c2: a project admin sees only their project's entries, and a member none", async () => {
    const asProjectAdmin = await harness.as(projectAdmin);
    const theirs = await listAll(asProjectAdmin, { projectId: restrictedId });
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((entry) => entry.project?.id === restrictedId)).toBe(true);
    expect(await trpcFailure(asProjectAdmin.audit.list({}))).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(asProjectAdmin.audit.list({ projectId: openId }))).toMatchObject({ code: "FORBIDDEN" });
    const member = await harness.as(harness.fixture.a.member);
    expect(await trpcFailure(member.audit.list({}))).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(member.audit.list({ projectId: openId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(member.audit.list({ projectId: restrictedId }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-073/c2: an entry names its entity: the live record's label, the label its data recorded once the record is gone, else the ID", async () => {
    const { a } = harness.fixture;
    const keyed = await seedTask(harness, { organizationId: orgA, projectId: openId, title: "Add a square root key" });
    await harness.test.db.task.update({ where: { id: keyed.taskId }, data: { ticketKey: "CALC-161" } });
    const titled = await seedTask(harness, { organizationId: orgA, projectId: openId, title: "Fix the divide button" });
    const gonePool = poolIdSchema.parse(randomUUID());
    const goneTask = taskIdSchema.parse(randomUUID());
    const member = { kind: "member" as const, id: a.admin.id };
    await record({ organizationId: orgA, projectId: openId, actor: member, action: "task.stopped", entity: "task", entityId: keyed.taskId });
    await record({ organizationId: orgA, projectId: openId, actor: member, action: "task.stopped", entity: "task", entityId: titled.taskId });
    await record({ organizationId: orgA, projectId: null, actor: member, action: "member.role-changed", entity: "member", entityId: memberIdSchema.parse(a.insider.id), data: { role: "admin" } });
    await record({ organizationId: orgA, projectId: null, actor: member, action: "pool.updated", entity: "runner-pool", entityId: gonePool, data: { name: "build-pool" } });
    await record({ organizationId: orgA, projectId: openId, actor: member, action: "task.stopped", entity: "task", entityId: goneTask });

    const all = await listAll(admin, {}, 50);
    const labelOf = (entityId: string) => all.find((entry) => entry.entityId === entityId)?.entityLabel;
    expect(labelOf(keyed.taskId)).toBe("CALC-161");
    expect(labelOf(titled.taskId)).toBe("Fix the divide button");
    const insider = await harness.test.db.user.findUniqueOrThrow({ where: { id: a.insider.userId } });
    expect(labelOf(a.insider.id)).toBe(insider.name);
    expect(labelOf(orgA)).toBe(a.organization.name);
    expect(labelOf(restrictedId)).toBe(a.restrictedProject.name);
    expect(labelOf(gonePool)).toBe("build-pool");
    expect(labelOf(goneTask)).toBe(goneTask);
    // An entry about no entity has no label.
    expect(all.find((entry) => entry.action === "budget.cleared")?.entityLabel).toBeNull();
    // Another organization's record never lends its label: B's project named in A's log reads as its ID.
    await record({ organizationId: orgA, projectId: null, actor: member, action: "project.access-changed", entity: "project", entityId: harness.fixture.b.project.id });
    expect(labelOf(harness.fixture.b.project.id)).toBeUndefined();
    const again = await listAll(admin, { entityId: harness.fixture.b.project.id }, 50);
    expect(again.map((entry) => entry.entityLabel)).toEqual([harness.fixture.b.project.id]);
  });

  it("F-073/c2: the Actor filter's Runners and System choices read every runner's entries, and the system's", async () => {
    expect(actions(await listAll(admin, { actorKind: "runner" }))).toEqual(["runner.registered"]);
    expect(actions(await listAll(admin, { actorKind: "system" }))).toEqual(["pr.merged"]);
    const response = await exportAs(harness.fixture.a.admin, "?actorKind=system");
    expect(parseCsv(await response.text()).slice(1).map((row) => row[4])).toEqual(["pr.merged"]);
  });

  it("F-073/c2: another organization's entries never appear, and its project is NOT_FOUND", async () => {
    const { b } = harness.fixture;
    const all = await listAll(admin, {}, 50);
    expect(all.some((entry) => entry.actor.id === b.admin.id)).toBe(false);
    expect(await listAll(admin, { actorId: b.admin.id })).toEqual([]);
    expect(await trpcFailure(admin.audit.list({ projectId: b.project.id }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

/** A CSV body as rows of fields (RFC 4180, every field quoted). */
const parseCsv = (text: string): string[][] =>
  text
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? "").replaceAll('""', '"')));

const exportAs = async (who: SeededMember | null, query: string): Promise<Response> => {
  const context =
    who === null
      ? { deps: harness.deps, headers: new Headers(), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) }
      : await harness.contextOf(who);
  // Pages of two, so a stream that stops after its first page shows.
  return serveAuditExport(context, new URL(`http://localhost:3000/api/audit/export${query}`), { pageSize: 2 });
};

describe("the CSV export", () => {
  it("F-073/c2: the export's rows equal the list's for the same filters, behind the same access check", async () => {
    for (const [query, filter] of [
      ["", {}],
      ["?action=budget.", { action: "budget." }],
      [`?projectId=${restrictedId}&from=${String(boundary)}`, { projectId: restrictedId, from: boundary }],
    ] as const) {
      const response = await exportAs(harness.fixture.a.admin, query);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      const rows = parseCsv(await response.text());
      // The target's columns (audit-log.md, "Export CSV"), and its file name.
      expect(rows[0]).toEqual(["time", "actor_kind", "actor_id", "actor_name", "action", "entity", "entity_id", "entity_label", "project_id", "project_name", "data"]);
      expect(rows[0]).toEqual([...AUDIT_CSV_COLUMNS]);
      const day = new Date().toISOString().slice(0, 10);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="audit-${harness.fixture.a.organization.slug}-${day}.csv"`);
      const listed = await listAll(admin, filter, 2);
      expect(rows.slice(1)).toEqual(parseCsv(listed.map((entry) => `${auditCsvRow(entry)}\r\n`).join("")));
      expect(rows.length - 1).toBe(listed.length);
      // Field by field from the list's own entries, not only through the same formatter.
      expect(rows.slice(1).map((row) => row.slice(1, 10))).toEqual(
        listed.map((entry) => [
          entry.actor.kind,
          entry.actor.id ?? "",
          entry.actor.name ?? "",
          entry.action,
          entry.entity ?? "",
          entry.entityId ?? "",
          entry.entityLabel ?? "",
          entry.project?.id ?? "",
          entry.project?.name ?? "",
        ]),
      );
    }
    expect((await exportAs(projectAdmin, `?projectId=${restrictedId}`)).status).toBe(200);
    expect((await exportAs(projectAdmin, "")).status).toBe(403);
    expect((await exportAs(harness.fixture.a.member, `?projectId=${restrictedId}`)).status).toBe(404);
    expect((await exportAs(harness.fixture.a.admin, `?projectId=${harness.fixture.b.project.id}`)).status).toBe(404);
    expect((await exportAs(null, "")).status).toBe(401);
    expect((await exportAs(harness.fixture.a.admin, "?action=made.up")).status).toBe(400);
  });

  it("F-073: a field a spreadsheet would run as a formula is defused, and quotes are doubled", () => {
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField("plain")).toBe('"plain"');
  });
});

describe("tasks.eventLog", () => {
  it("F-073/c3: returns every event in order with a tool call's full input for execute, read, search, edit and fetch, failures and approvals", async () => {
    const at = { organizationId: orgA, projectId: openId };
    const task = await seedTask(harness, at);
    const turnId = turnIdSchema.parse("turn-1");
    const kinds = ["execute", "read", "search", "edit", "fetch"] as const;
    const inputs = {
      execute: { command: "pnpm test -- --run", cwd: "/workspace/test1" },
      read: { path: "src/index.ts", offset: 10, limit: 200 },
      search: { pattern: "apiVersion", path: "src", glob: "**/*.ts" },
      edit: { path: "README.md", oldText: "a".repeat(3000), newText: "b".repeat(3000) },
      fetch: { url: "https://example.com/docs", method: "GET" },
    };
    for (const [index, toolKind] of kinds.entries()) {
      await appendEvent(harness, task, at, { kind: "tool.called", turnId, toolCallId: toolCallIdSchema.parse(`call-${String(index)}`), toolKind, title: toolKind, input: inputs[toolKind] });
    }
    await appendEvent(harness, task, at, { kind: "tool.failed", toolCallId: toolCallIdSchema.parse("call-0"), error: "exit code 1: 3 tests failed" });
    // An approval with the command it asked about (minor 2's subject).
    await appendEvent(harness, task, at, { ...minor2FieldFixtures["approval.requested"], approvalId: approvalIdSchema.parse(randomUUID()), subject: { kind: "command", value: "rm -rf build" } });

    const member = await harness.as(harness.fixture.a.member);
    const log = await member.tasks.eventLog({ taskId: task.taskId });
    expect(log.events.map((stored) => stored.seq)).toEqual([...log.events.map((stored) => stored.seq)].sort((x, y) => x - y));
    const called = log.events.flatMap((stored) => (stored.event.kind === "tool.called" ? [stored.event] : []));
    expect(called.map((event) => [event.toolKind, event.input])).toEqual(kinds.map((kind) => [kind, inputs[kind]]));
    expect(log.events.find((stored) => stored.event.kind === "tool.failed")?.event).toMatchObject({ error: "exit code 1: 3 tests failed" });
    expect(log.events.find((stored) => stored.event.kind === "approval.requested")?.event).toMatchObject({ subject: { kind: "command", value: "rm -rf build" } });

    // Filters by kind, and pages by seq.
    expect((await member.tasks.eventLog({ taskId: task.taskId, kinds: ["tool.failed"] })).events.map((stored) => stored.event.kind)).toEqual(["tool.failed"]);
    const first = await member.tasks.eventLog({ taskId: task.taskId, limit: 4 });
    expect(first.events).toHaveLength(4);
    const rest = await member.tasks.eventLog({ taskId: task.taskId, afterSeq: first.nextAfterSeq ?? 0 });
    expect([...first.events, ...rest.events]).toEqual(log.events);
    expect(rest.nextAfterSeq).toBeNull();
  });

  it("F-073/c3: a member who can't open the task's project gets NOT_FOUND", async () => {
    const task = await seedTask(harness, { organizationId: orgA, projectId: restrictedId });
    expect(await trpcFailure((await harness.as(harness.fixture.a.member)).tasks.eventLog({ taskId: task.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect((await (await harness.as(harness.fixture.a.insider)).tasks.eventLog({ taskId: task.taskId })).events).toEqual([]);
    const other = await seedTask(harness, { organizationId: harness.fixture.b.organization.id, projectId: harness.fixture.b.project.id });
    expect(await trpcFailure(admin.tasks.eventLog({ taskId: other.taskId }))).toMatchObject({ code: "NOT_FOUND" });
  });
});
