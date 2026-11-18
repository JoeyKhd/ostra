import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

/**
 * A temporary directory inside this spike's `.runs/` (gitignored), never the
 * system temp dir: a killed test run leaves nothing outside the spike, and git
 * there runs under the `GIT_CEILING_DIRECTORIES=.runs` guard (src/lib/git.ts).
 */
export const spikeTempDir = async (prefix: string): Promise<string> => {
  const runs = path.resolve(import.meta.dirname, "..", ".runs");
  await mkdir(runs, { recursive: true });
  return mkdtemp(path.join(runs, prefix));
};
