import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "./generated/prisma/client.ts";
import { buildIsolationRows, isolationAllowlist, isolationModelNames, isolationProjectModels } from "./testing/isolation-models.ts";
import { seedIsolationFixture } from "./testing/isolation.ts";
import type { IsolationFixture } from "./testing/isolation.ts";
import { createTestDatabase } from "./testing/test-database.ts";
import type { TestDatabase } from "./testing/test-database.ts";

// Milestone 4, ticket 09 (F-049, F-087, ADR 0053): the isolation model list's guard. Read from the
// Prisma schema (the DMMF's models and fields, parsed from `schema.prisma` and checked against the
// client's own model names): a model with `organizationId` must have a fixture builder, a model
// without it must be on the reviewed allowlist, and no model may be on both. And every builder
// makes a valid row, with its parents, in two organizations and in a restricted project.

type SchemaModel = { readonly name: string; readonly hasOrganizationId: boolean; readonly hasProjectId: boolean };

const readSchemaModels = async (): Promise<readonly SchemaModel[]> => {
  const schema = await readFile(path.resolve(import.meta.dirname, "..", "prisma", "schema.prisma"), "utf8");
  const models: SchemaModel[] = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    if (name === undefined || body === undefined) {
      continue;
    }
    const fields = body.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "");
    models.push({ name, hasOrganizationId: fields.includes("organizationId"), hasProjectId: fields.includes("projectId") });
  }
  return models;
};

describe("the isolation model list (F-049)", () => {
  it("F-049: every model with organizationId has a fixture builder, every other is on the allowlist with its reason, and none is on both", async () => {
    const models = await readSchemaModels();
    // The parse sees exactly the client's models.
    expect(new Set(models.map((model) => model.name))).toEqual(new Set(Object.values(Prisma.ModelName)));
    const listed = new Set<string>(isolationModelNames());
    const allowed = new Set<string>(Object.keys(isolationAllowlist));
    const onNeither = models.filter((model) => !listed.has(model.name) && !allowed.has(model.name)).map((model) => model.name);
    const onBoth = models.filter((model) => listed.has(model.name) && allowed.has(model.name)).map((model) => model.name);
    expect(onNeither, "a model on neither list: give it a fixture builder in isolation-models.ts, or a reviewed reason on the allowlist").toEqual([]);
    expect(onBoth).toEqual([]);
    // A builder is for a model with the column, and the allowlist for one without it.
    expect(models.filter((model) => listed.has(model.name) && !model.hasOrganizationId).map((model) => model.name)).toEqual([]);
    expect(models.filter((model) => allowed.has(model.name) && model.hasOrganizationId).map((model) => model.name)).toEqual([]);
    for (const reason of Object.values(isolationAllowlist)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("F-087: every model with a required projectId is built inside a project", async () => {
    const schema = await readFile(path.resolve(import.meta.dirname, "..", "prisma", "schema.prisma"), "utf8");
    const required = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
      .filter((match) => /^\s+projectId\s+String\s/m.test(match[2] ?? ""))
      .map((match) => match[1] ?? "");
    const projectModels = new Set<string>(isolationProjectModels);
    expect(required.filter((name) => !projectModels.has(name))).toEqual([]);
  });
});

describe("every builder makes a valid row (F-049, F-087)", () => {
  let test: TestDatabase;
  let fixture: IsolationFixture;

  beforeAll(async () => {
    test = await createTestDatabase();
    fixture = await seedIsolationFixture(test.db);
  });

  afterAll(async () => {
    await test.dispose();
  });

  it("F-049: builds every listed model in two organizations and in a restricted project, each row in its own organization and project", async () => {
    const { a, b } = fixture;
    const rowsA = await buildIsolationRows(test.db, { organizationId: a.organization.id, memberId: a.admin.id, userId: a.admin.userId }, [a.openProject.id, a.restrictedProject.id]);
    const rowsB = await buildIsolationRows(test.db, { organizationId: b.organization.id, memberId: b.admin.id, userId: b.admin.userId }, [b.project.id]);
    expect(rowsA.get(a.restrictedProject.id)?.size).toBe(isolationModelNames().length);
    expect(rowsB.get(b.project.id)?.size).toBe(isolationModelNames().length);
    const tasks = await test.db.task.findMany({ select: { organizationId: true, projectId: true } });
    expect(tasks).toEqual(
      expect.arrayContaining([
        { organizationId: a.organization.id, projectId: a.openProject.id },
        { organizationId: a.organization.id, projectId: a.restrictedProject.id },
        { organizationId: b.organization.id, projectId: b.project.id },
      ]),
    );
    // The restricted project's members are still the fixture's: no builder listed anyone new on it but its own member.
    const listed = await test.db.projectMember.findMany({ where: { projectId: a.restrictedProject.id }, select: { memberId: true } });
    expect(listed.map((row) => row.memberId)).not.toContain(a.member.id);
  });
});
