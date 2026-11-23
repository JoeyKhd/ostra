import { describe, expect, it } from "vitest";

import { diffParts } from "./environment-repo-draft";

// environment-repo-draft.md: the diff block shows every added line with one unchanged line of
// context on each side, and folds a longer run of unchanged lines into one row that opens it.

const same = (text: string) => ({ kind: "same" as const, text });
const add = (text: string) => ({ kind: "add" as const, text });

describe("a new repo's draft's diff", () => {
  it("folds the unchanged run before the new branch, keeping one line of context on each side", () => {
    const lines = [...Array.from({ length: 11 }, (_, i) => same(`line ${String(i + 1)}`)), add("  'acme/engine')"), add("    uv sync --frozen"), add("    ;;"), same("esac")];
    expect(diffParts(lines)).toEqual([
      { kind: "fold", id: 0, lines: lines.slice(0, 10) },
      { kind: "lines", lines: lines.slice(10) },
    ]);
  });

  it("shows a short run whole: folding one line would save nothing", () => {
    const lines = [add("case"), same("a"), same("b"), same("c"), add(";;")];
    expect(diffParts(lines)).toEqual([{ kind: "lines", lines }]);
  });
});
