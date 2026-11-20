import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// One embedded Postgres per run and a database per test file (packages/db, ticket 05): the end-to-end
// case runs a real core on it.
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))],
    hookTimeout: 180_000,
    testTimeout: 120_000,
  },
});
