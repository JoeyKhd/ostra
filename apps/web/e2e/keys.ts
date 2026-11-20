import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";

import { readStack } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// The keyboard specs' seeder and reader (F-081, milestone 7, tickets 13, 16 and 17): `seed-keys.ts`
// makes one task per call, `read-keys.ts` says what an action changed on it.

const run = promisify(execFile);
const cwd = path.resolve(import.meta.dirname, "..");

const seededSchema = z.object({ taskId: z.string(), key: z.string(), approvalId: z.string().nullable(), questionId: z.string().nullable() });
export type SeededKeysTask = z.infer<typeof seededSchema>;

/** One new task in the project `keys`, titled `title`, in the scenario's state (seed-keys.ts). */
export const seedKeysTask = async (scenario: "approval" | "question" | "running-other" | "stopped", title: string): Promise<SeededKeysTask> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-keys.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, scenario, title })], { cwd });
  return seededSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

const factsSchema = z.object({
  state: z.string(),
  drivenByAdmin: z.boolean(),
  approvals: z.array(z.object({ state: z.string(), decision: z.string().nullable() })),
  openItems: z.number(),
  events: z.record(z.string(), z.number()),
});
export type KeysFacts = z.infer<typeof factsSchema>;

/** What the database holds for the task now (read-keys.ts). */
export const readKeysTask = async (taskId: string): Promise<KeysFacts> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "read-keys.ts"), JSON.stringify({ databaseUrl, taskId })], { cwd });
  return factsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
};

/** Waits until the task's facts pass `check` (the API answers before the page's toast). */
export const expectFacts = async (taskId: string, check: (facts: KeysFacts) => boolean): Promise<void> => {
  let last = "";
  await expect
    .poll(
      async () => {
        const facts = await readKeysTask(taskId);
        last = JSON.stringify(facts);
        return check(facts);
      },
      { timeout: 15_000, message: `the task's facts never passed; the last read: ${last}` },
    )
    .toBe(true)
    .catch((cause: unknown) => {
      throw new Error(`the task's facts never passed; the last read: ${last}`, { cause });
    });
};

/** Presses Tab until `target` has the focus, failing after `max` presses: the target is reached by Tab alone. */
export const tabTo = async (page: Page, target: Locator, max = 120): Promise<number> => {
  for (let presses = 1; presses <= max; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return presses;
  }
  throw new Error(`Tab never reached the target in ${String(max)} presses`);
};

/** The element that has the focus, as a test id or an action name, for the focus-return checks. */
export const focusedMark = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return "";
    return active.dataset["action"] ?? active.dataset["testid"] ?? active.getAttribute("aria-label") ?? active.tagName;
  });
