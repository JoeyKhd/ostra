import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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

/** Seeds a task with a replayed log in the e2e database (`seed-task.ts`) and returns its ID. */
export const seedTask = async (scenario: "mid-turn" | "rest" | "without-changes" | "long", taskId?: string): Promise<string> => {
  const stack: unknown = JSON.parse(await readFile(path.join(import.meta.dirname, ".stack.json"), "utf8"));
  const databaseUrl: unknown = typeof stack === "object" && stack !== null ? Reflect.get(stack, "databaseUrl") : undefined;
  if (typeof databaseUrl !== "string") throw new Error("the e2e stack isn't running");
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-task.ts"), JSON.stringify({ databaseUrl, scenario, ...(taskId === undefined ? {} : { taskId }) })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  const id: unknown = Reflect.get(Object(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")), "taskId");
  if (typeof id !== "string") throw new Error("seeding the task failed");
  return id;
};
