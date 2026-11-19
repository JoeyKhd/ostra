import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { readStack, signIn } from "./helpers.ts";
import { e2eAdmin } from "./settings.ts";

// Milestone 4's specs (tickets 32 to 35): the seeder's two scenarios, and the screenshots compared
// with the targets. `OSTRA_E2E_SHOTS` names a folder for them; without it no screenshot is taken.

const run = promisify(execFile);
const shots = process.env["OSTRA_E2E_SHOTS"];

const seed = async (args: object): Promise<unknown> => {
  const { databaseUrl } = await readStack();
  const { stdout } = await run(process.execPath, [path.join(import.meta.dirname, "seed-m4.ts"), JSON.stringify({ databaseUrl, password: e2eAdmin.password, ...args })], {
    cwd: path.resolve(import.meta.dirname, ".."),
  });
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
};

const memberSchema = z.object({ memberId: z.string(), userId: z.string(), organizationId: z.string() });
export const seedM4Member = async (username: string) => memberSchema.parse(await seed({ scenario: "member", username }));

const worldSchema = z.object({ projectId: z.string(), taskId: z.string(), otherTaskId: z.string(), memberId: z.string() });
export type M4World = z.infer<typeof worldSchema>;
/** The m4calc project, its two tasks and the member `by` (seed-m4.ts, `world`). */
export const seedM4World = async (input: { readonly by: string; readonly word: string; readonly folder: string }): Promise<M4World> => worldSchema.parse(await seed({ scenario: "world", ...input }));

/** A page in a context of its own, signed in as `username` (the e2e password). */
export const signedInPage = async (browser: Browser, username: string): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, username);
  return page;
};

/** The final screenshot of a screen, for the by-eye check against its target. */
export const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m4-${name}${phone ? "-phone" : ""}-final.png`) });
};

/** The one world every milestone 4 spec seeds (idempotent): the same member, word and folder. */
export const m4World = {
  by: "e2e-m4-viewer",
  word: "zeppelinoid",
  folder: "/workspace/m4calc/packages/history/src/formatters/rounding/with-a-folder-name-long-enough-to-wrap",
} as const;

/** A phone-width screenshot only: the phone checks run at desktop width too, and keep the desktop shots. */
export const shootPhone = async (page: Page, name: string): Promise<void> => {
  if ((page.viewportSize()?.width ?? 1440) < 600) await shoot(page, name);
};
