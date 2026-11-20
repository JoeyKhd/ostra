import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The dev secrets' files (`~/.config/ostra-dev/*.env`, docs/development.md): read as the shell's
// `set -a; . file; set +a` would, and one value written back in place, for the app's rotating
// refresh token (ticket 38). Values are secrets: nothing here prints, logs or returns them in a
// message, and a write replaces the file whole, so a crash leaves the old file or the new one.

/** `~/.config/ostra-dev`, or `OSTRA_DEV_CONFIG_DIR` (the harness's tests point it at a folder of their own). */
export const devConfigDir = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env["OSTRA_DEV_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ostra-dev");

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The `KEY=value` lines of a dotenv text; comments and blank lines left out. */
export const parseEnvText = (text: string): Readonly<Record<string, string>> => {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) {
      continue;
    }
    const match = LINE.exec(line);
    const key = match?.[1];
    if (key !== undefined) {
      values[key] = unquote(match?.[2] ?? "");
    }
  }
  return values;
};

/** A file's values, or none when it's missing. */
export const readEnvFile = async (file: string): Promise<Readonly<Record<string, string>>> => {
  try {
    return parseEnvText(await readFile(file, "utf8"));
  } catch {
    return {};
  }
};

/**
 * The text with `key` set to `value`: the first line that sets it is replaced, any later ones
 * dropped, and the line is added at the end when none set it. Every other line stays as it was.
 */
export const setEnvValue = (text: string, key: string, value: string): string => {
  if (/[\r\n]/.test(value)) {
    throw new Error(`a value for ${key} can't hold a line break`);
  }
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let written = false;
  const out: string[] = [];
  for (const line of lines) {
    const match = LINE.exec(line);
    if (match?.[1] === key && !line.trim().startsWith("#")) {
      if (!written) {
        out.push(`${key}=${value}`);
        written = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!written) {
    if (out.length > 0 && out.at(-1) === "") {
      out.splice(out.length - 1, 0, `${key}=${value}`);
    } else {
      out.push(`${key}=${value}`);
    }
  }
  const joined = out.join(eol);
  return joined.endsWith(eol) ? joined : `${joined}${eol}`;
};

/** Writes `key=value` into the file in place (made when missing), through a temporary file and a rename. */
export const writeEnvValue = async (file: string, key: string, value: string): Promise<void> => {
  const before = await readFile(file, "utf8").catch(() => "");
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, setEnvValue(before, key, value), { mode: 0o600 });
  await rename(temporary, file);
};
