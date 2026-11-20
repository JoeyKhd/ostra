import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { turnOriginFromDb, turnOriginToDb } from "./enums.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 6's migration (ticket 05, spec section 5.3): the new tables, the new columns' defaults,
// the partial unique indexes that make an occurrence, a rule's match of a ticket and a team's
// agent-mode board one each, the checks, the scheduler's and the heartbeat's indexes, the new enum
// values, and an upgrade from milestone 5's head with rows in every table it alters.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const m6Migration = "20261126000000_milestone_6";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
const tag = (): string => randomBytes(4).toString("hex");

/** A project with a Linear board and a ticket, an automation, a task and its repo, in organization A's open project. */
const seedWorld = async () => {
  const organizationId = fixture.a.organization.id;
  const projectId = fixture.a.openProject.id;
  const linear = await test.db.connection.create({ data: { organizationId, kind: "linear", appId: `linear-${tag()}` } });
  const github = await test.db.connection.create({ data: { organizationId, kind: "github", appId: `app-${tag()}` } });
  const board = await test.db.board.create({ data: { organizationId, projectId, connectionId: linear.id, externalId: `team-${tag()}`, name: "OST", statusMap: {} } });
  const ticket = await test.db.ticket.create({
    data: { organizationId, projectId, boardId: board.id, connectionId: linear.id, externalId: `issue-${tag()}`, key: "OST-1", title: "A ticket", url: "https://linear.app/x/1", trackerUpdatedAt: new Date() },
  });
  const otherTicket = await test.db.ticket.create({
    data: { organizationId, projectId, boardId: board.id, connectionId: linear.id, externalId: `issue-${tag()}`, key: "OST-2", title: "Another", url: "https://linear.app/x/2", trackerUpdatedAt: new Date() },
  });
  const rule = await test.db.automation.create({ data: { organizationId, projectId, kind: "intake_rule", name: `rule-${tag()}`, taskKind: "code", filter: {} } });
  const otherRule = await test.db.automation.create({ data: { organizationId, projectId, kind: "intake_rule", name: `rule-${tag()}`, taskKind: "code", filter: {} } });
  const schedule = await test.db.automation.create({ data: { organizationId, projectId, kind: "schedule", name: `schedule-${tag()}`, taskKind: "code", schedule: "*/2 * * * *" } });
  const task = await test.db.task.create({ data: { organizationId, projectId, kind: "code", source: "prompt", title: "A task", prompt: "x", branchName: `ostra/m6-${tag()}` } });
  await test.db.codeHostInstallation.create({ data: { organizationId, connectionId: github.id, installationId: "1", accountLogin: `acct-${tag()}`, accountKind: "organization" } });
  const name = `repo-${tag()}`;
  const repo = await test.db.repo.create({ data: { organizationId, projectId, connectionId: github.id, installationId: "1", hostRepoId: name, fullName: `fixture/${name}`, defaultBranch: "main", checkoutDir: name } });
  const taskRepo = await test.db.taskRepo.create({ data: { organizationId, projectId, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main" } });
  return { organizationId, projectId, linear, board, ticket, otherTicket, rule, otherRule, schedule, task, taskRepo };
};

type World = Awaited<ReturnType<typeof seedWorld>>;
let world: World;

beforeAll(async () => {
  world = await seedWorld();
});

describe("the milestone 6 migration", () => {
  it("creates milestone 6's tables, and renames or drops nothing", async () => {
    const tables = z
      .array(z.object({ table_name: z.string() }))
      .parse(await test.db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(tables.map((row) => row.table_name));
    for (const table of [
      "automation_run",
      "bulk_start",
      "bulk_start_item",
      "agent_session",
      "agent_activity",
      "refine_draft",
      "refine_draft_image",
      "ci_run",
      "task_round",
      "review_run",
      "finding",
      "task_reviewer",
      "environment_proposal",
    ]) {
      expect(names, table).toContain(table);
    }
    // Additive only (AGENTS.md): no DROP, no RENAME, no column changed, nothing backfilled.
    const sql = await migrationSql(m6Migration);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM)\b/i);
  });

  it("gives every new column on an existing table its default", async () => {
    expect(await test.db.task.findUniqueOrThrow({ where: { id: world.task.id } })).toMatchObject({
      origin: "member",
      automationId: null,
      bulkStartId: null,
      parentTicketId: null,
      trackerActorId: null,
      trackerActorName: null,
      poolOnly: false,
      approvedByMemberId: null,
      approvedAt: null,
      rejectedReason: null,
      ciRounds: 0,
      reviewRounds: 0,
      automaticTurns: 0,
      lastPersonActionAt: null,
      onboarding: false,
    });
    expect(await test.db.project.findUniqueOrThrow({ where: { id: world.projectId } })).toMatchObject({ aiReview: true, outsideApproval: true, outsideApprovalChangedByMemberId: null });
    expect(world.board).toMatchObject({ agentMode: false });
    expect(world.linear).toMatchObject({ scopes: [], agentModeAt: null });
    expect(world.schedule).toMatchObject({
      timeZone: "UTC",
      prompt: null,
      title: null,
      requireApproval: false,
      skipWhileOpen: true,
      pausedAt: null,
      pausedReason: null,
      nextOccurrenceAt: null,
      lastOccurrenceAt: null,
      deletedAt: null,
    });
    const profile = await test.db.agentProfile.create({ data: { organizationId: world.organizationId, name: `p-${randomUUID()}`, adapter: "opencode" } });
    expect(profile.builtInKind).toBeNull();
  });

  it("F-106/c3: refuses a second occurrence row for the same automation and time", async () => {
    const occurrenceAt = new Date("2026-11-20T10:00:00Z");
    const occurrence = { organizationId: world.organizationId, projectId: world.projectId, automationId: world.schedule.id, kind: "occurrence" as const, occurrenceAt };
    await test.db.automationRun.create({ data: { ...occurrence, state: "started", taskId: world.task.id } });
    // Another replica's tick for the same time, whatever it found, is refused.
    await expect(test.db.automationRun.create({ data: { ...occurrence, state: "skipped", skipReason: "last_open" } })).rejects.toMatchObject({ code: "P2002" });
    await expect(test.db.automationRun.create({ data: { ...occurrence, state: "missed" } })).rejects.toMatchObject({ code: "P2002" });
    // The next minute is its own occurrence.
    await test.db.automationRun.create({ data: { ...occurrence, occurrenceAt: new Date("2026-11-20T10:02:00Z"), state: "missed" } });
    expect(await test.db.automationRun.count({ where: { automationId: world.schedule.id } })).toBe(2);
  });

  it("F-011/c1: refuses a second match for the same rule and ticket, and lets another rule match it", async () => {
    const match = { organizationId: world.organizationId, projectId: world.projectId, kind: "ticket_match" as const };
    await test.db.automationRun.create({ data: { ...match, automationId: world.rule.id, ticketId: world.ticket.id, state: "started", taskId: world.task.id } });
    // The same ticket matching the same rule again, by webhook, by poll or after its label came back.
    await expect(
      test.db.automationRun.create({ data: { ...match, automationId: world.rule.id, ticketId: world.ticket.id, state: "skipped", skipReason: "has_task" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Another ticket for the same rule, and the same ticket for another rule, are each their own.
    await test.db.automationRun.create({ data: { ...match, automationId: world.rule.id, ticketId: world.otherTicket.id, state: "skipped", skipReason: "hourly_limit" } });
    await test.db.automationRun.create({ data: { ...match, automationId: world.otherRule.id, ticketId: world.ticket.id, state: "skipped", skipReason: "has_task" } });
  });

  it("F-012: refuses a second agent-mode board for the same team, and keeps boards without agent mode as before", async () => {
    const organizationId = world.organizationId;
    const otherProject = await test.db.project.create({ data: { organizationId, name: `other-${tag()}`, slug: `other-${tag()}` } });
    const team = `team-${tag()}`;
    const board = (projectId: string, agentMode: boolean) =>
      test.db.board.create({ data: { organizationId, projectId, connectionId: world.linear.id, externalId: team, name: "OST", statusMap: {}, agentMode } });
    await board(world.projectId, true);
    // The same team on another project's board, also with agent mode: refused.
    await expect(board(otherProject.id, true)).rejects.toMatchObject({ code: "P2002" });
    // Without agent mode it's a board like any other.
    const plain = await board(otherProject.id, false);
    await expect(test.db.board.update({ where: { id: plain.id }, data: { agentMode: true } })).rejects.toMatchObject({ code: "P2002" });
    // Another team, or another organization's same team, may have its own.
    await test.db.board.create({ data: { organizationId, projectId: otherProject.id, connectionId: world.linear.id, externalId: `team-${tag()}`, name: "OPS", statusMap: {}, agentMode: true } });
    const b = fixture.b.organization.id;
    const bLinear = await test.db.connection.create({ data: { organizationId: b, kind: "linear", appId: `linear-${tag()}` } });
    await test.db.board.create({ data: { organizationId: b, projectId: fixture.b.project.id, connectionId: bLinear.id, externalId: team, name: "OST", statusMap: {}, agentMode: true } });
  });

  it("refuses a value its checks rule out", async () => {
    const { organizationId, projectId } = world;
    const run = { organizationId, projectId, automationId: world.schedule.id };
    const reviewRun = await test.db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: world.task.id, round: 1 } });
    const refusals: readonly (readonly [string, () => Promise<unknown>])[] = [
      // An occurrence without its time, a match with one, and a match without its ticket.
      ["an occurrence without its time", () => test.db.automationRun.create({ data: { ...run, kind: "occurrence", state: "started" } })],
      ["a match with an occurrence time", () => test.db.automationRun.create({ data: { ...run, kind: "ticket_match", ticketId: world.otherTicket.id, occurrenceAt: new Date(), state: "started" } })],
      ["an occurrence with a ticket", () => test.db.automationRun.create({ data: { ...run, kind: "occurrence", occurrenceAt: new Date("2030-01-01T00:00:00Z"), ticketId: world.ticket.id, state: "started" } })],
      ["a match without a ticket", () => test.db.automationRun.create({ data: { ...run, kind: "ticket_match", state: "started" } })],
      // A skip without its reason, and a reason without a skip.
      ["a skip without a reason", () => test.db.automationRun.create({ data: { ...run, kind: "occurrence", occurrenceAt: new Date("2030-01-01T00:01:00Z"), state: "skipped" } })],
      ["a reason without a skip", () => test.db.automationRun.create({ data: { ...run, kind: "occurrence", occurrenceAt: new Date("2030-01-01T00:02:00Z"), state: "started", skipReason: "paused" } })],
      // A pause without its reason.
      ["a pause without a reason", () => test.db.automation.update({ where: { id: world.schedule.id }, data: { pausedAt: new Date() } })],
      // A finding on line 0.
      [
        "a finding on line 0",
        () =>
          test.db.finding.create({
            data: { organizationId, projectId, reviewRunId: reviewRun.id, taskRepoId: world.taskRepo.id, path: "a.ts", line: 0, side: "new", severity: "nit", title: "t", body: "b" },
          }),
      ],
      // An approval time without the member who approved.
      ["an approval without its member", () => test.db.task.update({ where: { id: world.task.id }, data: { approvedAt: new Date() } })],
      // A negative round count.
      ["a negative round count", () => test.db.task.update({ where: { id: world.task.id }, data: { automaticTurns: -1 } })],
      // A reviewer that is both a user and a team, or neither.
      ["a reviewer that is both", () => test.db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: world.taskRepo.id, githubUserId: "1", teamSlug: "core", source: "requested" } })],
      ["a reviewer that is neither", () => test.db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: world.taskRepo.id, source: "codeowners" } })],
      // A draft's version 0.
      ["a draft's version 0", () => test.db.refineDraft.create({ data: { organizationId, projectId, taskId: world.task.id, version: 0, description: "d", source: "agent" } })],
    ];
    for (const [what, refusal] of refusals) {
      await expect(refusal(), what).rejects.toThrow();
    }
    // The same rows, valid, are stored.
    await test.db.automation.update({ where: { id: world.schedule.id }, data: { pausedAt: new Date(), pausedReason: "member" } });
    await test.db.task.update({ where: { id: world.task.id }, data: { approvedAt: new Date(), approvedByMemberId: fixture.a.member.id } });
    await test.db.finding.create({
      data: { organizationId, projectId, reviewRunId: reviewRun.id, taskRepoId: world.taskRepo.id, path: "a.ts", line: 1, side: "new", severity: "nit", title: "t", body: "b" },
    });
    await test.db.taskReviewer.create({ data: { organizationId, projectId, taskRepoId: world.taskRepo.id, teamSlug: "core", source: "team" } });
  });

  it("keeps one row per head, per round's cause, per review round, per draft version and per session", async () => {
    const { organizationId, projectId } = world;
    const head = "a".repeat(40);
    await test.db.ciRun.create({ data: { organizationId, projectId, taskRepoId: world.taskRepo.id, headSha: head } });
    await expect(test.db.ciRun.create({ data: { organizationId, projectId, taskRepoId: world.taskRepo.id, headSha: head } })).rejects.toMatchObject({ code: "P2002" });
    const round = { organizationId, projectId, taskId: world.task.id, kind: "ci" as const, number: 1, automatic: true, causeRef: head, state: "started" as const };
    await test.db.taskRound.create({ data: round });
    await expect(test.db.taskRound.create({ data: { ...round, number: 2 } })).rejects.toMatchObject({ code: "P2002" });
    await test.db.taskRound.create({ data: { ...round, kind: "findings" } });
    await test.db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: world.task.id, round: 7 } });
    await expect(test.db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: world.task.id, round: 7 } })).rejects.toMatchObject({ code: "P2002" });
    const draft = { organizationId, projectId, taskId: world.task.id, version: 1, description: "d", source: "agent" as const };
    await test.db.refineDraft.create({ data: draft });
    await expect(test.db.refineDraft.create({ data: draft })).rejects.toMatchObject({ code: "P2002" });
    const session = { organizationId, connectionId: world.linear.id, externalSessionId: `s-${tag()}`, creatorExternalId: "u-1", creatorName: "Robin" };
    const made = await test.db.agentSession.create({ data: session });
    await expect(test.db.agentSession.create({ data: session })).rejects.toMatchObject({ code: "P2002" });
    // A session before a project is known has none; an activity is posted once per key.
    expect(made).toMatchObject({ projectId: null, state: "active", heartbeatDueAt: null });
    const activity = { organizationId, agentSessionId: made.id, kind: "thought" as const, body: "Received.", idempotencyKey: `created:${made.id}` };
    await test.db.agentActivity.create({ data: activity });
    await expect(test.db.agentActivity.create({ data: activity })).rejects.toMatchObject({ code: "P2002" });
    const bulk = { organizationId, projectId, memberId: fixture.a.member.id, source: "inbox" as const, requestKey: `req-${tag()}`, taskKind: "code" as const, requested: 2 };
    const started = await test.db.bulkStart.create({ data: bulk });
    await expect(test.db.bulkStart.create({ data: bulk })).rejects.toMatchObject({ code: "P2002" });
    await test.db.bulkStartItem.create({ data: { organizationId, projectId, bulkStartId: started.id, ticketId: world.ticket.id } });
    await expect(test.db.bulkStartItem.create({ data: { organizationId, projectId, bulkStartId: started.id, ticketId: world.ticket.id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("F-049: refuses a draft image's blob, an agent session's connection and a run's ticket from another organization or project", async () => {
    const { organizationId, projectId } = world;
    const b = fixture.b.organization.id;
    const theirBlob = await test.db.blob.create({ data: { organizationId: b, projectId: fixture.b.project.id, store: "postgres", key: `blob-${randomUUID()}`, purpose: "x", contentType: "image/png", size: 1, sha256: "0".repeat(64) } });
    const theirLinear = await test.db.connection.create({ data: { organizationId: b, kind: "github", appId: `app-${tag()}` } });
    const draft = await test.db.refineDraft.create({ data: { organizationId, projectId, taskId: world.task.id, version: 99, description: "d", source: "member" } });
    const restrictedBoard = await test.db.board.create({
      data: { organizationId, projectId: fixture.a.restrictedProject.id, connectionId: world.linear.id, externalId: `team-${tag()}`, name: "R", statusMap: {} },
    });
    const restrictedTicket = await test.db.ticket.create({
      data: { organizationId, projectId: fixture.a.restrictedProject.id, boardId: restrictedBoard.id, connectionId: world.linear.id, externalId: `i-${tag()}`, key: "R-1", title: "R", url: "https://linear.app/x/r", trackerUpdatedAt: new Date() },
    });
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => test.db.refineDraftImage.create({ data: { organizationId, projectId, draftId: draft.id, blobId: theirBlob.id, name: "x.png", contentType: "image/png", size: 1 } }),
      () => test.db.agentSession.create({ data: { organizationId, connectionId: theirLinear.id, externalSessionId: `s-${tag()}`, creatorExternalId: "u", creatorName: "U" } }),
      () => test.db.automationRun.create({ data: { organizationId, projectId, automationId: world.rule.id, kind: "ticket_match", ticketId: restrictedTicket.id, state: "started" } }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "P2003" });
    }
  });

  it("F-106/c3: reads due schedules and due heartbeats through their indexes", async () => {
    const plans = await test.db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const planSchema = z.array(z.object({ "QUERY PLAN": z.string() }));
      const parse = (value: unknown) => planSchema.parse(value);
      const due = parse(await tx.$queryRaw`EXPLAIN SELECT "id" FROM "automation" WHERE "enabled" AND "nextOccurrenceAt" <= now() AND "schedule" IS NOT NULL`);
      const beats = parse(await tx.$queryRaw`EXPLAIN SELECT "id" FROM "agent_session" WHERE "heartbeatDueAt" <= now() AND "state" <> 'ended'`);
      return { due: due.map((row) => row["QUERY PLAN"]).join("\n"), beats: beats.map((row) => row["QUERY PLAN"]).join("\n") };
    });
    expect(plans.due).toContain("automation_due_schedules");
    expect(plans.beats).toContain("agent_session_heartbeat_due");
  });

  it("takes the milestone 6 enum values", async () => {
    const { organizationId, projectId } = world;
    for (const kind of ["draft_ready", "review_requested", "task_approval", "round_cap", "automation_paused"] as const) {
      const row = await test.db.notification.create({ data: { organizationId, memberId: fixture.a.admin.id, kind } });
      expect(row.kind).toBe(kind);
    }
    const item = await test.db.needsYouItem.create({ data: { organizationId, projectId, taskId: world.task.id, reason: "awaiting_approval", audience: "project_members" } });
    expect(item.reason).toBe("awaiting_approval");
    for (const origin of ["changes-requested", "linear-follow-up"] as const) {
      expect(turnOriginFromDb[turnOriginToDb[origin]]).toBe(origin);
    }
    const profile = await test.db.agentProfile.create({ data: { organizationId, name: `Refine ${tag()}`, adapter: "opencode", builtIn: true, builtInKind: "refine" } });
    expect(profile.builtInKind).toBe("refine");
    const proposal = await test.db.memoryProposal.create({
      data: { organizationId, projectId, scope: "project", title: "Name the CI workflow", body: "CI runs in ci.yml.", kind: "convention", sourceKind: "ai_finding", sourceRef: randomUUID() },
    });
    expect(proposal.sourceKind).toBe("ai_finding");
  });
});

// ---------- the upgrade: milestone 5's head with rows, then milestone 6's migration ----------

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const rowsOf = async (client: pg.Client, sql: string): Promise<unknown> => (await client.query(sql)).rows;

describe("upgrading a milestone 5 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_m6_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("applies on an empty database up to milestone 5, then over rows in every table it alters", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(m6Migration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < m6Migration)) {
        await client.query(await migrationSql(migration));
      }
    });

    // Milestone 5's head, with rows in every table milestone 6 alters (agent_profile, automation,
    // board, connection, project, task) and their parents.
    await withClient(upgradeUrl, async (client) => {
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "builtIn", "updatedAt") VALUES ('prof-1', 'org-1', 'OpenCode', 'opencode', true, now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-li', 'org-1', 'linear', 'lin', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "board" (id, "organizationId", "projectId", "connectionId", "externalId", name, "statusMap", "updatedAt") VALUES ('board-1', 'org-1', 'proj-1', 'conn-li', 'team-1', 'OST', '{}', now());
        INSERT INTO "automation" (id, "organizationId", "projectId", kind, name, "taskKind", "poolLabels", schedule, "updatedAt")
          VALUES ('auto-1', 'org-1', 'proj-1', 'schedule', 'Nightly', 'code', ARRAY[]::TEXT[], '0 2 * * *', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, "branchName", state, prompt, "createdAt", "updatedAt")
          VALUES ('task-1', 'org-1', 'proj-1', 'code', 'prompt', 'A prompt', 'ostra/a-prompt', 'queued', 'Add a CONTRIBUTING.md', now(), now());
      `);
      await client.query(await migrationSql(m6Migration));
    });

    await withClient(upgradeUrl, async (client) => {
      expect(
        await rowsOf(client, `SELECT origin, "poolOnly", "ciRounds", "reviewRounds", "automaticTurns", onboarding, "approvedAt", "automationId", prompt FROM "task" WHERE id = 'task-1'`),
      ).toEqual([{ origin: "member", poolOnly: false, ciRounds: 0, reviewRounds: 0, automaticTurns: 0, onboarding: false, approvedAt: null, automationId: null, prompt: "Add a CONTRIBUTING.md" }]);
      expect(await rowsOf(client, `SELECT "aiReview", "outsideApproval" FROM "project" WHERE id = 'proj-1'`)).toEqual([{ aiReview: true, outsideApproval: true }]);
      expect(await rowsOf(client, `SELECT "agentMode" FROM "board" WHERE id = 'board-1'`)).toEqual([{ agentMode: false }]);
      expect(await rowsOf(client, `SELECT scopes, "agentModeAt" FROM "connection" WHERE id = 'conn-li'`)).toEqual([{ scopes: [], agentModeAt: null }]);
      expect(await rowsOf(client, `SELECT "builtIn", "builtInKind" FROM "agent_profile" WHERE id = 'prof-1'`)).toEqual([{ builtIn: true, builtInKind: null }]);
      expect(await rowsOf(client, `SELECT schedule, "timeZone", "skipWhileOpen", "requireApproval", "nextOccurrenceAt", "pausedAt" FROM "automation" WHERE id = 'auto-1'`)).toEqual([
        { schedule: "0 2 * * *", timeZone: "UTC", skipWhileOpen: true, requireApproval: false, nextOccurrenceAt: null, pausedAt: null },
      ]);
      // It seeds nothing: the built-in profiles are the domain's (ticket 06).
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "agent_profile"`)).toEqual([{ n: 1 }]);
      // The untrusted text's columns say so.
      const comment = await rowsOf(
        client,
        `SELECT d.description FROM pg_description d JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid WHERE d.objoid = '"automation"'::regclass AND a.attname = 'prompt'`,
      );
      expect(comment).toEqual([{ description: "ostra: a prompt schedule's prompt. Private: never logged." }]);
    });
  });
});
