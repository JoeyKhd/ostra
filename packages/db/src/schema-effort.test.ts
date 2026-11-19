import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { effortLevelSchema } from "@ostra/protocol";

import { commandKindToDb, effortLevelFromDb, effortLevelToDb } from "./enums.ts";
import { mapAgentProfile, mapModel, mapTask, mapTurn } from "./mappers.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Reasoning effort's migration (F-137, ADR 0066, milestone 4's ticket 56; spec section 5.6):
// additive columns with `default` as every existing row's level, on an empty database and on one
// at the previous head with rows in every table it alters.

const effortMigration = "20261121100000_reasoning_effort";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

describe("the reasoning effort columns", () => {
  it("F-137: the level's enum is the protocol's, both ways, and set-effort is a command kind", () => {
    expect(Object.keys(effortLevelFromDb).sort()).toEqual([...effortLevelSchema.options].sort());
    for (const level of effortLevelSchema.options) {
      expect(effortLevelFromDb[effortLevelToDb[level]]).toBe(level);
    }
    expect(commandKindToDb["set-effort"]).toBe("set_effort");
  });

  it("F-137: on a fresh database a profile and a task read default, and a model's controls parse with the protocol's schema", async () => {
    const organizationId = fixture.a.organization.id;
    const provider = await test.db.modelProvider.create({
      data: { organizationId, name: "p", baseUrl: "https://models.example.com", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "ref" },
    });
    const model = await test.db.model.create({
      data: { organizationId, providerId: provider.id, endpointModelId: "m-1", catalogReasoning: { supported: true, effort: ["low", "high", "max"] } },
    });
    expect(mapModel(model)).toMatchObject({ catalogReasoning: { supported: true, effort: ["low", "high", "max"] }, adminReasoning: null });
    const profile = await test.db.agentProfile.create({ data: { organizationId, name: "OpenCode", adapter: "opencode", modelId: model.id } });
    expect(mapAgentProfile(profile).effort).toBe("default");
    const task = await test.db.task.create({
      data: { organizationId, projectId: fixture.a.openProject.id, kind: "code", source: "prompt", title: "t", prompt: "p", branchName: `ostra/${randomBytes(3).toString("hex")}` },
    });
    expect(mapTask(task).effort).toBe("default");
    const session = await test.db.session.create({ data: { organizationId, projectId: task.projectId, taskId: task.id, origin: "new" } });
    expect(session.reasoningTokens).toBe(0);
    const turn = await test.db.turn.create({
      data: { organizationId, projectId: task.projectId, taskId: task.id, sessionId: session.id, ordinal: 1, startSeq: 1, effort: "high", effortAdjustedFrom: "medium" },
    });
    expect(mapTurn(turn)).toMatchObject({ effort: "high", effortAdjustedFrom: "medium", reasoningTokens: 0 });
    // Controls ostra didn't write are refused on the way out, not passed on.
    const bad = await test.db.model.create({ data: { organizationId, providerId: provider.id, endpointModelId: "m-2", adminReasoning: { supported: true, effort: ["default"] } } });
    expect(() => mapModel(bad)).toThrow();
  });
});

// ---------- the upgrade: the previous head with rows, then this migration ----------

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

describe("upgrading a database at the previous head", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_effort_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-137: applies over rows in every table it alters, and every existing profile and task reads default", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(effortMigration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < effortMigration)) {
        await client.query(await migrationSql(migration));
      }
      // The previous head, with rows in every table this migration alters, and their parents.
      await client.query(`
        INSERT INTO "user" (id, name, email, username, "updatedAt") VALUES ('user-1', 'Admin', 'admin@example.com', 'admin', now());
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem-1', 'org-1', 'user-1', 'admin', now());
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt") VALUES ('prov-1', 'org-1', 'Anthropic', 'https://api.anthropic.com', 'anthropic_messages', 'x_api_key', 'ref', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "updatedAt") VALUES ('model-1', 'org-1', 'prov-1', 'claude', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "modelId", "builtIn", "updatedAt") VALUES ('prof-1', 'org-1', 'OpenCode', 'opencode', 'model-1', true, now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", "updatedAt") VALUES ('task-1', 'org-1', 'proj-1', 'code', 'prompt', 'Add docs', 'Add docs', 'ostra/add-docs', now());
        INSERT INTO "session" (id, "organizationId", "projectId", "taskId", origin, "updatedAt") VALUES ('sess-1', 'org-1', 'proj-1', 'task-1', 'new', now());
        INSERT INTO "turn" (id, "organizationId", "projectId", "taskId", "sessionId", ordinal, "startSeq", "outputTokens") VALUES ('turn-1', 'org-1', 'proj-1', 'task-1', 'sess-1', 1, 1, 900);
      `);
      await client.query(await migrationSql(effortMigration));
      for (const migration of all.filter((entry) => entry > effortMigration)) {
        await client.query(await migrationSql(migration));
      }
      expect(await rowsOf(client, `SELECT effort::text AS effort FROM "agent_profile" WHERE id = 'prof-1'`)).toEqual([{ effort: "default" }]);
      expect(await rowsOf(client, `SELECT effort::text AS effort FROM "task" WHERE id = 'task-1'`)).toEqual([{ effort: "default" }]);
      expect(await rowsOf(client, `SELECT "catalogReasoning", "adminReasoning" FROM "model" WHERE id = 'model-1'`)).toEqual([{ catalogReasoning: null, adminReasoning: null }]);
      expect(await rowsOf(client, `SELECT effort, "effortAdjustedFrom", "reasoningTokens", "outputTokens" FROM "turn" WHERE id = 'turn-1'`)).toEqual([
        { effort: null, effortAdjustedFrom: null, reasoningTokens: 0, outputTokens: 900 },
      ]);
      expect(await rowsOf(client, `SELECT "reasoningTokens" FROM "session" WHERE id = 'sess-1'`)).toEqual([{ reasoningTokens: 0 }]);
      // The new values are usable after the upgrade.
      await client.query(`UPDATE "task" SET effort = 'xhigh' WHERE id = 'task-1'`);
      expect(await rowsOf(client, `SELECT unnest(enum_range(NULL::"CommandKind"))::text AS kind`)).toContainEqual({ kind: "set_effort" });
    });
  });
});
