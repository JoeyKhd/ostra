import { readFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { devPgDir } from "@ostra/db/dev";
import { demoDatabase } from "@ostra/e2e-m1/database";
import { demoGitHub } from "@ostra/e2e-m1/github";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { loadState, say, signInAsAdmin } from "@ostra/e2e-m1/setup";
import { linearTool } from "@ostra/e2e-m2/linear";
import type { LinearTool } from "@ostra/e2e-m2/linear";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { loadRunState, saveRunState } from "./run-state.ts";
import type { RunState } from "./run-state.ts";
import { m3Settings } from "./settings.ts";
import type { M3Settings } from "./settings.ts";

// What every step of the demo works with (ticket 50): the settings, the stack's database, Linear and
// GitHub as the demo's own tools, and two signed-in browsers, Demo's and Sam's.

export type CheckResult = { readonly name: string; readonly ok: boolean; readonly detail: string };

export type Demo = {
  readonly settings: M3Settings;
  readonly db: Db;
  readonly tool: LinearTool;
  readonly github: DemoGitHub;
  /** The first admin's browser. */
  readonly demo: Page;
  /** The seeded member's browser. */
  readonly sam: Page;
  readonly run: RunState;
  readonly save: () => Promise<void>;
  readonly check: (name: string, ok: boolean, detail: string) => void;
  readonly checks: CheckResult[];
  readonly shot: (page: Page, name: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

const signInAs = async (page: Page, username: string, password: string): Promise<void> => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname !== "/sign-in") return;
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 30_000 });
  // A seeded member's password may be the seed's: the panel lets them on with it in development.
  if (new URL(page.url()).pathname === "/change-password") {
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm the new password").fill(password);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.waitForURL((url) => url.pathname === "/");
  }
};

export const openDemo = async (): Promise<Demo> => {
  const settings = m3Settings(process.env);
  const stateFile = path.join(settings.m3StateDir, "run.json");
  const run = await loadRunState(stateFile);
  const login = await loadState(path.join(settings.m3StateDir, "state.json"));
  const database = await demoDatabase(process.env, devPgDir);
  const db = createDb(database.url, { maxConnections: 3 });
  const tool = linearTool(settings.linearApiKey);
  const github = await demoGitHub(settings);
  const browser: Browser = await chromium.launch();
  const viewport = { width: 1440, height: 956 };
  const context = async () => {
    const made = await browser.newContext({ baseURL: settings.panelUrl, viewport });
    // The dev server's own indicator sits over the sheets' buttons: hidden, as in a production build.
    await made.addInitScript({
      content: "document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = 'nextjs-portal { display: none !important; }'; document.head.append(style); });",
    });
    return made.newPage();
  };
  const demo = await context();
  const sam = await context();
  await signInAsAdmin(demo, settings, login);
  await signInAs(sam, settings.samUsername, settings.samPassword);
  const checks: CheckResult[] = [];
  return {
    settings,
    db,
    tool,
    github,
    demo,
    sam,
    run,
    save: () => saveRunState(stateFile, run),
    checks,
    check: (name, ok, detail) => {
      checks.push({ name, ok, detail });
      say(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    },
    shot: async (page, name) => {
      // Committed screenshots: the dev endpoint, this machine's folders and the members' addresses are masked.
      const mask = [page.getByText(settings.modelBaseUrl), page.getByText(/[A-Za-z]:\\Users\\|\/home\/|\/Users\//), page.locator("#email")].map((locator) => locator.filter({ visible: true }));
      await page.screenshot({ path: path.join(settings.screenshotDir, `${name}.png`), mask });
      say(`screenshot ${name}.png`);
    },
    close: async () => {
      await saveRunState(stateFile, run).catch(() => undefined);
      await browser.close();
      await db.$disconnect();
    },
  };
};

/** The runner's device code its process wrote, or `null` when it was already signed in. */
export const runnerCode = async (settings: M3Settings, name = "runner"): Promise<string | null> => {
  const text = (await readFile(path.join(settings.m3StateDir, `${name}-code.txt`), "utf8").catch(() => "")).trim();
  return text === "" || text === "signed-in" ? null : text;
};
