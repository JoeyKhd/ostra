import os from "node:os";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import type { DemoSettings } from "@ostra/e2e-m1/settings";
import { m2Settings } from "@ostra/e2e-m2/settings";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { z } from "zod";

// Milestone 4's demo settings (spec section 3, ticket 41): milestone 2's, plus the people who
// arrive by invitation (Sam and Rae), the mail sink's folder and port (ticket 40), and where the
// demo keeps its own state, logs and screenshots. Holds secrets: never printed or logged whole.

const envSchema = z.object({
  /** The folder `pnpm dev:mail-sink` writes to (`OSTRA_MAIL_SINK_DIR`). */
  OSTRA_MAIL_SINK_DIR: z.string().min(1).optional(),
  OSTRA_MAIL_SINK_PORT: z.coerce.number().int().positive().default(2525),
  OSTRA_E2E_SAM_EMAIL: z.email().default("sam@demo.test"),
  OSTRA_E2E_RAE_EMAIL: z.email().default("rae@demo.test"),
  /** A token with push and admin on the test repos: branch protection and merges as a person (ticket 42). */
  GITHUB_TEST_TOKEN: z.string().min(1).optional(),
  /** The reviewer user's token (ticket 42): approvals that count for the independent-review check. */
  GITHUB_TEST_REVIEWER_TOKEN: z.string().min(1).optional(),
});

export type Person = { readonly username: string; readonly email: string };

export type M4Settings = M2Settings & {
  readonly sam: Person;
  readonly rae: Person;
  readonly mailDir: string;
  readonly mailPort: number;
  readonly testToken: string | null;
  readonly reviewerToken: string | null;
  /** Where the demo keeps its state and logs: `.ostra-dev/e2e-m4`. */
  readonly m4StateDir: string;
};

export const m4Settings = (env: Readonly<Record<string, string | undefined>>): M4Settings => {
  const base = m2Settings(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`missing or malformed: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  }
  const stateDir = path.join(base.dataDir, "e2e-m4");
  const runnerRoot = path.join(os.tmpdir(), "ostra-e2e-m4");
  const first: DemoSettings = {
    ...base,
    runnerDataDir: path.join(runnerRoot, "runner"),
    runnerName: "m4-runner",
    screenshotDir: path.join(repoRoot, "context", "specs", "m4-the-organization", "demo"),
    logFiles: [path.join(stateDir, "runner.log"), path.join(stateDir, "runner-2.log"), ...base.logFiles.slice(-1)],
  };
  return {
    ...base,
    ...first,
    stateDir,
    m4StateDir: stateDir,
    secondRunner: { ...first, runnerDataDir: path.join(runnerRoot, "runner-2"), runnerName: "m4-runner-2" },
    sam: { username: "sam", email: parsed.data.OSTRA_E2E_SAM_EMAIL },
    rae: { username: "rae", email: parsed.data.OSTRA_E2E_RAE_EMAIL },
    mailDir: parsed.data.OSTRA_MAIL_SINK_DIR ?? path.join(base.dataDir, "mail"),
    mailPort: parsed.data.OSTRA_MAIL_SINK_PORT,
    testToken: parsed.data.GITHUB_TEST_TOKEN ?? null,
    reviewerToken: parsed.data.GITHUB_TEST_REVIEWER_TOKEN ?? null,
  };
};
