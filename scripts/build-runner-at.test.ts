import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSteps, defaultBuilds, parseBuildArgs, protocolMinorOf } from "./build-runner-at.ts";

// F-061 (milestone 5's ticket 16): the script that builds milestone 4's and milestone 3's runners
// for the demo's step 10. The build itself (a worktree and an install per milestone) runs in the
// demo; here, its plan.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("build-runner-at (F-061)", () => {
  it("F-061: builds milestone 4's and milestone 3's runners from their refs, each a worktree with its own install, with no shell", () => {
    expect(defaultBuilds).toEqual([
      { name: "milestone-4", ref: "milestone-4" },
      { name: "milestone-3", ref: "milestone-3" },
    ]);
    const parsed = parseBuildArgs(["--ref", "milestone-3=05b2b3a5", "--dry-run"]);
    expect(parsed).toEqual({
      ok: true,
      dryRun: true,
      builds: [
        { name: "milestone-4", ref: "milestone-4" },
        { name: "milestone-3", ref: "05b2b3a5" },
      ],
    });
    const dir = path.join(root, ".ostra-dev", "runner-builds", "milestone-3");
    expect(buildSteps(root, { name: "milestone-3", ref: "05b2b3a5" })).toEqual([
      { command: "git", args: ["rev-parse", "--verify", "--quiet", "05b2b3a5^{commit}"], cwd: root },
      { command: "git", args: ["worktree", "add", "--force", "--detach", dir, "05b2b3a5^{commit}"], cwd: root },
      { command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: dir },
    ]);
    // A ref git could read as an option, or a range, is refused.
    expect(parseBuildArgs(["--ref", "milestone-3=--upload-pack=evil"]).ok).toBe(false);
    expect(parseBuildArgs(["--ref", "milestone-3=a..b"]).ok).toBe(false);
    expect(parseBuildArgs(["--ref", "milestone-9=abc"]).ok).toBe(false);
  });

  it("F-061: reads the protocol minor a build speaks from its source", async () => {
    const today = await readFile(path.join(root, "packages", "protocol", "src", "runner", "version.ts"), "utf8");
    expect(protocolMinorOf(today)).toBe(4);
    expect(protocolMinorOf("export const PROTOCOL_MINOR = 2;")).toBe(2);
    expect(protocolMinorOf("nothing here")).toBeNull();
  });
});
