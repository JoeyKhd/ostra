import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { signIn, watchOrigins } from "./helpers.ts";
import { e2eModelToken, e2eOpenAiStubBaseUrl, e2eStubBaseUrl } from "./settings.ts";

// F-088: "Add a model provider" in the panel, against a stub endpoint of each API format. It runs at
// both widths, so each provider it adds is named after the project, and nothing it adds is shared.

/** What every model endpoint has: no field here names or fits one provider (ADR 0033). */
const GENERIC_FIELDS = ["Name", "API base URL", "Token"];
const GENERIC_FIELDS_AFTER_TEST = [...GENERIC_FIELDS, "API format", "Sessions at once", "Allow on personal runners"];

const openForm = async (page: Page): Promise<Locator> => {
  await page.goto("/organization/models");
  await expect(page.getByRole("heading", { name: "Models", level: 1 })).toBeVisible();
  const form = page.getByRole("form", { name: "Add a model provider" });
  if (!(await form.isVisible())) {
    await page.getByRole("button", { name: "Add provider" }).first().click();
  }
  await expect(form).toBeVisible();
  return form;
};

/** The form's fields: each control's label, and how many controls there are. */
const fieldsOf = async (form: Locator): Promise<{ readonly labels: readonly string[]; readonly controls: number }> => ({
  labels: (await form.locator("label").allTextContents()).map((text) => text.trim()),
  controls: await form.locator("input:not([aria-hidden=true]), select, textarea, [role=switch]").count(),
});

const fillAndTest = async (form: Locator, name: string, baseUrl: string): Promise<void> => {
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("API base URL").fill(baseUrl);
  await form.getByLabel("Token", { exact: true }).fill(e2eModelToken);
  await form.getByRole("button", { name: "Test connection" }).click();
  await expect(form.getByTestId("test-result")).toBeVisible();
};

/** The saved provider's format, as its settings show it. */
const savedFormat = async (page: Page, name: string): Promise<Locator> => {
  await page.goto("/organization/models");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  return page.getByTestId("provider-settings");
};

test("F-088/c1,c2,c6: the add-provider form asks only for what any model endpoint has, in either API format, and the admin corrects the detected one", async ({ page }, testInfo) => {
  const origins = watchOrigins(page);
  await signIn(page);
  const suffix = testInfo.project.name;

  // Before "Test connection": a name, a base URL and a token, nothing else.
  let form = await openForm(page);
  expect(await fieldsOf(form)).toEqual({ labels: GENERIC_FIELDS, controls: GENERIC_FIELDS.length });

  // An OpenAI-compatible endpoint: detected, preselected, and saved as such.
  await fillAndTest(form, `openai-${suffix}`, e2eOpenAiStubBaseUrl);
  await expect(form.getByTestId("test-result")).toContainText("Connected · OpenAI-compatible");
  await expect(form.getByLabel("API format")).toHaveValue("openai-compatible");
  // After it: the format, the cap and "Allow on personal runners". Still nothing that fits one provider.
  expect(await fieldsOf(form)).toEqual({ labels: GENERIC_FIELDS_AFTER_TEST, controls: GENERIC_FIELDS_AFTER_TEST.length });
  await expect(form.getByLabel("API format").locator("option")).toHaveText(["Anthropic Messages", "OpenAI-compatible (detected)"]);
  await form.getByRole("button", { name: "Save provider" }).click();
  await expect(page.getByTestId("provider-settings")).toBeVisible();
  await expect(await savedFormat(page, `openai-${suffix}`)).toContainText("OpenAI-compatible");

  // An Anthropic endpoint: detected as Anthropic Messages, which the admin corrects to OpenAI-compatible.
  form = await openForm(page);
  await fillAndTest(form, `corrected-${suffix}`, e2eStubBaseUrl);
  await expect(form.getByTestId("test-result")).toContainText("Connected · Anthropic Messages");
  await expect(form.getByLabel("API format")).toHaveValue("anthropic-messages");
  expect(await fieldsOf(form)).toEqual({ labels: GENERIC_FIELDS_AFTER_TEST, controls: GENERIC_FIELDS_AFTER_TEST.length });
  await form.getByLabel("API format").selectOption("openai-compatible");
  await form.getByRole("button", { name: "Save provider" }).click();
  await expect(page.getByTestId("provider-settings")).toBeVisible();
  const corrected = await savedFormat(page, `corrected-${suffix}`);
  await expect(corrected).toContainText("OpenAI-compatible");
  await expect(corrected).not.toContainText("Anthropic Messages");

  // The token is never shown back, and the page called no one but ostra.
  expect(await page.content()).not.toContain(e2eModelToken);
  expect(origins.foreign()).toEqual([]);
});
