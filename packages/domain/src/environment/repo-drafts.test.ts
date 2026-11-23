import { describe, expect, it } from "vitest";

import { repoDraftChange, setupLanguageOf, setupScriptFromRepos, setupToolOf } from "./repo-drafts.ts";

// F-113: an onboarding proposal's scripts, one per repo, as the environment's one setup script,
// which every executor runs once in each repo's folder with `OSTRA_REPO` set. The two-repo case
// runs on a real host box in `apps/core/src/onboarding/onboarding.test.ts`.

describe("an accepted proposal's setup script", () => {
  it("F-113/c2: the same script for every repo, as a proposal that keeps the saved one hands it in, stays as it is; one repo's is its own", () => {
    const saved = 'case "$OSTRA_REPO" in\n  \'ostra-test/api\')\n    pnpm install\n    ;;\nesac\n';
    expect(setupScriptFromRepos([{ fullName: "ostra-test/api", setupScript: saved }, { fullName: "ostra-test/web", setupScript: saved }])).toBe(saved);
    expect(setupScriptFromRepos([{ fullName: "ostra-test/api", setupScript: "make bootstrap\n" }])).toBe("make bootstrap\n");
    expect(setupScriptFromRepos([{ fullName: "ostra-test/api", setupScript: null }, { fullName: "ostra-test/web", setupScript: "  \n" }])).toBeNull();
  });

  it("F-113/c2: scripts that differ go under each repo's name, as written, and a repo without one runs nothing", () => {
    expect(
      setupScriptFromRepos([
        { fullName: "ostra-test/api", setupScript: "cat > .npmrc <<'EOF'\nfund=false\nEOF\npnpm install\n\n" },
        { fullName: "ostra-test/docs", setupScript: null },
        { fullName: "ostra-test/o'neil", setupScript: "make" },
      ]),
    ).toBe(["case \"$OSTRA_REPO\" in", "  'ostra-test/api')", "cat > .npmrc <<'EOF'", "fund=false", "EOF", "pnpm install", "    ;;", "  'ostra-test/o'\\''neil')", "make", "    ;;", "esac", ""].join("\n"));
  });
});

// F-112/c1 (Q345 option (b)): what a repo added after the environment was saved would change in
// the saved setup script, worked out from the script as it is now. The use case and its API are
// proved on Postgres in packages/api/src/routers/environment-repo-drafts.test.ts.
describe("a new repo's draft beside the saved setup", () => {
  const saved = ["set -euo pipefail", 'case "$OSTRA_REPO" in', "  'acme/web')", "    pnpm install --frozen-lockfile", "    ;;", "esac", ""].join("\n");

  it("F-112/c1: a case without the repo gains its branch before esac, every other line kept", () => {
    const change = repoDraftChange({ savedScript: saved, fullName: "acme/engine", setupLines: ["uv sync --frozen"], otherRepos: ["acme/web"], waitingRepos: ["acme/mobile"] });
    expect(change).toEqual({
      kind: "case",
      // A repo whose own draft waits had no branch, and still has none: nothing changes for it.
      leftOut: [],
      script: ["set -euo pipefail", 'case "$OSTRA_REPO" in', "  'acme/web')", "    pnpm install --frozen-lockfile", "    ;;", "  'acme/engine')", "    uv sync --frozen", "    ;;", "esac", ""].join("\n"),
      lines: [
        { kind: "same", text: "set -euo pipefail" },
        { kind: "same", text: 'case "$OSTRA_REPO" in' },
        { kind: "same", text: "  'acme/web')" },
        { kind: "same", text: "    pnpm install --frozen-lockfile" },
        { kind: "same", text: "    ;;" },
        { kind: "add", text: "  'acme/engine')" },
        { kind: "add", text: "    uv sync --frozen" },
        { kind: "add", text: "    ;;" },
        { kind: "same", text: "esac" },
      ],
    });
  });

  it("F-112/c1: a plain script becomes a case, the old lines under each repo that ran them and the new lines under the new repo", () => {
    const change = repoDraftChange({ savedScript: "set -euo pipefail\ncorepack enable\npnpm install\n", fullName: "acme/engine", setupLines: ["uv sync --frozen"], otherRepos: ["acme/web", "acme/api"], waitingRepos: [] });
    expect(change.kind).toBe("plain");
    if (change.kind !== "plain") return;
    expect(change.script).toBe(
      ["set -euo pipefail", 'case "$OSTRA_REPO" in', "  'acme/web')", "corepack enable", "pnpm install", "    ;;", "  'acme/api')", "corepack enable", "pnpm install", "    ;;", "  'acme/engine')", "    uv sync --frozen", "    ;;", "esac", ""].join("\n"),
    );
    // The first repo's copy is the saved lines where they were; everything else is added.
    expect(change.lines.filter((line) => line.kind === "same").map((line) => line.text)).toEqual(["set -euo pipefail", "corepack enable", "pnpm install"]);
  });

  it("F-112/c1: nothing to review when the case has the repo's branch or the plain script is detection's lines, and nothing to add when detection found none", () => {
    expect(repoDraftChange({ savedScript: saved, fullName: "acme/web", setupLines: ["pnpm install"], otherRepos: [], waitingRepos: [] })).toEqual({ kind: "settled" });
    expect(repoDraftChange({ savedScript: "set -euo pipefail\ncorepack enable\npnpm install --frozen-lockfile\n", fullName: "acme/two", setupLines: ["corepack enable", "pnpm install --frozen-lockfile"], otherRepos: ["acme/one"], waitingRepos: [] })).toEqual({ kind: "settled" });
    expect(repoDraftChange({ savedScript: saved, fullName: "acme/docs", setupLines: [], otherRepos: ["acme/web"], waitingRepos: [] })).toEqual({ kind: "nothing" });
  });

  it("F-112/c1: a plain script made a case gives no branch to another new repo whose own draft waits to add one, and names it; with no lines saved, nobody loses any", () => {
    const change = repoDraftChange({ savedScript: "corepack enable\npnpm install\n", fullName: "acme/engine", setupLines: ["uv sync --frozen"], otherRepos: ["acme/web", "acme/docs"], waitingRepos: ["acme/mobile"] });
    expect(change).toMatchObject({ kind: "plain", leftOut: ["acme/mobile"] });
    if (change.kind !== "plain") return;
    expect(change.script).toBe(['case "$OSTRA_REPO" in', "  'acme/web')", "corepack enable", "pnpm install", "    ;;", "  'acme/docs')", "corepack enable", "pnpm install", "    ;;", "  'acme/engine')", "    uv sync --frozen", "    ;;", "esac", ""].join("\n"));
    expect(repoDraftChange({ savedScript: "set -euo pipefail\n", fullName: "acme/engine", setupLines: ["uv sync --frozen"], otherRepos: ["acme/web"], waitingRepos: ["acme/mobile"] })).toMatchObject({ kind: "plain", leftOut: [] });
  });

  it("names the tool and the language a setup runs first", () => {
    expect(setupToolOf(["corepack enable", "pnpm install"])).toBe("pnpm");
    expect(setupLanguageOf(["uv sync --frozen"])).toBe("python");
    expect(setupLanguageOf(["make"])).toBeNull();
  });
});
