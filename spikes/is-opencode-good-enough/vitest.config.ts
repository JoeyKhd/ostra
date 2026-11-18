import { defineConfig } from "vitest/config";

// Only the spike's own tests. The sample repo's tests and the hidden acceptance
// files run on node:test, inside the harness, never here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
