import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";

// F-086 (ADR 0026, Q28): "Every task belongs to one project, and every record inside a project
// carries it." Read from the migrated database itself, not from the Prisma schema, so a migration
// that forgets a column or a constraint fails here.
//
// A record is inside a project when it points at the project, or at a record inside one. It carries
// the project when it has a `projectId` column that its links to other records inside the project
// include: a composite foreign key `(parentId, projectId)`, so it can't name its parent's project
// wrongly. A record that may sit outside a project (its `projectId` is nullable) and links to a
// record inside one must not leave `projectId` empty while that link is set: Postgres checks a
// composite foreign key only when every one of its columns is set (MATCH SIMPLE).

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

const foreignKeySchema = z.object({
  table: z.string(),
  name: z.string(),
  columns: z.array(z.string()),
  references: z.string(),
});
type ForeignKey = z.infer<typeof foreignKeySchema>;

const columnSchema = z.object({ table: z.string(), column: z.string(), nullable: z.boolean() });
const checkSchema = z.object({ table: z.string(), definition: z.string() });

type Catalog = {
  readonly foreignKeys: readonly ForeignKey[];
  readonly projectIdColumns: ReadonlyMap<string, { readonly nullable: boolean }>;
  readonly checks: ReadonlyMap<string, readonly string[]>;
};

const readCatalog = async (): Promise<Catalog> => {
  const foreignKeys = z.array(foreignKeySchema).parse(
    await test.db.$queryRaw`
      SELECT src.relname AS "table", con.conname AS "name", dst.relname AS "references",
             array(SELECT att.attname::text FROM unnest(con.conkey) AS k(n)
                   JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.n) AS "columns"
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class dst ON dst.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      WHERE con.contype = 'f' AND ns.nspname = 'public'`,
  );
  const columns = z.array(columnSchema).parse(
    await test.db.$queryRaw`
      SELECT table_name AS "table", column_name AS "column", (is_nullable = 'YES') AS "nullable"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'projectId'`,
  );
  const checks = z.array(checkSchema).parse(
    await test.db.$queryRaw`
      SELECT src.relname AS "table", pg_get_constraintdef(con.oid) AS "definition"
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = src.relnamespace
      WHERE con.contype = 'c' AND ns.nspname = 'public'`,
  );
  const checksByTable = new Map<string, string[]>();
  for (const check of checks) {
    checksByTable.set(check.table, [...(checksByTable.get(check.table) ?? []), check.definition]);
  }
  return {
    foreignKeys,
    projectIdColumns: new Map(columns.map((column) => [column.table, { nullable: column.nullable }] as const)),
    checks: checksByTable,
  };
};

/** The tables whose rows are inside a project: they point at it, or at a row that is, by a required link. */
const tablesInsideAProject = (catalog: Catalog): ReadonlySet<string> => {
  const inside = new Set<string>(["project"]);
  const required = (key: ForeignKey): boolean => {
    const projectId = catalog.projectIdColumns.get(key.table);
    // A link whose columns include a nullable projectId is optional: the row may be outside a project.
    return !(key.columns.includes("projectId") && projectId?.nullable === true);
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of catalog.foreignKeys) {
      if (inside.has(key.references) && !inside.has(key.table) && required(key)) {
        inside.add(key.table);
        grew = true;
      }
    }
  }
  inside.delete("project");
  return inside;
};

/** The tables that may hold a row inside a project or outside one: a nullable projectId linked to a project. */
const tablesSometimesInsideAProject = (catalog: Catalog): ReadonlySet<string> =>
  new Set(
    catalog.foreignKeys
      .filter((key) => key.references === "project" && catalog.projectIdColumns.get(key.table)?.nullable === true)
      .map((key) => key.table),
  );

const newTask = async (projectId: string) =>
  test.db.task.create({
    data: {
      organizationId: fixture.a.organization.id,
      projectId,
      kind: "code",
      source: "prompt",
      title: "Add CONTRIBUTING.md",
      prompt: "Add a short CONTRIBUTING.md",
      branchName: `ostra/test-${randomUUID().slice(0, 8)}`,
    },
  });

describe("project scope in the schema", () => {
  it("F-086/c2: every task belongs to exactly one project, which it can't leave empty or take from another organization", async () => {
    const catalog = await readCatalog();
    expect(catalog.projectIdColumns.get("task")).toEqual({ nullable: false });
    expect(catalog.foreignKeys.filter((key) => key.table === "task" && key.references === "project").map((key) => [...key.columns].sort())).toEqual([
      ["organizationId", "projectId"],
    ]);
    // Behaviour, not only the catalog: no project, and another organization's project, are both refused.
    await expect(
      test.db.$executeRaw`INSERT INTO task ("id", "organizationId", "projectId", "kind", "source", "title", "prompt", "branchName", "updatedAt")
        VALUES (${randomUUID()}, ${fixture.a.organization.id}, NULL, 'code', 'prompt', 'No project', 'x', 'ostra/no-project', now())`,
    ).rejects.toThrow();
    await expect(
      test.db.task.create({
        data: {
          organizationId: fixture.a.organization.id,
          projectId: fixture.b.project.id,
          kind: "code",
          source: "prompt",
          title: "Elsewhere",
          prompt: "x",
          branchName: "ostra/elsewhere",
        },
      }),
    ).rejects.toThrow();
    expect((await newTask(fixture.a.openProject.id)).projectId).toBe(fixture.a.openProject.id);
  });

  it("F-086/c2: every record inside a project carries the project, and its links to other records in it include the project", async () => {
    const catalog = await readCatalog();
    const inside = tablesInsideAProject(catalog);
    // The tables a task's work writes are all here: a sanity check that the walk found the project's records.
    for (const table of ["task", "repo", "environment", "session", "event", "turn", "box", "lease", "approval", "needs_you_item", "ticket", "board"]) {
      expect(inside).toContain(table);
    }
    const missingColumn = [...inside].filter((table) => catalog.projectIdColumns.get(table)?.nullable !== false);
    expect(missingColumn).toEqual([]);
    // A link carries the project when it includes projectId, or the row's taskId where the row's own
    // link to its task includes projectId: the parent then has the row's task, so the row's project.
    const taskCarriesProject = (table: string): boolean =>
      catalog.foreignKeys.some((key) => key.table === table && key.references === "task" && key.columns.includes("taskId") && key.columns.includes("projectId"));
    const linksWithoutProject = catalog.foreignKeys
      .filter((key) => inside.has(key.table) && inside.has(key.references))
      .filter((key) => !key.columns.includes("projectId") && !(key.columns.includes("taskId") && taskCarriesProject(key.table)))
      .map((key) => `${key.table}.${key.name}`);
    expect(linksWithoutProject).toEqual([]);
  });

  it("F-086/c2: a record that may sit outside a project can't link to a record inside one without carrying its project", async () => {
    const catalog = await readCatalog();
    const inside = tablesInsideAProject(catalog);
    const unguarded: string[] = [];
    for (const table of tablesSometimesInsideAProject(catalog)) {
      for (const key of catalog.foreignKeys.filter((candidate) => candidate.table === table && inside.has(candidate.references))) {
        if (!key.columns.includes("projectId")) {
          unguarded.push(`${table}.${key.name}: its link leaves out projectId`);
          continue;
        }
        const linkColumns = key.columns.filter((column) => column !== "projectId" && column !== "organizationId");
        const guarded = (catalog.checks.get(table) ?? []).some(
          (definition) => definition.includes('"projectId" IS NOT NULL') && linkColumns.every((column) => definition.includes(`"${column}" IS NULL`)),
        );
        if (!guarded) {
          unguarded.push(`${table}.${key.name}: ${linkColumns.join(", ")} can be set with projectId empty`);
        }
      }
    }
    expect(unguarded).toEqual([]);

    // And the behaviour: a blob and a command that name a task but no project are refused.
    const task = await newTask(fixture.a.openProject.id);
    await expect(
      test.db.blob.create({
        data: {
          organizationId: fixture.a.organization.id,
          taskId: task.id,
          store: "postgres",
          key: `blob-${randomUUID()}`,
          purpose: "session-archive",
          contentType: "application/octet-stream",
          size: 1,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      test.db.blob.create({
        data: {
          organizationId: fixture.a.organization.id,
          taskId: "not-a-task",
          store: "postgres",
          key: `blob-${randomUUID()}`,
          purpose: "session-archive",
          contentType: "application/octet-stream",
          size: 1,
          sha256: "0".repeat(64),
        },
      }),
    ).rejects.toThrow();
    // With its project, the same blob is stored.
    const stored = await test.db.blob.create({
      data: {
        organizationId: fixture.a.organization.id,
        projectId: fixture.a.openProject.id,
        taskId: task.id,
        store: "postgres",
        key: `blob-${randomUUID()}`,
        purpose: "session-archive",
        contentType: "application/octet-stream",
        size: 1,
        sha256: "0".repeat(64),
      },
    });
    expect(stored.projectId).toBe(fixture.a.openProject.id);
  });
});
