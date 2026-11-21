import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runPrisma } from "./dev/prisma-cli.ts";
import { turnOriginFromDb, turnOriginToDb } from "./enums.ts";
import { buildIsolationRows } from "./testing/isolation-models.ts";
import type { IsolationModelName } from "./testing/isolation-models.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 9's migration (ticket 04, spec section 5.3, ADR 0070): files for the agent. It's
// additive, applies on an empty database and on one at the head before it with rows in every table
// it alters, seeds nothing, matches the schema, and keeps the rules Prisma can't declare: a blob's
// deletion leaves its file's row, an upload is a member's and no task's until sent, a sent file has
// its place, and a ticket's file is known by its URL's digest, never the URL.

const m9Migration = "20261202100000_milestone_9";
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
  const name = `ostra_upgrade_m9_${randomBytes(6).toString("hex")}`;
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

const newTables = ["message_file", "task_ticket_read"] as const;

const newEnums = {
  MessageFileOrigin: ["member", "ticket"],
  MessageFileState: ["uploaded", "sent", "expired", "left_out", "failed"],
  MessageFileKind: ["image", "document", "text", "file"],
  FileTextState: ["none", "ready", "failed", "off"],
  TicketReadReason: ["start", "reopen", "member", "retry"],
} as const;

const digest = (): string => randomBytes(32).toString("hex");

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

describe("the milestone 9 migration", () => {
  it("is additive: new enums, tables and nullable columns, one enum value, and no DROP, RENAME or changed column", async () => {
    const names = await migrationNames();
    expect(names).toContain(m9Migration);
    // After milestone 8's and every migration of its own since (the search vectors, the preview
    // notices last). Later ones may follow it.
    expect(names.indexOf(m9Migration)).toBeGreaterThan(names.indexOf("20261201120000_milestone_8"));
    expect(names.indexOf(m9Migration)).toBeGreaterThan(names.indexOf("20261201200000_preview_shared_notification"));
    const sql = (await migrationSql(m9Migration)).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN/i);
    // And it seeds nothing.
    expect(sql).not.toMatch(/\bINSERT INTO\b|\bUPDATE "|\bDELETE FROM\b/i);
    for (const table of newTables) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    for (const [name, values] of Object.entries(newEnums)) {
      expect(sql).toContain(`CREATE TYPE "${name}" AS ENUM (${values.map((value) => `'${value}'`).join(", ")})`);
    }
    expect(sql).toContain(`ALTER TYPE "HeldTurnOrigin" ADD VALUE 'ticket_update'`);
    expect(sql).toMatch(/ALTER TABLE "model" ADD COLUMN\s+"adminImageInput" BOOLEAN,\s*ADD COLUMN\s+"catalogInputModalities" JSONB;/);
    // A ticket update's turn origin, both ways.
    expect(turnOriginToDb["ticket-update"]).toBe("ticket_update");
    expect(turnOriginFromDb.ticket_update).toBe("ticket-update");
  });

  it("applies on an empty database, and the schema then has nothing of milestone 9 left to migrate", async () => {
    const url = await emptyDatabase();
    await apply(url, await migrationNames());
    const tables = await withClient(url, (client) =>
      client.query<Row>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name", [[...newTables]]),
    );
    expect(tables.rows.map((row) => row["table_name"])).toEqual([...newTables].sort());
    // `prisma migrate diff` from the migrated database to the schema holds nothing of milestone 9.
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

  it("applies on a database at the head before it, over rows in every table it alters, and backfills nothing", async () => {
    const names = await migrationNames();
    const url = await emptyDatabase();
    await apply(url, names.filter((name) => name < m9Migration));
    // The head before milestone 9, with a model and a held turn (the tables it alters) and their parents.
    await withClient(url, (client) =>
      client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "model_provider" (id, "organizationId", name, "baseUrl", "apiFormat", "authScheme", "tokenSecretRef", "updatedAt")
          VALUES ('prov-1', 'org-1', 'Anthropic', 'https://api.anthropic.com', 'anthropic_messages', 'x_api_key', 'secret-ref-1', now());
        INSERT INTO "model" (id, "organizationId", "providerId", "endpointModelId", "catalogReasoning", "updatedAt")
          VALUES ('model-1', 'org-1', 'prov-1', 'claude-sonnet-5', '{"kind":"none"}', now());
      `),
    );
    await apply(url, names.filter((name) => name >= m9Migration));
    await withClient(url, async (client) => {
      expect(await rowsOf(client, `SELECT "catalogInputModalities", "adminImageInput", "endpointModelId" FROM "model"`)).toEqual([
        { catalogInputModalities: null, adminImageInput: null, endpointModelId: "claude-sonnet-5" },
      ]);
      // Nothing seeded: the catalog's next sync fills a model's inputs.
      for (const table of newTables) {
        expect(await rowsOf(client, `SELECT count(*)::int AS n FROM ${client.escapeIdentifier(table)}`), table).toEqual([{ n: 0 }]);
      }
      // The columns that are never logged say so.
      const comments = await rowsOf(
        client,
        `SELECT a.attname AS column, d.description FROM pg_description d JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid WHERE d.objoid = '"message_file"'::regclass ORDER BY a.attname`,
      );
      expect(comments.map((row) => row["column"])).toEqual(["boxPath", "name", "textBlobId", "ticketSourceKey"]);
      expect(comments.find((row) => row["column"] === "name")).toEqual({ column: "name", description: "ostra: a file's safe name, the member's or the ticket's. Never logged." });
    });
  }, 120_000);
});

describe("the milestone 9 rules the database keeps", () => {
  const fileRow = async () => test.db.messageFile.findUniqueOrThrow({ where: { id: rowId("MessageFile") } });

  it("F-148: an upload is a member's and no task's, a sent file has its place, and two never share one", async () => {
    const sent = await fileRow();
    const base = { organizationId: sent.organizationId, projectId: sent.projectId, name: "mock.png", kind: "image" as const, contentType: "image/png", size: 10 };
    // An upload names its member, and no task, event or place.
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member" } })).rejects.toThrow(/message_file_member_has_uploader/);
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, taskId: sent.taskId } })).rejects.toThrow(/message_file_upload_unsent/);
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, boxPath: "attachments/1/mock.png" } })).rejects.toThrow(/message_file_upload_unsent/);
    // A sent file has its task, event, position, place and time.
    const placed = { taskId: sent.taskId, sessionId: sent.sessionId, eventSeq: 2, position: 0, boxPath: "attachments/2/mock.png", sentAt: new Date() };
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, state: "sent", ...placed, boxPath: null } })).rejects.toThrow(/message_file_sent_placed/);
    await test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, state: "sent", ...placed } });
    // Two files never share a place in a task.
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, state: "sent", ...placed, position: 1 } })).rejects.toThrow(/Unique constraint|message_file_one_per_place/);
    // Counts and digests are checked.
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, size: -1 } })).rejects.toThrow(/message_file_counts/);
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, sha256: "not-a-digest" } })).rejects.toThrow(/message_file_digests/);
    await expect(test.db.messageFile.create({ data: { ...base, origin: "member", memberId: sent.memberId, textState: "failed" } })).rejects.toThrow(/message_file_failed_text_has_reason/);
  });

  it("F-149: a ticket's file has no member, is a task's, names where it was and its URL's digest, and a left-out or failed one its reason", async () => {
    const sent = await fileRow();
    // A ticket's file whose download failed: a task's, no member's, no blob, where it was and its URL's digest.
    const ticket = {
      organizationId: sent.organizationId,
      projectId: sent.projectId,
      origin: "ticket" as const,
      taskId: sent.taskId,
      state: "failed" as const,
      reason: "download-failed",
      name: "spec.pdf",
      kind: "document" as const,
      contentType: "application/pdf",
      size: 10,
      ticketWhere: "attachment",
      ticketSourceKey: digest(),
    };
    const failed = await test.db.messageFile.create({ data: ticket });
    expect(failed).toMatchObject({ memberId: null, blobId: null, sha256: null, state: "failed" });
    // A Retry is a new row that names the one it fetched again.
    const retry = await test.db.messageFile.create({ data: { ...ticket, state: "left_out", reason: "too-big", ticketWhere: "comment", ticketCommentId: "comment-1", retryOfId: failed.id } });
    expect(retry.retryOfId).toBe(failed.id);
    await expect(test.db.messageFile.create({ data: { ...ticket, memberId: sent.memberId } })).rejects.toThrow(/message_file_member_has_uploader/);
    await expect(test.db.messageFile.create({ data: { ...ticket, taskId: null } })).rejects.toThrow(/message_file_ticket_has_task/);
    await expect(test.db.messageFile.create({ data: { ...ticket, reason: null } })).rejects.toThrow(/message_file_out_has_reason/);
    await expect(test.db.messageFile.create({ data: { ...ticket, ticketWhere: "title" } })).rejects.toThrow(/message_file_ticket_where/);
    // The URL itself is never a source key: only its SHA-256.
    await expect(test.db.messageFile.create({ data: { ...ticket, ticketSourceKey: "https://uploads.linear.app/abc/spec.pdf" } })).rejects.toThrow(/message_file_digests/);
    // A member's upload says nothing of a ticket.
    await expect(
      test.db.messageFile.create({ data: { ...ticket, origin: "member", memberId: sent.memberId, taskId: null, state: "uploaded", reason: null, ticketSourceKey: null, ticketWhere: "comment" } }),
    ).rejects.toThrow(/message_file_ticket_where/);
  });

  it("F-149: a read is once per round of a task, from 1, with a digest and two lists", async () => {
    const read = await test.db.taskTicketRead.findFirstOrThrow({ where: { organizationId: fixture.a.organization.id } });
    const base = { organizationId: read.organizationId, projectId: read.projectId, taskId: read.taskId, reason: "reopen" as const, descriptionSha256: digest() };
    await expect(test.db.taskTicketRead.create({ data: { ...base, round: read.round } })).rejects.toThrow(/Unique constraint/);
    await expect(test.db.taskTicketRead.create({ data: { ...base, round: 0 } })).rejects.toThrow(/task_ticket_read_round_positive/);
    await expect(test.db.taskTicketRead.create({ data: { ...base, round: 2, descriptionSha256: "the description itself" } })).rejects.toThrow(/task_ticket_read_digest/);
    await expect(test.db.taskTicketRead.create({ data: { ...base, round: 2, comments: { id: "c1" } } })).rejects.toThrow(/task_ticket_read_arrays/);
    const next = await test.db.taskTicketRead.create({ data: { ...base, round: read.round + 1, comments: [{ id: "c1", updatedAt: 1 }], fileKeys: [digest()], eventSeq: 4 } });
    expect(next).toMatchObject({ round: read.round + 1, reason: "reopen", eventSeq: 4 });
  });

  it("F-148/c5: a model's catalog inputs are a JSON array, and an admin's word is a boolean or nothing", async () => {
    const model = await test.db.model.findUniqueOrThrow({ where: { id: rowId("Model") } });
    expect(model).toMatchObject({ catalogInputModalities: null, adminImageInput: null });
    const updated = await test.db.model.update({ where: { id: model.id }, data: { catalogInputModalities: ["text", "image"], adminImageInput: false } });
    expect(updated).toMatchObject({ catalogInputModalities: ["text", "image"], adminImageInput: false });
    await expect(test.db.model.update({ where: { id: model.id }, data: { catalogInputModalities: { image: true } } })).rejects.toThrow(/model_catalog_input_modalities_array/);
  });

  it("F-148/c3: a blob's deletion keeps the file and its organization, its blob unset; a task's deletion takes its files, their blobs and its reads", async () => {
    const sent = await fileRow();
    const { organizationId, projectId } = sent;
    const base = { organizationId, projectId, memberId: sent.memberId, origin: "member" as const, name: "mock.png", kind: "image" as const, contentType: "image/png", size: 10 };
    const blobOf = (purpose: string, taskId: string | null = null) =>
      test.db.blob.create({ data: { organizationId, projectId, taskId, store: "postgres", key: `m9-${digest()}`, purpose, contentType: "image/png", size: 10, sha256: digest() } });
    // An upload with a blob and a text of its own, deleted: the row stays, with its organization, its blobs unset.
    const [blob, text] = [await blobOf("message-file"), await blobOf("message-file-text")];
    const upload = await test.db.messageFile.create({ data: { ...base, sha256: digest(), blobId: blob.id, textBlobId: text.id, textState: "ready" } });
    await test.db.blob.delete({ where: { id: blob.id } });
    await test.db.blob.delete({ where: { id: text.id } });
    expect(await test.db.messageFile.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({ organizationId, blobId: null, textBlobId: null, state: "uploaded" });
    // A file can't point at another organization's blob.
    const otherBlob = await test.db.blob.create({ data: { organizationId: fixture.b.organization.id, projectId: fixture.b.project.id, store: "postgres", key: `m9-${digest()}`, purpose: "message-file", contentType: "image/png", size: 10, sha256: digest() } });
    await expect(test.db.messageFile.create({ data: { ...base, blobId: otherBlob.id } })).rejects.toThrow(/Foreign key constraint|violates foreign key/);
    // A task of its own, with a sent file whose blob and text are the task's, and a read of its ticket.
    const task = await test.db.task.create({ data: { organizationId, projectId, kind: "code", source: "prompt", title: "Match the mock", prompt: "x", branchName: `ostra/m9-${digest().slice(0, 8)}`, state: "running" } });
    const [taskBlob, taskText] = [await blobOf("message-file", task.id), await blobOf("message-file-text", task.id)];
    const file = await test.db.messageFile.create({
      data: { ...base, taskId: task.id, state: "sent", eventSeq: 1, position: 0, boxPath: "attachments/1/mock.png", sentAt: new Date(), sha256: digest(), blobId: taskBlob.id, textBlobId: taskText.id, textState: "ready" },
    });
    await test.db.taskTicketRead.create({ data: { organizationId, projectId, taskId: task.id, round: 1, reason: "start", descriptionSha256: digest() } });
    // Its deletion (retention, F-079) takes the file, the blobs and the read together, whichever goes first.
    await test.db.task.delete({ where: { id: task.id } });
    expect(await test.db.messageFile.count({ where: { id: file.id } })).toBe(0);
    expect(await test.db.blob.count({ where: { id: { in: [taskBlob.id, taskText.id] } } })).toBe(0);
    expect(await test.db.taskTicketRead.count({ where: { taskId: task.id } })).toBe(0);
    // The unsent upload, no task's, stays the member's until the sweep.
    expect(await test.db.messageFile.count({ where: { id: upload.id } })).toBe(1);
  });
});
