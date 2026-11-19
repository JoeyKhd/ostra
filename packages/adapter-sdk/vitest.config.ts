import { defineConfig } from "vitest/config";

// The contract suites and the driver's cases start real processes: the fake ACP agent, the tiny
// executor's children, and taskkill for the process tree. Vitest's default of 5 s covered all of
// that, setup and teardown included, and on a loaded Windows machine where koffi can't load, one
// process listing through PowerShell alone takes seconds. The budgets the cases check (a cancel in under 5 s) are asserted
// inside them; this only stops a case that hangs.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
