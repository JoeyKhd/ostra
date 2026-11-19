import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { boxWaitingReasonSchema } from "@ostra/protocol";

import { boxWaitingReasonFromDb, boxWaitingReasonToDb } from "./enums.ts";
import { mapBox, mapBoxSize, mapRegistry } from "./mappers.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";
import "./testing/provided-context.ts";

// Milestone 5's migration (ticket 04, spec section 5.3): the box sizes and the registry, their
// keys per organization, the runner's and the snapshot's composite keys, the queue's index, the
// checks, and an upgrade from milestone 4's head with rows in every table it alters and the
// backfill of queued tasks, project pools and box sizes.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const m5Migration = "20261124000000_milestone_5";
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
const migrationSql = (name: string): Promise<string> => readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

type Side = "a" | "b";

/** A pool with a join token and a runner, a registry, an environment and a task, in one organization. */
const seedFleet = async (side: Side) => {
  const organizationId = side === "a" ? fixture.a.organization.id : fixture.b.organization.id;
  const projectId = side === "a" ? fixture.a.openProject.id : fixture.b.project.id;
  const pool = await test.db.runnerPool.create({ data: { organizationId, name: `pool-${randomUUID()}` } });
  const token = await test.db.joinToken.create({ data: { organizationId, poolId: pool.id, tokenHash: randomBytes(32).toString("hex") } });
  const runner = await test.db.runner.create({
    data: { organizationId, kind: "pool", poolId: pool.id, name: `build-${randomUUID()}`, publicKey: randomUUID(), executor: "docker", capacity: 4, version: "0.5.0", joinTokenId: token.id },
  });
  const registry = await test.db.registry.create({
    data: { organizationId, url: "registry.ostra-test.dev", repositoryPrefix: `org-${side}`, auth: "basic", pushSecretId: "secret-push", pullSecretId: "secret-pull" },
  });
  const environment = await test.db.environment.create({ data: { organizationId, projectId } });
  const task = await test.db.task.create({
    data: { organizationId, projectId, kind: "code", source: "prompt", title: "Add CONTRIBUTING.md", prompt: "x", branchName: `ostra/m5-${randomBytes(4).toString("hex")}` },
  });
  return { organizationId, projectId, pool, token, runner, registry, environment, task };
};

type Seeded = Awaited<ReturnType<typeof seedFleet>>;

let a: Seeded;
let b: Seeded;

beforeAll(async () => {
  a = await seedFleet("a");
  b = await seedFleet("b");
});

describe("the milestone 5 migration", () => {
  it("creates the box size and registry tables, and renames or drops nothing", async () => {
    const tables = z
      .array(z.object({ table_name: z.string() }))
      .parse(await test.db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = new Set(tables.map((row) => row.table_name));
    expect(names).toContain("box_size");
    expect(names).toContain("registry");
    // Additive only (AGENTS.md): no DROP, no RENAME, no column changed.
    const sql = await migrationSql(m5Migration);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|CONSTRAINT)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  it("gives every new column on an existing table its default", async () => {
    expect(a.task).toMatchObject({ queuePriority: 3, queuedAt: null, requiredLabels: [], cancelledByMemberId: null });
    expect(a.token).toMatchObject({ useCount: 0, revokedByMemberId: null });
    expect(a.pool).toMatchObject({ joinTokenDays: null, updatedByMemberId: null });
    expect(a.runner).toMatchObject({ install: null, minor: null, slots: null, cpuMillis: null, memoryMiB: null, capabilities: null, drainedAt: null, lastOfferedAt: null });
    const profile = await test.db.agentProfile.create({ data: { organizationId: a.organizationId, name: `p-${randomUUID()}`, adapter: "opencode" } });
    expect(profile.runnerLabels).toEqual([]);
    const link = await test.db.projectPool.create({ data: { organizationId: a.organizationId, projectId: a.projectId, poolId: a.pool.id } });
    expect(link.position).toBe(0);
    const box = await test.db.box.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, executor: "docker" } });
    expect(mapBox(box)).toMatchObject({ size: null, cpuMillis: null, imageRef: null, waitingReason: null, waitingSince: null, scheduledAt: null });
  });

  it("F-049: refuses a runner's join token and a snapshot's registry from another organization", async () => {
    const attempts: readonly (() => Promise<unknown>)[] = [
      // A runner in A that joined with B's token.
      () =>
        test.db.runner.create({
          data: { organizationId: a.organizationId, kind: "pool", poolId: a.pool.id, name: "x", publicKey: randomUUID(), executor: "docker", capacity: 1, version: "0.5.0", joinTokenId: b.token.id },
        }),
      // A snapshot in A pushed to B's registry.
      () =>
        test.db.snapshot.create({
          data: { organizationId: a.organizationId, projectId: a.projectId, environmentId: a.environment.id, reason: "nightly", registryId: b.registry.id, builder: "buildkit" },
        }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "P2003" });
    }
    // The same rows inside A are stored: the refusals above were the other organization's.
    await test.db.runner.create({
      data: { organizationId: a.organizationId, kind: "pool", poolId: a.pool.id, name: "y", publicKey: randomUUID(), executor: "docker", capacity: 1, version: "0.5.0", joinTokenId: a.token.id },
    });
    const snapshot = await test.db.snapshot.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, environmentId: a.environment.id, reason: "nightly", registryId: a.registry.id, builder: "buildkit" },
    });
    expect(snapshot).toMatchObject({ registryId: a.registry.id, builder: "buildkit", pushedAt: null });
  });

  it("F-095: keeps one box size of a name, and one registry, per organization", async () => {
    const small = await test.db.boxSize.create({ data: { organizationId: a.organizationId, name: "small", cpuMillis: 2000, memoryMiB: 4096 } });
    expect(mapBoxSize(small)).toMatchObject({ name: "small", cpuMillis: 2000, memoryMiB: 4096, updatedByMemberId: null });
    await expect(test.db.boxSize.create({ data: { organizationId: a.organizationId, name: "small", cpuMillis: 1000, memoryMiB: 1024 } })).rejects.toMatchObject({ code: "P2002" });
    // Another organization has its own `small`.
    await test.db.boxSize.create({ data: { organizationId: b.organizationId, name: "small", cpuMillis: 1000, memoryMiB: 1024 } });
    await expect(
      test.db.registry.create({ data: { organizationId: a.organizationId, url: "other.example.com", repositoryPrefix: "x", auth: "node" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(mapRegistry(a.registry)).toMatchObject({ organizationId: a.organizationId, auth: "basic", pushSecretId: "secret-push" });
  });

  it("refuses a value its checks rule out", async () => {
    const refusals: readonly (() => Promise<unknown>)[] = [
      // A size by another name, and one without limits.
      () => test.db.boxSize.create({ data: { organizationId: a.organizationId, name: "huge", cpuMillis: 1000, memoryMiB: 1024 } }),
      () => test.db.boxSize.create({ data: { organizationId: a.organizationId, name: "medium", cpuMillis: 0, memoryMiB: 1024 } }),
      // A project's default size by another name, and a box's.
      () => test.db.project.update({ where: { id: a.projectId }, data: { defaultBoxSize: "huge" } }),
      () => test.db.box.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, executor: "docker", size: "huge" } }),
      // A box waiting with no time, and a time with no reason.
      () => test.db.box.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, executor: "kubernetes", waitingReason: "node" } }),
      () => test.db.box.create({ data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, executor: "kubernetes", waitingSince: new Date() } }),
      // A priority off the scale.
      () => test.db.task.update({ where: { id: a.task.id }, data: { queuePriority: 5 } }),
      () => test.db.task.update({ where: { id: a.task.id }, data: { queuePriority: 0 } }),
      // A negative count, lifetime, position or offer.
      () => test.db.joinToken.update({ where: { id: a.token.id }, data: { useCount: -1 } }),
      () => test.db.runnerPool.update({ where: { id: a.pool.id }, data: { joinTokenDays: -1 } }),
      () => test.db.runner.update({ where: { id: a.runner.id }, data: { slots: -1 } }),
    ];
    for (const refusal of refusals) {
      await expect(refusal()).rejects.toThrow();
    }
    await test.db.project.update({ where: { id: a.projectId }, data: { defaultBoxSize: "medium" } });
    await test.db.task.update({ where: { id: a.task.id }, data: { queuePriority: 1 } });
  });

  it("F-067: reads a pool's queue through the queue's index", async () => {
    const plans = await test.db.$transaction(async (tx) => {
      // On a test's handful of rows a sequential scan is cheaper, so the planner is told not to.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return z.array(z.object({ "QUERY PLAN": z.string() })).parse(
        await tx.$queryRaw`EXPLAIN SELECT "id" FROM "task" WHERE "organizationId" = ${a.organizationId} AND "state" = 'queued' ORDER BY "queuePriority", "queuedAt", "id" LIMIT 50`,
      );
    });
    expect(plans.map((row) => row["QUERY PLAN"]).join("\n")).toContain("task_organizationId_state_queuePriority_queuedAt_idx");
  });

  it("F-067: counts a runner's and a project's boxes through their indexes", async () => {
    const plan = async (sql: "runner" | "project"): Promise<string> =>
      test.db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        const rows =
          sql === "runner"
            ? await tx.$queryRaw`EXPLAIN SELECT count(*) FROM "box" WHERE "runnerId" = ${a.runner.id} AND "state" IN ('creating', 'preparing', 'ready', 'idle')`
            : await tx.$queryRaw`EXPLAIN SELECT count(*) FROM "box" WHERE "projectId" = ${a.projectId} AND "state" IN ('creating', 'preparing', 'ready', 'idle')`;
        return z
          .array(z.object({ "QUERY PLAN": z.string() }))
          .parse(rows)
          .map((row) => row["QUERY PLAN"])
          .join("\n");
      });
    expect(await plan("runner")).toContain("box_runnerId_state_idx");
    expect(await plan("project")).toContain("box_projectId_state_idx");
  });

  it("F-093: maps a box's waiting reason both ways", async () => {
    for (const reason of boxWaitingReasonSchema.options) {
      expect(boxWaitingReasonFromDb[boxWaitingReasonToDb[reason]]).toBe(reason);
    }
    const box = await test.db.box.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, executor: "kubernetes", waitingReason: boxWaitingReasonToDb["image-pull"], waitingSince: new Date() },
    });
    expect(mapBox(box).waitingReason).toBe("image-pull");
  });

  it("takes the milestone 5 enum values", async () => {
    for (const kind of ["runner_joined", "runner_awaiting_approval"] as const) {
      const row = await test.db.notification.create({ data: { organizationId: a.organizationId, memberId: fixture.a.admin.id, kind } });
      expect(row.kind).toBe(kind);
    }
    const stopped = await test.db.task.update({ where: { id: a.task.id }, data: { state: "stopped", stoppedReason: "cancelled", cancelledByMemberId: fixture.a.admin.id } });
    expect(stopped.stoppedReason).toBe("cancelled");
    const item = await test.db.needsYouItem.create({
      data: { organizationId: a.organizationId, projectId: a.projectId, taskId: a.task.id, reason: "runner_awaiting_approval", audience: "organization_admins" },
    });
    expect(item.reason).toBe("runner_awaiting_approval");
    const runner = await test.db.runner.update({ where: { id: a.runner.id }, data: { install: "image", minor: 4 } });
    expect(runner).toMatchObject({ install: "image", minor: 4 });
  });
});

// ---------- the upgrade: milestone 4's head with rows, then milestone 5's migration ----------

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

describe("upgrading a milestone 4 database", () => {
  const serverUrl = inject("ostraDbServerUrl");
  const name = `ostra_upgrade_m5_${randomBytes(6).toString("hex")}`;
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const upgradeUrl = url.toString();

  afterAll(async () => {
    await withClient(serverUrl, (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  });

  it("F-067: applies over rows in every table it alters, and backfills the queue, the pools' order and the box sizes", async () => {
    await withClient(serverUrl, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
    const all = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(m5Migration);
    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry < m5Migration)) {
        await client.query(await migrationSql(migration));
      }
    });

    // Milestone 4's head, with rows in every table milestone 5 alters (runner_pool, join_token,
    // runner, agent_profile, project, project_pool, snapshot, task, box) and their parents: two
    // organizations, queued tasks from an Urgent ticket, a ticket without a priority, a ticket at
    // 0 (none) and a prompt, and a running task from an Urgent ticket.
    await withClient(upgradeUrl, async (client) => {
      await client.query(`
        INSERT INTO "user" (id, name, email, username, "updatedAt") VALUES ('user-1', 'Admin', 'admin@example.com', 'admin', now());
        INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('org-1', 'Demo', 'demo', now()), ('org-2', 'Other', 'other', now());
        INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('mem-1', 'org-1', 'user-1', 'admin', now());
        INSERT INTO "runner_pool" (id, "organizationId", name, "isDefault", "createdAt", "updatedAt")
          VALUES ('pool-late', 'org-1', 'build-fleet', false, now(), now()),
                 ('pool-default', 'org-1', 'default', true, now() - interval '1 day', now());
        INSERT INTO "join_token" (id, "organizationId", "poolId", "tokenHash") VALUES ('tok-1', 'org-1', 'pool-default', 'hash-1');
        INSERT INTO "runner" (id, "organizationId", kind, "poolId", name, "publicKey", executor, capacity, labels, version, state, "updatedAt")
          VALUES ('run-1', 'org-1', 'pool', 'pool-default', 'build-01', 'key-1', 'docker', 4, ARRAY['gpu'], '0.4.0', 'online', now());
        INSERT INTO "agent_profile" (id, "organizationId", name, adapter, "builtIn", "updatedAt") VALUES ('prof-1', 'org-1', 'OpenCode', 'opencode', true, now());
        INSERT INTO "connection" (id, "organizationId", kind, "appId", "updatedAt") VALUES ('conn-li', 'org-1', 'linear', 'lin', now());
        INSERT INTO "project" (id, "organizationId", name, slug, "defaultBoxSize", "updatedAt") VALUES ('proj-1', 'org-1', 'Demo', 'demo', 'medium', now());
        INSERT INTO "project_pool" ("organizationId", "projectId", "poolId", "maxBoxes") VALUES ('org-1', 'proj-1', 'pool-late', 2), ('org-1', 'proj-1', 'pool-default', NULL);
        INSERT INTO "environment" (id, "organizationId", "projectId", "updatedAt") VALUES ('env-1', 'org-1', 'proj-1', now());
        INSERT INTO "snapshot" (id, "organizationId", "projectId", "environmentId", reason, "runnerId", "updatedAt") VALUES ('snap-1', 'org-1', 'proj-1', 'env-1', 'nightly', 'run-1', now());
        INSERT INTO "board" (id, "organizationId", "projectId", "connectionId", "externalId", name, "statusMap", "updatedAt") VALUES ('board-1', 'org-1', 'proj-1', 'conn-li', 'team-1', 'OST', '{}', now());
        INSERT INTO "ticket" (id, "organizationId", "projectId", "boardId", "connectionId", "externalId", key, title, url, priority, "trackerUpdatedAt", "updatedAt")
          VALUES ('tk-urgent', 'org-1', 'proj-1', 'board-1', 'conn-li', 'e1', 'OST-1', 'Urgent', 'https://linear.app/x/1', 1, now(), now()),
                 ('tk-none', 'org-1', 'proj-1', 'board-1', 'conn-li', 'e2', 'OST-2', 'No priority', 'https://linear.app/x/2', NULL, now(), now()),
                 ('tk-zero', 'org-1', 'proj-1', 'board-1', 'conn-li', 'e3', 'OST-3', 'Zero', 'https://linear.app/x/3', 0, now(), now()),
                 ('tk-low', 'org-1', 'proj-1', 'board-1', 'conn-li', 'e4', 'OST-4', 'Low, running', 'https://linear.app/x/4', 4, now(), now());
        INSERT INTO "task" (id, "organizationId", "projectId", kind, source, title, "branchName", state, prompt, "ticketKey", "ticketId", "boardId", "createdAt", "updatedAt")
          VALUES ('task-urgent', 'org-1', 'proj-1', 'code', 'ticket', 'Urgent', 'ostra/ost-1', 'queued', NULL, 'OST-1', 'tk-urgent', 'board-1', '2026-11-20T10:00:00Z', now()),
                 ('task-none', 'org-1', 'proj-1', 'code', 'ticket', 'No priority', 'ostra/ost-2', 'queued', NULL, 'OST-2', 'tk-none', 'board-1', '2026-11-20T10:01:00Z', now()),
                 ('task-zero', 'org-1', 'proj-1', 'code', 'ticket', 'Zero', 'ostra/ost-3', 'queued', NULL, 'OST-3', 'tk-zero', 'board-1', '2026-11-20T10:02:00Z', now()),
                 ('task-prompt', 'org-1', 'proj-1', 'code', 'prompt', 'A prompt', 'ostra/a-prompt', 'queued', 'Add a CONTRIBUTING.md', NULL, NULL, NULL, '2026-11-20T10:03:00Z', now()),
                 ('task-running', 'org-1', 'proj-1', 'code', 'ticket', 'Low, running', 'ostra/ost-4', 'running', NULL, 'OST-4', 'tk-low', 'board-1', '2026-11-20T10:04:00Z', now());
        INSERT INTO "box" (id, "organizationId", "projectId", "taskId", "runnerId", executor, state, "updatedAt") VALUES ('box-1', 'org-1', 'proj-1', 'task-running', 'run-1', 'docker', 'ready', now());
      `);
    });

    await withClient(upgradeUrl, async (client) => {
      for (const migration of all.filter((entry) => entry >= m5Migration)) {
        await client.query(await migrationSql(migration));
      }
    });

    await withClient(upgradeUrl, async (client) => {
      // Queued tasks: queued at their creation, ranked by their ticket's priority, Medium without one.
      expect(
        await rowsOf(client, `SELECT id, "queuePriority", "queuedAt" = "createdAt" AS "queuedAtCreation" FROM "task" WHERE state = 'queued' ORDER BY "queuePriority", "queuedAt", id`),
      ).toEqual([
        { id: "task-urgent", queuePriority: 1, queuedAtCreation: true },
        { id: "task-none", queuePriority: 3, queuedAtCreation: true },
        { id: "task-zero", queuePriority: 3, queuedAtCreation: true },
        { id: "task-prompt", queuePriority: 3, queuedAtCreation: true },
      ]);
      // A task that isn't queued keeps the defaults: it's queued again with its own time when it is.
      expect(await rowsOf(client, `SELECT "queuePriority", "queuedAt", "requiredLabels" FROM "task" WHERE id = 'task-running'`)).toEqual([
        { queuePriority: 3, queuedAt: null, requiredLabels: [] },
      ]);
      // The project's pools numbered by their pools' creation: the default pool came first.
      expect(await rowsOf(client, `SELECT "poolId", position, "maxBoxes" FROM "project_pool" ORDER BY position`)).toEqual([
        { poolId: "pool-default", position: 0, maxBoxes: null },
        { poolId: "pool-late", position: 1, maxBoxes: 2 },
      ]);
      // Every organization's three sizes.
      expect(await rowsOf(client, `SELECT "organizationId", name, "cpuMillis", "memoryMiB" FROM "box_size" ORDER BY "organizationId", "cpuMillis"`)).toEqual([
        { organizationId: "org-1", name: "small", cpuMillis: 2000, memoryMiB: 4096 },
        { organizationId: "org-1", name: "medium", cpuMillis: 4000, memoryMiB: 8192 },
        { organizationId: "org-1", name: "large", cpuMillis: 8000, memoryMiB: 16_384 },
        { organizationId: "org-2", name: "small", cpuMillis: 2000, memoryMiB: 4096 },
        { organizationId: "org-2", name: "medium", cpuMillis: 4000, memoryMiB: 8192 },
        { organizationId: "org-2", name: "large", cpuMillis: 8000, memoryMiB: 16_384 },
      ]);
      // Every earlier row is as it was, with the new columns empty or at their defaults.
      expect(await rowsOf(client, `SELECT labels, "joinTokenId", install, "drainedAt", capacity FROM "runner" WHERE id = 'run-1'`)).toEqual([
        { labels: ["gpu"], joinTokenId: null, install: null, drainedAt: null, capacity: 4 },
      ]);
      expect(await rowsOf(client, `SELECT "useCount", "revokedByMemberId" FROM "join_token" WHERE id = 'tok-1'`)).toEqual([{ useCount: 0, revokedByMemberId: null }]);
      expect(await rowsOf(client, `SELECT "joinTokenDays" FROM "runner_pool" ORDER BY id`)).toEqual([{ joinTokenDays: null }, { joinTokenDays: null }]);
      expect(await rowsOf(client, `SELECT "runnerLabels" FROM "agent_profile" WHERE id = 'prof-1'`)).toEqual([{ runnerLabels: [] }]);
      expect(await rowsOf(client, `SELECT "defaultBoxSize" FROM "project" WHERE id = 'proj-1'`)).toEqual([{ defaultBoxSize: "medium" }]);
      expect(await rowsOf(client, `SELECT "runnerId", "registryId", builder FROM "snapshot" WHERE id = 'snap-1'`)).toEqual([{ runnerId: "run-1", registryId: null, builder: null }]);
      expect(await rowsOf(client, `SELECT state::text AS state, size, "waitingReason" FROM "box" WHERE id = 'box-1'`)).toEqual([{ state: "ready", size: null, waitingReason: null }]);
      // The registry table starts empty.
      expect(await rowsOf(client, `SELECT count(*)::int AS n FROM "registry"`)).toEqual([{ n: 0 }]);
    });
  });
});
