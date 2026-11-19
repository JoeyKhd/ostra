import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { e2eRepo } from "./settings.ts";

// Ticket 48 (F-094, F-054, F-051) in the browser: the environment's Services and checks tab. A
// project admin saves a check and a service from their sheets; with only a `host` runner online the
// page warns that the project's tasks wait, and a task of the project says why on its page. Each
// viewport makes its own project.

const run = promisify(execFile);

const seed = async (input: Record<string, string>): Promise<Record<string, string>> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-services.ts"), JSON.stringify({ databaseUrl, ...input })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const parsed: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  if (typeof parsed !== "object" || parsed === null) throw new Error("seeding failed");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
};

const createProject = async (page: Page, name: string): Promise<string> => {
  await page.goto("/projects/new");
  await page.getByRole("checkbox", { name: new RegExp(`${e2eRepo.owner}/${e2eRepo.name}`) }).check();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create the project" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/environment/);
  await page.getByRole("button", { name: "Save environment" }).first().click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const projectId = /\/projects\/([^/?]+)\/environment/.exec(page.url())?.[1];
  if (projectId === undefined) throw new Error("no project in the URL");
  return projectId;
};

test("F-094, F-054: a check and a service are saved; with only a host runner online the page warns, and a task of the project waits with the note", async ({ page }, info) => {
  test.setTimeout(120_000);
  await signIn(page);
  const projectId = await createProject(page, `svc-${info.project.name}`);

  // The second tab, from the tab row; `?tab=services` keeps it.
  await page.getByRole("tab", { name: "Services and checks" }).click();
  await expect(page).toHaveURL(/[?&]tab=services(?:&|$)/);
  await expect(page.getByText("No services. Add one when tasks need a database or a cache beside them.")).toBeVisible();
  await expect(page.getByText("No checks. Pull requests open without them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save environment" })).toHaveCount(0);

  // A check, from its sheet: it runs at the workspace root, 90 s.
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("typecheck");
  await page.getByLabel("Command").fill("pnpm typecheck");
  await page.getByRole("button", { name: "Save check" }).click();
  const checks = page.getByRole("table", { name: "Checks" });
  await expect(checks.getByRole("row", { name: "typecheck" })).toContainText("pnpm typecheck");
  await expect(checks.getByRole("row", { name: "typecheck" })).toContainText("10 min");

  // A service, with a secret that never comes back.
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("db");
  await page.getByLabel("Image").fill("postgres:17");
  await page.getByLabel("Port").fill("5432");
  await page.getByRole("button", { name: "Secret", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).last().fill("POSTGRES_PASSWORD");
  await page.getByLabel("Value", { exact: true }).last().fill("e2e-db-password-not-real");
  await page.getByLabel("Health check").fill("pg_isready -U app");
  await expect(page.getByText("Saving rebuilds the snapshot. Running tasks keep theirs.")).toBeVisible();
  await page.getByRole("button", { name: "Save service" }).click();
  const services = page.getByRole("table", { name: "Services" });
  const db = services.getByRole("row", { name: "db" });
  await expect(db).toContainText("postgres:17");
  await expect(db).toContainText("5432");
  await expect(db).toContainText("not run yet");

  // A host runner is the only one online: the project's tasks wait, and the page says so.
  const runner = await seed({ projectId, scenario: "host-runner" });
  const runnerName = runner["runnerName"] ?? "";
  await page.reload();
  const blocked = page.getByTestId("services-blocked");
  await expect(blocked).toContainText("Tasks of this project are waiting.");
  // The pool's only runner uses `host`, so the block says none of them can, not that none is online.
  await expect(blocked).toContainText("It has services, and none of this project's runners can start them: they all use the host executor.");
  await expect(page.getByTestId("where-tasks-run")).toContainText("0 runners online");
  expect(await page.content()).not.toContain("e2e-db-password-not-real");
  if (info.project.name === "phone") await expectNoHorizontalScroll(page);

  // Saved: after a reload, the service and the check are there; the secret reads as set.
  await services.getByRole("row", { name: "db" }).click();
  await expect(page.getByLabel("Value", { exact: true })).toHaveAttribute("placeholder", "Set: type to replace it");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(checks.getByRole("row", { name: "typecheck" })).toBeVisible();

  // A task of the project waits for a runner that can start services, and its page says why.
  const waiting = await seed({ projectId, scenario: "waiting-task", runnerName });
  await page.goto(`/tasks/${waiting["taskId"] ?? ""}`);
  await expect(page.getByTestId("task-dispatch-note")).toHaveText(`Waiting for a runner that can start services. Online now: ${runnerName} (host).`);
});

// The screenshot compared with the target (`context/brand/app-targets/m3/environment-services.webp`)
// at its own size, 1440×956: only when asked for (`OSTRA_E2E_SCREENSHOTS=1`), since it writes into
// the repo. The comparison is by eye; ticket 48's comments list the differences.
test("the Services and checks tab, as the target shows it @desktop-only", async ({ page }) => {
  test.skip(process.env["OSTRA_E2E_SCREENSHOTS"] !== "1", "writes the screenshot into the repo; run with OSTRA_E2E_SCREENSHOTS=1");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 956 });
  await signIn(page);
  const projectId = await createProject(page, `calculator-${String(Date.now()).slice(-5)}`);
  await seed({ projectId, scenario: "showcase" });
  await page.goto(`/projects/${projectId}/environment?tab=services`);
  await expect(page.getByRole("table", { name: "Services" }).getByRole("row", { name: "mailpit" })).toContainText("started");
  await expect(page.getByTestId("snapshot-group")).toContainText("Ready");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.resolve(import.meta.dirname, "..", "..", "..", "context", "specs", "m3-step-in", "evidence", "environment-services-built.png") });
});
