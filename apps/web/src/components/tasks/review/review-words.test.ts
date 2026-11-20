import { memberIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { aiReviewWords, capBody, capOf, findingsSentWords, findingsSummary, stagesOf, viewerReview } from "./review-words";

// F-035, F-101, F-102 (ticket 35): the review loop's words, each on its own. The stage line marks a
// stage done only when it happened in this pass, the round line's dot speaks to a reviewer still to
// review, and the cap's words name the cap the task stopped at.

const limits = { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 };

describe("the review loop's words (ticket 35)", () => {
  it("F-101/c3: the stage line marks the current stage, the stages that happened this pass done, and the rest ahead", () => {
    const fixingFindings = stagesOf({ subState: "fixing_findings", aiReview: true, ci: { used: 0, limit: 2 }, review: { used: 1, limit: 2 } });
    expect(fixingFindings.map((stage) => [stage.words, stage.state])).toEqual([
      ["CI running", "done"],
      ["Fixing CI", "ahead"],
      ["AI review", "done"],
      ["Fixing findings 1 of 2", "current"],
      ["Waiting for a reviewer", "ahead"],
    ]);
    // With the AI review off, its two stages aren't drawn.
    expect(stagesOf({ subState: "waiting_for_reviewer", aiReview: false, ci: { used: 2, limit: 2 }, review: { used: 0, limit: 2 } }).map((stage) => [stage.words, stage.state])).toEqual([
      ["CI running", "done"],
      ["Fixing CI 2 of 2", "done"],
      ["Waiting for a reviewer", "current"],
    ]);
  });

  it("F-102/c1: the round line's dot is the viewer's own review: amber to review, green once approved, else anyone's wait", () => {
    const me = memberIdSchema.parse("m1");
    const reviewers = (state: string | null) => [{ state: "pr_open" as const, reviewers: [{ login: "alex", team: null, member: { memberId: me, name: "Alex" }, source: "codeowners" as const, state }] }];
    expect(viewerReview(reviewers("commented"), "m1")).toBe("to-review");
    expect(viewerReview(reviewers("approved"), "m1")).toBe("approved");
    expect(viewerReview(reviewers(null), "m2")).toBe("other");
    expect(aiReviewWords(false, [])).toBe("AI review off");
    expect(aiReviewWords(true, [{ round: 2, state: "posted", blocking: 0 }])).toBe("AI review round 2: nothing blocking");
    expect(aiReviewWords(true, [{ round: 1, state: "posted", blocking: 1 }, { round: 2, state: "running", blocking: 0 }])).toBe("AI review running");
    expect(findingsSummary(true, [{ state: "open", severity: "nit" }, { state: "resolved", severity: "blocking" }])).toBe("1 nit open · 1 resolved");
  });

  it("F-101/c4: a findings round names the blocking findings it sent and lists the nits; the cap names its limit", () => {
    expect(findingsSentWords([{ title: "Escape the name", severity: "blocking" }, { title: "An unused import", severity: "nit" }])).toBe(
      "Sent 1 blocking finding: Escape the name. 1 nit listed, not required.",
    );
    expect(capOf([{ kind: "ci", state: "started", cappedReason: null }, { kind: "ci", state: "capped", cappedReason: "rounds" }])).toBe("ci");
    expect(capOf([{ kind: "findings", state: "capped", cappedReason: "automatic-turns" }])).toBe("turns");
    expect(capOf([{ kind: "ci", state: "started", cappedReason: null }])).toBeNull();
    expect(capBody("ci", { agent: "OpenCode", limits, failing: "test", blocking: 0 })).toBe("CI failed after 2 rounds, so ostra stopped sending it back to OpenCode. test still fails.");
  });
});
