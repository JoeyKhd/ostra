import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { turnOriginSchema } from "@ostra/protocol";

import { turnOriginFromDb, turnOriginToDb } from "./enums.ts";
import { mapBudget, mapHeldTurn, mapMemoryNote, mapSearchEntry } from "./mappers.ts";
import { seedInstallation } from "./testing/installations.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 4's migration (ticket 05, spec section 5.3): the new tables and columns, their
// composite keys and unique indexes, the generated search vectors, and an upgrade from milestone
// 3's head with rows in the tables the migration alters.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const m4Migration = "20261121000000_milestone_4";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

const m4Tables = [
  "reset_link_grant",
  "search_entry",
  "spend_daily",
  "budget",
  "budget_notice",
  "held_turn",
  "task_metric",
  "insight_daily",
  "insight_run",
  "memory_note",
  "memory_note_version",
  "memory_proposal",
  "memory_use",
  "review_check",
];

type Side = "a" | "b";

/** A model, a repo, a task with its task repo and a session, in one organization's project. */
const seedTask = async (side: Side) => {
  const organizationId = side === "a" ? fixture.a.organization.id : fixture.b.organization.id;
  const projectId = side === "a" ? fixture.a.openProject.id : fixture.b.project.id;
  const memberId = side === "a" ? fixture.a.member.id : fixture.b.admin.id;
  const provider = await test.db.modelProvider.create({
    data: { organizationId, name: `p-${randomUUID()}`, baseUrl: "https://models.example.com", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "ref" },
  });
  const model = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "m-1" } });
  const connection = await test.db.connection.create({ data: { organizationId, kind: "github", appId: `app-${randomUUID()}` } });
  await seedInstallation(test.db, { organizationId, connectionId: connection.id, installationId: "9" });
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
    data: { organizationId, projectId, kind: "code", source: "prompt", title: "Add CONTRIBUTING.md", prompt: "x", branchName: `ostra/m4-${randomBytes(4).toString("hex")}` },
  });
  const taskRepo = await test.db.taskRepo.create({
    data: { organizationId, projectId, taskId: task.id, repoId: repo.id, branchName: task.branchName, baseBranch: "main" },
  });
  const session = await test.db.session.create({ data: { organizationId, projectId, taskId: task.id, origin: "new" } });
  const budget = await test.db.budget.create({ data: { organizationId, projectId, monthlyMicroUsd: 50_000_000n } });
  const note = await test.db.memoryNote.create({
    data: { organizationId, projectId, scope: "project", title: "Run the tests with pnpm test", body: "Use pnpm test at the root.", kind: "command", sourceKind: "member", authorMemberId: memberId },
  });
  return { organizationId, projectId, memberId, provider, model, repo, task, taskRepo, session, budget, note };
};

type Seeded = Awaited<ReturnType<typeof seedTask>>;

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  a = await seedTask("a");
  b = await seedTask("b");
});

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("the milestone 4 migration", () => {
  it("creates every new table, and renames or drops nothing", async () => {
    const tables = z
      .array(z.object({ table_name: z.string() }))
      .parse(await test.db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(tables.map((row) => row.table_name));
    for (const table of m4Tables) {
      expect(names).toContain(table);
    }
    // Additive only: the migration's SQL holds no DROP and no RENAME (AGENTS.md).
    const sql = await migrationSql(m4Migration);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
    // The deprecated open sign-up columns are still there, for a later release to drop.
    const columns = z
      .array(z.object({ column_name: z.string() }))
      .parse(await test.db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'instance_setting'`);
    expect(columns.map((row) => row.column_name)).toEqual(expect.arrayContaining(["openSignupAccounts", "openSignupOrganizations"]));
  });

  it("gives every new column on an existing table its default", async () => {
    const member = await test.db.member.findUniqueOrThrow({ where: { id: fixture.a.member.id } });
    expect(member).toMatchObject({ state: "active", removedAt: null, removedByMemberId: null });
    const profile = await test.db.agentProfile.create({ data: { organizationId: a.organizationId, name: `p-${randomUUID()}`, adapter: "opencode" } });
    expect(profile.closingTurn).toBe(false);
    expect(a.repo.position).toBe(0);
    const model = await test.db.model.findUniqueOrThrow({ where: { id: a.model.id } });
    expect(model).toMatchObject({ priceSource: null, priceChangedAt: null });
  });

  it("F-049: refuses every new project row whose project or parent belongs to another organization", async () => {
    const attempts: readonly (() => Promise<unknown>)[] = [
      // A search entry in A's project on B's task.
      () => test.db.searchEntry.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: b.task.id, kind: "title", text: "x" } }),
      // A search entry claiming A for B's project.
      () => test.db.searchEntry.create({ data: { organizationId: a.organizationId, projectId: b.projectId, taskId: b.task.id, kind: "title", text: "x" } }),
      // Spend in A's project on B's model.
      () => test.db.spendDaily.create({ data: { organizationId: a.organizationId, projectId: a.projectId, day: day("2026-11-19"), modelId: b.model.id } }),
      // A budget in A for B's project.
      () => test.db.budget.create({ data: { organizationId: a.organizationId, projectId: b.projectId, monthlyMicroUsd: 1n } }),
      // A notice in A of B's budget.
      () => test.db.budgetNotice.create({ data: { organizationId: a.organizationId, budgetId: b.budget.id, month: "2026-11", threshold: "warn" } }),
      // A held turn of A's task on B's budget, and one on B's task.
      () => test.db.heldTurn.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, origin: "message", budgetId: b.budget.id } }),
      () => test.db.heldTurn.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: b.task.id, origin: "message", budgetId: a.budget.id } }),
      // A task metric of B's task in A.
      () => test.db.taskMetric.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: b.task.id, createdAt: new Date() } }),
      // A day of Insights in A for B's project.
      () => test.db.insightDaily.create({ data: { organizationId: a.organizationId, projectId: b.projectId, day: day("2026-11-19") } }),
      // A note in A on B's project.
      () => test.db.memoryNote.create({ data: { organizationId: a.organizationId, projectId: b.projectId, scope: "project", title: "x", body: "x", kind: "term", sourceKind: "member" } }),
      // A version in A of B's note.
      () => test.db.memoryNoteVersion.create({ data: { organizationId: a.organizationId, noteId: b.note.id, version: 2, title: "x", body: "x", kind: "term", always: false } }),
      // A proposal in A for B's project.
      () => test.db.memoryProposal.create({ data: { organizationId: a.organizationId, projectId: b.projectId, scope: "project", title: "x", body: "x", kind: "term", sourceKind: "agent" } }),
      // A use in A of B's note, and one on B's session.
      () => test.db.memoryUse.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, noteId: b.note.id, via: "read" } }),
      () => test.db.memoryUse.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: b.session.id, noteId: a.note.id, via: "read" } }),
      // A review check in A of B's task repo.
      () => test.db.reviewCheck.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskRepoId: b.taskRepo.id, prNumber: 1, headSha: sha("a") } }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "P2003" });
    }
    // The same rows inside A are stored: the refusals above were the other organization's.
    await test.db.heldTurn.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, origin: "message", budgetId: a.budget.id } });
    await test.db.memoryUse.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, noteId: a.note.id, via: "index" } });
  });

  const createTwice = async (create: () => Promise<unknown>): Promise<void> => {
    await create();
    await expect(create()).rejects.toMatchObject({ code: "P2002" });
  };

  it("refuses each unique index's duplicate", async () => {
    await createTwice(() => test.db.resetLinkGrant.create({ data: { userId: fixture.a.member.userId, kind: "admin_link", tokenHash: "hash-1", expiresAt: new Date() } }));
    await createTwice(() => test.db.searchEntry.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, eventSeq: 4, kind: "member_message", text: "x" } }));
    // The title, prompt and ticket rows have no event: one of each per task.
    await createTwice(() => test.db.searchEntry.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, kind: "prompt", text: "x" } }));
    await createTwice(() => test.db.spendDaily.create({ data: { organizationId: a.organizationId, projectId: a.projectId, day: day("2026-11-19"), modelId: a.model.id } }));
    await createTwice(() => test.db.budgetNotice.create({ data: { organizationId: a.organizationId, budgetId: a.budget.id, month: "2026-11", threshold: "reached" } }));
    await createTwice(() => test.db.taskMetric.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, createdAt: new Date() } }));
    await createTwice(() => test.db.insightDaily.create({ data: { organizationId: a.organizationId, projectId: a.projectId, day: day("2026-11-18") } }));
    await createTwice(() => test.db.memoryNoteVersion.create({ data: { organizationId: a.organizationId, noteId: a.note.id, version: 1, title: "x", body: "x", kind: "term", always: false } }));
    await createTwice(() => test.db.memoryUse.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, sessionId: a.session.id, noteId: a.note.id, via: "search" } }));
    await createTwice(() => test.db.reviewCheck.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskRepoId: a.taskRepo.id, prNumber: 1, headSha: sha("b") } }));
    await createTwice(() => test.db.insightRun.create({ data: { organizationId: a.organizationId } }));
    // A project budget twice.
    await expect(test.db.budget.create({ data: { organizationId: a.organizationId, projectId: a.projectId, monthlyMicroUsd: 2n } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("F-037: keeps one organization budget, where projectId is null", async () => {
    const own = await test.db.budget.create({ data: { organizationId: a.organizationId, projectId: null, monthlyMicroUsd: 100_000_000n } });
    expect(mapBudget(own).projectId).toBeNull();
    await expect(test.db.budget.create({ data: { organizationId: a.organizationId, projectId: null, monthlyMicroUsd: 1n } })).rejects.toMatchObject({ code: "P2002" });
    // Another organization has its own, and a project budget sits beside the organization's.
    await test.db.budget.create({ data: { organizationId: b.organizationId, projectId: null, monthlyMicroUsd: 1n } });
    await test.db.budget.create({ data: { organizationId: a.organizationId, projectId: fixture.a.restrictedProject.id, monthlyMicroUsd: 1n } });
    // One day of the organization's Insights, the same way.
    await test.db.insightDaily.create({ data: { organizationId: a.organizationId, projectId: null, day: day("2026-11-19") } });
    await expect(test.db.insightDaily.create({ data: { organizationId: a.organizationId, projectId: null, day: day("2026-11-19") } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("refuses a value its checks rule out", async () => {
    const refusals: readonly (() => Promise<unknown>)[] = [
      () => test.db.budgetNotice.create({ data: { organizationId: a.organizationId, budgetId: a.budget.id, month: "2026-13", threshold: "warn" } }),
      () => test.db.budget.create({ data: { organizationId: a.organizationId, projectId: fixture.a.openProject.id, monthlyMicroUsd: -1n } }),
      // An organization note with a project, and a project note without one.
      () => test.db.memoryNote.create({ data: { organizationId: a.organizationId, projectId: a.projectId, scope: "organization", title: "x", body: "x", kind: "term", sourceKind: "member" } }),
      () => test.db.memoryNote.create({ data: { organizationId: a.organizationId, scope: "project", title: "x", body: "x", kind: "term", sourceKind: "member" } }),
      // A relation with no note, and a note with no relation.
      () => test.db.memoryProposal.create({ data: { organizationId: a.organizationId, scope: "organization", title: "x", body: "x", kind: "term", sourceKind: "agent", relation: "contradicts" } }),
      () => test.db.memoryProposal.create({ data: { organizationId: a.organizationId, scope: "organization", title: "x", body: "x", kind: "term", sourceKind: "agent", relatesToNoteId: a.note.id } }),
      // A search entry over 8 KiB.
      () => test.db.searchEntry.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, eventSeq: 99, kind: "agent_message", text: "x".repeat(8193) } }),
      // A removed membership with no time, and an active one with a time.
      () => test.db.member.update({ where: { id: fixture.a.insider.id }, data: { state: "removed" } }),
      () => test.db.member.update({ where: { id: fixture.a.insider.id }, data: { removedAt: new Date() } }),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toThrow();
    }
    const organizationNote = await test.db.memoryNote.create({
      data: { organizationId: a.organizationId, scope: "organization", title: "Say client, not customer", body: "x", kind: "term", sourceKind: "member" },
    });
    expect(mapMemoryNote(organizationNote).projectId).toBeNull();
  });

  it("F-080: finds a search entry by @@ on its generated vector, and nothing for a near miss", async () => {
    const entry = await test.db.searchEntry.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, eventSeq: 11, kind: "tool_input", text: "pnpm --filter @ostra/web exec playwright test" },
    });
    expect(mapSearchEntry(entry).taskId).toBe(a.task.id);
    const query = "playwright";
    const found = z
      .array(z.object({ id: z.string() }))
      .parse(await test.db.$queryRaw`SELECT id FROM search_entry WHERE vector @@ plainto_tsquery('simple', ${query}) AND "organizationId" = ${a.organizationId}`);
    expect(found.map((row) => row.id)).toEqual([entry.id]);
    const missed = "playwrite";
    expect(await test.db.$queryRaw`SELECT id FROM search_entry WHERE vector @@ plainto_tsquery('simple', ${missed})`).toEqual([]);
    // A write never sets the vector: Postgres keeps it in step with the text.
    await test.db.searchEntry.update({ where: { id: entry.id }, data: { text: "vitest run" } });
    expect(await test.db.$queryRaw`SELECT id FROM search_entry WHERE vector @@ plainto_tsquery('simple', ${query})`).toEqual([]);
  });

  it("F-109/c3: finds a memory note and a proposal by @@ on their vectors, over title and body", async () => {
    const byTitle = "pnpm";
    const notes = z
      .array(z.object({ id: z.string() }))
      .parse(await test.db.$queryRaw`SELECT id FROM memory_note WHERE vector @@ plainto_tsquery('simple', ${byTitle}) AND "organizationId" = ${a.organizationId}`);
    expect(notes.map((row) => row.id)).toEqual([a.note.id]);
    const byBody = "root";
    const byBodyRows = z
      .array(z.object({ id: z.string() }))
      .parse(await test.db.$queryRaw`SELECT id FROM memory_note WHERE vector @@ plainto_tsquery('simple', ${byBody}) AND "organizationId" = ${a.organizationId}`);
    expect(byBodyRows.map((row) => row.id)).toEqual([a.note.id]);
    const proposal = await test.db.memoryProposal.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, scope: "project", title: "Tests run with vitest", body: "The old script is gone", kind: "command", sourceKind: "agent", relatesToNoteId: a.note.id, relation: "contradicts" },
    });
    const word = "vitest";
    const proposals = z
      .array(z.object({ id: z.string() }))
      .parse(await test.db.$queryRaw`SELECT id FROM memory_proposal WHERE vector @@ plainto_tsquery('simple', ${word})`);
    expect(proposals.map((row) => row.id)).toEqual([proposal.id]);
  });

  it("F-037: maps a held turn's origin both ways", async () => {
    for (const origin of turnOriginSchema.options) {
      expect(turnOriginFromDb[turnOriginToDb[origin]]).toBe(origin);
    }
    const held = await test.db.heldTurn.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, origin: turnOriginToDb["diff-comments"], budgetId: a.budget.id },
    });
    expect(mapHeldTurn(held).origin).toBe("diff-comments");
  });

  it("takes the milestone 4 notification kinds", async () => {
    for (const kind of ["invitation", "email_verification", "password_reset", "budget_warning", "budget_reached"] as const) {
      const row = await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: a.memberId, kind } });
      expect(row.kind).toBe(kind);
    }
  });
});

// ---------- the upgrade: milestone 3's head with rows, then milestone 4's migration ----------

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

describe("upgrading a milestone 3 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_m4_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("applies over rows in every table it alters, and numbers each project's repos by creation", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const before = all.filter((entry) => entry < m4Migration);
    expect(all).toContain(m4Migration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of before) {
        await client.query(await migrationSql(migration));
      }
    });

    // Milestone 3's head, with rows in every table milestone 4 alters (member, invitation,
    // audit_entry, model, agent_profile, repo, notification) and their parents.
    await withClient(upgradeUrl, async (client) => {
      await client.query(`
        INSERT INTO "user" (id, name, email, username, "updatedAt") VALUES ('user-1', 'Admin', 'admin@example.com', 'admin', now());
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem-1', 'org-1', 'user-1', 'admin', now());
        INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "inviterId") VALUES ('inv-1', 'org-1', 'new@example.com', 'member', 'pending', now() + interval '7 days', 'user-1');
        INSERT INTO "audit_entry" (id, "organizationId", "actorKind", "actorId", action) VALUES ('audit-1', 'org-1', 'member', 'mem-1', 'project.created');
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt") VALUES ('prov-1', 'org-1', 'Anthropic', 'https://api.anthropic.com', 'anthropic_messages', 'x_api_key', 'ref', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "updatedAt") VALUES ('model-1', 'org-1', 'prov-1', 'claude', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "modelId", "builtIn", "updatedAt") VALUES ('prof-1', 'org-1', 'OpenCode', 'opencode', 'model-1', true, now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-gh', 'org-1', 'github', '123', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now()), ('proj-2', 'org-1', 'Other', 'other', now());
        INSERT INTO "repo" (id, "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "createdAt", "updatedAt")
          VALUES ('repo-b', 'org-1', 'proj-1', 'conn-gh', '9', '42', 'ostra-test/test2', 'main', 'test2', now() - interval '1 day', now()),
                 ('repo-a', 'org-1', 'proj-1', 'conn-gh', '9', '41', 'ostra-test/test1', 'main', 'test1', now() - interval '2 days', now()),
                 ('repo-c', 'org-1', 'proj-1', 'conn-gh', '9', '43', 'ostra-test/test3', 'main', 'test3', now(), now()),
                 ('repo-z', 'org-1', 'proj-2', 'conn-gh', '9', '44', 'ostra-test/other', 'main', 'other', now(), now());
        INSERT INTO "notification" (id, "organizationId", "memberId", kind, "updatedAt") VALUES ('note-1', 'org-1', 'mem-1', 'test', now());
      `);
    });

    await withClient(upgradeUrl, async (client) => {
      await client.query(await migrationSql(m4Migration));
      for (const migration of all.filter((entry) => entry > m4Migration)) {
        await client.query(await migrationSql(migration));
      }
    });

    await withClient(upgradeUrl, async (client) => {
      expect(await rowsOf(client, `SELECT id, position FROM "repo" ORDER BY "projectId", position`)).toEqual([
        { id: "repo-a", position: 0 },
        { id: "repo-b", position: 1 },
        { id: "repo-c", position: 2 },
        { id: "repo-z", position: 0 },
      ]);
      expect(await rowsOf(client, `SELECT state::text AS state, "removedAt" FROM "member" WHERE id = 'mem-1'`)).toEqual([{ state: "active", removedAt: null }]);
      expect(await rowsOf(client, `SELECT "projectGrants", "acceptedAt", "revokedAt" FROM "invitation" WHERE id = 'inv-1'`)).toEqual([
        { projectGrants: [], acceptedAt: null, revokedAt: null },
      ]);
      expect(await rowsOf(client, `SELECT action, "actorName" FROM "audit_entry" WHERE id = 'audit-1'`)).toEqual([{ action: "project.created", actorName: null }]);
      expect(await rowsOf(client, `SELECT "closingTurn", "modelId" FROM "agent_profile" WHERE id = 'prof-1'`)).toEqual([{ closingTurn: false, modelId: "model-1" }]);
      expect(await rowsOf(client, `SELECT "priceSource" FROM "model" WHERE id = 'model-1'`)).toEqual([{ priceSource: null }]);
      expect(await rowsOf(client, `SELECT kind::text AS kind FROM "notification" WHERE id = 'note-1'`)).toEqual([{ kind: "test" }]);
      // The new tables start empty: the migration backfills no search entry (search.backfill does).
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "search_entry"`)).toEqual([{ n: 0 }]);
    });
  });
});
