import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import "./testing/provided-context.ts";

// Milestone 2's additive migrations, on a database as milestone 1 left it (tickets 43 and 46): a
// fresh database is migrated up to the last migration milestone 1 shipped, given the rows milestone
// 1's demo leaves (an organization, a GitHub connection, a project with its repo, and prompt tasks
// that ended in review, stopped and merged, each with its branch, its PR and its session), and then
// migrated the rest of the way, file by file, as `prisma migrate deploy` applies them.

const migrationsDir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));

/** The schema milestone 1's demo ran on; every migration after it comes later. */
const LAST_OF_MILESTONE_1 = "20261119120000_user_must_change_password";

const migrationNames = async (): Promise<string[]> =>
  (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const databases: string[] = [];

const withClient = async <T,>(database: string, work: (client: pg.Client) => Promise<T>): Promise<T> => {
  const url = new URL(inject("ostraDbServerUrl"));
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

/** An empty database of its own, not copied from the migrated template. */
const emptyDatabase = async (): Promise<string> => {
  const name = `ostra_migrate_${randomBytes(6).toString("hex")}`;
  await withClient("postgres", (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`));
  databases.push(name);
  return name;
};

const apply = async (database: string, names: readonly string[]): Promise<void> => {
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");
    await withClient(database, (client) => client.query(sql));
  }
};

afterAll(async () => {
  for (const name of databases) {
    await withClient("postgres", (client) => client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`));
  }
});

type DemoTask = { readonly id: string; readonly branchName: string };

/** The rows milestone 1's demo leaves, written in milestone 1's schema. */
const seedMilestoneOneDemo = async (database: string, branches: readonly string[]): Promise<readonly DemoTask[]> =>
  withClient(database, async (client) => {
    const id = (): string => randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const organizationId = id();
    const projectId = id();
    const connectionId = id();
    const repoId = id();
    await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, 'Demo', 'demo', now())`, [organizationId]);
    await client.query(
      `INSERT INTO "connection" ("id", "organizationId", "kind", "appId", "slug", "updatedAt") VALUES ($1, $2, 'github', '5821041', 'ostra-test', now())`,
      [connectionId, organizationId],
    );
    await client.query(`INSERT INTO "project" ("id", "organizationId", "name", "slug", "updatedAt") VALUES ($1, $2, 'Demo', 'demo', now())`, [
      projectId,
      organizationId,
    ]);
    await client.query(
      `INSERT INTO "repo" ("id", "organizationId", "projectId", "connectionId", "installationId", "hostRepoId", "fullName", "defaultBranch", "checkoutDir", "updatedAt")
       VALUES ($1, $2, $3, $4, '777', 'host-1', 'ostra-test/test1', 'main', 'test1', now())`,
      [repoId, organizationId, projectId, connectionId],
    );
    const ended = [
      { state: "in_review", subState: "waiting_for_reviewer", stoppedReason: null },
      { state: "stopped", subState: null, stoppedReason: "requested" },
      { state: "merged", subState: null, stoppedReason: null },
    ] as const;
    const tasks: DemoTask[] = [];
    for (const [index, branchName] of branches.entries()) {
      const taskId = id();
      const shape = ended[index % ended.length] ?? ended[0];
      await client.query(
        `INSERT INTO "task" ("id", "organizationId", "projectId", "kind", "source", "title", "prompt", "branchName", "state", "subState", "stoppedReason", "leaseEpoch", "dispatchNote", "updatedAt")
         VALUES ($1, $2, $3, 'code', 'prompt', 'Add a short CONTRIBUTING.md', 'a prompt', $4, $5, $6, $7, 1, NULL, now())`,
        [taskId, organizationId, projectId, branchName, shape.state, shape.subState, shape.stoppedReason],
      );
      await client.query(
        `INSERT INTO "task_repo" ("id", "organizationId", "projectId", "taskId", "repoId", "branchName", "baseBranch", "prNumber", "prUrl", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 'main', $7, $8, now())`,
        [id(), organizationId, projectId, taskId, repoId, branchName, index + 1, `https://github.com/ostra-test/test1/pull/${String(index + 1)}`],
      );
      await client.query(
        `INSERT INTO "session" ("id", "organizationId", "projectId", "taskId", "origin", "state", "outcome", "endedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'new', 'ended', 'with_changes', now(), now())`,
        [id(), organizationId, projectId, taskId],
      );
      tasks.push({ id: taskId, branchName });
    }
    return tasks;
  });

describe("milestone 2's migrations", () => {
  it("F-016: apply to an empty database", async () => {
    const database = await emptyDatabase();
    await apply(database, await migrationNames());
    const indexes = await withClient(database, (client) =>
      client.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'task_project_branch_unique'`),
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toContain(`WHERE ("branchName" <> 'pending'::text)`);
    const columns = await withClient(database, (client) =>
      client.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'task' AND column_name = 'dispatchWait'`),
    );
    expect(columns.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("F-016/c3: apply to a database holding milestone 1's demo data, and keep every row and branch as it was", async () => {
    const names = await migrationNames();
    const cut = names.indexOf(LAST_OF_MILESTONE_1);
    expect(cut).toBeGreaterThanOrEqual(0);
    const database = await emptyDatabase();
    await apply(database, names.slice(0, cut + 1));
    const seeded = await seedMilestoneOneDemo(database, ["ostra/1a2b3c4d-add-a-short-contributing-md", "ostra/5e6f7a8b-add-a-short-contributing-md", "ostra/9c0d1e2f-add-a-short-contributing-md"]);

    await apply(database, names.slice(cut + 1));

    const rows = await withClient(database, (client) => client.query(`SELECT "id", "branchName", "dispatchWait", "dispatchNote" FROM "task" ORDER BY "branchName"`));
    expect(rows.rows).toEqual(seeded.map((task) => ({ id: task.id, branchName: task.branchName, dispatchWait: null, dispatchNote: null })).sort((x, y) => x.branchName.localeCompare(y.branchName)));
    const repos = await withClient(database, (client) => client.query(`SELECT count(*)::int AS "count" FROM "task_repo" WHERE "prNumber" IS NOT NULL`));
    expect(repos.rows).toEqual([{ count: 3 }]);
    // The index holds from here on.
    const first = seeded[0];
    if (first === undefined) {
      throw new Error("no task was seeded");
    }
    await expect(
      withClient(database, (client) =>
        client.query(`UPDATE "task" SET "branchName" = $1 WHERE "id" <> $2 AND "branchName" <> $1`, [first.branchName, first.id]),
      ),
    ).rejects.toThrow(/task_project_branch_unique/);
  });

  it("F-016/c3: stop on two tasks of a project that share a branch, name them, and rename nothing", async () => {
    const names = await migrationNames();
    const cut = names.indexOf(LAST_OF_MILESTONE_1);
    const database = await emptyDatabase();
    await apply(database, names.slice(0, cut + 1));
    const shared = "ostra/1a2b3c4d-nightly-report";
    const seeded = await seedMilestoneOneDemo(database, [shared, "ostra/5e6f7a8b-other", shared]);
    const unique = names.find((name) => name.endsWith("_task_branch_unique"));
    if (unique === undefined) {
      throw new Error("no branch-name migration");
    }
    const before = names.slice(cut + 1, names.indexOf(unique));
    await apply(database, before);

    const refused = apply(database, [unique]);
    await expect(refused).rejects.toThrow(shared);
    const message = await refused.then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    for (const task of seeded.filter((row) => row.branchName === shared)) {
      expect(message).toContain(task.id);
    }
    const rows = await withClient(database, (client) => client.query(`SELECT "branchName" FROM "task" ORDER BY "branchName"`));
    expect(rows.rows.map((row: { branchName: string }) => row.branchName)).toEqual([shared, shared, "ostra/5e6f7a8b-other"]);
    const indexes = await withClient(database, (client) => client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'task_project_branch_unique'`));
    expect(indexes.rows).toEqual([]);
  });
});
