import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 11, ticket 12 (F-152/c1, choice 13), through the panel: Organization › Trackers lists
// every tracker connection of the organization, of any kind, with its mark, name, site, mode, last
// event and state, and the selected one's panel; `/organization/linear` leads on to the first
// Linear connection's page. The organization is its own (`seed-trackers-world.ts`): two Linear
// workspaces and two Jira sites, one of each active, a pending one and a failed one.

const run = promisify(execFile);
const worldSchema = z.object({
  username: z.string(),
  organizationId: z.string(),
  connections: z.object({ acme: z.string(), globex: z.string(), ops: z.string(), northwind: z.string() }),
  boards: z.object({ calculator: z.object({ projectId: z.string() }), shop: z.object({ projectId: z.string() }) }),
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

test("F-152/c1: Trackers lists four connections of two kinds with their marks, names, sites, modes, states and panel, and /organization/linear lands on the first Linear one", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page, world.username);
  await page.goto("/organization/trackers");
  await expect(page.getByRole("heading", { name: "Trackers", exact: true })).toBeVisible();

  const table = page.getByTestId("tracker-connections");
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(4);

  const row = (id: string) => table.locator(`tbody tr[data-connection="${id}"]`);

  // Acme's Linear: its mark at 20px in the brand colour, its name over the kind, its workspace, Webhooks, its last event, Connected.
  const acme = row(world.connections.acme);
  await expect(acme.getByText("Acme Linear", { exact: true })).toBeVisible();
  await expect(acme.getByText("Linear", { exact: true })).toBeVisible();
  await expect(acme.getByText("acme", { exact: true })).toBeVisible();
  await expect(acme.getByText("Webhooks", { exact: true })).toBeVisible();
  await expect(acme.getByText("Connected", { exact: true })).toBeVisible();
  await expect(acme.getByText(/^\d+[smh] ago$/)).toBeVisible();
  const acmeMark = acme.locator('[data-tracker-mark="linear"]');
  await expect(acmeMark).toHaveCount(1);
  await expect(acmeMark).toHaveAttribute("width", "20");
  await expect(acmeMark).toHaveAttribute("data-treatment", "brand");

  // Globex's Jira: its site, Jira Cloud under the name, Jira's own mark.
  const globex = row(world.connections.globex);
  await expect(globex.getByText("Globex Jira", { exact: true })).toBeVisible();
  await expect(globex.getByText("Jira Cloud", { exact: true })).toBeVisible();
  await expect(globex.getByText("globex.atlassian.net", { exact: true })).toBeVisible();
  await expect(globex.locator('[data-tracker-mark="jira"]')).toHaveCount(1);

  // A pending Jira connection says what it waits for; its last event is a dash.
  const ops = row(world.connections.ops);
  await expect(ops.getByText("Pending", { exact: true })).toBeVisible();
  await expect(ops.getByText("No delivery yet", { exact: true })).toBeVisible();
  await expect(ops.getByText("acme-ops.atlassian.net", { exact: true })).toBeVisible();
  await expect(ops.getByText("–", { exact: true })).toBeVisible();

  // A failed Linear connection polls, and its reason is the refused token.
  const northwind = row(world.connections.northwind);
  await expect(northwind.getByText("Polling", { exact: true })).toBeVisible();
  await expect(northwind.getByText("Failed", { exact: true })).toBeVisible();
  await expect(northwind.getByText("Token refused", { exact: true })).toBeVisible();

  // The admin's one primary, and the line under the table that keeps two clients' connections apart.
  await expect(page.getByRole("button", { name: "Connect a tracker" }).first()).toBeVisible();
  await expect(page.getByTestId("trackers-kept-apart")).toContainText("A client's tickets only ever move through its own connection");

  // The panel follows the selected row: Globex's, with its boards and what Jira does here.
  await globex.click();
  const panel = page.getByTestId("tracker-panel");
  await expect(panel).toHaveAttribute("data-connection", world.connections.globex);
  await expect(panel.getByText("Globex Jira", { exact: true })).toBeVisible();
  await expect(panel.getByText("Boards on it")).toBeVisible();
  await expect(panel.getByText("calculator", { exact: true })).toBeVisible();
  await expect(panel.getByText("globex-shop", { exact: true })).toBeVisible();
  await expect(panel.getByText("What Jira does here", { exact: true })).toBeVisible();
  await expect(panel.getByText("Agent mode", { exact: true })).toBeVisible();
  await expect(panel.getByText("– not in Jira", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Open Globex Jira" })).toHaveAttribute("href", `/organization/trackers/${world.connections.globex}`);

  // Linear's old address leads to the first Linear connection's page, past the Jira ones listed before it.
  await page.goto("/organization/linear");
  await page.waitForURL((url) => url.pathname === `/organization/trackers/${world.connections.acme}`);
  await expect(page.getByRole("heading", { name: "Acme Linear", exact: true })).toBeVisible();
});
