import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { cliDeviceResponseSchema, cliDeviceTokenResponseSchema, cliPaths } from "@ostra/protocol";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eAdmin, e2eGitHubMember, e2eRepo } from "./settings.ts";

// F-054, F-028, F-103, F-119 (milestone 3's ticket 47): the Checks tab, Take it local, the device
// page for `ostra login`, and Account, on the fake GitHub. The project is made through New project on
// `test1`; the turn's check runs, which a runner reports, are seeded as ingest writes them
// (`seed-step-in.ts`), since this stack runs no agent. The CLI's two device calls are made as
// `ostra login` makes them, and GitHub's sign-in page is answered with the fake's code for
// `e2eGitHubMember`, which the panel trades with the fake GitHub as it would with GitHub. Q295's two
// cases give the App its OAuth client secret through the panel: on "Use an existing App" in an
// organization of its own, and later on the GitHub page of the first organization.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets
// (app-targets/m3/task-checks.webp, take-it-local.webp, account.webp; app-targets/m1/device.png).

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];
const seedScript = path.join(import.meta.dirname, "seed-step-in.ts");
const webDir = path.resolve(import.meta.dirname, "..");
const checksWorldSchema = z.object({ taskId: z.string(), failingCheckId: z.string(), failingTail: z.string() });
const githubOrgSchema = z.object({ organizationId: z.string(), admin: z.string(), member: z.string() });

const seed = async (args: object): Promise<unknown> => {
  const { stdout } = await run(process.execPath, [seedScript, JSON.stringify(args)], { cwd: webDir });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

/** A page in a context of its own, signed in as `username` (the e2e password). */
const pageAs = async (browser: Browser, username: string): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, username);
  return page;
};

/**
 * Plays GitHub's sign-in page: the panel's start is read as the panel gave it, and the member goes
 * straight back to its callback with the fake's code for `e2eGitHubMember` and the state. Answers
 * the sign-in URLs the panel sent the member to.
 */
const answerGitHubSignIn = async (page: Page, linkCode: string): Promise<URL[]> => {
  const asked: URL[] = [];
  await page.route((url) => url.pathname === "/api/github/link/start", async (route) => {
    const started = await route.fetch({ maxRedirects: 0 });
    const url = new URL(started.headers()["location"] ?? "");
    asked.push(url);
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", linkCode);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  return asked;
};

/** Account's Link GitHub account, through the fake's sign-in, back linked as `e2eGitHubMember`. */
const linkThroughGitHub = async (page: Page, linkCode: string): Promise<URL[]> => {
  const asked = await answerGitHubSignIn(page, linkCode);
  await page.goto("/account");
  await expect(page.locator('[data-github="not-linked"]')).toBeVisible();
  await page.locator('[data-action="link-github"]').click();
  await expect(page.getByText(`Linked as @${e2eGitHubMember.login}.`)).toBeVisible();
  await expect(page.locator('[data-github="linked"]')).toContainText(`@${e2eGitHubMember.login}`);
  await expect(page.locator('[data-github="linked"]')).toContainText(`ID ${e2eGitHubMember.userId}`);
  return asked;
};

/** Unlink, so the fake's GitHub account is free for the next case. */
const unlinkGitHub = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
  await expect(page.locator('[data-github="not-linked"]')).toBeVisible();
  await expect(page.getByText("Unlinked.")).toBeVisible();
};

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.screenshot({ path: path.join(shots, `m3-${name}${phone ? "-phone" : ""}.png`) });
};

/** A project on the fake GitHub's test1, through New project, and a task in it whose turn ran two checks. */
const seedChecksWorld = async (page: Page): Promise<z.infer<typeof checksWorldSchema>> => {
  await ensureGitHub(page);
  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/test1`) }).check();
  await page.getByLabel("Name", { exact: true }).fill(`calc-checks-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  const projectId = new URL(page.url()).pathname.split("/")[2] ?? "";
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [seedScript, JSON.stringify({ part: "checks", databaseUrl, projectId })], { cwd: webDir });
  return checksWorldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

test("F-054/c2: a failing check shows its output, and Ask the agent to fix sends it to the agent", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const world = await seedChecksWorld(page);
  await page.goto(`/tasks/${world.taskId}?tab=checks`);
  await expect(page.getByText("PR #21 is a draft")).toBeVisible();
  await expect(page.locator('[data-check="lint"]')).toHaveAttribute("data-status", "passed");
  await expect(page.locator('[data-check="unit-tests"]')).toHaveAttribute("data-status", "failed");
  // A failing check opens on its output.
  const output = page.locator(`[data-output="${world.failingCheckId}"]`);
  await expect(output).toContainText("AssertionError: expected 5 to be 4");
  await expect(output).toContainText("Tests  1 failed | 11 passed (12)");
  await shoot(page, "task-checks");
  await page.locator('[data-action="fix-checks"]').click();
  await expect(page.getByText(/^Asked .+ to fix it at /)).toBeVisible();
  await expect(page.locator('[data-action="fix-checks"]')).toHaveCount(0);
  // The message the agent gets: the failing check's command and output, in the task's thread.
  await page.getByRole("button", { name: "See it in Activity" }).click();
  await expect(page.getByText("AssertionError: expected 5 to be 4").first()).toBeVisible();
  await expect(page.getByText("pnpm test").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("F-028/c1: Take it local shows the ostra checkout line, the login hint and the git commands, and copies the line", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const world = await seedChecksWorld(page);
  await page.goto(`/tasks/${world.taskId}`);
  await page.locator('[data-action="take-it-local"]').click();
  const card = page.getByRole("dialog").filter({ hasText: "Take it local" });
  const checkout = card.locator("code").filter({ hasText: /^ostra checkout / });
  await expect(checkout).toBeVisible();
  const line = (await checkout.textContent()) ?? "";
  expect(line).toMatch(/^ostra checkout \S+$/);
  // No CLI session yet: the login hint and its line.
  await expect(card).toContainText("First time on this machine? Run ostra login, then approve its code in the browser.");
  await expect(card.locator("code").filter({ hasText: /ostra login --server / })).toBeVisible();
  // The plain git commands for the task's one repo.
  const branch = await card.locator(`[data-repo="${e2eRepo.owner}/test1"] pre`).textContent();
  expect(branch).toMatch(/^git fetch origin ostra\/\S+\ngit switch ostra\/\S+$/);
  await shoot(page, "take-it-local");
  // Copy puts the line on the clipboard and says so.
  await card.getByRole("button", { name: "Copy" }).and(card.locator(`[data-copy="${line}"]`)).click();
  await expect(card.getByRole("status").filter({ hasText: /^Copied$/ })).toHaveCount(1);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
});

test("F-103/c4: a CLI session approved on the device page shows in Account, and Revoke ends it", async ({ page, request }) => {
  await signIn(page);
  const machine = `e2e-laptop-${Date.now().toString(36)}`;
  // `ostra login`: start the grant, as the CLI does.
  const started = cliDeviceResponseSchema.parse(await (await request.post(cliPaths.device, { data: { name: machine, version: "0.0.0-e2e" } })).json());
  // The member approves the code on the device page, which names what it signs in.
  await page.goto(started.verificationUrlComplete);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in the ostra CLI");
  await expect(page.getByText(`Sign in the ostra CLI on ${machine}.`)).toBeVisible();
  await expect(page.getByText("It becomes your personal runner")).toHaveCount(0);
  await shoot(page, "device-cli");
  await page.getByRole("button", { name: "Approve sign-in" }).click();
  await expect(page.getByText("Approved. The CLI finishes signing in on its own.")).toBeVisible();
  // The CLI's poll gets the session, which then reads a task's branches as the member.
  const polled = await request.post(cliPaths.deviceToken, { data: { deviceCode: started.deviceCode } });
  const session = cliDeviceTokenResponseSchema.parse(await polled.json());
  const authorization = { authorization: `Bearer ${session.token}` };
  expect((await request.get(cliPaths.taskBranches("OST-0"), { headers: authorization })).status()).toBe(404);

  // Account lists it with its machine, and Revoke ends it.
  await page.getByRole("link", { name: "Open Account" }).click();
  await page.waitForURL(/\/account$/);
  const row = page.locator(`[data-session="${session.sessionId}"]`);
  await expect(row).toContainText(machine);
  // Used once just now, by the read above.
  await expect(row).not.toContainText("never");
  await shoot(page, "account");
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("Revoked.")).toBeVisible();
  expect((await request.get(cliPaths.taskBranches("OST-0"), { headers: authorization })).status()).toBe(401);
  await expectNoHorizontalScroll(page);
});

test("F-119/c1: an existing App connected with its client secret lets a member link their GitHub account through the App's sign-in", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const { databaseUrl, github } = await readStack();
  const world = githubOrgSchema.parse(await seed({ part: "github-org", databaseUrl, password: e2eAdmin.password }));
  // The admin of an organization with no GitHub App connects the fake's with "Use an existing App",
  // its OAuth client secret among the values (Q295). GitHub answers the client ID itself.
  await signIn(page, world.admin);
  await page.goto("/organization/github");
  await page.getByLabel("App ID").fill(github.appId);
  await page.getByLabel("Private key", { exact: true }).fill(github.privateKey);
  await page.getByLabel("Webhook secret").fill(github.webhookSecret);
  await page.getByLabel("Client secret").fill(github.clientSecret);
  await page.getByRole("button", { name: "Connect the App" }).click();
  await expect(page.locator(`[data-testid="github-app"][data-slug="${github.slug}"]`)).toBeVisible();
  await expect(page.getByTestId("member-linking-off")).toHaveCount(0);
  expect(await page.content()).not.toContain(github.clientSecret);

  // A member links at once, through the App's own sign-in with its client ID.
  const member = await pageAs(browser, world.member);
  const asked = await linkThroughGitHub(member, github.linkCode);
  expect(asked).toHaveLength(1);
  expect(asked[0]?.searchParams.get("client_id")).toMatch(/^Iv1\./);
  await unlinkGitHub(member);
  await member.context().close();
});

test("F-119/c1,c2: without the App's client secret Account says an admin must add it; once an admin adds it on the GitHub page, Link GitHub account goes through GitHub's sign-in and comes back linked as the account's login; Unlink clears it", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await signIn(page);
  await ensureGitHub(page);
  const { databaseUrl, github } = await readStack();
  // The first organization's App, as "Use an existing App" without a client secret leaves it (Q295).
  await seed({ part: "github-link-reset", databaseUrl });
  const username = "e2e-step-in-member";
  await run(process.execPath, [path.join(import.meta.dirname, "seed-member.ts"), JSON.stringify({ databaseUrl, username, password: e2eAdmin.password })], { cwd: webDir });

  // A member's Account says what an organization admin must do, and offers no link.
  const member = await pageAs(browser, username);
  await member.goto("/account");
  await expect(member.locator('[data-github="not-linked"]')).toContainText("Linking isn't on yet: the GitHub App has no client secret.");
  await expect(member.getByTestId("github-needs-secret")).toHaveText("An organization admin needs to add the GitHub App's client secret on the GitHub page. Then you can link your account here.");
  await expect(member.locator('[data-action="link-github"]')).toHaveCount(0);
  await expect(member.getByText("GitHub isn't connected to this install yet.")).toHaveCount(0);

  // The GitHub page says member linking is off, and the admin adds the secret there.
  await page.goto("/organization/github");
  const off = page.getByTestId("member-linking-off");
  await expect(off).toContainText("Member linking is off until the App's client secret is added.");
  await off.getByRole("button", { name: "Add client secret" }).click();
  const form = page.getByTestId("client-secret-form");
  await form.getByLabel("Client secret").fill(github.clientSecret);
  await form.getByRole("button", { name: "Save client secret" }).click();
  await expect(page.getByText("Client secret saved. Members can link their GitHub accounts on Account.")).toBeVisible();
  await expect(off).toHaveCount(0);
  expect(await page.content()).not.toContain(github.clientSecret);

  // Linking is on: the member's sign-in is the App's, on the GitHub the install talks to (here the
  // fake), with its client ID and no scope.
  const asked = await linkThroughGitHub(member, github.linkCode);
  expect(asked).toHaveLength(1);
  expect(asked[0]?.pathname).toBe("/login/oauth/authorize");
  expect(asked[0]?.searchParams.get("client_id")).toMatch(/^Iv1\./);
  expect(asked[0]?.searchParams.get("redirect_uri")).toMatch(/\/api\/github\/link\/callback$/);
  expect(asked[0]?.searchParams.has("scope")).toBe(false);
  // No code, state or token stays in the address.
  expect(member.url()).not.toContain(github.linkCode);
  await shoot(member, "account-linked");
  await unlinkGitHub(member);
  await member.context().close();
});
