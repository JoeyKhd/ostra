import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { chooseTheme } from "./m6.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 11, ticket 14 (F-152/c1, F-152/c5, F-152/c3; app-targets/m11-trackers/
// connection-settings.md): each tracker connection's page. An admin renames a Jira connection and a
// Linear one in place (`Enter` saves, `Esc` cancels, a taken name is said), Linear's page holds
// today's sections with Agent mode under its connection, Disconnect's dialog names the boards it
// pauses, and a member reads the page without the webhook URL, the secret or any action. The world
// is `seed-trackers-world.ts`'s; `OSTRA_E2E_SHOTS` names a folder for the screenshots.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({
  username: z.string(),
  memberUsername: z.string(),
  organizationId: z.string(),
  connections: z.object({ acme: z.string(), globex: z.string(), ops: z.string(), northwind: z.string() }),
  boards: z.object({
    calculator: z.object({ projectId: z.string() }),
    shop: z.object({ projectId: z.string() }),
    web: z.object({ projectId: z.string() }),
  }),
});
type World = z.infer<typeof worldSchema>;

let world: World;

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-trackers-world.ts"), JSON.stringify({ scenario: "world", databaseUrl, password: e2eAdmin.password })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** Renames the connection in the header: the pencil, the name, `Enter`. */
const rename = async (page: Page, to: string): Promise<void> => {
  await page.getByTestId("connection-rename").click();
  const field = page.getByTestId("connection-name-input");
  await field.fill(to);
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: to, exact: true })).toBeVisible();
};

test("F-152/c1: an admin renames a Jira and a Linear connection, and Linear's page holds today's sections with Agent mode under its connection", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.username);

  // Jira's page: its header, its four sections and its panel.
  await page.goto(`/organization/trackers/${world.connections.globex}`);
  await expect(page.getByRole("heading", { name: "Globex Jira", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-header")).toContainText("Jira Cloud · globex.atlassian.net");
  await expect(page.getByTestId("connection-header").locator('[data-tracker-mark="jira"]')).toHaveCount(1);
  for (const section of ["Connection", "Events", "Service account", "Disconnect"]) await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  await expect(page.getByTestId("jira-connection")).toContainText("Connected");
  await expect(page.getByTestId("jira-token-healthy")).toBeVisible();
  const panel = page.getByTestId("jira-settings-panel");
  await expect(panel.getByText("Cloud ID")).toBeVisible();
  await expect(panel.getByText("Workflows")).toBeVisible();
  await expect(panel.getByText("Boards on it")).toBeVisible();
  await expect(panel.getByText("PROJ", { exact: false })).toBeVisible();

  // Rename in place: `Enter` saves, the list follows, `Esc` cancels, and a name another connection holds is refused.
  await rename(page, "Globex Jira Ops");
  await page.goto("/organization/trackers");
  await expect(page.getByTestId("tracker-connections").locator(`[data-connection="${world.connections.globex}"]`)).toContainText("Globex Jira Ops");
  await page.goto(`/organization/trackers/${world.connections.globex}`);
  await page.getByTestId("connection-rename").click();
  await page.getByTestId("connection-name-input").fill("Not saved");
  await page.getByTestId("connection-name-input").press("Escape");
  await expect(page.getByRole("heading", { name: "Globex Jira Ops", exact: true })).toBeVisible();
  await page.getByTestId("connection-rename").click();
  await page.getByTestId("connection-name-input").fill("Acme Linear");
  await page.getByTestId("connection-name-input").press("Enter");
  await expect(page.getByTestId("connection-rename-error")).toContainText("Another connection is already called Acme Linear");
  await page.getByTestId("connection-name-input").press("Escape");
  await rename(page, "Globex Jira");

  // Linear's page: today's sections, and Agent mode under its connection, marked Linear only.
  await page.goto(`/organization/trackers/${world.connections.acme}`);
  await expect(page.getByRole("heading", { name: "Acme Linear", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-header")).toContainText("Linear · workspace acme");
  await expect(page.getByTestId("connection-header").locator('[data-tracker-mark="linear"]')).toHaveCount(1);
  for (const section of ["Connection", "Events", "Token", "Agent mode", "Disconnect"]) await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent mode", exact: true })).toBeVisible();
  await expect(page.getByText("Linear only", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-mode-state")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Linear" })).toHaveAttribute("href", /linear\.app/);
  await rename(page, "Acme Linear HQ");
  await page.goto("/organization/trackers");
  await expect(page.getByTestId("tracker-connections").locator(`[data-connection="${world.connections.acme}"]`)).toContainText("Acme Linear HQ");
  await page.goto(`/organization/trackers/${world.connections.acme}`);
  await rename(page, "Acme Linear");
});

test("F-152/c3: a member reads the connection's page without the webhook URL, the secret or any action", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.memberUsername);

  await page.goto(`/organization/trackers/${world.connections.globex}`);
  await expect(page.getByRole("heading", { name: "Globex Jira", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
  await expect(page.getByText("Webhooks: receiving")).toBeVisible();
  await expect(page.getByTestId("connection-rename")).toHaveCount(0);
  await expect(page.getByTestId("jira-webhook-url")).toHaveCount(0);
  await expect(page.getByText("Rotate the secret")).toHaveCount(0);
  await expect(page.getByTestId("jira-token-replace")).toHaveCount(0);
  await expect(page.getByTestId("jira-check-again")).toHaveCount(0);
  for (const action of ["Replace", "Disconnect"]) await expect(page.getByRole("button", { name: action, exact: true })).toHaveCount(0);

  await page.goto(`/organization/trackers/${world.connections.acme}`);
  await expect(page.getByRole("heading", { name: "Acme Linear", exact: true })).toBeVisible();
  await expect(page.getByText("In the secret store")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("connection-rename")).toHaveCount(0);
});

/** The `trackers.get` batch as a Jira admin sees it with a public address: only its URL is added. */
const withWebhookUrl = async (page: Page, connectionId: string): Promise<void> => {
  await page.route("**/api/trpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.replace(/^.*\/api\/trpc\//, "").split(",");
    const at = procedures.indexOf("trackers.get");
    if (route.request().method() !== "GET" || at < 0) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = z.array(z.unknown()).parse(await response.json());
    const patched = z.record(z.string(), z.unknown()).parse(body[at]);
    const outer = z.record(z.string(), z.unknown()).safeParse(patched["result"]);
    if (outer.success) {
      const result = outer.data;
      const inner = z.record(z.string(), z.unknown()).safeParse(result["data"]);
      const payload = inner.success ? inner.data : null;
      if (payload !== null && payload["kind"] === "jira") {
        const jira = z.record(z.string(), z.unknown()).parse(payload["jira"]);
        jira["webhookUrl"] = `https://ostra.acme.dev/webhooks/jira/${connectionId}`;
        payload["jira"] = jira;
        result["data"] = payload;
        patched["result"] = result;
        body[at] = patched;
      }
    }
    await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, json: body });
  });
};

const shoot = async (page: Page, name: string, theme: "dark" | "light"): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  const width = (page.viewportSize()?.width ?? 1440) < 600 ? "390" : "1440";
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
};

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("ticket 14: each connection's page at 1440 and 390, in both themes", async ({ page }) => {
  test.skip(shots === undefined, "screenshots only");
  test.setTimeout(180_000);
  // The page scrolls inside its own column: a taller viewport photographs all of it.
  const width = page.viewportSize()?.width ?? 1440;
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1400 });
  await withWebhookUrl(page, world.connections.globex);
  await signIn(page, world.username);
  const jiraPage = `/organization/trackers/${world.connections.globex}`;
  const linearPage = `/organization/trackers/${world.connections.acme}`;
  await page.goto(jiraPage);
  await expect(page.getByTestId("jira-token-healthy")).toBeVisible();
  await shoot(page, "connection-jira", "dark");
  await chooseTheme(page, "Light");
  await page.goto(jiraPage);
  await expect(page.getByTestId("jira-token-healthy")).toBeVisible();
  await shoot(page, "connection-jira", "light");
  await chooseTheme(page, "Dark");

  await page.goto(linearPage);
  await expect(page.getByRole("heading", { name: "Agent mode", exact: true })).toBeVisible();
  await shoot(page, "connection-linear", "dark");
  await chooseTheme(page, "Light");
  await page.goto(linearPage);
  await expect(page.getByRole("heading", { name: "Agent mode", exact: true })).toBeVisible();
  await shoot(page, "connection-linear", "light");
});

test("F-152/c5: Disconnect's dialog names the boards it pauses; after it the board reads paused", { tag: "@desktop-only" }, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world.username);
  await page.goto(`/organization/trackers/${world.connections.globex}`);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Disconnect Globex Jira?");
  await expect(dialog).toContainText("Its 2 boards on calculator and globex-shop");
  await expect(dialog).toContainText("Delete the webhook in Jira yourself");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();

  // The connection leaves the list, and its board stays attached, paused, with its line.
  await page.waitForURL((url) => url.pathname === "/organization/trackers");
  await expect(page.getByTestId("tracker-connections").locator(`[data-connection="${world.connections.globex}"]`)).toHaveCount(0);
  await page.goto(`/projects/${world.boards.calculator.projectId}/boards`);
  const paused = page.getByTestId("boards").locator('[data-paused="true"]');
  await expect(paused).toHaveCount(1);
  await expect(page.getByTestId("board-pause")).toContainText("Globex Jira");
});
