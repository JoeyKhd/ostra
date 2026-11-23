import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Locator, Page, Route } from "@playwright/test";
import { z } from "zod";

import { checkContrast, prepareA11y, walkByTab } from "./a11y/checks.ts";
import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { settleRoute } from "./routes.ts";
import { e2eBaseUrl, e2eFakeControlUrl } from "./settings.ts";

// F-006/c4 (app-targets/m10-gaps/github-events.md): an App the manifest flow made while ostra had
// no public address has no webhook and takes no events; the GitHub page says so and finishes it
// later. On the stack's own App (connected with a webhook secret): the section line and the Events
// row say it waits while GitHub lists only some of its events, `Which ones` lists the missing ones,
// once the fake GitHub lists all ten the row reads On, and `New webhook secret` asks first and goes
// to core, which refuses while the stack's address is loopback. An App made without a webhook is the
// stack's App as `github.connections` answers with its webhook left out (`withoutWebhook`): the
// row's states, core's refusal of `Turn on`, and its result shown once with the leave dialog. Core's
// side of a Turn on with a public address is `apps/core/src/webhooks/github-webhook-later.test.ts`.
// `OSTRA_E2E_SHOTS` names a folder for the screenshots compared with the targets, drawn on the
// targets' own demo data (`demoRoutes`).

const shots = process.env["OSTRA_E2E_SHOTS"];

/** Every event ostra uses, in the manifest's order (`appEvents`). */
const ALL_EVENTS = ["pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "issue_comment", "check_run", "check_suite", "status", "push", "workflow_run"] as const;
/** What the fake App subscribes to unless a spec changes it: an App made before milestone 6. */
const FAKE_DEFAULT_EVENTS = ["pull_request"];
const SECRET = "9f2c41d07a6b8e35c1f0d4a92b7e6c58";
const REFUSED = "This server's address isn't public, so GitHub can't deliver to it. Set OSTRA_CORE_PUBLIC_URL to a public address first.";

/** The fake GitHub lists `events` as the App's, as an admin ticking them in its settings would. */
const setAppEvents = async (events: readonly string[]): Promise<void> => {
  const response = await fetch(`${e2eFakeControlUrl}/github/app-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
  expect(response.status).toBe(204);
};

const batchSchema = z.array(z.unknown());
const resultSchema = z.object({ result: z.object({ data: z.unknown() }) });

/** Answers the named queries of every tRPC batch with `edit` applied to what the server answered. */
const rewrite = async (page: Page, edits: Readonly<Record<string, (data: unknown) => unknown>>): Promise<void> => {
  await page.route("**/api/trpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const procedures = url.pathname.replace(/^.*\/api\/trpc\//, "").split(",");
    if (route.request().method() !== "GET" || !procedures.some((name) => name in edits)) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = batchSchema.parse(await response.json());
    for (const [index, name] of procedures.entries()) {
      const edit = edits[name];
      const answered = resultSchema.safeParse(body[index]);
      if (edit !== undefined && answered.success) body[index] = { result: { data: edit(answered.data.result.data) } };
    }
    await route.fulfill({ response, json: body });
  });
};

const appsSchema = z.array(z.looseObject({ slug: z.string().nullable() }));
const requestSchema = z.looseObject({ webhookPossible: z.boolean() });
const turnOnInputSchema = z.object({ "0": z.object({ connectionId: z.string() }) });

/** `github.connections` with the stack's App as one made without a webhook: no secret, every event missing. */
const withoutWebhook = (slug: string) => (data: unknown): unknown =>
  appsSchema.parse(data).map((app) => (app.slug === slug ? { ...app, webhook: { kind: "none" }, missingEvents: [...ALL_EVENTS] } : app));

/** `github.appRequest` with the server's address public or not. */
const publicAddress = (possible: boolean) => (data: unknown): unknown => ({ ...requestSchema.parse(data), webhookPossible: possible });

/** `github.turnOnWebhook` as core answers it with a public address: the App's own address, the secret, the events. */
const answerTurnOn = async (page: Page, options: { readonly base: string; readonly replaced: boolean }): Promise<void> => {
  await page.route("**/api/trpc/github.turnOnWebhook**", async (route) => {
    const { connectionId } = turnOnInputSchema.parse(route.request().postDataJSON())["0"];
    await route.fulfill({ json: [{ result: { data: { connectionId, webhookUrl: `${options.base}/webhooks/github/${connectionId}`, webhookSecret: SECRET, events: [...ALL_EVENTS], replaced: options.replaced } } }] });
  });
};

/** The stack's App's section on the page. */
const stackApp = async (page: Page): Promise<{ readonly slug: string; readonly section: Locator }> => {
  const { github } = await readStack();
  const section = page.locator(`[data-testid="github-app"][data-slug="${github.slug}"]`);
  await expect(section).toBeVisible();
  return { slug: github.slug, section };
};

test.describe.configure({ mode: "serial" });

// A refetch still in flight when a test ends finds its page gone: the routes go first.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test.afterAll(async () => {
  await setAppEvents(FAKE_DEFAULT_EVENTS);
});

test("F-006/c4: an App that takes only some events waits for them: Which ones lists the missing ones, and once GitHub lists all ten it reads On", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  await ensureGitHub(page);
  await setAppEvents(FAKE_DEFAULT_EVENTS);
  await page.goto("/organization/github");
  const { slug, section } = await stackApp(page);
  await expect(section.getByTestId("webhook-state")).toHaveAttribute("data-state", "waiting");
  await expect(section.getByTestId("webhook-state")).toHaveText("Waiting for events");
  // Its webhook is set, so no note says its events are off.
  await expect(section.getByTestId("events-off-note")).toHaveCount(0);

  await section.getByRole("button", { name: new RegExp(slug) }).first().click();
  const row = page.getByTestId("app-panel").getByTestId("events-row");
  await expect(row).toHaveAttribute("data-state", "waiting");
  await expect(row).toContainText("EventsWaiting for events");
  await expect(row.getByTestId("events-line")).toContainText("Subscribe to 9 events in the App's settings on GitHub.");
  await expect(row.getByRole("link", { name: "Permissions and events" })).toHaveAttribute("href", new RegExp(`/settings/apps/${slug}/permissions$`));

  // Which ones: the missing events, in ostra's order, and no secret.
  await row.getByRole("button", { name: "Which ones" }).click();
  const shown = page.getByTestId("shown-once");
  await expect(shown).toHaveAttribute("data-kind", "which-ones");
  await expect(shown.getByTestId("events-to-tick").locator("li")).toHaveText(ALL_EVENTS.filter((event) => event !== "pull_request"));
  await expect(shown).toContainText("Tick these 9 under Subscribe to events, then save.");
  await expect(shown.getByTestId("webhook-secret")).toHaveCount(0);
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(row).toHaveAttribute("data-state", "waiting");

  // GitHub lists all ten: the row reads On, and the section line no longer waits.
  await setAppEvents(ALL_EVENTS);
  await page.reload();
  await section.getByRole("button", { name: new RegExp(slug) }).first().click();
  await expect(row).toHaveAttribute("data-state", "on");
  await expect(row).toContainText("On· 10 events");
  await expect(section.getByTestId("webhook-state")).toHaveAttribute("data-state", /^(receiving|failing)$/);

  // New webhook secret asks first; core refuses it while the stack's address is loopback, and says why.
  await row.getByRole("button", { name: "New webhook secret" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByRole("heading", { name: "Replace the webhook secret?" })).toBeVisible();
  await expect(confirm).toContainText(`GitHub keeps signing with the old secret until you paste the new one in ${slug}'s settings.`);
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await row.getByRole("button", { name: "New webhook secret" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace the secret" }).click();
  await expect(row.getByRole("alert")).toHaveText(REFUSED);
  await expect(page.getByTestId("shown-once")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("F-006/c4: an App made without a webhook says its events are off, names the setting while the address isn't public, and core refuses Turn on until it is", async ({ page }) => {
  await signIn(page);
  await ensureGitHub(page);
  const { github } = await readStack();
  await rewrite(page, { "github.connections": withoutWebhook(github.slug), "github.appRequest": publicAddress(false) });
  await page.goto("/organization/github");
  const { slug, section } = await stackApp(page);
  await expect(section.getByTestId("webhook-state")).toHaveText("Events off");
  const note = section.getByTestId("events-off-note");
  await expect(note).toHaveText("Made while this server had no public address, so GitHub sends it no events.");
  await section.getByRole("button", { name: new RegExp(slug) }).first().click();
  const row = page.getByTestId("app-panel").getByTestId("events-row");
  await expect(row).toHaveAttribute("data-state", "no-public");
  await expect(row).toContainText("Off · no public address");
  await expect(row.getByTestId("events-line")).toHaveText("GitHub can't reach this server. Set OSTRA_CORE_PUBLIC_URL to a public address and restart core, then turn them on here.");
  await expect(row.getByRole("button")).toHaveCount(0);

  // With a public address the page offers Turn on. Core, whose address is loopback here, refuses it,
  // as one restarted without a public address would, and `appRequest`, asked again, says so too.
  let possible = true;
  await page.unrouteAll({ behavior: "wait" });
  await rewrite(page, { "github.connections": withoutWebhook(github.slug), "github.appRequest": (data) => publicAddress(possible)(data) });
  await page.reload();
  await expect(note.getByRole("button", { name: "Turn them on" })).toBeVisible();
  await section.getByRole("button", { name: new RegExp(slug) }).first().click();
  await expect(row).toHaveAttribute("data-state", "off");
  await expect(row.getByTestId("events-line")).toHaveText("Without them, ostra learns of PR changes only on its periodic check, and never sees @ostra in a PR comment.");
  possible = false;
  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(row.getByRole("alert")).toHaveText(REFUSED);
  await expect(row).toHaveAttribute("data-state", "no-public");
  await expect(note.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("shown-once")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // The address made public later: the next time `appRequest` answers (here on the window's focus,
  // its answer 15s old), Turn on is back, without a reload, and the refusal is gone.
  possible = true;
  await page.clock.setFixedTime(Date.now() + 60_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("visibilitychange")); });
  await expect(row).toHaveAttribute("data-state", "off");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(note.getByRole("button", { name: "Turn them on" })).toBeVisible();
});

test("F-006/c4: Turn on's result shows the App's webhook address, the secret once and the ten events, and leaving it before Done asks first", { tag: "@desktop-only" }, async ({ page }) => {
  await signIn(page);
  await ensureGitHub(page);
  const { github } = await readStack();
  await rewrite(page, { "github.connections": withoutWebhook(github.slug), "github.appRequest": publicAddress(true) });
  await answerTurnOn(page, { base: "https://ostra.example.com", replaced: false });
  // Reached from another of the panel's pages, so Back stays in the panel (Next's own history).
  await page.goto("/organization/members");
  await page.locator('a[href="/organization/github"]').first().click();
  await expect(page).toHaveURL(/\/organization\/github$/);
  const { slug, section } = await stackApp(page);

  // The note's Turn them on selects the App and starts Turn on; the panel widens to hold the result.
  await section.getByTestId("events-off-note").getByRole("button", { name: "Turn them on" }).click();
  const shown = page.getByTestId("shown-once");
  await expect(shown).toHaveAttribute("data-kind", "secret");
  await expect(shown.getByRole("heading", { name: "Turn on events" })).toBeFocused();
  // Tab: the URL's copy, the secret's, GitHub's two pages, Done.
  for (const next of [shown.getByRole("button", { name: "Copy" }).first(), shown.getByRole("button", { name: "Copy" }).last(), shown.getByRole("link", { name: "General" }), shown.getByRole("link", { name: "Permissions", exact: true }), shown.getByRole("button", { name: "Done" })]) {
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  await expect(section.getByRole("button", { name: new RegExp(slug) }).first()).toHaveAttribute("aria-pressed", "true");
  expect((await page.getByRole("complementary", { name: "Properties" }).boundingBox())?.width).toBe(380);
  await expect(shown).toContainText("Set these in the App's settings on GitHub: it has no call that does it for ostra.");
  await expect(shown).toContainText("Webhook, under General");
  await expect(shown).toContainText("Tick Active, then paste both.");
  await expect(shown.getByTestId("webhook-url")).toHaveText(/^https:\/\/ostra\.example\.com\/webhooks\/github\/[0-9a-f-]{36}$/);
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);
  await expect(shown).toContainText("The secret is shown once. Copy it now: ostra keeps it in the secret store and never shows it again.");
  const general = shown.getByRole("link", { name: "General" });
  await expect(general).toHaveAttribute("href", new RegExp(`^https://github\\.com/(organizations/[^/]+/)?settings/apps/${slug}$`));
  await expect(general).toHaveAttribute("target", "_blank");
  await expect(general).toHaveAttribute("rel", "noreferrer");
  await expect(shown.getByRole("link", { name: "Permissions", exact: true })).toHaveAttribute("href", new RegExp(`/settings/apps/${slug}/permissions$`));
  await expect(shown).toContainText("Tick these 10 under Subscribe to events, then save.");
  await expect(shown.getByTestId("events-to-tick").locator("li")).toHaveText([...ALL_EVENTS]);
  await expect(shown).toContainText("Events reads On once GitHub lists all 10.");

  // Leaving it any other way asks first: another row, Esc, a link to another page, the shell's keys,
  // Back. Stay keeps it.
  const leave = page.getByRole("alertdialog");
  const otherRow = section.getByTestId("installation").first().getByRole("button").first();
  await otherRow.click();
  await expect(leave.getByRole("heading", { name: "Leave without copying the secret?" })).toBeVisible();
  await expect(leave).toContainText("ostra shows it only now. Without it in the App's settings, GitHub's deliveries can't be checked and ostra drops them. You'd make another with New webhook secret.");
  await expect(leave.getByRole("button", { name: "Stay" })).toBeFocused();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);
  // Esc with the focus outside the result, on the row that asked, still asks.
  await otherRow.focus();
  await page.keyboard.press("Escape");
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await page.getByRole("link", { name: /^Members/ }).first().click();
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  // `g` then `h`: Home, through the shell's router.
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await page.goBack({ waitUntil: "commit" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/organization\/github/);
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);

  // Done goes back to the App's panel without asking.
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(leave).toHaveCount(0);
  const row = page.getByTestId("app-panel").getByTestId("events-row");
  await expect(row).toBeVisible();

  // Turn on from the panel's row, then leave for another row: the result and its secret are gone.
  await row.getByRole("button", { name: "Turn on" }).click();
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);
  await otherRow.click();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByTestId("installation-panel")).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);

  // Turn on again, then Back: Leave goes where Back was going, and the secret goes with the page.
  await section.getByTestId("events-off-note").getByRole("button", { name: "Turn them on" }).click();
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);
  await page.goBack({ waitUntil: "commit" });
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(page).toHaveURL(/\/organization\/members$/);
  await expect(page.getByTestId("github-app")).toHaveCount(0);
  expect(await page.content()).not.toContain(SECRET);
});

test("F-006/c4: on a phone Turn on's result is a bottom sheet with 44px fields, and its close asks first", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the phone's sheet");
  await signIn(page);
  await ensureGitHub(page);
  const { github } = await readStack();
  await rewrite(page, { "github.connections": withoutWebhook(github.slug), "github.appRequest": publicAddress(true) });
  await answerTurnOn(page, { base: "https://ostra.example.com", replaced: false });
  await page.goto("/organization/github");
  const { section } = await stackApp(page);
  await section.getByTestId("events-off-note").getByRole("button", { name: "Turn them on" }).click();
  const sheet = page.getByRole("dialog");
  const shown = sheet.getByTestId("shown-once");
  await expect(shown.getByTestId("webhook-secret")).toHaveText(SECRET);
  expect((await shown.getByTestId("webhook-url").boundingBox())?.height).toBe(44);
  expect((await shown.getByRole("button", { name: "Done" }).boundingBox())?.height).toBe(44);
  await expectNoHorizontalScroll(page);

  // Its close asks first; Leave closes it, and the secret is gone.
  await sheet.getByRole("button", { name: "Close" }).last().click();
  const leave = page.getByRole("alertdialog");
  await expect(leave.getByRole("heading", { name: "Leave without copying the secret?" })).toBeVisible();
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(shown).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).last().click();
  await leave.getByRole("button", { name: "Leave" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await page.content()).not.toContain(SECRET);
});

test("F-081/c2: the Events row and Turn on's result pass the keyboard walk and the contrast check in both themes", async ({ page, isMobile }) => {
  test.skip(isMobile, "the desktop panel");
  test.setTimeout(120_000);
  await prepareA11y(page);
  await signIn(page);
  await ensureGitHub(page);
  const { github } = await readStack();
  await rewrite(page, { "github.connections": withoutWebhook(github.slug), "github.appRequest": publicAddress(true) });
  await answerTurnOn(page, { base: "https://ostra.example.com", replaced: false });
  const problems: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
    await page.goto("/organization/github");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const { slug, section } = await stackApp(page);
    await section.getByRole("button", { name: new RegExp(slug) }).first().click();
    await expect(page.getByTestId("events-row")).toHaveAttribute("data-state", "off");
    // The walk starts from the page, not from the line a pointer just chose.
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await settleRoute(page);
    problems.push(...(await checkContrast(page, null)).failures.map((failure) => `${theme}, events off: ${failure}`));
    problems.push(...(await walkByTab(page, null)).map((problem) => `${theme}, events off: ${problem}`));
    await page.getByTestId("events-row").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByTestId("shown-once").getByTestId("webhook-secret")).toBeVisible();
    problems.push(...(await checkContrast(page, null)).failures.map((failure) => `${theme}, the result: ${failure}`));
    problems.push(...(await walkByTab(page, null)).map((problem) => `${theme}, the result: ${problem}`));
    await page.getByTestId("shown-once").getByRole("button", { name: "Done" }).click();
  }
  expect((await page.request.post("/api/trpc/account.setTheme", { data: { theme: "dark" }, headers: { origin: e2eBaseUrl } })).ok()).toBe(true);
  expect(problems).toEqual([]);
});

// ── The side-by-side shots (OSTRA_E2E_SHOTS): the targets' demo data, at their sizes ─────────────

const DEMO_ACME = "0d8f2a14-6b3e-4c71-9a2d-5e8b1c3f7a01";
const DEMO_NORTHWIND = "0d8f2a14-6b3e-4c71-9a2d-5e8b1c3f7a02";

type DemoState = {
  webhook: { readonly kind: "none" } | { readonly kind: "receiving"; readonly lastDeliveryAt: number | null } | { readonly kind: "failing"; readonly lastDeliveryAt: number; readonly lastError: string };
  missingEvents: readonly string[] | null;
  webhookPossible: boolean;
};

const installation = (accountLogin: string, isOwner: boolean, repos: number | "all", id: number) => ({
  installationId: String(id),
  accountLogin,
  accountKind: "organization",
  state: "linked",
  isOwner,
  repoSelection: repos === "all" ? "all" : "selected",
  repos: repos === "all" ? [] : Array.from({ length: repos }, (_, i) => ({ hostRepoId: `${String(id)}${String(i)}`, fullName: `${accountLogin}/repo-${String(i)}`, defaultBranch: "main", private: true })),
  installedAt: null,
  installedBy: null,
  removedAt: null,
  removedBy: null,
  projects: [],
});

/** The targets' Apps (`ostra-acme`, `northwind-ostra`), Acme Corp, and ostra-acme's webhook as `state` says. */
const demoRoutes = async (page: Page, state: DemoState): Promise<void> => {
  await rewrite(page, {
    "github.connections": () => [
      {
        connectionId: DEMO_ACME,
        appId: "1184207",
        slug: "ostra-acme",
        ownerLogin: "acme",
        ownerKind: "organization",
        public: true,
        own: true,
        webhookUrl: "https://ostra.acme.dev/webhooks/github/cn_8f2kq7",
        webhook: state.webhook,
        missingEvents: state.missingEvents,
        installations: [installation("acme", true, "all", 51), installation("globex", false, 2, 52)],
      },
      {
        connectionId: DEMO_NORTHWIND,
        appId: "1190331",
        slug: "northwind-ostra",
        ownerLogin: "northwind-co",
        ownerKind: "organization",
        public: false,
        own: false,
        webhookUrl: "https://ostra.acme.dev/webhooks/github/cn_3d9wq1",
        webhook: { kind: "receiving", lastDeliveryAt: null },
        missingEvents: [],
        installations: [installation("northwind-co", true, 3, 53)],
      },
    ],
    "github.connection": () => ({
      connectionId: DEMO_ACME,
      appId: "1184207",
      slug: "ostra-acme",
      botName: "ostra-acme[bot]",
      botEmail: "1184207+ostra-acme[bot]@users.noreply.github.com",
      permissions: { checks: "write", contents: "write", pull_requests: "write", issues: "write", statuses: "write", actions: "read", metadata: "read" },
      clientSecretSet: true,
    }),
    "github.appRequest": (data) => ({ ...requestSchema.parse(data), webhookPossible: state.webhookPossible }),
    "me.get": (data) => {
      const me = z.looseObject({ organization: z.looseObject({}).nullable() }).parse(data);
      return { ...me, organization: me.organization === null ? null : { ...me.organization, name: "Acme Corp" } };
    },
  });
};

const settle = async (page: Page): Promise<void> => {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
};

/** The page or one element, in a theme. */
const shoot = async (page: Page, name: string, theme: "dark" | "light", locator?: Locator): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.evaluate((value) => { document.documentElement.setAttribute("data-theme", value); }, theme);
  await page.waitForTimeout(150);
  const file = path.join(shots, `${name}-${theme}.png`);
  if (locator === undefined) await page.screenshot({ path: file, scale: "css" });
  else await locator.screenshot({ path: file, scale: "css" });
};

/** Copies the secret, so its button shows its check, as the target does (`copied: true`). */
const copySecret = async (page: Page, scope: Locator): Promise<void> => {
  await scope.getByRole("button", { name: "Copy" }).last().click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
};

test("the targets' shots: events off, Turn on's result, the states and the phone", async ({ page, isMobile, context }) => {
  test.skip(shots === undefined, "OSTRA_E2E_SHOTS names the folder for the side-by-side shots");
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await ensureGitHub(page);
  const state: DemoState = { webhook: { kind: "none" }, missingEvents: [...ALL_EVENTS], webhookPossible: true };
  await demoRoutes(page, state);
  await answerTurnOn(page, { base: "https://ostra.acme.dev", replaced: false });

  if (isMobile) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/organization/github");
    const note = page.getByTestId("events-off-note");
    await expect(note).toBeVisible();
    state.webhook = { kind: "receiving", lastDeliveryAt: null };
    await note.getByRole("button", { name: "Turn them on" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("webhook-secret")).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await settle(page);
      await copySecret(page, sheet);
      await shoot(page, "github-events-phone", theme);
    }
    return;
  }

  // github-events: the App selected, events off, Turn on (1440 × 956).
  await page.setViewportSize({ width: 1440, height: 956 });
  await page.goto(`/organization/github?app=${DEMO_ACME}`);
  const panel = page.getByTestId("app-panel");
  await expect(panel.getByTestId("events-row")).toHaveAttribute("data-state", "off");
  await settle(page);
  await shoot(page, "github-events", "dark");
  await shoot(page, "github-events", "light");

  // github-events-turn-on: the result, the secret copied; the App now waits for its events.
  state.webhook = { kind: "receiving", lastDeliveryAt: null };
  await panel.getByRole("button", { name: "Turn on" }).click();
  const shown = page.getByTestId("shown-once");
  await expect(shown.getByTestId("webhook-secret")).toBeVisible();
  await expect(page.locator(`[data-testid="github-app"][data-slug="ostra-acme"] [data-testid="webhook-state"]`)).toHaveAttribute("data-state", "waiting");
  await shown.getByRole("heading", { name: "Turn on events" }).evaluate((node) => { if (node instanceof HTMLElement) node.blur(); });
  for (const theme of ["dark", "light"] as const) {
    await settle(page);
    await copySecret(page, shown);
    await shoot(page, "github-events-turn-on", theme);
  }
  await page.evaluate(() => { document.documentElement.setAttribute("data-theme", "dark"); });
  await shown.getByRole("button", { name: "Done" }).click();

  // The states: the Events row and the section line in each.
  const row = panel.getByTestId("events-row");
  const line = page.locator(`[data-testid="github-app"][data-slug="ostra-acme"] > button`).first();
  const states: readonly { readonly name: string; readonly set: () => void; readonly row: string; readonly line: string | null }[] = [
    { name: "nopublic", set: () => { state.webhook = { kind: "none" }; state.missingEvents = [...ALL_EVENTS]; state.webhookPossible = false; }, row: "no-public", line: "off" },
    { name: "off", set: () => { state.webhookPossible = true; }, row: "off", line: null },
    { name: "waiting", set: () => { state.webhook = { kind: "receiving", lastDeliveryAt: null }; }, row: "waiting", line: "waiting" },
    { name: "on", set: () => { state.missingEvents = []; }, row: "on", line: "receiving" },
    { name: "unknown", set: () => { state.missingEvents = null; }, row: "unknown", line: null },
    { name: "failing", set: () => { state.missingEvents = []; state.webhook = { kind: "failing", lastDeliveryAt: Date.now(), lastError: "The last delivery failed" }; }, row: "on", line: "failing" },
  ];
  for (const each of states) {
    each.set();
    await page.goto(`/organization/github?app=${DEMO_ACME}`);
    await expect(row).toHaveAttribute("data-state", each.row);
    await settle(page);
    if (each.name !== "failing") await shoot(page, `state-row-${each.name}`, "dark", row);
    if (each.line !== null) await shoot(page, `state-line-${each.line}`, "dark", line);
  }

  // New webhook secret: its confirm, then its result (no events step: none missing).
  await answerTurnOn(page, { base: "https://ostra.acme.dev", replaced: true });
  state.webhook = { kind: "receiving", lastDeliveryAt: null };
  state.missingEvents = [];
  await page.goto(`/organization/github?app=${DEMO_ACME}`);
  await row.getByRole("button", { name: "New webhook secret" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await settle(page);
  await shoot(page, "state-replace", "dark", dialog);
  await dialog.getByRole("button", { name: "Replace the secret" }).click();
  await expect(shown).toHaveAttribute("data-kind", "secret");
  await shown.getByRole("heading", { name: "New webhook secret" }).evaluate((node) => { if (node instanceof HTMLElement) node.blur(); });
  await settle(page);
  await shoot(page, "state-new-secret", "dark", shown);
  // The leave dialog, from another row.
  await page.locator('[data-testid="installation"]').first().getByRole("button").first().click();
  await expect(dialog.getByRole("heading", { name: "Leave without copying the secret?" })).toBeVisible();
  await settle(page);
  await shoot(page, "state-leave", "dark", dialog);
});
