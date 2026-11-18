import { defineConfig } from "vitest/config";

// The cases clone repos and start processes, so they get room.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 60_000 } });
