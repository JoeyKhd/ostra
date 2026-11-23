import { gitShaSchema, memberIdSchema, repoIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { aiReviewWords, capBody, capOf, findingStateWords, findingsSentWords, findingsSummary, prCiRow, reviewRunningText, viewerReview } from "./review-words";

// F-035, F-101, F-102 (ticket 35): the review loop's words, each on its own. Milestone 10 (ticket 17)
// dropped the stage strip: the loop's stage is the status line's sub-state and the Checks tab's
// marker, and the round line's dot speaks to a reviewer still to review; the cap's words name the
// cap the task stopped at.

const limits = { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 };

describe("the review loop's words (ticket 35)", () => {
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

  it("F-102/c1: a resolved finding says its round, and a review running on a new head says which head and whose findings show", () => {
    expect(findingStateWords({ state: "resolved", resolvedInRound: 2 })).toBe("Resolved in round 2");
    expect(findingStateWords({ state: "resolved", resolvedInRound: null })).toBe("Resolved");
    expect(findingStateWords({ state: "open", resolvedInRound: null })).toBe("Open");
    const repo = repoIdSchema.parse("01900000-0000-7000-8000-0000000000a1");
    const other = repoIdSchema.parse("01900000-0000-7000-8000-0000000000a2");
    const head = (sha: string) => [{ repoId: repo, headSha: gitShaSchema.parse(sha.repeat(40 / sha.length)) }];
    const runs = [
      { round: 1, state: "posted" as const, heads: head("a1") },
      { round: 2, state: "posted" as const, heads: head("b2") },
      { round: 3, state: "running" as const, heads: head("3f9c21a0") },
    ];
    expect(reviewRunningText(runs, repo)).toBe("A new review is running on 3f9c21a. These findings are from round 2.");
    // Not on this PR's repo, nothing running, or nothing finished before it: no line.
    expect(reviewRunningText(runs, other)).toBeNull();
    expect(reviewRunningText(runs.slice(0, 2), repo)).toBeNull();
    expect(reviewRunningText(runs.slice(2), repo)).toBeNull();
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

  it("F-151/c6: the review screen's CI row counts the code host's CI in jobs, and a failure names its failing jobs", () => {
    const job = (name: string, conclusion: string | null) => ({ name, conclusion });
    const passed = { state: "passed" as const, checks: [job("build", "success"), job("lint", "success"), job("e2e", "skipped")], completedAt: 1 };
    expect(prCiRow(passed)).toEqual({ mark: "passed", words: "Passed · 3 jobs" });
    expect(prCiRow({ ...passed, checks: [job("build", "success")] }).words).toBe("Passed · 1 job");
    expect(prCiRow({ state: "failed", checks: [job("build", "success"), job("e2e", "failure"), job("lint", "timed_out"), job("docs", null)], completedAt: 1 })).toEqual({ mark: "failed", words: "Failed · e2e, lint" });
    expect(prCiRow({ state: "pending", checks: [job("build", null)], completedAt: null })).toEqual({ mark: "running", words: "Running · 0 of 1 job" });
    expect(prCiRow({ state: "pending", checks: [], completedAt: null })).toEqual({ mark: "running", words: "CI running" });
    expect([prCiRow(null), prCiRow({ state: "none", checks: [], completedAt: null }), prCiRow({ state: "timed_out", checks: [], completedAt: null })]).toEqual([
      { mark: "quiet", words: "No CI" },
      { mark: "quiet", words: "No CI" },
      { mark: "quiet", words: "CI timed out" },
    ]);
  });
});
