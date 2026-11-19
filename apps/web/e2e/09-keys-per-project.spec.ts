import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-135 (ticket 53): keys per project in the panel. An organization admin gives a project its own
// list and sees the save's preview first; a project admin and a member read the keys by name with
// no edit and no token; New task says "no key" with Start disabled; the needs-you row reaches
// organization admins only; the task page names its key; a profile's model is picked by name.
// The keys, projects and tasks are seeded (`seed-keys-world.ts`): two keys with one model, no
// endpoint called. The live run with two real keys is ticket 55, the maintainer's step.

const run = promisify(execFile);

const seededSchema = z.object({
  memberId: z.string(),
  projectAdminId: z.string(),
  calculator: z.string(),
  portal: z.string(),
  noKey: z.string(),
  ranTaskId: z.string(),
  queuedTaskId: z.string(),
  builderId: z.string(),
  clientA: z.string(),
  clientB: z.string(),
});
type Seeded = z.infer<typeof seededSchema>;

let seeded: Seeded | null = null;
/** The seeded world, once per worker; `again` seeds it anew, putting back what a case changed. */
const seedWorld = async (again = false): Promise<Seeded> => {
  if (seeded !== null && !again) return seeded;
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-keys-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  seeded = seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  return seeded;
};

const signOut = async (page: Page): Promise<void> => {
  await page.context().clearCookies();
};

/** No secret ref and no token-shaped value anywhere in the page's text or markup. */
const expectNoToken = async (page: Page): Promise<void> => {
  const html = await page.content();
  expect(html).not.toContain("builtin:client-a");
  expect(html).not.toContain("builtin:client-b");
  expect(html).not.toContain("e2e-model-token-not-a-real-key");
};

/** The seeded model's row in a project's "Models its profiles use", by its catalog ID. */
const sonnetRow = (page: Page) => page.locator('tr[data-model="anthropic/claude-sonnet-4-5"]');

test.describe.configure({ mode: "serial" });

test("F-135: an organization admin gives a project its own list, and sees the preview before the save", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedWorld();
  await signIn(page);
  await page.goto(`/projects/${world.calculator}/settings/models`);
  await expect(page.getByRole("heading", { level: 1, name: "Models and keys" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Use this project's own list/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "client-a" })).toBeChecked();
  // Nothing unsaved: no save in the top bar.
  await expect(page.getByRole("button", { name: "Save list" })).toHaveCount(0);

  // Ticking client-b too: the preview says nothing moves, before anything is saved.
  await page.getByRole("checkbox", { name: "client-b" }).click();
  const preview = page.getByTestId("providers-preview");
  await expect(preview.getByText("Before you save")).toBeVisible();
  await expect(preview.getByRole("heading", { name: "Nothing moves" })).toBeVisible();
  await expect(preview.getByTestId("preview-line").filter({ hasText: "Claude Sonnet 4.5" })).toContainText("stays on client-a");
  await expect(page.getByRole("button", { name: "Save list" })).toBeEnabled();

  // Unticking client-a instead: the model is left with no key, said before the save.
  await page.getByRole("checkbox", { name: "client-b" }).click();
  await page.getByRole("checkbox", { name: "client-a" }).click();
  await expect(preview.getByRole("heading", { name: "This save changes 1 model" })).toBeVisible();
  await expect(preview.getByTestId("preview-line").filter({ hasText: "Claude Sonnet 4.5" })).toContainText("has no key here");
  await expect(sonnetRow(page)).toContainText("No key");

  // Discard leaves the saved list as it was; then the save of client-a + client-b applies.
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("checkbox", { name: "client-a" })).toBeChecked();
  await page.getByRole("checkbox", { name: "client-b" }).click();
  await expect(preview.getByRole("heading", { name: "Nothing moves" })).toBeVisible();
  await page.getByRole("button", { name: "Save list" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save list" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "client-b" })).toBeChecked();
  await expect(sonnetRow(page)).toContainText("client-a");

  // Put the list back for the cases below.
  await page.getByRole("checkbox", { name: "client-b" }).click();
  await page.getByRole("button", { name: "Save list" }).click();
  await expect(page.getByRole("button", { name: "Save list" })).toHaveCount(0);
  await expectNoToken(page);
});

/** A project admin or a member on a project's Models and keys: the keys by name, nothing to change, no token. */
const readsKeysOnly = async (page: Page, who: "keys-padmin" | "keys-member"): Promise<void> => {
  const world = await seedWorld();
  await signIn(page, who);
  await page.goto(`/projects/${world.calculator}/settings/models`);
  await expect(page.getByRole("heading", { level: 1, name: "Models and keys" })).toBeVisible();
  await expect(page.getByText("Only an organization admin changes this project's keys.")).toBeVisible();
  await expect(page.getByTestId("provider-rows")).toContainText("client-a");
  await expect(sonnetRow(page)).toContainText("client-a");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Change/ })).toHaveCount(0);
  await expect(page.getByText("Nobody sees a token.", { exact: false })).toBeVisible();
  await expectNoToken(page);
  await expectNoHorizontalScroll(page);
  await signOut(page);
};

test("F-135: a project admin sees the keys by name, with no edit and no token", async ({ page }) => {
  await readsKeysOnly(page, "keys-padmin");
});

test("F-135: a member sees the keys by name, with no edit and no token", async ({ page }) => {
  await readsKeysOnly(page, "keys-member");
});

test("F-135: New task shows no key with Start disabled", async ({ page }) => {
  const world = await seedWorld();
  await signIn(page, "keys-member");
  await page.goto("/tasks/new");
  await page.getByTestId("pick-project").click();
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: "nokey", exact: true }).click();
  await page.getByLabel("Prompt").fill("Write notes.txt");
  const reason = page.getByTestId("no-key");
  await expect(reason).toContainText("No key for Claude Sonnet 4.5 in nokey.");
  await expect(reason).toContainText("An organization admin picks one in Models and keys.");
  // A member is told who can fix it, by name, and gets no link.
  await expect(reason).toContainText("Organization admins:");
  await expect(reason.getByRole("link")).toHaveCount(0);
  const start = page.locator('[data-action="start-task"]');
  await expect(start).toBeDisabled();
  await expect(page.getByTestId("task-key")).toHaveText("None in nokey");
  // The same project with a key: Start is offered again.
  await page.getByTestId("pick-project").click();
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: "calculator", exact: true }).click();
  await expect(page.getByTestId("no-key")).toHaveCount(0);
  await expect(page.getByTestId("task-key")).toHaveText("client-a");
  await expect(start).toBeEnabled();
  expect(world.noKey).not.toBe("");
  await signOut(page);
});

test("F-135: the needs-you row shows for an organization admin and not for a member", async ({ page }) => {
  const world = await seedWorld();
  await signIn(page);
  const row = page.locator(`[data-testid="needs-you-row"][data-task="${world.queuedTaskId}"]`);
  await expect(row).toContainText("No key for its model in this project");
  await expect(row.getByRole("link", { name: "Pick a key" })).toHaveAttribute("href", `/projects/${world.noKey}/settings/models`);
  await signOut(page);
  await signIn(page, "keys-member");
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await expect(page.locator(`[data-task="${world.queuedTaskId}"]`)).toHaveCount(0);
  await expect(page.getByText("No key for its model in this project")).toHaveCount(0);
  await signOut(page);
});

test("F-135: the task page names its key, and a task queued with no key says why", async ({ page }) => {
  const world = await seedWorld();
  await signIn(page, "keys-member");
  await page.goto(`/tasks/${world.ranTaskId}`);
  await expect(page.getByTestId("task-key")).toHaveText("Key · client-a");
  await page.goto(`/tasks/${world.queuedTaskId}`);
  await expect(page.getByTestId("task-no-key")).toContainText("No key for Claude Sonnet 4.5 in nokey.");
  // A member is told who can fix it, by name.
  await expect(page.getByTestId("task-no-key")).toContainText("Organization admins:");
  await expect(page.getByTestId("task-doing")).toContainText("Queued · no key");
  await signOut(page);
});

test("F-135: a profile's model is picked by name, with the projects where no key serves it", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedWorld();
  await signIn(page);
  await page.goto(`/organization/agent-profiles/${world.builderId}`);
  await page.getByTestId("profile-model").click();
  const option = page.getByRole("option", { name: /Claude Sonnet 4.5/ });
  await expect(option).toContainText("client-a, client-b");
  await expect(option).toContainText("No key in nokey");
  // While highlighted, the panel previews the model in each project.
  await option.hover();
  const inProjects = page.getByTestId("model-in-projects");
  await expect(inProjects).toContainText("Claude Sonnet 4.5 in each project");
  await expect(inProjects).toContainText("client-a");
  await expect(inProjects.getByRole("listitem").filter({ hasText: "nokey" }).getByRole("link", { name: "No key" })).toHaveAttribute("href", `/projects/${world.noKey}/settings/models`);
  // The custom model, by its endpoint ID: one key lists it.
  await page.getByRole("searchbox").or(page.getByRole("combobox", { name: "Search models" })).fill("local-coder");
  const custom = page.getByRole("option", { name: /local-coder-7b/ });
  await expect(custom).toContainText("client-b");
  await custom.click();
  await expect(page.getByTestId("profile-model")).toContainText("local-coder-7b");
  await page.locator('[data-action="save-profile"]').click();
  await expect(page.getByRole("status")).toContainText("Saved. No key serves it in");
  await page.reload();
  await expect(page.getByTestId("profile-model")).toContainText("local-coder-7b");
  // Back to the model by its catalog name.
  await page.getByTestId("profile-model").click();
  await page.getByRole("option", { name: /Claude Sonnet 4.5/ }).click();
  await page.locator('[data-action="save-profile"]').click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  // Put the profile's key row back for the phone run's cases.
  await seedWorld(true);
});
