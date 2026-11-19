import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

// The demo's settings: the dev stack's addresses, and the secrets from ~/.config/ostra-dev/
// (model.env, github.env, github-test.env), read from the environment. Holds secrets: never
// printed or logged whole.

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const envSchema = z.object({
  OSTRA_DEV_MODEL_BASE_URL: z.url(),
  OSTRA_DEV_MODEL_API_KEY: z.string().min(1),
  OSTRA_DEV_MODEL_ID: z.string().min(1),
  GITHUB_APP_ID: z.string().regex(/^\d+$/),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_TEST_ORG: z.string().min(1),
  GITHUB_TEST_REPO: z.string().min(1),
  GITHUB_TEST_OTHER_REPO: z.string().min(1),
  GITHUB_TEST_MEMBER_LOGIN: z.string().min(1).optional(),
  OSTRA_E2E_PANEL_URL: z.url().default("http://localhost:3000"),
  OSTRA_PUBLIC_URL: z.url().optional(),
  OSTRA_E2E_CORE_URL: z.url().default("http://localhost:8787"),
  OSTRA_E2E_STACK_LOG: z.string().min(1).optional(),
  OSTRA_E2E_PROMPT: z.string().min(1).default("Add a CONTRIBUTING.md with a short section on how to run the tests"),
  /** A setup script the demo saves in the project's environment, so the runner runs it before each task. */
  OSTRA_E2E_SETUP_SCRIPT: z.string().min(1).optional(),
  // The admin the dev stack seeded (F-001): the same variables, and defaults, as the server's.
  OSTRA_ADMIN_EMAIL: z.email().default("demo@demo.com"),
  OSTRA_ADMIN_USERNAME: z.string().min(1).default("demo"),
  OSTRA_ADMIN_PASSWORD: z.string().min(1).optional(),
  OSTRA_ORGANIZATION_NAME: z.string().min(1).default("Demo"),
  // The stack's idle timer, as the stack reads it (the same default): a capacity-1 runner takes the
  // next task only once the last one's box has gone from idle to stopped (F-096).
  OSTRA_BOX_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
});

export type DemoSettings = {
  readonly panelUrl: string;
  readonly coreUrl: string;
  /** The panel's address as the stack was told (OSTRA_PUBLIC_URL), which PR bodies link the task with. */
  readonly publicUrl: string;
  readonly dataDir: string;
  /**
   * The runner's folder, outside the repo: an agent on the host executor can read the folders
   * above its worktree, and ostra's own AGENTS.md there would read as its instructions.
   */
  readonly runnerDataDir: string;
  /** Logs searched for credentials after the run: the runner's, and the dev stack's when OSTRA_E2E_STACK_LOG names it. */
  readonly logFiles: readonly string[];
  readonly screenshotDir: string;
  readonly organizationName: string;
  readonly adminUsername: string;
  readonly adminEmail: string;
  /** OSTRA_ADMIN_PASSWORD, a secret typed into the sign-in form only. `null`: the seeded default, which the demo changes. */
  readonly adminPassword: string | null;
  readonly modelBaseUrl: string;
  /** A secret: typed into the form only. */
  readonly modelApiKey: string;
  readonly modelId: string;
  readonly githubAppId: string;
  readonly githubPrivateKeyPath: string;
  /** The App's webhooks aren't read in milestone 1: a fresh random secret per stack. */
  readonly githubWebhookSecret: string;
  readonly githubOrg: string;
  readonly githubRepo: string;
  readonly githubOtherRepo: string;
  readonly runnerName: string;
  readonly prompt: string;
  /** The environment's setup script, or `null` to keep the drafted one. */
  readonly setupScript: string | null;
  /** `OSTRA_BOX_IDLE_MINUTES`, as the stack has it: how long a finished turn's box stays warm on the runner's slot. */
  readonly idleMinutes: number;
};

/** The variables the demo reads, named when one is missing; never their values. */
export const demoSettings = (env: Readonly<Record<string, string | undefined>>): DemoSettings => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`missing or malformed: ${names}. Load model.env, github.env and github-test.env from ~/.config/ostra-dev/`);
  }
  const value = parsed.data;
  const dataDir = path.join(repoRoot, ".ostra-dev");
  return {
    panelUrl: value.OSTRA_E2E_PANEL_URL,
    coreUrl: value.OSTRA_E2E_CORE_URL,
    publicUrl: (value.OSTRA_PUBLIC_URL ?? value.OSTRA_E2E_PANEL_URL).replace(/\/+$/, ""),
    dataDir,
    runnerDataDir: path.join(os.tmpdir(), "ostra-e2e-m1", "runner"),
    logFiles: [path.join(dataDir, "e2e-m1", "runner.log"), ...(value.OSTRA_E2E_STACK_LOG === undefined ? [] : [value.OSTRA_E2E_STACK_LOG])],
    screenshotDir: path.join(repoRoot, "context", "specs", "m1-first-pr", "demo"),
    organizationName: value.OSTRA_ORGANIZATION_NAME,
    adminUsername: value.OSTRA_ADMIN_USERNAME,
    adminPassword: value.OSTRA_ADMIN_PASSWORD ?? null,
    // GitHub links a co-author by a noreply address of the account: start the dev stack with
    // OSTRA_ADMIN_EMAIL=<GITHUB_TEST_MEMBER_LOGIN>@users.noreply.github.com for that (docs/development.md).
    adminEmail: value.OSTRA_ADMIN_EMAIL,
    modelBaseUrl: value.OSTRA_DEV_MODEL_BASE_URL,
    modelApiKey: value.OSTRA_DEV_MODEL_API_KEY,
    modelId: value.OSTRA_DEV_MODEL_ID,
    githubAppId: value.GITHUB_APP_ID,
    githubPrivateKeyPath: value.GITHUB_APP_PRIVATE_KEY_PATH,
    githubWebhookSecret: `dev-${value.GITHUB_APP_ID}-not-read-in-m1`,
    githubOrg: value.GITHUB_TEST_ORG,
    githubRepo: value.GITHUB_TEST_REPO,
    githubOtherRepo: value.GITHUB_TEST_OTHER_REPO,
    runnerName: "demo-runner",
    prompt: value.OSTRA_E2E_PROMPT,
    setupScript: value.OSTRA_E2E_SETUP_SCRIPT ?? null,
    idleMinutes: value.OSTRA_BOX_IDLE_MINUTES,
  };
};
