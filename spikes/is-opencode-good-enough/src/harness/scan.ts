// A scan of a folder of run records for something that must never be in them:
// a real key, or a fake key that got out of the agent's environment. It reports
// which files, never what was found.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listFiles } from "../runner/workspace.ts";

export type ScanResult = { readonly files: number; readonly hits: readonly string[] };

const MAX_BYTES = 8_000_000;

export const scanForSecrets = async (dir: string, needles: readonly (string | RegExp)[]): Promise<ScanResult> => {
  const hits: string[] = [];
  const files = await listFiles(dir).catch((): string[] => []);
  for (const file of files) {
    const full = path.join(dir, file);
    const info = await stat(full).catch(() => undefined);
    if (info === undefined || info.size > MAX_BYTES) continue;
    const text = await readFile(full, "utf8").catch(() => "");
    if (needles.some((needle) => (typeof needle === "string" ? needle !== "" && text.includes(needle) : needle.test(text)))) hits.push(file);
  }
  return { files: files.length, hits };
};
