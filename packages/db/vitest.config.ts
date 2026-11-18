import { defineConfig } from "vitest/config";

// One embedded Postgres per run, a migrated template, and a database per test file (ticket 05).
export default defineConfig({
  test: {
    globalSetup: ["./src/testing/global-setup.ts"],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
