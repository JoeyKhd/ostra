import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runPrisma } from "./dev/prisma-cli.ts";
import { buildIsolationRows } from "./testing/isolation-models.ts";
import type { IsolationModelName } from "./testing/isolation-models.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 8's migration (ticket 04, spec section 5.3, ADR 0068, ADR 0069): previews and the
// library. It's additive, applies on an empty database and on one at the head before it with rows
// in every table it alters, backfills nothing, matches the schema, and keeps the rules Prisma can't
// declare: one primary app process per environment, a link that expires unless it's public, and
// the rest of its checks.

const m8Migration = "20261201120000_milestone_8";
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
const rowsOf = async (client: pg.Client, sql: string): Promise<Row[]> => (await client.query<Row>(sql)).rows;

const serverUrl = (): string => inject("ostraDbServerUrl");
const created: string[] = [];

/** A database of its own, empty, and its URL. */
const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_upgrade_m8_${randomBytes(6).toString("hex")}`;
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

const newTables = [
  "app_process",
  "task_attachment",
  "task_preview",
  "preview_access",
  "preview_access_member",
  "preview_link",
  "preview_view",
  "preview_code",
  "library_item",
  "library_item_version",
  "agent_profile_library_item",
  "library_source",
  "library_suggestion",
] as const;

const newEnums = {
  AppReadyKind: ["http", "command", "port"],
  AttachmentKind: ["screenshot", "recording"],
  AttachmentSource: ["agent", "after_turn", "member"],
  PreviewTargetKind: ["process", "port", "service"],
  PreviewLevel: ["members", "named"],
  PreviewLinkKind: ["expiring", "public"],
  PreviewViewMode: ["stream", "tunnel", "native", "cli"],
  PreviewViewState: ["opening", "open", "closed"],
  PreviewCodeKind: ["enter", "cli_ticket"],
  LeasePurpose: ["turn", "app"],
  LibraryItemKind: ["skill", "mcp_server"],
  LibraryItemSourceKind: ["github", "well_known", "registry"],
  LibrarySourceKind: ["github_owner", "github_repo", "well_known_host", "registry"],
  LibraryVersionState: ["current", "available", "superseded", "dismissed"],
  LibrarySuggestionState: ["open", "installed", "dismissed"],
} as const;

let test: TestDatabase;
let fixture: IsolationFixture;
let rows: ReadonlyMap<IsolationModelName, string>;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  const built = await buildIsolationRows(test.db, { organizationId: fixture.a.organization.id, memberId: fixture.a.admin.id, userId: fixture.a.admin.userId }, [fixture.a.openProject.id]);
  const open = built.get(fixture.a.openProject.id);
  if (open === undefined) {
    throw new Error("no rows built");
  }
  rows = open;
}, 120_000);

afterAll(async () => {
  await test.dispose();
  for (const name of created) {
    await withClient(serverUrl(), (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  }
});

const rowId = (model: IsolationModelName): string => {
  const id = rows.get(model);
  if (id === undefined) {
    throw new Error(`no ${model} row`);
  }
  return id;
};

describe("the milestone 8 migration", () => {
  it("is additive: new enums, tables and columns, and no DROP, RENAME or changed column", async () => {
    const names = await migrationNames();
    expect(names).toContain(m8Migration);
    // It comes after every earlier migration, milestone 7's and the ones since (minor 7's commands
    // last). Later ones may follow it: ticket 19's runner preview column is one.
    expect(names.indexOf("20261201100000_command_minor_7")).toBeGreaterThan(-1);
    expect(names.indexOf(m8Migration)).toBeGreaterThan(names.indexOf("20261201100000_command_minor_7"));
    const sql = (await migrationSql(m8Migration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    for (const table of newTables) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const [name, values] of Object.entries(newEnums)) {
      expect(sql).toContain(`CREATE TYPE "${name}" AS ENUM (${values.map((value) => `'${value}'`).join(", ")})`);
    }
  });

  it("applies on an empty database, and the schema then has nothing left to migrate", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    const tables = await withClient(url, (client) =>
      client.query<Row>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name", [[...newTables]]),
    );
    expect(tables.rows.map((row) => row["table_name"])).toEqual([...newTables].sort());
    // `prisma migrate diff` from the migrated database to the schema holds nothing of milestone 8.
    // Its only statements re-create three older partial indexes whose `IN` lists Postgres keeps as
    // `= ANY (ARRAY[...])`, which Prisma reads as different text: noise from milestones 1 to 6, the
    // same on `main` before this migration, and no change of shape.
    const diff = await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--script"], { databaseUrl: url });
    expect(diff.ok, diff.output).toBe(true);
    const statements = diff.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(CREATE|DROP|ALTER)\b/.test(line));
    const indexes = new Set(statements.map((line) => /INDEX "([^"]+)"/.exec(line)?.[1] ?? line));
    expect([...indexes].sort()).toEqual(["event_turn_boundary", "session_one_active_per_task", "task_one_active_code_task_per_ticket"]);
  }, 120_000);

  it("applies on a database at the head before it, over rows in every table it alters, and backfills nothing", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < m8Migration));
    // The head before milestone 8, with rows in every table it alters (organization_setting,
    // environment, service, task, box, lease) and their parents.
    await withClient(url, (client) =>
      client.query(`
        INSERT INTO "user" (id, name, email, username, "updatedAt") VALUES ('user-1', 'Admin', 'admin@example.com', 'admin', now());
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem-1', 'org-1', 'user-1', 'admin', now());
        INSERT INTO "organization_setting" ("organizationId", "updatedAt") VALUES ('org-1', now());
        INSERT INTO "runner_pool" (id, "organizationId", name, "isDefault", "createdAt", "updatedAt") VALUES ('pool-1', 'org-1', 'default', true, now(), now());
        INSERT INTO "runner" (id, "organizationId", kind, "poolId", name, "publicKey", executor, capacity, labels, version, state, "updatedAt")
          VALUES ('run-1', 'org-1', 'pool', 'pool-1', 'build-01', 'key-1', 'docker', 4, ARRAY[]::TEXT[], '0.8.0', 'online', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "environment" (id, "organizationId", "projectId", "updatedAt") VALUES ('env-1', 'org-1', 'proj-1', now());
        INSERT INTO "service" (id, "organizationId", "projectId", "environmentId", name, image, port, variables, "updatedAt")
          VALUES ('svc-1', 'org-1', 'proj-1', 'env-1', 'mailpit', 'axllent/mailpit:v1.21', 8025, '[]', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", state, "updatedAt")
          VALUES ('task-1', 'org-1', 'proj-1', 'code', 'prompt', 'Add a footer', 'x', 'ostra/m8-upgrade', 'running', now());
        INSERT INTO "box" (id, "organizationId", "projectId", "taskId", "runnerId", executor, state, "updatedAt") VALUES ('box-1', 'org-1', 'proj-1', 'task-1', 'run-1', 'docker', 'ready', now());
        INSERT INTO "lease" (id, "organizationId", "projectId", "taskId", epoch, "runnerId", "boxId", state) VALUES ('lease-1', 'org-1', 'proj-1', 'task-1', 1, 'run-1', 'box-1', 'active');
      `),
    );
    await apply(url, names.filter((name) => name >= m8Migration));
    await withClient(url, async (client) => {
      expect(await rowsOf(client, `SELECT "publicPreviewLinks", "marketplaceSearch" FROM "organization_setting"`)).toEqual([{ publicPreviewLinks: false, marketplaceSearch: false }]);
      expect(await rowsOf(client, `SELECT "screenshotsAfterTurn", "screenshotRoutes", "screenshotWidths" FROM "environment"`)).toEqual([
        { screenshotsAfterTurn: true, screenshotRoutes: ["/"], screenshotWidths: ["desktop"] },
      ]);
      expect(await rowsOf(client, `SELECT "previewLabel", image FROM "service"`)).toEqual([{ previewLabel: null, image: "axllent/mailpit:v1.21" }]);
      expect(await rowsOf(client, `SELECT "previewId", title FROM "task"`)).toEqual([{ previewId: null, title: "Add a footer" }]);
      expect(await rowsOf(client, `SELECT "previewWatchedAt", state FROM "box"`)).toEqual([{ previewWatchedAt: null, state: "ready" }]);
      expect(await rowsOf(client, `SELECT purpose, "appStartedByMemberId", state FROM "lease"`)).toEqual([{ purpose: "turn", appStartedByMemberId: null, state: "active" }]);
      // Nothing seeded: no app process, no library item, no source (ticket 06's job seeds the registry).
      for (const table of newTables) {
        expect(await rowsOf(client, `SELECT count(*)::int AS n FROM ${client.escapeIdentifier(table)}`), table).toEqual([{ n: 0 }]);
      }
      // The columns that are never logged say so.
      const comment = await rowsOf(
        client,
        `SELECT d.description FROM pg_description d JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid WHERE d.objoid = '"app_process"'::regclass AND a.attname = 'command'`,
      );
      expect(comment).toEqual([{ description: "ostra: an app process's command, run through the init's argument array. Never logged." }]);
    });
  }, 120_000);
});

describe("the milestone 8 rules the database keeps", () => {
  it("F-140: a second primary app process in one environment is refused by the index, and a second non-primary isn't", async () => {
    const first = await test.db.appProcess.findUniqueOrThrow({ where: { id: rowId("AppProcess") } });
    expect(first.primary).toBe(true);
    const base = {
      organizationId: first.organizationId,
      projectId: first.projectId,
      environmentId: first.environmentId,
      repoId: first.repoId,
      command: "node server.js",
      readyKind: "port" as const,
      label: "API",
    };
    await expect(test.db.appProcess.create({ data: { ...base, name: "api", port: 3001, primary: true } })).rejects.toThrow(/app_process_one_primary|Unique constraint/);
    const api = await test.db.appProcess.create({ data: { ...base, name: "api", port: 3001, primary: false } });
    expect(api.hostRewrite).toBe(true);
    // Names and ports are once per environment.
    await expect(test.db.appProcess.create({ data: { ...base, name: "api", port: 3002 } })).rejects.toThrow(/Unique constraint/);
    await expect(test.db.appProcess.create({ data: { ...base, name: "docs", port: 3001 } })).rejects.toThrow(/Unique constraint/);
    // A port below 1024, and a ready check's value that doesn't fit its kind, are refused.
    await expect(test.db.appProcess.create({ data: { ...base, name: "low", port: 80 } })).rejects.toThrow(/app_process_port_allowed/);
    await expect(test.db.appProcess.create({ data: { ...base, name: "odd", port: 3003, readyValue: "/" } })).rejects.toThrow(/app_process_ready_value_unless_port/);
    await expect(test.db.appProcess.create({ data: { ...base, name: "bare", port: 3004, readyKind: "http" } })).rejects.toThrow(/app_process_ready_value_unless_port/);
    // Another environment may have its own primary.
    const other = await buildIsolationRows(test.db, { organizationId: fixture.b.organization.id, memberId: fixture.b.admin.id, userId: fixture.b.admin.userId }, [fixture.b.project.id]);
    const otherProcess = other.get(fixture.b.project.id)?.get("AppProcess");
    expect(otherProcess === undefined ? null : (await test.db.appProcess.findUniqueOrThrow({ where: { id: otherProcess } })).primary).toBe(true);
  });

  it("F-142: a link expires unless it's public, a revoke names its member, and a token's hash is used once", async () => {
    const link = await test.db.previewLink.findUniqueOrThrow({ where: { id: rowId("PreviewLink") } });
    const base = { organizationId: link.organizationId, projectId: link.projectId, taskId: link.taskId, key: "app-web", createdByMemberId: link.createdByMemberId };
    await expect(test.db.previewLink.create({ data: { ...base, kind: "expiring", tokenHash: randomBytes(32).toString("hex") } })).rejects.toThrow(/preview_link_expires_unless_public/);
    await expect(
      test.db.previewLink.create({ data: { ...base, kind: "public", tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000) } }),
    ).rejects.toThrow(/preview_link_expires_unless_public/);
    const open = await test.db.previewLink.create({ data: { ...base, kind: "public", tokenHash: randomBytes(32).toString("hex") } });
    expect(open).toMatchObject({ allowInput: false, expiresAt: null, revokedAt: null });
    await expect(test.db.previewLink.update({ where: { id: open.id }, data: { revokedAt: new Date() } })).rejects.toThrow(/preview_link_revoked_has_member/);
    await expect(test.db.previewLink.create({ data: { ...base, kind: "public", tokenHash: link.tokenHash } })).rejects.toThrow(/Unique constraint/);
  });

  it("F-141, F-143, F-144: a view and a code name a member or a link, a CLI ticket a member, and a task's preview ID is 26 base32 characters", async () => {
    const view = await test.db.previewView.findUniqueOrThrow({ where: { id: rowId("PreviewView") } });
    const viewBase = { organizationId: view.organizationId, projectId: view.projectId, taskId: view.taskId, key: "app-web", mode: "stream" as const, leaseEpoch: 1 };
    await expect(test.db.previewView.create({ data: viewBase })).rejects.toThrow(/preview_view_member_or_link/);
    await expect(test.db.previewView.create({ data: { ...viewBase, openedByMemberId: view.openedByMemberId, state: "closed" } })).rejects.toThrow(/preview_view_closed_has_time/);
    // A box's refusal is a closed view's only.
    await expect(test.db.previewView.create({ data: { ...viewBase, openedByMemberId: view.openedByMemberId, refusal: "too-many-pages" } })).rejects.toThrow(/preview_view_refusal_when_closed/);
    const refused = await test.db.previewView.create({ data: { ...viewBase, openedByMemberId: view.openedByMemberId, state: "closed", closedAt: new Date(), refusal: "too-many-pages" } });
    expect(refused.refusal).toBe("too-many-pages");
    const code = await test.db.previewCode.findUniqueOrThrow({ where: { id: rowId("PreviewCode") } });
    const codeBase = { organizationId: code.organizationId, projectId: code.projectId, taskId: code.taskId, key: "app-web", port: 5173, leaseEpoch: 1, expiresAt: new Date(Date.now() + 60_000) };
    await expect(test.db.previewCode.create({ data: { ...codeBase, kind: "cli_ticket", codeHash: randomBytes(32).toString("hex"), linkId: rowId("PreviewLink") } })).rejects.toThrow(
      /preview_code_ticket_is_a_member_s/,
    );
    await expect(test.db.previewCode.create({ data: { ...codeBase, kind: "enter", codeHash: randomBytes(32).toString("hex") } })).rejects.toThrow(/preview_code_member_or_link/);
    await expect(test.db.previewCode.create({ data: { ...codeBase, kind: "enter", codeHash: code.codeHash, memberId: code.memberId } })).rejects.toThrow(/Unique constraint/);
    const taskId = rowId("Task");
    await expect(test.db.task.update({ where: { id: taskId }, data: { previewId: "NOT-BASE32-0000000000000000".slice(0, 26) } })).rejects.toThrow(/task_preview_id_base32/);
    const previewId = "abcdefghijklmnopqrstuvwx23";
    expect((await test.db.task.update({ where: { id: taskId }, data: { previewId } })).previewId).toBe(previewId);
    const otherTask = await test.db.task.create({
      data: { organizationId: view.organizationId, projectId: view.projectId, kind: "code", source: "prompt", title: "Another", prompt: "x", branchName: `ostra/${randomBytes(4).toString("hex")}-other` },
    });
    await expect(test.db.task.update({ where: { id: otherTask.id }, data: { previewId } })).rejects.toThrow(/Unique constraint/);
  });

  it("F-121, F-141: an attachment is once per task, a recording carries its length, and an app lease names who started it", async () => {
    const attachment = await test.db.taskAttachment.findUniqueOrThrow({ where: { id: rowId("TaskAttachment") } });
    const base = {
      organizationId: attachment.organizationId,
      projectId: attachment.projectId,
      taskId: attachment.taskId,
      blobId: attachment.blobId,
      source: "agent" as const,
      targetKind: "process" as const,
      targetName: "web",
      path: "/",
      width: 1440,
      height: 900,
      browserName: "Chromium",
      browserVersion: "131",
    };
    await expect(test.db.taskAttachment.create({ data: { ...base, attachmentId: attachment.attachmentId, kind: "screenshot" } })).rejects.toThrow(/Unique constraint/);
    await expect(test.db.taskAttachment.create({ data: { ...base, attachmentId: "att-rec", kind: "recording" } })).rejects.toThrow(/task_attachment_recording_has_length/);
    expect((await test.db.taskAttachment.create({ data: { ...base, attachmentId: "att-rec", kind: "recording", durationMs: 4100, frameCount: 41 } })).frameCount).toBe(41);
    await expect(test.db.taskAttachment.create({ data: { ...base, attachmentId: "att-port", kind: "screenshot", targetKind: "port", port: 4100 } })).rejects.toThrow(
      /task_attachment_name_unless_port/,
    );
    await expect(test.db.taskAttachment.create({ data: { ...base, attachmentId: "att-member", kind: "screenshot", source: "member" } })).rejects.toThrow(/task_attachment_member_for_member/);
    const lease = await test.db.lease.findUniqueOrThrow({ where: { id: rowId("Lease") } });
    expect(lease.purpose).toBe("turn");
    await expect(test.db.lease.update({ where: { id: lease.id }, data: { appStartedByMemberId: fixture.a.admin.id } })).rejects.toThrow(/lease_app_starter_only_for_app/);
    expect((await test.db.lease.update({ where: { id: lease.id }, data: { purpose: "app", appStartedByMemberId: fixture.a.admin.id } })).purpose).toBe("app");
  });

  it("F-145: an item's name is once per kind among the installed ones, a version's number once per item, and a source once with or without its namespace", async () => {
    const item = await test.db.libraryItem.findUniqueOrThrow({ where: { id: rowId("LibraryItem") } });
    const base = { organizationId: item.organizationId, kind: item.kind, name: item.name, sourceKind: item.sourceKind, source: {}, installedByMemberId: item.installedByMemberId };
    await expect(test.db.libraryItem.create({ data: base })).rejects.toThrow(/library_item_one_name|Unique constraint/);
    // An MCP server may share a skill's name, and a removed item frees its name.
    expect((await test.db.libraryItem.create({ data: { ...base, kind: "mcp_server", sourceKind: "registry" } })).kind).toBe("mcp_server");
    await test.db.libraryItem.update({ where: { id: item.id }, data: { removedAt: new Date(), removedByMemberId: item.installedByMemberId } });
    const again = await test.db.libraryItem.create({ data: base });
    expect(again.removedAt).toBeNull();
    const version = await test.db.libraryItemVersion.findUniqueOrThrow({ where: { id: rowId("LibraryItemVersion") } });
    await expect(test.db.libraryItemVersion.create({ data: { organizationId: version.organizationId, itemId: version.itemId, number: version.number, state: "available" } })).rejects.toThrow(/Unique constraint/);
    await expect(test.db.libraryItemVersion.create({ data: { organizationId: version.organizationId, itemId: version.itemId, number: 0, state: "available" } })).rejects.toThrow(
      /library_item_version_number_positive/,
    );
    // The current version is one of the item's, and the item keeps it.
    expect((await test.db.libraryItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } })).currentVersionId).toBe(version.id);
    const source = { organizationId: item.organizationId, kind: "registry" as const, value: "https://api.mcp.github.com" };
    await test.db.librarySource.create({ data: source });
    await expect(test.db.librarySource.create({ data: source })).rejects.toThrow(/library_source_one_without_namespace|Unique constraint/);
    await test.db.librarySource.create({ data: { ...source, namespace: "io.github.example" } });
    await expect(test.db.librarySource.create({ data: { ...source, namespace: "io.github.example" } })).rejects.toThrow(/Unique constraint/);
    const suggestion = await test.db.librarySuggestion.findUniqueOrThrow({ where: { id: rowId("LibrarySuggestion") } });
    expect(suggestion.state).toBe("open");
    await expect(test.db.librarySuggestion.update({ where: { id: suggestion.id }, data: { state: "dismissed" } })).rejects.toThrow(/library_suggestion_decided_unless_open/);
  });

  it("F-049: a project record can't point at another organization's or project's row", async () => {
    const task = await test.db.task.findUniqueOrThrow({ where: { id: rowId("Task") } });
    const other = await test.db.project.findUniqueOrThrow({ where: { id: fixture.a.restrictedProject.id } });
    // The task is in the open project: an attachment in the restricted one can't name it.
    await expect(
      test.db.$executeRaw`INSERT INTO "task_preview" (id, "organizationId", "projectId", "taskId", key, port, label, "updatedAt") VALUES (${`tp-${randomBytes(4).toString("hex")}`}, ${other.organizationId}, ${other.id}, ${task.id}, 'port-4200', 4200, 'Docs', now())`,
    ).rejects.toThrow(/foreign key/i);
    // A named person of another organization can't be listed.
    await expect(
      test.db.$executeRaw`INSERT INTO "preview_access_member" (id, "organizationId", "projectId", "previewAccessId", "memberId") VALUES (${`pam-${randomBytes(4).toString("hex")}`}, ${task.organizationId}, ${task.projectId}, ${rowId("PreviewAccess")}, ${fixture.b.admin.id})`,
    ).rejects.toThrow(/foreign key/i);
  });
});
