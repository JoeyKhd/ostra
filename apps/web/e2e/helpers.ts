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

// The stack file the e2e stack writes, and the line seed-task.ts prints: both are read through a schema.
const stackSchema = z.object({ databaseUrl: z.string() });
const seededSchema = z.object({ taskId: taskIdSchema });

/** Seeds a task with a replayed log in the e2e database (`seed-task.ts`) and returns its ID. */
export const seedTask = async (scenario: "mid-turn" | "rest" | "without-changes" | "long", taskId?: TaskId): Promise<TaskId> => {
  const stack = stackSchema.safeParse(JSON.parse(await readFile(path.join(import.meta.dirname, ".stack.json"), "utf8")));
  if (!stack.success) throw new Error("the e2e stack isn't running");
  const databaseUrl = stack.data.databaseUrl;
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-task.ts"), JSON.stringify({ databaseUrl, scenario, ...(taskId === undefined ? {} : { taskId }) })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const seeded = seededSchema.safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
  if (!seeded.success) throw new Error("seeding the task failed");
  return seeded.data.taskId;
};
