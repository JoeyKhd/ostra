import { defineConfig, devices } from "@playwright/test";

import { e2eBaseUrl } from "./e2e/settings.ts";

// The panel's browser checks (ADR 0007): a throwaway stack (`e2e/stack.ts`) and Chromium at
// desktop and phone width. Run with `pnpm --filter @ostra/web test:e2e` after `next build`.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: e2eBaseUrl, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] }, dependencies: ["desktop"] },
  ],
  webServer: {
    command: "node e2e/stack.ts",
    url: `${e2eBaseUrl}/sign-in`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
