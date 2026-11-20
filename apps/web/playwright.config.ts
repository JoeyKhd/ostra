import { defineConfig, devices } from "@playwright/test";

import { e2eBaseUrl, e2eDefaultPasswordBaseUrl, e2eDefaultPasswordPort, e2eExternalStack } from "./e2e/settings.ts";

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
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: ["**/06-default-password.spec.ts", "**/06-email-locked.spec.ts", "phone/**", "**/pseudo-locale.spec.ts", "a11y/**"],
    },
    // The setup specs write data and run once, at desktop width; the phone project leaves them out,
    // and a test tagged `@desktop-only` (it changes state once: the seeded admin's default password).
    {
      name: "phone",
      use: { ...devices["Pixel 7"] },
      dependencies: ["desktop"],
      testIgnore: ["**/02-setup.spec.ts", "**/03-first-run.spec.ts", "**/06-default-password.spec.ts", "**/06-email-locked.spec.ts", "phone/**", "**/pseudo-locale.spec.ts", "a11y/**"],
      grepInvert: /@desktop-only/,
    },
    // F-075 (ticket 19): the phone sweep, every route on a touch phone at 390 × 844. It seeds its
    // own member and world, so it needs no other project and runs alone (`--project phone-sweep`).
    {
      name: "phone-sweep",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } },
      testMatch: "phone/**/*.spec.ts",
    },
    // F-081 (ticket 17): the keyboard walk and the contrast check on every route, in both themes, at
    // 1440 px and at 390 px. Each seeds its own member and world, so they run alone
    // (`--project a11y-desktop --project a11y-phone`).
    {
      name: "a11y-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testMatch: "a11y/**/*.spec.ts",
    },
    {
      name: "a11y-phone",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } },
      testMatch: "a11y/**/*.spec.ts",
    },
    // F-001: the second stack, with OSTRA_ALLOW_DEFAULT_PASSWORD=true, and only its specs. Its email
    // is set by its settings too (F-115, ticket 45), which lock the email page.
    {
      name: "default-password",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: e2eDefaultPasswordBaseUrl },
      testMatch: ["**/06-default-password.spec.ts", "**/06-email-locked.spec.ts"],
    },
  ],
  // An outside stack (OSTRA_E2E_PANEL_URL, e2e/settings.ts) is already running, with the fakes beside
  // it (e2e/compose-e2e.sh): Playwright starts no stack of its own.
  webServer: e2eExternalStack
    ? []
    : [
        {
          command: "node e2e/stack.ts",
          url: `${e2eBaseUrl}/sign-in`,
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: "pipe",
        },
        {
          // F-001: an install that allows the default password (`06-default-password.spec.ts`), and
          // whose settings set its email (F-115, `06-email-locked.spec.ts`).
          command: "node e2e/stack.ts",
          url: `${e2eDefaultPasswordBaseUrl}/sign-in`,
          env: { OSTRA_E2E_PORT: String(e2eDefaultPasswordPort), OSTRA_ALLOW_DEFAULT_PASSWORD: "true", OSTRA_E2E_EMAIL_LOCKED: "1" },
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: "ignore",
        },
      ],
});
