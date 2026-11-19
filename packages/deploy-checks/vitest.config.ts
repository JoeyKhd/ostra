import { defineConfig } from "vitest/config";

// The checks read the repo's deploy files and, where Helm is installed, render the charts.
export default defineConfig({ test: { testTimeout: 60_000 } });
