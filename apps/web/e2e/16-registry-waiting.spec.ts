import { expect, test } from "@playwright/test";

import { startFakeOciRegistry } from "@ostra/adapter-sdk/testing/net";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { signedInPage } from "./m4.ts";
import { seedPushedSnapshot, seedWaitWorld, shoot, taskOf } from "./m5-settings.ts";

// F-067, F-069, F-120, F-014 (milestone 5's ticket 33): the task's waiting line, New task's runner
// picker, and the Registry page with its check, through the panel, its API, core and the database.

const sam = "e2e-wait-sam";

test("F-067, F-069: a queued task's page says why it waits, for each reason, its place in its pool's queue, a node wait and who cancelled it", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedWaitWorld(sam);
  await signIn(page);
  const lines: readonly (readonly [string, string])[] = [
    ["Waits for a registry", "e2e-wait-pool needs a registry for snapshots: an admin sets one under Registry."],
    ["Waits for services", "The environment has services, and no runner of e2e-wait-app's pools can start them."],
    ["Waits for labels", "No runner in e2e-wait-pool has the label gpu."],
    ["Waits for a bigger runner", "No runner of e2e-wait-app's pools offers the large box size."],
    ["Waits at its share", "e2e-wait-app is at its share of e2e-wait-pool: 2 boxes."],
    ["Waits at the pool's cap", "e2e-wait-pool is at its cap of boxes."],
    ["Waits for a runner online", "No runner of e2e-wait-app's pools is online with a free slot."],
    ["Waits for a protocol", "The agent profile needs a runner at protocol 1.4 or later: update the runner."],
  ];
  for (const [title, line] of lines) {
    await page.goto(`/tasks/${taskOf(world, title)}`);
    await expect(page.getByTestId("task-wait-line"), title).toHaveText(line);
  }

  // Its place in its pool's queue, read from the queue itself.
  await page.goto(`/tasks/${taskOf(world, "First in the queue")}`);
  await expect(page.getByTestId("task-wait-line")).toContainText("1st in e2e-wait-pool's queue");
  await shoot(page, "task-waiting");
  await page.goto(`/tasks/${taskOf(world, "Second in the queue")}`);
  await expect(page.getByTestId("task-wait-line")).toContainText("2nd in e2e-wait-pool's queue");

  // A box the cluster has no node for yet, with how long, and the box's size in the panel.
  await page.goto(`/tasks/${taskOf(world, "Waits for a node")}`);
  await expect(page.getByTestId("task-box-waiting")).toHaveText(/^Waiting for a node · \d+(s|m)$/);
  await expect(page.getByTestId("task-box-size")).toHaveText("small · 2 vCPU · 4 GiB");

  // Cancelled from the queue: who did it.
  await page.goto(`/tasks/${taskOf(world, "Cancelled from the queue")}`);
  await expect(page.getByTestId("task-wait-line")).toHaveText(`Cancelled by ${world.adminName}`);
});

test("F-069, F-014: New task offers A pool and Your machine, each machine that can't take it disabled with its reason", { tag: "@desktop-only" }, async ({ browser }) => {
  const world = await seedWaitWorld(sam);
  const page = await signedInPage(browser, sam);
  await page.goto("/tasks/new");
  await page.getByTestId("pick-project").click();
  await page.getByLabel("Find a project…").fill("e2e-wait-app");
  await page.getByLabel("Find a project…").press("Enter");
  await expect(page.getByTestId("pick-project")).toContainText("e2e-wait-app");
  // No machine can take it, so "A pool" is the choice, and the box it gets is the project's size.
  await expect(page.getByTestId("run-on")).toContainText("A pool");
  await expect(page.getByTestId("new-task-box-size")).toHaveText("small · 2 vCPU · 4 GiB");

  await page.getByTestId("run-on").click();
  const menu = page.getByRole("menu");
  const pool = menu.locator('[data-runner="pools"]');
  await expect(pool).toContainText("A pool");
  await expect(pool.getByTestId("run-on-pool-reason")).toContainText("Waits:");
  const laptop = menu.locator(`[data-runner="${world.personal.offline}"]`);
  await expect(laptop).toContainText("Your machine");
  await expect(laptop).toHaveAttribute("data-disabled", "");
  await expect(laptop.getByTestId("run-on-personal-reason")).toHaveText("offline");
  const desktop = menu.locator(`[data-runner="${world.personal.online}"]`);
  await expect(desktop).toHaveAttribute("data-disabled", "");
  await expect(desktop.getByTestId("run-on-personal-reason")).toHaveText("the model provider isn't allowed on personal runners");
  await shoot(page, "task-new-picker");
  await page.context().close();
});

test("F-120: an admin sets the registry and both credentials, the check answers, and no credential's value is in the page or an answer", { tag: "@desktop-only" }, async ({ page }) => {
  await seedWaitWorld(sam);
  const registry = await startFakeOciRegistry();
  const secrets = [registry.push.password, registry.pull.password];
  const answers: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/trpc")) void response.text().then((body) => { answers.push(body); }, () => undefined);
  });
  try {
    await signIn(page);
    await page.goto("/organization/registry");
    await expect(page.getByRole("heading", { level: 1, name: "Registry" })).toBeVisible();
    await expect(page.getByText("Save a registry to check it.")).toBeVisible();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();

    // A scheme other than https is refused for any host but this machine's.
    await page.getByLabel("Registry", { exact: true }).fill("http://registry.example.com");
    await expect(page.getByRole("alert").filter({ hasText: "A host and optional port" })).toBeVisible();
    await page.getByLabel("Registry", { exact: true }).fill(`http://${registry.host}`);
    await page.getByLabel("Repository prefix").fill("ostra-e2e/");
    await expect(page.getByText(`${registry.host}/ostra-e2e/<project>:<snapshot>`)).toBeVisible();

    await page.getByTestId("registry-push").getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Push credential: Username").fill(registry.push.username);
    await page.getByLabel("Push credential: Password or token").fill(registry.push.password);
    await page.getByTestId("registry-pull").getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Pull credential: Username").fill(registry.pull.username);
    await page.getByLabel("Pull credential: Password or token").fill(registry.pull.password);
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. Checking the registry…" })).toBeVisible();
    await expect(page.getByTestId("registry-push")).toContainText("Set");
    await expect(page.getByTestId("registry-pull")).toContainText("Set");

    // Core's check signs in, starts and cancels an upload, and reads a manifest: both allowed.
    await expect(page.getByTestId("registry-check-result")).toHaveText("Push and pull both allowed for ostra-e2e/", { timeout: 45_000 });
    await expect(page.getByTestId("registry-status")).toHaveText("Push and pull allowed");
    expect(registry.requests().some((request) => request.method === "POST")).toBe(true);

    // A snapshot pushed there: its row, its digest, where it was built.
    const snapshot = await seedPushedSnapshot();
    await page.reload();
    const row = page.getByTestId("registry-snapshot");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("e2e-wait-app");
    await expect(row).toContainText(`sha256:${snapshot.digest.slice(7, 13)}…${snapshot.digest.slice(-4)}`);
    await expect(row).toContainText("e2e-wait-k8s-01, BuildKit");
    await expect(page.getByTestId("registry-pool").filter({ hasText: "e2e-wait-k8s" })).toContainText("pulls every snapshot from here");
    await shoot(page, "registry");

    // No credential's value in the page, after a save or a reload, nor in any answer of the API.
    for (const secret of secrets) {
      expect(await page.content()).not.toContain(secret);
      expect(answers.some((body) => body.includes(secret))).toBe(false);
    }

    // The environment's snapshot names the registry's image by digest and where it was built.
    await page.goto(`/projects/${snapshot.projectId}/environment`);
    await expect(page.getByTestId("snapshot-registry-ref")).toHaveText(`${registry.host}/ostra-e2e/${snapshot.projectId}@${snapshot.digest}`);
    await expect(page.getByTestId("snapshot-built-on")).toHaveText("e2e-wait-k8s-01, BuildKit");
  } finally {
    await registry.close();
  }
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-120, F-067: the Registry page and a waiting task fit a phone", async ({ page }) => {
    const world = await seedWaitWorld(sam);
    await signIn(page);
    await page.goto("/organization/registry");
    await expect(page.getByRole("heading", { level: 1, name: "Registry" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shoot(page, "registry");
    await page.goto(`/tasks/${taskOf(world, "First in the queue")}`);
    await expect(page.getByTestId("task-wait-line")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
