import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// A repo's variables and secrets in its checkout (spec section 11, item 7): written to the repo's
// env file (`.env` by default, or the path the environment names), one `NAME=value` a line, and
// every file ostra writes into a checkout is kept out of git: through the repo's own .gitignore, or
// a line in `.git/info/exclude`. Nothing is shared across repos.

/** A value as a dotenv line takes it: bare when it's plain, double-quoted with escapes otherwise. */
export const dotenvValue = (value: string): string =>
  /^[A-Za-z0-9_./:@+,-]*$/.test(value)
    ? value
    : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;

export const renderEnvFile = (variables: readonly { readonly name: string; readonly value: string }[]): string =>
  variables.map((variable) => `${variable.name}=${dotenvValue(variable.value)}\n`).join("");

/**
 * Resolves a repo-relative path inside a checkout, or `null` when it would leave it or write into
 * git's own folder (a hook there would run code).
 */
export const insideCheckout = (checkout: string, relative: string): string | null => {
  const parts = relative.split("/");
  if (parts.some((part) => part === ".." || part === "") || parts[0]?.toLowerCase() === ".git") {
    return null;
  }
  const target = path.resolve(checkout, ...parts);
  const root = path.resolve(checkout);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
};

/** Writes a file into the checkout, making its folders. */
export const writeCheckoutFile = async (target: string, content: string): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, { mode: 0o600 });
};

/** Adds lines to `.git/info/exclude` that aren't there yet. */
export const excludeFromGit = async (gitDir: string, relativePaths: readonly string[]): Promise<void> => {
  const file = path.join(gitDir, "info", "exclude");
  await mkdir(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  const have = new Set(existing.split(/\r?\n/));
  const add = relativePaths.map((relative) => `/${relative}`).filter((line) => !have.has(line));
  if (add.length === 0) {
    return;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${prefix}# written by ostra: the task's environment, never committed\n${add.join("\n")}\n`);
};
