import { defineConfig } from "vitest/config";

// The contract suite starts the real OpenCode binary for each case, so cases get room.
export default defineConfig({ test: { testTimeout: 180_000, hookTimeout: 60_000 } });
