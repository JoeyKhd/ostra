import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin, e2eFakeControlUrl, e2eSkillsRepo } from "./settings.ts";

// F-145, F-146 (milestone 8, ticket 31; app-targets/m8/library*.md, agent-profile-library.md): the
// skills and MCP library through the panel, against the stack's fakes. A skill installed by
// reference from the fake GitHub's public skills repo and attached to a profile; an MCP server from
// the API's fake registry with a secret header that never shows again; an upstream push, core's
// update check and its diff accepted; a member's suggestion installed by an admin; and the
// marketplace, off by default, then searched and a result installed. The server's calls out reach
// only the fakes (`library-fetch.ts`). The screens' rules alone are unit tests (`library-model.test.ts`).

const run = promisify(execFile);
const worldSchema = z.object({ username: z.string(), memberUsername: z.string(), profileId: z.string(), profileName: z.string() });
let world: z.infer<typeof worldSchema>;

/** The stub MCP server's token (`@ostra/api/testing`'s fake library): the secret header the server lists its tools for. */
const MCP_SECRET = "Bearer mcp-token-0f4c2a9e7b1d";

// Each test drives a whole flow, through look-ups, installs and core's jobs.
test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-library-world.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, tag: Date.now().toString(36) })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

const toast = (page: Page) => page.getByTestId("shell-toast");
const sheet = (page: Page) => page.getByTestId("add-from-source");

/** Opens the install sheet from the library's primary, on the kind asked for. */
const openInstall = async (page: Page, kind: "skill" | "mcp"): Promise<void> => {
  await page.goto("/organization/skills");
  await hydrated(page.locator("[data-action='add-from-source']"));
  await page.locator("[data-action='add-from-source']").click();
  await expect(sheet(page)).toBeVisible();
  if (kind === "mcp") await sheet(page).getByRole("radio", { name: "MCP server" }).click();
};

/** A second person in their own browser context. */
const asMember = async (browser: Browser): Promise<Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, world.memberUsername);
  return page;
};

test.describe("the skills and MCP library", { tag: "@desktop-only" }, () => {
  test("F-145/c1, F-145/c7: an admin installs a skill by reference, its files and scripts shown, and attaches it to a profile on Save", async ({ page }) => {
    await signIn(page, world.username);
    await openInstall(page, "skill");
    await sheet(page).getByTestId("install-source").fill(`${e2eSkillsRepo.owner}/${e2eSkillsRepo.name}@pdf`);
    await sheet(page).getByTestId("install-source").press("Enter");
    await expect(sheet(page).getByTestId("look-resolved")).toContainText("HEAD is");
    const commit = (await sheet(page).getByTestId("look-commit").textContent()) ?? "";
    expect(commit).toMatch(/^[0-9a-f]{7}$/);
    // The files with their sizes, the script pointed out, and the source not on the allowlist yet.
    await expect(sheet(page).locator("[data-file='SKILL.md']")).toBeVisible();
    await expect(sheet(page).locator("[data-file='scripts/extract.py']")).toContainText("script");
    await expect(sheet(page).getByTestId("allowlist-note")).toContainText(`github.com/${e2eSkillsRepo.owner}/${e2eSkillsRepo.name}`);
    await expect(sheet(page).locator("[data-action='install']")).toBeDisabled();
    await sheet(page).locator("[data-action='allow-source']").click();
    await expect(sheet(page).getByTestId("allowlist-note")).toHaveCount(0);
    await sheet(page).locator("[data-action='install']").click();
    await expect(toast(page)).toContainText(`pdf installed at ${commit}`);
    await expect(sheet(page)).toHaveCount(0);
    const row = page.locator("a[data-item='pdf']");
    await expect(row.locator("[data-pin]")).toHaveText(commit);

    // The profile editor's picker attaches it; it shows unsaved until Save, then pinned.
    await page.goto(`/organization/agent-profiles/${world.profileId}`);
    const button = page.locator("[data-action='attach-skill']");
    await hydrated(button);
    await button.click();
    await page.getByTestId("attach-picker").locator("[data-pick-name='pdf']").click();
    const attached = page.locator("[data-library-item='pdf'][data-origin='attached']");
    await expect(attached).toHaveAttribute("data-state", "added");
    await expect(attached.getByTestId("not-saved-yet")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator("[data-action='save-profile']").click();
    await expect(attached).toHaveAttribute("data-state", "saved");
    await page.reload();
    await expect(page.locator("[data-library-item='pdf'][data-origin='attached']")).toContainText(commit);
    await page.goto("/organization/skills");
    await expect(page.locator("a[data-item='pdf']")).toContainText("1 profile");
  });

  test("F-145/c4: an MCP server installs from a registry with its secret header, which the page never shows again, and its test call lists its tools", async ({ page }) => {
    await signIn(page, world.username);
    // The API's fake registry joins the organization's list of sources, from the library's policy.
    await page.goto("/organization/skills");
    await hydrated(page.locator("[data-action='edit-policy']"));
    await page.locator("[data-action='edit-policy']").click();
    const sources = page.getByTestId("sources-sheet");
    await sources.getByRole("combobox").click();
    await page.getByRole("option", { name: "An MCP registry" }).click();
    await sources.getByTestId("source-value").fill("https://registry.example.test");
    await sources.locator("[data-action='add-source']").click();
    await expect(sources.locator("[data-source-entry='registry registry.example.test']")).toBeVisible();
    await page.keyboard.press("Escape");

    await openInstall(page, "mcp");
    await sheet(page).getByTestId("install-registry").click();
    await page.getByRole("option", { name: "registry.example.test" }).click();
    await sheet(page).getByTestId("install-server-name").fill("io.example/notes");
    await sheet(page).getByTestId("install-server-name").press("Enter");
    await expect(sheet(page).getByTestId("look-resolved")).toContainText("v1.0.0");
    const secret = sheet(page).getByTestId("secret-input");
    await expect(secret).toHaveAttribute("type", "password");
    await secret.fill(MCP_SECRET);
    await sheet(page).locator("[data-action='install']").click();
    const tested = sheet(page).getByTestId("test-call");
    await expect(tested.locator("[data-tool='search_notes']")).toBeVisible();
    await expect(tested.locator("[data-tool='read_note']")).toBeVisible();
    // Stored, the secret is gone from the page: its field is empty and says where it is.
    await expect(secret).toHaveValue("");
    await sheet(page).locator("[data-action='install-done']").click();

    await page.locator("a[data-item='notes']").click();
    await expect(page.getByTestId("server-tab").locator("[data-input='Authorization']")).toContainText("in the secret store");
    await expect(page.locator("body")).not.toContainText("mcp-token-0f4c2a9e7b1d");
    const answer = await page.request.get(`/api/trpc/library.list`);
    expect(await answer.text()).not.toContain("mcp-token-0f4c2a9e7b1d");
  });

  test("F-145/c10, F-145/c11: a push upstream shows as an update with its diff, which an admin accepts, moving the pin", async ({ page }) => {
    await signIn(page, world.username);
    const pushed = z.object({ sha: z.string() }).parse(await (await fetch(`${e2eFakeControlUrl}/skills/push`, { method: "POST" })).json());
    await page.goto("/organization/skills");
    await page.locator("a[data-item='pdf']").click();
    await hydrated(page.locator("[data-action='check-updates']"));
    await page.locator("[data-action='check-updates']").click();
    // Core's check runs as a job; the page asks again until the update shows.
    await expect(page.getByTestId("update-tab")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("update-to")).toHaveText(pushed.sha.slice(0, 7));
    const diff = page.getByTestId("update-diff");
    await expect(diff.locator("[data-diff-file='SKILL.md']")).toBeVisible();
    await expect(diff.locator("[data-diff-file='signing.md']")).toContainText("added");
    await expect(diff.getByTestId("diff-lines")).toContainText("Reads, fills and signs PDF forms.");
    await page.locator("[data-action='accept-update']").click();
    await expect(page.getByTestId("update-tab")).toHaveCount(0);
    await expect(page.getByTestId("item-pin")).toHaveText(pushed.sha.slice(0, 7));
    await expect(toast(page)).toContainText(`Moved to ${pushed.sha.slice(0, 7)}`);
  });

  test("F-145/c9: a member reads the library and suggests a skill; an admin installs it, and the member sees the answer", async ({ page, browser }) => {
    const member = await asMember(browser);
    await member.goto("/organization/skills");
    await expect(member.locator("[data-action='add-from-source']")).toHaveCount(0);
    await hydrated(member.locator("[data-action='suggest']"));
    await member.locator("[data-action='suggest']").click();
    await member.getByTestId("suggest-reference").fill(`${e2eSkillsRepo.owner}/${e2eSkillsRepo.name}@writer`);
    await member.getByTestId("suggest-note").fill("We write release notes every Friday.");
    await member.locator("[data-action='send-suggestion']").click();
    await expect(member.getByTestId("suggest-sent")).toContainText("on the allowlist");
    const mine = member.locator(`[data-my-suggestion='${e2eSkillsRepo.owner}/${e2eSkillsRepo.name}@writer']`);
    await expect(mine).toHaveAttribute("data-state", "open");

    await signIn(page, world.username);
    await page.goto("/organization/skills/suggestions");
    await expect(page.getByTestId("suggestion-note")).toHaveText("We write release notes every Friday.");
    await page.locator("[data-action='install-suggestion']").click();
    await expect(sheet(page).getByTestId("install-origin")).toContainText(`Suggested by ${world.memberUsername}`);
    await expect(sheet(page).getByTestId("look-resolved")).toBeVisible();
    await sheet(page).locator("[data-action='install']").click();
    await expect(toast(page)).toContainText("writer installed at");
    await page.goto("/organization/skills/suggestions?tab=decided");
    await expect(page.locator(`[data-suggestion='${e2eSkillsRepo.owner}/${e2eSkillsRepo.name}@writer']`)).toContainText("Installed");

    await member.goto("/organization/skills?suggest=1");
    await expect(mine).toHaveAttribute("data-state", "installed");
    await expect(mine).toContainText(`Installed by ${world.username}`);
    await member.context().close();
  });

  test("F-146/c3: the marketplace is off by default, for an admin and a member, and the policy's switch turns it on, saying what a search sends where", async ({ page, browser }) => {
    await signIn(page, world.username);
    await page.goto("/organization/skills/marketplace");
    await expect(page.getByTestId("marketplace-off")).toBeVisible();
    await expect(page.getByTestId("search-sends")).toContainText("skills.sh");
    const member = await asMember(browser);
    await member.goto("/organization/skills/marketplace");
    await expect(member.getByTestId("marketplace-off")).toBeVisible();
    await member.context().close();

    await page.goto("/organization/skills");
    const toggle = page.getByTestId("marketplace-switch");
    await hydrated(toggle);
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await expect(page.getByTestId("search-words")).toContainText("skills.sh");
    await expect(page.getByRole("link", { name: "Browse marketplace" })).toBeVisible();
  });

  test("F-146/c1: an admin searches skills.sh through the server and installs a result through the same install", async ({ page }) => {
    await signIn(page, world.username);
    await page.goto("/organization/skills/marketplace");
    const field = page.getByTestId("marketplace-search");
    await hydrated(field);
    await field.fill("review");
    await field.press("Enter");
    const results = page.getByTestId("marketplace-results");
    await expect(results.locator("[data-result='writer']")).toContainText("In the library");
    const review = results.locator("[data-result='review']");
    await expect(review).toContainText("skills-org/skills");
    await review.locator("[data-action='install-result']").click();
    await expect(sheet(page).getByTestId("install-origin")).toContainText("From skills.sh");
    await expect(sheet(page).getByTestId("look-resolved")).toBeVisible();
    await sheet(page).locator("[data-action='install']").click();
    await expect(toast(page)).toContainText("review installed at");
    await expect(page.locator("a[data-item='review']")).toBeVisible();
  });
});
