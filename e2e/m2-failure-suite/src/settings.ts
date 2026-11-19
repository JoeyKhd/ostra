import os from "node:os";
import path from "node:path";

import { m2Settings } from "@ostra/e2e-m2/settings";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { z } from "zod";

// The failure suite's settings (ticket 38): milestone 2's demo settings (the GitHub App, the test
// org and repo, the Linear workspace and team, from ~/.config/ostra-dev/), plus the suite's own
// ports and folders. The model is the suite's stub, so model.env's endpoint isn't used. Holds
// secrets: never printed or logged whole.

const envSchema = z.object({
  /** The suite's own stack, on ports of its own: never the maintainer's (3000, 8787, 54329). */
  OSTRA_FS_WEB_PORT: z.coerce.number().int().positive().default(3211),
  OSTRA_FS_CORE_PORT: z.coerce.number().int().positive().default(8811),
  OSTRA_FS_PG_PORT: z.coerce.number().int().positive().default(54411),
});

export type SuiteSettings = {
  readonly m2: M2Settings;
  readonly ports: { readonly web: number; readonly core: number; readonly pg: number };
  /** `.ostra-dev/e2e-m2-failures`: the run's logs and result. */
  readonly stateDir: string;
  /** The runners' folders, short and outside the repo (git refuses long `.git` paths on Windows). */
  readonly runnersDir: string;
  /** `--long`: the 11-minute cut, past the grace. */
  readonly long: boolean;
  /** `--only <case>,<case>`: the cases to run; every case when empty. */
  readonly only: readonly string[];
  /** `--keep`: leave the tickets, PRs and branches for a look after the run. */
  readonly keep: boolean;
};

const argAfter = (argv: readonly string[], name: string): string | null => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

export const suiteSettings = (env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): SuiteSettings => {
  const parsed = envSchema.parse(env);
  const ports = { web: parsed.OSTRA_FS_WEB_PORT, core: parsed.OSTRA_FS_CORE_PORT, pg: parsed.OSTRA_FS_PG_PORT };
  if ([3000, 8787, 54329].some((port) => Object.values(ports).includes(port))) {
    throw new Error("the failure suite never runs on the default ports (3000, 8787, 54329): another stack may be there");
  }
  const panelUrl = `http://localhost:${String(ports.web)}`;
  const m2 = m2Settings({
    // The stub stands in for model.env's endpoint; the demo settings still want its three values.
    OSTRA_DEV_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    OSTRA_DEV_MODEL_API_KEY: "unused",
    OSTRA_DEV_MODEL_ID: "unused",
    ...env,
    OSTRA_E2E_PANEL_URL: panelUrl,
    OSTRA_E2E_CORE_URL: `http://127.0.0.1:${String(ports.core)}`,
    OSTRA_PUBLIC_URL: panelUrl,
    OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
  });
  const stateDir = path.join(repoRoot, ".ostra-dev", "e2e-m2-failures");
  const runnersDir = path.join(os.tmpdir(), "ostra-f38");
  const only = (argAfter(argv, "--only") ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  return {
    // The suite's own folders: the demo's runner folder is another stack's, and the sign-in clears it.
    m2: { ...m2, screenshotDir: path.join(stateDir, "screenshots"), stateDir, runnerDataDir: path.join(runnersDir, "main"), runnerName: "fs-main", logFiles: [] },
    ports,
    stateDir,
    runnersDir,
    long: argv.includes("--long"),
    only,
    keep: argv.includes("--keep"),
  };
};
