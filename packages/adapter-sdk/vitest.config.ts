import { defineConfig } from "vitest/config";

// The contract suites and the driver's cases start real processes: the fake ACP agent, the tiny
// executor's children, taskkill and PowerShell for the process tree. Vitest's default of 5 s
// covered all of that, setup and teardown included, and on a loaded Windows machine one process
// listing alone takes seconds. The budgets the cases check (a cancel in under 5 s) are asserted
// inside them; this only stops a case that hangs.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
