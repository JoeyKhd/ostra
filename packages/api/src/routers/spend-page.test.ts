import { budgetMonthOf } from "@ostra/domain";
import { providerIdSchema } from "@ostra/protocol";
import type { ModelId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow, seedSpendRows } from "../testing/m4-seed.ts";

// F-037 (ticket 36): what the Spend page reads beyond ticket 27's figures: each budget's notices this
// month, the turns it holds and who set it, a model's catalog logo and whether it's custom, and one
// model's four prices with their source for the price form.

let harness: ApiHarness;
let priced: ModelId;
let unpriced: ModelId;
const MONTH = budgetMonthOf(Date.now());
const LAST_MONTH = budgetMonthOf(Date.parse(`${MONTH}-01T00:00:00Z`) - 1);

beforeAll(async () => {
  harness = await createApiHarness();
  harness.catalogEntries.push({
    catalogId: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    aliases: [],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    cacheReadPricePerMTok: null,
    cacheWritePricePerMTok: null,
    logoPath: "/assets/models/anthropic.svg",
    reasoning: { supported: false },
    reasoningPriceDiffers: false,
    inputModalities: null,
  });
  const { a } = harness.fixture;
  const provider = await seedProviderRow(harness.test.db, a.organization.id, "Spend page keys");
  priced = await seedModelRow(harness.test.db, {
    organizationId: a.organization.id,
    providerId: provider,
    endpointModelId: "claude-sonnet-4-5",
    catalogId: "anthropic/claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
  });
  unpriced = await seedModelRow(harness.test.db, { organizationId: a.organization.id, providerId: provider, endpointModelId: "acme/sql-coder-ft" });
  await seedSpendRows(harness.test.db, a.organization.id, [
    { projectId: a.openProject.id, modelId: priced, day: `${MONTH}-01`, inputTokens: 1000, spentMicroUsd: 5_000_000 },
    { projectId: a.openProject.id, modelId: unpriced, day: `${MONTH}-01`, inputTokens: 700, unpricedTokens: 760 },
    { projectId: a.openProject.id, modelId: unpriced, day: `${LAST_MONTH}-28`, inputTokens: 9, unpricedTokens: 9 },
  ]);
});

afterAll(async () => {
  await harness.dispose();
});

describe("spend.month for the Spend page", () => {
  it("F-037/c1: a budget carries this month's notices, the turns it holds now and who set it", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { budgetId } = await admin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 4 });
    // The organization's budget, with no notices and nothing held of its own.
    const organizationBudget = await admin.budgets.set({ projectId: null, monthlyUsd: 1000 });
    const warnedAt = new Date(Date.parse(`${MONTH}-01T08:00:00Z`));
    const reachedAt = new Date(Date.parse(`${MONTH}-01T09:30:00Z`));
    await harness.test.db.budgetNotice.createMany({
      data: [
        { organizationId: a.organization.id, budgetId, month: MONTH, threshold: "warn", sentAt: warnedAt },
        { organizationId: a.organization.id, budgetId, month: MONTH, threshold: "reached", sentAt: reachedAt },
        // Last month's notice isn't this month's.
        { organizationId: a.organization.id, budgetId, month: LAST_MONTH, threshold: "warn", sentAt: new Date(Date.parse(`${LAST_MONTH}-20T00:00:00Z`)) },
      ],
    });
    const scope = { organizationId: a.organization.id, projectId: a.openProject.id };
    const queuedOne = await seedTask(harness, { ...scope, state: "queued" });
    const queuedTwo = await seedTask(harness, { ...scope, state: "queued" });
    const idle = await seedTask(harness, { ...scope, sessionState: "idle" });
    const held = (taskId: string, origin: "dispatch" | "message" | "pr_comment", releasedAt: Date | null = null) => ({
      organizationId: a.organization.id,
      projectId: a.openProject.id,
      taskId,
      origin,
      budgetId,
      releasedAt,
    });
    await harness.test.db.heldTurn.createMany({
      data: [
        held(queuedOne.taskId, "dispatch"),
        // A task held twice at dispatch is one queued task.
        held(queuedOne.taskId, "dispatch"),
        held(queuedTwo.taskId, "dispatch"),
        held(idle.taskId, "message"),
        held(idle.taskId, "pr_comment"),
        // Released turns aren't held any more.
        held(idle.taskId, "message", new Date()),
        held(queuedTwo.taskId, "dispatch", new Date()),
      ],
    });

    const view = await admin.spend.month({ month: MONTH });
    const budget = view.budgets.find((row) => row.budgetId === budgetId);
    const name = (await harness.test.db.user.findUniqueOrThrow({ where: { id: a.admin.userId } })).name;
    expect(budget).toMatchObject({
      state: "reached",
      warnedAt: warnedAt.getTime(),
      reachedAt: reachedAt.getTime(),
      queuedTasks: 2,
      heldTurns: 2,
      setBy: { name },
    });
    expect(budget?.setBy?.at).toBe(budget?.updatedAt);
    expect(view.budgets.find((row) => row.budgetId === organizationBudget.budgetId)).toMatchObject({ warnedAt: null, reachedAt: null, queuedTasks: 0, heldTurns: 0 });

    // Last month shows last month's notices: its warning, and no 100% notice.
    const past = await admin.spend.month({ month: LAST_MONTH });
    expect(past.budgets.find((row) => row.budgetId === budgetId)).toMatchObject({ warnedAt: Date.parse(`${LAST_MONTH}-20T00:00:00Z`), reachedAt: null });
  });

  it("F-037/c1: a new task the gate keeps queued counts as a queued task of the budget its dispatch note names", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const queuedOf = async (): Promise<{ readonly project: number; readonly organization: number }> => {
      const view = await admin.spend.month({ month: MONTH });
      return {
        project: view.budgets.find((row) => row.scope.kind === "project" && row.scope.projectId === a.openProject.id)?.queuedTasks ?? -1,
        organization: view.budgets.find((row) => row.scope.kind === "organization")?.queuedTasks ?? -1,
      };
    };
    const before = await queuedOf();
    const scope = { organizationId: a.organization.id, projectId: a.openProject.id };
    const atProject = await seedTask(harness, { ...scope, state: "queued" });
    const atOrganization = await seedTask(harness, { ...scope, state: "queued" });
    const forRunner = await seedTask(harness, { ...scope, state: "queued" });
    await harness.test.db.task.update({ where: { id: atProject.taskId }, data: { dispatchWait: { code: "budget-reached", scope: "project" } } });
    await harness.test.db.task.update({ where: { id: atOrganization.taskId }, data: { dispatchWait: { code: "budget-reached", scope: "organization" } } });
    // A task waiting for a runner isn't the budget's.
    await harness.test.db.task.update({ where: { id: forRunner.taskId }, data: { dispatchWait: { code: "no-runner-online" } } });
    expect(await queuedOf()).toEqual({ project: before.project + 1, organization: before.organization + 1 });
  });

  it("F-037/c1: each model line says whether it's custom, with the catalog's logo for one that isn't", async () => {
    const view = await (await harness.as(harness.fixture.a.admin)).spend.month({ month: MONTH });
    const sonnet = view.byModel.find((line) => line.modelId === priced);
    const custom = view.byModel.find((line) => line.modelId === unpriced);
    expect(sonnet).toMatchObject({ custom: false, name: "Claude Sonnet 4.5" });
    expect(sonnet?.logoPath).toBe("/assets/models/anthropic.svg");
    expect(custom).toMatchObject({ custom: true, logoPath: null, unpricedTokens: 760, spentMicroUsd: 0 });
  });
});

describe("spend.modelPrice", () => {
  it("F-037/c1: a model's four prices, where they came from, and its unpriced tokens this month", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    expect(await admin.spend.modelPrice({ modelId: unpriced, month: MONTH })).toEqual({
      modelId: unpriced,
      name: "acme/sql-coder-ft",
      endpointModelId: "acme/sql-coder-ft",
      custom: true,
      logoPath: null,
      providerName: "Spend page keys",
      priceSource: null,
      priceChangedAt: null,
      prices: { inputPerMTok: null, outputPerMTok: null, cacheReadPerMTok: null, cacheWritePerMTok: null },
      unpricedTokens: 760,
    });
    const saved = await admin.providers.setModelPrice({ modelId: unpriced, inputPerMTok: 0.2, outputPerMTok: 0.8, cacheReadPerMTok: 0.02, cacheWritePerMTok: null });
    const after = await admin.spend.modelPrice({ modelId: unpriced, month: MONTH });
    expect(after).toMatchObject({
      priceSource: "admin",
      priceChangedAt: saved.priceChangedAt,
      prices: { inputPerMTok: 0.2, outputPerMTok: 0.8, cacheReadPerMTok: 0.02, cacheWritePerMTok: null },
      // Spend already counted is never repriced.
      unpricedTokens: 760,
    });
    expect((await admin.spend.modelPrice({ modelId: unpriced, month: LAST_MONTH })).unpricedTokens).toBe(9);

    // Models shows the same four and their source.
    const provider = await harness.test.db.model.findUniqueOrThrow({ where: { id: unpriced }, select: { providerId: true } });
    const listed = (await admin.providers.models({ providerId: providerIdSchema.parse(provider.providerId) })).find((model) => model.id === unpriced);
    expect(listed).toMatchObject({ inputPricePerMTok: 0.2, outputPricePerMTok: 0.8, cacheReadPricePerMTok: 0.02, cacheWritePricePerMTok: null, priceSource: "admin", priceChangedAt: saved.priceChangedAt });
  });

  it("F-037/c1: a member can't read a model's price form, nor another organization's model", async () => {
    const { a, b } = harness.fixture;
    await expect((await harness.as(a.member)).spend.modelPrice({ modelId: priced, month: MONTH })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(b.admin)).spend.modelPrice({ modelId: priced, month: MONTH })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
