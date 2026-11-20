import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-137 (ticket 63): the reasoning effort on the profile editor, the task page and Models, against
// the fixture catalog's controls (`seed-effort.ts`): GPT-5.5 takes Off to Extra high, Claude Haiku 5
// doesn't reason. `OSTRA_E2E_SHOTS` names a folder for the 1440px screenshots compared with the targets.

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const MEMBER = "e2e-effort-watcher";
const shots = process.env["OSTRA_E2E_SHOTS"];

const seededSchema = z.object({ taskId: z.string(), profileId: z.string() });
let seeded: z.infer<typeof seededSchema> | null = null;

const seed = async (): Promise<z.infer<typeof seededSchema>> => {
  if (seeded !== null) return seeded;
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-effort.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, member: MEMBER })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  seeded = seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  return seeded;
};

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m4-effort-${name}-final.png`) });
};

const levels = (page: Page): Promise<(string | null)[]> =>
  page.getByTestId("profile-effort").locator("[data-level]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-level")));

test("F-137/c1,c2: Careful on GPT-5.5 offers its five levels and Default, and a model that doesn't reason offers no control", { tag: "@desktop-only" }, async ({ page }) => {
  const { profileId } = await seed();
  await signIn(page);
  await page.goto(`/organization/agent-profiles/${profileId}`);
  const field = page.getByTestId("profile-effort");
  await expect(field).toHaveAttribute("data-view", "list");
  expect(await levels(page)).toEqual(["default", "none", "low", "medium", "high", "xhigh"]);
  await expect(field.locator('[data-chosen="true"]')).toHaveAttribute("data-level", "high");
  await expect(field).toContainText("How long GPT-5.5 thinks before it acts.");
  await expect(page.getByTestId("panel-effort")).toHaveText("High");
  await expect(page.getByTestId("profile-model")).toContainText("GPT-5.5");
  await expectNoHorizontalScroll(page);
  await shoot(page, "agent-profile-effort");

  // Claude Haiku 5 doesn't reason: the list goes, and one line says so.
  await page.getByTestId("profile-model").click();
  await page.getByRole("option", { name: /Claude Haiku 5/ }).click();
  await expect(field).toHaveAttribute("data-view", "line");
  await expect(page.getByTestId("profile-effort-line")).toHaveText("Claude Haiku 5 doesn't take an effort level. Tasks run at the endpoint's default.");
  await expect(field.locator('[role="radio"]')).toHaveCount(0);

  // Back on GPT-5.5, the saved level is chosen again.
  await page.getByTestId("profile-model").click();
  await page.getByRole("option", { name: /GPT-5\.5/ }).click();
  await expect(field.locator('[data-chosen="true"]')).toHaveAttribute("data-level", "high");
});

test("F-137/c7,c8: the driver changes a running task's level and sees that it applies from the next turn", { tag: "@desktop-only" }, async ({ page }) => {
  const { taskId } = await seed();
  await signIn(page);
  await page.goto(`/tasks/${taskId}`);
  const trigger = page.getByTestId("task-effort-trigger");
  await expect(trigger).toHaveAttribute("data-level", "high");
  await expect(page.getByTestId("task-effort-next")).toHaveCount(0);
  await expect(trigger).toHaveText("High");

  await trigger.click();
  await page.getByRole("option", { name: /^Low/ }).click();
  await expect(trigger).toHaveAttribute("data-level", "low");
  const next = page.getByTestId("task-effort-next");
  await expect(next).toContainText("From the next turn.");
  await expect(next).toContainText("This turn runs at High.");
  // The thread's marker, live from the stream.
  await expect(page.locator('[data-part="thread"]')).toContainText("set effort to Low, from the next turn", { timeout: 10_000 });
  await expectNoHorizontalScroll(page);
  await shoot(page, "task-effort");
});

test("F-137/c7: a member who isn't the driver sees the level and no control", { tag: "@desktop-only" }, async ({ page }) => {
  const { taskId } = await seed();
  await signIn(page, MEMBER);
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("task-effort")).toHaveText("Low");
  await expect(page.getByTestId("task-effort-trigger")).toHaveCount(0);
});

test("F-137/c2: Models shows each model's levels and their source", { tag: "@desktop-only" }, async ({ page }) => {
  await seed();
  await signIn(page);
  await page.goto("/organization/models");
  const gpt = page.locator('tr[data-model="gpt-5.5"]');
  await expect(gpt.getByTestId("model-reasoning-cell")).toContainText("Off, Low, Medium, High, Extra high");
  await expect(gpt.getByTestId("model-reasoning-cell")).toContainText("from the catalog");
  await expect(page.locator('tr[data-model="claude-haiku-5"]').getByTestId("model-reasoning-cell")).toContainText("Doesn't reason");
  await gpt.click();
  await expect(page.getByTestId("model-reasoning")).toHaveAttribute("data-source", "catalog");
  await expectNoHorizontalScroll(page);
  await shoot(page, "model-reasoning");
});
