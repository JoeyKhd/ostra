import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
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

/**
 * The page's own status line. The shell holds a second status on every page, its toast
 * (`shell-toast`): the one polite live region that says what a palette action did and announces
 * a new needs-you item (milestone 7, ticket 16), empty until then.
 */
export const pageStatus = (page: Page): Locator => page.getByRole("status").and(page.locator(':not([data-testid="shell-toast"])'));

/** No horizontal scroll at this width (F-075). */
export const expectNoHorizontalScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
};

/**
 * Waits until React has hydrated the element. A page load's `load` event can come before React
 * hydrates the page, and text filled into a field before then stays in the field but never reaches
 * React's state: a button that waits on the field stays disabled, and a click on it times out.
 * React marks each element it has hydrated with a `__reactProps$…` key; from then on it takes
 * every input event.
 */
export const hydrated = async (locator: Locator): Promise<void> => {
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps$"))), {
      message: "the page didn't hydrate",
    })
    .toBe(true);
};

/** Opens the sign-in page and fills its form, once React has it (`hydrated`). */
const fillSignIn = async (page: Page, identifier: string, password: string): Promise<void> => {
  await page.goto("/sign-in");
  const field = page.getByLabel("Username or email");
  await hydrated(field);
  await field.fill(identifier);
  await page.getByLabel("Password").fill(password);
};

const refusedText = "That username or email and password don't match.";

/**
 * Signs in, waiting out better-auth's sign-in rate limit (3 tries per 10 s) when a test hits it.
 * On a fresh stack the seeded admin keeps the default password until 01-shell's first test chooses
 * `e2eAdmin.password`. A spec run without it (one file, or a project with `--no-deps`) has its
 * sign-in as the admin refused; it then signs in with the default password and chooses that
 * password on the forced change, as 01-shell does, rather than wait for a Home that never comes.
 */
export const signIn = async (page: Page, identifier: string = e2eAdmin.username, chosen: string = e2eAdmin.password): Promise<void> => {
  const admin = (identifier === e2eAdmin.username || identifier === e2eAdmin.email) && chosen === e2eAdmin.password;
  let password = chosen;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await fillSignIn(page, identifier, password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // With the default password the panel always asks for a new one, and the client router passes
    // through Home on its way there: only the change page counts as arrived.
    const arrived =
      password === e2eAdmin.defaultPassword
        ? page.waitForURL((url) => url.pathname === "/change-password").then(() => "change" as const)
        : page.waitForURL((url) => url.pathname === "/").then(() => "in" as const);
    const outcome = await Promise.race([
      arrived,
      page.getByText("Too many sign-in attempts").waitFor().then(() => "limited" as const),
      page.getByText(refusedText).waitFor().then(() => "refused" as const),
    ]);
    switch (outcome) {
      case "in":
        return;
      case "change": {
        const next = page.getByLabel("New password", { exact: true });
        await hydrated(next);
        await next.fill(e2eAdmin.password);
        await page.getByLabel("Confirm the new password").fill(e2eAdmin.password);
        await page.getByRole("button", { name: "Save and continue" }).click();
        await page.waitForURL((url) => url.pathname === "/");
        return;
      }
      case "refused":
        if (!admin || password === e2eAdmin.defaultPassword) throw new Error(`the sign-in as ${identifier} was refused`);
        password = e2eAdmin.defaultPassword;
        break;
      case "limited":
        await page.waitForTimeout(11_000);
        break;
      default:
        outcome satisfies never;
    }
  }
  throw new Error("signing in kept being rate limited");
};

/** A sign-in that must be refused in words, waiting out the rate limit like `signIn` does. */
export const expectSignInRefused = async (page: Page, identifier: string, password: string): Promise<void> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fillSignIn(page, identifier, password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const alert = page.getByRole("alert").filter({ hasText: /./ });
    await alert.waitFor();
    if ((await alert.textContent())?.includes("Too many sign-in attempts") !== true) {
      await expect(alert).toHaveText(refusedText);
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
  /** Milestone 6 (ticket 34): the fake Linear, its admin's API key and its team. */
  linear: z.object({ apiUrl: z.string(), apiKey: z.string(), teamId: z.string(), teamKey: z.string() }),
  /** Milestone 3 (ticket 45): the fake Resend API and the key it takes, which the email spec types into the panel. */
  resend: z.object({ apiUrl: z.string(), apiKey: z.string() }),
  /** The server's data folder, holding its secrets key; `null` for an outside stack. */
  dataDir: z.string().nullable(),
});
const seededSchema = z.object({ taskId: taskIdSchema });

/** What the e2e stack wrote about itself (`stack.ts`). */
export const readStack = async (): Promise<z.infer<typeof stackSchema>> => {
  const stack = stackSchema.safeParse(JSON.parse(await readFile(path.join(import.meta.dirname, ".stack.json"), "utf8")));
  if (!stack.success) throw new Error("the e2e stack isn't running");
  return stack.data;
};

/** Seeds a task with a replayed log in the e2e database (`seed-task.ts`) and returns its ID. */
export const seedTask = async (scenario: "mid-turn" | "live-edit" | "rest" | "without-changes" | "long" | "usage" | "estimated-usage" | "approval", taskId?: TaskId): Promise<TaskId> => {
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

/**
 * Connects the stack's GitHub App (`stack.ts`) when no spec before this one has (a spec run alone):
 * the GitHub page's first-connection form, as `03-first-run` fills it.
 */
export const ensureGitHub = async (page: Page): Promise<void> => {
  const { github } = await readStack();
  await page.goto("/organization/github");
  const connect = page.getByRole("button", { name: "Connect the App" });
  const connected = page.locator(`[data-testid="github-app"][data-slug="${github.slug}"]`);
  await expect(connect.or(connected)).toBeVisible();
  if (await connected.isVisible()) return;
  await page.getByLabel("App ID").fill(github.appId);
  await page.getByLabel("Private key", { exact: true }).fill(github.privateKey);
  await page.getByLabel("Webhook secret").fill(github.webhookSecret);
  await connect.click();
  await expect(connected).toBeVisible();
};
