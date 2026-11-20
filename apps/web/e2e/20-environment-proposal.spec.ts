import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eRepo } from "./settings.ts";

// F-113 (milestone 6's ticket 36): the onboarding task and its environment proposal, on the fake
// GitHub. The project is made through New project on `test1`; "Test this environment" starts the
// onboarding task through the page; its agent's proposal is the proposing fake's `sampleProposal`,
// stored as core's endpoint stores it (`seed-onboarding-world.ts`), since this stack runs no agent.
// The proposal is read as a diff per repo, then edited and accepted, and the Setup tab holds the
// edited script as the environment's next version. `OSTRA_E2E_SHOTS` names a folder for the
// screenshots compared with app-targets/m6/environment-proposal.webp.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
    await page.screenshot({ path: path.join(shots, `m6-${name}${phone ? "-phone" : ""}-${theme}-final.png`) });
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
};

test("F-113/c1,c2,c3: a project admin starts the onboarding task, reads the proposing fake's proposal, edits it and accepts it", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await ensureGitHub(page);
  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/test1`) }).check();
  await page.getByLabel("Name", { exact: true }).fill(`calc-onboard-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  const projectId = new URL(page.url()).pathname.split("/")[2] ?? "";
  const stack = await readStack();
  if (stack.dataDir === null) throw new Error("the proposal's scan reads the stack's own secret store");
  const seed = async (step: "model" | "propose") =>
    run(process.execPath, [path.join(import.meta.dirname, "seed-onboarding-world.ts"), JSON.stringify({ databaseUrl: stack.databaseUrl, dataDir: stack.dataDir, projectId, step })], { cwd: path.resolve(import.meta.dirname, "..") });
  // The stack has no model provider: the project's code profile gets one its list serves.
  await seed("model");

  // "Test this environment": the onboarding task starts, and the Proposal tab shows it running.
  await page.locator('[data-action="test-environment"]').click();
  await expect(page).toHaveURL(/tab=proposal/);
  await expect(page.getByTestId("onboarding-line")).toHaveAttribute("data-open", "true");
  await expect(page.locator('[data-action="test-environment"]')).toBeDisabled();

  // The proposing fake hands in its proposal; the runner reports the AGENTS.md PR and what it didn't commit.
  const { stdout } = await seed("propose");
  z.object({ proposalId: z.string() }).parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  await page.reload();
  const proposal = page.getByTestId("proposal");
  await expect(proposal).toBeVisible();
  await expect(page.getByTestId("proposal-notes")).toContainText("I added Postgres");
  await expect(proposal.locator('[data-testid="script-diff"] [data-sign="+"]')).toContainText(["pnpm install --frozen-lockfile"]);
  await expect(proposal.getByTestId("proposal-check")).toContainText("pnpm test");
  await expect(proposal.getByTestId("proposal-variable")).toContainText("DATABASE_URL");
  await expect(proposal.getByTestId("proposal-service")).toContainText("postgres:17");
  await expect(page.getByTestId("agents-pr")).toContainText("AGENTS.md PR #97");
  await expect(page.getByTestId("not-committed")).toContainText("package.json");
  await shoot(page, "environment-proposal");

  // Edit and accept: the admin's script goes in as the environment's next version.
  await page.locator('[data-action="edit-and-accept"]').click();
  await page.getByLabel(`Setup script for ${e2eRepo.owner}/test1`).fill("corepack enable\npnpm install --frozen-lockfile");
  await page.locator('[data-action="accept-edited"]').click();
  await expect(page.getByTestId("proposal-decided")).toContainText("Accepted as version");
  await expect(page.getByTestId("proposal")).toHaveCount(0);

  // The Setup tab holds it now.
  await page.goto(`/projects/${projectId}/environment`);
  await expect(page.locator("textarea").first()).toHaveValue(/corepack enable\npnpm install --frozen-lockfile/);
  await expect(page.getByTestId("proposal-banner")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
