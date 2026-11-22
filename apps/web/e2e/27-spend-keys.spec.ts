import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { checkContrast, prepareA11y, walkByTab } from "./a11y/checks.ts";
import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eBaseUrl } from "./settings.ts";

// F-135/c13 (spend-keys.md, ADR 0055 "Spend per key"): Organization › Spend's Keys, between Projects
// and Models: every key with its month, one that spent nothing at $0.00, a key with unpriced tokens
// marked, and the key's month in the panel a row opens. The world is `seed-spend-keys-world.ts`'s:
// four keys, five projects and their spend in the rollup. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets (app-targets/m10-gaps/spend-keys*), at their sizes in both
// themes; that run seeds the targets' own demo world (Acme Corp), so it runs on a stack of its own.

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");
const shots = process.env["OSTRA_E2E_SHOTS"];
/**
 * For the shots only: a folder of models.dev's logos (`anthropic.svg`, …) put where the panel keeps
 * the ones it fetched, since the stack fetches none (`OSTRA_CATALOG_FETCH=false`).
 */
const logos = process.env["OSTRA_E2E_LOGOS"];

const worldSchema = z.object({
  keys: z.object({ acme: z.string(), northwind: z.string(), globex: z.string(), spare: z.string() }),
  projects: z.object({ billing: z.string(), calculator: z.string(), portal: z.string(), shop: z.string(), pipeline: z.string() }),
  sqlCoder: z.string(),
});
type World = z.infer<typeof worldSchema>;

const seed = async (options: { readonly demo?: boolean; readonly spent?: boolean } = {}): Promise<World> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-spend-keys-world.ts"), JSON.stringify({ databaseUrl, ...options })], { cwd });
  return worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date());
const OURS = ["acme-anthropic", "northwind-anthropic", "globex-openrouter", "spare-openai"];

/** The keys' rows in the page's order, ours only (other specs' keys share the stack). */
const keyOrder = async (page: Page): Promise<string[]> =>
  (await page.locator("[data-testid='spend-keys'] tr[data-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-key") ?? ""))).filter((name) => OURS.includes(name));

test.describe.configure({ mode: "serial" });

test("F-135/c13: Spend lists every key between Projects and Models with its month, one that spent nothing at $0.00, and a row opens the key's month in the panel", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop table and its panel");
  test.setTimeout(120_000);
  await signIn(page);
  const world = await seed();
  await page.goto("/organization/spend");
  await expect(page.getByRole("heading", { level: 1, name: "Spend" })).toBeVisible();

  // Keys sits between Projects and Models, one row per key, highest first and ties by name.
  const headings = await page.locator("main section h2").allTextContents();
  expect(headings.indexOf("Keys")).toBeGreaterThan(headings.indexOf("Projects"));
  expect(headings.indexOf("Keys")).toBeLessThan(headings.indexOf("Models"));
  const table = page.getByTestId("spend-keys");
  await expect(table.locator("tr[data-key='spare-openai']")).toBeVisible();
  expect(await keyOrder(page)).toEqual(OURS);

  // Each key's month: its four token kinds and its spend; one that spent nothing at $0.00.
  const acme = table.locator("tr[data-key='acme-anthropic']");
  // The Key cell holds the host too, shown only where the column has room; the sum folds below 1100px.
  await expect(acme.locator("td")).toHaveText([/^acme-anthropic/, "52.1M", "4.8M", "65.3M", "6.2M", "128.4M", "$1,170.85"]);
  await expect(acme.locator("td").first()).toHaveAttribute("title", "api.anthropic.com");
  await expect(table.locator("tr[data-key='northwind-anthropic'] [data-testid='key-spent']")).toHaveText("$412.80");
  const spare = table.locator("tr[data-key='spare-openai']");
  await expect(spare.getByTestId("key-spent")).toHaveText("$0.00");
  await expect(spare.locator("td").nth(1)).toHaveText("–");
  // A key with unpriced tokens says so on its figure.
  await expect(table.locator("tr[data-key='globex-openrouter'] [data-testid='key-unpriced'] svg")).toHaveAttribute("aria-label", "3.4M tokens on acme/sql-coder-ft have no price and aren't in this figure");
  await expect(table.locator("tr[data-key='globex-openrouter'] [data-testid='key-spent']")).toHaveText("$258.52");

  // A row selects its key: the panel holds the key's month, the models it served, the projects on it.
  await table.locator("tr[data-key='northwind-anthropic']").click();
  await expect(page).toHaveURL(new RegExp(`[?&]provider=${world.keys.northwind}`));
  await expect(table.locator("tr[data-key='northwind-anthropic']")).toHaveAttribute("aria-pressed", "true");
  const panel = page.getByTestId("key-panel");
  await expect(panel).toContainText("Key");
  await expect(panel.getByRole("heading", { name: "northwind-anthropic" })).toBeVisible();
  await expect(panel).toContainText("api.anthropic.com · Anthropic Messages");
  await expect(panel).toContainText(MONTH);
  await expect(panel.getByTestId("key-panel-spent")).toHaveText("$412.80");
  await expect(panel).toContainText(/\d+% of the organization's/);
  await expect(panel.getByTestId("key-panel-tasks")).toHaveText("3");
  await expect(panel.getByTestId("key-panel-models").locator("li")).toHaveText(["Claude Opus 5.5$270.25", "Claude Sonnet 5.5$142.55"]);
  await expect(panel.getByTestId("key-panel-projects").locator("li")).toHaveText(["northwind-portalown list · $412.80"]);
  await expect(panel.getByTestId("key-panel-budgets")).toHaveText("Budgets stay per project: northwind-portal's is $800.00. A key has no budget of its own.");
  await expect(panel.getByRole("button")).toHaveCount(0);

  // A key with unpriced tokens, chosen from the keyboard: the row in the panel, and "Enter its price."
  // opens the model's price form.
  await table.locator("tr[data-key='globex-openrouter']").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`[?&]provider=${world.keys.globex}`));
  await expect(panel.getByTestId("key-panel-unpriced")).toHaveText("acme/sql-coder-ft has no price, so its tokens aren't in $258.52. Enter its price.");
  await expect(panel).toContainText("Unpriced3.4M tokens");
  await expect(panel.getByTestId("key-panel-models").locator("li")).toHaveText(["GPT-6.2 Sol$188.60", "DeepSeek V4 Flash$69.92", "acme/sql-coder-ftNo price"]);
  await panel.getByRole("button", { name: "Enter its price." }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]model=${world.sqlCoder}`));
  await expect(page.getByTestId("price-form")).toContainText("acme/sql-coder-ft");

  // A key nothing uses: no project, nothing spent, and still no budget of its own.
  await table.locator("tr[data-key='spare-openai']").click();
  await expect(panel).toContainText("On no list. Nothing uses it.");
  await expect(panel).toContainText(`Nothing ran on this key in ${MONTH}.`);
  await expect(panel.getByTestId("key-panel-budgets")).toHaveText("A key has no budget of its own.");

  // The key on Models: Models opens with that key selected.
  await table.locator("tr[data-key='northwind-anthropic']").click();
  await panel.getByRole("link", { name: "The key on Models" }).click();
  await page.waitForURL((url) => url.pathname === "/organization/models" && url.searchParams.get("provider") === world.keys.northwind);
  await expect(page.getByTestId("provider-settings")).toContainText("northwind-anthropic");
});

test("F-135/c13: at phone width each key is a two-line row, and a tap opens its month in a bottom sheet", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the phone's rows");
  await signIn(page);
  await seed();
  await page.goto("/organization/spend");
  const rows = page.getByTestId("spend-keys-narrow");
  await expect(rows.locator("button", { hasText: "northwind-anthropic" })).toContainText("api.anthropic.com · 46.9M tokens");
  await expect(rows.locator("button", { hasText: "spare-openai" })).toContainText("$0.00");
  await expect(rows.locator("button", { hasText: "spare-openai" })).toContainText("api.openai.com · nothing this month");
  await expectNoHorizontalScroll(page);
  await rows.locator("button", { hasText: "northwind-anthropic" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByTestId("key-panel")).toContainText("northwind-anthropic");
  await expect(sheet.getByTestId("key-panel-spent")).toHaveText("$412.80");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("F-081/c2: the Keys section and a key's panel pass the keyboard walk and the contrast check in both themes", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop table and its panel");
  test.setTimeout(120_000);
  await prepareA11y(page);
  await signIn(page);
  const world = await seed();
  const problems: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
    await page.goto(`/organization/spend?provider=${world.keys.globex}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("key-panel")).toBeVisible();
    await settleRoute(page);
    problems.push(...(await checkContrast(page, null)).failures.map((failure) => `${theme}: ${failure}`));
    problems.push(...(await walkByTab(page, null)).map((problem) => `${theme}: ${problem}`));
  }
  expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme: "dark" }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
  expect(problems).toEqual([]);
});

// ── The side-by-side shots (OSTRA_E2E_SHOTS): the targets' demo world, at their sizes ────────────

const shoot = async (page: Page, name: string, target: { readonly locator?: string } = {}): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(150);
    const file = path.join(shots, `${name}-${theme}.png`);
    if (target.locator === undefined) await page.screenshot({ path: file, scale: "css" });
    else await page.locator(target.locator).first().screenshot({ path: file, scale: "css" });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

test("the targets' shots: a key selected, its states and the phone", async ({ page, isMobile }) => {
  test.skip(shots === undefined, "OSTRA_E2E_SHOTS names the folder for the side-by-side shots");
  test.setTimeout(240_000);
  const { dataDir } = await readStack();
  if (logos !== undefined && dataDir !== null) await cp(logos, path.join(dataDir, "model-logos"), { recursive: true });
  await signIn(page);
  const world = await seed({ demo: true });
  const keysSection = "main section:has(h2:text-is('Keys'))";
  if (isMobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/organization/spend");
    await expect(page.getByTestId("spend-keys-narrow")).toBeVisible();
    await page.evaluate(() => {
      const heading = [...document.querySelectorAll("main section h2")].find((node) => node.textContent === "Keys");
      if (heading !== undefined) window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 155);
    });
    await shoot(page, "spend-keys-phone");
    return;
  }
  // A key selected (spend-keys, spend-keys-light), at 1440 × 956.
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.goto(`/organization/spend?provider=${world.keys.northwind}`);
  await expect(page.getByTestId("key-panel")).toContainText("northwind-anthropic");
  await shoot(page, "spend-keys");
  // The states: a key with unpriced tokens selected, nothing selected, below 1100px, a past month.
  await page.goto(`/organization/spend?provider=${world.keys.globex}`);
  await expect(page.getByTestId("key-panel-unpriced")).toBeVisible();
  await shoot(page, "state-unpriced", { locator: "[data-testid='spend-panel']" });
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  await page.goto(`/organization/spend?month=${lastMonth}`);
  await expect(page.locator(keysSection)).toContainText("acme-anthropic");
  await shoot(page, "state-past-month", { locator: keysSection });
  await page.setViewportSize({ width: 1099, height: 956 });
  await page.goto(`/organization/spend?provider=${world.keys.northwind}`);
  await expect(page.locator(keysSection)).toContainText("Tokens");
  await page.keyboard.press("Escape");
  await shoot(page, "state-below-1100", { locator: keysSection });
  await page.setViewportSize({ width: 1440, height: 956 });
  // Loading: the keys' providers held back, so the section draws its bars.
  await page.route("**/api/trpc/**providers.list**", () => undefined);
  await page.goto("/organization/spend");
  await expect(page.getByTestId("spend-keys-loading")).toBeVisible();
  await shoot(page, "state-loading", { locator: keysSection });
  await page.unroute("**/api/trpc/**providers.list**");
  // Nothing spent yet this month: every key at $0.00, by name; with no budget reached, nothing is selected.
  await seed({ demo: true, spent: false });
  await page.goto("/organization/spend");
  await expect(page.getByTestId("spend-keys-idle")).toBeVisible();
  await shoot(page, "state-nothing-spent", { locator: keysSection });
  await expect(page.getByTestId("spend-hint")).toBeVisible();
  await shoot(page, "state-nothing-selected", { locator: "[data-testid='spend-panel']" });
});
