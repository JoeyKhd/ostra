import type { CompareFile, CompareResult } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";

import { commentStillMatches, diffLineAt, readStoredDiff, toStoredDiff } from "./stored-diff.ts";
import { lineAt, parseUnifiedDiff, quotedLines } from "./unified-diff.ts";

// Ticket 22's parser and the stored diff (F-027, F-072), on patches as GitHub's compare sends them:
// no `diff --git` header, hunks only; a binary file or an unchanged rename has no patch.

/** A modified file: two hunks, one with a section heading. */
const MODIFIED = [
  "@@ -1,4 +1,5 @@",
  " # ostra",
  "-An old line",
  "+A new line",
  "+Another new line",
  " ",
  " ## Install",
  "@@ -20,3 +21,3 @@ function run() {",
  "   const a = 1;",
  "-  return a;",
  "+  return a + 1;",
  " }",
].join("\n");

/** A new file whose last line has no newline. */
const ADDED_NO_NEWLINE = ["@@ -0,0 +1,2 @@", "+first", "+second", "\\ No newline at end of file"].join("\n");

/** A change to a file's last line, where the old one had no newline at the end. */
const LAST_LINE = ["@@ -3 +3 @@", "-end", "\\ No newline at end of file", "+end", ""].join("\n");

const file = (path: string, patch: string | null, extra: Partial<CompareFile> = {}): CompareFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
  truncated: false,
  ...extra,
});

const compare = (files: readonly CompareFile[], extra: Partial<CompareResult> = {}): CompareResult => ({
  aheadBy: 2,
  behindBy: 0,
  mergeBase: "b".repeat(40),
  files,
  filesTruncated: false,
  limits: { maxFiles: 300, maxPatchBytes: 1_000_000 },
  ...extra,
});

describe("the unified-diff parser", () => {
  it("F-027/c1: reads a GitHub patch into hunks, with each line's old and new numbers", () => {
    const parsed = parseUnifiedDiff(MODIFIED);
    expect(parsed.hunks).toHaveLength(2);
    const [first, second] = parsed.hunks;
    expect(first?.oldStart).toBe(1);
    expect(first?.newLines).toBe(5);
    expect(first?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
    expect(second?.header).toBe("@@ -20,3 +21,3 @@ function run() {");
    expect(second?.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ["context", 20, 21, "  const a = 1;"],
      ["del", 21, null, "  return a;"],
      ["add", null, 22, "  return a + 1;"],
      ["context", 22, 23, "}"],
    ]);
    expect(lineAt(parsed, "new", 22)?.text).toBe("  return a + 1;");
    expect(lineAt(parsed, "old", 2)?.kind).toBe("del");
    // Line 10 of the new file is between the hunks: the diff doesn't show it.
    expect(lineAt(parsed, "new", 10)).toBeNull();
  });

  it("F-027: a new file's patch, a missing newline at the end, and a header without counts", () => {
    const added = parseUnifiedDiff(ADDED_NO_NEWLINE);
    expect(added.hunks[0]?.lines.map((line) => [line.kind, line.newLine])).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
    expect(added.newNoNewlineAtEnd).toBe(true);
    expect(added.oldNoNewlineAtEnd).toBe(false);
    const last = parseUnifiedDiff(LAST_LINE);
    expect(last.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(last.hunks[0]?.lines.map((line) => line.kind)).toEqual(["del", "add"]);
    expect(last.oldNoNewlineAtEnd).toBe(true);
    expect(last.newNoNewlineAtEnd).toBe(false);
  });

  it("F-027: a binary file or a rename with no change has no hunks, and a git header is skipped", () => {
    expect(parseUnifiedDiff(null).hunks).toEqual([]);
    expect(parseUnifiedDiff("").hunks).toEqual([]);
    const withHeader = parseUnifiedDiff(["diff --git a/x b/y", "similarity index 90%", "rename from x", "rename to y", "--- a/x", "+++ b/y", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
    expect(withHeader.hunks).toHaveLength(1);
    expect(withHeader.hunks[0]?.lines.map((line) => line.text)).toEqual(["a", "b"]);
    // Windows line endings don't leak into the text.
    expect(parseUnifiedDiff("@@ -1 +1 @@\r\n-a\r\n+b\r\n").hunks[0]?.lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  it("F-072: quotes the commented line and the lines above it on the same side", () => {
    const parsed = parseUnifiedDiff(MODIFIED);
    expect(quotedLines(parsed, "new", 3)).toBe(" # ostra\n+A new line\n+Another new line");
    expect(quotedLines(parsed, "old", 2, 1)).toBe(" # ostra\n-An old line");
    expect(quotedLines(parsed, "new", 99)).toBe("");
  });
});

describe("the stored diff", () => {
  it("F-027: files past OSTRA_DIFF_MAX_FILES and patches past OSTRA_DIFF_MAX_PATCH_KIB are kept as too large, with the host's link", () => {
    const big = `@@ -1 +1 @@\n-${"x".repeat(2000)}\n+${"y".repeat(2000)}`;
    const stored = toStoredDiff(compare([file("a.ts", MODIFIED), file("big.ts", big), file("c.ts", MODIFIED), file("cut.ts", "@@ -1 +1 @@\n-a\n+b", { truncated: true })]), {
      headSha: "c".repeat(40),
      hostUrl: "https://github.example/o/r/pull/1/files",
      limits: { maxFiles: 3, maxPatchBytes: 1024 },
    });
    expect(stored.files.map((entry) => [entry.path, entry.tooLarge, entry.patch === null])).toEqual([
      ["a.ts", false, false],
      ["big.ts", true, true],
      ["c.ts", false, false],
      ["cut.ts", true, true],
    ]);
    expect(stored.filesTruncated).toBe(true);
    expect(stored.hostUrl).toBe("https://github.example/o/r/pull/1/files");
    // What's stored reads back; a row of another shape doesn't, and is fetched again.
    expect(readStoredDiff(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readStoredDiff({ ...stored, version: 2 })).toBeNull();
    const fits = toStoredDiff(compare([file("a.ts", MODIFIED)]), { headSha: "c".repeat(40), hostUrl: null, limits: { maxFiles: 3, maxPatchBytes: 1024 } });
    expect(fits.filesTruncated).toBe(false);
  });

  it("F-072: a comment on a line that changed is outdated, and one on an untouched line isn't", () => {
    const limits = { maxFiles: 300, maxPatchBytes: 1_000_000 };
    const written = toStoredDiff(compare([file("a.ts", MODIFIED)]), { headSha: "1".repeat(40), hostUrl: null, limits });
    // The next head rewrote line 22 and left line 2 as it was.
    const changed = MODIFIED.replace("+  return a + 1;", "+  return a + 2;");
    const latest = toStoredDiff(compare([file("a.ts", changed)]), { headSha: "2".repeat(40), hostUrl: null, limits });
    expect(diffLineAt(latest, "a.ts", "new", 22)?.text).toBe("  return a + 2;");
    expect(commentStillMatches({ path: "a.ts", side: "new", line: 22 }, written, latest)).toBe(false);
    expect(commentStillMatches({ path: "a.ts", side: "new", line: 2 }, written, latest)).toBe(true);
    // A file the new head reverted leaves the diff, and its comments are outdated.
    const reverted = toStoredDiff(compare([]), { headSha: "3".repeat(40), hostUrl: null, limits });
    expect(commentStillMatches({ path: "a.ts", side: "new", line: 2 }, written, reverted)).toBe(false);
  });
});
