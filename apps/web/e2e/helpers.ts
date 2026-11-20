import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { e2eAdmin, e2eBaseUrl } from "./settings.ts";

const run = promisify(execFile);

/** Records every request whose origin isn't the panel's: the page must call no third party. */
export const watchOrigins = (page: Page): { readonly foreign: () => readonly string[] } => {
  const own = new URL(e2eBaseUrl).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== own) foreign.push(url.origin);
  });
  return { foreign: () => foreign };
};

/** No horizontal scroll at this width (F-075). */
export const expectNoHorizontalScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
};

/** Signs in, waiting out better-auth's sign-in rate limit (a few tries per 10 s) when a test hits it. */
export const signIn = async (page: Page, identifier: string = e2eAdmin.username): Promise<void> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto("/sign-in");
    await page.getByLabel("Username or email").fill(identifier);
    await page.getByLabel("Password").fill(e2eAdmin.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const outcome = await Promise.race([
      page.waitForURL((url) => url.pathname === "/").then(() => "in" as const),
      page.getByText("Too many sign-in attempts").waitFor().then(() => "limited" as const),
    ]);
    if (outcome === "in") return;
    await page.waitForTimeout(11_000);
  }
  throw new Error("signing in kept being rate limited");
};

/** A sign-in that must be refused in words, waiting out the rate limit like `signIn` does. */
export const expectSignInRefused = async (page: Page, identifier: string, password: string): Promise<void> => {
  const refused = "That username or email and password don't match.";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto("/sign-in");
    await page.getByLabel("Username or email").fill(identifier);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = page.getByRole("alert").filter({ hasText: /./ });
    await alert.waitFor();
    if ((await alert.textContent())?.includes("Too many sign-in attempts") !== true) {
      await expect(alert).toHaveText(refused);
      return;
    }
    await page.waitForTimeout(11_000);
  }
  throw new Error("signing in kept being rate limited");
};

// The stack file the e2e stack writes, and the line seed-task.ts prints: both are read through a schema.
const stackSchema = z.object({
  databaseUrl: z.string(),
  /** The fake GitHub's App: the credentials the setup spec types into "Use an existing App". */
  github: z.object({ appId: z.string(), privateKey: z.string(), webhookSecret: z.string(), slug: z.string() }),
  /**
   * F-136: a second GitHub organization with the App installed, waiting to be linked (`login`, its
   * repo), and a second App owned by a third account, for "Connect another App" (`appId`, `privateKey`, `slug`).
   */
  githubB: z.object({ login: z.string(), repo: z.string(), appId: z.string(), privateKey: z.string(), slug: z.string() }),
});
const seededSchema = z.object({ taskId: taskIdSchema });

/** What the e2e stack wrote about itself (`stack.ts`). */
export const readStack = async (): Promise<z.infer<typeof stackSchema>> => {
  const stack = stackSchema.safeParse(JSON.parse(await readFile(path.join(import.meta.dirname, ".stack.json"), "utf8")));
  if (!stack.success) throw new Error("the e2e stack isn't running");
  return stack.data;
};

/** Seeds a task with a replayed log in the e2e database (`seed-task.ts`) and returns its ID. */
export const seedTask = async (scenario: "mid-turn" | "live-edit" | "rest" | "without-changes" | "long" | "usage" | "estimated-usage", taskId?: TaskId): Promise<TaskId> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-task.ts"), JSON.stringify({ databaseUrl, scenario, ...(taskId === undefined ? {} : { taskId }) })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const seeded = seededSchema.safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  if (!seeded.success) throw new Error("seeding the task failed");
  return seeded.data.taskId;
};

/** The first-run checklist's rows on Home (F-076), in the order the page shows them. */
export const checklistSteps = (page: Page): Promise<string[]> =>
  page
    .getByTestId("setup-checklist")
    .locator("[data-step]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-step") ?? ""));
