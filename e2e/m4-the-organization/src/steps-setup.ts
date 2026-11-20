import path from "node:path";

import { devDataDir } from "@ostra/db/dev";
import { addModelProvider, connectGitHub, createProject, say } from "@ostra/e2e-m1/setup";
import { seedLinear } from "@ostra/e2e-m2/seed-linear";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { runnerCode } from "./context.ts";
import type { Demo } from "./context.ts";

// The demo's "Before" (spec section 3): milestones 1 to 3's setup by their helpers (a model
// provider named `client-a`, the test App, the projects test1 and test2, Linear with OST attached
// to test1, one personal runner on `host`, the `Careful` profile), and email over SMTP to ticket
// 40's mail sink, set in the panel so step 14 can switch it off.

export const PROFILE = "Careful";
export const CLIENT_A = "client-a";
/** Dollars per million tokens: the demo's prices for the dev model (see `setup`). */
export const DEMO_PRICES = { inputPerMTok: 20, outputPerMTok: 60, cacheReadPerMTok: 2, cacheWritePerMTok: 20 } as const;

/** The project's ID from its sidebar link (`/projects/<id>`). */
export const projectIdOf = (href: string): string => href.split("/")[2] ?? "";

/** A project on one test repo (milestone 1's helper makes only the first). */
export const createRepoProject = async (d: Demo, name: string, repo: string): Promise<string> => {
  const { demo, settings } = d;
  await demo.goto("/");
  const nav = demo.getByRole("navigation", { name: "Navigation" });
  if ((await nav.getByRole("link", { name, exact: true }).count()) === 0) {
    say(`create the project ${name} on ${repo}`);
    await demo.goto("/projects/new");
    await demo.locator(`li[data-repo="${settings.githubOrg}/${repo}"]`).getByRole("checkbox").check({ timeout: 60_000 });
    await demo.locator("#project-name").fill(name);
    await demo.getByRole("button", { name: "Create the project" }).click();
    await demo.waitForURL(/\/projects\/[^/]+\/environment/, { timeout: 60_000 });
    await demo.getByRole("button", { name: "Save environment" }).click();
    await demo.getByText("Saved.").first().waitFor({ timeout: 30_000 });
    await demo.goto("/");
  }
  const href = await nav.getByRole("link", { name, exact: true }).first().getAttribute("href");
  if (href === null) throw new Error(`the project ${name} isn't in the sidebar`);
  return href;
};

const attachBoard = async (d: Demo, projectHref: string): Promise<void> => {
  const { demo, settings } = d;
  await demo.goto(`${projectHref}/boards`);
  await demo.getByText("Attach a team").first().waitFor({ timeout: 30_000 });
  const already = demo.locator("li", { hasText: settings.linearTeamKey }).filter({ hasText: "Detach" });
  if ((await already.count()) > 0) return;
  say(`before: attach ${settings.linearTeamKey} to test1`);
  await demo.getByRole("combobox", { name: "Attach a team" }).click();
  await demo.getByRole("option", { name: new RegExp(`· ${settings.linearTeamKey}`) }).click();
  await demo.getByRole("button", { name: "Attach", exact: true }).click();
  await already.first().waitFor({ timeout: 30_000 });
};

const approveRunner = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const code = await runnerCode(settings);
  if (code !== null && d.run.ids["runnerApproved"] === undefined) {
    say("before: approve the runner's code in the panel");
    await demo.goto("/device");
    await demo.locator("#user-code").fill(code);
    await demo.getByRole("button", { name: "Continue" }).click();
    await demo.getByTestId("device-confirm").waitFor();
    await demo.getByRole("button", { name: "Approve" }).click();
    await demo.getByText(/^Approved\./).waitFor();
  }
  d.run.ids["runnerApproved"] = "yes";
  await demo.goto("/organization/runners");
  await demo.getByTestId("my-runners").getByText(settings.runnerName, { exact: true }).waitFor({ timeout: 120_000 });
};

/** Email over SMTP to ticket 40's mail sink on loopback (no TLS: a local relay). */
const emailToSink = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  if (d.run.ids["emailOn"] !== undefined) return;
  say("before: email over SMTP to the mail sink");
  await demo.goto("/organization/email");
  await demo.getByText("Provider").first().waitFor();
  await demo.getByText("SMTP", { exact: true }).click();
  await demo.getByLabel("Host").fill("127.0.0.1");
  await demo.getByLabel("Port").fill(String(settings.mailPort));
  await demo.getByRole("combobox", { name: "Security" }).click();
  await demo.getByRole("option", { name: /None/ }).click();
  await demo.getByLabel("From address").fill("ostra@demo.test");
  await demo.getByLabel("From name").fill("ostra");
  await demo.locator('[data-action="save-email"]').click();
  await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
  await d.shot(demo, "before-email-sink");
  d.run.ids["emailOn"] = "yes";
};

const pickOption = async (page: Page, trigger: ReturnType<Page["locator"]>, option: string | RegExp): Promise<void> => {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
};

/** Milestone 3's `Careful` profile: the dev model, plan first. */
const careful = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  await demo.goto("/organization/agent-profiles");
  await demo.waitForLoadState("networkidle");
  if ((await demo.locator(`tr[data-profile="${PROFILE}"]`).count()) > 0) return;
  say(`before: the profile ${PROFILE}, plan first`);
  await demo.getByRole("link", { name: "New profile" }).first().click();
  await demo.getByTestId("profile-eyebrow").waitFor();
  await demo.getByTestId("profile-name").fill(PROFILE);
  const model = await d.db.model.findFirst({ where: { endpointModelId: settings.modelId }, select: { displayName: true } });
  await pickOption(demo, demo.getByTestId("profile-model"), new RegExp(model?.displayName ?? settings.modelId));
  await demo.getByRole("textbox", { name: "Instructions" }).fill("Plan before you change anything. Keep each change small.");
  await demo.getByTestId("plan-first").click();
  await demo.locator('[data-action="save-profile"]').click();
  await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
};

/** The files the demo's tasks add, per repo: an earlier run's merged copies are deleted first. */
const ADDED_FILES: Readonly<Record<string, readonly string[]>> = {
  test1: ["CONTRIBUTING.md", "docs/budget.md", "docs/client.md", "docs/effort.md", "scripts/print-release.js"],
  test2: ["docs/budget.md", "notes.txt", "HELLO.md"],
};

const API_LINE = "API version is now 2";

const contentSchema = z.object({ sha: z.string(), content: z.string() });

/**
 * The test repos as the demo's tickets expect them (an earlier run merged its PRs on `main`):
 * test1's `config/settings.json` holds `releaseName` and no `apiVersion`, test2's changelog has no
 * "API version is now 2" line, and no file a task adds is there. One commit per file, by the App,
 * on the test repos only, once per data folder.
 */
const resetFixtures = async (d: Demo): Promise<void> => {
  if (d.run.notes["fixtures-reset"] !== undefined) return;
  const { github, settings } = d;
  const { owner, octokit } = github;
  const read = async (repo: string, file: string) =>
    octokit.rest.repos.getContent({ owner, repo, path: file }).then(
      (answer) => {
        const parsed = contentSchema.safeParse(answer.data);
        return parsed.success ? { sha: parsed.data.sha, text: Buffer.from(parsed.data.content, "base64").toString("utf8") } : null;
      },
      () => null,
    );
  const write = async (repo: string, file: string, sha: string, text: string) => {
    await octokit.rest.repos.createOrUpdateFileContents({ owner, repo, path: file, sha, message: `Reset ${file} for the milestone 4 demo`, content: Buffer.from(text, "utf8").toString("base64") });
  };
  const done: string[] = [];
  const settingsFile = await read(settings.githubRepo, "config/settings.json");
  if (settingsFile !== null) {
    const json = z.record(z.string(), z.unknown()).parse(JSON.parse(settingsFile.text));
    const name = typeof json["releaseName"] === "string" ? json["releaseName"] : typeof json["release"] === "string" ? json["release"] : "Quiet Heron";
    const wanted = `${JSON.stringify({ releaseName: name }, null, 2)}\n`;
    if (settingsFile.text !== wanted) {
      await write(settings.githubRepo, "config/settings.json", settingsFile.sha, wanted);
      done.push(`${settings.githubRepo}/config/settings.json`);
    }
  }
  const changelog = await read(settings.githubOtherRepo, "CHANGELOG.md");
  if (changelog?.text.includes(API_LINE) === true) {
    await write(settings.githubOtherRepo, "CHANGELOG.md", changelog.sha, changelog.text.split("\n").filter((line) => !line.includes(API_LINE)).join("\n"));
    done.push(`${settings.githubOtherRepo}/CHANGELOG.md`);
  }
  for (const [repo, files] of Object.entries(ADDED_FILES)) {
    for (const file of files) {
      const found = await read(repo, file);
      if (found === null) continue;
      await octokit.rest.repos.deleteFile({ owner, repo, path: file, sha: found.sha, message: `Remove ${file} for the milestone 4 demo` });
      done.push(`${repo}/${file} removed`);
    }
  }
  d.run.notes["fixtures-reset"] = done.length === 0 ? "nothing to reset" : done.join(", ");
  say(`before: the test repos' fixtures: ${d.run.notes["fixtures-reset"]}`);
  await d.save();
};

export const setup = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  await resetFixtures(d);
  if (d.run.ids["project:test1"] === undefined || d.run.ids["project:test2"] === undefined) {
    if ((await d.db.modelProvider.count()) === 0) {
      // Milestone 1's helper adds it through the form; its later clicks (personal runners, the
      // default model) predate the Models page of milestone 4, so those are done below.
      await addModelProvider(demo, settings).catch((error: unknown) => {
        say(`before: the provider's form is done; the rest by the API (${error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? "") : "error"})`);
      });
    }
    // The same for the App: its page of milestone 4 lists Apps and installations, not milestone 1's card.
    await connectGitHub(demo, settings).catch(async () => {
      if ((await d.db.codeHostInstallation.count({ where: { accountLogin: settings.githubOrg, state: "linked" } })) === 0) throw new Error("the App didn't connect");
      say("before: the App is connected, and its installation on the test org linked");
    });
    await demo.goto("/organization/github");
    await demo.waitForLoadState("networkidle");
    await d.shot(demo, "before-github");
    const test1 = await createProject(demo, settings);
    d.run.ids["project:test1"] = projectIdOf(test1);
    await d.save();
    d.run.ids["project:test2"] = projectIdOf(await createRepoProject(d, "test2", settings.githubOtherRepo));
    await d.save();
  }
  // The provider of "Before" is `client-a` (spec section 3, before step 15).
  const provider = await d.db.modelProvider.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  if (provider === null) throw new Error("no model provider: the form didn't save it");
  const updated = await d.mutate(demo, "providers.update", { providerId: provider.id, name: CLIENT_A, allowOnPersonalRunners: true });
  if (!updated.ok) throw new Error(`renaming the provider: ${updated.code}`);
  d.run.ids["provider:client-a"] = provider.id;
  const model = await d.db.model.findFirstOrThrow({ where: { providerId: provider.id, endpointModelId: settings.modelId }, select: { id: true } });
  const defaulted = await d.mutate(demo, "agentProfiles.setDefaultModel", { modelId: model.id });
  if (!defaulted.ok) throw new Error(`the default model: ${defaulted.code}`);
  // The four prices (F-037): the dev model's own prices make a task cost under a cent, too little
  // for a budget in whole cents, so the demo prices it at a frontier model's rates.
  const priced = await d.mutate(demo, "providers.setModelPrice", { modelId: model.id, ...DEMO_PRICES });
  if (!priced.ok) throw new Error(`the model's prices: ${priced.code}`);
  d.run.notes["prices"] = `${settings.modelId} priced at ${String(DEMO_PRICES.inputPerMTok)} input, ${String(DEMO_PRICES.outputPerMTok)} output, ${String(DEMO_PRICES.cacheReadPerMTok)} cache read and ${String(DEMO_PRICES.cacheWritePerMTok)} cache write, in dollars per million tokens`;
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
  await attachBoard(d, `/projects/${d.id("project:test1")}`);
  await approveRunner(d);
  await emailToSink(d);
  await careful(d);
  await d.save();
};
