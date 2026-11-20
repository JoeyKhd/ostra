import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn, watchOrigins } from "./helpers.ts";
import { e2eRepo } from "./settings.ts";

// F-097: a prompt task, typed in the panel. The project and the default model are the earlier
// specs' (`03-first-run`, `02-setup`); the project has no tracker, and no runner is online, so the
// task is created and waits for one. The database is read through `read-task.ts`.

const run = promisify(execFile);

const factsSchema = z.object({
  source: z.string(),
  kind: z.string(),
  state: z.string(),
  ticketKey: z.string().nullable(),
  ticketId: z.string().nullable(),
  projectSlug: z.string(),
  sessions: z.number(),
  projectBoards: z.number(),
  tickets: z.number(),
  ticketWrites: z.number(),
  dispatchJobs: z.number(),
});

const readTask = async (taskId: string): Promise<z.infer<typeof factsSchema>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "read-task.ts"), JSON.stringify({ databaseUrl, taskId })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return factsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

test("F-097/c1,c2,c3: a member types a prompt in a project with no tracker, and the task starts with no ticket", { tag: "@desktop-only" }, async ({ page }) => {
  const origins = watchOrigins(page);
  await signIn(page);
  await page.goto("/tasks/new");

  // The project from the GitHub repo, picked in the composer's footer.
  await page.getByTestId("pick-project").click();
  await page.getByRole("listbox", { name: "Pick the project" }).getByRole("button", { name: e2eRepo.name, exact: true }).click();
  await expect(page.getByTestId("pick-project")).toContainText(e2eRepo.name);

  const prompt = "Add a docs/numbers.md that lists the numbers one to ten";
  await page.getByLabel("Prompt").fill(prompt);
  await expect(page.getByTestId("branch-preview")).toContainText("add-a-docs-numbers-md");
  await page.locator('[data-action="start-task"]').click();

  // It lands on the task page, with the prompt as the member's first message.
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(page.locator('[data-part="thread"]')).toContainText(prompt);

  const facts = await readTask(taskId);
  expect(facts).toMatchObject({ source: "prompt", kind: "code", state: "queued", projectSlug: e2eRepo.name, sessions: 1 });
  expect(facts.dispatchJobs).toBeGreaterThanOrEqual(1);
  // No ticket: none on the task, none made, none written to a tracker, and the project has none.
  expect(facts).toMatchObject({ ticketKey: null, ticketId: null, projectBoards: 0, tickets: 0, ticketWrites: 0 });
  expect(origins.foreign()).toEqual([]);
});
