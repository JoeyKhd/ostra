import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

import { readStack, signIn } from "../helpers.ts";
import { appRoutePatterns, memberRoutes, seedRoutesWorld, settleRoute, visitorRoutes } from "../routes.ts";
import type { PanelRoute, RoutesWorld } from "../routes.ts";
import { e2eBaseUrl } from "../settings.ts";
import { checkContrast, drawnScheme, overlayClosed, overlayTriggers, prepareA11y, tagOpenOverlay, walkByArrows, walkByTab } from "./checks.ts";

// F-081 (milestone 7, ticket 17): the keyboard walk and the contrast check on every route of the
// panel (the list `routes.ts` keeps, checked against `src/app`), on the routes' seeded world in
// its fullest state, in both themes; the `a11y-desktop` project runs it at 1440 px, `a11y-phone`
// at 390 px (playwright.config.ts). On each route, and in every dialog, sheet, menu and palette
// step it opens:
// - the walk: Tab from the top reaches every visible control once, in document order, each with a
//   2px outline or ring at 3:1, and comes back round (no trap); in a dialog the focus stays inside;
//   Escape closes it and gives the focus back to its trigger;
// - the contrast: every visible text node at 4.5:1 (3:1 when large), placeholders too, and the edges
//   of fields and buttons at 3:1; disabled controls are listed, not failed.
// Each failure names the route, the theme, the element's role and text, and the ratio.

type Theme = "dark" | "light";

/**
 * An overlay a route opens by keys of its own (no trigger to press): the palette, its step, the `?`
 * sheet. `escapes`: the palette's step goes back a step on Escape, so it closes on the second.
 */
type KeyedOverlay = { readonly name: string; readonly open: (page: Page) => Promise<void>; readonly escapes?: number };

/** One visit: a route, or a route in another state (a task waiting on an approval), with the keyed overlays it opens. */
type Visit = PanelRoute & { readonly label: string; readonly keyed: readonly KeyedOverlay[] };

const palette: KeyedOverlay = {
  name: "the ⌘K palette",
  open: async (page) => {
    await page.keyboard.press("Control+KeyK");
    // Typed keys go to the palette once its field has the focus, as a member sees it.
    await expect(page.getByTestId("search-palette").getByRole("combobox")).toBeFocused();
  },
};
const paletteStep: KeyedOverlay = {
  name: "the palette's Approve… step",
  escapes: 2,
  open: async (page) => {
    await palette.open(page);
    await page.keyboard.type("approve");
    await expect(page.getByTestId("palette-action").first()).toHaveAttribute("data-action", "approve");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("search-palette")).toHaveAttribute("data-step", "approve-pick");
  },
};
const sheet: KeyedOverlay = {
  name: "the ? sheet",
  open: async (page) => {
    await page.keyboard.press("Shift+Slash");
    await page.getByTestId("shortcut-sheet").waitFor();
  },
};

/** The overlays opened by keys, beside the routes that open them; triggers are found on every route. */
const keyedOverlays: Readonly<Record<string, readonly KeyedOverlay[]>> = {
  "/": [palette, sheet],
  "/needs-you": [palette, paletteStep],
  "/tasks/[task-id]": [palette],
};

/** Every route, and the task page in each "needs you" state: an approval card, a question's form, a spend cap. */
const visits = (world: RoutesWorld): { readonly member: readonly Visit[]; readonly visitor: readonly Visit[] } => {
  const visit = (route: PanelRoute, label = route.pattern): Visit => ({ ...route, label, keyed: label === route.pattern ? (keyedOverlays[route.pattern] ?? []) : [] });
  const task = "/tasks/[task-id]";
  return {
    member: [
      ...memberRoutes(world).map((route) => visit(route)),
      visit({ pattern: task, path: `/tasks/${world.approval.taskId}` }, `${task} (an approval)`),
      visit({ pattern: task, path: `/tasks/${world.question.taskId}` }, `${task} (a question)`),
      visit({ pattern: task, path: `/tasks/${world.capped.taskId}` }, `${task} (a spend cap)`),
    ],
    visitor: visitorRoutes(world).map((route) => visit(route)),
  };
};

type Report = { walk: string[]; contrast: string[]; disabled: string[] };

/** Opens one overlay, checks it, closes it with Escape, and checks the focus went back. */
const checkOverlay = async (page: Page, where: string, report: Report, open: () => Promise<void>, trigger: string | null, escapes = 1): Promise<void> => {
  await open();
  const kind = await tagOpenOverlay(page);
  if (kind === null) {
    report.walk.push(`${where}: pressing Enter on it opens nothing`);
    return;
  }
  const scope = "[data-a11y-overlay]";
  const contrast = await checkContrast(page, scope);
  report.contrast.push(...contrast.failures.map((failure) => `${where}: ${failure}`));
  report.disabled.push(...contrast.disabled.map((line) => `${where}: ${line}`));
  const walk = kind === "menu" ? await walkByArrows(page, scope) : await walkByTab(page, scope);
  report.walk.push(...walk.map((problem) => `${where}: ${problem}`));
  for (let press = 0; press < escapes; press += 1) await page.keyboard.press("Escape");
  if (!(await overlayClosed(page))) {
    report.walk.push(`${where}: Escape doesn't close it`);
    // Close whatever is left, for the next check.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    return;
  }
  if (trigger !== null) {
    // Radix gives the focus back a tick after the overlay goes.
    const back = await page
      .waitForFunction((id) => (document.activeElement?.closest(`[data-a11y-trigger="${id}"]`) ?? null) !== null, trigger, { timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!back) report.walk.push(`${where}: closed, the focus doesn't go back to its trigger`);
  }
};

const checkVisit = async (page: Page, visit: Visit, theme: Theme, report: Report): Promise<void> => {
  const at = `${visit.label} (${theme})`;
  await page.goto(visit.path);
  await settleRoute(page);
  const scheme = await drawnScheme(page);
  if (scheme !== theme) {
    report.contrast.push(`${at}: drawn in the ${scheme || "unknown"} theme, not ${theme}`);
    return;
  }
  const contrast = await checkContrast(page, null);
  report.contrast.push(...contrast.failures.map((failure) => `${at}: ${failure}`));
  report.disabled.push(...contrast.disabled.map((line) => `${at}: ${line}`));
  report.walk.push(...(await walkByTab(page, null)).map((problem) => `${at}: ${problem}`));

  // Every overlay a trigger on the page opens, by the keyboard: the focus on it, then Enter.
  const settled = new URL(page.url()).pathname;
  const triggers = await overlayTriggers(page);
  for (const trigger of triggers) {
    const present = await page.locator(`[data-a11y-trigger="${trigger.id}"]`).count();
    if (present === 0) continue;
    await checkOverlay(page, `${at} > ${trigger.name}`, report, async () => {
      await page.locator(`[data-a11y-trigger="${trigger.id}"]`).focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
    }, trigger.id);
    if (new URL(page.url()).pathname !== settled) {
      report.walk.push(`${at} > ${trigger.name}: Enter left the page`);
      await page.goto(visit.path);
      await settleRoute(page);
      await overlayTriggers(page);
    }
  }
  for (const overlay of visit.keyed) {
    await page.locator("body").focus();
    await checkOverlay(page, `${at} > ${overlay.name}`, report, () => overlay.open(page), null, overlay.escapes);
  }
};

/**
 * The member's theme, saved through the panel's own API (account.setTheme), as the theme menu saves
 * it. First the panel's own write settles: signed in on a new browser, it writes the account's
 * theme into the cookie (ticket 18), which would race this one.
 */
const chooseTheme = async (page: Page, theme: Theme): Promise<void> => {
  await page.waitForLoadState("networkidle");
  const response = await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } });
  expect(response.ok(), `account.setTheme answered ${String(response.status())}`).toBe(true);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

let world: RoutesWorld;

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  world = await seedRoutesWorld(databaseUrl, `a11y-${Date.now().toString(36)}`);
});

test.beforeEach(async ({ page }) => {
  await prepareA11y(page);
});

test("F-081: the walk and the contrast check name every route of the panel", async () => {
  const { member, visitor } = visits(world);
  const named = new Set([...member, ...visitor].map((visit) => visit.pattern));
  expect((await appRoutePatterns()).filter((pattern) => !named.has(pattern)), "a route of src/app the checks don't open").toEqual([]);
});

/** Every route and every overlay it opens, in one theme: the walk's and the contrast check's failures, each failing the test. */
const checkEverything = async (page: Page, theme: Theme, testInfo: TestInfo): Promise<void> => {
  const report: Report = { walk: [], contrast: [], disabled: [] };
  const { member, visitor } = visits(world);
  await signIn(page, world.username);
  await chooseTheme(page, theme);
  for (const visit of member) await checkVisit(page, visit, theme, report);
  // The pages a visitor opens, signed out, in the theme the browser's cookie holds.
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "ostra-theme", value: theme, url: e2eBaseUrl }]);
  for (const visit of visitor) await checkVisit(page, visit, theme, report);
  await testInfo.attach("listed, not failed: disabled controls and text over a picture", { body: report.disabled.join("\n") || "none", contentType: "text/plain" });
  expect.soft(report.walk, "the keyboard walk").toEqual([]);
  expect.soft(report.contrast, "the contrast check").toEqual([]);
};

test("F-081: the keyboard walk and the contrast check pass on every route, dialog, menu and palette step, dark theme", async ({ page }, testInfo) => {
  test.setTimeout(1_500_000);
  await checkEverything(page, "dark", testInfo);
});

test("F-081: the keyboard walk and the contrast check pass on every route, dialog, menu and palette step, light theme", async ({ page }, testInfo) => {
  test.setTimeout(1_500_000);
  await checkEverything(page, "light", testInfo);
});
