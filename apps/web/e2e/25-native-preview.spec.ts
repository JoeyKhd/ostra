import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { z } from "zod";

import { ensureGitHub, expectNoHorizontalScroll, readStack, signIn } from "./helpers.ts";
import { runnerToken, startFixtureBox } from "./preview-box.ts";
import type { FixtureBox } from "./preview-box.ts";
import { e2eCoreUrl, e2ePreviewDomain } from "./settings.ts";
import { contextPanel } from "./shell.ts";

// Milestone 8, ticket 26 (F-144, F-142): the native preview and Instance › Previews, against the
// approved targets (`context/brand/app-targets/m8/preview-native.md`, `instance-preview-domain.md`).
// The stack's preview domain is `preview.localhost` (`stack.ts`), which needs no record and no
// certificate. The app is milestone 8's `test-web` fixture, served on this machine; the box's side is
// `apps/runner/src/testing/native-box-child.ts`, the runner's real tunnel code on core's real preview
// connection, told by this spec which native views core opened (the stack runs no runner). Between the
// member's browser and the fixture everything is the real panel and core's real native proxy: the
// one-time code, its handshake, the `__Host-` cookie, the rewrites and the framing headers.
// Chromium only: the e2e config has no Firefox project, where `network.cookie.cookieBehavior` 5
// would turn partitioning on (spike 08). `OSTRA_E2E_SHOTS` names a folder for the screenshots
// compared with the targets.

test.describe.configure({ mode: "serial" });

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({ organizationId: z.string(), projectName: z.string(), runnerId: z.string(), liveTaskId: z.string() });
type World = z.infer<typeof worldSchema>;

const seedWorld = async (args: Record<string, unknown>): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-preview-world.ts"), JSON.stringify({ databaseUrl, ...args })], { cwd: path.resolve(import.meta.dirname, "..") });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

const readSchema = z.object({ views: z.array(z.object({ id: z.string(), state: z.string(), mode: z.string(), leaseEpoch: z.number() })), enterCodes: z.number() });
const readTask = async (taskId: string) => readSchema.parse(await seedWorld({ mode: "read", taskId }));

let world: World | null = null;
let box: FixtureBox | null = null;
let tunnel: ChildProcess | null = null;
/** The task's native views told to the box's side: it serves each once, as a runner does on `preview.open`. */
const told = new Set<string>();
let watching = false;
let watcher: Promise<void> = Promise.resolve();

/** Tells the box's side of each native view core opened or closed for the task, until the file ends. */
const watchViews = async (taskId: string, child: ChildProcess): Promise<void> => {
  while (watching) {
    const read = await readTask(taskId).catch(() => null);
    for (const view of read?.views ?? []) {
      if (view.mode !== "native") continue;
      if (view.state === "closed") {
        if (told.has(view.id)) child.stdin?.write(`${JSON.stringify({ close: view.id })}\n`);
        told.delete(view.id);
        continue;
      }
      if (told.has(view.id)) continue;
      told.add(view.id);
      child.stdin?.write(`${JSON.stringify({ open: { viewId: view.id, key: "app-web", leaseEpoch: view.leaseEpoch } })}\n`);
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
};

const killTree = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
  await exited;
};

/** The world, the fixture's Vite and the box's tunnel side, made once for the file. */
const ready = async (page: Page, browser: Browser): Promise<World> => {
  await signIn(page);
  if (world === null) {
    await ensureGitHub(page);
    world = worldSchema.parse(await seedWorld({ mode: "seed", tag: `nv-${Date.now().toString(36)}`, tunnel: true }));
  }
  const { dataDir } = await readStack();
  if (dataDir === null) throw new Error("the native preview's spec needs the stack's own data folder");
  box ??= await startFixtureBox(browser, { dataDir, runnerId: world.runnerId, organizationId: world.organizationId });
  if (tunnel === null) {
    const runnerDir = path.resolve(import.meta.dirname, "..", "..", "runner");
    const token = await runnerToken(dataDir, world.runnerId, world.organizationId);
    const child = spawn(process.execPath, [path.join(runnerDir, "src", "testing", "native-box-child.ts"), JSON.stringify({ serverUrl: e2eCoreUrl, appPort: box.webPort })], {
      cwd: runnerDir,
      env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", OSTRA_TEST_ACCESS_TOKEN: token },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    tunnel = child;
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => { if (chunk.toString("utf8").includes("ready")) resolve(); });
      child.once("exit", (code) => { reject(new Error(`the box's tunnel side exited (${String(code)})`)); });
    });
    watching = true;
    watcher = watchViews(world.liveTaskId, child);
  }
  return world;
};

test.afterAll(async () => {
  watching = false;
  await watcher;
  if (tunnel !== null) await killTree(tunnel);
  tunnel = null;
  await box?.stop();
  box = null;
  // The specs after this one find the preview domain unchecked again, as a fresh install does.
  await seedWorld({ mode: "clear-check" });
});

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m8-t26-${name}.png`) });
};

/** The page in the other theme, for its screenshot, and back. */
const shootLight = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.evaluate(() => { document.documentElement.dataset["theme"] = "light"; });
  // The controls' colours ease over 150 ms: the picture waits for them.
  await page.waitForTimeout(400);
  await shoot(page, name);
  await page.evaluate(() => { document.documentElement.dataset["theme"] = "dark"; });
};

const pane = (page: Page): Locator => page.getByTestId("preview-pane");
const iframe = (page: Page): Locator => page.getByTestId("preview-iframe");
const checkRow = (page: Page, row: "dns" | "certificate" | "proxy" | "upgrade"): Locator => page.getByTestId("preview-domain-check").locator(`[data-row="${row}"]`);
/** The preview host the stack serves: `5173-<26 base32>.preview.localhost` on core's port. */
const previewHost = `5173-[a-z2-7]{26}\\.${e2ePreviewDomain.replaceAll(".", "\\.")}:${new URL(e2eCoreUrl).port}`;
const previewOrigin = new RegExp(`^http://${previewHost}`);

test("F-144/c8: Instance › Previews shows the preview domain, has nothing to add on preview.localhost, and its first visit runs the check, which passes through core's proxy", { tag: "@desktop-only" }, async ({ page, browser }) => {
  await ready(page, browser);
  await page.goto("/instance/previews");
  await expect(page.getByTestId("instance-previews")).toHaveAttribute("data-domain", e2ePreviewDomain);
  await expect(page.getByRole("heading", { level: 1, name: "Previews" })).toBeVisible();
  // The shell's Instance group has its row, selected here.
  await expect(contextPanel(page).getByRole("link", { name: "Previews", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("preview-domain-setting")).toContainText(`OSTRA_PREVIEW_DOMAIN${e2ePreviewDomain}`);
  // Under `localhost`: no record and no certificate to add; no warning (the panel is on `localhost`).
  await expect(page.getByTestId("preview-add-dns")).toContainText(`Not needed for ${e2ePreviewDomain}.`);
  await expect(page.getByTestId("preview-add-certificate")).toContainText(`Not needed for ${e2ePreviewDomain}.`);
  await expect(page.getByTestId("preview-domain-warning")).toHaveCount(0);
  // The check ran by itself on this first visit, and passed: core's own mark, and an upgrade.
  await expect(checkRow(page, "proxy")).toHaveAttribute("data-state", "passed", { timeout: 30_000 });
  await expect(checkRow(page, "dns")).toHaveAttribute("data-state", "not-needed");
  await expect(checkRow(page, "certificate")).toHaveAttribute("data-state", "not-needed");
  await expect(checkRow(page, "upgrade")).toHaveAttribute("data-state", "passed");
  await expect(checkRow(page, "proxy")).toContainText("Core's preview proxy answered.");
  await expect(page.getByTestId("preview-check-line")).toContainText(/Checked at \d\d:\d\d by .+\. Previews open in members' own browsers\./);
  await expect(page.getByTestId("preview-domain-status")).toHaveText("Working");
  // `Check again` runs it again, and keeps its result.
  await Promise.all([page.waitForResponse((answer) => answer.url().includes("instance.previewDomainCheck")), page.locator("[data-action='preview-check']").click()]);
  await expect(page.locator("[data-action='preview-check']")).toHaveText("Check again", { timeout: 30_000 });
  await expect(checkRow(page, "upgrade")).toHaveAttribute("data-state", "passed");
  // The organization's public-links switch, off by default, with its words.
  await expect(page.getByTestId("public-links-switch")).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId("public-links-setting")).toContainText("off: a link expires within 7 days");
  await shoot(page, "instance-previews-1440");
  await shootLight(page, "instance-previews-1440-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  await shoot(page, "instance-previews-390");
});

test("F-144/c1: the pane frames the fixture app on its preview host in the member's own browser, and the app's own state survives Expand: no reload", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const { liveTaskId } = await ready(page, browser);
  await page.goto(`/tasks/${liveTaskId}?pane=preview`);
  await expect(pane(page)).toHaveAttribute("data-state", "live", { timeout: 45_000 });
  await expect(page.getByTestId("preview-viewport")).toHaveAttribute("data-mode", "native");
  // The frame's source is the preview host's one-time sign-in, sandboxed without top navigation.
  const src = (await iframe(page).getAttribute("src")) ?? "";
  expect(src).toMatch(previewOrigin);
  expect(new URL(src).pathname).toBe("/.ostra/enter");
  await expect(iframe(page)).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads");
  // The app runs in this browser: a click on its counter is this page's own, with no relay.
  const app = page.frameLocator("[data-testid='preview-iframe']");
  const counter = app.locator("#counter");
  await expect(counter).toHaveText("Count: 0", { timeout: 30_000 });
  await counter.click();
  await counter.click();
  await expect(counter).toHaveText("Count: 2");
  // Its `/api` goes through Vite's proxy, on the preview's own origin.
  await expect(app.locator("#api")).not.toHaveText("", { timeout: 15_000 });
  // The footer: live, in your browser, the host; no watchers' count in this mode.
  const foot = page.getByTestId("preview-foot");
  await expect(foot).toHaveAttribute("data-mode", "native");
  await expect(foot).toContainText("Live");
  await expect(foot).toContainText("in your browser");
  await expect(page.getByTestId("preview-host")).toHaveAttribute("title", new RegExp(`^${previewHost}$`));
  await expect(page.getByTestId("preview-watchers")).toHaveCount(0);
  // Core served it through a native view on the box's connection, and no stream view opened.
  const read = await readTask(liveTaskId);
  expect(read.views.some((view) => view.mode === "native" && view.state !== "closed")).toBe(true);
  expect(read.views.filter((view) => view.mode === "stream")).toHaveLength(0);
  await shoot(page, "preview-native-1440");
  await shootLight(page, "preview-native-1440-light");

  // Expand: the same frame element, wider, and the app's count is still 2.
  await iframe(page).evaluate((node) => { node.setAttribute("data-e2e-kept", "yes"); });
  await page.locator("[data-action='preview-expand']").click();
  await expect(pane(page)).toHaveAttribute("data-expanded", "true");
  await expect(iframe(page)).toHaveAttribute("data-e2e-kept", "yes");
  await expect(counter).toHaveText("Count: 2");
  await page.locator("[data-action='preview-expand']").click();
  await expect(pane(page)).toHaveAttribute("data-expanded", "false");
  await expect(iframe(page)).toHaveAttribute("data-e2e-kept", "yes");
  await expect(counter).toHaveText("Count: 2");
});

test("F-144/c1: \"Open in a new tab\" makes its own handshake: a second one-time code, and the app on its preview host in a tab", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const { liveTaskId } = await ready(page, browser);
  await page.goto(`/tasks/${liveTaskId}?pane=preview`);
  await expect(pane(page)).toHaveAttribute("data-state", "live", { timeout: 45_000 });
  const before = (await readTask(liveTaskId)).enterCodes;
  const newTab = page.locator("[data-action='preview-new-tab']");
  await expect(newTab).toHaveAttribute("title", "Open in a new tab · it signs you in on the preview's own host");
  const [tab] = await Promise.all([page.context().waitForEvent("page"), newTab.click()]);
  await tab.waitForURL(previewOrigin, { timeout: 30_000 });
  await expect(tab.locator("#counter")).toHaveText("Count: 0", { timeout: 30_000 });
  // The tab's own code: one more than the frame's, and the tab never saw the frame's.
  expect((await readTask(liveTaskId)).enterCodes).toBe(before + 1);
  await tab.close();
});

test("F-144/c4: a page that sent X-Frame-Options shows in the frame, and the pane's notice says ostra replaced it, until dismissed", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const { liveTaskId } = await ready(page, browser);
  await page.goto(`/tasks/${liveTaskId}?pane=preview`);
  await expect(pane(page)).toHaveAttribute("data-state", "live", { timeout: 45_000 });
  // The path field loads the fixture's page that refuses framing, on the preview's host.
  const field = page.getByTestId("preview-path");
  await field.fill("/frame-deny");
  await field.press("Enter");
  await expect(page.frameLocator("[data-testid='preview-iframe']").locator("h1")).toHaveText("This page sends X-Frame-Options: DENY", { timeout: 30_000 });
  const notice = page.getByTestId("preview-framing-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("web sent X-Frame-Options. ostra replaced it: only this panel can frame the preview.");
  await expect(notice).toHaveAttribute("title", /X-Frame-Options: DENY\./);
  await shoot(page, "preview-native-notice-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: "Preview" }).click();
  await expect(notice).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shoot(page, "preview-native-390");
  await page.setViewportSize({ width: 1440, height: 900 });
  // Dismissed, it stays away for this preview in this browser.
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(pane(page)).toHaveAttribute("data-state", "live", { timeout: 45_000 });
  await expect(page.getByTestId("preview-framing-notice")).toHaveCount(0);
});

test("F-144/c1: \"Use the box's browser\" switches the pane to the stream and keeps the choice; \"Open it in your browser\" brings the app back", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const { liveTaskId } = await ready(page, browser);
  await page.goto(`/tasks/${liveTaskId}?pane=preview`);
  await expect(page.getByTestId("preview-viewport")).toHaveAttribute("data-mode", "native", { timeout: 30_000 });
  await page.getByTestId("preview-foot").locator("[data-action='preview-use-box']").click();
  await expect(page.getByTestId("preview-viewport")).toHaveAttribute("data-mode", "stream");
  await expect(page).toHaveURL(/[?&]mode=stream/);
  // The choice is the member's, per preview: a fresh visit with no mode in the address keeps it.
  await page.goto(`/tasks/${liveTaskId}?pane=preview`);
  await expect(page.getByTestId("preview-viewport")).toHaveAttribute("data-mode", "stream", { timeout: 30_000 });
  const open = page.getByTestId("preview-foot").locator("[data-action='preview-open-here']");
  await expect(open).toHaveText("Open it in your browser");
  await open.click();
  await expect(page.getByTestId("preview-viewport")).toHaveAttribute("data-mode", "native");
  await expect(pane(page)).toHaveAttribute("data-state", "live", { timeout: 45_000 });
});
