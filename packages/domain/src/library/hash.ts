import { createHash } from "node:crypto";

// F-145 (ADR 0069, ticket 06): a skill's `computedHash`, the `skills` CLI's documented algorithm
// (its README, "Lock File Content Hash", and `src/skill-hash.ts`; research §2.5), so ostra's pin
// agrees with a repo's `skills-lock.json`:
// - the skill's files, paths relative to its folder with `/`, minus any file named
//   `metadata.json` and anything under a folder named `.git`, `__pycache__` or `__pypackages__`,
//   at any depth;
// - in a text file (one with no NUL byte), each CRLF made LF; a lone CR stays;
// - sorted by the UTF-8 bytes of each path, never by a locale;
// - `path \0 <length in decimal> \0 <content>` for each file, into one SHA-256, as lowercase hex.

/** A file of a skill: its path relative to the skill's folder, and its bytes. */
export type SkillFile = { readonly path: string; readonly bytes: Uint8Array };

const EXCLUDED_FILES: ReadonlySet<string> = new Set(["metadata.json"]);
const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set([".git", "__pycache__", "__pypackages__"]);

/** Whether the installer leaves the file out: the hash never counts it, and the library never stores it. */
export const isExcludedSkillPath = (path: string): boolean => {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return EXCLUDED_FILES.has(name) || parts.slice(0, -1).some((part) => EXCLUDED_FOLDERS.has(part));
};

/** The files the installer keeps. */
export const skillFilesOf = <T extends { readonly path: string }>(files: readonly T[]): T[] => files.filter((file) => !isExcludedSkillPath(file.path));

/** A text file's bytes with each CRLF made LF; a binary file's (one holding a NUL byte) as they are. */
export const normalizedSkillBytes = (bytes: Uint8Array): Uint8Array => {
  if (bytes.includes(0)) {
    return bytes;
  }
  let crlf = 0;
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) crlf += 1;
  }
  if (crlf === 0) {
    return bytes;
  }
  const out = new Uint8Array(bytes.length - crlf);
  let at = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      continue;
    }
    out[at] = byte;
    at += 1;
  }
  return out;
};

const encoder = new TextEncoder();

/** Compares two byte strings as `Buffer.compare` does: byte by byte, the shorter first on a tie. */
const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/** The skill's `computedHash`: lowercase hex, as `skills-lock.json` writes it. */
export const computedHash = (files: readonly SkillFile[]): string => {
  const entries = skillFilesOf(files)
    .map((file) => ({ path: encoder.encode(file.path.split("\\").join("/")), content: normalizedSkillBytes(file.bytes) }))
    .sort((a, b) => compareBytes(a.path, b.path));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.content.length));
    hash.update("\0");
    hash.update(entry.content);
  }
  return hash.digest("hex");
};
