import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The rehearsal runs core as its own process on a database of its own (packages/db, ticket 05).
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
