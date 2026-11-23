import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { chooseTheme } from "./m6.ts";
import { e2eAdmin, e2eCorePort } from "./settings.ts";

// Milestone 11, ticket 13 (F-008/c1, F-152/c2, F-008/c8; app-targets/m11-trackers/jira-connect.md):
// connecting the fake Jira's site through the three steps. Step 1 finds the site's cloud ID at the
// fake's tenant info, step 2 reads the service account back and saves its token, step 3 is a Jira
// admin webhook (the stack's address is loopback, so the mode is the target's, and the spec's signed
// delivery reaches core's real inbox and activates it) or polling (the real mode), and step 2's done
// line warns from 14 days before the token's date. A second connection to the same site is refused,
// naming the first, with `Open it →`. The four worlds come from `seed-jira-connect.ts`.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const EVENTS = ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"];
const DAY_MS = 86_400_000;

const worldSchema = z.object({
  webhook: z.object({ username: z.string(), first: z.string(), second: z.string(), secret: z.string() }),
  polling: z.object({ username: z.string(), connectionId: z.string() }),
  shots: z.object({ username: z.string(), connectionId: z.string(), secret: z.string() }),
  jira: z.object({ siteName: z.string(), serviceAccountEmail: z.string(), token: z.string(), projectKey: z.string() }),
});
type World = z.infer<typeof worldSchema>;

let world: World;

test.beforeAll(async () => {
  const stack = await readStack();
  const { stdout } = await run(
    process.execPath,
    [
      path.join(import.meta.dirname, "seed-jira-connect.ts"),
      JSON.stringify({ databaseUrl: stack.databaseUrl, dataDir: stack.dataDir, password: e2eAdmin.password, jira: { cloudId: stack.jira.cloudId, siteHost: stack.jira.siteHost, token: stack.jira.token, serviceAccountEmail: stack.jira.serviceAccountEmail, projectKey: stack.jira.projectKey } }),
    ],
    { cwd: path.resolve(import.meta.dirname, "..") },
  );
  world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
});

/** A signed admin-webhook delivery, as the fake Jira sends one: HMAC-SHA256 of the raw body. */
const delivery = (secret: string, timestamp: number): { readonly body: string; readonly headers: Record<string, string> } => {
  const body = JSON.stringify({ timestamp, webhookEvent: "jira:issue_updated", issue: { id: "1", key: `${world.jira.projectKey}-1` }, user: { accountId: "person" } });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "content-type": "application/json", "x-hub-signature": `sha256=${signature}`, "x-atlassian-webhook-identifier": randomUUID() } };
};

type Mode = "webhooks" | "polling";

/**
 * `trackers.jira.webhook` as a Jira admin sees it with a public address (its URL and the secret the
 * seed put in the store), or as polling; every other procedure in the batch is the server's own.
 */
const answerWebhook = async (page: Page, view: { mode: Mode; connectionId: string; secret: string }): Promise<void> => {
  const payload = () =>
    view.mode === "webhooks"
      ? {
          mode: "webhooks" as const,
          url: `https://ostra.acme.dev/webhooks/jira/${view.connectionId}`,
          secret: view.secret,
          events: EVENTS,
          jql: `project in (${world.jira.projectKey})`,
          webhooksPage: `https://${world.jira.siteName}.atlassian.net/plugins/servlet/webhooks`,
          firstDeliveryAt: null,
          badSignatureAt: null,
          lastEventAt: null,
        }
      : { mode: "polling" as const, reason: "not-https" as const };
  await page.route("**/api/trpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.replace(/^.*\/api\/trpc\//, "").split(",");
    if (route.request().method() !== "GET" || !procedures.includes("trackers.jira.webhook")) {
      await route.fallback();
      return;
    }
    // The webhook procedure is answered here, never run by the server (it would make it polling,
    // since the stack's address is loopback). Every other procedure in the batch is the server's
    // own: the same request without the webhook one.
    const others = procedures.filter((name) => name !== "trackers.jira.webhook");
    let answered: unknown[] = [];
    if (others.length > 0) {
      const inputRaw = url.searchParams.get("input");
      const input = inputRaw === null ? null : z.record(z.string(), z.unknown()).parse(JSON.parse(inputRaw));
      const otherUrl = new URL(url);
      otherUrl.pathname = url.pathname.replace(procedures.join(","), others.join(","));
      if (input !== null) {
        const filtered: Record<string, unknown> = {};
        others.forEach((name, at) => {
          const original = procedures.indexOf(name);
          const value = input[String(original)];
          if (value !== undefined) filtered[String(at)] = value;
        });
        otherUrl.searchParams.set("input", JSON.stringify(filtered));
      }
      const response = await route.fetch({ url: otherUrl.toString() });
      answered = z.array(z.unknown()).parse(await response.json());
    }
    let cursor = 0;
    const body = procedures.map((name) => {
      if (name === "trackers.jira.webhook") return { result: { data: { connectionId: view.connectionId, webhook: payload() } } };
      const entry = answered[cursor];
      cursor += 1;
      return entry;
    });
    await route.fulfill({ status: 200, headers: { "content-type": "application/json" }, json: body });
  });
};

/** Walks step 1's form: the site's name and the connection's name, then `Find the site`. */
const findSite = async (page: Page): Promise<void> => {
  await page.getByTestId("jira-site").fill(world.jira.siteName);
  await page.getByTestId("jira-name").fill("Globex Jira");
  await page.getByRole("button", { name: "Find the site" }).click();
  await expect(page.getByTestId("jira-done-count")).toHaveText("1 of 3");
};

/** Fills step 2's three fields, checking the token first when `check` is set. */
const fillToken = async (page: Page, expiresOn: string, check: boolean): Promise<void> => {
  await page.getByTestId("jira-email").fill(world.jira.serviceAccountEmail);
  await page.getByTestId("jira-token").fill(world.jira.token);
  await page.getByTestId("jira-expires").fill(expiresOn);
  if (check) {
    await page.getByRole("button", { name: "Check the token" }).click();
    await expect(page.getByTestId("jira-readback")).toBeVisible();
  }
};

const futureDay = (): string => new Date((Math.floor(Date.now() / DAY_MS) + 200) * DAY_MS).toISOString().slice(0, 10);
const soonDay = (): string => new Date((Math.floor(Date.now() / DAY_MS) + 13) * DAY_MS).toISOString().slice(0, 10);

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("F-008/c1, F-152/c2: three checked steps connect the fake Jira's site by webhook, its first signed delivery activates it, and the same site again is refused with Open it →", async ({ page }) => {
  await answerWebhook(page, { mode: "webhooks", connectionId: world.webhook.first, secret: world.webhook.secret });
  await signIn(page, world.webhook.username);
  await page.goto(`/organization/trackers/${world.webhook.first}`);

  // The header: the mark, the eyebrow, the name, the lede, the started line.
  await expect(page.getByRole("heading", { level: 1, name: "Jira" })).toBeVisible();
  await expect(page.getByText("Jira Cloud · connecting")).toBeVisible();
  await expect(page.getByText(/ostra signs in as a service account the client owns/)).toBeVisible();
  await expect(page.getByTestId("jira-start-again")).toBeVisible();
  await expect(page.getByTestId("jira-done-count")).toHaveText("0 of 3");

  // Step 1: the site's name, the name prefilled from it, Find the site reads its cloud ID.
  await expect(page.getByText("The Jira Cloud site this client works in. ostra finds its cloud ID from it.")).toBeVisible();
  await findSite(page);
  // The host sits beside the step's title at desktop width; a phone collapses a done step to one line.
  if ((page.viewportSize()?.width ?? 1440) >= 640) {
    await expect(page.getByText("globex.atlassian.net").first()).toBeVisible();
  }
  await expect(page.getByText("Jira Cloud. This connection is called Globex Jira.")).toBeVisible();
  await expect(page.getByTestId("jira-site-change")).toBeVisible();

  // Step 2: Check the token reads back four lines.
  await fillToken(page, futureDay(), true);
  const readback = page.getByTestId("jira-readback");
  await expect(readback.getByRole("list")).toBeVisible();
  await expect(readback.getByRole("listitem")).toHaveCount(4);
  await expect(readback).toContainText("Signs in as");
  await expect(readback).toContainText("· a service account, not a person");
  await expect(readback).toContainText(`Sees 1 project: ${world.jira.projectKey}`);
  await expect(readback).toContainText("Reads their workflows");
  // Its three outcomes are the target's icons and words, not an error.
  await expect(readback.locator('[data-outcome="ok"]')).toHaveCount(4);

  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByTestId("jira-done-count")).toHaveText("2 of 3");

  // Step 3: the URL, the secret, the six events, the JQL, and the wait row.
  await expect(page.getByRole("heading", { level: 3, name: "The admin webhook" })).toBeVisible();
  await expect(page.getByTestId("jira-webhook-url")).toContainText(`/webhooks/jira/${world.webhook.first}`);
  await expect(page.getByTestId("jira-webhook-secret")).toHaveText(world.webhook.secret);
  await expect(page.getByTestId("jira-webhook-events").getByRole("listitem")).toHaveCount(6);
  await expect(page.getByTestId("jira-webhook-jql")).toHaveText(`project in (${world.jira.projectKey})`);
  await expect(page.getByTestId("jira-webhook-wait")).toContainText("Waiting for the first delivery…");
  await expect(page.getByTestId("jira-connect-panel")).toContainText("The token needs");
  await expect(page.getByTestId("jira-connect-panel")).toContainText("Webhook events");
  await expect(page.getByTestId("jira-connect-panel")).toContainText("It sees");

  // The fake sends the first delivery, signed with the secret step 3 showed; core's inbox takes it
  // and activates the connection.
  const signed = delivery(world.webhook.secret, Date.now());
  const response = await page.request.post(`http://127.0.0.1:${String(e2eCorePort)}/webhooks/jira/${world.webhook.first}`, { headers: signed.headers, data: signed.body });
  expect(response.status()).toBe(200);
  await expect(page.getByTestId("jira-connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("jira-connected")).toContainText("Connected");
  await expect(page.getByTestId("jira-connected")).toContainText("Just connected");

  // F-152/c2: the same site in the same organization is refused, naming the holder, with Open it →.
  await page.goto(`/organization/trackers/${world.webhook.second}`);
  await page.getByTestId("jira-site").fill(world.jira.siteName);
  await page.getByRole("button", { name: "Find the site" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already connected" })).toContainText("globex.atlassian.net is already connected, as Globex Jira.");
  await expect(page.getByRole("link", { name: /Open it →/ })).toHaveAttribute("href", `/organization/trackers/${world.webhook.first}`);
  await expect(page.getByTestId("jira-done-count")).toHaveText("0 of 3");
});

test("F-008/c1, F-008/c8: without a public address step 3 is polling, Finish connects it, and a token 13 days from its date warns on step 2's done line", async ({ page }) => {
  await signIn(page, world.polling.username);
  await page.goto(`/organization/trackers/${world.polling.connectionId}`);
  await findSite(page);

  // F-008/c8: the date the admin gave is within 14 days, so the done line carries the warning.
  await fillToken(page, soonDay(), true);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByTestId("jira-done-count")).toHaveText("2 of 3");
  const warning = page.getByTestId("jira-token-expiry");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/Expires (in \d+ days|tomorrow), on /);

  // Step 3 is polling: why, how often, the setting, and Finish.
  await expect(page.getByRole("heading", { level: 3, name: "Events: polling" })).toBeVisible();
  await expect(page.getByTestId("jira-polling-why")).toContainText("This server's address isn't public");
  await expect(page.getByTestId("jira-polling-why")).toContainText("a ticket's change reaches ostra up to a minute late.");
  await expect(page.getByText("OSTRA_CORE_PUBLIC_URL")).toBeVisible();
  await expect(page.getByTestId("jira-connect-panel")).toContainText("Polling every 60 s");
  await expect(page.getByTestId("jira-connect-panel")).not.toContainText("Webhook events");
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByTestId("jira-connected")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("jira-connected")).toContainText("Just connected");
});

/** The screenshots of the connect screens, for comparison with the targets (both themes, both widths). */
const shoot = async (page: Page, name: string, theme: "dark" | "light"): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  const width = (page.viewportSize()?.width ?? 1440) < 600 ? "390" : "1440";
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
};

test("ticket 13: the connect screens at 1440 and 390 in both themes", async ({ page }) => {
  test.skip(shots === undefined, "screenshots only");
  const view: { mode: Mode; connectionId: string; secret: string } = { mode: "webhooks", connectionId: world.shots.connectionId, secret: world.shots.secret };
  await answerWebhook(page, view);
  await signIn(page, world.shots.username);
  await page.goto(`/organization/trackers/${world.shots.connectionId}`);

  // Step 1 done, step 2 checked: the target's `jira-connect`, dark.
  await findSite(page);
  await fillToken(page, futureDay(), true);
  await shoot(page, "jira-connect", "dark");

  // Step 3, waiting for the first delivery: the target's `jira-connect-webhook`, dark.
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByTestId("jira-webhook-wait")).toBeVisible();
  await shoot(page, "jira-connect-webhook", "dark");

  // Light: step 2 through Replace, then the webhook step again.
  await chooseTheme(page, "Light");
  await page.goto(`/organization/trackers/${world.shots.connectionId}`);
  await page.getByTestId("jira-token-replace").click();
  await fillToken(page, futureDay(), true);
  await shoot(page, "jira-connect", "light");
  await page.goto(`/organization/trackers/${world.shots.connectionId}`);
  await expect(page.getByTestId("jira-webhook-wait")).toBeVisible();
  await shoot(page, "jira-connect-webhook", "light");

  // No public address: step 3 is polling, light and dark.
  view.mode = "polling";
  await expect(page.getByRole("heading", { level: 3, name: "Events: polling" })).toBeVisible({ timeout: 10_000 });
  await shoot(page, "jira-connect-polling", "light");
  await chooseTheme(page, "Dark");
  await page.goto(`/organization/trackers/${world.shots.connectionId}`);
  await expect(page.getByRole("heading", { level: 3, name: "Events: polling" })).toBeVisible();
  await shoot(page, "jira-connect-polling", "dark");

  await chooseTheme(page, "Dark");
});
