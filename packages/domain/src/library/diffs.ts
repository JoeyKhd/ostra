import { normalizedSkillBytes, skillFilesOf } from "./hash.ts";
import type { SkillFile } from "./hash.ts";

// F-145 (ADR 0069, Q323, ticket 06): what an update changes, shown to an admin before it's
// accepted. A skill's diff lists its files added, removed and changed, with each text file's line
// diff, three lines of context around each change, capped at `SKILL_DIFF_MAX_LINES` in all; past
// the cap a file is listed with no lines and says so. A server's diff names the fields of its entry
// that changed and the tools a fresh test call lists. Files compare as the hash reads them (CRLF as
// LF), so a diff is empty exactly when the hash didn't change. Pure; a skill's text is never logged.

/** The most lines a skill's diff carries, every file together *(working value)*. */
export const SKILL_DIFF_MAX_LINES = 2000;
/** Lines of context around each change. */
const CONTEXT_LINES = 3;

export type SkillDiffLine =
  | { readonly kind: "context"; readonly oldLine: number; readonly newLine: number; readonly text: string }
  | { readonly kind: "add"; readonly oldLine: null; readonly newLine: number; readonly text: string }
  | { readonly kind: "del"; readonly oldLine: number; readonly newLine: null; readonly text: string };

export type SkillFileDiff = {
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  /** A file holding a NUL byte: listed, never diffed by line. */
  readonly binary: boolean;
  readonly lines: readonly SkillDiffLine[];
  /** The cap cut this file's lines, or left them all out. */
  readonly truncated: boolean;
};

export type SkillDiff = { readonly files: readonly SkillFileDiff[]; readonly truncated: boolean };

type Op = { readonly kind: "equal" | "add" | "del"; readonly oldIndex: number; readonly newIndex: number };

const decoder = new TextDecoder();

const linesOf = (bytes: Uint8Array): string[] => {
  const text = decoder.decode(bytes);
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * Myers' diff of two lists of lines, the shortest edit script, keeping only the window of each
 * step it needs to walk back (memory grows with the edits squared, not the file). `null` when it
 * takes more than `maxEdits` edits.
 */
const editScript = (a: readonly string[], b: readonly string[], maxEdits: number): Op[] | null => {
  // The lines both share at either end are equal, whatever the middle does.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const at = (list: readonly string[], index: number): string | undefined => list[prefix + index];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** `trace[d]`: v for k in [-d-1, d+1] before step d. */
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    if (d > maxEdits) {
      return null;
    }
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && at(a, x) === at(b, y)) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const window = trace[d];
    if (window === undefined) break;
    const get = (k: number): number => window[k + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = get(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      middle.push({ kind: "equal", oldIndex: prefix + x - 1, newIndex: prefix + y - 1 });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      middle.push(x === previousX ? { kind: "add", oldIndex: prefix + x, newIndex: prefix + y - 1 } : { kind: "del", oldIndex: prefix + x - 1, newIndex: prefix + y });
    }
    x = previousX;
    y = previousY;
  }
  const ops: Op[] = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ kind: "equal", oldIndex: index, newIndex: index });
  ops.push(...middle.reverse());
  for (let index = 0; index < suffix; index += 1) ops.push({ kind: "equal", oldIndex: a.length - suffix + index, newIndex: b.length - suffix + index });
  return ops;
};

/** The changes with their context, as numbered lines, at most `budget`; whether it cut them. */
const hunksOf = (a: readonly string[], b: readonly string[], ops: readonly Op[], budget: number): { readonly lines: SkillDiffLine[]; readonly truncated: boolean } => {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "equal") return;
    for (let near = Math.max(0, index - CONTEXT_LINES); near <= Math.min(ops.length - 1, index + CONTEXT_LINES); near += 1) keep[near] = true;
  });
  const lines: SkillDiffLine[] = [];
  for (const [index, op] of ops.entries()) {
    if (keep[index] !== true) continue;
    if (lines.length >= budget) return { lines, truncated: true };
    switch (op.kind) {
      case "equal":
        lines.push({ kind: "context", oldLine: op.oldIndex + 1, newLine: op.newIndex + 1, text: a[op.oldIndex] ?? "" });
        break;
      case "add":
        lines.push({ kind: "add", oldLine: null, newLine: op.newIndex + 1, text: b[op.newIndex] ?? "" });
        break;
      case "del":
        lines.push({ kind: "del", oldLine: op.oldIndex + 1, newLine: null, text: a[op.oldIndex] ?? "" });
        break;
      default:
        return op.kind satisfies never;
    }
  }
  return { lines, truncated: false };
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** A skill's files before and after an update, paths relative to its folder. */
export const skillDiff = (before: readonly SkillFile[], after: readonly SkillFile[]): SkillDiff => {
  const old = new Map(skillFilesOf(before).map((file) => [file.path, normalizedSkillBytes(file.bytes)]));
  const next = new Map(skillFilesOf(after).map((file) => [file.path, normalizedSkillBytes(file.bytes)]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].sort();
  let budget = SKILL_DIFF_MAX_LINES;
  let truncated = false;
  const files: SkillFileDiff[] = [];
  for (const path of paths) {
    const from = old.get(path);
    const to = next.get(path);
    if (from !== undefined && to !== undefined && sameBytes(from, to)) continue;
    const change = from === undefined ? "added" : to === undefined ? "removed" : "changed";
    const binary = (from?.includes(0) ?? false) || (to?.includes(0) ?? false);
    if (binary) {
      files.push({ path, change, binary, lines: [], truncated: false });
      continue;
    }
    const a = from === undefined ? [] : linesOf(from);
    const b = to === undefined ? [] : linesOf(to);
    // A file added or removed is all adds or all dels, shown up to the cap; a change is diffed.
    const ops =
      from === undefined
        ? b.map((_, index): Op => ({ kind: "add", oldIndex: 0, newIndex: index }))
        : to === undefined
          ? a.map((_, index): Op => ({ kind: "del", oldIndex: index, newIndex: 0 }))
          : budget === 0
            ? null
            : editScript(a, b, budget);
    const shown = ops === null ? { lines: [], truncated: true } : hunksOf(a, b, ops, budget);
    budget -= shown.lines.length;
    truncated ||= shown.truncated;
    files.push({ path, change, binary, lines: shown.lines, truncated: shown.truncated });
  }
  return { files, truncated };
};

// ---------- a server's update ----------

/** What a server's diff compares: its entry's fields that matter, and the tools a test call listed. */
export type ServerSnapshot = {
  readonly version: string;
  readonly description: string | null;
  /** The remote's URL template, before the admin's variables. */
  readonly remoteUrl: string;
  /** The headers the remote asks for, by name. Never a value. */
  readonly headers: readonly { readonly name: string; readonly isSecret: boolean }[];
  readonly toolNames: readonly string[];
};

export type FieldChange<T> = { readonly from: T; readonly to: T } | null;

export type ServerDiff = {
  readonly version: FieldChange<string>;
  readonly description: FieldChange<string | null>;
  readonly remoteUrl: FieldChange<string>;
  readonly headers: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    /** Headers whose secret mark changed: one that turned plain is worth a look. */
    readonly secretChanged: readonly { readonly name: string; readonly isSecret: boolean }[];
  };
  readonly tools: { readonly added: readonly string[]; readonly removed: readonly string[] };
  /** Whether anything above changed. */
  readonly changed: boolean;
};

const fieldChange = <T>(from: T, to: T): FieldChange<T> => (from === to ? null : { from, to });

/** Header names are matched without case, as HTTP matches them. */
const headerKey = (name: string): string => name.toLowerCase();

export const serverDiff = (before: ServerSnapshot, after: ServerSnapshot): ServerDiff => {
  const oldHeaders = new Map(before.headers.map((header) => [headerKey(header.name), header]));
  const newHeaders = new Map(after.headers.map((header) => [headerKey(header.name), header]));
  const oldTools = new Set(before.toolNames);
  const newTools = new Set(after.toolNames);
  const diff = {
    version: fieldChange(before.version, after.version),
    description: fieldChange(before.description, after.description),
    remoteUrl: fieldChange(before.remoteUrl, after.remoteUrl),
    headers: {
      added: after.headers.filter((header) => !oldHeaders.has(headerKey(header.name))).map((header) => header.name),
      removed: before.headers.filter((header) => !newHeaders.has(headerKey(header.name))).map((header) => header.name),
      secretChanged: after.headers
        .filter((header) => {
          const old = oldHeaders.get(headerKey(header.name));
          return old !== undefined && old.isSecret !== header.isSecret;
        })
        .map((header) => ({ name: header.name, isSecret: header.isSecret })),
    },
    tools: { added: [...newTools].filter((name) => !oldTools.has(name)).sort(), removed: [...oldTools].filter((name) => !newTools.has(name)).sort() },
  };
  const changed =
    diff.version !== null ||
    diff.description !== null ||
    diff.remoteUrl !== null ||
    diff.headers.added.length + diff.headers.removed.length + diff.headers.secretChanged.length + diff.tools.added.length + diff.tools.removed.length > 0;
  return { ...diff, changed };
};
