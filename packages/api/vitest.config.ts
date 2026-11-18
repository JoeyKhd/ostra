import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// One embedded Postgres per run and a migrated database per test file (ticket 05, docs/development.md).
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
