import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn, watchOrigins } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-021, F-026, F-063 (ticket 42): an admin makes an agent profile with a preset rule, plan first and
// a member limit; a listed member sees it in New task's picker and starts a task with it, an unlisted
// member doesn't see it; the project's default for code tasks is offered first. The project is the
// earlier specs' (`03-first-run`); the members, and a model on the built-in profile when `02-setup`
// left none, are seeded here.

const run = promisify(execFile);

const LISTED = "e2e-listed";
const UNLISTED = "e2e-unlisted";
const CAREFUL = "Careful e2e";
const TEAM = "Team default e2e";

const seededSchema = z.object({ members: z.array(z.object({ username: z.string(), memberId: z.string() })), projectName: z.string() });

/** The two members, a model on the built-in profile, and the project to start in (`seed-profile-world.ts`). */
const seedWorld = async (): Promise<z.infer<typeof seededSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(
    process.execPath,
    [path.join(import.meta.dirname, "seed-profile-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, usernames: [LISTED, UNLISTED] })],
    { cwd: path.resolve(import.meta.dirname, "..") },
  );
  return seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const factsSchema = z.object({ profileName: z.string().nullable(), state: z.string() });

const readTask = async (taskId: string): Promise<z.infer<typeof factsSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "read-task.ts"), JSON.stringify({ databaseUrl, taskId })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return factsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** A new profile with only a name; the model is the built-in profile's (agent-profile.md, "New profile"). */
const startProfile = async (page: Page, name: string): Promise<void> => {
  await page.goto("/organization/agent-profiles");
  await page.getByRole("link", { name: "New profile" }).first().click();
  await page.waitForURL("**/organization/agent-profiles/new");
  await expect(page.getByTestId("profile-eyebrow")).toHaveText("New agent profile");
  await page.getByTestId("profile-name").fill(name);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
};

const saveProfile = async (page: Page): Promise<void> => {
  await page.locator('[data-action="save-profile"]').click();
  await page.waitForURL(/\/organization\/agent-profiles\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("status")).toHaveText("Saved.");
};

/** New task's picker, in the e2e repo's project: the offered profiles' names, in order. */
const pickerNames = async (page: Page, project: string): Promise<string[]> => {
  await page.goto("/tasks/new");
  await page.getByTestId("pick-project").click();
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: project, exact: true }).click();
  await expect(page.getByTestId("agent-profile-name")).not.toHaveText("");
  await page.getByTestId("agent-profile").click();
  const names = await page.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("data-profile") ?? ""));
  return names;
};

test("F-021, F-026, F-063: an admin makes a profile with a preset rule, plan first and a member limit; only a listed member can pick it; the project's default comes first", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(180_000);
  const origins = watchOrigins(page);
  const { projectName } = await seedWorld();
  await signIn(page);

  // The profile: a preset rule that opens editable with its coverage line, plan first, one listed member.
  await startProfile(page, CAREFUL);
  await page.getByTestId("rule-presets").getByRole("button", { name: "Adding a dependency" }).click();
  const open = page.locator("[data-rule-open]");
  await expect(open).toHaveCount(1);
  await expect(open.getByTestId("rule-coverage")).toContainText("Asks for");
  await open.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("rules").locator("[data-rule]").first()).toContainText("preset");
  // The preset now in the profile can't be added twice.
  await expect(page.getByTestId("rule-presets").getByRole("button", { name: "Adding a dependency" })).toBeDisabled();
  // Plan first is off on a new profile (F-063), and one press turns it on.
  await expect(page.getByTestId("plan-first")).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("plan-first").click();
  await expect(page.getByTestId("plan-first")).toHaveAttribute("aria-checked", "true");
  await page.getByText("Only these members", { exact: true }).click();
  // Nobody listed yet: it can't be saved.
  await expect(page.locator('[data-action="save-profile"]')).toBeDisabled();
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByRole("listbox", { name: "Add member" }).getByRole("option", { name: new RegExp(LISTED) }).click();
  await expect(page.getByTestId("listed-members")).toContainText(LISTED);
  await saveProfile(page);

  // A second profile, open to everyone, made the project's default for code tasks.
  await startProfile(page, TEAM);
  await saveProfile(page);

  // The list shows what was saved: plan first, the rule, the listed member.
  await page.goto("/organization/agent-profiles");
  const row = page.locator(`tr[data-profile="${CAREFUL}"]`);
  await expect(row).toContainText("On");
  await expect(row).toContainText("1 member");
  await row.click();
  await expect(page.getByTestId("profile-panel")).toContainText("Only these members");
  await expect(page.getByTestId("panel-rules")).toContainText("preset");

  await page.goto("/");
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: projectName, exact: true }).click();
  const defaults = page.getByTestId("project-defaults");
  // A listed profile is never offered as a default: it isn't open to every member.
  await defaults.locator('[data-kind="code"]').click();
  await expect(page.getByRole("option", { name: CAREFUL })).toHaveCount(0);
  await page.getByRole("option", { name: TEAM }).click();
  await expect(defaults.getByRole("status")).toHaveText("Saved.");
  await expect(defaults.locator('[data-kind="code"]')).toContainText(TEAM);

  // The listed member: the project's default first and chosen, and the listed profile offered.
  await page.context().clearCookies();
  await signIn(page, LISTED);
  const listedSees = await pickerNames(page, projectName);
  expect(listedSees[0]).toBe(TEAM);
  expect(listedSees).toContain(CAREFUL);
  await expect(page.getByRole("menuitem").first()).toContainText("default");
  await page.getByRole("menuitem").filter({ hasText: CAREFUL }).click();
  await expect(page.getByTestId("agent-profile-name")).toHaveText(CAREFUL);
  await expect(page.getByTestId("chosen-profile")).toHaveText(CAREFUL);
  // Its facts under the name: the model, plan first and the preset's two rules (its edit and its command).
  await page.getByTestId("agent-profile").click();
  await expect(page.getByRole("menuitem").filter({ hasText: CAREFUL })).toContainText("plan first · 2 rules");
  await page.keyboard.press("Escape");
  await page.getByLabel("Prompt").fill("List the files in the repo's root in docs/files.md");
  await page.locator('[data-action="start-task"]').click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  expect((await readTask(taskId)).profileName).toBe(CAREFUL);

  // The unlisted member: the default, and never the listed profile.
  await page.context().clearCookies();
  await signIn(page, UNLISTED);
  const unlistedSees = await pickerNames(page, projectName);
  expect(unlistedSees[0]).toBe(TEAM);
  expect(unlistedSees).not.toContain(CAREFUL);
  // Nor in the list of profiles, nor by its address.
  await page.goto("/organization/agent-profiles");
  await expect(page.locator(`tr[data-profile="${CAREFUL}"]`)).toHaveCount(0);

  expect(origins.foreign()).toEqual([]);
});
