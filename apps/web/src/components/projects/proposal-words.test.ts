import { repoIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { editedProposal, lineDiff } from "./proposal-words";

// F-113 (ticket 36): the proposal's setup script as a diff against the saved one, and the proposal
// an admin's edits make for "Edit and accept".

describe("the environment proposal's words (ticket 36)", () => {
  it("F-113/c2: the setup script's diff marks the added and removed lines and folds a long unchanged run", () => {
    expect(lineDiff("make bootstrap", "corepack enable\nmake bootstrap\npnpm install")).toEqual([
      { sign: "+", text: "corepack enable" },
      { sign: " ", text: "make bootstrap" },
      { sign: "+", text: "pnpm install" },
    ]);
    expect(lineDiff("npm ci", "pnpm install")).toEqual([
      { sign: "-", text: "npm ci" },
      { sign: "+", text: "pnpm install" },
    ]);
    expect(lineDiff(null, "pnpm install")).toEqual([{ sign: "+", text: "pnpm install" }]);
    const long = ["a", "b", "c", "d", "e", "f"].join("\n");
    expect(lineDiff(`x\n${long}\ny`, `x2\n${long}\ny2`).filter((row) => row.sign === "fold")).toEqual([{ sign: "fold", lines: 4 }]);
  });

  it("F-113/c2: Edit and accept sends the proposal with the admin's script and commands, and the rest as proposed", () => {
    const repoId = repoIdSchema.parse("r1");
    const body = {
      repos: [{ repoId, setupScript: "pnpm install", checks: [{ name: "test", command: "pnpm test", timeoutSeconds: 600 }], variableNames: ["DATABASE_URL"] }],
      services: [],
      notes: "Added the test check.",
    };
    const edited = editedProposal(body, new Map([[repoId, { setupScript: "corepack enable\npnpm install", commands: new Map([["test", "pnpm test --run"]]) }]]));
    expect(edited.repos[0]).toEqual({ repoId, setupScript: "corepack enable\npnpm install", checks: [{ name: "test", command: "pnpm test --run", timeoutSeconds: 600 }], variableNames: ["DATABASE_URL"] });
    expect(editedProposal(body, new Map())).toEqual(body);
  });
});
