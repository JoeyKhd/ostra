import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { inject } from "vitest";
import { z } from "zod";

import type { ApprovalRule, CheckId, DiffCommentId, NotificationId, TaskApprovalRuleId } from "@ostra/protocol";

import { checkRunStatusFromDb, checkRunStatusToDb } from "./enums.ts";
import {
  mapAgentProfile,
  mapAgentProfileSkill,
  mapCheckRun,
  mapCliSession,
  mapDiffComment,
  mapNotification,
  mapTaskApprovalRule,
  mapTaskPullRequest,
} from "./mappers.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 3's migration (ticket 06, spec section 5.3): the new tables and columns, their
// composite keys and unique indexes, the mappers, and an upgrade from milestone 2's data with the
// TaskPullRequest backfill.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const m3Tables = [
  "agent_profile_member",
  "agent_profile_skill",
  "task_approval_rule",
  "diff_comment",
  "diff_cache",
  "task_pull_request",
  "check_run",
  "notification",
  "notification_delivery",
  "notification_preference",
  "email_settings",
  "cli_session",
];

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

type Side = "a" | "b";

/** A profile, a repo, a task with its task repo, a session, a needs-you item and an approval, in one organization's project. */
const seedTask = async (side: Side) => {
  const organizationId = side === "a" ? fixture.a.organization.id : fixture.b.organization.id;
  const projectId = side === "a" ? fixture.a.openProject.id : fixture.b.project.id;
  const memberId = side === "a" ? fixture.a.member.id : fixture.b.admin.id;
  const profile = await test.db.agentProfile.create({
    data: { organizationId, name: `profile-${randomUUID()}`, adapter: "opencode" },
  });
  const connection = await test.db.connection.create({
    data: { organizationId, kind: "github", appId: `app-${randomUUID()}` },
  });
  const repo = await test.db.repo.create({
    data: {
      organizationId,
      projectId,
      connectionId: connection.id,
      installationId: "9",
      hostRepoId: randomUUID(),
      fullName: "ostra-test/test1",
      defaultBranch: "main",
      checkoutDir: `test-${randomBytes(3).toString("hex")}`,
    },
  });
  const task = await test.db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title: "Add CONTRIBUTING.md",
      prompt: "x",
      branchName: `ostra/m3-${randomBytes(4).toString("hex")}`,
      agentProfileId: profile.id,
    },
  });
  const taskRepo = await test.db.taskRepo.create({
    data: { organizationId, projectId, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main" },
  });
  const session = await test.db.session.create({
    data: { organizationId, projectId, taskId: task.id, origin: "new" },
  });
  const approval = await test.db.approval.create({
    data: { organizationId, projectId, taskId: task.id, sessionId: session.id, toolCallId: "call-1", options: [] },
  });
  const item = await test.db.needsYouItem.create({
    data: { organizationId, projectId, taskId: task.id, reason: "approval", audience: "driver", approvalId: approval.id },
  });
  return { organizationId, projectId, memberId, profile, repo, task, taskRepo, session, approval, item };
};

type Seeded = Awaited<ReturnType<typeof seedTask>>;

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  a = await seedTask("a");
  b = await seedTask("b");
});

describe("the milestone 3 migration", () => {
  it("creates every new table, and the install's one email row, off", async () => {
    const rows = z
      .array(z.object({ table_name: z.string() }))
      .parse(await test.db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(rows.map((row) => row.table_name));
    for (const table of m3Tables) {
      expect(names).toContain(table);
    }
    const email = await test.db.emailSettings.findUniqueOrThrow({ where: { id: "instance" } });
    expect(email).toMatchObject({ provider: "off", fromAddress: null, resendApiKeySecretRef: null, lockedBySettings: false });
    await expect(test.db.emailSettings.create({ data: { id: "second" } })).rejects.toThrow();
  });

  it("gives every new column its default, so a milestone 2 row reads the same", async () => {
    expect(a.profile).toMatchObject({ approvalRules: [], planFirst: false, access: "everyone", archivedAt: null, mcpServers: [] });
    expect(a.task).toMatchObject({ planState: "none" });
    expect(a.taskRepo).toMatchObject({ behindBy: null, behindCheckedAt: null, generation: 1 });
    expect(a.approval).toMatchObject({ ruleSource: null, subjectKind: null, subjectValue: null, denyReason: null });
    expect(a.item).toMatchObject({ questionId: null, planTurnId: null, notifiedAt: null });
    const turn = await test.db.turn.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, ordinal: 1, startSeq: 1 },
    });
    expect(turn).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spentMicroUsd: 0, estimated: false, agentMs: null });
    const device = await test.db.deviceCode.create({
      data: { id: randomUUID(), deviceCode: randomUUID(), userCode: randomUUID().slice(0, 8), expiresAt: new Date(), status: "pending" },
    });
    expect(device).toMatchObject({ purpose: "runner", machineName: null });
  });

  it("maps a check run's hyphenated status both ways", () => {
    for (const [protocol, db] of Object.entries(checkRunStatusToDb)) {
      expect(checkRunStatusFromDb[db]).toBe(protocol);
    }
    expect(checkRunStatusToDb["timed-out"]).toBe("timed_out");
  });
});

describe("organization scope, for the new rows", () => {
  it("refuses every new row whose project or parent belongs to another organization", async () => {
    const attempts: readonly (() => Promise<unknown>)[] = [
      // A's profile, B's member.
      () => test.db.agentProfileMember.create({ data: { organizationId: a.organizationId, profileId: a.profile.id, memberId: b.memberId } }),
      // A skill on B's profile, in A.
      () => test.db.agentProfileSkill.create({ data: { organizationId: a.organizationId, profileId: b.profile.id, name: "x", body: "x" } }),
      // A task in A that started with B's profile.
      () =>
        test.db.task.create({
          data: { organizationId: a.organizationId, projectId: a.projectId, kind: "code", source: "prompt", title: "x", prompt: "x", branchName: `ostra/x-${randomUUID()}`, agentProfileId: b.profile.id },
        }),
      // A task rule in A's project on B's task.
      () => test.db.taskApprovalRule.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: b.task.id, tool: "execute", pattern: "pnpm add", createdByMemberId: a.memberId } }),
      // A task rule naming another task's approval.
      () => test.db.taskApprovalRule.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, tool: "edit", pattern: "x", approvalId: b.approval.id, createdByMemberId: a.memberId } }),
      // A diff comment on B's task repo.
      () =>
        test.db.diffComment.create({
          data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, taskRepoId: b.taskRepo.id, memberId: a.memberId, path: "a.ts", side: "new", line: 1, headSha: sha("a"), body: "x" },
        }),
      // A diff cache in B's project, claiming A.
      () => test.db.diffCache.create({ data: { organizationId: a.organizationId, projectId: b.projectId, repoId: b.repo.id, baseSha: sha("1"), headSha: sha("2"), result: {} } }),
      // A cache of B's repo in A's project.
      () => test.db.diffCache.create({ data: { organizationId: a.organizationId, projectId: a.projectId, repoId: b.repo.id, baseSha: sha("1"), headSha: sha("2"), result: {} } }),
      // A PR of B's task repo in A's project.
      () => test.db.taskPullRequest.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskRepoId: b.taskRepo.id, number: 1, url: "https://x", branchName: "x" } }),
      // A check run on B's session.
      () =>
        test.db.checkRun.create({
          data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: b.session.id, turnOrdinal: 1, checkId: "c", name: "Tests" },
        }),
      // A notification in A for B's member, and one for A's member on B's task.
      () => test.db.notification.create({ data: { organizationId: a.organizationId, memberId: b.memberId, kind: "test" } }),
      () => test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, projectId: a.projectId, taskId: b.task.id, kind: "approval" } }),
      () => test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, projectId: a.projectId, needsYouItemId: b.item.id, kind: "approval" } }),
      // A preference and a CLI session in A for B's member.
      () => test.db.notificationPreference.create({ data: { organizationId: a.organizationId, memberId: b.memberId, kind: "approval", channel: "email", enabled: false } }),
      () =>
        test.db.cliSession.create({
          data: { organizationId: a.organizationId, memberId: b.memberId, userId: fixture.b.admin.userId, tokenHash: randomUUID(), name: "laptop", expiresAt: new Date() },
        }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "P2003" });
    }
    // A delivery in A of B's notification.
    const notificationB = await test.db.notification.create({ data: { organizationId: b.organizationId, memberId: b.memberId, kind: "test" } });
    await expect(
      test.db.notificationDelivery.create({ data: { organizationId: a.organizationId, notificationId: notificationB.id, channel: "panel", adapter: "panel", idempotencyKey: randomUUID() } }),
    ).rejects.toMatchObject({ code: "P2003" });
    // A snapshot built on B's runner, in A.
    const runnerB = await test.db.runner.create({
      data: { organizationId: b.organizationId, kind: "personal", ownerMemberId: b.memberId, name: "b", executor: "host", publicKey: randomUUID(), capacity: 1, labels: [], version: "0.0.0" },
    });
    const environmentA = await test.db.environment.create({ data: { organizationId: a.organizationId, projectId: a.projectId } });
    await expect(
      test.db.snapshot.create({ data: { organizationId: a.organizationId, projectId: a.projectId, environmentId: environmentA.id, reason: "nightly", runnerId: runnerB.id } }),
    ).rejects.toMatchObject({ code: "P2003" });
    // With A's own runner, the same snapshot is stored: the refusal above was the runner's organization.
    const runnerA = await test.db.runner.create({
      data: { organizationId: a.organizationId, kind: "personal", ownerMemberId: a.memberId, name: "a", executor: "docker", publicKey: randomUUID(), capacity: 1, labels: [], version: "0.0.0" },
    });
    const snapshot = await test.db.snapshot.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, environmentId: environmentA.id, reason: "nightly", runnerId: runnerA.id, buildInputsHash: "h", secretScan: "passed", buildDurationMs: 1 },
    });
    expect(snapshot.secretScan).toBe("passed");
  });

  it("F-086: refuses a notification that names a task or an item but no project", async () => {
    await expect(
      test.db.$executeRaw`INSERT INTO "notification" ("id", "organizationId", "memberId", "taskId", "kind", "updatedAt")
        VALUES (${randomUUID()}, ${a.organizationId}, ${a.memberId}, ${a.task.id}, 'approval', now())`,
    ).rejects.toThrow();
    await expect(
      test.db.$executeRaw`INSERT INTO "notification" ("id", "organizationId", "memberId", "needsYouItemId", "kind", "updatedAt")
        VALUES (${randomUUID()}, ${a.organizationId}, ${a.memberId}, ${a.item.id}, 'approval', now())`,
    ).rejects.toThrow();
    // A test notification has none of them; one of a moment has all three.
    const test1 = await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind: "test" } });
    expect(test1.projectId).toBeNull();
    const moment = await test.db.notification.create({
      data: { organizationId: a.organizationId, memberId: a.memberId, projectId: a.projectId, taskId: a.task.id, needsYouItemId: a.item.id, kind: "approval" },
    });
    expect(moment.state).toBe("open");
  });
});

describe("the unique indexes", () => {
  const createTwice = async (create: () => Promise<unknown>): Promise<void> => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "P2002" });
  };

  it("refuse each one's duplicate", async () => {
    const otherMember = fixture.a.insider.id;
    await createTwice(() => test.db.agentProfileMember.create({ data: { organizationId: a.organizationId, profileId: a.profile.id, memberId: otherMember } }));
    await createTwice(() => test.db.agentProfileSkill.create({ data: { organizationId: a.organizationId, profileId: a.profile.id, name: "release-notes", body: "# Notes" } }));
    await createTwice(() =>
      test.db.taskApprovalRule.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, tool: "execute", pattern: "pnpm add", approvalId: a.approval.id, createdByMemberId: a.memberId } }),
    );
    await createTwice(() => test.db.diffCache.create({ data: { organizationId: a.organizationId, projectId: a.projectId, repoId: a.repo.id, baseSha: sha("1"), headSha: sha("2"), result: {} } }));
    await createTwice(() => test.db.taskPullRequest.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskRepoId: a.taskRepo.id, number: 7, url: "https://x/7", branchName: "x" } }));
    await createTwice(() =>
      test.db.checkRun.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, turnOrdinal: 1, checkId: "check-1", name: "Tests" } }),
    );
    await createTwice(() =>
      test.db.notification.create({ data: { organizationId: a.organizationId, memberId: otherMember, projectId: a.projectId, taskId: a.task.id, needsYouItemId: a.item.id, kind: "approval" } }),
    );
    const notification = await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind: "test" } });
    const key = `test:${randomUUID()}`;
    await createTwice(() => test.db.notificationDelivery.create({ data: { organizationId: a.organizationId, notificationId: notification.id, channel: "email", adapter: "smtp", idempotencyKey: key } }));
    await createTwice(() => test.db.notificationPreference.create({ data: { organizationId: a.organizationId, memberId: otherMember, kind: "plan", channel: "tracker", enabled: false } }));
    const tokenHash = randomBytes(32).toString("hex");
    await createTwice(() =>
      test.db.cliSession.create({ data: { organizationId: a.organizationId, memberId: a.memberId, userId: fixture.a.member.userId, tokenHash, name: "laptop", expiresAt: new Date() } }),
    );
  });

  it("let a member have a test notification as often as they like", async () => {
    await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind: "test" } });
    await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind: "test" } });
  });

  it("F-119: githubUserId is unique where set, and repeatable where null", async () => {
    const githubUserId = String(Date.now());
    await test.db.user.update({ where: { id: fixture.a.member.userId }, data: { githubUserId, githubLogin: "ostra-test-member", githubLinkedAt: new Date() } });
    // The same GitHub account on another person is refused, even in another organization.
    await expect(test.db.user.update({ where: { id: fixture.b.admin.userId }, data: { githubUserId } })).rejects.toMatchObject({ code: "P2002" });
    // Two accounts with no link are fine.
    const nulls = await test.db.user.count({ where: { githubUserId: null } });
    expect(nulls).toBeGreaterThanOrEqual(2);
    // Unlinking frees it for someone else.
    await test.db.user.update({ where: { id: fixture.a.member.userId }, data: { githubUserId: null, githubLogin: null, githubLinkedAt: null } });
    await test.db.user.update({ where: { id: fixture.b.admin.userId }, data: { githubUserId } });
  });

  it("refuse a value out of its range", async () => {
    await expect(
      test.db.diffComment.create({
        data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, taskRepoId: a.taskRepo.id, memberId: a.memberId, path: "a.ts", side: "new", line: 0, headSha: sha("a"), body: "x" },
      }),
    ).rejects.toThrow();
    await expect(test.db.taskRepo.update({ where: { id: a.taskRepo.id }, data: { generation: 0 } })).rejects.toThrow();
    await expect(test.db.emailSettings.update({ where: { id: "instance" }, data: { smtpPort: 70_000 } })).rejects.toThrow();
  });
});

describe("the new rows' mappers", () => {
  it("parse IDs into their branded types, the profile's rules by the protocol's schema, and the check status", async () => {
    const rule: ApprovalRule = approvalRule;
    const profile = mapAgentProfile(await test.db.agentProfile.update({ where: { id: a.profile.id }, data: { approvalRules: [rule] } }));
    expect(profile.approvalRules).toEqual([rule]);
    const skill = mapAgentProfileSkill(
      await test.db.agentProfileSkill.create({
        data: { organizationId: a.organizationId, profileId: a.profile.id, name: "skill-2", body: "# Skill", files: [{ path: "a.md", blobId: "blob-1" }] },
      }),
    );
    expect(skill.files).toEqual([{ path: "a.md", blobId: "blob-1" }]);
    const taskRule = mapTaskApprovalRule(
      await test.db.taskApprovalRule.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, tool: "fetch", pattern: "registry.npmjs.org", createdByMemberId: a.memberId } }),
    );
    expectTypeOf(taskRule.id).toEqualTypeOf<TaskApprovalRuleId>();
    expect(taskRule.tool).toBe("fetch");
    const comment = mapDiffComment(
      await test.db.diffComment.create({
        data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, taskRepoId: a.taskRepo.id, memberId: a.memberId, path: "src/a.ts", side: "new", line: 12, headSha: sha("c"), body: "Rename this" },
      }),
    );
    expectTypeOf(comment.id).toEqualTypeOf<DiffCommentId>();
    expect(comment.state).toBe("draft");
    const run = mapCheckRun(
      await test.db.checkRun.create({
        data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, turnOrdinal: 2, checkId: "check-2", name: "Lint", status: "timed_out" },
      }),
    );
    expectTypeOf(run.checkId).toEqualTypeOf<CheckId>();
    expect(run.status).toBe("timed-out");
    const notification = mapNotification(await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind: "test" } }));
    expectTypeOf(notification.id).toEqualTypeOf<NotificationId>();
    expect(notification.taskId).toBeNull();
    const pr = mapTaskPullRequest(
      await test.db.taskPullRequest.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskRepoId: a.taskRepo.id, number: 9, url: "https://x/9", branchName: "x-2" } }),
    );
    expect(pr).toMatchObject({ state: "open", draft: false, draftByOstra: false });
    const cli = mapCliSession(
      await test.db.cliSession.create({
        data: { organizationId: a.organizationId, memberId: a.memberId, userId: fixture.a.member.userId, tokenHash: randomBytes(32).toString("hex"), name: "ci", expiresAt: new Date(1_900_000_000_000) },
      }),
    );
    expect(cli.revokedAt).toBeNull();
  });

  it("refuses a profile whose stored rules don't parse", async () => {
    const bad = await test.db.agentProfile.update({ where: { id: b.profile.id }, data: { approvalRules: [{ ruleId: "r", name: "n", tool: "edit", match: { kind: "mcp-not-read-only" } }] } });
    expect(() => mapAgentProfile(bad)).toThrow();
  });
});

const approvalRule: ApprovalRule = {
  ruleId: z.string().brand<"ApprovalRuleId">().parse("rule-1"),
  name: "Adding a dependency",
  tool: "edit",
  match: { kind: "path-glob", glob: "**/package.json" },
  preset: "dependency",
};

// ---------- the upgrade: milestone 2's data, then milestone 3's migrations ----------

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
/** The first migration of milestone 3. Every one before it is milestone 2's or earlier. */
const firstM3Migration = "20261119230000_command_minor_2";
const m3Migration = "20261120000000_milestone_3";

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

const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

const applyMigrations = async (url: string, names: readonly string[]): Promise<void> => {
  await withClient(url, async (client) => {
    for (const name of names) {
      await client.query(await migrationSql(name));
    }
  });
};

/** The backfill block of milestone 3's migration, to run it again. */
const backfillSql = async (): Promise<string> => {
  const sql = await migrationSql(m3Migration);
  const start = sql.indexOf("-- backfill: task_pull_request (begin)");
  const end = sql.indexOf("-- backfill: task_pull_request (end)");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe("upgrading a milestone 2 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_m3_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("applies over rows in every milestone 2 table, and backfills one TaskPullRequest per PR, once", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const m3Names = new Set([firstM3Migration, m3Migration]);
    const before = all.filter((entry) => !m3Names.has(entry) && entry < m3Migration);
    const after = all.filter((entry) => m3Names.has(entry) || entry > m3Migration);
    expect(after).toEqual(expect.arrayContaining([firstM3Migration, m3Migration]));
    await applyMigrations(upgradeUrl, before);

    // Milestone 2's head, with a row in every table it added: a Linear board and ticket, a ticket
    // task with three repos (a merged PR, an open one, none), a write, a blob and its chunk, an
    // upload, an idempotency record, a rate budget, an OAuth state and an organization's settings.
    await withClient(upgradeUrl, async (client) => {
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "instance_setting" (id, "updatedAt") VALUES ('instance', now());
        INSERT INTO "organization_setting" ("organizationId", "updatedAt") VALUES ('org-1', now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-gh', 'org-1', 'github', '123', now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-lin', 'org-1', 'linear', 'client-1', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "builtIn", "updatedAt") VALUES ('prof-1', 'org-1', 'OpenCode', 'opencode', true, now());
        INSERT INTO "repo" (id, "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "updatedAt")
          VALUES ('repo-1', 'org-1', 'proj-1', 'conn-gh', '9', '41', 'ostra-test/test1', 'main', 'test1', now()),
                 ('repo-2', 'org-1', 'proj-1', 'conn-gh', '9', '42', 'ostra-test/test2', 'main', 'test2', now()),
                 ('repo-3', 'org-1', 'proj-1', 'conn-gh', '9', '43', 'ostra-test/test3', 'main', 'test3', now());
        INSERT INTO "board" (id, "organizationId", "projectId", "connectionId", "externalId", name, key, "statusMap", "updatedAt")
          VALUES ('board-1', 'org-1', 'proj-1', 'conn-lin', 'team-1', 'OST', 'OST', '{}', now());
        INSERT INTO "ticket" (id, "organizationId", "projectId", "boardId", "connectionId", "externalId", key, title, url, "trackerUpdatedAt", "updatedAt")
          VALUES ('ticket-1', 'org-1', 'proj-1', 'board-1', 'conn-lin', 'issue-1', 'OST-12', 'Add the date', 'https://linear.app/x/OST-12', now(), now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, "ticketKey", "ticketId", "boardId", "branchName", "updatedAt")
          VALUES ('task-1', 'org-1', 'proj-1', 'code', 'ticket', 'OST-12: Add the date', 'OST-12', 'ticket-1', 'board-1', 'ostra/ost-12-add-date', now());
        INSERT INTO "task_repo" (id, "organizationId", "projectId", "taskId", "repoId", "branchName", "baseBranch", state, "prNumber", "prUrl", "mergedAt", "updatedAt")
          VALUES ('tr-1', 'org-1', 'proj-1', 'task-1', 'repo-1', 'ostra/ost-12-add-date', 'main', 'merged', 4, 'https://github.com/ostra-test/test1/pull/4', now(), now()),
                 ('tr-2', 'org-1', 'proj-1', 'task-1', 'repo-2', 'ostra/ost-12-add-date', 'main', 'pr_open', 5, 'https://github.com/ostra-test/test2/pull/5', NULL, now()),
                 ('tr-3', 'org-1', 'proj-1', 'task-1', 'repo-3', 'ostra/ost-12-add-date', 'main', 'no_branch', NULL, NULL, NULL, now());
        INSERT INTO "box" (id, "organizationId", "projectId", "taskId", executor, "updatedAt") VALUES ('box-1', 'org-1', 'proj-1', 'task-1', 'host', now());
        INSERT INTO "session" (id, "organizationId", "projectId", "taskId", "boxId", origin, "updatedAt") VALUES ('sess-1', 'org-1', 'proj-1', 'task-1', 'box-1', 'new', now());
        INSERT INTO "ticket_write" (id, "organizationId", "projectId", "taskId", "boardId", "ticketId", kind, payload, "idempotencyKey", "updatedAt")
          VALUES ('tw-1', 'org-1', 'proj-1', 'task-1', 'board-1', 'ticket-1', 'comment', '{}', 'key-1', now());
        INSERT INTO "blob" (id, "organizationId", "projectId", "taskId", store, key, purpose, "contentType", size, sha256)
          VALUES ('blob-1', 'org-1', 'proj-1', 'task-1', 'postgres', 'k-1', 'session-archive', 'application/gzip', 1, '${"a".repeat(64)}');
        INSERT INTO "blob_chunk" (id, "organizationId", "blobId", ordinal, "offset", bytes) VALUES ('chunk-1', 'org-1', 'blob-1', 0, 0, '\\x01');
        INSERT INTO "blob_upload" (id, "organizationId", store, purpose, "contentType", "expectedSha256", size, "updatedAt")
          VALUES ('up-1', 'org-1', 'postgres', 'session-archive', 'application/gzip', '${"b".repeat(64)}', 10, now());
        INSERT INTO "idempotency_record" (id, "organizationId", key, state, "claimedAt") VALUES ('idem-1', 'org-1', 'k', 'done', now());
        INSERT INTO "rate_budget" (id, "organizationId", key, remaining, "resetAt", "updatedAt") VALUES ('rate-1', 'org-1', 'linear', 100, now(), now());
        INSERT INTO "oauth_state" (id, "organizationId", "connectionId", "stateHash", "codeVerifierSecretRef", "memberId", "authSessionId", "expiresAt")
          VALUES ('oauth-1', 'org-1', 'conn-lin', 'h', 'ref', 'mem-1', 'as-1', now());
      `);
    });

    await applyMigrations(upgradeUrl, after);

    await withClient(upgradeUrl, async (client) => {
      // The backfill: one TaskPullRequest per task repo with a PR, in that PR's state.
      const prs = z
        .array(z.object({ taskRepoId: z.string(), number: z.number(), state: z.string(), url: z.string(), closed: z.boolean() }))
        .parse(await rowsOf(client, `SELECT "taskRepoId", number, state::text, url, ("closedAt" IS NOT NULL) AS closed FROM "task_pull_request" ORDER BY number`));
      expect(prs).toEqual([
        { taskRepoId: "tr-1", number: 4, state: "merged", url: "https://github.com/ostra-test/test1/pull/4", closed: true },
        { taskRepoId: "tr-2", number: 5, state: "open", url: "https://github.com/ostra-test/test2/pull/5", closed: false },
      ]);
      // Running it a second time makes no second one.
      await client.query(await backfillSql());
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "task_pull_request"`)).toEqual([{ n: 2 }]);

      // Every milestone 2 row is still there, and the new columns read their defaults.
      for (const [table, id] of [
        ["ticket", "ticket-1"],
        ["ticket_write", "tw-1"],
        ["blob", "blob-1"],
        ["blob_chunk", "chunk-1"],
        ["blob_upload", "up-1"],
        ["idempotency_record", "idem-1"],
        ["rate_budget", "rate-1"],
        ["oauth_state", "oauth-1"],
      ] as const) {
        expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "${table}" WHERE id = '${id}'`)).toEqual([{ n: 1 }]);
      }
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "organization_setting"`)).toEqual([{ n: 1 }]);
      expect(await rowsOf(client, `SELECT "planState"::text AS "planState", "agentProfileId" FROM "task" WHERE id = 'task-1'`)).toEqual([
        { planState: "none", agentProfileId: null },
      ]);
      expect(await rowsOf(client, `SELECT generation, "behindBy" FROM "task_repo" WHERE id = 'tr-1'`)).toEqual([{ generation: 1, behindBy: null }]);
      expect(await rowsOf(client, `SELECT access::text AS access, "planFirst", "approvalRules" FROM "agent_profile" WHERE id = 'prof-1'`)).toEqual([
        { access: "everyone", planFirst: false, approvalRules: [] },
      ]);
      expect(await rowsOf(client, `SELECT provider::text AS provider FROM "email_settings"`)).toEqual([{ provider: "off" }]);
      // Minor 2's command kinds are usable after the upgrade.
      const kinds = z
        .array(z.object({ kind: z.string() }))
        .parse(await rowsOf(client, `SELECT unnest(enum_range(NULL::"CommandKind"))::text AS kind`));
      expect(kinds.map((row) => row.kind)).toEqual(expect.arrayContaining(["question_answer", "plan_answer", "snapshot_build"]));
    });
  });
});
