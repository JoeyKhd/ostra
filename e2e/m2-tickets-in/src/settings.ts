import os from "node:os";
import path from "node:path";

import { demoSettings, repoRoot } from "@ostra/e2e-m1/settings";
import type { DemoSettings } from "@ostra/e2e-m1/settings";
import { z } from "zod";

// Milestone 2's demo settings (spec section 3): milestone 1's, plus the Linear workspace from
// linear.env, the tunnel's address from tunnel.env, and a second personal runner for the reopen
// on a fresh box (step 8). Holds secrets: never printed or logged whole.

const envSchema = z.object({
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEST_TEAM_KEY: z.string().min(1),
  LINEAR_TEST_TEAM_ID: z.string().min(1),
  /** The tunnel to core (tunnel.env, or the demo's own quick tunnel): Linear's webhooks go there. Unset: the connection polls. */
  OSTRA_DEV_PUBLIC_URL: z.url().optional(),
  /** The admin token of ticket 40's step 4: the repo checks run only with it. */
  GITHUB_TEST_ADMIN_TOKEN: z.string().min(1).optional(),
  /** The stack's drift poll, as the stack reads it (the same default): a webhooks connection's tickets are polled this often. */
  OSTRA_RECONCILE_MINUTES: z.coerce.number().int().positive().default(5),
});

export type M2Settings = DemoSettings & {
  readonly linearApiKey: string;
  readonly linearTeamKey: string;
  readonly linearTeamId: string;
  readonly devPublicUrl: string | null;
  readonly githubAdminToken: string | null;
  readonly reconcileMinutes: number;
  /** Where the demo keeps its own state and logs: `.ostra-dev/e2e-m2`. */
  readonly stateDir: string;
  /** The second personal runner: another name and another data folder, for the reopen on a fresh box. */
  readonly secondRunner: DemoSettings;
};

export const m2Settings = (env: Readonly<Record<string, string | undefined>>): M2Settings => {
  const base = demoSettings(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`missing or malformed: ${names}. Load linear.env (and tunnel.env for webhooks) from ~/.config/ostra-dev/`);
  }
  const stateDir = path.join(base.dataDir, "e2e-m2");
  const runnerRoot = path.join(os.tmpdir(), "ostra-e2e-m2");
  const first: DemoSettings = {
    ...base,
    runnerDataDir: path.join(runnerRoot, "runner"),
    runnerName: "demo-runner",
    screenshotDir: path.join(repoRoot, "context", "specs", "m2-tickets-in", "demo"),
    logFiles: [path.join(stateDir, "demo-runner.log"), path.join(stateDir, "demo-runner-2.log"), ...base.logFiles.slice(1)],
  };
  return {
    ...first,
    linearApiKey: parsed.data.LINEAR_API_KEY,
    linearTeamKey: parsed.data.LINEAR_TEST_TEAM_KEY,
    linearTeamId: parsed.data.LINEAR_TEST_TEAM_ID,
    devPublicUrl: parsed.data.OSTRA_DEV_PUBLIC_URL?.replace(/\/+$/, "") ?? null,
    githubAdminToken: parsed.data.GITHUB_TEST_ADMIN_TOKEN ?? null,
    reconcileMinutes: parsed.data.OSTRA_RECONCILE_MINUTES,
    stateDir,
    secondRunner: { ...first, runnerDataDir: path.join(runnerRoot, "runner-2"), runnerName: "demo-runner-2" },
  };
};
