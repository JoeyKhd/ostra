import { defineConfig } from "vitest/config";

// Each case starts a tool as its own process and stops it.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 30_000 } });
