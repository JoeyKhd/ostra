import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The rehearsal runs core as its own process on a database of its own (packages/db, ticket 05).
// It runs only at the launch gate (OSTRA_LINEAR_REHEARSAL=1, `src/rehearsal.test.ts`), and the
// harness's own tests need no database, so `pnpm test` starts no Postgres here.
const rehearsal = process.env["OSTRA_LINEAR_REHEARSAL"] === "1";

export default defineConfig({
  test: {
    globalSetup: rehearsal ? [fileURLToPath(import.meta.resolve("@ostra/db/testing/global-setup"))] : [],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
