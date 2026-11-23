import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { hydrated, readStack, signIn } from "./helpers.ts";
import { e2eAdmin, e2eBaseUrl } from "./settings.ts";

// Milestone 2's tickets 33 and 35 (F-005, F-076, F-007, F-010, F-042), through the panel, core and
// the stack's fake Linear (`fakes.ts`; the panel and core reach it through OSTRA_LINEAR_API_URL, and
// Connect Linear's new-app form, consent and token endpoints at the same origin). The two cases run
// in order, in an organization of their own (`seed-linear-world.ts`): every other spec's seed
// connects the first organization's Linear with an API key, and an organization has one connection.
// The stack's core listens on loopback, which Linear couldn't reach: the connection polls.
// 1. Connect Linear: the pre-filled link opens the fake's new-app form, which registers the app at
//    once; its two values go into the form; Authorize goes through the fake's consent and back to
//    the panel's callback, and the connection is active.
// 2. The project's Boards page attaches the fake's team. A ticket made on the fake while the Inbox
//    is open reaches it by core's poll, with no reload, and Start task starts its task.

const run = promisify(execFile);

const seed = async (args: object): Promise<unknown> => {
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-linear-world.ts"), JSON.stringify(args)], { cwd: path.resolve(import.meta.dirname, "..") });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};
const worldSchema = z.object({ username: z.string(), organizationId: z.string(), projectId: z.string(), projectName: z.string() });
const ticketSchema = z.object({ key: z.string(), externalId: z.string() });

test.describe.configure({ mode: "serial" });

let world: z.infer<typeof worldSchema>;

test.beforeAll(async () => {
  const { databaseUrl } = await readStack();
  world = worldSchema.parse(await seed({ scenario: "world", databaseUrl, password: e2eAdmin.password }));
});

test(
  "F-005/c1, F-076/c1: an admin connects Linear in three steps, through an app made from the pre-filled link, and the connection is active",
  { tag: "@desktop-only" },
  async ({ page }) => {
    const { linear } = await readStack();
    // The run never reaches the real Linear: a link or a redirect there fails, and so does the case.
    await page.context().route(/^https:\/\/([a-z0-9-]+\.)*linear\.app\//, (route) => route.abort());
    await signIn(page, world.username);
    await page.goto("/organization/linear");

    // Core's address is loopback, which Linear can't reach: the page says it polls, before anything is made.
    await expect(page.getByText(/This server's address isn't public/).first()).toBeVisible();
    const create = page.getByRole("button", { name: "Create the app in Linear" });
    await hydrated(create);

    // Step 1: the pre-filled link opens Linear's new-app form (the fake's), which makes the app.
    const opened = page.context().waitForEvent("page");
    await create.click();
    const form = await opened;
    await form.waitForLoadState();
    expect(form.url().startsWith(`${new URL(linear.apiUrl).origin}/settings/api/applications/new?manifest=`)).toBe(true);
    await expect(form.getByTestId("callback-urls")).toHaveText(`${e2eBaseUrl}/api/linear/callback`);
    await expect(form.getByTestId("webhook-url")).toHaveText("");
    const clientId = (await form.getByTestId("client-id").textContent()) ?? "";
    const clientSecret = (await form.getByTestId("client-secret").textContent()) ?? "";
    await form.close();

    // Step 2: polling needs two values, not the webhook secret.
    const values = page.getByRole("form", { name: "Paste the app's values" });
    await expect(values.getByLabel("Webhook signing secret")).toHaveCount(0);
    await values.getByLabel("Client ID").fill(clientId);
    await values.getByLabel("Client secret").fill(clientSecret);
    await values.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved in the secret store.")).toBeVisible();

    // Step 3: Authorize: Linear's consent (the fake's, which agrees at once) sends the admin back.
    await page.getByRole("button", { name: "Authorize in Linear" }).click();
    await page.waitForURL((url) => url.pathname === "/organization/linear" && url.searchParams.get("connected") === "1");
    const connection = page.getByTestId("linear-connection");
    await expect(connection).toContainText("Connected");
    await expect(connection).toContainText("Just connected");
    await expect(connection).toContainText("ostra-test");
    await expect(page.getByText("Polling every 60 s").first()).toBeVisible();
    await expect(page.getByText(`ostra (${new URL(e2eBaseUrl).host})`).first()).toBeVisible();

    // Home's first-run checklist ticks its Linear step.
    await page.goto("/");
    await expect(page.locator('[data-step="tracker"]')).toHaveAttribute("data-state", "done");
  },
);

test(
  "F-007/c1, F-010/c1,c2, F-042/c1: a board attached from the panel brings a ticket made in Linear into the Inbox without a reload, and Start task starts its task",
  { tag: "@desktop-only" },
  async ({ page }) => {
    // Core's poll runs every minute on the minute, and the Inbox asks again every 10 s.
    test.setTimeout(240_000);
    const { linear } = await readStack();
    await signIn(page, world.username);

    // The project's Boards page attaches the fake's team; its mapping drafts itself.
    await page.goto(`/projects/${world.projectId}/boards`);
    const team = page.getByRole("combobox", { name: "Attach", exact: true });
    await hydrated(team);
    await team.click();
    await page.getByRole("option", { name: new RegExp(`· ${linear.teamKey}`) }).click();
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await expect(page.getByText("Attached. The first poll is filling the Inbox.")).toBeVisible();
    await expect(page.getByTestId("boards")).toContainText(linear.teamKey);

    // The Inbox is open when the ticket is made in Linear, and stays as it is: no reload, no navigation.
    await page.goto(`/projects/${world.projectId}/inbox`);
    await expect(page.getByTestId("inbox-list").or(page.getByTestId("inbox-empty-nothing-open"))).toBeVisible({ timeout: 90_000 });
    const title = `Show the build number in the footer ${randomBytes(3).toString("hex")}`;
    const made = ticketSchema.parse(await seed({ scenario: "ticket", linear, title }));
    const row = page.locator(`[data-ticket="${made.key}"]`);
    await expect(row).toBeVisible({ timeout: 150_000 });
    await expect(row).toContainText(title);

    // Filterable: the text filter narrows the list to it.
    const filter = page.getByLabel("Filter by title or key");
    await filter.fill(made.key);
    await expect(page.getByTestId("inbox-list").locator("[data-ticket]")).toHaveCount(1);
    await expect(row).toBeVisible();

    // Start task, in one action: the panel then shows its task.
    await row.getByRole("button").first().click();
    const panel = page.getByTestId("ticket-panel");
    await expect(panel).toContainText(made.key);
    // The kind and the agent profile come prefilled from the project's defaults: code, on its own `Ticket builder`.
    const start = panel.getByTestId("start-task");
    await expect(start).toContainText(/Kind\s*Code/);
    await expect(start.getByTestId("agent-profile")).toHaveText(/Ticket builder/);
    await start.getByRole("button", { name: "Start task" }).click();
    const active = panel.getByTestId("active-task");
    await expect(active).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/Queued|Preparing|Running/);
    await active.getByRole("link", { name: "Open task" }).click();
    await page.waitForURL(/\/tasks\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    // Milestone 10 (ticket 17) took the header's ticket strip: the key line names the ticket and its tracker.
    await expect(page.getByTestId("task-key-line")).toContainText(`${made.key} · from Linear`);
    await expect(page.getByTestId("task-profile")).toHaveText("Ticket builder");
  },
);
