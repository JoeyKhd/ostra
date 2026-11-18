import { defineConfig } from "vitest/config";

// Root config: runs the repo-level scripts' tests. Each workspace package runs its own tests
// through turbo, with Vitest's defaults.
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    environment: "node",
  },
});
