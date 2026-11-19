import path from "node:path";

import { devDataDir } from "@ostra/db/dev";
import { addModelProvider, connectGitHub, createProject, say } from "@ostra/e2e-m1/setup";
import { seedLinear } from "@ostra/e2e-m2/seed-linear";

import { runnerCode } from "./context.ts";
import type { Demo } from "./context.ts";

// The demo's "Before" (spec section 3): milestones 1 and 2's setup by their helpers (a model
// provider, the test App, the projects test1 and test2, Linear with OST attached to test1, one
// personal runner on `host`), and the panel's new pages looked at once.

/** A second project, on the other test repo (milestone 1's helper makes only the first). */
const createOtherProject = async (d: Demo): Promise<string> => {
  const { demo, settings } = d;
  const repo = settings.githubOtherRepo;
  await demo.goto("/");
  const existing = demo.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: repo, exact: true });
  if ((await existing.count()) === 0) {
    say(`before: create the project ${repo}`);
    await demo.goto("/projects/new");
    await demo.locator(`li[data-repo="${settings.githubOrg}/${repo}"]`).getByRole("checkbox").check({ timeout: 60_000 });
    await demo.locator("#project-name").fill(repo);
    await demo.getByRole("button", { name: "Create the project" }).click();
    await demo.waitForURL(/\/projects\/[^/]+\/environment/, { timeout: 60_000 });
    await demo.getByRole("button", { name: "Save environment" }).click();
    await demo.getByText("Saved.").first().waitFor({ timeout: 30_000 });
    await demo.goto("/");
  }
  const href = await demo.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: repo, exact: true }).first().getAttribute("href");
  if (href === null) throw new Error(`the project ${repo} isn't in the sidebar`);
  return href;
};

/** Milestone 2's step 2: the board attached in the panel. */
const attachBoard = async (d: Demo, projectHref: string): Promise<void> => {
  const { demo, settings } = d;
  await demo.goto(`${projectHref}/boards`);
  await demo.getByText("Attach a team").first().waitFor({ timeout: 30_000 });
  const already = demo.locator("li", { hasText: settings.linearTeamKey }).filter({ hasText: "Detach" });
  if ((await already.count()) > 0) return;
  say(`before: attach ${settings.linearTeamKey} to ${settings.githubRepo}`);
  await demo.getByRole("combobox", { name: "Attach a team" }).click();
  await demo.getByRole("option", { name: new RegExp(`· ${settings.linearTeamKey}`) }).click();
  await demo.getByRole("button", { name: "Attach", exact: true }).click();
  await already.first().waitFor({ timeout: 30_000 });
};

const approveRunner = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const code = await runnerCode(settings);
  if (code !== null && !d.run.runnerApproved) {
    say("before: approve the runner's code in the panel");
    await demo.goto("/device");
    await demo.locator("#user-code").fill(code);
    await demo.getByRole("button", { name: "Continue" }).click();
    await demo.getByTestId("device-confirm").waitFor();
    await demo.getByRole("button", { name: "Approve" }).click();
    await demo.getByText(/^Approved\./).waitFor();
  }
  d.run.runnerApproved = true;
  await demo.goto("/organization/runners");
  await demo.getByTestId("my-runners").getByText(settings.runnerName, { exact: true }).waitFor({ timeout: 120_000 });
};

export const setup = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  await addModelProvider(demo, settings);
  await connectGitHub(demo, settings);
  d.run.projectHref = await createProject(demo, settings);
  d.run.otherProjectHref = await createOtherProject(d);
  const seeded = await seedLinear({
    db: d.db,
    tool: d.tool,
    env: process.env,
    serverDataDir: path.join(devDataDir, "server"),
    apiKey: settings.linearApiKey,
    teamId: settings.linearTeamId,
    publicUrl: settings.devPublicUrl,
  });
  d.run.notes["linearWebhook"] = seeded.webhookId ?? "polling";
  say(`before: Linear connection ${seeded.connectionId}, ${seeded.webhookId === null ? "polling" : "webhooks on the tunnel"}`);
  await attachBoard(d, d.run.projectHref);
  await approveRunner(d);
  await d.save();
};

/** The new pages, looked at once by each member: nothing on them may fail to load. */
export const smoke = async (d: Demo): Promise<void> => {
  for (const [page, who] of [[d.demo, "demo"], [d.sam, "sam"]] as const) {
    for (const [route, name] of [["/needs-you", "needs-you"], ["/account", "account"], ["/account/notifications", "notification-settings"], ["/?view=board", "home-board"], ["/", "home"]] as const) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const failed = await page.getByText(/Unhandled Runtime Error|Application error|Something went wrong/).count();
      d.check(`${who} sees ${route}`, failed === 0, failed === 0 ? "loads" : "shows an error");
      if (who === "demo") await d.shot(page, `smoke-${name}`);
    }
  }
  await d.demo.goto("/organization/email");
  await d.demo.waitForLoadState("networkidle");
  await d.shot(d.demo, "smoke-email-settings");
};
