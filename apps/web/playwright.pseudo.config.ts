import { defineConfig, devices } from "@playwright/test";

import { e2ePort } from "./e2e/settings.ts";

// F-083 (ticket 20): the pseudo-locale pass. Its own stack (`e2e/stack.ts` with
// OSTRA_PSEUDO_LOCALE=1, twenty ports above the main stack's) serves the pseudo-locale build, in
// which every message reads `⟦…⟧`; `e2e/pseudo-locale.spec.ts` walks every route and finds any
// visible text outside the brackets. Build and run it with:
//
//   OSTRA_PSEUDO_LOCALE=1 pnpm --filter @ostra/web exec next build
//   OSTRA_PSEUDO_LOCALE=1 pnpm --filter @ostra/web exec playwright test -c playwright.pseudo.config.ts
//
// The proof workflow's `e2e-pseudo` job runs both (never ci.yml, AGENTS.md).

// The spec reads the panel's own words in the pseudo-locale, through `t`.
process.env["OSTRA_PSEUDO_LOCALE"] = "1";

const pseudoPort = e2ePort + 20;
const ci = process.env["CI"] === "true";

export default defineConfig({
  testDir: "e2e",
  testMatch: "pseudo-locale.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  forbidOnly: ci,
  reporter: ci ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"]],
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${String(pseudoPort)}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "node e2e/stack.ts",
    url: `http://localhost:${String(pseudoPort)}/sign-in`,
    env: { OSTRA_E2E_PORT: String(pseudoPort), OSTRA_PSEUDO_LOCALE: "1" },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
  },
});
