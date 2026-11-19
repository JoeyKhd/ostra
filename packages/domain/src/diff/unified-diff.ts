// The unified-diff parser (F-027, ADR 0051): a code host's patch for one file into hunks and lines,
// each line with its number on the old side, the new side, or both. Pure. A patch holds the repo's
// code: it's never logged.
//
// GitHub's patches carry no `diff --git` or `---`/`+++` header: they start at the first `@@`. A
// header the host did send is skipped. A binary file has no patch at all (`null`), and a rename
// with no change has an empty one: both parse to no hunks.

/** One line of a hunk. `context` lines have both numbers, `add` only the new, `del` only the old. */
export type DiffLine =
  | { readonly kind: "context"; readonly oldLine: number; readonly newLine: number; readonly text: string }
  | { readonly kind: "add"; readonly oldLine: null; readonly newLine: number; readonly text: string }
  | { readonly kind: "del"; readonly oldLine: number; readonly newLine: null; readonly text: string };

export type DiffHunk = {
  /** The `@@ -a,b +c,d @@` line as the host wrote it, with its section heading. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
};

export type ParsedPatch = {
  readonly hunks: readonly DiffHunk[];
  /** The old file ends without a newline (`\ No newline at end of file` after its last line). */
  readonly oldNoNewlineAtEnd: boolean;
  readonly newNoNewlineAtEnd: boolean;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const EMPTY: ParsedPatch = { hunks: [], oldNoNewlineAtEnd: false, newNoNewlineAtEnd: false };

/** Parses one file's patch. A line outside a hunk, or a malformed header, is skipped, never thrown on. */
export const parseUnifiedDiff = (patch: string | null): ParsedPatch => {
  if (patch === null || patch === "") {
    return EMPTY;
  }
  const rows = patch.split("\n");
  // A patch that ends with a newline leaves one empty row after it, which is no line of the diff.
  if (rows.at(-1) === "") {
    rows.pop();
  }
  const hunks: DiffHunk[] = [];
  let current: { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] } | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldNoNewlineAtEnd = false;
  let newNoNewlineAtEnd = false;
  /** The side of the last line read, for a `\ No newline` marker after it. */
  let last: "context" | "add" | "del" | null = null;
  for (const raw of rows) {
    const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(row);
    if (header !== null) {
      current = {
        header: row,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      last = null;
      continue;
    }
    if (current === null) {
      // A `diff --git`, `index`, `---` or `+++` header before the first hunk.
      continue;
    }
    const marker = row.charAt(0);
    const text = row.slice(1);
    switch (marker) {
      case " ":
      case "":
        // A blank row inside a hunk is a context line whose leading space was lost.
        current.lines.push({ kind: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
        last = "context";
        break;
      case "+":
        current.lines.push({ kind: "add", oldLine: null, newLine, text });
        newLine += 1;
        last = "add";
        break;
      case "-":
        current.lines.push({ kind: "del", oldLine, newLine: null, text });
        oldLine += 1;
        last = "del";
        break;
      case "\\":
        // `\ No newline at end of file`: about the line just before it.
        if (last === "del") {
          oldNoNewlineAtEnd = true;
        } else if (last === "add") {
          newNoNewlineAtEnd = true;
        } else if (last === "context") {
          oldNoNewlineAtEnd = true;
          newNoNewlineAtEnd = true;
        }
        break;
      default:
        // Anything else isn't part of a unified diff: skipped.
        break;
    }
  }
  return { hunks, oldNoNewlineAtEnd, newNoNewlineAtEnd };
};

/** The side of a diff a line number belongs to: the base's (`old`) or the head's (`new`). */
export type DiffSide = "old" | "new";

/** The line of a parsed patch at a side's number, or `null` when the diff doesn't show that line. */
export const lineAt = (parsed: ParsedPatch, side: DiffSide, line: number): DiffLine | null => {
  for (const hunk of parsed.hunks) {
    for (const candidate of hunk.lines) {
      const number = side === "old" ? candidate.oldLine : candidate.newLine;
      if (number === line) {
        return candidate;
      }
    }
  }
  return null;
};

/**
 * The lines a comment quotes: the commented line and up to `before` lines above it in its hunk, on
 * the same side, each with its marker. Empty when the line isn't in the diff.
 */
export const quotedLines = (parsed: ParsedPatch, side: DiffSide, line: number, before = 2): string => {
  for (const hunk of parsed.hunks) {
    const index = hunk.lines.findIndex((candidate) => (side === "old" ? candidate.oldLine : candidate.newLine) === line);
    if (index === -1) {
      continue;
    }
    const sameSide = hunk.lines.slice(0, index + 1).filter((candidate) => (side === "old" ? candidate.oldLine : candidate.newLine) !== null);
    return sameSide
      .slice(-1 - before)
      .map((candidate) => `${candidate.kind === "add" ? "+" : candidate.kind === "del" ? "-" : " "}${candidate.text}`)
      .join("\n");
  }
  return "";
};
