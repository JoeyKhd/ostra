import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { checkContrast, prepareA11y, walkByTab } from "./a11y/checks.ts";
import { readStack, signIn } from "./helpers.ts";
import { memberRoutes, seedRoutesWorld, settleRoute } from "./routes.ts";
import type { RoutesWorld } from "./routes.ts";
import { e2eBaseUrl } from "./settings.ts";
import { contextPanel, isPhoneWidth, menuButton, navSheet, openNavSheet, rail, railSpace } from "./shell.ts";
import type { RailSpace } from "./shell.ts";

// F-147 (milestone 8, ticket 10; brand/app-targets/m8/app-shell.md): the double sidebar. The rail
// of spaces and the open space's context panel at 1440px, every route reached through them, the
// collapse kept over a reload with no flash, the peek, the keyboard, and at 390px the top bar's
// menu sheet that holds them both. The rules alone are unit tests (`shell.test.tsx`).

let world: RoutesWorld;

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  world = await seedRoutesWorld(databaseUrl, `shell-${Date.now().toString(36)}`);
});

/** The rail's names of the spaces the shell draws in `data-place`. */
const spaceName: Readonly<Record<string, RailSpace>> = { home: "Home", "needs-you": "Needs you", projects: "Projects", organization: "Organization", settings: "Settings" };

/** The page's place as the shell drew it: its space (`none` for a page with no place) and its panel row. */
const placeOnPage = async (page: Page): Promise<{ readonly space: string; readonly row: string }> => {
  const panel = page.getByTestId("context-panel");
  return { space: (await panel.getAttribute("data-place")) ?? "none", row: (await panel.getAttribute("data-place-row")) ?? "" };
};

const chooseTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  await page.waitForLoadState("networkidle");
  const response = await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } });
  expect(response.ok(), `account.setTheme answered ${String(response.status())}`).toBe(true);
};

test.describe("at 1440px", { tag: "@desktop-only" }, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("F-147/c1: the rail lights the open space, and its panel lists that space's pages for the member's role", async ({ page, browser }) => {
    await signIn(page, world.username);
    await expect(rail(page)).toBeVisible();
    await expect(railSpace(page, "Home")).toHaveAttribute("aria-current", "page");
    for (const row of ["Overview", "Board", "All tasks"]) await expect(contextPanel(page).getByRole("link", { name: row, exact: true })).toBeVisible();

    await page.goto(`/projects/${world.projectId}`);
    await expect(railSpace(page, "Projects")).toHaveAttribute("aria-current", "page");
    for (const row of ["Tasks", "Needs approval", "Inbox", "Boards", "Environment", "Automations", "Memory", "Insights", "Settings"]) {
      await expect(contextPanel(page).getByRole("link", { name: new RegExp(`^${row}`) }).first()).toBeVisible();
    }
    await expect(contextPanel(page).getByRole("link", { name: /^Repos/ })).toHaveCount(0);
    // Its live tasks: what needs the member first, each opening the task.
    await expect(contextPanel(page).locator(`[data-live-task="${world.approval.taskId}"]`)).toBeVisible();

    await railSpace(page, "Organization").click();
    await page.waitForURL(/\/organization\/insights$/);
    const adminRows = ["Insights", "Spend", "Memory", "Runners", "Box sizes", "Registry", "Agent profiles", "Models", "GitHub", "Linear", "Members", "Audit log", "Accounts", "Storage", "Email"];
    for (const row of adminRows) await expect(contextPanel(page).getByRole("link", { name: row, exact: true })).toBeVisible();

    // A member who isn't an admin: only their rows, and the groups left empty are hidden.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const member = await context.newPage();
    await signIn(member, world.memberUsername);
    await railSpace(member, "Organization").click();
    await member.waitForURL(/\/organization\/insights$/);
    const shown = await contextPanel(member).getByRole("link").evaluateAll((links) => links.map((link) => link.textContent.trim()));
    expect(shown).toEqual(["Insights", "Memory", "Runners", "Box sizes", "Agent profiles", "Members"]);
    await expect(contextPanel(member).getByText("Connections", { exact: true })).toHaveCount(0);
    await context.close();
  });

  test("F-147/c3: every route of the panel is reachable through the rail and the context panel, and lights its place", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, world.username);
    // First each page itself: it has a place (a page with none fails here), its space is lit in the
    // rail, and its row, where it has one, is marked as the page in the panel.
    const rows = new Map<string, RailSpace>();
    for (const route of memberRoutes(world)) {
      await page.goto(route.path);
      await settleRoute(page);
      const place = await placeOnPage(page);
      expect(place.space, `${route.pattern} has no place in the rail and the panel`).not.toBe("none");
      const space = spaceName[place.space];
      if (space === undefined) throw new Error(`${route.pattern}: an unknown space ${place.space}`);
      await expect(railSpace(page, space), route.pattern).toHaveAttribute("aria-current", "page");
      if (place.row === "") continue;
      const current = contextPanel(page).locator("[aria-current='page']").first();
      await expect(current, `${route.pattern}: no row of the panel is the page`).toBeVisible();
      const href = await current.getAttribute("href");
      if (href !== null && !href.startsWith("/tasks/")) rows.set(href, space);
    }
    // Then each row through the shell alone: from another space, its space in the rail, then its row.
    for (const [href, space] of rows) {
      await page.goto(space === "Home" ? "/needs-you" : "/search");
      await settleRoute(page);
      await railSpace(page, space).click();
      await expect(railSpace(page, space)).toHaveAttribute("aria-current", "page");
      await contextPanel(page).locator(`a[href="${href}"]`).first().click();
      await page.waitForURL((at) => `${at.pathname}${at.search}`.startsWith(href), { timeout: 15_000 });
    }
    expect(rows.size).toBeGreaterThan(25);
  });

  test("F-147/c2: `[` collapses the panel, a reload keeps it with no flash, a rest on a space peeks, and the peek docks it again", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto(`/projects/${world.projectId}`);
    const panel = page.getByTestId("context-panel");
    await expect(panel).toHaveAttribute("data-collapsed", "false");
    await page.locator("body").focus();
    await page.keyboard.press("[");
    await expect(panel).toHaveAttribute("data-collapsed", "true");
    await expect(panel).toHaveAttribute("inert", "");

    // The server draws it collapsed from the cookie: the first frame has no panel to hide.
    const served = await page.request.get(`/projects/${world.projectId}`);
    expect(await served.text()).toMatch(/data-testid="context-panel" data-collapsed="true"/);
    await page.reload();
    await expect(panel).toHaveAttribute("data-collapsed", "true");
    expect(await panel.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);
    await expect(page.getByTestId("show-sidebar")).toBeVisible();

    // A mouse resting on a space shows its panel over the page; moving off closes it.
    await railSpace(page, "Organization").hover();
    const peek = page.locator("[data-shell-peek='organization']");
    await expect(peek).toBeVisible();
    await expect(peek.getByRole("link", { name: "Members", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await railSpace(page, "Home").hover();
    await expect(page.locator("[data-shell-peek='home']")).toBeVisible();
    await page.mouse.move(900, 600);
    await expect(page.locator("[data-shell-peek]")).toHaveCount(0);

    // Keep it open: the peek's last button docks the panel, and that choice is kept too.
    await railSpace(page, "Organization").hover();
    await peek.getByRole("button", { name: "Keep it open · [" }).click();
    await expect(panel).toHaveAttribute("data-collapsed", "false");
    await page.reload();
    await expect(panel).toHaveAttribute("data-collapsed", "false");
    expect(await panel.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(240);
  });

  test("F-147/c4: ⌘K, `g h`, `g n`, `?` and `c` work as before, and the ? sheet lists `[`, `g p` and `g o`", async ({ page }) => {
    await signIn(page, world.username);
    await page.keyboard.press("Control+KeyK");
    await expect(page.getByTestId("search-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("n");
    await page.waitForURL(/\/needs-you$/);
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await page.waitForURL((url) => url.pathname === "/");
    await page.keyboard.press("Shift+Slash");
    const sheet = page.getByTestId("shortcut-sheet");
    await expect(sheet.locator("[data-sheet-line='toggle-sidebar']")).toHaveAttribute("data-keys", "[");
    await expect(sheet.locator("[data-sheet-line='go-projects']")).toHaveAttribute("data-keys", "g p");
    await expect(sheet.locator("[data-sheet-line='go-organization']")).toHaveAttribute("data-keys", "g o");
    await page.keyboard.press("Escape");
    await page.keyboard.press("c");
    await page.waitForURL(/\/tasks\/new$/);
  });

  test("F-147/c5: the rail is one tab stop with arrow keys, the panel's rows take ↑ and ↓, and Tab goes rail, panel, page", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto(`/projects/${world.projectId}`);
    await settleRoute(page);
    await page.locator("body").focus();
    await page.keyboard.press("Tab");
    // The rail's stop is the open space.
    await expect(railSpace(page, "Projects")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(railSpace(page, "Organization")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rail(page).getByRole("button", { name: /^Switch organization/ })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByTestId("user-menu").filter({ visible: true })).toBeFocused();
    // Tab leaves the rail for the panel: its project switcher, then its head's buttons, then its rows.
    await page.keyboard.press("Tab");
    await expect(contextPanel(page).getByRole("button", { name: /^Switch project/ })).toBeFocused();
    const tasks = contextPanel(page).getByRole("link", { name: /^Tasks/ }).first();
    await tasks.focus();
    await page.keyboard.press("ArrowDown");
    await expect(contextPanel(page).getByRole("link", { name: /^Needs approval/ })).toBeFocused();
  });

  test("F-147/c7: the shell is drawn at the approved targets' sizes", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto(`/projects/${world.projectId}`);
    await settleRoute(page);
    const size = async (selector: string) => page.locator(selector).first().evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [Math.round(box.width), Math.round(box.height)];
    });
    // app-shell.md, "Layout": rail 64 | panel 240 | page; the tile 40, New task 32, a space 54×50.
    expect((await size("[data-shell-rail]"))[0]).toBe(64);
    expect((await size("[data-testid='context-panel']"))[0]).toBe(240);
    expect(await size("[data-shell-rail] [aria-label^='Switch organization']")).toEqual([40, 40]);
    expect(await size("[data-shell-rail] a[href='/tasks/new']")).toEqual([32, 32]);
    expect(await size("[data-shell-rail] [data-space='projects']")).toEqual([54, 50]);
    // The panel's head is level with the page's 46px top bar, and a row is 28px.
    expect((await size("[data-shell-panel='docked'] > div"))[1]).toBe(46);
    expect((await size("header"))[1]).toBe(46);
    expect((await size("[data-shell-panel='docked'] a[aria-current='page']"))[1]).toBe(28);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`F-147/c5: the shell passes the keyboard walk and the contrast check at 1440px, ${theme} theme`, async ({ page }) => {
      test.setTimeout(180_000);
      await prepareA11y(page);
      await signIn(page, world.username);
      await chooseTheme(page, theme);
      const problems: string[] = [];
      for (const path of ["/", `/projects/${world.projectId}`, "/organization/members", `/tasks/${world.approval.taskId}`]) {
        await page.goto(path);
        await settleRoute(page);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        problems.push(...(await checkContrast(page, "[data-shell-rail]")).failures.map((line) => `${path} rail: ${line}`));
        problems.push(...(await checkContrast(page, "[data-shell-panel='docked']")).failures.map((line) => `${path} panel: ${line}`));
        problems.push(...(await walkByTab(page, null)).map((line) => `${path}: ${line}`));
      }
      // The peek, over a collapsed panel.
      await page.locator("body").focus();
      await page.keyboard.press("[");
      await railSpace(page, "Organization").hover();
      await page.locator("[data-shell-peek]").waitFor();
      problems.push(...(await checkContrast(page, "[data-shell-peek]")).failures.map((line) => `peek: ${line}`));
      await page.keyboard.press("Escape");
      await page.keyboard.press("[");
      expect(problems).toEqual([]);
    });
  }
});

test.describe("at 390px", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("F-147/c6: the menu sheet opens with the rail and the panel, traps the focus, and closes on Escape, a tap outside and a chosen page, with the focus back on the menu button", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto(`/projects/${world.projectId}`);
    await settleRoute(page);
    expect(isPhoneWidth(page)).toBe(true);
    // No rail and no tab bar on the page: the top bar's menu button, with its amber dot.
    await expect(rail(page)).toHaveCount(0);
    await expect(page.getByTestId("menu-needs-you-dot")).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-label", /^Open navigation, \d+ need you$/);

    await openNavSheet(page);
    const sheet = navSheet(page);
    // The page behind is hidden from assistive tech while the sheet is open: the button by its mark.
    await expect(page.locator("[data-shell-menu-button]")).toHaveAttribute("aria-expanded", "true");
    expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(334);
    await expect(sheet.getByRole("navigation", { name: "Spaces" })).toBeVisible();
    await expect(sheet.locator("[data-shell-panel='sheet']")).toBeVisible();
    // The focus starts on the page's row, and Tab never leaves the sheet.
    await expect(sheet.locator("[data-shell-panel='sheet'] [aria-current='page']").first()).toBeFocused();
    for (let press = 0; press < 30; press += 1) {
      await page.keyboard.press("Tab");
      expect(await sheet.evaluate((root) => root.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();

    // Escape closes it from the rail too, where a desktop item would show its tooltip.
    await openNavSheet(page);
    await sheet.getByRole("link", { name: /^Home/ }).focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();

    // A tap outside, on the page's strip to the right of the sheet.
    await openNavSheet(page);
    await page.mouse.click(370, 400);
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();

    // A chosen page: Inbox in the panel, then a space in the rail.
    await openNavSheet(page);
    await sheet.getByRole("link", { name: /^Inbox/ }).click();
    await page.waitForURL(new RegExp(`/projects/${world.projectId}/inbox$`));
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
    await openNavSheet(page);
    await sheet.getByRole("link", { name: /^Organization/ }).click();
    await page.waitForURL(/\/organization\/insights$/);
    await expect(sheet).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
  });

  test("F-147/c7: at 390px the top bar is 54px, the menu button 44px, and the sheet 334px with 44px rows", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto(`/projects/${world.projectId}`);
    await settleRoute(page);
    const box = async (target: ReturnType<Page["locator"]>) => {
      const found = await target.boundingBox();
      return [Math.round(found?.width ?? 0), Math.round(found?.height ?? 0)];
    };
    expect((await box(page.locator("header").first()))[1]).toBe(54);
    expect(await box(menuButton(page))).toEqual([44, 44]);
    await openNavSheet(page);
    expect((await box(navSheet(page)))[0]).toBe(334);
    expect((await box(navSheet(page).locator("[data-shell-panel='sheet'] a[aria-current='page']").first()))[1]).toBe(44);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`F-147/c5: the top bar and the menu sheet pass the keyboard walk and the contrast check at 390px, ${theme} theme`, async ({ page }) => {
      await prepareA11y(page);
      await signIn(page, world.username);
      await chooseTheme(page, theme);
      await page.goto(`/projects/${world.projectId}`);
      await settleRoute(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const problems = [...(await checkContrast(page, "header")).failures];
      await openNavSheet(page);
      await page.evaluate(() => document.querySelector("[role='dialog']")?.setAttribute("data-a11y-overlay", ""));
      problems.push(...(await checkContrast(page, "[data-a11y-overlay]")).failures);
      problems.push(...(await walkByTab(page, "[data-a11y-overlay]")));
      expect(problems).toEqual([]);
    });
  }
});
