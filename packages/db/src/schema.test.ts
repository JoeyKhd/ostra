import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { eventFixtures } from "@ostra/protocol/testing";
import { z } from "zod";

import { mapCommandToFrame, mapEventToStored, mapTask } from "./mappers.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const everyTable = [
  "user",
  "auth_session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  "deviceCode",
  "instance_setting",
  "secrets_key_check",
  "audit_entry",
  "change_notice",
  "connection",
  "model_provider",
  "model",
  "runner_pool",
  "join_token",
  "runner",
  "runner_presence",
  "agent_profile",
  "secret",
  "project",
  "project_member",
  "project_pool",
  "repo",
  "board",
  "environment",
  "environment_entry",
  "service",
  "check",
  "snapshot",
  "automation",
  "task",
  "task_repo",
  "task_co_author",
  "box",
  "lease",
  "session",
  "turn",
  "event",
  "command",
  "approval",
  "needs_you_item",
  "webhook_delivery",
];

const newTask = async (organizationId: string, projectId: string) =>
  test.db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title: "Add CONTRIBUTING.md",
      prompt: "Add a short CONTRIBUTING.md",
      branchName: `ostra/${randomBytes(4).toString("hex")}-add-contributing`,
    },
  });

describe("the first migration", () => {
  it("creates every table of the milestone 1 schema", async () => {
    const rows = await test.db.$queryRaw<readonly unknown[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const tables = z
      .array(z.object({ tablename: z.string() }))
      .parse(rows)
      .map((row) => row.tablename);
    for (const table of everyTable) {
      expect(tables).toContain(table);
    }
  });

  it("creates the live-text table UNLOGGED, in its own schema", async () => {
    const rows = await test.db.$queryRaw<readonly unknown[]>`
      SELECT c.relpersistence::text AS relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ostra_live' AND c.relname = 'live_text'`;
    expect(z.array(z.object({ relpersistence: z.string() })).parse(rows)).toEqual([{ relpersistence: "u" }]);
  });
});

describe("organization scope", () => {
  it("seeds two organizations and a restricted project, and reads them back", async () => {
    const projects = await test.db.project.findMany({ where: { organizationId: fixture.a.organization.id } });
    expect(projects.map((project) => project.id).sort()).toEqual(
      [fixture.a.openProject.id, fixture.a.restrictedProject.id].sort(),
    );
    const insiders = await test.db.projectMember.findMany({ where: { projectId: fixture.a.restrictedProject.id } });
    expect(insiders.map((row) => row.memberId)).toEqual([fixture.a.insider.id]);
    expectTypeOf(fixture.a.organization.id).toEqualTypeOf<OrganizationId>();
    expectTypeOf(fixture.b.project.id).toEqualTypeOf<ProjectId>();
  });

  it("refuses a project record that points at another organization's project", async () => {
    await expect(newTask(fixture.a.organization.id, fixture.b.project.id)).rejects.toThrow();
    await expect(
      test.db.projectMember.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.b.project.id,
          memberId: fixture.a.member.id,
          role: "member",
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a task record that points at a task of another project", async () => {
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    await expect(
      test.db.taskCoAuthor.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.a.restrictedProject.id,
          taskId: task.id,
          name: "Admin",
          email: "admin@example.com",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("the event log", () => {
  it("numbers events per task and per session, and refuses a duplicate session number", async () => {
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const session = await test.db.session.create({
      data: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        origin: "new",
      },
    });
    const base = {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      sessionId: session.id,
      leaseEpoch: 1,
      kind: "turn.started",
      payload: eventFixtures["turn.started"],
      occurredAt: new Date(1_700_000_000_000),
    };
    await test.db.event.create({ data: { ...base, seq: 1, sessionSeq: 1 } });
    await expect(test.db.event.create({ data: { ...base, seq: 2, sessionSeq: 1 } })).rejects.toThrow();
    await expect(test.db.event.create({ data: { ...base, seq: 1, sessionSeq: 2 } })).rejects.toThrow();
    // The server's own events have no session number, and many may share that.
    await test.db.event.create({ data: { ...base, seq: 2, sessionSeq: null, kind: "pr.opened" } });
    await test.db.event.create({ data: { ...base, seq: 3, sessionSeq: null, kind: "pr.opened" } });

    const first = await test.db.event.findUniqueOrThrow({ where: { taskId_seq: { taskId: task.id, seq: 1 } } });
    expect(mapEventToStored(first)).toMatchObject({ seq: 1, sessionSeq: 1, event: { kind: "turn.started" } });
  });

  it("keeps at most one active session per task", async () => {
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    const data = { organizationId: task.organizationId, projectId: task.projectId, taskId: task.id, origin: "new" as const };
    await test.db.session.create({ data });
    await expect(test.db.session.create({ data })).rejects.toThrow();
    await test.db.session.create({ data: { ...data, state: "ended", outcome: "with_changes" } });
  });
});

describe("the task's state columns", () => {
  it("refuses a sub-state outside in_review, and in_review without one", async () => {
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    await expect(
      test.db.task.update({ where: { id: task.id }, data: { subState: "ci_running" } }),
    ).rejects.toThrow();
    await expect(test.db.task.update({ where: { id: task.id }, data: { state: "in_review" } })).rejects.toThrow();
    await test.db.task.update({
      where: { id: task.id },
      data: { state: "in_review", subState: "waiting_for_reviewer" },
    });
  });

  it("refuses needs_you without a reason, and done on a code task", async () => {
    const task = await newTask(fixture.a.organization.id, fixture.a.openProject.id);
    await expect(test.db.task.update({ where: { id: task.id }, data: { state: "needs_you" } })).rejects.toThrow();
    await expect(test.db.task.update({ where: { id: task.id }, data: { state: "done" } })).rejects.toThrow();
    await test.db.task.update({ where: { id: task.id }, data: { state: "needs_you", needsYouReason: "no_changes" } });
  });

  it("maps a row's IDs to branded types", async () => {
    const task = mapTask(await newTask(fixture.a.organization.id, fixture.a.openProject.id));
    expectTypeOf(task.id).toEqualTypeOf<TaskId>();
    expect(task.projectId).toBe(fixture.a.openProject.id);
    expect(task.runnerId).toBeNull();
  });
});

describe("the command outbox", () => {
  it("numbers commands per runner and maps a row to its frame", async () => {
    const runner = await test.db.runner.create({
      data: {
        organizationId: fixture.a.organization.id,
        kind: "personal",
        ownerMemberId: fixture.a.admin.id,
        name: "laptop",
        publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
        executor: "host",
        capacity: 1,
        labels: [],
        version: "0.1.0",
      },
    });
    const data = {
      organizationId: runner.organizationId,
      runnerId: runner.id,
      seq: 1,
      kind: "update_hint" as const,
      body: { version: "0.2.0" },
      notAfter: new Date(1_900_000_000_000),
    };
    const row = await test.db.command.create({ data });
    await expect(test.db.command.create({ data })).rejects.toThrow();
    expect(mapCommandToFrame(row)).toMatchObject({ type: "command", seq: 1, kind: "update-hint" });
  });

  it("refuses a personal runner without an owner", async () => {
    await expect(
      test.db.runner.create({
        data: {
          organizationId: fixture.a.organization.id,
          kind: "personal",
          name: "orphan",
          publicKey: "B6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
          executor: "host",
          capacity: 1,
          labels: [],
          version: "0.1.0",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("a project's branch names (ticket 46)", () => {
  const named = (projectId: string, branchName: string, organizationId: string = fixture.a.organization.id) =>
    test.db.task.create({
      data: { organizationId, projectId, kind: "code", source: "prompt", title: "Nightly", prompt: "p", branchName },
    });

  it("F-016/c3: the index refuses a hand-made duplicate in a project, and allows it in another project and for the placeholder", async () => {
    const branch = `ostra/${randomBytes(4).toString("hex")}-nightly`;
    await named(fixture.a.openProject.id, branch);
    await expect(named(fixture.a.openProject.id, branch)).rejects.toThrow(/task_project_branch_unique|Unique constraint/);
    // Another project of the organization, and another organization's project, may hold the name.
    await named(fixture.a.restrictedProject.id, branch);
    await named(fixture.b.project.id, branch, fixture.b.organization.id);
    // The placeholder a create writes first is left out of the index.
    await named(fixture.a.openProject.id, "pending");
    await named(fixture.a.openProject.id, "pending");
    // A rename onto a taken name is refused too.
    const other = await named(fixture.a.openProject.id, `ostra/${randomBytes(4).toString("hex")}-other`);
    await expect(test.db.task.update({ where: { id: other.id }, data: { branchName: branch } })).rejects.toThrow();
  });
});
