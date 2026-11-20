import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { m4World, seedM4World, shoot, shootPhone } from "./m4.ts";

// F-073 (ticket 34): the audit log and the task's event log, on the seeded m4calc world (seed-m4.ts):
// two `task.created` entries, one by the admin and one by the member, and the admin's task's log with a
// failed `pnpm test -- history` in a long folder.

/** A CSV body as rows of fields: every field quoted, `""` for a quote. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows;
};

const pick = async (page: Page, filter: string, option: string): Promise<void> => {
  await page.getByTestId(`audit-filter-${filter}`).getByRole("button").first().click();
  await page.getByRole("listbox", { name: filter === "actor" ? "Actor" : "Action" }).getByRole("option", { name: option, exact: true }).click();
};

const rowsOf = (page: Page) => page.getByTestId("audit-row");

test("F-073/c2: an admin filters by actor and action and exports the same rows", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.goto("/organization/audit");
  await expect(rowsOf(page).first()).toBeVisible();

  await pick(page, "actor", m4World.by);
  await expect(page).toHaveURL(new RegExp(`actor=${world.memberId}`));
  await pick(page, "action", "task.created");
  await expect(page).toHaveURL(/action=task.created/);
  await expect(page.getByTestId("audit-filter-actor-value")).toHaveText(m4World.by);
  await expect(rowsOf(page)).toHaveCount(1);
  await expect(rowsOf(page).first()).toHaveAttribute("data-entity-id", world.otherTaskId);
  await expect(rowsOf(page).first()).toContainText(m4World.by);
  await expect(page.getByTestId("audit-count")).toHaveText("1 entry");

  // The export holds the same rows: one header, then this entry.
  const href = (await page.getByTestId("audit-export").getAttribute("href")) ?? "";
  expect(href).toContain(`actorId=${world.memberId}`);
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  const csv = parseCsv(await response.text());
  // The target's columns (app-targets/m4/audit-log.md, "Export CSV").
  expect(csv[0]).toEqual(["time", "actor_kind", "actor_id", "actor_name", "action", "entity", "entity_id", "entity_label", "project_id", "project_name", "data"]);
  const body = csv.slice(1);
  const shown = await rowsOf(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-entity-id")));
  expect(body.map((row) => row[6])).toEqual(shown);
  expect(body.map((row) => row[4])).toEqual(["task.created"]);
  expect(body.map((row) => row[2])).toEqual([world.memberId]);

  // Without the actor filter, both entries; the export follows.
  await page.getByRole("button", { name: "Clear Actor" }).click();
  await expect(rowsOf(page).and(page.locator(`[data-entity-id="${world.taskId}"]`))).toHaveCount(1);
  const listed = await rowsOf(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-entity-id")));
  const all = parseCsv(await (await page.request.get((await page.getByTestId("audit-export").getAttribute("href")) ?? "")).text()).slice(1);
  expect(all.map((row) => row[6])).toEqual(listed);
  expect(all.map((row) => row[6])).toEqual(expect.arrayContaining([world.taskId, world.otherTaskId]));
  await expectNoHorizontalScroll(page);
});

test("F-073/c4: a task entry opens the event log at that task, and a tool call's command and folder show in full", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.goto("/organization/audit?action=task.created");
  const entry = rowsOf(page).and(page.locator(`[data-entity-id="${world.taskId}"]`));
  await entry.click();
  await expect(entry).toHaveAttribute("aria-selected", "true");
  const panel = page.getByTestId("audit-panel");
  await expect(panel).toContainText("task.created");
  await expect(page.getByTestId("audit-data")).toContainText("source");
  await shoot(page, "audit-log");
  await panel.getByTestId("audit-open-event-log").click();
  await page.waitForURL(new RegExp(`/tasks/${world.taskId}\\?tab=events`));
  await expect(page.getByRole("tab", { name: /Event log/ })).toHaveAttribute("aria-selected", "true");

  const log = page.getByTestId("event-log");
  const exec = log.getByTestId("event-row").and(page.locator('[data-word="execute"]'));
  await expect(exec).toContainText("pnpm test -- history");
  await expect(exec.getByTestId("event-status")).toHaveText("failed · exit 1");
  await exec.click();
  const input = log.getByTestId("event-input");
  await expect(input).toContainText('"command": "pnpm test -- history"');
  await expect(input).toContainText(`"cwd": "${m4World.folder}"`);
  // In full: the folder isn't cut, and the block wraps instead of scrolling sideways.
  const fits = await input.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(fits).toBe(true);
  await expect(log.getByTestId("event-row").and(page.locator('[data-word="read"]'))).toContainText("src/history.ts");
  await shoot(page, "task-event-log");

  // The kind chips filter the rows.
  await log.getByRole("button", { name: /^Messages/ }).click();
  await expect(log.getByTestId("event-row").and(page.locator('[data-word="execute"]'))).toHaveCount(0);
  await expect(log.getByTestId("event-row").and(page.locator('[data-word="agent"]'))).toContainText(m4World.word);
});

test("F-073: the audit log and the event log fit a phone", async ({ page }) => {
  const world = await seedM4World(m4World);
  await signIn(page);
  await page.goto("/organization/audit");
  await expect(rowsOf(page).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "audit-log");
  await page.goto(`/tasks/${world.taskId}?tab=events`);
  await expect(page.getByTestId("event-row").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shootPhone(page, "task-event-log");
});
