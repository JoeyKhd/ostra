import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { z } from "zod";

import { readStack } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 5's settings specs (tickets 32 and 33): the seeder's scenarios, and the screenshots
// compared with the targets. `OSTRA_E2E_SHOTS` names a folder for them; without it none is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const seed = async (args: object): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-m5-settings.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, ...args })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

const runnersSchema = z.object({
  projectId: z.string(),
  profileId: z.string(),
  pools: z.object({ docker: z.string(), k8s: z.string(), host: z.string(), extra: z.string() }),
});
export type SizesWorld = z.infer<typeof runnersSchema>;
/** The `e2e-sizes-app` project on three pools, and the profile `e2e-sizes-fast` (seed-m5-settings.ts, `runners`). */
export const seedSizesWorld = async (): Promise<SizesWorld> => runnersSchema.parse(await seed({ scenario: "runners" }));

/** The final screenshot of a screen, for the by-eye check against its target (`m5-<screen>-final.png`). */
export const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m5-${name}${phone ? "-phone" : ""}-final.png`) });
};
