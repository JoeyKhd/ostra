import { describe, expect, it } from "vitest";

import { appliedSecretsText, diffParts, leftOutText } from "./environment-repo-draft";

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

describe("a new repo's draft's words for one name and for several", () => {
  it("names the secrets Apply couldn't keep, one or a list", () => {
    expect(appliedSecretsText(["ENGINE_API_KEY"])).toBe("Give the secret `ENGINE_API_KEY` a value in the repo's section, then save: a secret is kept only with one.");
    expect(appliedSecretsText(["A_KEY", "B_KEY", "C_KEY"])).toBe("Give the secrets `A_KEY`, `B_KEY` and `C_KEY` a value each in the repo's section, then save: a secret is kept only with one.");
  });

  it("F-112/c2: names the other new repos a plain script made a case gives no branch, and nothing when there are none", () => {
    expect(leftOutText([])).toBeNull();
    expect(leftOutText(["acme/mobile"])).toBe("Applying this gives `acme/mobile` no branch: its own draft adds one, and until that's applied its tasks set up nothing.");
    expect(leftOutText(["acme/mobile", "acme/cli"])).toBe("Applying this gives `acme/mobile` and `acme/cli` no branch: their own drafts add them, and until those are applied their tasks set up nothing.");
  });
});
