import { describe, expect, it } from "vitest";

import { setupScriptFromRepos } from "./repo-drafts.ts";

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
