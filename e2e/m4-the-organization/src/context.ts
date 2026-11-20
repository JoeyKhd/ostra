import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { devPgDir } from "@ostra/db/dev";
import { demoDatabase } from "@ostra/e2e-m1/database";
import { demoGitHub } from "@ostra/e2e-m1/github";
import type { DemoGitHub } from "@ostra/e2e-m1/github";
import { say } from "@ostra/e2e-m1/setup";
import { linearTool } from "@ostra/e2e-m2/linear";
import type { LinearTool } from "@ostra/e2e-m2/linear";
import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";

import { m4Settings } from "./settings.ts";
import type { M4Settings } from "./settings.ts";
import { loadPasswords, loadRunState, saveRunState } from "./state.ts";
import type { Passwords, RunState } from "./state.ts";

// What every step of the demo works with (ticket 41): the settings, the stack's database, Linear
// and GitHub as the demo's own tools, and up to three signed-in browsers, Demo's, Sam's and Rae's.

export type CheckResult = { readonly step: string; readonly name: string; readonly ok: boolean; readonly detail: string };

export type Who = "demo" | "sam" | "rae";

/** A tRPC answer as the panel's own client would get it: the data, or the refusal's code. */
export type Answer = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: string; readonly message: string };

export type Demo = {
  readonly settings: M4Settings;
  readonly passwords: Passwords;
  readonly db: Db;
  readonly tool: LinearTool;
  readonly github: DemoGitHub;
  readonly demo: Page;
  /** Sam's or Rae's browser, signed in (made at the first use, once they have an account). */
  readonly page: (who: Exclude<Who, "demo">) => Promise<Page>;
  /** Closes a person's browser, so the next `page` signs in again. */
  readonly forget: (who: Exclude<Who, "demo">) => Promise<void>;
  /** A browser of its own, not signed in. */
  readonly freshPage: () => Promise<Page>;
  readonly run: RunState;
  readonly save: () => Promise<void>;
  /** The step that's running, for the checks' record. */
  step: string;
  readonly check: (name: string, ok: boolean, detail: string) => void;
  readonly checks: CheckResult[];
  /** Bearer links and tokens the run handled (invitations, verifications, resets): searched for after, never printed. */
  readonly secrets: string[];
  readonly shot: (page: Page, name: string) => Promise<void>;
  readonly query: (page: Page, procedure: string, input?: unknown) => Promise<Answer>;
  readonly mutate: (page: Page, procedure: string, input?: unknown) => Promise<Answer>;
  readonly id: (key: string) => string;
  readonly close: () => Promise<void>;
};

const answerSchema = z.union([
  z.object({ result: z.object({ data: z.unknown() }) }),
  z.object({ error: z.looseObject({ message: z.string(), data: z.looseObject({ code: z.string() }).optional() }) }),
]);

const toAnswer = (body: unknown): Answer => {
  const parsed = answerSchema.parse(body);
  if ("result" in parsed) return { ok: true, data: parsed.result.data };
  return { ok: false, code: parsed.error.data?.code ?? "UNKNOWN", message: parsed.error.message };
};

export const signIn = async (page: Page, identifier: string, password: string): Promise<void> => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname !== "/sign-in") return;
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 30_000 });
};

export const openDemo = async (): Promise<Demo> => {
  const settings = m4Settings(process.env);
  const stateFile = path.join(settings.m4StateDir, "run.json");
  const run = await loadRunState(stateFile);
  const passwords = await loadPasswords(settings.m4StateDir);
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
  // The default first admin keeps the default password (OSTRA_ALLOW_DEFAULT_PASSWORD=true).
  await signIn(demo, settings.adminUsername, settings.adminPassword ?? "demo");
  const pages = new Map<Who, Page>();
  // The bearer links the run handled, kept outside the repo for the leak scan of a later run.
  const secretsFile = path.join(settings.m4StateDir, "secrets.json");
  const secrets = z.array(z.string()).catch([]).parse(JSON.parse(await readFile(secretsFile, "utf8").catch(() => "[]")));
  const checks: CheckResult[] = [];
  const call = async (page: Page, kind: "query" | "mutation", procedure: string, input: unknown): Promise<Answer> => {
    const response =
      kind === "query"
        ? await page.request.get(`/api/trpc/${procedure}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
        : await page.request.post(`/api/trpc/${procedure}`, { data: input ?? null, headers: { "content-type": "application/json" } });
    return toAnswer(await response.json());
  };
  const d: Demo = {
    settings,
    passwords,
    db,
    tool,
    github,
    demo,
    page: async (who) => {
      const open = pages.get(who);
      if (open !== undefined) return open;
      const page = await context();
      // Sam's password changes in step 14: the one in use is named in the run's notes.
      const current = run.notes[`password:${who}`];
      const password = current === "samReset" ? passwords.samReset : current === "samFinal" ? passwords.samFinal : passwords[who];
      await signIn(page, settings[who].username, password);
      pages.set(who, page);
      return page;
    },
    forget: async (who) => {
      await pages.get(who)?.context().close().catch(() => undefined);
      pages.delete(who);
    },
    freshPage: context,
    run,
    save: () => saveRunState(stateFile, run),
    step: "",
    checks,
    secrets,
    check: (name, ok, detail) => {
      checks.push({ step: d.step, name, ok, detail });
      say(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    },
    shot: async (page, name) => {
      // Committed screenshots: the dev endpoint, this machine's folders and private keys are masked.
      const mask = [page.getByText(settings.modelBaseUrl), page.getByText(/[A-Za-z]:\\Users\\|\/home\/|\/Users\//), page.locator("#private-key")].map((locator) => locator.filter({ visible: true }));
      await page.mouse.move(0, 0).catch(() => undefined);
      await page.screenshot({ path: path.join(settings.screenshotDir, `${name}.png`), mask });
      say(`screenshot ${name}.png`);
    },
    query: (page, procedure, input) => call(page, "query", procedure, input),
    mutate: (page, procedure, input) => call(page, "mutation", procedure, input),
    id: (key) => {
      const value = run.ids[key];
      if (value === undefined) throw new Error(`no ${key} yet: run the step that makes it first`);
      return value;
    },
    close: async () => {
      await saveRunState(stateFile, run).catch(() => undefined);
      await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 }).catch(() => undefined);
      await browser.close();
      await db.$disconnect();
    },
  };
  return d;
};

/** The runner's device code its process wrote, or `null` when it was already signed in. */
export const runnerCode = async (settings: M4Settings, name: "runner" | "runner-2" = "runner"): Promise<string | null> => {
  const text = (await readFile(path.join(settings.m4StateDir, `${name}-code.txt`), "utf8").catch(() => "")).trim();
  return text === "" || text === "signed-in" ? null : text;
};
