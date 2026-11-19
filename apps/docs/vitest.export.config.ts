import path from "node:path";

import { defineConfig } from "vitest/config";

// `pnpm check:export`, after `next build`: the checked build of the static export (ticket 21).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["scripts/export.check.test.ts"],
    environment: "node",
  },
});
