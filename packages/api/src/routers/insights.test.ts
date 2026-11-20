import {
  medianTimeToFirstPr,
  mergeRate,
  prsClosedUnmerged,
  prsMerged,
  prsOpened,
  timeWaiting,
  tokensAndSpend,
  waitingDurationsByReason,
} from "@ostra/domain";
import type { InsightPeriod, InsightPullRequest, InsightTask, InsightWaitingItem } from "@ostra/domain";
import { repoIdSchema } from "@ostra/protocol";
import type { ModelId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow, seedSpendRows } from "../testing/m4-seed.ts";

// F-108 (ticket 28): Insights read only what `insights.compute` keeps. The fixture states raw PRs,
// needs-you items and spend, writes the rows the job would write from them with ticket 06's
// definitions, and checks each figure against the same definitions over the raw data.

const DAY = 86_400_000;
const at = (text: string): number => Date.parse(text);
const dayOf = (ms: number): number => Math.floor(ms / DAY) * DAY;

let harness: ApiHarness;
const SECRET_NAME = "Client Zephyr secret project";

type Fixture = {
  readonly tasks: readonly (InsightTask & { readonly projectId: ProjectId })[];
  readonly prs: readonly (InsightPullRequest & { readonly projectId: ProjectId })[];
  readonly items: readonly (InsightWaitingItem & { readonly projectId: ProjectId })[];
  readonly spend: readonly { readonly projectId: ProjectId; readonly modelId: ModelId; readonly day: string; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly spentMicroUsd: number }[];
};

let fixture: Fixture;
let modelA: ModelId;
let modelB: ModelId;
const LAST_RUN = new Date("2026-10-08T03:04:05.000Z");

/** What `insights.compute` writes for each day of the window: the organization's row and each project's. */
const writeJobRows = async (data: Fixture, from: number, to: number): Promise<void> => {
  const { a } = harness.fixture;
  const organizationId = a.organization.id;
  const projects: readonly (ProjectId | null)[] = [null, a.openProject.id, a.restrictedProject.id];
  for (let day = from; day < to; day += DAY) {
    const period: InsightPeriod = { start: day, end: day + DAY };
    for (const projectId of projects) {
      const prs = data.prs.filter((pr) => projectId === null || pr.projectId === projectId);
      const items = data.items.filter((item) => projectId === null || item.projectId === projectId);
      const waiting = timeWaiting(items, period);
      await harness.test.db.insightDaily.create({
        data: {
          organizationId,
          projectId,
          day: new Date(day),
          prsOpened: prsOpened(prs, period),
          prsMerged: prsMerged(prs, period),
          prsClosedUnmerged: prsClosedUnmerged(prs, period),
          waitingMs: BigInt(waiting.totalMs),
          waitingItems: waiting.count,
          waitingByReason: waitingDurationsByReason(items, period),
        },
      });
    }
  }
  for (const task of data.tasks) {
    const own = data.prs.filter((pr) => pr.taskId === task.taskId);
    const first = own.reduce<number | null>((min, pr) => (min === null || pr.openedAt < min ? pr.openedAt : min), null);
    await harness.test.db.taskMetric.create({
      data: {
        organizationId,
        projectId: task.projectId,
        taskId: task.taskId,
        createdAt: new Date(task.createdAt),
        firstPrAt: first === null ? null : new Date(first),
        prsOpened: own.length,
      },
    });
  }
  await harness.test.db.insightRun.create({ data: { organizationId, lastRunAt: LAST_RUN, lastSourceChangeAt: LAST_RUN } });
};

beforeAll(async () => {
  harness = await createApiHarness();
  const { a } = harness.fixture;
  const organizationId = a.organization.id;
  await harness.test.db.project.update({ where: { id: a.restrictedProject.id }, data: { name: SECRET_NAME } });
  const provider = await seedProviderRow(harness.test.db, organizationId, "Acme models");
  modelA = await seedModelRow(harness.test.db, { organizationId, providerId: provider, endpointModelId: "model-a", displayName: "Model A" });
  modelB = await seedModelRow(harness.test.db, { organizationId, providerId: provider, endpointModelId: "model-b" });

  const task = async (projectId: ProjectId, createdAt: string): Promise<InsightTask & { readonly projectId: ProjectId }> => {
    const seeded = await seedTask(harness, { organizationId, projectId, state: "in_review" });
    await harness.test.db.task.update({ where: { id: seeded.taskId }, data: { createdAt: new Date(createdAt) } });
    return { taskId: seeded.taskId, kind: "code", createdAt: at(createdAt), projectId };
  };
  const t1 = await task(a.openProject.id, "2026-09-30T10:00:00Z");
  const t2 = await task(a.openProject.id, "2026-10-02T08:00:00Z");
  const t3 = await task(a.openProject.id, "2026-10-03T00:00:00Z");
  const t4 = await task(a.restrictedProject.id, "2026-10-01T12:00:00Z");
  const t5 = await task(a.openProject.id, "2026-09-20T00:00:00Z");
  const repo = repoIdSchema.parse("00000000-0000-7000-8000-000000000001");
  const pr = (t: { readonly taskId: TaskId; readonly projectId: ProjectId }, openedAt: string, merged: string | null, closed: string | null) => ({
    taskId: t.taskId,
    projectId: t.projectId,
    repoId: repo,
    openedAt: at(openedAt),
    mergedAt: merged === null ? null : at(merged),
    closedUnmergedAt: closed === null ? null : at(closed),
  });
  const item = (projectId: ProjectId, reason: string, createdAt: string, endedAt: string | null) => ({
    projectId,
    reason,
    createdAt: at(createdAt),
    endedAt: endedAt === null ? null : at(endedAt),
  });
  fixture = {
    tasks: [t1, t2, t3, t4, t5],
    prs: [
      pr(t1, "2026-10-01T10:00:00Z", "2026-10-02T10:00:00Z", null),
      pr(t1, "2026-10-01T11:00:00Z", null, "2026-10-04T00:00:00Z"),
      pr(t2, "2026-10-02T20:00:00Z", "2026-10-05T00:00:00Z", null),
      pr(t3, "2026-10-06T00:00:00Z", null, null),
      pr(t4, "2026-10-03T12:00:00Z", "2026-10-06T23:59:00Z", null),
      // Outside the period: its first PR opened in September.
      pr(t5, "2026-09-25T00:00:00Z", "2026-10-01T05:00:00Z", null),
    ],
    items: [
      item(a.openProject.id, "question", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z"),
      item(a.openProject.id, "question", "2026-10-02T00:00:00Z", "2026-10-02T03:00:00Z"),
      item(a.openProject.id, "approval", "2026-10-03T00:00:00Z", "2026-10-03T00:30:00Z"),
      item(a.restrictedProject.id, "plan", "2026-09-30T00:00:00Z", "2026-10-04T00:00:00Z"),
      item(a.openProject.id, "question", "2026-10-05T00:00:00Z", null),
      item(a.openProject.id, "approval", "2026-09-29T00:00:00Z", "2026-09-29T05:00:00Z"),
    ],
    spend: [
      { projectId: a.openProject.id, modelId: modelA, day: "2026-10-02", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 5, spentMicroUsd: 120_000 },
      { projectId: a.openProject.id, modelId: modelB, day: "2026-10-03", inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, spentMicroUsd: 9_000 },
      { projectId: a.restrictedProject.id, modelId: modelA, day: "2026-10-04", inputTokens: 7000, outputTokens: 900, cacheReadTokens: 10, cacheWriteTokens: 1, spentMicroUsd: 777_000 },
      { projectId: a.openProject.id, modelId: modelA, day: "2026-09-29", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, spentMicroUsd: 1 },
    ],
  };
  await writeJobRows(fixture, at("2026-09-25T00:00:00Z"), at("2026-10-10T00:00:00Z"));
  await seedSpendRows(harness.test.db, organizationId, fixture.spend);
});

afterAll(async () => {
  await harness.dispose();
});

const PERIOD = { kind: "range", from: "2026-10-01", to: "2026-10-07" } as const;
const PERIOD_MS: InsightPeriod = { start: at("2026-10-01T00:00:00Z"), end: at("2026-10-08T00:00:00Z") };

describe("insights.get", () => {
  it("F-108/c1: each figure equals ticket 06's reference for the organization over the period", async () => {
    const view = await (await harness.as(harness.fixture.a.admin)).insights.get({ projectId: null, period: PERIOD });
    expect(view.period).toEqual(PERIOD_MS);
    expect(view.prsOpened).toBe(prsOpened(fixture.prs, PERIOD_MS));
    expect(view.prsOpened).toBe(5);
    expect(view.prsMerged).toBe(prsMerged(fixture.prs, PERIOD_MS));
    expect(view.prsMerged).toBe(4);
    expect(view.mergeRate).toBe(mergeRate(fixture.prs, PERIOD_MS));
    expect(view.mergeRate).toBeCloseTo(4 / 5);
    const first = medianTimeToFirstPr(fixture.tasks, fixture.prs, PERIOD_MS);
    expect(view.timeToFirstPr).toEqual(first);
    expect(view.timeToFirstPr.count).toBe(4);
    const waiting = timeWaiting(fixture.items, PERIOD_MS);
    expect(view.waiting).toMatchObject({ totalMs: waiting.totalMs, medianMs: waiting.medianMs, count: waiting.count });
    expect(view.waiting.count).toBe(4);
    for (const [reason, figure] of waiting.byReason) {
      expect(view.waiting.byReason.find((row) => row.reason === reason)).toEqual({ reason, ...figure });
    }
    expect(view.waiting.byReason).toHaveLength(waiting.byReason.size);
    const spend = tokensAndSpend(
      fixture.spend.map((row) => ({
        ...row,
        day: at(`${row.day}T00:00:00Z`),
        inputTokens: BigInt(row.inputTokens),
        outputTokens: BigInt(row.outputTokens),
        cacheReadTokens: BigInt(row.cacheReadTokens),
        cacheWriteTokens: BigInt(row.cacheWriteTokens),
        spentMicroUsd: BigInt(row.spentMicroUsd),
      })),
      PERIOD_MS,
    );
    expect(view.tokens.total).toMatchObject({
      inputTokens: Number(spend.total.inputTokens),
      outputTokens: Number(spend.total.outputTokens),
      cacheReadTokens: Number(spend.total.cacheReadTokens),
      cacheWriteTokens: Number(spend.total.cacheWriteTokens),
      spentMicroUsd: Number(spend.total.spentMicroUsd),
    });
    for (const [modelId, totals] of spend.byModel) {
      expect(view.tokens.byModel.find((row) => row.modelId === modelId)).toMatchObject({ spentMicroUsd: Number(totals.spentMicroUsd), inputTokens: Number(totals.inputTokens) });
    }
    expect(view.tokens.byModel.find((row) => row.modelId === modelA)).toMatchObject({ name: "Model A", providerName: "Acme models" });
    expect(view.tokens.byModel.find((row) => row.modelId === modelB)).toMatchObject({ name: "model-b" });
    // An admin can open every project: each has its own line.
    const open = view.tokens.byProject.find((row) => row.line.kind === "project" && row.line.projectId === harness.fixture.a.openProject.id);
    expect(open?.spentMicroUsd).toBe(Number(spend.byProject.get(harness.fixture.a.openProject.id)?.spentMicroUsd));
    expect(view.tokens.byProject.some((row) => row.line.kind === "project" && row.line.name === SECRET_NAME)).toBe(true);
  });

  it("F-108/c1: the medians' counts, and a series per day of PRs opened and merged", async () => {
    const view = await (await harness.as(harness.fixture.a.member)).insights.get({ projectId: null, period: PERIOD });
    expect(view.timeToFirstPr.count).toBe(4);
    expect(view.waiting.count).toBe(4);
    expect(view.series).toHaveLength(7);
    expect(view.series.map((row) => row.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
    expect(view.series.map((row) => row.prsOpened)).toEqual([2, 1, 1, 0, 0, 1, 0]);
    expect(view.series.map((row) => row.prsMerged)).toEqual([1, 1, 0, 0, 1, 1, 0]);
  });

  it("F-108/c1: each day of the series carries the sparklines' figures, from the job's rows and the rollup alone", async () => {
    const view = await (await harness.as(harness.fixture.a.admin)).insights.get({ projectId: null, period: PERIOD });
    view.series.forEach((row, i) => {
      const day: InsightPeriod = { start: PERIOD_MS.start + i * DAY, end: PERIOD_MS.start + (i + 1) * DAY };
      expect(row.mergeRate).toBe(mergeRate(fixture.prs, day));
      expect(row.firstPrMedianMs).toBe(medianTimeToFirstPr(fixture.tasks, fixture.prs, day).medianMs);
      expect(row.waitingMs).toBe(timeWaiting(fixture.items, day).totalMs);
      expect(row.spentMicroUsd).toBe(fixture.spend.filter((spend) => at(`${spend.day}T00:00:00Z`) === day.start).reduce((sum, spend) => sum + spend.spentMicroUsd, 0));
    });
    // The days add up to the period's figures.
    expect(view.series.reduce((sum, row) => sum + row.waitingMs, 0)).toBe(view.waiting.totalMs);
    expect(view.series.reduce((sum, row) => sum + row.spentMicroUsd, 0)).toBe(view.tokens.total.spentMicroUsd);
    expect(view.series.filter((row) => row.mergeRate === null).length).toBeGreaterThan(0);
    expect(view.series.filter((row) => row.firstPrMedianMs !== null).length).toBe(view.timeToFirstPr.count);
    expect(view.intervalMinutes).toBe(5);
  });

  it("F-108/c1: the repo count covers the projects the member can open, or the one project", async () => {
    const { a } = harness.fixture;
    const member = await harness.as(a.member);
    expect((await member.insights.get({ projectId: null, period: PERIOD })).repoCount).toBe(0);
    const world = await seedConnectionAndModel(harness);
    const project = await seedProject(harness, world, "insights-repos");
    expect((await member.insights.get({ projectId: null, period: PERIOD })).repoCount).toBe(1);
    expect((await member.insights.get({ projectId: project.projectId, period: PERIOD })).repoCount).toBe(1);
    expect((await member.insights.get({ projectId: a.openProject.id, period: PERIOD })).repoCount).toBe(0);
  });

  it("F-108/c1: a project's figures cover its own rows only", async () => {
    const { a } = harness.fixture;
    const view = await (await harness.as(a.member)).insights.get({ projectId: a.openProject.id, period: PERIOD });
    const prs = fixture.prs.filter((pr) => pr.projectId === a.openProject.id);
    const items = fixture.items.filter((item) => item.projectId === a.openProject.id);
    expect(view.scope).toEqual({ kind: "project", projectId: a.openProject.id });
    expect(view.prsOpened).toBe(prsOpened(prs, PERIOD_MS));
    expect(view.prsMerged).toBe(prsMerged(prs, PERIOD_MS));
    expect(view.mergeRate).toBe(mergeRate(prs, PERIOD_MS));
    expect(view.timeToFirstPr).toEqual(medianTimeToFirstPr(fixture.tasks.filter((t) => t.projectId === a.openProject.id), prs, PERIOD_MS));
    expect(view.waiting).toMatchObject({ totalMs: timeWaiting(items, PERIOD_MS).totalMs, count: timeWaiting(items, PERIOD_MS).count });
    expect(view.tokens.total.spentMicroUsd).toBe(129_000);
  });

  it("F-108/c1: the merge rate is null, the page's dash, when no PR closed in the period", async () => {
    const view = await (await harness.as(harness.fixture.a.member)).insights.get({ projectId: null, period: { kind: "range", from: "2026-10-07", to: "2026-10-07" } });
    expect(view.prsMerged + view.prsClosedUnmerged).toBe(0);
    expect(view.mergeRate).toBeNull();
    expect(view.timeToFirstPr).toEqual({ medianMs: null, count: 0 });
  });

  it("F-108/c1: a hidden project's name never appears; its share is one line, Other projects", async () => {
    const { a } = harness.fixture;
    const view = await (await harness.as(a.member)).insights.get({ projectId: null, period: PERIOD });
    const text = JSON.stringify(view);
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(a.restrictedProject.id);
    const other = view.tokens.byProject.filter((row) => row.line.kind === "other");
    expect(other).toHaveLength(1);
    expect(other[0]?.spentMicroUsd).toBe(777_000);
    // The organization's totals still count it.
    expect(view.tokens.total.spentMicroUsd).toBe(120_000 + 9_000 + 777_000);
    expect(view.tokens.byProject.at(-1)?.line).toEqual({ kind: "other" });
    // The project's own Insights are NOT_FOUND for that member, and the insider's.
    await expect((await harness.as(a.member)).insights.get({ projectId: a.restrictedProject.id, period: PERIOD })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const insider = await (await harness.as(a.insider)).insights.get({ projectId: a.restrictedProject.id, period: PERIOD });
    expect(insider.prsMerged).toBe(1);
    await expect((await harness.as(harness.fixture.b.admin)).insights.get({ projectId: a.openProject.id, period: PERIOD })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-108/c3: computedAt is the job's last run, and another organization sees none of these rows", async () => {
    const view = await (await harness.as(harness.fixture.a.member)).insights.get({ projectId: null, period: PERIOD });
    expect(view.computedAt).toBe(LAST_RUN.getTime());
    const other = await (await harness.as(harness.fixture.b.admin)).insights.get({ projectId: null, period: PERIOD });
    expect(other).toMatchObject({ prsOpened: 0, computedAt: null, tokens: { total: { spentMicroUsd: 0 } } });
  });

  it("F-108/c3: reads only the job's rows, so a task created since its run changes nothing until it runs again", async () => {
    const { a } = harness.fixture;
    const member = await harness.as(a.member);
    const before = await member.insights.get({ projectId: null, period: PERIOD });
    const late = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, state: "needs_you" });
    await harness.test.db.task.update({ where: { id: late.taskId }, data: { createdAt: new Date("2026-10-03T00:00:00Z") } });
    await harness.test.db.needsYouItem.create({
      data: { organizationId: a.organization.id, projectId: a.openProject.id, taskId: late.taskId, reason: "question", audience: "driver", state: "answered", createdAt: new Date("2026-10-03T00:00:00Z"), resolvedAt: new Date("2026-10-03T05:00:00Z") },
    });
    expect(await member.insights.get({ projectId: null, period: PERIOD })).toEqual(before);
  });

  it("F-108: a preset ends with today, and a period is checked", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const view = await member.insights.get({ projectId: null, period: { kind: "preset", days: 7 } });
    expect(view.period.end).toBe(dayOf(Date.now()) + DAY);
    expect(view.period.end - view.period.start).toBe(7 * DAY);
    await expect(member.insights.get({ projectId: null, period: { kind: "range", from: "2026-10-07", to: "2026-10-01" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(member.insights.get({ projectId: null, period: { kind: "range", from: "2024-01-01", to: "2026-01-01" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
