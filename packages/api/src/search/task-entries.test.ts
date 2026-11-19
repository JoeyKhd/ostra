import { searchTasks } from "@ostra/domain";
import { memberIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 4, ticket 11 (F-080): the panel's task writers write their search entries in the same
// transaction: a new task's title and prompt, and its first message, through `tasks.create`.

let harness: ApiHarness;
let projectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "searched")).projectId;
});

afterAll(async () => {
  await harness.dispose();
});

describe("a new task's entries (F-080)", () => {
  it("F-080: tasks.create writes the task's title, prompt and first message as entries, and search finds it by them", async () => {
    const { a } = harness.fixture;
    const created = await (await harness.as(a.member)).tasks.create({ projectId, prompt: "Teach the calculator about hexadecimal input", title: "Hexadecimal calculator" });
    const entries = await harness.test.db.searchEntry.findMany({ where: { taskId: created.taskId }, orderBy: { kind: "asc" } });
    expect(entries.map((entry) => [entry.kind, entry.authorMemberId])).toEqual([
      ["title", a.member.id],
      ["prompt", a.member.id],
      ["member_message", a.member.id],
    ]);
    const scope = { organizationId: organizationIdSchema.parse(a.organization.id), memberId: memberIdSchema.parse(a.member.id), role: "member" as const, projectRoles: new Map() };
    const results = await searchTasks(harness.test.db, scope, { text: "hexadeci", ticketKey: null, repoId: null, memberId: null, state: null, limit: 10 });
    expect(results.map((result) => result.taskId)).toEqual([created.taskId]);
  });
});
