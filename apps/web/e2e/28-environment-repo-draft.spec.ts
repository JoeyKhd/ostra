import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// F-112/c1 for a repo added after the environment was saved (Q345 option (b),
// environment-repo-draft.md): the Setup tab shows the new repo's draft beside the saved setup, and a
// project admin applies it (saved at once), edits it first (its lines in the editors, marked, kept
// by Save) or dismisses it (with Undo), through the panel, the API, the domain's use cases and the
// database; a member sees it without buttons, and the other tabs point to it. The draft is seeded as
// `projects.addRepo` stores it (`seed-repo-draft-world.ts`: detection's own reading of the repo's
// files); adding the repo and its detection are proved on Postgres in
// packages/api/src/routers/environment-repo-drafts.test.ts. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with the targets (app-targets/m10-gaps/environment-repo-draft*).

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({ username: z.string(), memberUsername: z.string(), projectId: z.string(), engineRepoId: z.string(), docsRepoId: z.string().nullable(), mobileRepoId: z.string().nullable() });
type World = z.infer<typeof worldSchema>;

const seed = async (options: { readonly plain?: boolean; readonly docs?: boolean; readonly mobile?: boolean } = {}): Promise<World> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-repo-draft-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag: `rd-${Date.now().toString(36)}`, ...options })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const band = (page: Page): Locator => page.getByTestId("repo-draft-band");
const draftOf = (page: Page, repo: string): Locator => page.locator(`[data-testid='repo-draft'][data-repo='${repo}']`);
const script = (page: Page): Locator => page.getByRole("textbox", { name: "Setup script" });

const openSetup = async (page: Page, world: World): Promise<void> => {
  await page.goto(`/projects/${world.projectId}/environment`);
  await expect(page.getByRole("heading", { level: 1, name: "Environment" })).toBeVisible();
  await hydrated(script(page));
};

test.describe.configure({ mode: "serial" });

test("F-112/c1: a project admin reviews a new repo's draft beside the saved setup: Edit first puts its lines in the editors, marked, and Cancel takes them out; Dismiss leaves the setup as it is, with Undo; Apply saves it at once", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop page");
  test.setTimeout(120_000);
  const world = await seed();
  await signIn(page, world.username);
  await openSetup(page, world);

  // The band and the draft: why, the lines Apply adds (unchanged lines folded) and its variables.
  await expect(band(page).getByRole("heading", { name: "New repo, not in the setup yet" })).toBeVisible();
  const draft = draftOf(page, "acme/calculator-engine");
  await expect(draft).toContainText("added by Alex Kim · 20 min ago");
  await expect(draft).toContainText("Its tasks run the saved setup as it is, and its case has no branch for this repo, so they set up nothing.");
  const diff = draft.getByTestId("repo-draft-diff");
  await expect(diff.getByRole("button", { name: "10 lines unchanged" })).toBeVisible();
  await expect(diff.locator("[data-line='add'] > span:last-child")).toHaveText(["Added:   'acme/calculator-engine')", "Added:     uv sync --frozen", "Added:     ;;"]);
  await expect(draft.getByRole("list", { name: "Variables and secrets" }).locator("li")).toHaveText([/^\+ENGINE_LOG_LEVEL/, /^\+ENGINE_API_KEY.*secret$/]);
  await expect(draft.getByRole("button", { name: /^(Dismiss|Edit first|Apply)$/ })).toHaveText(["Dismiss", "Edit first", "Apply"]);
  // The panel: the new repo marked among the repos, and what detection found in it.
  await expect(page.getByTestId("environment-repos")).toContainText("acme/calculator-enginenew");
  await expect(page.getByTestId("repo-draft-found")).toContainText("Found in acme/calculator-engine");
  await expect(page.getByTestId("repo-draft-found")).toContainText("uv.lock");
  await expect(page.getByTestId("repo-draft-found")).toContainText("python 3.12");
  await diff.getByRole("button", { name: "10 lines unchanged" }).click();
  await expect(diff.locator("[data-line]")).toHaveCount(15);

  // The other tabs point to it.
  await page.getByRole("tab", { name: "Services and checks" }).click();
  await expect(page.getByTestId("repo-draft-pointer")).toContainText("New repo, not in the setup yet");
  await page.getByTestId("repo-draft-pointer").getByRole("button", { name: "Review it on Setup" }).click();
  await expect(band(page)).toBeVisible();

  // Edit first: the lines in the editor, marked and unsaved; the repo's rows too; Cancel drops them.
  const saved = await script(page).inputValue();
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Edit first" }).click();
  await expect(page.getByText("Editing · not saved yet")).toBeVisible();
  await expect(page.getByTestId("repo-draft-editing")).toContainText("Editing acme/calculator-engine's lines, marked below. Save to keep them.");
  await expect(script(page)).toBeFocused();
  expect(await script(page).inputValue()).toContain("  'acme/calculator-engine')\n    uv sync --frozen\n    ;;\nesac");
  await expect(page.getByTestId("code-editor").locator("[data-marked]")).toHaveCount(3);
  await expect(page.locator("tr[data-marked]")).toHaveCount(2);
  await page.getByTestId("repo-draft-editing").getByRole("button", { name: "Cancel" }).click();
  await expect(band(page)).toBeVisible();
  expect(await script(page).inputValue()).toBe(saved);
  await expect(page.locator("tr[data-marked]")).toHaveCount(0);

  // Dismiss: the setup as it is, with Undo.
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Dismiss" }).click();
  const said = page.getByTestId("repo-draft-said");
  await expect(said).toContainText("Dismissed. acme/calculator-engine runs the saved setup as it is.");
  await expect(band(page)).toHaveCount(0);
  await said.getByRole("button", { name: "Undo" }).click();
  await expect(band(page)).toBeVisible();

  // Apply: saved at once; the band leaves, the script has the repo's branch, and its secret waits for a value.
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Apply" }).click();
  await expect(said).toContainText("Saved. acme/calculator-engine has its own lines now.");
  await expect(band(page)).toHaveCount(0);
  await expect.poll(() => script(page).inputValue()).toContain("  'acme/calculator-engine')\n    uv sync --frozen\n    ;;\nesac");
  await expect(page.locator("tr[data-marked]")).toHaveCount(1);
  await expect(page.locator("tr[data-marked] input").first()).toHaveValue("ENGINE_API_KEY");
  await page.reload();
  await hydrated(script(page));
  await expect(band(page)).toHaveCount(0);
  await expect(page.getByText("Saved just now")).toBeVisible();
  expect(await script(page).inputValue()).toContain("'acme/calculator-engine')");
});

test("F-112/c1: Edit first and Save keep the new repo's lines and take its draft in; a member sees the draft without its buttons", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop page");
  test.setTimeout(120_000);
  const world = await seed({ plain: true, docs: true });
  await signIn(page, world.username);
  await openSetup(page, world);
  // Two new repos: one row each, the first open and the second folded to its head.
  await expect(band(page).getByRole("heading", { name: "New repos, not in the setup yet" })).toBeVisible();
  await expect(draftOf(page, "acme/calculator-engine")).toContainText("Its tasks run the saved setup as it is: the pnpm lines, in a Python repo.");
  await expect(draftOf(page, "acme/calculator-docs").getByRole("button", { name: "acme/calculator-docs" })).toHaveAttribute("aria-expanded", "false");
  await draftOf(page, "acme/calculator-docs").getByRole("button", { name: "acme/calculator-docs" }).click();
  await expect(draftOf(page, "acme/calculator-docs")).toContainText("Detection found nothing to set up in it");
  await expect(draftOf(page, "acme/calculator-docs").getByRole("button", { name: /^(Dismiss|Edit first|Apply)$/ })).toHaveText(["Dismiss"]);

  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Edit first" }).click();
  expect(await script(page).inputValue()).toContain('case "$OSTRA_REPO" in');
  // The secret needs its value before it's kept.
  await page.locator("tr[data-marked][data-kind='secret']").getByLabel("Secret value").fill("e2e-engine-key-0123");
  await page.getByRole("button", { name: "Save environment" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." }).first()).toBeVisible();
  await expect(page.getByTestId("repo-draft-editing")).toHaveCount(0);
  // The engine's draft is done; the docs one waits.
  await expect(band(page).getByRole("heading", { name: "New repo, not in the setup yet" })).toBeVisible();
  await expect(draftOf(page, "acme/calculator-engine")).toHaveCount(0);

  // A member: the same band and draft, no buttons, and the member's foot.
  await page.context().clearCookies();
  await signIn(page, world.memberUsername);
  await openSetup(page, world);
  await expect(draftOf(page, "acme/calculator-docs")).toContainText("A project admin applies it, edits it first or dismisses it.");
  await expect(draftOf(page, "acme/calculator-docs").getByRole("button", { name: /^(Dismiss|Edit first|Apply)$/ })).toHaveCount(0);
});

test("F-112/c1: on a phone the draft's head stacks, its diff scrolls inside its box and its buttons go full width under the foot", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the phone's layout");
  const world = await seed();
  await signIn(page, world.username);
  await openSetup(page, world);
  const draft = draftOf(page, "acme/calculator-engine");
  await expect(draft).toContainText("added by Alex Kim · 20 min ago");
  await expect(draft.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  const apply = await draft.getByRole("button", { name: "Apply", exact: true }).boundingBox();
  expect(apply?.height).toBe(44);
  await expectNoHorizontalScroll(page);
});

// ── The side-by-side shots (OSTRA_E2E_SHOTS): the targets' demo world, at their sizes ────────────

const shootPage = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

/** One state: the main column's part from the band (or its status line) down, dark only. */
const shootState = async (page: Page, name: string, locator: Locator): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await locator.screenshot({ path: path.join(shots, `state-${name}.png`) });
};

test("the targets' shots: the draft, Edit first, the states and the phone", async ({ page, isMobile }) => {
  test.skip(shots === undefined, "OSTRA_E2E_SHOTS names the folder for the side-by-side shots");
  test.setTimeout(240_000);
  const world = await seed();
  await signIn(page, world.username);
  if (isMobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSetup(page, world);
    await expect(band(page)).toBeVisible();
    await shootPage(page, "environment-repo-draft-phone");
    return;
  }
  await page.setViewportSize({ width: 1440, height: 956 });
  await openSetup(page, world);
  await expect(band(page)).toBeVisible();
  await shootPage(page, "environment-repo-draft");
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Edit first" }).click();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await shootPage(page, "environment-repo-draft-edit");
  await page.evaluate(() => { document.querySelector("tr[data-marked]")?.scrollIntoView({ block: "center" }); });
  await shootState(page, "edit-rows", page.locator("section:has(tr[data-marked])"));
  await page.getByTestId("repo-draft-editing").getByRole("button", { name: "Cancel" }).click();
  // Dismissed, then applied.
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Dismiss" }).click();
  await shootState(page, "dismissed", page.getByTestId("repo-draft-said"));
  await page.getByTestId("repo-draft-said").getByRole("button", { name: "Undo" }).click();
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("repo-draft-said")).toContainText("Saved.");
  await shootState(page, "applied", page.getByTestId("repo-draft-said"));
  // A plain saved script, with a second repo where detection found nothing.
  const plain = await seed({ plain: true, docs: true });
  await openSetup(page, plain);
  await shootState(page, "plain", draftOf(page, "acme/calculator-engine"));
  await draftOf(page, "acme/calculator-docs").getByRole("button", { name: "acme/calculator-docs" }).click();
  await shootState(page, "nothing", draftOf(page, "acme/calculator-docs"));
  // Two new repos, folded but the first.
  const two = await seed({ mobile: true });
  await openSetup(page, two);
  await draftOf(page, "acme/calculator-engine").getByRole("button", { name: "acme/calculator-engine" }).click();
  await shootState(page, "two", band(page));
  // A member.
  await page.context().clearCookies();
  await signIn(page, world.memberUsername);
  const member = await seed();
  await openSetup(page, member);
  await shootState(page, "member", band(page));
});
