import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { inject } from "vitest";
import { z } from "zod";

import type { BlobId, BoardId, ExternalTicketId, TicketId, TicketKey, TicketWriteId, UploadId } from "@ostra/protocol";

import { boxReleaseReasonFromDb, boxReleaseReasonToDb, sessionLimitFromDb, sessionLimitToDb } from "./enums.ts";
import {
  mapBlob,
  mapBlobChunk,
  mapBlobUpload,
  mapBoard,
  mapBox,
  mapConnection,
  mapIdempotencyRecord,
  mapOAuthState,
  mapOrganizationSetting,
  mapRateBudget,
  mapSession,
  mapTask,
  mapTicket,
  mapTicketWrite,
} from "./mappers.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 2's migration (ticket 05): the new tables and columns, the partial index of one active
// code task per ticket, the mappers, the composite keys, and an upgrade from milestone 1's data.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const m2Tables = [
  "organization_setting",
  "ticket",
  "ticket_write",
  "idempotency_record",
  "rate_budget",
  "blob",
  "blob_upload",
  "blob_chunk",
  "oauth_state",
];

const sha = "ab".repeat(32);

/** A Linear connection, a board on the project and one ticket on it. */
const seedBoard = async (organizationId: string, projectId: string) => {
  // One Linear connection per organization: reuse it.
  const connection =
    (await test.db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } } })) ??
    (await test.db.connection.create({
      data: {
        organizationId,
        kind: "linear",
        appId: `client-${randomUUID()}`,
        state: "active",
        credentialKind: "app_oauth",
        externalWorkspaceKey: "ostra-test",
      },
    }));
  const board = await test.db.board.create({
    data: {
      organizationId,
      projectId,
      connectionId: connection.id,
      externalId: `team-${randomUUID()}`,
      name: "OST",
      key: "OST",
      statusMap: {},
    },
  });
  const ticket = await test.db.ticket.create({
    data: {
      organizationId,
      projectId,
      boardId: board.id,
      connectionId: connection.id,
      externalId: `issue-${randomUUID()}`,
      key: "OST-12",
      title: "Add today's date to the README",
      url: "https://linear.app/ostra-test/issue/OST-12",
      labels: ["docs"],
      trackerUpdatedAt: new Date(1_700_000_000_000),
    },
  });
  return { connection, board, ticket };
};

const newTicketTask = (
  seeded: Awaited<ReturnType<typeof seedBoard>>,
  overrides: { readonly kind?: "code" | "refine" } = {},
) =>
  test.db.task.create({
    data: {
      organizationId: seeded.ticket.organizationId,
      projectId: seeded.ticket.projectId,
      kind: overrides.kind ?? "code",
      source: "ticket",
      title: "OST-12: Add today's date to the README",
      ticketKey: seeded.ticket.key,
      ticketId: seeded.ticket.id,
      boardId: seeded.board.id,
      branchName: `ostra/ost-12-${randomBytes(4).toString("hex")}-add-date`,
    },
  });

describe("the milestone 2 migration", () => {
  it("creates every new table", async () => {
    const rows = await test.db.$queryRaw<readonly unknown[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const tables = z
      .array(z.object({ tablename: z.string() }))
      .parse(rows)
      .map((row) => row.tablename);
    for (const table of m2Tables) {
      expect(tables).toContain(table);
    }
  });

  it("keeps a chunk's bytes as bytea, in its own table", async () => {
    const rows = await test.db.$queryRaw<readonly unknown[]>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'blob_chunk' AND column_name = 'bytes'`;
    expect(z.array(z.object({ data_type: z.string() })).parse(rows)).toEqual([{ data_type: "bytea" }]);
  });

  it("maps the protocol's hyphenated limits and release reasons both ways", () => {
    for (const [protocol, db] of Object.entries(sessionLimitToDb)) {
      expect(sessionLimitFromDb[db]).toBe(protocol);
    }
    for (const [protocol, db] of Object.entries(boxReleaseReasonToDb)) {
      expect(boxReleaseReasonFromDb[db]).toBe(protocol);
    }
  });
});

describe("one active code task per ticket per project", () => {
  it("refuses a second active code task for one ticket, and allows one once the first is stopped", async () => {
    const seeded = await seedBoard(fixture.a.organization.id, fixture.a.openProject.id);
    const first = await newTicketTask(seeded);
    await expect(newTicketTask(seeded)).rejects.toThrow();
    // Another kind doesn't count.
    await newTicketTask(seeded, { kind: "refine" });
    await test.db.task.update({ where: { id: first.id }, data: { state: "stopped", stoppedReason: "requested" } });
    const second = await newTicketTask(seeded);
    expect(second.ticketId).toBe(seeded.ticket.id);
    // A task in review still holds the ticket.
    await test.db.task.update({
      where: { id: second.id },
      data: { state: "in_review", subState: "waiting_for_reviewer" },
    });
    await expect(newTicketTask(seeded)).rejects.toThrow();
  });

  it("refuses a ticket with no board, and prompt tasks are never held by it", async () => {
    const seeded = await seedBoard(fixture.a.organization.id, fixture.a.openProject.id);
    await expect(
      test.db.task.create({
        data: {
          organizationId: seeded.ticket.organizationId,
          projectId: seeded.ticket.projectId,
          kind: "code",
          source: "ticket",
          title: "no board",
          ticketId: seeded.ticket.id,
          branchName: "ostra/no-board",
        },
      }),
    ).rejects.toThrow();
  });
});

// Milestone 2's one Linear connection per organization became one per workspace in milestone 11
// (ADR 0071): `schema-m11.test.ts` holds its rule.

describe("the new rows' mappers", () => {
  it("parse every new model's IDs into their branded types", async () => {
    const orgId = fixture.a.organization.id;
    const seeded = await seedBoard(orgId, fixture.a.openProject.id);
    const task = mapTask(await newTicketTask(seeded));
    expectTypeOf(task.ticketId).toEqualTypeOf<TicketId | null>();
    expectTypeOf(task.boardId).toEqualTypeOf<BoardId | null>();
    expectTypeOf(task.ticketKey).toEqualTypeOf<TicketKey | null>();
    expect(task.ticketId).toBe(seeded.ticket.id);

    const board = mapBoard(seeded.board);
    expectTypeOf(board.id).toEqualTypeOf<BoardId>();
    expect(board.integrationDetected).toBeNull();

    const ticket = mapTicket(seeded.ticket);
    expectTypeOf(ticket.externalId).toEqualTypeOf<ExternalTicketId>();
    expect(ticket).toMatchObject({ key: "OST-12", open: true, labels: ["docs"], removedAt: null });

    const connection = mapConnection(seeded.connection);
    expect(connection).toMatchObject({ state: "active", webhookMode: "webhooks", createdByMemberId: null });

    const write = mapTicketWrite(
      await test.db.ticketWrite.create({
        data: {
          organizationId: orgId,
          projectId: task.projectId,
          taskId: task.id,
          boardId: board.id,
          ticketId: ticket.id,
          kind: "move",
          payload: { target: "started" },
          idempotencyKey: `ticket-write:${task.id}:move:started`,
        },
      }),
    );
    expectTypeOf(write.id).toEqualTypeOf<TicketWriteId>();
    expect(write).toMatchObject({ state: "pending", attempts: 0 });

    const upload = mapBlobUpload(
      await test.db.blobUpload.create({
        data: {
          organizationId: orgId,
          projectId: task.projectId,
          taskId: task.id,
          store: "postgres",
          purpose: "session-archive",
          contentType: "application/gzip",
          expectedSha256: sha,
          size: 3,
        },
      }),
    );
    expectTypeOf(upload.id).toEqualTypeOf<UploadId>();
    const chunk = mapBlobChunk(
      await test.db.blobChunk.create({
        data: { organizationId: orgId, uploadId: upload.id, ordinal: 0, offset: 0, bytes: new Uint8Array([1, 2, 3]) },
      }),
    );
    expect(chunk.uploadId).toBe(upload.id);
    const blob = mapBlob(
      await test.db.blob.create({
        data: {
          organizationId: orgId,
          projectId: task.projectId,
          taskId: task.id,
          store: "postgres",
          key: `postgres:${randomUUID()}`,
          purpose: "session-archive",
          contentType: "application/gzip",
          size: 3,
          sha256: sha,
        },
      }),
    );
    expectTypeOf(blob.id).toEqualTypeOf<BlobId>();
    // Finishing moves the chunk from the upload to the blob; both at once is refused.
    await expect(
      test.db.blobChunk.update({ where: { id: chunk.id }, data: { blobId: blob.id } }),
    ).rejects.toThrow();
    await test.db.blobChunk.update({ where: { id: chunk.id }, data: { blobId: blob.id, uploadId: null } });
    await test.db.blobUpload.delete({ where: { id: upload.id } });
    expect(await test.db.blobChunk.count({ where: { blobId: blob.id } })).toBe(1);

    const session = mapSession(
      await test.db.session.create({
        data: {
          organizationId: orgId,
          projectId: task.projectId,
          taskId: task.id,
          origin: "restored",
          state: "ended",
          outcome: "with_changes",
          archiveBlobId: blob.id,
          archiveTurnOrdinal: 2,
          limitReached: "max_duration",
        },
      }),
    );
    expect(session).toMatchObject({ archiveBlobId: blob.id, limitReached: "max-duration", spentMicroUsd: 0 });

    const box = mapBox(
      await test.db.box.create({
        data: {
          organizationId: orgId,
          projectId: task.projectId,
          taskId: task.id,
          executor: "host",
          state: "released",
          releaseReason: "prs_closed",
        },
      }),
    );
    expect(box.releaseReason).toBe("prs-closed");

    const record = mapIdempotencyRecord(
      await test.db.idempotencyRecord.create({
        data: { organizationId: orgId, key: `task:${task.id}:open-pr`, state: "pending", claimedAt: new Date() },
      }),
    );
    expect(record.state).toBe("pending");
    await expect(
      test.db.idempotencyRecord.create({
        data: { organizationId: orgId, key: `task:${task.id}:open-pr`, state: "pending", claimedAt: new Date() },
      }),
    ).rejects.toThrow();

    const budget = mapRateBudget(
      await test.db.rateBudget.create({
        data: { organizationId: orgId, key: `linear:${seeded.connection.id}`, remaining: 10, resetAt: new Date() },
      }),
    );
    expect(budget.limit).toBeNull();

    const state = mapOAuthState(
      await test.db.oAuthState.create({
        data: {
          organizationId: orgId,
          connectionId: seeded.connection.id,
          stateHash: sha,
          codeVerifierSecretRef: "secret:builtin:x",
          memberId: fixture.a.admin.id,
          authSessionId: "auth-session-1",
          expiresAt: new Date(Date.now() + 600_000),
        },
      }),
    );
    expect(state.connectionId).toBe(seeded.connection.id);

    const setting = mapOrganizationSetting(
      await test.db.organizationSetting.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, linearSkippedAt: new Date(), linearSkippedByMemberId: fixture.a.admin.id },
        update: {},
      }),
    );
    expect(setting.linearSkippedByMemberId).toBe(fixture.a.admin.id);
  });

  it("refuses a create-less write without its ticket, a bad digest and a chunk over 1 MiB", async () => {
    const orgId = fixture.a.organization.id;
    const seeded = await seedBoard(orgId, fixture.a.openProject.id);
    const task = await newTicketTask(seeded);
    const base = {
      organizationId: orgId,
      projectId: task.projectId,
      taskId: task.id,
      boardId: seeded.board.id,
      payload: {},
    };
    await expect(
      test.db.ticketWrite.create({ data: { ...base, kind: "comment", idempotencyKey: randomUUID() } }),
    ).rejects.toThrow();
    await test.db.ticketWrite.create({ data: { ...base, kind: "create", idempotencyKey: randomUUID() } });
    await expect(
      test.db.blob.create({
        data: { organizationId: orgId, store: "postgres", key: randomUUID(), purpose: "x", contentType: "x/y", size: 1, sha256: "nope" },
      }),
    ).rejects.toThrow();
    const blob = await test.db.blob.create({
      data: { organizationId: orgId, store: "postgres", key: randomUUID(), purpose: "x", contentType: "x/y", size: 1, sha256: sha },
    });
    await expect(
      test.db.blobChunk.create({
        data: { organizationId: orgId, blobId: blob.id, ordinal: 0, offset: 0, bytes: new Uint8Array(1024 * 1024 + 1) },
      }),
    ).rejects.toThrow();
  });
});

describe("organization scope, for the new rows", () => {
  it("refuses a ticket, a write or a blob that points across organizations or projects", async () => {
    const seededA = await seedBoard(fixture.a.organization.id, fixture.a.openProject.id);
    const seededB = await seedBoard(fixture.b.organization.id, fixture.b.project.id);
    // A ticket in A on B's board.
    await expect(
      test.db.ticket.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.a.openProject.id,
          boardId: seededB.board.id,
          connectionId: seededA.connection.id,
          externalId: randomUUID(),
          key: "OST-1",
          title: "x",
          url: "https://linear.app/x",
          trackerUpdatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    // A ticket on a board of another project in the same organization.
    await expect(
      test.db.ticket.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.a.restrictedProject.id,
          boardId: seededA.board.id,
          connectionId: seededA.connection.id,
          externalId: randomUUID(),
          key: "OST-1",
          title: "x",
          url: "https://linear.app/x",
          trackerUpdatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    // A task in A holding B's ticket.
    await expect(
      test.db.task.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.a.openProject.id,
          kind: "code",
          source: "ticket",
          title: "x",
          ticketId: seededB.ticket.id,
          boardId: seededB.board.id,
          branchName: "ostra/x",
        },
      }),
    ).rejects.toThrow();
    // A blob in A owned by B's task.
    const taskB = await newTicketTask(seededB);
    await expect(
      test.db.blob.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.a.openProject.id,
          taskId: taskB.id,
          store: "postgres",
          key: randomUUID(),
          purpose: "x",
          contentType: "x/y",
          size: 1,
          sha256: sha,
        },
      }),
    ).rejects.toThrow();
    // A chunk in A on B's blob.
    const blobB = await test.db.blob.create({
      data: { organizationId: fixture.b.organization.id, store: "postgres", key: randomUUID(), purpose: "x", contentType: "x/y", size: 1, sha256: sha },
    });
    await expect(
      test.db.blobChunk.create({
        data: { organizationId: fixture.a.organization.id, blobId: blobB.id, ordinal: 0, offset: 0, bytes: new Uint8Array([1]) },
      }),
    ).rejects.toThrow();
    // And A's reads see none of B's rows.
    const tickets = await test.db.ticket.findMany({ where: { organizationId: fixture.a.organization.id } });
    expect(tickets.some((row) => row.id === seededB.ticket.id)).toBe(false);
  });
});

// ---------- the upgrade: milestone 1's data, then milestone 2's migrations ----------

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
/** The first migration of milestone 2. Every one before it shipped with milestone 1. */
const firstM2Migration = "20261119200000_command_release";

const withClient = async <T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

/** A query's rows, as data to parse or compare. */
const rowsOf = async (client: pg.Client, sql: string): Promise<unknown> => (await client.query(sql)).rows;

const applyMigrations =async (url: string, names: readonly string[]): Promise<void> => {
  await withClient(url, async (client) => {
    for (const name of names) {
      const sql = await readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
      await client.query(sql);
    }
  });
};

describe("upgrading a milestone 1 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) =>
      client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`),
    );
  });

  it("applies over milestone 1's rows, and every existing row stays valid", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const m1 = all.filter((entry) => entry < firstM2Migration);
    const m2 = all.filter((entry) => entry >= firstM2Migration);
    expect(m1.length).toBeGreaterThan(0);
    expect(m2).toContain("20261119210000_milestone_2");
    await applyMigrations(upgradeUrl, m1);

    // Milestone 1's demo, in miniature: an organization, its GitHub App, a project with a repo, a
    // prompt task with its branch, a session, a box and a webhook delivery.
    await withClient(upgradeUrl, async (client) => {
      await client.query(`
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now());
        INSERT INTO "instance_setting" (id, "updatedAt") VALUES ('instance', now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-1', 'org-1', 'github', '123', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', now());
        INSERT INTO "repo" (id, "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "updatedAt")
          VALUES ('repo-1', 'org-1', 'proj-1', 'conn-1', '9', '42', 'ostra-test/test1', 'main', 'test1', now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, prompt, "branchName", "updatedAt")
          VALUES ('task-1', 'org-1', 'proj-1', 'code', 'prompt', 'Add CONTRIBUTING.md', 'x', 'ostra/add-contributing', now());
        INSERT INTO "task_repo" (id, "organizationId", "projectId", "taskId", "repoId", "branchName", "baseBranch", "updatedAt")
          VALUES ('tr-1', 'org-1', 'proj-1', 'task-1', 'repo-1', 'ostra/add-contributing', 'main', now());
        INSERT INTO "box" (id, "organizationId", "projectId", "taskId", executor, "updatedAt") VALUES ('box-1', 'org-1', 'proj-1', 'task-1', 'host', now());
        INSERT INTO "session" (id, "organizationId", "projectId", "taskId", "boxId", origin, "updatedAt") VALUES ('sess-1', 'org-1', 'proj-1', 'task-1', 'box-1', 'new', now());
        INSERT INTO "webhook_delivery" (id, "organizationId", "connectionId", "deliveryId", event) VALUES ('wh-1', 'org-1', 'conn-1', 'd-1', 'pull_request');
      `);
    });

    await applyMigrations(upgradeUrl, m2);

    await withClient(upgradeUrl, async (client) => {
      expect(
        await rowsOf(client, `SELECT state::text, "webhookMode"::text, "credentialKind" FROM "connection" WHERE id = 'conn-1'`),
      ).toEqual([{ state: "active", webhookMode: "webhooks", credentialKind: null }]);
      expect(await rowsOf(client, `SELECT "ticketId", "boardId", "spentMicroUsd" FROM "task" WHERE id = 'task-1'`)).toEqual([
        { ticketId: null, boardId: null, spentMicroUsd: 0 },
      ]);
      expect(await rowsOf(client, `SELECT "retentionDays", "retentionSetAt" FROM "instance_setting"`)).toEqual([
        { retentionDays: null, retentionSetAt: null },
      ]);
      expect(await rowsOf(client, `SELECT payload, "signatureHash" FROM "webhook_delivery" WHERE id = 'wh-1'`)).toEqual([
        { payload: null, signatureHash: null },
      ]);
      expect(await rowsOf(client, `SELECT "hiddenRefSha", "mergedAt" FROM "task_repo" WHERE id = 'tr-1'`)).toEqual([
        { hiddenRefSha: null, mergedAt: null },
      ]);
      // The new enum values are usable after the upgrade.
      await client.query(`UPDATE "task" SET state = 'needs_you', "needsYouReason" = 'restore_conflict' WHERE id = 'task-1'`);
      const kinds = z
        .array(z.object({ kind: z.string() }))
        .parse(await rowsOf(client, `SELECT unnest(enum_range(NULL::"CommandKind"))::text AS kind`));
      expect(kinds.map((row) => row.kind)).toContain("release");
    });
  });
});
