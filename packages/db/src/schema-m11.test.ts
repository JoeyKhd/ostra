import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runPrisma } from "./dev/prisma-cli.ts";
import { buildIsolationRows } from "./testing/isolation-models.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 11's migration (ticket 01, spec section 5.1, ADR 0071): several tracker connections per
// organization, of any kind, and Jira. It adds two enum values, nullable columns, a per-site index
// and a board key per connection, and drops only the two constraints ADR 0071 relaxes. Over a
// milestone 10 database, Linear's existing connection becomes the first named one, a pending row's
// placeholder names its row, and a skipped setup step stays skipped.

const m11Migration = "20261204000000_milestone_11";
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

/** A database of its own, empty, and its URL. */
const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_upgrade_m11_${randomBytes(6).toString("hex")}`;
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

const indexNames = async (client: pg.Client, table: string): Promise<string[]> =>
  (await rowsOf(client, `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`, [table])).map((row) => String(row["indexname"]));

/** The IDs a milestone 10 install holds, for reading them back. */
type MilestoneTen = {
  readonly organizationId: string;
  readonly otherOrganizationId: string;
  readonly linearId: string;
  readonly revokedId: string;
  readonly unnamedId: string;
  readonly pendingId: string;
  readonly githubId: string;
  readonly boardIds: readonly string[];
  readonly ticketIds: readonly string[];
};

/**
 * A milestone 10 install, written in milestone 10's schema: an organization with its GitHub App,
 * one active Linear connection with agent mode on, two boards (one in agent mode) with cached
 * tickets, a revoked older Linear row, and its Linear setup step skipped; and a second
 * organization whose Linear connection is pending, and a third whose workspace was never read.
 */
/** When the seeded organization skipped its Linear step. */
const skippedAt = new Date("2026-11-20T10:00:00Z");

const seedMilestoneTen = async (url: string): Promise<MilestoneTen> =>
  withClient(url, async (client) => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    const unreadOrganizationId = randomUUID();
    const projectId = randomUUID();
    const [linearId, revokedId, unnamedId, pendingId, githubId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const boardIds = [randomUUID(), randomUUID()];
    const ticketIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, slug] of [
      [organizationId, "acme"],
      [otherOrganizationId, "globex"],
      [unreadOrganizationId, "northwind"],
    ] as const) {
      await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, $2, $2, now())`, [id, slug]);
    }
    await client.query(`INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "slug", "updatedAt") VALUES ($1, $2, 'github', '5821041', 'ostra-test', now())`, [githubId, organizationId]);
    // The revoked older Linear row, its app ID given back; then the active one with agent mode on.
    await client.query(
      `INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "externalWorkspaceId", "externalWorkspaceKey", "externalWorkspaceName", "updatedAt")
       VALUES ($1, $2, 'linear', $3, 'revoked', 'app_oauth', 'ws-acme', 'acme', 'Acme', now())`,
      [revokedId, organizationId, `revoked:${revokedId}`],
    );
    await client.query(
      `INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "externalWorkspaceId", "externalWorkspaceKey", "externalWorkspaceName",
         "appUserId", "appUserName", "accessTokenSecretRef", "webhookSecretSecretRef", "clientSecretSecretRef", "activatedAt", "scopes", "agentModeAt", "updatedAt")
       VALUES ($1, $2, 'linear', 'client-acme', 'active', 'app_oauth', 'ws-acme', 'acme', 'Acme', 'app-user-1', 'ostra', 'secret:access', 'secret:webhook', 'secret:client',
         now(), ARRAY['read', 'write', 'app:assignable', 'app:mentionable'], now(), now())`,
      [linearId, organizationId],
    );
    // Another organization's pending Linear row, before the admin pasted the client ID.
    await client.query(`INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "updatedAt") VALUES ($1, $2, 'linear', 'pending', 'pending', 'app_oauth', now())`, [
      pendingId,
      otherOrganizationId,
    ]);
    // A third organization's Linear row whose workspace was never read (the development seed's API key).
    await client.query(`INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "updatedAt") VALUES ($1, $2, 'linear', 'api-key', 'active', 'api_key', now())`, [
      unnamedId,
      unreadOrganizationId,
    ]);
    await client.query(`INSERT INTO "project" ("id", "organizationId", "name", "slug", "updatedAt") VALUES ($1, $2, 'Calc', 'calc', now())`, [projectId, organizationId]);
    const statusMap = JSON.stringify({ open: "s-todo", started: "s-doing", inReview: "s-review", done: "s-done" });
    for (const [index, boardId] of boardIds.entries()) {
      await client.query(
        `INSERT INTO "board" ("id", "organizationId", "projectId", "connectionId", "externalId", "name", "key", "statusMap", "pollCursor", "agentMode", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, now())`,
        [boardId, organizationId, projectId, linearId, `team-${String(index)}`, `Team ${String(index)}`, index === 0 ? "CALC" : "OPS", statusMap, index === 0],
      );
    }
    for (const [index, ticketId] of ticketIds.entries()) {
      await client.query(
        `INSERT INTO "ticket" ("id", "organizationId", "projectId", "boardId", "connectionId", "externalId", "key", "title", "url", "trackerUpdatedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'A ticket', 'https://linear.app/acme/issue/x', now(), now())`,
        [ticketId, organizationId, projectId, boardIds[index % boardIds.length], linearId, `issue-${String(index)}`, `CALC-${String(170 + index)}`],
      );
    }
    await client.query(`INSERT INTO "organization_setting" ("organizationId", "linearSkippedAt", "linearSkippedByMemberId", "updatedAt") VALUES ($1, $2, 'member-1', now())`, [
      organizationId,
      skippedAt,
    ]);
    await client.query(`INSERT INTO "organization_setting" ("organizationId", "updatedAt") VALUES ($1, now())`, [otherOrganizationId]);
    return { organizationId, otherOrganizationId, linearId, revokedId, unnamedId, pendingId, githubId, boardIds, ticketIds };
  });

let test: TestDatabase;
let fixture: IsolationFixture;
let ticketWriteId: string;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  const built = await buildIsolationRows(test.db, { organizationId: fixture.a.organization.id, memberId: fixture.a.admin.id, userId: fixture.a.admin.userId }, [fixture.a.openProject.id]);
  const write = built.get(fixture.a.openProject.id)?.get("TicketWrite");
  if (write === undefined) {
    throw new Error("no ticket write built");
  }
  ticketWriteId = write;
}, 120_000);

afterAll(async () => {
  await test.dispose();
  for (const name of created) {
    await withClient(serverUrl(), (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  }
});

describe("the milestone 11 migration", () => {
  it("F-152/c6: adds and relaxes only: two enum values, nullable columns, two indexes, and no DROP but the two constraints ADR 0071 names", async () => {
    const names = await migrationNames();
    expect(names).toContain(m11Migration);
    expect(names.indexOf(m11Migration)).toBeGreaterThan(names.indexOf("20261203110000_box_released_with_its_session"));
    const sql = (await migrationSql(m11Migration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bRENAME\b|ALTER COLUMN|DROP COLUMN|DROP TABLE|DROP TYPE|DROP CONSTRAINT|\bDELETE FROM\b|\bINSERT INTO\b/i);
    expect([...sql.matchAll(/\bDROP\s+(\w+)\s+"([^"]+)"/gi)].map((match) => `${match[1] ?? ""} ${match[2] ?? ""}`)).toEqual([
      "INDEX connection_one_linear_per_organization",
      "INDEX board_projectId_externalId_key",
    ]);
    expect(sql).toContain(`ALTER TYPE "ConnectionKind" ADD VALUE 'jira'`);
    expect(sql).toContain(`ALTER TYPE "ConnectionCredential" ADD VALUE 'service_account_token'`);
    // Each relaxed constraint is dropped only after the one replacing it exists.
    expect(sql.indexOf(`CREATE UNIQUE INDEX "connection_one_site_per_organization"`)).toBeLessThan(sql.indexOf(`DROP INDEX "connection_one_linear_per_organization"`));
    expect(sql.indexOf(`CREATE UNIQUE INDEX "board_one_per_connection_board_per_project"`)).toBeLessThan(sql.indexOf(`DROP INDEX "board_projectId_externalId_key"`));
  });

  it("applies on an empty database, and the schema then has nothing of milestone 11 left to migrate", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    // `prisma migrate diff` from the migrated database to the schema holds nothing of milestone 11.
    // Its only statements re-create three older partial indexes whose `IN` lists Postgres keeps as
    // `= ANY (ARRAY[...])`, which Prisma reads as different text: noise from milestones 1 to 6.
    const diff = await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], { databaseUrl: url });
    expect(diff.ok, diff.output).toBe(true);
    const statements = diff.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(CREATE|DROP|ALTER)\b/.test(line));
    const indexes = new Set(statements.map((line) => /INDEX "([^"]+)"/.exec(line)?.[1] ?? line));
    expect([...indexes].sort()).toEqual(["event_turn_boundary", "session_one_active_per_task", "task_one_active_code_task_per_ticket"]);
  }, 120_000);

  it("F-152/c6: over a milestone 10 database, Linear's connection becomes the first named one, nothing is lost, and a second Linear connection can join it", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < m11Migration));
    const seeded = await seedMilestoneTen(url);
    const before = await withClient(url, async (client) => ({
      connections: await rowsOf(client, `SELECT "id", "kind", "state", "externalWorkspaceId", "agentModeAt" IS NOT NULL AS "agentMode", "scopes" FROM "connection" ORDER BY "id"`),
      boards: await rowsOf(client, `SELECT "id", "connectionId", "externalId", "statusMap", "agentMode", "pollCursor" FROM "board" ORDER BY "id"`),
      tickets: await rowsOf(client, `SELECT "id", "boardId", "connectionId", "externalId", "key" FROM "ticket" ORDER BY "id"`),
    }));

    await apply(url, names.filter((name) => name >= m11Migration));

    await withClient(url, async (client) => {
      // Every row reads back as it was.
      expect(await rowsOf(client, `SELECT "id", "kind", "state", "externalWorkspaceId", "agentModeAt" IS NOT NULL AS "agentMode", "scopes" FROM "connection" ORDER BY "id"`)).toEqual(before.connections);
      expect(await rowsOf(client, `SELECT "id", "connectionId", "externalId", "statusMap", "agentMode", "pollCursor" FROM "board" ORDER BY "id"`)).toEqual(before.boards);
      expect(await rowsOf(client, `SELECT "id", "boardId", "connectionId", "externalId", "key" FROM "ticket" ORDER BY "id"`)).toEqual(before.tickets);
      // Linear's rows are named from their workspace, or `Linear` when it was never read; GitHub's has none.
      const named = await rowsOf(client, `SELECT "id", "name", "appId" FROM "connection" ORDER BY "id"`);
      expect(named).toEqual(
        [
          { id: seeded.linearId, name: "Acme Linear", appId: "client-acme" },
          { id: seeded.revokedId, name: "Acme Linear", appId: `revoked:${seeded.revokedId}` },
          { id: seeded.unnamedId, name: "Linear", appId: "api-key" },
          // The pending placeholder names its row.
          { id: seeded.pendingId, name: "Linear", appId: `pending:${seeded.pendingId}` },
          { id: seeded.githubId, name: null, appId: "5821041" },
        ].sort((x, y) => (x.id < y.id ? -1 : 1)),
      );
      // The new columns are empty on every old row.
      expect(
        await rowsOf(
          client,
          `SELECT count(*)::int AS n FROM "connection" WHERE "accountEmail" IS NOT NULL OR "tokenExpiresOn" IS NOT NULL OR "accessCheck" IS NOT NULL OR "accessCheckedAt" IS NOT NULL
             OR "firstDeliveryAt" IS NOT NULL OR "badSignatureAt" IS NOT NULL OR "resumedIntoId" IS NOT NULL`,
        ),
      ).toEqual([{ n: 0 }]);
      // The skipped setup step stays skipped, under the tracker step's column too; `linearSkippedAt` stays.
      const settings = await rowsOf(client, `SELECT "organizationId", "linearSkippedAt", "trackerSkippedAt" FROM "organization_setting" ORDER BY "organizationId"`);
      expect(settings).toEqual(
        [
          { organizationId: seeded.organizationId, linearSkippedAt: skippedAt, trackerSkippedAt: skippedAt },
          { organizationId: seeded.otherOrganizationId, linearSkippedAt: null, trackerSkippedAt: null },
        ].sort((x, y) => (x.organizationId < y.organizationId ? -1 : 1)),
      );
      // The new indexes exist and the two old ones don't.
      const connectionIndexes = await indexNames(client, "connection");
      expect(connectionIndexes).toContain("connection_one_site_per_organization");
      expect(connectionIndexes).not.toContain("connection_one_linear_per_organization");
      const boardIndexes = await indexNames(client, "board");
      expect(boardIndexes).toContain("board_one_per_connection_board_per_project");
      expect(boardIndexes).not.toContain("board_projectId_externalId_key");
      // A second Linear connection, another client's workspace, joins the first in its organization:
      // milestone 2's one-Linear index would refuse it.
      await client.query(
        `INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "externalWorkspaceId", "name", "updatedAt")
         VALUES ($1, $2, 'linear', 'client-northwind', 'active', 'app_oauth', 'ws-northwind', 'Northwind Linear', now())`,
        [randomUUID(), seeded.organizationId],
      );
      // And a Jira connection beside them, by its service account's token.
      await client.query(
        `INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "state", "credentialKind", "externalWorkspaceId", "externalWorkspaceKey", "name", "tokenExpiresOn", "updatedAt")
         VALUES ($1, $2, 'jira', 'cloud-globex', 'active', 'service_account_token', 'cloud-globex', 'globex.atlassian.net', 'Globex Jira', '2027-02-01', now())`,
        [randomUUID(), seeded.organizationId],
      );
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "connection" WHERE "organizationId" = $1 AND "kind" <> 'github' AND "state" <> 'revoked'`, [seeded.organizationId])).toEqual([{ n: 3 }]);
    });
  }, 120_000);
});

describe("one tracker connection per site, in Postgres (ADR 0071)", () => {
  /** A tracker connection of the organization: `appId` is Linear's client ID, or Jira's cloud ID. */
  const connect = (organizationId: string, kind: "linear" | "jira", appId: string, workspace: string | null) =>
    test.db.connection.create({
      data: {
        organizationId,
        kind,
        appId,
        state: "active",
        credentialKind: kind === "jira" ? "service_account_token" : "app_oauth",
        externalWorkspaceId: workspace,
        name: `${workspace ?? "No"} ${kind}`,
      },
    });
  /** What disconnecting does to the row: revoked, its app ID given back. */
  const revoke = (id: string) => test.db.connection.update({ where: { id }, data: { state: "revoked", appId: `revoked:${id}` } });

  it("F-152/c2: a second connection of one kind on the same site is refused while the first isn't revoked, and allowed once it is; another organization may hold the same site", async () => {
    const a = fixture.a.organization.id;
    const b = fixture.b.organization.id;
    // Linear: two apps on one workspace in one organization.
    const first = await connect(a, "linear", `client-${randomUUID()}`, "ws-acme");
    await expect(connect(a, "linear", `client-${randomUUID()}`, "ws-acme")).rejects.toThrow(/Unique constraint|connection_one_site_per_organization/);
    // Several connections still pending, the workspace not known yet, sit side by side.
    await connect(a, "linear", `pending:${randomUUID()}`, null);
    await connect(a, "linear", `pending:${randomUUID()}`, null);
    // A failed connection still holds its site.
    await test.db.connection.update({ where: { id: first.id }, data: { state: "failed" } });
    await expect(connect(a, "linear", `client-${randomUUID()}`, "ws-acme")).rejects.toThrow(/Unique constraint|connection_one_site_per_organization/);
    await revoke(first.id);
    await connect(a, "linear", `client-${randomUUID()}`, "ws-acme");
    // Jira: the site's cloud ID, as its app ID and its workspace.
    const globex = await connect(a, "jira", "cloud-globex", "cloud-globex");
    await expect(test.db.connection.create({ data: { organizationId: a, kind: "jira", appId: `pending:${randomUUID()}`, state: "pending", externalWorkspaceId: "cloud-globex", name: "Again" } })).rejects.toThrow(
      /Unique constraint|connection_one_site_per_organization/,
    );
    await revoke(globex.id);
    await connect(a, "jira", "cloud-globex", "cloud-globex");
    // The same site in another organization is that organization's own.
    await connect(b, "jira", "cloud-globex", "cloud-globex");
    await connect(b, "linear", `client-${randomUUID()}`, "ws-acme");
    // A workspace ID of one kind doesn't hold another kind's.
    await connect(a, "jira", "ws-acme", "ws-acme");
    // And two GitHub Apps are never held to it.
    await test.db.connection.create({ data: { organizationId: a, kind: "github", appId: `gh-${randomUUID()}`, externalWorkspaceId: "same" } });
    await test.db.connection.create({ data: { organizationId: a, kind: "github", appId: `gh-${randomUUID()}`, externalWorkspaceId: "same" } });
  });

  it("F-152/c4: two connections' boards with the same external ID attach to one project; one connection's twice is refused", async () => {
    const organizationId = fixture.a.organization.id;
    const projectId = fixture.a.openProject.id;
    const globex = await connect(organizationId, "jira", `cloud-${randomUUID()}`, `site-${randomUUID()}`);
    const initech = await connect(organizationId, "jira", `cloud-${randomUUID()}`, `site-${randomUUID()}`);
    const board = (connectionId: string) =>
      test.db.board.create({ data: { organizationId, projectId, connectionId, externalId: "10000", name: "Shop", key: "SHOP", statusMap: { open: "1", started: "3", inReview: "10001", done: "10002" } } });
    // Two Jira sites each have a project `10000`: two boards of one project.
    const one = await board(globex.id);
    const two = await board(initech.id);
    expect(new Set([one.connectionId, two.connectionId])).toEqual(new Set([globex.id, initech.id]));
    expect(await test.db.board.count({ where: { projectId, externalId: "10000" } })).toBe(2);
    // The same connection's project twice in one project is refused.
    await expect(board(globex.id)).rejects.toThrow(/Unique constraint|board_one_per_connection_board_per_project/);
    // And another project may attach it.
    const other = await test.db.project.create({ data: { organizationId, name: "Other", slug: `other-${randomUUID().slice(0, 8)}` } });
    await test.db.board.create({ data: { organizationId, projectId: other.id, connectionId: globex.id, externalId: "10000", name: "Shop", statusMap: {} } });
  });

  it("F-008: a move's transitions and Jira's columns read back as written, and none holds a secret", async () => {
    const organizationId = fixture.a.organization.id;
    const jira = await test.db.connection.create({
      data: {
        organizationId,
        kind: "jira",
        appId: `cloud-${randomUUID()}`,
        state: "pending",
        credentialKind: "service_account_token",
        name: "Globex Jira",
        accountEmail: "ostra@serviceaccount.atlassian.com",
        tokenExpiresOn: new Date("2027-03-01T00:00:00Z"),
        accessCheck: { projects: [{ key: "SHOP", id: "10000", name: "Shop", permissions: { BROWSE_PROJECTS: true } }], workflowsReadable: false },
        accessCheckedAt: new Date(),
        badSignatureAt: new Date(),
      },
    });
    expect(jira).toMatchObject({ kind: "jira", credentialKind: "service_account_token", tokenExpiresOn: new Date("2027-03-01T00:00:00Z"), firstDeliveryAt: null, resumedIntoId: null });
    // `tokenExpiresOn` is a date: a time of day isn't kept.
    const later = await test.db.connection.update({ where: { id: jira.id }, data: { tokenExpiresOn: new Date("2027-03-02T17:45:00Z") } });
    expect(later.tokenExpiresOn).toEqual(new Date("2027-03-02T00:00:00Z"));
    const settings = await test.db.organizationSetting.upsert({
      where: { organizationId },
      create: { organizationId, trackerSkippedAt: new Date("2026-11-23T09:00:00Z") },
      update: { trackerSkippedAt: new Date("2026-11-23T09:00:00Z") },
    });
    expect(settings.trackerSkippedAt).toEqual(new Date("2026-11-23T09:00:00Z"));
    // A move's transitions, for the task's "On Jira" rows: none until it's done.
    expect((await test.db.ticketWrite.findUniqueOrThrow({ where: { id: ticketWriteId } })).via).toBeNull();
    const via = [
      { id: "11", name: "Start progress" },
      { id: "21", name: "Ready for review" },
    ];
    expect((await test.db.ticketWrite.update({ where: { id: ticketWriteId }, data: { via } })).via).toEqual(via);
  });
});
