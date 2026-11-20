import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { releasedHoldText, roundOutcomeText } from "./review-words";
import { CodeHeadRows, statusWithSubState } from "./task-rounds";

// Milestone 6's review follow-ups (ticket 41, F-035, F-101): the task page in review against
// `task-rounds.md`: the status's sub-state, the Code group's Head and CI, a released hold's line and
// each round's outcome after its card.

const at = Date.UTC(2026, 10, 20, 10, 34);

describe("the task page in review (task-rounds.md)", () => {
  it("F-101/c3: the status names the stage the review loop is at", () => {
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "ci_running" })).toBe("In review · CI running");
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "fixing_ci" })).toBe("In review · fixing CI");
    expect(statusWithSubState({ state: "in_review", reason: null, subState: "waiting_for_reviewer" })).toBe("In review · waiting for a reviewer");
    expect(statusWithSubState({ state: "running", reason: null, subState: null })).toBe("Running");
  });

  it("F-035/c1: the Code group shows the head and its CI, and each round's push and how its CI went", () => {
    const failed = renderToStaticMarkup(<CodeHeadRows headSha="3f9c21ab7e" ci={{ state: "failed", failing: "unit-tests" }} />);
    expect(failed).toContain(">3f9c21a</span>");
    expect(failed).toContain("Failed · unit-tests");
    expect(renderToStaticMarkup(<CodeHeadRows headSha="3f9c21ab7e" ci={{ state: "passed", failing: null }} />)).toContain("Passed");
    expect(renderToStaticMarkup(<CodeHeadRows headSha={null} ci={null} />)).toContain("No CI");
    expect(roundOutcomeText({ kind: "pushed", headSha: "b20e7f31aa", ci: "passed", failing: null }, "OpenCode")).toBe("OpenCode pushed b20e7f3. CI passed.");
    expect(roundOutcomeText({ kind: "pushed", headSha: "b20e7f31aa", ci: "failed", failing: "lint" }, "OpenCode")).toBe("OpenCode pushed b20e7f3. CI failed again: lint.");
    expect(roundOutcomeText({ kind: "pushed", headSha: "b20e7f31aa", ci: "pending", failing: null }, "OpenCode")).toBe("OpenCode pushed b20e7f3.");
    expect(roundOutcomeText({ kind: "no-push", endedAt: at }, "OpenCode")).toBe("The turn ended without a push.");
    expect(roundOutcomeText(null, "OpenCode")).toBeNull();
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
