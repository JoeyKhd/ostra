import { expect, test } from "@playwright/test";

import { signIn } from "./helpers.ts";
import { e2eRepo } from "./settings.ts";

// F-050 and F-112 in the browser: a new project lands on the environment ostra drafted from its
// repo's files (the fake GitHub's `fake-org/test1`: a pnpm lockfile and an `.nvmrc`), the admin
// reviews and edits it, and only then saves it. The page says what environments are for. GitHub was
// connected by the setup spec before this one; each viewport makes its own project.

test("F-050, F-112: the admin reviews the drafted environment, edits it and saves it, and the page says it's for dev and test credentials", async ({ page }, info) => {
  test.setTimeout(90_000);
  await signIn(page);
  const name = `env-${info.project.name}`;

  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/${e2eRepo.name}`) }).check();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  const environmentUrl = page.url();

  // The draft, not saved yet, with what detection found and why: no agent and no model ran.
  await expect(page.getByText("Draft · not saved yet")).toBeVisible();
  await expect(page.getByText(`Found in ${e2eRepo.owner}/${e2eRepo.name}`)).toBeVisible();
  const setup = page.getByRole("textbox", { name: "Setup script" });
  await expect(setup).toHaveValue(/pnpm install --frozen-lockfile/);
  await expect(page.getByText("For dev and test credentials, never production ones.", { exact: false })).toBeVisible();

  // The admin edits it before saving: the setup script, a variable and a secret.
  await setup.fill("pnpm install --frozen-lockfile\necho edited by the admin\n");
  const entries = page.getByRole("table", { name: `Entries of ${e2eRepo.owner}/${e2eRepo.name}` });
  await page.getByRole("button", { name: "Variable", exact: true }).click();
  await entries.getByLabel("Name", { exact: true }).last().fill("E2E_PORT");
  await entries.getByLabel("Value", { exact: true }).last().fill("4000");
  await page.getByRole("button", { name: "Secret", exact: true }).click();
  await entries.getByLabel("Name", { exact: true }).last().fill("E2E_TOKEN");
  await entries.getByLabel("Secret value").last().fill("e2e-secret-value-not-real-123");
  await page.getByRole("button", { name: "Save environment" }).first().click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  // Saved as edited: the script, the variable, and the secret by name only.
  await page.goto(environmentUrl);
  // The editor shows the script without its final newline.
  await expect(page.getByRole("textbox", { name: "Setup script" })).toHaveValue("pnpm install --frozen-lockfile\necho edited by the admin");
  await expect(page.getByText("Draft · not saved yet")).toHaveCount(0);
  const saved = page.getByRole("table", { name: `Entries of ${e2eRepo.owner}/${e2eRepo.name}` });
  await expect(saved.getByLabel("Name", { exact: true })).toHaveCount(2);
  await expect(saved.getByLabel("Value", { exact: true })).toHaveValue("4000");
  await expect(saved.getByLabel("Secret value")).toHaveAttribute("placeholder", "Set: type to replace it");
  expect(await page.content()).not.toContain("e2e-secret-value-not-real-123");
  await expect(page.getByText("For dev and test credentials, never production ones.", { exact: false })).toBeVisible();
});
