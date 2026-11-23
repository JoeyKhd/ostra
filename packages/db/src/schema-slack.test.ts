import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runPrisma } from "./dev/prisma-cli.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { buildIsolationRows, isolationModelNames, isolationProjectModels } from "./testing/isolation-models.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Post-v1 (F-057, ADR 0074): Slack's tables and channel. Additive: one enum value and two tables,
// nothing seeded, nothing dropped or renamed. It applies on a fresh database and over a milestone 11
// install, whose every row reads the same after it. Every secret column holds a `SecretRef`, never
// a value, and the two tables are on the isolation list.

const slackMigration = "20261205100000_slack_installation";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
const migrationNames = async (): Promise<string[]> =>
  (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const withClient = async <T,>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

type Row = Record<string, unknown>;
const rowsOf = async (client: pg.Client, sql: string, values: readonly unknown[] = []): Promise<Row[]> => (await client.query<Row>(sql, [...values])).rows;

const serverUrl = (): string => inject("ostraDbServerUrl");
const created: string[] = [];

const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_slack_${randomBytes(6).toString("hex")}`;
  await withClient(serverUrl(), (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
  created.push(name);
  const url = new URL(serverUrl());
  url.pathname = `/${name}`;
  return url.toString();
};

const apply = async (url: string, names: readonly string[]): Promise<void> => {
  await withClient(url, async (client) => {
    for (const name of names) {
      await client.query(await migrationSql(name));
    }
  });
};

const tablesOf = async (client: pg.Client, table: string): Promise<Row[]> =>
  rowsOf(
    client,
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );

const enumValues = async (client: pg.Client, name: string): Promise<readonly string[]> =>
  (await rowsOf(client, `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`)).map((row) => String(row["value"]));

describe("the Slack migration (F-057/c2)", () => {
  const secretColumns = ["botTokenSecretRef", "clientSecretSecretRef", "refreshTokenSecretRef"];

  it("F-057/c2: adds only: one enum value and two tables, with no DROP, no backfill and nothing renamed", async () => {
    const names = await migrationNames();
    expect(names).toContain(slackMigration);
    expect(names.indexOf(slackMigration)).toBeGreaterThan(names.indexOf("20261205000000_environment_network_rule"));
    const sql = (await migrationSql(slackMigration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE|DROP TYPE|DROP CONSTRAINT|\bDELETE FROM\b|\bINSERT INTO\b|UPDATE\s+"/i);
    expect(sql).toContain(`ALTER TYPE "NotificationChannel" ADD VALUE 'slack'`);
    expect(sql).toContain(`CREATE TYPE "SlackInstallState" AS ENUM ('pending', 'active', 'failed', 'revoked')`);
    expect(sql).toContain(`CREATE TABLE "slack_installation"`);
    expect(sql).toContain(`CREATE TABLE "slack_identity"`);
    // One Slack per organization, one identity per member, and the workspace user's index.
    expect(sql).toContain(`CREATE UNIQUE INDEX "slack_installation_organizationId_key" ON "slack_installation"("organizationId")`);
    expect(sql).toContain(`CREATE UNIQUE INDEX "slack_identity_organizationId_memberId_key" ON "slack_identity"("organizationId", "memberId")`);
    expect(sql).toContain(`CREATE INDEX "slack_identity_organizationId_slackUserId_idx" ON "slack_identity"("organizationId", "slackUserId")`);
    // The organization's cascade, and the member's by its composite key: another organization's member is refused.
    expect(sql).toContain(`FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE`);
    expect(sql).toContain(`FOREIGN KEY ("memberId", "organizationId") REFERENCES "member"("id", "organizationId") ON DELETE CASCADE`);
  });

  it("F-057/c2: applies on a fresh database, and the schema then has nothing of it left to migrate", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    await withClient(url, async (client) => {
      expect((await tablesOf(client, "slack_installation")).map((column) => column["column_name"])).toEqual([
        "id",
        "organizationId",
        "state",
        "clientId",
        "clientSecretSecretRef",
        "botTokenSecretRef",
        "refreshTokenSecretRef",
        "teamId",
        "teamName",
        "botUserId",
        "appId",
        "scopes",
        "tokenExpiresAt",
        "lastCheckedAt",
        "lastError",
        "oauthStateHash",
        "oauthStateExpiresAt",
        "installedByMemberId",
        "revokedAt",
        "createdAt",
        "updatedAt",
      ]);
      expect((await tablesOf(client, "slack_identity")).map((column) => column["column_name"])).toEqual([
        "id",
        "organizationId",
        "memberId",
        "slackUserId",
        "slackTeamId",
        "matchedEmail",
        "checkedAt",
        "createdAt",
        "updatedAt",
      ]);
      // The old release's three channels stay, in their order; `slack` is appended.
      expect(await enumValues(client, "NotificationChannel")).toEqual(["panel", "tracker", "email", "slack"]);
      expect(await enumValues(client, "SlackInstallState")).toEqual(["pending", "active", "failed", "revoked"]);
    });
    // `prisma migrate diff` from the migrated database to the schema holds nothing of this migration.
    // Its only statements are older partial indexes whose `IN` lists Postgres keeps as
    // `= ANY (ARRAY[...])` (the same noise `schema-m11.test.ts` records).
    const diff = await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], { databaseUrl: url });
    expect(diff.ok, diff.output).toBe(true);
    const statements = diff.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(CREATE|DROP|ALTER)\b/.test(line));
    expect(statements.some((line) => /slack_installation|slack_identity|SlackInstallState/.test(line))).toBe(false);
  }, 120_000);

  it("F-057/c2: the secret columns are references by name and by value, and nothing else can hold a token", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    await withClient(url, async (client) => {
      const installation = await tablesOf(client, "slack_installation");
      const names = installation.map((column) => String(column["column_name"]));
      expect(names.filter((name) => /secret/i.test(name)).sort()).toEqual([...secretColumns].sort());
      // The one other column whose name says token is the date it expires, never a token.
      expect(names.filter((name) => /token|secret/i.test(name) && !name.endsWith("SecretRef"))).toEqual(["tokenExpiresAt"]);
      expect(installation.find((column) => column["column_name"] === "tokenExpiresAt")?.["data_type"]).toBe("timestamp without time zone");
      for (const column of installation.filter((each) => /secret/i.test(String(each["column_name"])))) {
        expect(column["data_type"], String(column["column_name"])).toBe("text");
      }
      // `refreshTokenSecretRef` is nullable for rotation off; the client's is always set.
      expect(installation.find((column) => column["column_name"] === "refreshTokenSecretRef")?.["is_nullable"]).toBe("YES");
      expect(installation.find((column) => column["column_name"] === "clientSecretSecretRef")?.["is_nullable"]).toBe("NO");

      const organizationId = randomUUID();
      await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, 'Calc', 'calc', now())`, [organizationId]);
      // `secretRefSchema`'s shape (`<store>:<opaque>`, adapter-sdk): a reference holds no part of a value.
      const ref = (store: string): string => `${store}:${randomBytes(16).toString("base64url")}`;
      const secretsWritten = { client: ref("builtin"), bot: ref("builtin"), refresh: ref("builtin") };
      for (const value of Object.values(secretsWritten)) {
        expect(value).toMatch(/^[a-z][a-z0-9-]*:\S+$/);
      }
      await client.query(
        `INSERT INTO "slack_installation" ("id", "organizationId", "clientId", "clientSecretSecretRef", "botTokenSecretRef", "refreshTokenSecretRef", "installedByMemberId", "updatedAt") VALUES ($1, $2, '1234.5678', $3, $4, $5, $6, now())`,
        [randomUUID(), organizationId, secretsWritten.client, secretsWritten.bot, secretsWritten.refresh, randomUUID()],
      );
      expect(await rowsOf(client, `SELECT "clientSecretSecretRef" AS "client", "botTokenSecretRef" AS "bot", "refreshTokenSecretRef" AS "refresh" FROM "slack_installation"`)).toEqual([
        secretsWritten,
      ]);
    });
  }, 120_000);

  it("F-057/c2: applies over a milestone 11 install: every existing row reads the same, and `slack` is new", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < slackMigration));
    const organizationId = randomUUID();
    const userId = randomUUID();
    const memberId = randomUUID();
    const notificationId = randomUUID();
    const deliveryId = randomUUID();
    const preferenceId = randomUUID();
    await withClient(url, async (client) => {
      await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, 'Calc', 'calc', now())`, [organizationId]);
      await client.query(`INSERT INTO "user" ("id", "name", "email", "username", "updatedAt") VALUES ($1, 'Sam', 'sam@acme.test', 'sam', now())`, [userId]);
      await client.query(`INSERT INTO "member" ("id", "organizationId", "userId", "createdAt") VALUES ($1, $2, $3, now())`, [memberId, organizationId, userId]);
      await client.query(`INSERT INTO "notification" ("id", "organizationId", "memberId", "kind", "updatedAt") VALUES ($1, $2, $3, 'approval', now())`, [
        notificationId,
        organizationId,
        memberId,
      ]);
      await client.query(
        `INSERT INTO "notification_delivery" ("id", "organizationId", "notificationId", "channel", "adapter", "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, 'email', 'resend', $4, now())`,
        [deliveryId, organizationId, notificationId, `notify:${notificationId}:created:${memberId}:email`],
      );
      await client.query(`INSERT INTO "notification_preference" ("id", "organizationId", "memberId", "kind", "channel", "enabled", "updatedAt") VALUES ($1, $2, $3, 'approval', 'email', true, now())`, [
        preferenceId,
        organizationId,
        memberId,
      ]);
      // A milestone 11 database has neither table, and its channel enum has no `slack`.
      expect(await rowsOf(client, `SELECT to_regclass('public.slack_installation')::text AS "table"`)).toEqual([{ table: null }]);
      expect(await enumValues(client, "NotificationChannel")).toEqual(["panel", "tracker", "email"]);
      await expect(
        client.query(`INSERT INTO "notification_delivery" ("id", "organizationId", "notificationId", "channel", "adapter", "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, 'slack', 'slack', $4, now())`, [
          randomUUID(),
          organizationId,
          notificationId,
          `notify:${notificationId}:created:${memberId}:slack`,
        ]),
      ).rejects.toThrow(/invalid input value for enum/);
    });
    const before = {
      notifications: await withClient(url, (client) => rowsOf(client, `SELECT * FROM "notification" ORDER BY "id"`)),
      deliveries: await withClient(url, (client) => rowsOf(client, `SELECT * FROM "notification_delivery" ORDER BY "id"`)),
      preferences: await withClient(url, (client) => rowsOf(client, `SELECT * FROM "notification_preference" ORDER BY "id"`)),
    };

    await apply(url, names.filter((name) => name >= slackMigration));

    await withClient(url, async (client) => {
      expect(await rowsOf(client, `SELECT * FROM "notification" ORDER BY "id"`)).toEqual(before.notifications);
      expect(await rowsOf(client, `SELECT * FROM "notification_delivery" ORDER BY "id"`)).toEqual(before.deliveries);
      expect(await rowsOf(client, `SELECT * FROM "notification_preference" ORDER BY "id"`)).toEqual(before.preferences);
      expect(await enumValues(client, "NotificationChannel")).toEqual(["panel", "tracker", "email", "slack"]);
      // The new release alone writes `slack`, and the two tables join the organization.
      await client.query(`INSERT INTO "notification_delivery" ("id", "organizationId", "notificationId", "channel", "adapter", "idempotencyKey", "updatedAt") VALUES ($1, $2, $3, 'slack', 'slack', $4, now())`, [
        randomUUID(),
        organizationId,
        notificationId,
        `notify:${notificationId}:created:${memberId}:slack`,
      ]);
      await client.query(`INSERT INTO "slack_identity" ("id", "organizationId", "memberId", "slackUserId", "slackTeamId", "matchedEmail", "checkedAt", "updatedAt") VALUES ($1, $2, $3, 'U123', 'T123', 'sam@acme.test', now(), now())`, [
        randomUUID(),
        organizationId,
        memberId,
      ]);
      expect(await rowsOf(client, `SELECT "channel"::text FROM "notification_delivery" ORDER BY "channel"::text`)).toEqual([{ channel: "email" }, { channel: "slack" }]);
      expect(await rowsOf(client, `SELECT "slackUserId" FROM "slack_identity"`)).toEqual([{ slackUserId: "U123" }]);
      // Deleting the membership deletes its identity: the member relation cascades.
      await client.query(`DELETE FROM "member" WHERE "id" = $1`, [memberId]);
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "slack_identity"`)).toEqual([{ n: 0 }]);
    });
  }, 120_000);
});

describe("Slack's one install and one identity (F-057/c8)", () => {
  let test: TestDatabase;
  let fixture: IsolationFixture;

  beforeAll(async () => {
    test = await createTestDatabase();
    fixture = await seedIsolationFixture(test.db);
  }, 120_000);

  afterAll(async () => {
    await test.dispose();
    for (const name of created) {
      await withClient(serverUrl(), (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
    }
  });

  it("F-057/c8: a second installation for one organization is refused by Postgres", async () => {
    const { a } = fixture;
    const data = { organizationId: a.organization.id, clientId: "client-1", clientSecretSecretRef: "builtin:one", installedByMemberId: a.admin.id };
    await test.db.slackInstallation.create({ data });
    await expect(test.db.slackInstallation.create({ data: { ...data, clientId: "client-2", clientSecretSecretRef: "builtin:two" } })).rejects.toThrow(
      /slack_installation_organizationId_key/,
    );
  });

  it("F-057/c8: a Slack identity of another organization's member is refused by the composite relation", async () => {
    const { a, b } = fixture;
    const identity = { slackUserId: "U1", slackTeamId: "T1", matchedEmail: "insider@acme.test", checkedAt: new Date() };
    await expect(test.db.slackIdentity.create({ data: { ...identity, organizationId: a.organization.id, memberId: b.admin.id } })).rejects.toThrow(
      /slack_identity_memberId_organizationId_fkey/,
    );
    await test.db.slackIdentity.create({ data: { ...identity, organizationId: a.organization.id, memberId: a.admin.id } });
    await expect(test.db.slackIdentity.create({ data: { ...identity, organizationId: a.organization.id, memberId: a.admin.id } })).rejects.toThrow(
      /slack_identity_organizationId_memberId_key/,
    );
  });

  it("F-057/c8: the generated isolation suite covers both tables, built in two organizations", async () => {
    // The tests above made one install and one identity in A: the builder makes its own.
    await test.db.slackInstallation.deleteMany({});
    await test.db.slackIdentity.deleteMany({});
    expect(isolationModelNames()).toContain("SlackInstallation");
    expect(isolationModelNames()).toContain("SlackIdentity");
    expect(isolationProjectModels.has("SlackInstallation")).toBe(false);
    expect(isolationProjectModels.has("SlackIdentity")).toBe(false);
    const { a, b } = fixture;
    const rowsA = await buildIsolationRows(test.db, { organizationId: a.organization.id, memberId: a.admin.id, userId: a.admin.userId }, [a.openProject.id]);
    const rowsB = await buildIsolationRows(test.db, { organizationId: b.organization.id, memberId: b.admin.id, userId: b.admin.userId }, [b.project.id]);
    const installationA = rowsA.get(a.openProject.id)?.get("SlackInstallation");
    const installationB = rowsB.get(b.project.id)?.get("SlackInstallation");
    const identityA = rowsA.get(a.openProject.id)?.get("SlackIdentity");
    const identityB = rowsB.get(b.project.id)?.get("SlackIdentity");
    expect([installationA, installationB, identityA, identityB].every((value) => value !== undefined)).toBe(true);
    const installations = await test.db.slackInstallation.findMany({ where: { id: { in: [installationA ?? "", installationB ?? ""] } }, select: { organizationId: true } });
    expect(new Set(installations.map((row) => row.organizationId))).toEqual(new Set([a.organization.id, b.organization.id]));
    const identities = await test.db.slackIdentity.findMany({ where: { id: { in: [identityA ?? "", identityB ?? ""] } }, select: { organizationId: true } });
    expect(new Set(identities.map((row) => row.organizationId))).toEqual(new Set([a.organization.id, b.organization.id]));
  });
});
