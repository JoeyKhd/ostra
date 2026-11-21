import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { readStack, signIn } from "../helpers.ts";
import { appRoutePatterns, memberRoutes, seedRoutesWorld, settleRoute, sharedRoutes, visitorRoutes } from "../routes.ts";
import type { PanelRoute, RoutesWorld } from "../routes.ts";

// Ticket 19 (F-075): the phone sweep. Every route milestones 1 to 7 built, on a touch phone at
// 390 × 844 (the `phone-sweep` project, playwright.config.ts): the page never scrolls sideways (a
// table or a diff may scroll inside itself), and every control is at least 44 px tall to touch.
// Then the "needs you" moments by tap, from Needs you to the task's new state: approve, answer and
// reopen (milestone 3's `phone-approval` target).

let world: RoutesWorld;

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  world = await seedRoutesWorld(databaseUrl, `sweep-${Date.now().toString(36)}`);
});

/** How far the page scrolls sideways at this width: 0 when it fits. */
const sidewaysOverflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * The controls a finger presses that are under 44 px tall: buttons, links drawn as buttons, fields,
 * selects, tabs and menu triggers. A checkbox, a switch or a radio is pressed through its row,
 * which the label makes the target, so it's measured there. Hidden ones (a closed menu) don't count.
 */
const smallControls = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const selector = [
      "button:not([role=checkbox]):not([role=switch]):not([role=radio])",
      "[data-slot=button]",
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])",
      "select",
      "textarea",
      "[role=tab]",
      "[role=combobox]",
    ].join(",");
    const small: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || element.closest("[aria-hidden=true], [inert]") !== null) continue;
      if (box.height < 43.5) {
        const name = element.getAttribute("aria-label") ?? element.textContent.trim().slice(0, 40);
        small.push(`${element.tagName.toLowerCase()}${element.getAttribute("role") === null ? "" : `[role=${element.getAttribute("role") ?? ""}]`} "${name}" ${String(Math.round(box.height))}px`);
      }
    }
    return small;
  });

type Problem = { readonly route: string; readonly overflow: number; readonly small: readonly string[] };

const sweep = async (page: Page, routes: readonly PanelRoute[]): Promise<Problem[]> => {
  const problems: Problem[] = [];
  for (const route of routes) {
    await page.goto(route.path);
    await settleRoute(page);
    const overflow = await sidewaysOverflow(page);
    const small = await smallControls(page);
    if (overflow > 0 || small.length > 0) problems.push({ route: route.pattern, overflow, small });
  }
  return problems;
};

test("F-075/c1: the sweep names every route of the panel", async () => {
  const named = new Set([...memberRoutes(world), ...sharedRoutes(world), ...visitorRoutes(world)].map((route) => route.pattern));
  expect((await appRoutePatterns()).filter((pattern) => !named.has(pattern))).toEqual([]);
});

test("F-075/c1: no route scrolls sideways at 390 px, and every control is at least 44 px tall to touch", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, world.username);
  const member = await sweep(page, [...memberRoutes(world), ...sharedRoutes(world)]);
  // The pages a visitor opens, signed out.
  await page.context().clearCookies();
  const visitor = await sweep(page, visitorRoutes(world));
  const problems = [...member, ...visitor];
  expect.soft(problems.filter((problem) => problem.overflow > 0), "a route scrolls sideways").toEqual([]);
  expect.soft(problems.filter((problem) => problem.small.length > 0), "a control is under 44 px").toEqual([]);
});

test("F-075/c1: the menu sheet keeps the account menu in reach by tap, at the rail's foot", async ({ page }) => {
  // A small phone, 320 × 568: the rail in the sheet never scrolls, so its foot stays on screen;
  // the panel beside it scrolls on its own (F-147, app-shell.md "Phone").
  await page.setViewportSize({ width: 320, height: 568 });
  await signIn(page, world.username);
  await page.getByRole("button", { name: /^Open navigation/ }).tap();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByTestId("user-menu")).toBeInViewport();
  await drawer.getByTestId("user-menu").tap();
  await page.getByRole("menuitem", { name: "Sign out" }).tap();
  await page.waitForURL(/\/sign-in$/);
});

/** The row of Needs you for a seeded task. */
const needsYouRow = (page: Page, taskId: string) => page.locator(`li[data-notification]`).filter({ has: page.locator(`a[href="/tasks/${taskId}"]`) });

/** The task page's state, once the panel has it. */
const expectTaskState = async (page: Page, taskId: string, state: string): Promise<void> => {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("task-doing")).toHaveAttribute("data-state", state);
};

test("F-075/c1: approve, answer and reopen work by tap from Needs you to the task's new state", async ({ page }) => {
  await signIn(page, world.username);

  // Approve: an approval is open in the list at phone width; one tap on "Approve once".
  await page.goto("/needs-you");
  const approval = needsYouRow(page, world.approval.taskId);
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Approve once" }).tap();
  // Answered, the row leaves the open list (its outcome is under Done).
  await expect(approval.getByRole("button", { name: "Approve once" })).toHaveCount(0);
  await expectTaskState(page, world.approval.taskId, "running");

  // Answer: tap "Answer", which opens the question in a bottom sheet (phone-approval.md), type the
  // answer, tap "Send answer"; the sheet closes once it's answered.
  await page.goto("/needs-you");
  const question = needsYouRow(page, world.question.taskId);
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Answer" }).tap();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Your answer").fill("config/settings.json");
  await sheet.getByRole("button", { name: "Send answer" }).tap();
  await expect(sheet).toHaveCount(0);
  // No runner holds the seeded session, so the answer starts the task's next turn: it queues for one.
  await expectTaskState(page, world.question.taskId, "queued");

  // Reopen: the row opens the task; the composer reopens it with a message.
  await page.goto("/needs-you");
  const reopen = needsYouRow(page, world.reopen.taskId);
  await reopen.getByRole("link", { name: "Open task" }).tap();
  await page.waitForURL((url) => url.pathname === `/tasks/${world.reopen.taskId}`);
  await page.getByLabel("Message the agent").fill("Add a test for the parser too.");
  await page.locator('[data-action="reopen"]').tap();
  await expect(page.getByTestId("task-doing")).toHaveAttribute("data-state", "queued");
  await expectTaskState(page, world.reopen.taskId, "queued");

  // Under Done, the two answers with who gave them.
  await page.goto("/needs-you");
  await page.getByRole("tab", { name: "Done" }).tap();
  const done = page.locator("[data-done-list]");
  await expect(done.locator("li").filter({ hasText: "Add left-pad to the build" })).toContainText("Approved once by");
  await expect(done.locator("li").filter({ hasText: "Pick the config file to change" })).toContainText("Answered by");
});
