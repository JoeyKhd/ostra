import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LinearAdapter } from "@ostra/adapter-linear";
import { externalTicketIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";

// F-099 (milestone 6's ticket 34): a refine task's draft in the panel, against the stack's fake
// Linear (`fakes.ts`, OSTRA_LINEAR_API_URL) and core. The world is seeded (`seed-refine-world.ts`):
// the fake Linear connected with an API key, the "calculator" project with team `OST` as its
// board, a ticket made on the fake, and a refine task on it holding the two versions its agent
// handed in (the drafting fake's `sampleDraft`, then a second). Everything after goes through the
// page: a criterion edited, an image uploaded, "Update ticket", which core's `draft.apply` writes to
// the fake Linear, and "Mark ready", which ticket sync moves to `Todo`. The fake Linear is read
// back through the shipped adapter. `OSTRA_E2E_SHOTS` names a folder for the screenshots compared
// with the targets (app-targets/m6/refine-draft*.webp), in dark and light.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const worldSchema = z.object({ projectId: z.string(), taskId: z.string(), ticketKey: z.string().nullable(), externalId: z.string().nullable(), boardId: z.string() });

const seed = async (): Promise<z.infer<typeof worldSchema>> => {
  const stack = await readStack();
  if (stack.dataDir === null) throw new Error("the refine spec seeds a secret: it needs the stack's own data folder");
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-refine-world.ts"), JSON.stringify({ databaseUrl: stack.databaseUrl, dataDir: stack.dataDir, linear: stack.linear })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** The 1440px (or phone) screenshot in the theme given, for the by-eye check against the target. */
const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  await page.evaluate(() => { for (const node of [document.scrollingElement, ...document.querySelectorAll("main, [data-scroll]")]) node?.scrollTo(0, 0); });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.screenshot({ path: path.join(shots, `m6-${name}${phone ? "-phone" : ""}-${theme}-final.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** A 1×1 PNG, as a member's mock-up. */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("F-099/c6,c7: a member edits the agent's draft, uploads an image, then Update ticket and Mark ready write it to the fake Linear", async ({ page }) => {
  test.setTimeout(150_000);
  const world = await seed();
  const { linear } = await readStack();
  await signIn(page);
  await page.goto(`/tasks/${world.taskId}`);

  // A refine task opens on its draft: the agent's two versions, the second shown.
  const tab = page.getByTestId("draft-tab");
  await expect(tab).toBeVisible();
  await expect(page.getByTestId("task-read-only")).toHaveText("Read-only: this task never pushes");
  await expect(page.getByTestId("task-doing")).toContainText("Needs you · draft ready");
  await expect(page.getByTestId("task-pushes")).toHaveText("None: read-only");
  await expect(tab.locator("[data-version]")).toHaveText(["v1 · agent", "v2 · agent"]);
  await expect(tab.locator('[data-field="acceptanceCriteria"] input')).toHaveCount(3);
  await expect(page.getByTestId("draft-footnote")).toHaveText(`Update ticket writes version 2 to ${world.ticketKey ?? ""} on Linear and creates 2 sub-issues. Mark ready moves it to Todo.`);
  // Nothing is on Linear before a member acts.
  await expect(page.getByText("Nothing written yet. A draft reaches Linear only when someone presses Update ticket.")).toBeVisible();

  // The first version is the drafting fake's, read-only.
  await tab.locator('[data-version="1"]').click();
  await expect(page.getByTestId("draft-older")).toBeVisible();
  await expect(tab.locator('[data-field="acceptanceCriteria"] li')).toHaveText(["1The banner shows the name", "2A name with `<script>` stays text"]);
  await tab.locator('[data-version="2"]').click();

  // Edit a criterion: it saves itself as the member's version 3, with the agent's words under it.
  const criterion = page.getByLabel("Acceptance criteria 2", { exact: true });
  await criterion.fill("GET /version returns the version and the git SHA as JSON");
  await expect(tab.locator("[data-version]")).toHaveText(["v1 · agent", "v2 · agent", "v3 · your edit"]);
  await expect(page.getByTestId("draft-saved")).toHaveText("Saved just now");
  await expect(tab.getByTestId("draft-edited")).toHaveText("edited by you · the agent's: GET /version returns the version");

  // Upload an image.
  await tab.getByTestId("draft-upload-input").setInputFiles({ name: "version-mock.png", mimeType: "image/png", buffer: png });
  await expect(tab.locator('[data-image="version-mock.png"]')).toBeVisible();
  await expect(tab.locator('[data-field="images"]')).toContainText("1 of 10");
  await expect(page.getByTestId("draft-footnote")).toContainText("writes version 3");
  await shoot(page, "refine-draft");

  // The preview is what Update ticket writes.
  await page.getByRole("radio", { name: "Preview" }).click();
  await expect(page.getByTestId("draft-preview")).toContainText("GET /version returns the version and the git SHA as JSON");
  await expect(page.getByTestId("draft-preview")).toContainText("Linear has no field for acceptance criteria");
  await page.getByRole("radio", { name: "Edit" }).click();

  // Update ticket: core writes version 3 to the fake Linear, with the image and two sub-issues.
  await page.locator('[data-action="update-ticket"]').click();
  await expect(page.getByTestId("draft-applied")).toContainText(`Version 3 applied to ${world.ticketKey ?? ""}`);
  await expect(page.getByTestId("draft-written")).toHaveText(`${world.ticketKey ?? ""} is updated on Linear. 2 sub-issues created.`, { timeout: 30_000 });
  await expect(page.locator('[data-testid="draft-sync"] [data-row="description"]')).toHaveAttribute("data-state", "done");
  await expect(tab.locator('[data-image="version-mock.png"]')).toContainText("attached");

  // Mark ready: the ticket moves to the board's ready status, Todo.
  await page.locator('[data-action="mark-ready"]').click();
  await expect(page.locator('[data-testid="draft-sync"] [data-row="move"]')).toHaveAttribute("data-state", "done", { timeout: 30_000 });
  await expect(page.locator('[data-testid="draft-sync"] [data-row="move"]')).toContainText("Moved to Todo");
  await expect(page.getByTestId("draft-applied")).toContainText("moved to Todo");
  await expect(page.locator('[data-action="mark-ready"]')).toHaveCount(0);
  await shoot(page, "refine-draft-applied");

  // The fake Linear holds what the page said, read through the shipped adapter.
  const adapter = new LinearAdapter({ apiUrl: linear.apiUrl, auth: { kind: "api-key", token: linear.apiKey } });
  const read = await adapter.getTicketContext({ externalId: linear.teamId }, { externalId: externalTicketIdSchema.parse(world.externalId ?? "") });
  if (!read.ok) throw new Error(read.error.message);
  expect(read.value.ticket.description).toContain("GET /version returns the version and the git SHA as JSON");
  expect(read.value.ticket.description).toContain("## Acceptance criteria");
  expect(read.value.ticket.status.name).toBe("Todo");
  expect(read.value.attachments.map((attachment) => attachment.title)).toContain("version-mock.png");
  expect(read.value.children.map((child) => child.title).sort()).toEqual(["Add a /version endpoint", "Show the version in the footer"]);
  await expectNoHorizontalScroll(page);
});

test("F-099/c5: Needs you lists the draft as a draft ready, and the draft reads on a phone", async ({ page }) => {
  const world = await seed();
  await signIn(page);
  await page.goto("/needs-you");
  const row = page.getByTestId("needs-you-row").filter({ hasText: world.ticketKey ?? "" }).first();
  await expect(row).toContainText("Draft ready");
  await expect(row).toContainText("Review draft");
  await page.goto(`/tasks/${world.taskId}`);
  await expect(page.getByTestId("draft-tab")).toBeVisible();
  await expect(page.getByTestId("draft-tab").locator("[data-version]")).toHaveText(["v1 · agent", "v2 · agent"]);
  await expectNoHorizontalScroll(page);
  if ((page.viewportSize()?.width ?? 1440) < 600) await shoot(page, "refine-draft");
});
