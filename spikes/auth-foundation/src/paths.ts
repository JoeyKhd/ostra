import path from "node:path";

/** The spike's own directory: everything below it is the spike's. */
export const spikeRoot: string = path.resolve(import.meta.dirname, "..");

export const nodeModulesBin = {
  prisma: path.join(spikeRoot, "node_modules", "prisma", "build", "index.js"),
  tsc: path.join(spikeRoot, "node_modules", "typescript", "bin", "tsc"),
  vitest: path.join(spikeRoot, "node_modules", "vitest", "vitest.mjs"),
} as const;

/** Where throwaway database clusters live. Gitignored. */
export const dataDir: string = path.join(spikeRoot, ".data");

/**
 * The environment child tools run with: telemetry and update checks off
 * (ADR 0021), and the database URL given explicitly.
 */
export const toolEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  CHECKPOINT_DISABLE: "1",
  PRISMA_HIDE_UPDATE_MESSAGE: "1",
  NO_COLOR: "1",
  ...extra,
});
