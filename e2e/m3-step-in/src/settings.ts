import os from "node:os";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import type { DemoSettings } from "@ostra/e2e-m1/settings";
import { m2Settings } from "@ostra/e2e-m2/settings";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { z } from "zod";

// Milestone 3's demo settings (spec section 3): milestone 2's, plus the second member (Sam), the
// second project's repo, and where the demo keeps its own state, logs and screenshots. Holds
// secrets: never printed or logged whole.

const envSchema = z.object({
  /** Sam's password, as `pnpm dev:seed-member sam --password …` set it: typed into the sign-in form only. */
  OSTRA_E2E_SAM_PASSWORD: z.string().min(1).default("sam-demo-password-1"),
  OSTRA_E2E_SAM_EMAIL: z.email().default("sam@example.com"),
  /** A token with push on the test repos (github-test.env): the demo's own pushes, as a person's git access. */
  GITHUB_TEST_TOKEN: z.string().min(1).optional(),
});

export type M3Settings = M2Settings & {
  readonly samUsername: string;
  readonly samEmail: string;
  readonly samPassword: string;
  readonly testToken: string | null;
  /** Where the demo keeps its state, the fixtures' records and logs: `.ostra-dev/e2e-m3`. */
  readonly m3StateDir: string;
};

export const m3Settings = (env: Readonly<Record<string, string | undefined>>): M3Settings => {
  const base = m2Settings(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`missing or malformed: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  const stateDir = path.join(base.dataDir, "e2e-m3");
  const runnerRoot = path.join(os.tmpdir(), "ostra-e2e-m3");
  const first: DemoSettings = {
    ...base,
    runnerDataDir: path.join(runnerRoot, "runner"),
    runnerName: "m3-runner",
    screenshotDir: path.join(repoRoot, "context", "specs", "m3-step-in", "demo"),
    logFiles: [path.join(stateDir, "runner.log"), ...base.logFiles.slice(-1)],
  };
  return {
    ...base,
    ...first,
    stateDir,
    m3StateDir: stateDir,
    secondRunner: { ...first, runnerDataDir: path.join(runnerRoot, "runner-2"), runnerName: "m3-runner-2" },
    samUsername: "sam",
    samEmail: parsed.data.OSTRA_E2E_SAM_EMAIL,
    samPassword: parsed.data.OSTRA_E2E_SAM_PASSWORD,
    testToken: parsed.data.GITHUB_TEST_TOKEN ?? null,
  };
};
