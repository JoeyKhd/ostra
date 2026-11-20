import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { seedM4Member, signedInPage } from "./m4.ts";
import { seedSizesWorld, shoot } from "./m5-settings.ts";

// F-095, F-086, F-069 (milestone 5's ticket 32): Box sizes, a project's Runners tab, and a
// profile's runner labels, through the panel, its API and the database.

test("F-095/c1: an admin edits a size, sees where no runner offers it, saves it, and a member reads it only", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await seedSizesWorld();
  await signIn(page);
  await page.goto("/organization/box-sizes");
  await expect(page.getByRole("heading", { level: 1, name: "Box sizes" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigation" }).getByRole("link", { name: "Box sizes" })).toBeVisible();
  await expect(page.getByTestId("box-sizes-host-note")).toContainText("host runners count slots only.");
  const save = page.getByRole("button", { name: "Save sizes" });
  await expect(save).toBeDisabled();
  // small is e2e-sizes-app's default.
  await expect(page.locator('[data-size="small"]')).toContainText("e2e-sizes-app");

  const memory = page.getByLabel("large: memory in GiB");
  await expect(memory).toHaveValue("16");
  // Larger than any runner's offer: the warning names the size, and it doesn't block saving.
  await memory.fill("900");
  await expect(page.getByTestId("box-sizes-warning")).toContainText("No runner offers 900 GiB yet");
  await expect(page.locator('[data-size="large"]')).toContainText("was 16");
  await expect(save).toBeEnabled();

  // Invalid values: refused inline, Save disabled.
  await page.getByLabel("small: vCPU").fill("0.3");
  await expect(page.getByRole("alert").filter({ hasText: "small: vCPU is a multiple of 0.5" })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel("small: vCPU").fill("2");

  await memory.fill("32");
  await shoot(page, "box-sizes");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. New boxes get these sizes." })).toBeVisible();
  await expect(page.getByTestId("box-sizes-last-change")).toContainText("Large set to 8 vCPU · 32 GiB by");

  // It's stored: a reload reads it back from the API.
  await page.reload();
  await expect(page.getByLabel("large: memory in GiB")).toHaveValue("32");
  await expect(page.getByRole("button", { name: "Save sizes" })).toBeDisabled();

  // A member reads the sizes, with no input and no Save.
  await seedM4Member("e2e-sizes-viewer");
  const member = await signedInPage(browser, "e2e-sizes-viewer");
  await member.goto("/organization/box-sizes");
  await expect(member.locator('[data-size="large"]')).toContainText("32");
  await expect(member.getByLabel("large: memory in GiB")).toHaveCount(0);
  await expect(member.getByRole("button", { name: "Save sizes" })).toHaveCount(0);
  await member.context().close();
});

test("F-086/c1, F-069, F-095/c2: a project admin reorders the pools with the keyboard, sets a share, and picks the default size", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedSizesWorld();
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/settings/runners`);
  await expect(page.getByRole("heading", { level: 1, name: "Runners" })).toBeVisible();
  const rows = page.getByTestId("project-pool-row");
  await expect(rows).toHaveCount(3);
  const names = () => rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-pool")));
  expect(await names()).toEqual(["e2e-sizes-docker", "e2e-sizes-k8s", "e2e-sizes-host"]);
  // The docker pool: the project holds its whole share there.
  const docker = page.locator('[data-pool="e2e-sizes-docker"]');
  await expect(docker).toContainText("2 / 2");
  await expect(docker).toContainText("at share");
  await expect(docker.getByRole("meter")).toHaveAttribute("aria-valuenow", "2");
  await expect(page.locator('[data-pool="e2e-sizes-k8s"]')).toContainText("kubernetes");
  await shoot(page, "project-runners");

  // Keyboard: lift k8s, move it up, drop it. Each step is said, and the order saves at once.
  const handle = page.getByRole("button", { name: "Move e2e-sizes-k8s" });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("project-runners-live")).toHaveText("e2e-sizes-k8s lifted, position 2 of 3.");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("project-runners-live")).toHaveText("e2e-sizes-k8s moved to position 1 of 3.");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("project-runners-live")).toHaveText("e2e-sizes-k8s dropped at position 1 of 3.");
  await expect(page.getByRole("status").filter({ hasText: "Saved. e2e-sizes-k8s is first." })).toBeVisible();

  // Escape puts a lifted row back.
  await page.getByRole("button", { name: "Move e2e-sizes-host" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-runners-live")).toHaveText("Move cancelled.");

  // A share: past the pool's cap it's refused; within it, it saves.
  const share = page.getByLabel("e2e-sizes-app's share of e2e-sizes-k8s");
  await share.fill("50");
  await share.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "A whole number from 1 to 20, or empty for no cap." })).toBeVisible();
  await share.fill("3");
  await share.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Saved. e2e-sizes-app may hold 3 boxes in e2e-sizes-k8s." })).toBeVisible();

  // The default size applies at once.
  await page.getByRole("radio", { name: /medium/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. New boxes in e2e-sizes-app get medium." })).toBeVisible();

  // All of it is stored: a reload reads the order, the share and the size back.
  await page.reload();
  await expect(rows).toHaveCount(3);
  expect(await names()).toEqual(["e2e-sizes-k8s", "e2e-sizes-docker", "e2e-sizes-host"]);
  await expect(page.getByLabel("e2e-sizes-app's share of e2e-sizes-k8s")).toHaveValue("3");
  await expect(page.getByRole("radio", { name: /medium/ })).toBeChecked();
});

test("F-069/c1: a profile's runner label with a reserved prefix is refused inline, and an allowed one is kept", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedSizesWorld();
  await signIn(page);
  await page.goto(`/organization/agent-profiles/${world.profileId}`);
  const field = page.getByLabel("Add a runner label");
  await field.fill("executor:docker");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "executor: labels come from what a runner reports" })).toBeVisible();
  await expect(page.getByTestId("runner-label")).toHaveCount(0);

  await field.fill("tier:fast");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("runner-label")).toHaveText(["tier:fast"]);
  await expect(page.getByRole("status").filter({ hasText: "Saved. Its next tasks go only to runners labelled tier:fast." })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("runner-label")).toHaveText(["tier:fast"]);
});

// At phone width (F-075), in the desktop project too: the phone project waits on every desktop spec.
test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-095, F-086: Box sizes and the Runners tab fit a phone", async ({ page }) => {
    const world = await seedSizesWorld();
    await signIn(page);
    await page.goto("/organization/box-sizes");
    await expect(page.locator('[data-size="large"]')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, "box-sizes");
    await page.goto(`/projects/${world.projectId}/settings/runners`);
    await expect(page.getByTestId("project-pool-row").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, "project-runners");
  });
});
