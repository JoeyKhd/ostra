import { defineConfig } from "vitest/config";

// `pnpm test`: the unit tests. The checked build (`scripts/export.check.test.ts`) needs `out/`, so it
// runs after `next build`, from `vitest.export.config.ts`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
