import { budgetMonthOf, setDefaultProviders } from "@ostra/domain";
import { afterAll, beforeAll, it } from "vitest";
import { expect } from "vitest";

import { createApiHarness, seedConnectionAndModel } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedSpendRows } from "../testing/m4-seed.ts";

// F-037 and F-135 (tickets 27 and 50): the New task check runs the dispatch's own checks, on a fresh
// install whose first provider is on the default list.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

it("F-037/c2, F-135/c11: startCheck gives each reason: open, a project's and the organization's budget reached, no price, and no key", async () => {
  const { a } = harness.fixture;
  const world = await seedConnectionAndModel(harness);
  const admin = await harness.as(a.admin);
  const member = await harness.as(a.member);
  const check = () => member.tasks.startCheck({ projectId: a.openProject.id });

  // The organization's first provider is on the default list (ADR 0065), so a fresh install's
  // project has a key. Its model has no price yet: with no budget, that's fine.
  expect(await check()).toEqual({ kind: "open", providerName: "World models" });

  // A budget, and a model without a price: the budget can't count it.
  const { budgetId: orgBudget } = await admin.budgets.set({ projectId: null, monthlyUsd: 1000 });
  expect(await check()).toEqual({
    kind: "wait",
    reason: "unpriced",
    budgetId: orgBudget,
    message: "This model has no price, so the budget can't count it",
  });
  await admin.providers.setModelPrice({
    modelId: world.modelId,
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
  });
  expect(await check()).toEqual({ kind: "open", providerName: "World models" });

  // The project's budget reached.
  const now = budgetMonthOf(Date.now());
  await seedSpendRows(harness.test.db, a.organization.id, [
    {
      projectId: a.openProject.id,
      modelId: world.modelId,
      day: `${now}-01`,
      spentMicroUsd: 2_000_000,
    },
  ]);
  const monthWords = new Date(Date.now()).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const { budgetId: projectBudget } = await admin.budgets.set({
    projectId: a.openProject.id,
    monthlyUsd: 0.5,
  });
  expect(await check()).toEqual({
    kind: "wait",
    reason: "budget-reached",
    budgetId: projectBudget,
    scope: "project",
    month: now,
    message: `open's budget for ${monthWords} is reached`,
  });
  await admin.budgets.clear({ projectId: a.openProject.id });

  // The organization's budget reached, by every project's spend.
  await admin.budgets.set({ projectId: null, monthlyUsd: 0.01 });
  expect(await check()).toEqual({
    kind: "wait",
    reason: "budget-reached",
    budgetId: orgBudget,
    scope: "organization",
    month: now,
    message: `The organization's budget for ${monthWords} is reached`,
  });
  await admin.budgets.clear({ projectId: null });
  expect(await check()).toEqual({ kind: "open", providerName: "World models" });

  // No key: the project's own list doesn't allow the profile's provider (ADR 0065 amended
  // 2026-11-20: the first-run model names it).
  await harness.test.db.project.update({
    where: { id: a.openProject.id },
    data: { ownProviders: true },
  });
  expect(await check()).toEqual({
    kind: "wait",
    reason: "no-provider",
    modelName: "world-model",
    provider: { name: "World models", reason: "not-allowed" },
    message: "The profile runs on World models, which this project's list doesn't allow: an organization admin adds it in Models and keys, or a member picks a profile on an allowed key",
  });
  await harness.test.db.project.update({
    where: { id: a.openProject.id },
    data: { ownProviders: false },
  });
  // The default list emptied: the same reason.
  const scope = (await harness.contextOf(a.admin)).member?.scope;
  if (scope === undefined) {
    throw new Error("the admin has a scope");
  }
  await setDefaultProviders({ db: harness.test.db, ...harness.deps.ports }, scope, {
    providerIds: [],
  });
  expect((await check()).kind).toBe("wait");
  await expect(
    member.tasks.startCheck({ projectId: a.restrictedProject.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
