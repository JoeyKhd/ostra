import os from "node:os";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { m2Settings } from "@ostra/e2e-m2/settings";
import type { M2Settings } from "@ostra/e2e-m2/settings";
import { z } from "zod";

// Milestone 5's demo settings (ticket 37, spec section 3): milestone 2's (the GitHub App, the test
// org and its repos, the Linear workspace and team, from ~/.config/ostra-dev/), plus the demo's own
// ports, folders and dev tools' ports. The model is the failure suite's stub, so model.env's
// endpoint isn't used. Holds secrets: never printed or logged whole.

const envSchema = z.object({
  /** The demo's own stack, on ports of its own: never the maintainer's (3000, 8787, 54329). */
  OSTRA_E2E_M5_WEB_PORT: z.coerce.number().int().positive().default(3930),
  /** The first core replica's port; the others take the next ones. */
  OSTRA_E2E_M5_CORE_PORT: z.coerce.number().int().positive().default(9530),
  OSTRA_E2E_M5_PG_PORT: z.coerce.number().int().positive().default(55130),
  /** The first of the dev tools' ports: the fake cluster, the registry, the npm registry, then the proxies' four. */
  OSTRA_E2E_M5_TOOLS_PORT: z.coerce.number().int().positive().default(13530),
  OSTRA_E2E_M5_REPLICAS: z.coerce.number().int().min(1).max(8).default(3),
  OSTRA_E2E_SAM_PASSWORD: z.string().min(1).default("sam-demo-password-1"),
});

export type M5Settings = {
  readonly m2: M2Settings;
  readonly ports: { readonly web: number; readonly core: number; readonly pg: number };
  readonly replicas: number;
  readonly tools: { readonly fakeKube: number; readonly registry: number; readonly npmRegistry: number; readonly netProxies: number };
  readonly panelUrl: string;
  /** Each replica's address, the first one first. */
  readonly coreUrls: readonly string[];
  /** `.ostra-dev/e2e-m5`: the run's logs, result and the installed CLI. */
  readonly stateDir: string;
  /** The runners' folders, short and outside the repo (git refuses long `.git` paths on Windows). */
  readonly runnersDir: string;
  readonly screenshotDir: string;
  readonly samUsername: string;
  readonly samPassword: string;
  /** `--steps 1,2,3`: run only these steps (the setup always runs). Every step when empty. */
  readonly steps: readonly number[];
  /** `--keep`: leave the tickets, PRs and branches for a look after the run. */
  readonly keep: boolean;
};

const argAfter = (argv: readonly string[], name: string): string | null => {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

export const m5Settings = (env: Readonly<Record<string, string | undefined>>, argv: readonly string[]): M5Settings => {
  const parsed = envSchema.parse(env);
  const ports = { web: parsed.OSTRA_E2E_M5_WEB_PORT, core: parsed.OSTRA_E2E_M5_CORE_PORT, pg: parsed.OSTRA_E2E_M5_PG_PORT };
  if ([3000, 8787, 54329].some((port) => Object.values(ports).includes(port))) {
    throw new Error("the demo never runs on the default ports (3000, 8787, 54329): another stack may be there");
  }
  const panelUrl = `http://localhost:${String(ports.web)}`;
  const coreUrls = Array.from({ length: parsed.OSTRA_E2E_M5_REPLICAS }, (_unused, index) => `http://127.0.0.1:${String(ports.core + index)}`);
  const m2 = m2Settings({
    // The stub stands in for model.env's endpoint; the demo settings still want its three values.
    OSTRA_DEV_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    OSTRA_DEV_MODEL_API_KEY: "unused",
    OSTRA_DEV_MODEL_ID: "unused",
    ...env,
    OSTRA_E2E_PANEL_URL: panelUrl,
    OSTRA_E2E_CORE_URL: coreUrls[0] ?? panelUrl,
    OSTRA_PUBLIC_URL: panelUrl,
    OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
  });
  const stateDir = path.join(repoRoot, ".ostra-dev", "e2e-m5");
  const runnersDir = path.join(os.tmpdir(), "ostra-m5d");
  const screenshotDir = path.join(repoRoot, "context", "specs", "m5-the-fleet", "demo");
  const tools = parsed.OSTRA_E2E_M5_TOOLS_PORT;
  const steps = (argAfter(argv, "--steps") ?? "")
    .split(",")
    .map((step) => Number.parseInt(step.trim(), 10))
    .filter((step) => Number.isInteger(step));
  return {
    // Milestone 1's helpers keep their own screenshots in the state folder: the record is this demo's.
    m2: { ...m2, screenshotDir: path.join(stateDir, "setup-shots"), stateDir, runnerDataDir: path.join(runnersDir, "sam"), runnerName: "sam-laptop", logFiles: [] },
    ports,
    replicas: parsed.OSTRA_E2E_M5_REPLICAS,
    tools: { fakeKube: tools, registry: tools + 1, npmRegistry: tools + 2, netProxies: tools + 3 },
    panelUrl,
    coreUrls,
    stateDir,
    runnersDir,
    screenshotDir,
    samUsername: "sam",
    samPassword: parsed.OSTRA_E2E_SAM_PASSWORD,
    steps,
    keep: argv.includes("--keep"),
  };
};
