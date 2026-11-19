import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { DemoSettings } from "./settings.ts";

// Searching for a credential by value. A secret is looked for and never printed: what comes back is
// file paths and counts.

/** GitHub's tokens start with `gh?_` (a pattern, not a value). Installation tokens are `ghs_`. */
export const TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{30,}/;

/** A PEM line shorter than this is too common in other text to count as the key. */
const MIN_NEEDLE_CHARS = 24;

/** The base64 lines of a PEM: every one is searched for, so a file holding any part of the key is found. */
export const pemLines = (pem: string): readonly string[] =>
  pem
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_NEEDLE_CHARS && !line.startsWith("-----"));

/** The values that must appear nowhere: the real model token, and every line of the App's private key. */
export const secretNeedles = async (settings: DemoSettings): Promise<readonly string[]> => [
  settings.modelApiKey,
  ...pemLines(await readFile(settings.githubPrivateKeyPath, "utf8")),
];

/** Whether the bytes hold a needle, or look like a GitHub token. */
export const holdsSecret = (data: Buffer, needles: readonly string[]): boolean =>
  needles.some((needle) => data.includes(needle)) || TOKEN_PATTERN.test(data.toString("latin1"));

/** Whether a string (an environment value, say) holds a needle or looks like a GitHub token. */
export const textHoldsSecret = (text: string, needles: readonly string[]): boolean => holdsSecret(Buffer.from(text, "utf8"), needles);

export type FolderScan = {
  /** The folder was there. */
  readonly exists: boolean;
  /** Files read in full. */
  readonly files: number;
  /** Files that could not be read: they cannot be called clean. */
  readonly unreadable: number;
  /** Their paths, relative to the folder (a path holds no secret; the file's content might). */
  readonly unreadablePaths: readonly string[];
  /** Paths, relative to the folder, of the files that hold a secret. */
  readonly holding: readonly string[];
};

/** Beyond this a file is read in pieces no longer: a task's folders hold nothing this large but a database. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Git objects are compressed: a value can't be read in them, and they are most of a checkout. */
const skipDirectory = (relative: string): boolean => {
  const parts = relative.split(path.sep);
  return parts.at(-1) === "node_modules" || parts.slice(-2).join("/") === ".git/objects";
};

/** Every file under `root` (symlinks aren't followed), searched for the needles and the token pattern. */
export const scanFolder = async (root: string, needles: readonly string[]): Promise<FolderScan> => {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return { exists: false, files: 0, unreadable: 0, unreadablePaths: [], holding: [] };
  let files = 0;
  const unreadablePaths: string[] = [];
  const holding: string[] = [];
  const slashed = (relative: string): string => relative.split(path.sep).join("/");
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      unreadablePaths.push(`${slashed(relative)}/`);
      return;
    }
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectory(child)) await walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const size = (await stat(path.join(root, child))).size;
        if (size > MAX_FILE_BYTES) {
          unreadablePaths.push(slashed(child));
          continue;
        }
        // An empty file holds nothing, and needn't be opened: a lock file another process holds
        // exclusively (OpenCode's PTY service keeps one while a shell runs) can be stat'ed, not read.
        if (size === 0) {
          files += 1;
          continue;
        }
        const data = await readFile(path.join(root, child));
        files += 1;
        if (holdsSecret(data, needles)) holding.push(slashed(child));
      } catch {
        unreadablePaths.push(slashed(child));
      }
    }
  };
  await walk("");
  return { exists: true, files, unreadable: unreadablePaths.length, unreadablePaths, holding };
};
