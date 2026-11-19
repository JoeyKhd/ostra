import { say } from "@ostra/e2e-m1/setup";
import type { Page } from "@playwright/test";

import type { Demo } from "./context.ts";
import { loadFixtures } from "./run-state.ts";

// Spec section 3, step 1 (a profile), step 6's environment (two checks), step 16's service on
// test2, and email over SMTP to the fixtures' local server (ticket 50's decision on Q186).

export const PROFILE = "Careful";
export const RULE_NAME = "Settings files";
const SKILL = `---
name: changelog
description: How a line of CHANGELOG.md reads
---

Each change gets one line under "## Unreleased" in CHANGELOG.md at the repo's root: "- <what changed>" in the
present tense, under 100 characters. Create the file and the heading when they are missing.
`;

const pickOption = async (page: Page, trigger: ReturnType<Page["locator"]>, option: string | RegExp): Promise<void> => {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
};

/** Step 1: the `Careful` profile, and test1's default profile for code tasks. */
export const profile = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const fixtures = await loadFixtures(settings.m3StateDir);
  await demo.goto("/organization/agent-profiles");
  await demo.waitForLoadState("networkidle");
  const row = demo.locator(`tr[data-profile="${PROFILE}"]`);
  if ((await row.count()) === 0) {
    say(`step 1: create the profile ${PROFILE}`);
    await demo.getByRole("link", { name: "New profile" }).first().click();
    await demo.getByTestId("profile-eyebrow").waitFor();
    await demo.getByTestId("profile-name").fill(PROFILE);
    // The model from model.env: the only one the dev endpoint lists.
    const model = await d.db.model.findFirst({ where: { endpointModelId: settings.modelId }, select: { displayName: true } });
    await demo.getByTestId("profile-model").click();
    await demo.getByRole("option", { name: new RegExp(model?.displayName ?? settings.modelId) }).first().click();
    await demo.getByRole("textbox", { name: "Instructions" }).fill("Add a line to CHANGELOG.md for every change you make.");
    // A skill: its SKILL.md says how a changelog line reads.
    await demo.getByRole("button", { name: "Skill", exact: true }).click();
    await demo.getByLabel("Name", { exact: true }).last().fill("changelog");
    await demo.getByLabel("SKILL.md").fill(SKILL);
    await demo.getByRole("button", { name: "Done" }).last().click();
    // The release-names MCP server, its bearer token a secret in the secret store.
    await demo.getByRole("button", { name: "HTTP server" }).click();
    await demo.getByLabel("Name", { exact: true }).last().fill("release-names");
    await demo.getByLabel("URL").fill(fixtures.mcp.url);
    await demo.getByRole("button", { name: "Header", exact: true }).click();
    await demo.getByLabel("Header name").fill("Authorization");
    await demo.getByLabel("Value", { exact: true }).fill(`Bearer ${fixtures.mcp.token}`);
    await demo.getByRole("button", { name: "Done" }).last().click();
    // The rule: edits of config/** wait for a person.
    await demo.getByRole("button", { name: "Custom rule" }).click();
    const open = demo.locator("[data-rule-open]");
    await open.getByLabel("Name").fill(RULE_NAME);
    await pickOption(demo, open.getByLabel("Tool"), "Edit files");
    await pickOption(demo, open.getByLabel("Match"), "Path matches");
    await open.getByLabel("Globs or commands, comma-separated").fill("config/**");
    await d.shot(demo, "step01-profile-rule");
    await open.getByRole("button", { name: "Done" }).click();
    await demo.getByTestId("plan-first").click();
    await d.shot(demo, "step01-profile-editor");
    await demo.locator('[data-action="save-profile"]').click();
    await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
  } else {
    say(`step 1: ${PROFILE} is there`);
  }
  await demo.goto("/organization/agent-profiles");
  await demo.locator(`tr[data-profile="${PROFILE}"]`).waitFor();
  await d.shot(demo, "step01-profiles");
  // test1 picks it for code tasks.
  if (d.run.projectHref === null) throw new Error("run setup first");
  await demo.goto(d.run.projectHref);
  const defaults = demo.getByTestId("project-defaults");
  await defaults.waitFor({ timeout: 30_000 });
  if (!(await defaults.locator('[data-kind="code"]').innerText()).includes(PROFILE)) {
    say(`step 1: ${PROFILE} becomes test1's default for code tasks`);
    await defaults.locator('[data-kind="code"]').click();
    await demo.getByRole("option", { name: PROFILE }).click();
    await defaults.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  }
  await d.shot(demo, "step01-project-default");
  d.run.profileDone = true;
};

const addCheck = async (page: Page, name: string, command: string): Promise<void> => {
  const checks = page.getByRole("table", { name: "Checks" });
  if ((await checks.getByRole("row", { name }).count()) > 0) return;
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Command").fill(command);
  await page.getByRole("button", { name: "Save check" }).click();
  await checks.getByRole("row", { name }).waitFor({ timeout: 30_000 });
};

/** Step 6's checks on test1, and step 16's service on test2. */
export const environment = async (d: Demo): Promise<void> => {
  const { demo } = d;
  if (d.run.projectHref === null || d.run.otherProjectHref === null) throw new Error("run setup first");
  await demo.goto(`${d.run.projectHref}/environment?tab=services`);
  await demo.getByRole("tab", { name: "Services and checks" }).click();
  await addCheck(demo, "whitespace", "git diff --check origin/main...HEAD");
  await addCheck(demo, "settings-json", "node -e \"JSON.parse(require('fs').readFileSync('config/settings.json','utf8'))\"");
  await d.shot(demo, "step06-environment-checks");
  await demo.goto(`${d.run.otherProjectHref}/environment?tab=services`);
  await demo.getByRole("tab", { name: "Services and checks" }).click();
  const services = demo.getByRole("table", { name: "Services" });
  await demo.waitForLoadState("networkidle");
  if ((await services.getByRole("row", { name: "db" }).count()) === 0) {
    await demo.getByRole("button", { name: "Service", exact: true }).click();
    await demo.getByLabel("Name", { exact: true }).fill("db");
    await demo.getByLabel("Image").fill("postgres:17");
    await demo.getByLabel("Port").fill("5432");
    await demo.getByLabel("Health check").fill("pg_isready -U postgres");
    await demo.getByRole("button", { name: "Save service" }).click();
    await services.getByRole("row", { name: "db" }).waitFor({ timeout: 30_000 });
  }
  await d.shot(demo, "step16-environment-service");
  d.run.checksDone = true;
};

/** Email over SMTP to the fixtures' server on loopback (no TLS there; ticket 13 allows it on loopback only). */
export const email = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const fixtures = await loadFixtures(settings.m3StateDir);
  await demo.goto("/organization/email");
  await demo.getByText("Provider").first().waitFor();
  await demo.getByText("SMTP", { exact: true }).click();
  await demo.getByLabel("Host").fill(fixtures.smtp.host);
  await demo.getByLabel("Port").fill(String(fixtures.smtp.port));
  await demo.getByRole("combobox", { name: "Security" }).click();
  await demo.getByRole("option", { name: /None/ }).click();
  await demo.getByLabel("Username").fill(fixtures.smtp.user);
  await demo.getByLabel("Password").fill(fixtures.smtp.pass);
  await demo.getByLabel("From address").fill("ostra@demo.test");
  await demo.getByLabel("From name").fill("ostra");
  await d.shot(demo, "step15-email-smtp-form");
  await demo.locator('[data-action="save-email"]').click();
  await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
  await demo.getByRole("button", { name: "Send a test mail" }).click();
  await demo.getByText(/Accepted|accepted/).first().waitFor({ timeout: 60_000 });
  await d.shot(demo, "step15-email-test-sent");
  d.run.emailOn = true;
};
