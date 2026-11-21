import { describe, expect, it } from "vitest";

import { createTreeCollector, TREE_NOTES_MAX, treeFolderOf, treeLimitsProblem } from "./tree.ts";

// Milestone 8 (ticket 02, F-145): the rules every code host's `readTree` shares. The contract
// suite runs them through each adapter; these are the corners it doesn't reach.

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const wide = { maxFiles: 100, maxBytes: 1024 * 1024 };

/** Feeds entries as an archive would, in the given order, and finishes the tree. */
const collect = (folder: string, entries: readonly (readonly [string, string] | readonly [string, { readonly to: string }])[], limits = wide) => {
  const collector = createTreeCollector(folder, limits);
  for (const [path, entry] of entries) {
    if (typeof entry === "string") {
      if (collector.wants(path, bytes(entry).length)) collector.file(path, "regular", bytes(entry));
    } else {
      collector.symlink(path, entry.to);
    }
    if (collector.full()) break;
  }
  return collector.finish();
};

const paths = (tree: { readonly files: readonly { readonly path: string }[] }): string[] => tree.files.map((file) => file.path);

describe("a tree's folder and caps", () => {
  it("F-145: normalizes a folder, and refuses one that isn't repo-relative", () => {
    expect(treeFolderOf("")).toBe("");
    expect(treeFolderOf(".")).toBe("");
    expect(treeFolderOf("skills/pdf/")).toBe("skills/pdf");
    for (const unsafe of ["/skills", "skills/../x", "..", "a//b", "a/./b", "a\\b", "a\u0000b", "x".repeat(1025)]) {
      expect(treeFolderOf(unsafe), unsafe).toBeNull();
    }
  });

  it("F-145: refuses caps that aren't whole numbers, or no files at all", () => {
    expect(treeLimitsProblem({ maxFiles: 1, maxBytes: 0 })).toBeNull();
    for (const limits of [{ maxFiles: 0, maxBytes: 1 }, { maxFiles: 1.5, maxBytes: 1 }, { maxFiles: 1, maxBytes: -1 }, { maxFiles: Number.NaN, maxBytes: 1 }]) {
      expect(treeLimitsProblem(limits), JSON.stringify(limits)).not.toBeNull();
    }
  });

  it("F-145: takes only what's under the folder, a file named by the folder itself included", () => {
    const tree = collect("skills/pdf", [
      ["skills/pdf", "a file, not a folder"],
      ["skills/pdf/SKILL.md", "# pdf"],
      ["skills/pdf-tools/SKILL.md", "# a sibling with the same prefix"],
      ["skills/other/SKILL.md", "# other"],
    ]);
    expect(paths(tree)).toEqual(["skills/pdf", "skills/pdf/SKILL.md"]);
  });
});

describe("symlinks in a tree", () => {
  it("F-145: follows a link to a folder inside, carrying its files under the link's path", () => {
    const tree = collect("skill", [
      ["skill/docs/a.md", "A"],
      ["skill/docs/b.md", "B"],
      ["skill/guide", { to: "docs" }],
    ]);
    expect(paths(tree)).toEqual(["skill/docs/a.md", "skill/docs/b.md", "skill/guide/a.md", "skill/guide/b.md"]);
    expect(tree.notes).toEqual([]);
  });

  it("F-145: follows a chain of links that stays inside, and refuses one whose hop leaves the folder", () => {
    const tree = collect("skill", [
      ["skill/a.md", { to: "b.md" }],
      ["skill/b.md", { to: "real/c.md" }],
      ["skill/real/c.md", "C"],
      ["skill/out.md", { to: "hop.md" }],
      ["skill/hop.md", { to: "../outside.md" }],
      ["outside.md", "secret"],
    ]);
    expect(paths(tree)).toEqual(["skill/a.md", "skill/b.md", "skill/real/c.md"]);
    expect(new TextDecoder().decode(tree.files[0]?.bytes)).toBe("C");
    expect(tree.notes).toEqual([
      { path: "skill/hop.md", reason: "symlink-outside" },
      { path: "skill/out.md", reason: "symlink-outside" },
    ]);
  });

  it("F-145: never follows an absolute link, one past the repo's root, or one that loops back to a folder holding it", () => {
    const tree = collect("", [
      ["etc", { to: "/etc/passwd" }],
      ["up", { to: "../../secret" }],
      ["skill/self", { to: "." }],
      ["skill/root", { to: ".." }],
      ["skill/ping", { to: "pong" }],
      ["skill/pong", { to: "ping" }],
      ["skill/SKILL.md", "# skill"],
    ]);
    expect(paths(tree)).toEqual(["skill/SKILL.md"]);
    expect(tree.notes.map((note) => [note.path, note.reason])).toEqual([
      ["etc", "symlink-outside"],
      ["skill/ping", "symlink-outside"],
      ["skill/pong", "symlink-outside"],
      ["skill/root", "symlink-outside"],
      ["skill/self", "symlink-outside"],
      ["up", "symlink-outside"],
    ]);
  });

  it("F-145: a link to nothing is dangling, and a link to a file a cap left out says which cap", () => {
    const tree = collect(
      "skill",
      [
        ["skill/big.bin", "x".repeat(50)],
        ["skill/gone.md", { to: "missing.md" }],
        ["skill/small.md", "s"],
        ["skill/to-big", { to: "big.bin" }],
      ],
      { maxFiles: 10, maxBytes: 10 },
    );
    expect(paths(tree)).toEqual(["skill/small.md"]);
    expect(tree.truncated).toBe(true);
    expect(tree.notes).toEqual([
      { path: "skill/big.bin", reason: "over-max-bytes" },
      { path: "skill/gone.md", reason: "symlink-dangling" },
      { path: "skill/to-big", reason: "over-max-bytes" },
    ]);
  });

  it("F-145: a followed link counts against the caps like any file", () => {
    const tree = collect("skill", [["skill/a.md", "A"], ["skill/b.md", { to: "a.md" }]], { maxFiles: 1, maxBytes: 100 });
    expect(paths(tree)).toEqual(["skill/a.md"]);
    expect(tree.truncated).toBe(true);
    expect(tree.notes).toEqual([{ path: "skill/b.md", reason: "over-max-files" }]);
  });
});

describe("the caps", () => {
  it("F-145: stops at the first file past maxFiles, and keeps at most TREE_NOTES_MAX notes", () => {
    const many = Array.from({ length: 300 }, (_, index) => [`repo/link-${String(index).padStart(3, "0")}`, { to: "/abs" }] as const);
    const tree = collect("", [...many, ["a.md", "a"], ["b.md", "b"], ["c.md", "c"]], { maxFiles: 2, maxBytes: 100 });
    expect(paths(tree)).toEqual(["a.md", "b.md"]);
    expect(tree.truncated).toBe(true);
    expect(tree.notes).toHaveLength(TREE_NOTES_MAX);
  });
});
