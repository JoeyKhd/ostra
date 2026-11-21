import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { e2eAdmin } from "./settings.ts";
import { ensureGitHub, readStack, signIn } from "./helpers.ts";
import { startFixtureBox } from "./preview-box.ts";

// Milestone 8 (F-142; `preview-viewer.md`, open point 2): a preview shared by name. The demo's step
// 8: Demo names Sam on the live task's preview from the share menu; Sam, a member the restricted
// project doesn't list, signs in, opens the notice from Needs you and watches the stream on the
// preview's own page (`/previews/<id>`), watch-only, with nothing else of the task; and once Demo
// takes Sam's name off, Sam's open page ends. The world is `seed-preview-world.ts`'s, restricted;
// the box is `preview-box.ts`'s fixture, on core's real preview connection. `OSTRA_E2E_SHOTS` names
// a folder for the screenshots.

const run = promisify(execFile);
const webDir = path.resolve(import.meta.dirname, "..");
const shots = process.env["OSTRA_E2E_SHOTS"];

const worldSchema = z.object({ organizationId: z.string(), organizationName: z.string(), projectName: z.string(), runnerId: z.string(), runnerName: z.string(), liveTaskId: z.string() });

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `named-${name}.png`) });
};

test("F-142/c3: a person named on a preview signs in, opens the notice and watches the stream on the preview's own page, watch-only and nothing else of the task, until their name is taken off", { tag: "@desktop-only" }, async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await ensureGitHub(page);
  const { databaseUrl, dataDir } = await readStack();
  if (dataDir === null) throw new Error("the spec needs the stack's own data folder");
  const tag = `ps-${Date.now().toString(36)}`;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-preview-world.ts"), JSON.stringify({ databaseUrl, mode: "seed", tag, restricted: true })], { cwd: webDir });
  const world = worldSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  const sam = `sam-${tag}`;
  await run(process.execPath, [path.join(import.meta.dirname, "seed-member.ts"), JSON.stringify({ databaseUrl, username: sam, password: e2eAdmin.password })], { cwd: webDir });
  const box = await startFixtureBox(browser, { dataDir, runnerId: world.runnerId, organizationId: world.organizationId });
  const samContext = await browser.newContext({ viewport: { width: 1440, height: 956 } });
  try {
    // Demo names Sam from the share menu.
    await page.goto(`/tasks/${world.liveTaskId}?pane=preview`);
    await expect(page.getByTestId("preview-pane")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("preview-share").click();
    const menu = page.getByTestId("preview-share-menu");
    await menu.getByRole("radio", { name: "Named people" }).click();
    await menu.getByLabel("Find a member").fill(sam);
    await menu.getByRole("checkbox", { name: sam }).click();
    await expect(menu.getByRole("list", { name: "The people picked" })).toContainText(sam);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("preview-share")).toHaveAttribute("data-level", "named");

    // Sam signs in, in a browser of their own, and finds the notice on Needs you.
    const samPage = await samContext.newPage();
    const requests: string[] = [];
    samPage.on("request", (request) => { requests.push(new URL(request.url()).pathname); });
    await samPage.clock.install();
    await samPage.goto("/sign-in");
    await signIn(samPage, sam, e2eAdmin.password);
    await samPage.goto("/needs-you");
    const notice = samPage.getByTestId("preview-share");
    await expect(notice).toContainText("shared web :5173 with you", { timeout: 30_000 });
    await shoot(samPage, "notification");

    // Watch opens the preview's own page: the stream alone, watch-only, with no expiry.
    await notice.getByRole("link", { name: "Watch web :5173" }).click();
    await samPage.waitForURL(/\/previews\/[^/?]+$/);
    const viewer = samPage.getByTestId("preview-viewer");
    await expect(viewer).toHaveAttribute("data-source", "shared");
    const frame = samPage.getByTestId("preview-frame");
    await expect(frame).toHaveAttribute("data-view-id", /.+/, { timeout: 30_000 });
    const view = await box.serve((await frame.getAttribute("data-view-id")) ?? "", 1);
    await expect(viewer).toHaveAttribute("data-state", "live", { timeout: 30_000 });
    await expect.poll(async () => Number((await samPage.getByTestId("preview-canvas").getAttribute("data-frame-seq")) ?? "0"), { timeout: 15_000 }).toBeGreaterThan(1);
    await expect(samPage.locator("footer")).toContainText("Live");
    await expect(samPage.getByTestId("viewer-mode").filter({ visible: true })).toHaveText("Watch only");
    await expect(samPage.getByTestId("viewer-expiry")).toHaveCount(0);
    await expect(frame).toHaveAttribute("data-input", "false");
    await expect(samPage).toHaveTitle(`web :5173 · ${world.organizationName}`);
    await expect(samPage.getByRole("banner")).toContainText(`a preview from ${world.organizationName}`);
    const text = (await samPage.locator("body").innerText()).toLowerCase();
    for (const secret of ["Add a history panel", world.projectName, world.runnerName, e2eAdmin.email, "Activity", "Properties"]) expect(text).not.toContain(secret.toLowerCase());
    await shoot(samPage, "page");

    // Sam's clicks and keys reach nothing.
    const count = (await box.page.locator("#counter").textContent()) ?? "";
    const canvas = await samPage.getByTestId("preview-canvas").boundingBox();
    if (canvas === null) throw new Error("the frame isn't drawn");
    await samPage.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await samPage.keyboard.type("x");
    await samPage.waitForTimeout(1_500);
    await expect(box.page.locator("#counter")).toHaveText(count);
    expect(view.input()).toEqual([]);
    expect(requests.filter((one) => one.includes("/input"))).toEqual([]);
    // The page reached its own procedures and its view's stream, and no other of the task.
    const reached = requests.filter((one) => one.startsWith("/api/trpc/previews.") || one.startsWith("/api/previews/"));
    for (const one of reached) expect(one).toMatch(/^\/api\/previews\/[^/]+\/stream$|^\/api\/trpc\/previews\.(shared\.open|heartbeat|close)/);

    // Demo takes Sam's name off: Sam's open page ends by its next heartbeat, with no picture.
    await page.getByTestId("preview-share").click();
    await menu.getByRole("button", { name: `Remove ${sam}` }).click();
    await expect(menu.getByRole("list", { name: "The people picked" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await samPage.clock.fastForward("00:31");
    await expect(viewer).toHaveAttribute("data-state", "not-shared", { timeout: 15_000 });
    await expect(samPage.getByRole("heading", { name: "This preview isn't shared with you" })).toBeVisible();
    await expect(frame).toHaveCount(0);
    await shoot(samPage, "not-shared");
    // And Needs you lists it no more.
    await samPage.goto("/needs-you");
    await expect(samPage.getByTestId("preview-share")).toHaveCount(0);
    view.close();
  } finally {
    await samContext.close();
    await box.stop();
  }
});
