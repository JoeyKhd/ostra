import path from "node:path";

import { defineConfig } from "vitest/config";

// Unit tests of the panel's pure parts (the messages helper, the stream client, the converter).
// The browser flows are Playwright's (`e2e/`).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], environment: "node" },
});
