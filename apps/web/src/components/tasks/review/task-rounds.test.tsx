import { describe, expect, it } from "vitest";

import { repoIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";
import { resultWords } from "@/task/thread/words";

import { releasedHoldText } from "./review-words";
import { statusWithSubState } from "./task-rounds";

// Milestone 6's review follow-ups (ticket 41, F-035, F-101): the task page in review against
// `task-rounds.md`: the status's sub-state, a released hold's line and each round's outcome, its
// turn's push line since milestone 10 (ticket 14; ticket 17 dropped the panel's Head row).

const at = Date.UTC(2026, 10, 20, 10, 34);

describe("the task page in review (task-rounds.md)", () => {
  it("F-101/c3: the status names the stage the review loop is at", () => {
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "ci_running" })).toBe("In review · CI running");
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "fixing_ci" })).toBe("In review · fixing CI");
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "waiting_for_reviewer" })).toBe("In review · waiting for a reviewer");
    expect(statusWithSubState({ state: "running", reason: null, subState: null })).toBe("Running");
  });

  it("F-035/c1: each round's push says how its CI went", () => {
    // A round's push to the open PR is its turn's result line, with CI's verdict once it says.
    const push = { kind: "push" as const, push: { repoId: repoIdSchema.parse("0196f1a0-ca1c-7000-8000-000000000001"), branch: "ostra/calc-192", headSha: "b20e7f31aa".padEnd(40, "0"), ref: "refs/heads/ostra/calc-192", hidden: false, checks: null, firstPr: null } };
    const line = (ci: "passed" | "failed" | "running" | null): string => resultWords(push, t, { later: true, ci }).words.map((segment) => segment.text).join("");
    expect([line("passed"), line("failed"), line("running"), line(null)]).toEqual(["Pushed b20e7f3 · CI passed", "Pushed b20e7f3 · CI failed", "Pushed b20e7f3 · CI running", "Pushed b20e7f3"]);
  });

  it("F-035/c2: a released hold says how long it held, which budget, and what released it", () => {
    expect(releasedHoldText({ heldAt: at, releasedAt: at + 9 * 60_000, scope: "project", releasedByName: "Alex Kim" })).toBe(
      "Held 9 min: the project's budget for November was reached. Released when Alex Kim raised it.",
    );
    expect(releasedHoldText({ heldAt: Date.UTC(2026, 10, 30, 23), releasedAt: Date.UTC(2026, 11, 1, 0, 5), scope: "organization", releasedByName: null })).toBe(
      "Held 1 h: the organization's budget for November was reached. Released when December began.",
    );
    expect(releasedHoldText({ heldAt: at, releasedAt: null, scope: "project", releasedByName: null })).toBeNull();
  });
});
