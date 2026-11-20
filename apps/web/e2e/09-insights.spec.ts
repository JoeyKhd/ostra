import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";

// F-108 (ticket 37): the Insights page shows what `insights.get` returns for the picked period, and
// the period lives in the URL. The seed writes what `insights.compute` and the spend rollup write.

const run = promisify(execFile);

const seedInsights = async (): Promise<void> => {
  const { databaseUrl } = await readStack();
  await run(process.execPath, [path.join(import.meta.dirname, "seed-insights.ts"), JSON.stringify({ databaseUrl })], { cwd: path.resolve(import.meta.dirname, "..") });
};

const figuresSchema = z.object({
  prsOpened: z.number(),
  prsMerged: z.number(),
  prsClosedUnmerged: z.number(),
  mergeRate: z.number().nullable(),
  timeToFirstPr: z.object({ medianMs: z.number().nullable(), count: z.number() }),
  waiting: z.object({ totalMs: z.number(), medianMs: z.number().nullable(), count: z.number() }),
  tokens: z.object({ total: z.object({ spentMicroUsd: z.number() }) }),
  period: z.object({ start: z.number(), end: z.number() }),
});
const responseSchema = z.object({ result: z.object({ data: figuresSchema }) });

/** `insights.get` over HTTP, as the signed-in member. */
const insightsGet = async (page: Page, period: unknown, projectId: string | null = null): Promise<z.infer<typeof figuresSchema>> => {
  const input = encodeURIComponent(JSON.stringify({ projectId, period }));
  const response = await page.request.get(`/api/trpc/insights.get?input=${input}`);
  expect(response.ok()).toBe(true);
  return responseSchema.parse(await response.json()).result.data;
};

/** The page's six figures, by cell. */
const pageFigures = async (page: Page): Promise<Record<string, string>> => {
  const cells = page.getByTestId("insights-figures").locator("[data-figure]");
  await expect(cells.first().getByTestId("figure-value")).toBeVisible();
  const out: Record<string, string> = {};
  for (const cell of await cells.all()) {
    const id = (await cell.getAttribute("data-figure")) ?? "";
    out[id] = `${(await cell.getByTestId("figure-value").textContent()) ?? ""} | ${(await cell.getByTestId("figure-note").textContent()) ?? ""}`;
  }
  return out;
};

const span = (ms: number): string => {
  if (ms <= 0) return "0 min";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${String(Math.max(1, Math.round(minutes)))} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : String(Math.round(hours))} h`;
  return `${(hours / 24).toFixed(1)} d`;
};
const money = (micro: number): string => {
  const dollars = micro / 1_000_000;
  if (dollars === 0) return "$0";
  return dollars >= 100 ? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(dollars))}` : `$${dollars.toFixed(2)}`;
};
const count = (n: number): string => new Intl.NumberFormat("en-US").format(n);

/** What the page must show for `insights.get`'s figures, written out independently of the page's code. */
const expected = (data: z.infer<typeof figuresSchema>): Record<string, string> => {
  const closed = data.prsMerged + data.prsClosedUnmerged;
  return {
    "prs-opened": count(data.prsOpened),
    "prs-merged": count(data.prsMerged),
    "merge-rate": `${data.mergeRate === null ? "—" : `${String(Math.round(data.mergeRate * 100))}%`} | ${closed === 0 ? "No PR closed in this period" : `of ${count(closed)} PRs closed`}`,
    "first-pr": `${data.timeToFirstPr.medianMs === null ? "—" : span(data.timeToFirstPr.medianMs)} | over ${count(data.timeToFirstPr.count)} task${data.timeToFirstPr.count === 1 ? "" : "s"}`,
    waiting: span(data.waiting.totalMs),
    spend: money(data.tokens.total.spentMicroUsd),
  };
};

const expectFiguresEqual = async (page: Page, data: z.infer<typeof figuresSchema>): Promise<void> => {
  const shown = await pageFigures(page);
  for (const [id, want] of Object.entries(expected(data))) {
    // Cells whose note isn't part of `want` compare the figure alone.
    const got = shown[id] ?? "";
    expect(want.includes(" | ") ? got : got.split(" | ")[0]).toBe(want);
  }
};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedInsights();
});

test("F-108/c1: the figures on the page equal insights.get's for the picked period, and changing the period changes the URL and the figures", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/insights");
  await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();
  await expect(page.getByTestId("insights-computed")).toHaveText(/^Computed [34] min ago$/);

  // The default period is 30 days.
  const month = await insightsGet(page, { kind: "preset", days: 30 });
  await expect(page.getByRole("radio", { name: "30 days" })).toHaveAttribute("aria-checked", "true");
  await expectFiguresEqual(page, month);

  // 7 days: the URL changes at once, then the figures.
  await page.getByRole("radio", { name: "7 days" }).click();
  await expect(page).toHaveURL(/\?period=7d$/);
  const week = await insightsGet(page, { kind: "preset", days: 7 });
  expect(week.prsOpened).not.toBe(month.prsOpened);
  await expect(page.getByTestId("insights-figures").locator("[data-figure=prs-opened]").getByTestId("figure-value")).toHaveText(count(week.prsOpened));
  await expectFiguresEqual(page, week);

  // Two dates, picked in the popover.
  const lastDay = new Date(week.period.end - 86_400_000).toISOString().slice(0, 10);
  const firstDay = new Date(week.period.end - 12 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole("radio", { name: "Dates" }).click();
  await page.getByLabel("From", { exact: true }).fill(firstDay);
  await page.getByLabel("To", { exact: true }).fill(lastDay);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?from=${firstDay}&to=${lastDay}$`));
  const range = await insightsGet(page, { kind: "range", from: firstDay, to: lastDay });
  await expect(page.getByTestId("insights-figures").locator("[data-figure=prs-opened]").getByTestId("figure-value")).toHaveText(count(range.prsOpened));
  await expectFiguresEqual(page, range);

  // The URL alone brings the period back: a reload, or a shared link.
  await page.goto("/organization/insights?period=90d");
  await expect(page.getByRole("radio", { name: "90 days" })).toHaveAttribute("aria-checked", "true");
  await expectFiguresEqual(page, await insightsGet(page, { kind: "preset", days: 90 }));
  await expectNoHorizontalScroll(page);
});

const projectsSchema = z.object({ result: z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }) });

test("F-108/c1: a project's Insights show insights.get's figures for that project", async ({ page }) => {
  await signIn(page);
  const listed = projectsSchema.parse(await (await page.request.get("/api/trpc/projects.list")).json()).result.data;
  const project = listed.find((row) => row.name === "insights-b");
  if (project === undefined) throw new Error("the seed's project is missing");
  await page.goto(`/projects/${project.id}/insights?period=7d`);
  await expect(page.getByText("What the agents shipped in insights-b, and what it cost.")).toBeVisible();
  const own = await insightsGet(page, { kind: "preset", days: 7 }, project.id);
  const organization = await insightsGet(page, { kind: "preset", days: 7 });
  expect(own.prsOpened).toBeLessThan(organization.prsOpened);
  await expectFiguresEqual(page, own);
  await expect(page.getByText("By project")).toHaveCount(0);
});

test("F-108/c1: the PR chart has a table view with the same days", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/insights?period=7d");
  await expect(page.getByTestId("pr-chart")).toBeVisible();
  await page.getByRole("button", { name: "Table" }).click();
  await expect(page.getByTestId("pr-table").locator("tbody tr")).toHaveCount(7);
});
