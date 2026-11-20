import type { CatalogEntry } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { budgetMonthOf } from "@ostra/domain";
import { modelIdSchema, providerIdSchema } from "@ostra/protocol";
import type { ModelId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow, seedSpendRows } from "../testing/m4-seed.ts";

// F-037 (ticket 27; ADR 0055): the month's spend and the budgets read `SpendDaily` only; budgets and
// prices are an organization admin's, each with its audit entry; a budget set below the spend
// reports reached at once; and the New task check says why a task would wait.

let harness: ApiHarness;
const SECRET_NAME = "Client Orion hidden project";
let model: ModelId;
let otherModel: ModelId;
let unpricedModel: ModelId;
const MONTH = "2026-10";
const PRICED_URL = "https://priced-models.example.com/v1";
const PRICED_TOKEN = "sk-priced-models-token-0123456789abcdef";

/** The micro-USD each seeded task spent, as ingest adds each `usage.recorded` to the rollup. */
const taskSpend: {
  readonly projectId: () => ProjectId;
  readonly day: string;
  readonly micro: number;
  readonly tokens: number;
  readonly modelId: () => ModelId;
}[] = [
  {
    projectId: () => harness.fixture.a.openProject.id,
    day: "2026-10-01",
    micro: 1_250_000,
    tokens: 1000,
    modelId: () => model,
  },
  {
    projectId: () => harness.fixture.a.openProject.id,
    day: "2026-10-15",
    micro: 750_000,
    tokens: 400,
    modelId: () => otherModel,
  },
  {
    projectId: () => harness.fixture.a.restrictedProject.id,
    day: "2026-10-31",
    micro: 3_000_000,
    tokens: 2000,
    modelId: () => model,
  },
  // Not this month: September's last day, and November's first.
  {
    projectId: () => harness.fixture.a.openProject.id,
    day: "2026-09-30",
    micro: 9_999_000,
    tokens: 1,
    modelId: () => model,
  },
  {
    projectId: () => harness.fixture.a.openProject.id,
    day: "2026-11-01",
    micro: 8_888_000,
    tokens: 1,
    modelId: () => model,
  },
];

beforeAll(async () => {
  harness = await createApiHarness();
  const { a, b } = harness.fixture;
  await harness.test.db.project.update({
    where: { id: a.restrictedProject.id },
    data: { name: SECRET_NAME },
  });
  const provider = await seedProviderRow(harness.test.db, a.organization.id, "Client keys");
  model = await seedModelRow(harness.test.db, {
    organizationId: a.organization.id,
    providerId: provider,
    endpointModelId: "m-1",
    displayName: "Model one",
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
  });
  otherModel = await seedModelRow(harness.test.db, {
    organizationId: a.organization.id,
    providerId: provider,
    endpointModelId: "m-2",
  });
  unpricedModel = await seedModelRow(harness.test.db, {
    organizationId: a.organization.id,
    providerId: provider,
    endpointModelId: "m-3",
  });
  await seedSpendRows(
    harness.test.db,
    a.organization.id,
    taskSpend.map((row) => ({
      projectId: row.projectId(),
      modelId: row.modelId(),
      day: row.day,
      inputTokens: row.tokens,
      outputTokens: 10,
      spentMicroUsd: row.micro,
    })),
  );
  await seedSpendRows(harness.test.db, a.organization.id, [
    {
      projectId: a.openProject.id,
      modelId: unpricedModel,
      day: "2026-10-20",
      inputTokens: 500,
      unpricedTokens: 520,
    },
  ]);
  // Another organization's spend, which organization A never sees.
  const providerB = await seedProviderRow(harness.test.db, b.organization.id, "B keys");
  const modelB = await seedModelRow(harness.test.db, {
    organizationId: b.organization.id,
    providerId: providerB,
    endpointModelId: "b-1",
  });
  await seedSpendRows(harness.test.db, b.organization.id, [
    { projectId: b.project.id, modelId: modelB, day: "2026-10-02", spentMicroUsd: 42_000_000 },
  ]);
});

afterAll(async () => {
  await harness.dispose();
});

describe("spend.month", () => {
  it("F-037: the month's totals equal the sum of its tasks' spend, by project and model, inside the month only", async () => {
    const view = await (await harness.as(harness.fixture.a.admin)).spend.month({ month: MONTH });
    const inMonth = taskSpend.filter((row) => row.day.startsWith(MONTH));
    expect(view.total.spentMicroUsd).toBe(inMonth.reduce((sum, row) => sum + row.micro, 0));
    expect(view.total.spentMicroUsd).toBe(5_000_000);
    expect(view.total.inputTokens).toBe(1000 + 400 + 2000 + 500);
    expect(view.byProject.reduce((sum, row) => sum + row.spentMicroUsd, 0)).toBe(
      view.total.spentMicroUsd,
    );
    expect(view.byModel.reduce((sum, row) => sum + row.spentMicroUsd, 0)).toBe(
      view.total.spentMicroUsd,
    );
    expect(view.byModel.find((row) => row.modelId === model)).toMatchObject({
      name: "Model one",
      spentMicroUsd: 4_250_000,
      providerName: "Client keys",
    });
    expect(
      view.byProject.find((row) => row.line.kind === "project" && row.line.name === SECRET_NAME)
        ?.spentMicroUsd,
    ).toBe(3_000_000);
    expect(view.unpriced).toEqual([{ modelId: unpricedModel, name: "m-3", unpricedTokens: 520 }]);
    expect(view.total.unpricedTokens).toBe(520);
    // Organization B's own month: only its own row.
    expect(
      (await (await harness.as(harness.fixture.b.admin)).spend.month({ month: MONTH })).total
        .spentMicroUsd,
    ).toBe(42_000_000);
  });

  it("F-037: a hidden project's spend shows only as Other projects", async () => {
    const { a } = harness.fixture;
    const view = await (await harness.as(a.member)).spend.month({ month: MONTH });
    const text = JSON.stringify(view);
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(a.restrictedProject.id);
    expect(view.byProject.filter((row) => row.line.kind === "other")).toEqual([
      expect.objectContaining({ line: { kind: "other" }, spentMicroUsd: 3_000_000 }),
    ]);
    expect(view.total.spentMicroUsd).toBe(5_000_000);
    // The insider can open it: its own line, by name.
    const insider = await (await harness.as(a.insider)).spend.month({ month: MONTH });
    expect(
      insider.byProject.some((row) => row.line.kind === "project" && row.line.name === SECRET_NAME),
    ).toBe(true);
    await expect(
      (await harness.as(a.member)).spend.project({
        projectId: a.restrictedProject.id,
        month: MONTH,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await (
          await harness.as(a.insider)
        ).spend.project({ projectId: a.restrictedProject.id, month: MONTH })
      ).total.spentMicroUsd,
    ).toBe(3_000_000);
  });
});

describe("budgets and prices", () => {
  it("F-037: a member can't set a budget or a price, nor clear one", async () => {
    const { a } = harness.fixture;
    for (const actor of [a.member, a.insider]) {
      const caller = await harness.as(actor);
      await expect(caller.budgets.set({ projectId: null, monthlyUsd: 100 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        caller.budgets.set({ projectId: a.openProject.id, monthlyUsd: 100 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.budgets.clear({ projectId: null })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        caller.providers.setModelPrice({
          modelId: otherModel,
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(
      await harness.test.db.budget.count({ where: { organizationId: a.organization.id } }),
    ).toBe(0);
    // Another organization's admin can't reach organization A's project or model.
    const otherAdmin = await harness.as(harness.fixture.b.admin);
    await expect(
      otherAdmin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      otherAdmin.providers.setModelPrice({
        modelId: otherModel,
        inputPerMTok: 1,
        outputPerMTok: 1,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-037: a budget is the organization's or a project's only: no member's or agent profile's, which come later (F-131)", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const base: Parameters<typeof admin.budgets.set>[0] = { projectId: null, monthlyUsd: 10 };
    for (const scope of [{ memberId: a.member.id }, { agentProfileId: "01900000-0000-7000-8000-0000000000c1" }]) {
      await expect(admin.budgets.set(Object.assign({}, base, scope))).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(admin.budgets.clear(Object.assign({ projectId: null }, scope))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await harness.test.db.budget.count({ where: { organizationId: a.organization.id } })).toBe(0);
    // A budget row has an organization and, at most, a project: nothing names a member or a profile.
    expect(Object.keys(Prisma.BudgetScalarFieldEnum).filter((field) => field.endsWith("Id")).sort()).toEqual(
      ["organizationId", "projectId", "updatedByMemberId"].sort(),
    );
  });

  it("F-037: an admin's price takes all four, from now on, with its audit entry", async () => {
    const { a } = harness.fixture;
    const saved = await (
      await harness.as(a.admin)
    ).providers.setModelPrice({
      modelId: otherModel,
      inputPerMTok: 2.5,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.25,
      cacheWritePerMTok: null,
    });
    const row = await harness.test.db.model.findUniqueOrThrow({ where: { id: otherModel } });
    expect(row.inputPricePerMTok?.toNumber()).toBe(2.5);
    expect(row.outputPricePerMTok?.toNumber()).toBe(10);
    expect(row.cacheReadPricePerMTok?.toNumber()).toBe(0.25);
    expect(row.cacheWritePricePerMTok).toBeNull();
    expect(row.priceSource).toBe("admin");
    expect(row.priceChangedAt?.getTime()).toBe(saved.priceChangedAt);
    // Spend already counted keeps its price.
    expect(
      (await (await harness.as(a.admin)).spend.month({ month: MONTH })).byModel.find(
        (line) => line.modelId === otherModel,
      )?.spentMicroUsd,
    ).toBe(750_000);
    const audit = await harness.test.db.auditEntry.findFirst({
      where: { organizationId: a.organization.id, action: "model.price-changed", entityId: otherModel },
    });
    expect(audit?.actorId).toBe(a.admin.id);
  });

  it("F-037: a budget set below the spend reports reached at once, and enqueues its notices", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    // The month's spend is the clock's month: put this month's spend on the restricted project.
    const now = budgetMonthOf(Date.now());
    await seedSpendRows(harness.test.db, a.organization.id, [
      { projectId: a.restrictedProject.id, modelId: model, day: `${now}-01`, spentMicroUsd: 2_000_000 },
    ]);
    const jobsBefore = harness.fakes.jobs.jobs.length;
    const { budgetId } = await admin.budgets.set({ projectId: a.restrictedProject.id, monthlyUsd: 1 });
    const view = await admin.spend.month({ month: now });
    expect(view.budgets).toEqual([
      expect.objectContaining({
        budgetId,
        scope: { kind: "project", projectId: a.restrictedProject.id, name: SECRET_NAME },
        monthlyMicroUsd: 1_000_000,
        spentMicroUsd: 2_000_000,
        share: 2,
        state: "reached",
        overshootMicroUsd: 1_000_000,
      }),
    ]);
    const enqueued = harness.fakes.jobs.jobs
      .slice(jobsBefore)
      .filter((job) => job.job === "budget.check");
    expect(enqueued.map((job) => job.payload)).toEqual([
      { organizationId: a.organization.id, budgetId, month: now, threshold: "warn" },
      { organizationId: a.organization.id, budgetId, month: now, threshold: "reached" },
    ]);
    const audit = await harness.test.db.auditEntry.findFirst({
      where: {
        organizationId: a.organization.id,
        action: "budget.set",
        entityId: a.restrictedProject.id,
      },
    });
    expect(audit).toMatchObject({
      actorId: a.admin.id,
      projectId: a.restrictedProject.id,
      data: { budgetId, monthlyMicroUsd: 1_000_000, previousMicroUsd: null },
    });
    // Raised above the spend: warn, not reached, and the held turns are released.
    await admin.budgets.set({ projectId: a.restrictedProject.id, monthlyUsd: 2.4 });
    const raised = await admin.spend.month({ month: now });
    expect(raised.budgets[0]).toMatchObject({ state: "warn", overshootMicroUsd: 0 });
    expect(harness.fakes.jobs.jobs.some((job) => job.job === "budget.release")).toBe(true);
    // A member sees the budget of a project they can open; never one they can't.
    await admin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 50 });
    const asMember = await (await harness.as(a.member)).spend.month({ month: now });
    expect(asMember.budgets.map((budget) => budget.scope)).toEqual([
      { kind: "project", projectId: a.openProject.id, name: "open" },
    ]);
    await admin.budgets.clear({ projectId: a.restrictedProject.id });
    await admin.budgets.clear({ projectId: a.openProject.id });
    expect(
      await harness.test.db.budget.count({ where: { organizationId: a.organization.id } }),
    ).toBe(0);
    expect(
      await harness.test.db.auditEntry.count({
        where: { organizationId: a.organization.id, action: "budget.cleared" },
      }),
    ).toBe(2);
  });

  it("F-037: an admin's price comes last in the order: a catalog refresh keeps it", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const entry: CatalogEntry = {
      catalogId: "acme/priced-1",
      name: "Priced one",
      aliases: ["priced-1"],
      contextWindow: 100_000,
      maxOutputTokens: 8_000,
      inputPricePerMTok: 1.25,
      outputPricePerMTok: 10,
      cacheReadPricePerMTok: 0.125,
      cacheWritePricePerMTok: null,
      logoPath: null,
      reasoning: { supported: false },
      reasoningPriceDiffers: false,
    };
    harness.catalogEntries.push(entry);
    harness.fakes.modelProvider.endpoints.set(PRICED_URL, {
      token: PRICED_TOKEN,
      apiFormat: "openai-compatible",
      authScheme: "bearer",
      models: [{ endpointModelId: "priced-1", displayName: null, contextWindow: null }],
    });
    const created = await admin.providers.create({
      name: "Priced",
      baseUrl: PRICED_URL,
      apiFormat: "openai-compatible",
      authScheme: "bearer",
      sessionsAtOnce: null,
      allowOnPersonalRunners: false,
      token: PRICED_TOKEN,
    });
    const providerId = providerIdSchema.parse(created.providerId);
    const row = await harness.test.db.model.findFirstOrThrow({
      where: { providerId, endpointModelId: "priced-1" },
    });
    // The catalog's prices first.
    expect(row.inputPricePerMTok?.toNumber()).toBe(1.25);
    await admin.providers.setModelPrice({
      modelId: modelIdSchema.parse(row.id),
      inputPerMTok: 2,
      outputPerMTok: 8,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    });
    expect(await admin.providers.refresh({ providerId })).toMatchObject({ listed: 1, matched: 1 });
    const after = await harness.test.db.model.findUniqueOrThrow({ where: { id: row.id } });
    expect([
      after.inputPricePerMTok?.toNumber(),
      after.outputPricePerMTok?.toNumber(),
      after.cacheReadPricePerMTok?.toNumber(),
      after.cacheWritePricePerMTok?.toNumber(),
      after.priceSource,
    ]).toEqual([2, 8, 0.2, 2.5, "admin"]);
    // A price past what the column holds is refused.
    await expect(
      admin.providers.setModelPrice({
        modelId: modelIdSchema.parse(row.id),
        inputPerMTok: 1_000_000,
        outputPerMTok: 1,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
