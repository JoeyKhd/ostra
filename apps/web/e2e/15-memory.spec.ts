import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-109, F-111 (ticket 38): Memory in the panel. A project, a second member, a task, a note and an
// agent's proposal are seeded (`seed-memory-world.ts`); everything else goes through the pages and
// the API. "Remember this" on a diff comment reads the task's diff from the cache `diff.fetch` fills,
// seeded for a head on the fake GitHub's repo that the setup spec links (`02-setup.spec.ts`).

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");
const worldSchema = z.object({ projectId: z.string(), taskId: z.string(), noteId: z.string(), proposalId: z.string(), diffCommentId: z.string().nullable() });
type World = z.infer<typeof worldSchema>;

const seedScript = async (extra: Readonly<Record<string, string>> = {}): Promise<string> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-memory-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, ...extra })], { cwd });
  return stdout.trim().split("\n").at(-1) ?? "{}";
};

let world: World | null = null;
const seed = async (): Promise<World> => {
  world ??= worldSchema.parse(JSON.parse(await seedScript()));
  return world;
};

const newNote = async (page: Page, projectId: string, title: string, body: string): Promise<void> => {
  await page.goto(`/projects/${projectId}/memory/new`);
  await expect(page.getByRole("heading", { level: 1, name: "New note" })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Body").fill(body);
};


test("F-109/c1,c3: a member writes a note and finds it by a word", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId } = await seed();
  await signIn(page);
  await newNote(page, projectId, "Check JavaScript with node", "Run `node --check <file>` on every JavaScript file you change.");
  await page.getByLabel("Kind").click();
  await page.getByRole("option", { name: "Command" }).click();
  await page.getByTestId("save-note").click();
  await page.waitForURL(/\/memory\/[0-9a-f-]{36}\?saved=1$/);
  await expect(page.getByText("Saved as version 1.")).toBeVisible();

  // The Memory page finds it by a word of its body, and not the note that doesn't have it.
  await page.goto(`/projects/${projectId}/memory`);
  await expect(page.locator('[data-note="Settings keys use camelCase"]')).toBeVisible();
  await page.getByTestId("memory-search").fill("javascript");
  const list = page.getByTestId("memory-list");
  await expect(list.locator('[data-note="Check JavaScript with node"]')).toBeVisible();
  await expect(list.locator('[data-note="Settings keys use camelCase"]')).toHaveCount(0);
  await expect(page).toHaveURL(/q=javascript/);
  await list.locator('[data-note="Check JavaScript with node"]').click();
  const panel = page.getByTestId("note-panel");
  await expect(panel.getByRole("heading", { name: "Check JavaScript with node" })).toBeVisible();
  await expect(panel).toContainText("Command");
  await expect(panel.getByTestId("note-body").locator("code")).toHaveText("node --check <file>");
});

test("F-109/c4: a note with a fake token is refused with the kind named, and nothing is saved", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId } = await seed();
  await signIn(page);
  const token = `ghp_${"A".repeat(36)}`;
  await newNote(page, projectId, "Tests read the GitHub token", `Tests that call GitHub read GITHUB_TOKEN=${token}`);
  await page.getByTestId("save-note").click();
  const refusal = page.getByTestId("note-secret");
  await expect(refusal).toContainText("This note holds a GitHub token. Memory never holds credentials.");
  await expect(refusal).toContainText("Nothing was saved.");
  await expect(refusal).not.toContainText(token);
  // The member's text stays, and the page is still the new note's.
  await expect(page.getByLabel("Body")).toHaveValue(`Tests that call GitHub read GITHUB_TOKEN=${token}`);
  await expect(page).toHaveURL(/\/memory\/new$/);
  await page.goto(`/projects/${projectId}/memory`);
  await page.getByTestId("memory-search").fill("GitHub token");
  await expect(page.getByTestId("memory-no-match")).toBeVisible();
});

test("F-109/c5: a save from a stale version says who saved first and keeps the text", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, noteId } = await seed();
  await signIn(page);
  await page.goto(`/projects/${projectId}/memory/${noteId}`);
  const body = page.getByLabel("Body");
  await expect(body).toHaveValue(/camelCase, like releaseName\.$/);
  await body.fill("New keys in `config/settings.json` are camelCase. Older keys are renamed when touched.");
  // Sam saves version 2 meanwhile.
  expect(JSON.parse(await seedScript({ bump: noteId }))).toEqual({ version: 2 });
  await page.getByTestId("save-note").click();
  await expect(page.getByTestId("note-conflict")).toContainText("saved version 2 while you were editing. Your text is still in the editor");
  await expect(page.getByTestId("note-conflict")).toContainText("mem-sam");
  await expect(body).toHaveValue("New keys in `config/settings.json` are camelCase. Older keys are renamed when touched.");
});

test("F-111/c3,c5, F-109/c2: a proposal is approved and appears as a note with its source", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, taskId } = await seed();
  await signIn(page);
  await page.goto(`/projects/${projectId}/memory`);
  // A count on the Memory page, never amber and never a needs-you row.
  await expect(page.getByTestId("proposals-link")).toHaveText("Proposals1");
  await page.getByTestId("proposals-link").click();
  await page.waitForURL(/\/memory\/proposals/);
  const row = page.locator('[data-proposal="Settings keys are single lowercase words"]');
  await expect(row).toContainText("contradicts");
  const detail = page.getByTestId("proposal-detail");
  await expect(detail).toContainText("Settings keys use camelCase");
  await expect(page.getByTestId("proposal-task")).toHaveText("Rename the releaseName key");
  await detail.getByTestId("approve-proposal").click();

  // It lands on the note, from the agent's proposal of the task.
  await page.waitForURL(/\/memory\?note=/);
  const panel = page.getByTestId("note-panel");
  await expect(panel.getByRole("heading", { name: "Settings keys are single lowercase words" })).toBeVisible();
  await expect(panel.getByRole("link", { name: taskId.slice(-7) })).toHaveAttribute("href", `/tasks/${taskId}`);
  await expect(panel).toContainText("An agent’s proposal");
  await page.goto(`/projects/${projectId}/memory/proposals`);
  await expect(page.getByTestId("proposals-empty")).toHaveText("No proposals waiting.");
});

test("F-111/c1: Remember this on a diff comment makes a proposal with the comment as its source", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, taskId, diffCommentId } = await seed();
  expect(diffCommentId, "the setup spec links the fake GitHub's installation first").not.toBeNull();
  await signIn(page);
  await page.goto(`/tasks/${taskId}?tab=changes`);
  const comment = page.locator(`[data-comment="${diffCommentId ?? ""}"]`);
  await expect(comment).toContainText("Print a newline at the end");
  await comment.locator('[data-action="remember-this"]').click();
  await expect(comment.getByTestId("remembered")).toHaveText("Proposed for memory");

  // It waits in the project's proposals: the comment's text, by the member, from the task.
  await page.goto(`/projects/${projectId}/memory/proposals`);
  const row = page.locator('[data-proposal="Print a newline at the end"]');
  await expect(row).toContainText(`demo, a diff comment on ${taskId.slice(-7)}`);
  await row.click();
  await expect(page.getByTestId("proposal-detail")).toContainText("Print a newline at the end");
  await expect(page.getByTestId("proposal-task")).toHaveText("Rename the releaseName key");
});

test("F-111/c1: Remember this on an accepted @ostra comment makes a proposal in the member's words", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, taskId } = await seed();
  await signIn(page);
  await page.goto(`/tasks/${taskId}`);
  const row = page.locator('[data-part="pr-comment"]');
  await expect(row).toContainText("ostra-test-member asked through an @ostra comment on the pull request");
  await expect(row.getByRole("link", { name: "Open the comment" })).toHaveAttribute("href", /\/pull\/3#issuecomment-31$/);
  await row.locator('[data-action="remember-this"]').click();
  const form = row.getByTestId("pr-comment-remember");
  await form.getByLabel("Title").fill("Changelog lines start with an ISO date");
  await form.getByLabel("What the next task should know").fill("Every line added to CHANGELOG.md starts with the date as YYYY-MM-DD.");
  await form.getByRole("button", { name: "Propose" }).click();
  await expect(row.getByTestId("remembered")).toHaveText("Proposed for memory");
  await expect(form).toHaveCount(0);

  await page.goto(`/projects/${projectId}/memory/proposals`);
  const proposal = page.locator('[data-proposal="Changelog lines start with an ISO date"]');
  await expect(proposal).toContainText(`demo, a PR comment on ${taskId.slice(-7)}`);
  await proposal.click();
  await expect(page.getByTestId("proposal-detail")).toContainText("Every line added to CHANGELOG.md starts with the date as YYYY-MM-DD.");
});

test("F-111/c4: a merge into a note that moved on says who saved first and keeps the merged text", { tag: "@desktop-only" }, async ({ page }) => {
  const { projectId, noteId } = await seed();
  const { proposalId } = z.object({ proposalId: z.string() }).parse(JSON.parse(await seedScript({ proposal: noteId })));
  await signIn(page);
  await page.goto(`/projects/${projectId}/memory/proposals?proposal=${proposalId}`);
  const detail = page.getByTestId("proposal-detail");
  await expect(detail).toContainText("Settings keys say what they hold");
  await detail.getByRole("button", { name: "Merge into Settings keys use camelCase" }).click();
  const merged = detail.locator("#merged-body");
  const text = "New keys in `config/settings.json` are camelCase and name what they hold, like releaseName.";
  await merged.fill(text);
  // Sam saves the note's next version meanwhile.
  z.object({ version: z.number() }).parse(JSON.parse(await seedScript({ bump: noteId })));
  await detail.getByRole("button", { name: /^Merge as version \d+$/ }).click();
  await expect(detail.getByTestId("proposal-error")).toContainText(/mem-sam saved version \d+ of the note since you opened it\. Reload to merge into the latest\./);
  await expect(merged).toHaveValue(text);
  // Nothing was merged: the proposal still waits.
  await page.reload();
  await expect(page.locator('[data-proposal="Settings keys say what they hold"]')).toBeVisible();
});

test("F-110/c4, F-111/c1: the task panel's Memory lists the notes its session used and the proposals it made", { tag: "@desktop-only" }, async ({ page }) => {
  const { taskId } = await seed();
  await signIn(page);
  await page.goto(`/tasks/${taskId}`);
  const memory = page.getByTestId("task-memory");
  // One row per note, the strongest way the session saw it: a read beats the index.
  await expect(memory.getByTestId("task-memory-note")).toHaveCount(1);
  await expect(memory.getByTestId("task-memory-note")).toContainText("Settings keys use camelCase");
  await expect(memory.getByTestId("task-memory-note")).toContainText("read");
  await expect(memory.getByTestId("task-memory-proposal").filter({ hasText: "Proposed: Settings keys are single lowercase words" })).toBeVisible();
});

test("F-109/c1: Memory reads at phone width with no sideways scroll", async ({ page }) => {
  const { projectId } = await seed();
  await signIn(page);
  await page.goto(`/projects/${projectId}/memory`);
  await expect(page.getByTestId("memory-list")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
