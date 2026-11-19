import { defineConfig, devices } from "@playwright/test";

import { e2eBaseUrl } from "./e2e/settings.ts";

// The panel's browser checks (ADR 0007): a throwaway stack (`e2e/stack.ts`) and Chromium at
// desktop and phone width. Run with `pnpm --filter @ostra/web test:e2e`, which builds the panel first.
// On CI it also writes the HTML report and a screenshot of each failure, for the job's artifacts, and
// an annotation per failure, which the run's page shows without signing in.
const ci = process.env["CI"] === "true";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: ci,
  reporter: ci ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: e2eBaseUrl, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // The setup specs write data and run once, at desktop width; the phone project leaves them out.
    { name: "phone", use: { ...devices["Pixel 7"] }, dependencies: ["desktop"], testIgnore: ["**/02-setup.spec.ts", "**/03-first-run.spec.ts"] },
  ],
  webServer: {
    command: "node e2e/stack.ts",
    url: `${e2eBaseUrl}/sign-in`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
