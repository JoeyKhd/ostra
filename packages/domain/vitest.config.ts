import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// One embedded Postgres per run and a migrated database per test file (packages/db, ticket 05), for
// the domain's tests that run on Postgres (milestone 11: tracker connections and boards). The
// others never open one.
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
