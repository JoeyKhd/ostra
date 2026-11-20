import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eGitHubOrgB } from "./settings.ts";

// F-136 (ticket 54): repos from several GitHub organizations in the panel. The fake GitHub of the
// e2e stack has the App installed on a second account, which waits to be linked: it shows with
// "Link" and "Remove", and its repos are offered nowhere until an admin links it. "Connect another
// App" shows the App's own webhook address and a generated secret, once. The setup form sends the
// answer it was given on whether other accounts install the App. The live run with a second real
// GitHub organization is ticket 55, the maintainer's step.

test.describe.configure({ mode: "serial" });

/** New project's repos: every full name the picker offers. */
const offeredRepos = async (page: Page): Promise<string[]> => {
  await page.goto("/projects/new");
  const list = page.getByTestId("repo-options");
  await expect(list).toBeVisible();
  return list.locator("[data-repo]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-repo") ?? ""));
};

test("F-136: a waiting installation is shown with Link and Remove, and its repos aren't offered until it's linked", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/github");
  const waiting = page.locator(`[data-testid="installation"][data-account="${e2eGitHubOrgB.login}"]`);
  await expect(waiting).toHaveAttribute("data-state", "waiting");
  await expect(waiting).toContainText("Waiting to be linked");
  await expect(waiting.getByRole("button", { name: "Link" })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByText("A stranger who installs a public App reaches nothing", { exact: false })).toBeVisible();

  // Selecting it says what linking does; its install link is there to send.
  await waiting.getByRole("button", { name: e2eGitHubOrgB.login }).click();
  await expect(page.getByTestId("installation-panel")).toContainText("Link it if it's a client's");

  // While it waits, New project offers none of its repos.
  expect((await offeredRepos(page)).some((repo) => repo.startsWith(`${e2eGitHubOrgB.login}/`))).toBe(false);

  await page.goto("/organization/github");
  await waiting.getByRole("button", { name: "Link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "is linked" })).toContainText(`${e2eGitHubOrgB.login} is linked. Its repos can join projects.`);
  await expect(waiting).toHaveAttribute("data-state", "linked");
  await expect(waiting.getByRole("button", { name: "Unlink" })).toBeVisible();

  // Linked: its repos are offered, grouped under its account.
  expect(await offeredRepos(page)).toContain(`${e2eGitHubOrgB.login}/${e2eGitHubOrgB.repo}`);
  await expect(page.getByTestId("repo-group").filter({ hasText: e2eGitHubOrgB.login })).toBeVisible();

  // Unlink again, so the next run starts from a waiting installation.
  await page.goto("/organization/github");
  await waiting.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
  await expect(waiting).not.toHaveAttribute("data-state", "linked");
  await expectNoHorizontalScroll(page);
});

test("F-136: Connect another App shows the webhook address and the secret once", { tag: "@desktop-only" }, async ({ page }) => {
  const { githubB } = await readStack();
  await signIn(page);
  await page.goto("/organization/github");
  await page.getByRole("button", { name: "Connect another App" }).click();
  const form = page.getByRole("form", { name: "Connect another App" });
  await form.getByLabel("App ID").fill(githubB.appId);
  await form.getByLabel("Private key", { exact: true }).fill(githubB.privateKey);
  await form.getByRole("button", { name: "Connect the App" }).click();

  const once = page.getByTestId("shown-once");
  await expect(once).toContainText("Set these in the App's settings on GitHub");
  const url = await once.getByTestId("webhook-url").textContent();
  const secret = (await once.getByTestId("webhook-secret").textContent()) ?? "";
  expect(url).toMatch(/\/webhooks\/github\/[0-9a-f-]{36}$/);
  expect(secret.length).toBeGreaterThanOrEqual(32);
  await expect(once).toContainText("The secret is shown once.");
  await once.getByRole("button", { name: "Done" }).click();

  // Its own section, with its own webhook address; the secret appears nowhere again.
  const section = page.locator(`[data-testid="github-app"][data-slug="${githubB.slug}"]`);
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: new RegExp(githubB.slug) }).first().click();
  await expect(page.getByTestId("app-panel")).toContainText(url ?? "");

  // The client's App is private: the panel says only its owner can install it, that public is one
  // way, and links to the App's own setting on GitHub.
  await page.getByRole("button", { name: "Add a GitHub organization", exact: true }).click();
  const privateApps = page.getByTestId("private-apps");
  await expect(privateApps).toContainText(`GitHub lets only its owner install a private App, so ${githubB.slug} stays on client-c.`);
  await expect(privateApps).toContainText("Making an App public is one way: once another account installs it, it can't be made private again.");
  await expect(privateApps.getByRole("link", { name: /The App's settings on GitHub/ })).toHaveAttribute("href", `https://github.com/organizations/client-c/settings/apps/${githubB.slug}/advanced`);
  await page.reload();
  expect(await page.content()).not.toContain(secret);
});

test("F-136: the GitHub page's two buttons and its installations fit the screen", async ({ page }) => {
  await signIn(page);
  await page.goto("/organization/github");
  await expect(page.locator('[data-testid="installation"]').first()).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  for (const name of ["Connect another App", "Add a GitHub organization"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), name).toBeLessThanOrEqual(width);
  }
  await expectNoHorizontalScroll(page);
});

const batchSchema = z.array(z.unknown());

/** Answers `github.connections` with no App, so the page shows the setup form (milestone 1's `github-not-connected`). */
const noAppYet = async (route: Route): Promise<void> => {
  const url = new URL(route.request().url());
  const procedures = url.pathname.replace(/^.*\/api\/trpc\//, "").split(",");
  const at = procedures.indexOf("github.connections");
  if (at < 0) {
    await route.fallback();
    return;
  }
  const response = await route.fetch();
  const body = batchSchema.parse(await response.json());
  body[at] = { result: { data: [] } };
  await route.fulfill({ response, json: body });
};

/** The setup form's question answered `label`: what `github.startManifest` was sent as `public`. */
const sendsAnswer = async (page: Page, label: string): Promise<boolean> => {
  await signIn(page);
  await page.route("**/api/trpc/**", noAppYet);
  const sent = new Promise<unknown>((resolve) => {
    void page.route("**/api/trpc/github.startManifest**", async (route) => {
      resolve(route.request().postDataJSON());
      await route.fulfill({ status: 400, json: [{ error: { message: "stopped by the test", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } }] });
    });
  });
  await page.goto("/organization/github");
  await page.getByRole("tab", { name: "Create a new App" }).click();
  const question = page.getByRole("radiogroup", { name: "Will repos outside this account use the App?" });
  await expect(question.getByRole("radio", { name: "No, only this account's repos" })).toBeChecked();
  await expect(page.getByText("Private is the default: a public App can't be made private again once another account installs it.")).toBeVisible();
  await question.getByRole("radio", { name: label }).click();
  await page.getByRole("button", { name: "Create the App on GitHub" }).click();
  return z.object({ "0": z.object({ public: z.boolean() }) }).parse(await sent)["0"].public;
};

test("F-136: the setup form sends the answer it was given (private)", async ({ page }) => {
  expect(await sendsAnswer(page, "No, only this account's repos")).toBe(false);
});

test("F-136: the setup form sends the answer it was given (public)", async ({ page }) => {
  expect(await sendsAnswer(page, "Yes, other GitHub organizations install it too")).toBe(true);
});
