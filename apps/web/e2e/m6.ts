import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { z } from "zod";

import { readStack } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 6's web specs (tickets 31 to 33): the seeder's scenarios, and the screenshots compared
// with the targets. `OSTRA_E2E_SHOTS` names a folder for them; without it none is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const seed = async (args: object): Promise<unknown> => {
  const { databaseUrl, dataDir, linear } = await readStack();
  if (dataDir === null) throw new Error("the milestone 6 seeds need the stack's data folder, for its secrets key");
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-m6.ts"), JSON.stringify({ databaseUrl, dataDir, linear, password: e2eAdmin.password, ...args })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

const automationsSchema = z.object({ projectId: z.string(), boardId: z.string(), memberId: z.string() });
/** The project `e2e-auto` with its board and tickets, and `username` able to open it (seed-m6.ts, `automations`). */
export const seedAutomationsWorld = async (username: string) => automationsSchema.parse(await seed({ scenario: "automations", username }));

const pausedSchema = z.object({ automationId: z.string(), projectId: z.string() });
/** A rule of `e2e-auto` its hourly limit paused (`paused`). */
export const seedPausedRule = async (name: string) => pausedSchema.parse(await seed({ scenario: "paused", name }));

const inboxSchema = z.object({
  projectId: z.string(),
  parentTicketId: z.string(),
  keys: z.object({ one: z.string(), two: z.string(), three: z.string(), four: z.string(), held: z.string(), parent: z.string(), childA: z.string(), childB: z.string() }),
});
export type BulkWorld = z.infer<typeof inboxSchema>;
/** The project `e2e-bulk`, its tickets on the fake Linear, one with a task, and a parent with two sub-issues (`inbox`). */
export const seedBulkWorld = async () => inboxSchema.parse(await seed({ scenario: "inbox" }));

const agentSchema = z.object({ projectId: z.string(), boardName: z.string(), tasks: z.array(z.object({ id: z.string(), key: z.string() })) });
/** The project `e2e-agent`, its board, and three outside tasks waiting for approval (`agent-mode`). */
export const seedAgentWorld = async () => agentSchema.parse(await seed({ scenario: "agent-mode" }));

/** The final screenshot of a screen, for the by-eye check against its target (`m6-<screen>-final.png`). */
export const shootM6 = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m6-${name}${phone ? "-phone" : ""}-final.png`) });
};

/** Saves the signed-in member's theme on Account › Appearance (F-082), for the light screenshots. */
export const chooseTheme = async (page: Page, label: "Dark" | "Light"): Promise<void> => {
  await page.goto("/account");
  const radio = page.getByTestId("theme-choice").getByRole("radio", { name: label });
  // A click before hydration does nothing: click until the radio holds it.
  for (let attempt = 0; attempt < 10 && !(await radio.isChecked()); attempt += 1) {
    await radio.click();
    await page.waitForTimeout(300);
  }
};
