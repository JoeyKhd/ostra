import { budgetMonthOf } from "@ostra/domain";
import type { ModelId, ProjectId, ProviderId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow, seedSpendRows } from "../testing/m4-seed.ts";

// F-135/c13 (spend-keys.md, ADR 0055 "Spend per key"): Organization › Spend's Keys section reads
// `spend.month`'s `byProvider`. An organization admin's month lists every key it holds, one that
// spent nothing at zero, highest first and ties by name; each key carries its month's tasks; anyone
// else's lists only the keys that spent, with the tasks of the projects they can open; a project's
// month lists only the keys it spent on; and no other organization's key is ever in any of them.

let harness: ApiHarness;
const MONTH = budgetMonthOf(Date.now());
const LAST_MONTH = budgetMonthOf(Date.parse(`${MONTH}-01T00:00:00Z`) - 1);
let busy: ProviderId;
let quiet: ProviderId;
let spareB: ProviderId;
let spareA: ProviderId;
let otherOrganizationKey: ProviderId;
let busyModel: ModelId;
let quietModel: ModelId;

beforeAll(async () => {
  harness = await createApiHarness();
  const { a, b } = harness.fixture;
  const db = harness.test.db;
  busy = await seedProviderRow(db, a.organization.id, "keys-acme-anthropic");
  quiet = await seedProviderRow(db, a.organization.id, "keys-northwind-anthropic");
  // Two keys that spend nothing, created out of name order: their tie is broken by name.
  spareB = await seedProviderRow(db, a.organization.id, "keys-spare-openai");
  spareA = await seedProviderRow(db, a.organization.id, "keys-globex-openrouter");
  otherOrganizationKey = await seedProviderRow(db, b.organization.id, "keys-other-organization");
  busyModel = await seedModelRow(db, { organizationId: a.organization.id, providerId: busy, endpointModelId: "busy-model", inputPricePerMTok: 3, outputPricePerMTok: 15 });
  quietModel = await seedModelRow(db, { organizationId: a.organization.id, providerId: quiet, endpointModelId: "quiet-model", inputPricePerMTok: 3, outputPricePerMTok: 15 });
  const otherModel = await seedModelRow(db, { organizationId: b.organization.id, providerId: otherOrganizationKey, endpointModelId: "other-model" });
  await seedSpendRows(db, a.organization.id, [
    { projectId: a.openProject.id, modelId: busyModel, day: `${MONTH}-01`, inputTokens: 5_000, outputTokens: 400, cacheReadTokens: 9_000, cacheWriteTokens: 300, spentMicroUsd: 9_000_000 },
    { projectId: a.restrictedProject.id, modelId: busyModel, day: `${MONTH}-01`, inputTokens: 1_000, spentMicroUsd: 1_000_000 },
    { projectId: a.restrictedProject.id, modelId: quietModel, day: `${MONTH}-01`, inputTokens: 700, outputTokens: 70, spentMicroUsd: 4_000_000 },
    // Last month's spend isn't this month's.
    { projectId: a.openProject.id, modelId: quietModel, day: `${LAST_MONTH}-28`, inputTokens: 50, spentMicroUsd: 77_000_000 },
  ]);
  await seedSpendRows(db, b.organization.id, [{ projectId: b.project.id, modelId: otherModel, day: `${MONTH}-01`, inputTokens: 10, spentMicroUsd: 99_000_000 }]);
});

afterAll(async () => {
  await harness.dispose();
});

/** A task whose session ran on `providerId`, started at `startedAt`. */
const sessionOn = async (projectId: ProjectId, providerId: ProviderId, startedAt: Date, taskId?: string): Promise<string> => {
  const { a } = harness.fixture;
  const db = harness.test.db;
  if (taskId !== undefined) {
    await db.session.create({ data: { organizationId: a.organization.id, projectId, taskId, origin: "resumed", state: "ended", outcome: "with_changes", endedAt: startedAt, startedAt, providerId } });
    return taskId;
  }
  const task = await seedTask(harness, { organizationId: a.organization.id, projectId });
  await db.session.update({ where: { id: task.sessionId }, data: { providerId, startedAt } });
  return task.taskId;
};

describe("F-135/c13: Spend per key", () => {
  it("F-135/c13: the organization's month lists every key, one that spent nothing at zero, highest first and ties by name, and the keys sum to the month", async () => {
    const { a } = harness.fixture;
    const view = await (await harness.as(a.admin)).spend.month({ month: MONTH });
    const ours = await harness.test.db.modelProvider.findMany({ where: { organizationId: a.organization.id }, select: { id: true } });
    expect(view.byProvider.map((line) => line.providerId).sort()).toEqual(ours.map((row) => row.id).sort());
    expect(view.byProvider.map((line) => line.providerId)).not.toContain(otherOrganizationKey);

    const mine = view.byProvider.filter((line) => [busy, quiet, spareA, spareB].includes(line.providerId));
    expect(mine.map((line) => line.name)).toEqual(["keys-acme-anthropic", "keys-northwind-anthropic", "keys-globex-openrouter", "keys-spare-openai"]);
    expect(mine[0]).toMatchObject({ providerId: busy, inputTokens: 6_000, outputTokens: 400, cacheReadTokens: 9_000, cacheWriteTokens: 300, unpricedTokens: 0, spentMicroUsd: 10_000_000 });
    expect(mine[1]).toMatchObject({ providerId: quiet, inputTokens: 700, outputTokens: 70, spentMicroUsd: 4_000_000 });
    for (const spare of [spareA, spareB]) {
      expect(view.byProvider.find((line) => line.providerId === spare)).toEqual({
        providerId: spare,
        name: spare === spareA ? "keys-globex-openrouter" : "keys-spare-openai",
        taskCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        unpricedTokens: 0,
        spentMicroUsd: 0,
      });
    }
    // The keys, the projects and the models are three cuts of the same month.
    const sum = (lines: readonly { readonly spentMicroUsd: number }[]): number => lines.reduce((total, line) => total + line.spentMicroUsd, 0);
    expect(sum(view.byProvider)).toBe(view.total.spentMicroUsd);
    expect(sum(view.byProject)).toBe(view.total.spentMicroUsd);
    expect(sum(view.byModel)).toBe(view.total.spentMicroUsd);
    // A past month lists the keys held then: last month's spend is that month's, a key held before
    // it that spent nothing in it is at zero, and a key added since isn't one of its keys.
    await harness.test.db.modelProvider.update({ where: { id: spareA }, data: { createdAt: new Date(Date.parse(`${LAST_MONTH}-01T00:00:00Z`) - 1) } });
    const last = await (await harness.as(a.admin)).spend.month({ month: LAST_MONTH });
    expect(last.byProvider.find((line) => line.providerId === quiet)?.spentMicroUsd).toBe(77_000_000);
    expect(last.byProvider.find((line) => line.providerId === spareA)).toMatchObject({ spentMicroUsd: 0, inputTokens: 0, taskCount: 0 });
    expect(last.byProvider.map((line) => line.providerId)).not.toContain(busy);
    expect(last.byProvider.map((line) => line.providerId)).not.toContain(spareB);
  });

  it("F-135/c13: a key's tasks are the month's: each task with a session on it that started in the month, once", async () => {
    const { a } = harness.fixture;
    const inMonth = new Date(Date.parse(`${MONTH}-01T10:00:00Z`));
    const lastMonth = new Date(Date.parse(`${LAST_MONTH}-27T10:00:00Z`));
    const caller = await harness.as(a.admin);
    const before = await caller.spend.month({ month: MONTH });
    const countOf = (view: typeof before, providerId: ProviderId): number => view.byProvider.find((line) => line.providerId === providerId)?.taskCount ?? -1;
    // Two tasks on the busy key this month, one of them with a second session on it; one on the quiet key last month.
    const first = await sessionOn(a.openProject.id, busy, inMonth);
    await sessionOn(a.openProject.id, busy, inMonth, first);
    await sessionOn(a.restrictedProject.id, busy, inMonth);
    await sessionOn(a.openProject.id, quiet, lastMonth);
    const after = await caller.spend.month({ month: MONTH });
    expect(countOf(after, busy) - countOf(before, busy)).toBe(2);
    expect(countOf(after, quiet)).toBe(countOf(before, quiet));
    expect(countOf(after, spareA)).toBe(0);
    expect((await caller.spend.month({ month: LAST_MONTH })).byProvider.find((line) => line.providerId === quiet)?.taskCount).toBe(1);
    // The project's month counts only its own tasks.
    const project = await caller.spend.project({ projectId: a.restrictedProject.id, month: MONTH });
    expect(project.byProvider.find((line) => line.providerId === busy)?.taskCount).toBe(1);
  });

  it("F-135/c13: a member who isn't an organization admin sees only the keys that spent, and counts only the tasks of the projects they can open", async () => {
    const { a } = harness.fixture;
    const db = harness.test.db;
    const inMonth = new Date(Date.parse(`${MONTH}-02T10:00:00Z`));
    const viewOf = async (member: typeof a.admin) => (await harness.as(member)).spend.month({ month: MONTH });
    const countOf = (view: Awaited<ReturnType<typeof viewOf>>, providerId: ProviderId): number => view.byProvider.find((line) => line.providerId === providerId)?.taskCount ?? -1;
    // A key on the restricted project's own list alone, named for its client, that spent nothing.
    const hidden = await seedProviderRow(db, a.organization.id, "keys-restricted-client");
    await db.providerListEntry.create({ data: { organizationId: a.organization.id, projectId: a.restrictedProject.id, providerId: hidden } });
    const before = { admin: await viewOf(a.admin), member: await viewOf(a.member), insider: await viewOf(a.insider) };
    await sessionOn(a.openProject.id, busy, inMonth);
    await sessionOn(a.restrictedProject.id, busy, inMonth);
    await sessionOn(a.restrictedProject.id, hidden, inMonth);
    const after = { admin: await viewOf(a.admin), member: await viewOf(a.member), insider: await viewOf(a.insider) };

    // The admin's month lists every key, the restricted project's at zero with its task.
    expect(after.admin.byProvider.find((line) => line.providerId === hidden)).toMatchObject({ name: "keys-restricted-client", spentMicroUsd: 0, taskCount: 1 });
    expect(countOf(after.admin, busy) - countOf(before.admin, busy)).toBe(2);
    for (const view of [after.member, after.insider]) {
      // Anyone else's lists the keys that spent, the ones the models' lines name, and nothing more.
      const spent = new Set(view.byModel.map((line) => line.providerId));
      expect(view.byProvider.map((line) => line.providerId).sort()).toEqual([...spent].sort());
      expect(view.byProvider.every((line) => line.spentMicroUsd > 0)).toBe(true);
      for (const name of ["keys-restricted-client", "keys-spare-openai", "keys-globex-openrouter"]) {
        expect(JSON.stringify(view)).not.toContain(name);
      }
      expect(view.byProvider.reduce((total, line) => total + line.spentMicroUsd, 0)).toBe(view.total.spentMicroUsd);
    }
    // A member off the restricted project counts the open project's task alone; one on it counts both.
    expect(countOf(after.member, busy) - countOf(before.member, busy)).toBe(1);
    expect(countOf(after.insider, busy) - countOf(before.insider, busy)).toBe(2);
    expect(countOf(after.member, busy)).toBeLessThan(countOf(after.admin, busy));
  });

  it("F-135/c13: a project's month lists only the keys it spent on, and another organization's month never lists ours", async () => {
    const { a, b } = harness.fixture;
    const project = await (await harness.as(a.admin)).spend.project({ projectId: a.openProject.id, month: MONTH });
    expect(project.byProvider.map((line) => line.providerId)).toEqual([busy]);
    expect(project.byProvider[0]?.spentMicroUsd).toBe(9_000_000);
    const other = await (await harness.as(b.admin)).spend.month({ month: MONTH });
    expect(other.byProvider.map((line) => line.providerId)).toContain(otherOrganizationKey);
    for (const ours of [busy, quiet, spareA, spareB]) {
      expect(other.byProvider.map((line) => line.providerId)).not.toContain(ours);
    }
    expect(JSON.stringify(other)).not.toContain("keys-acme-anthropic");
  });
});
