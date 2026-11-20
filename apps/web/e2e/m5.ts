import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { z } from "zod";

import { readStack } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 5's fleet specs (tickets 30 and 31): the seeder's scenarios, and the screenshots compared
// with the targets. `OSTRA_E2E_SHOTS` names a folder for them; without it no screenshot is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const seed = async (args: object): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-m5.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, ...args })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

const fleetSchema = z.object({ fleetPoolId: z.string(), queuePoolId: z.string(), projectId: z.string() });
/** The pools `e2e-fleet` and `e2e-queue`, their runners, boxes and queue (seed-m5.ts, `fleet`). */
export const seedFleet = async () => fleetSchema.parse(await seed({ scenario: "fleet" }));

/** A task of `e2e-fleet-app` takes a box on `e2e-fleet-01`. */
export const seedTake = async () => z.object({ taskId: z.string() }).parse(await seed({ scenario: "take" }));

/** A runner `name` waiting for approval in `e2e-approve`. */
export const seedJoiner = async (name: string) => z.object({ runnerId: z.string(), poolId: z.string() }).parse(await seed({ scenario: "joiner", name }));

/** The member `username` and their personal runner `name`. */
export const seedPersonal = async (username: string, name: string) => z.object({ runnerId: z.string(), memberId: z.string() }).parse(await seed({ scenario: "personal", username, name }));

/** The final screenshot of a screen, for the by-eye check against its target. */
export const shootM5 = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m5-${name}${phone ? "-phone" : ""}-final.png`) });
};
