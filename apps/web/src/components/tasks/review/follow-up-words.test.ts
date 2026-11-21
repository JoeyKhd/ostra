import { describe, expect, it } from "vitest";

import { dispatchWaitSchema } from "@ostra/domain";
import { poolIdSchema, taskIdSchema } from "@ostra/protocol";

import type { Reason, WaitContext } from "../task-waiting-words";
import { aiReviewLine, followUpWaitWords, reviewedPrText, reviewResultText } from "./follow-up-words";
import type { AiReview } from "./follow-up-words";

// F-100/c6 (2026-11-21, ADR 0059 amended): what a waiting review says, and how its code task's
// page names the AI review's state. The maintainer saw a review queued for 45 minutes that said
// only "No runner of test1's pools is online with a free slot", and nothing on its code task.

const pool = poolIdSchema.parse("01900000-0000-7000-8000-000000000001");
const context: WaitContext = { project: "test1", poolNames: [], poolName: (poolId) => (poolId === pool ? "default" : ""), personal: null };
const reason = (value: object): Reason => dispatchWaitSchema.parse(value);
const runner = { id: "01900000-0000-7000-8000-0000000000aa", name: "santi-laptop" };
const reviewTaskId = taskIdSchema.parse("01a1f173-8696-70be-a85a-8522396470aa");

describe("a follow-up's words (F-100/c6)", () => {
  it("F-100/c6: a waiting review says where it may run and why none can take it now", () => {
    const waits = (personal: string) => followUpWaitWords(reason({ code: "follow-up-waits", runner, personal }), context);
    expect(waits("busy")).toBe("AI review runs on santi-laptop, the runner its code task ran on, or on one of test1's pools; none is free right now.");
    expect(waits("offline")).toBe("AI review runs on santi-laptop, the runner its code task ran on, or on one of test1's pools. santi-laptop is offline, and no pool runner is free.");
    expect(waits("outdated")).toBe("AI review runs on santi-laptop, the runner its code task ran on, or on one of test1's pools. santi-laptop needs an update to run reviews, and no pool runner is free.");
    expect(waits("not-allowed")).toBe("AI review runs on one of test1's pools: its model provider isn't allowed on personal runners, so it can't use santi-laptop. None is free right now.");
    // With no runner of its member's to use, the pools alone, with their own reason when it says more.
    expect(followUpWaitWords(reason({ code: "no-runner-online" }), context)).toBe("AI review runs on one of test1's pools; none is free right now.");
    expect(followUpWaitWords(reason({ code: "pool-full", poolId: pool }), context)).toBe("AI review runs on one of test1's pools; none is free right now. default is at its cap of boxes.");
    // A wait that isn't for a runner keeps the page's own block.
    expect(followUpWaitWords(reason({ code: "budget-reached", scope: "project" }), context)).toBeNull();
    expect(followUpWaitWords(reason({ code: "no-model" }), context)).toBeNull();
  });

  it("F-100/c6: a review names its PR, and its round's result once it has one", () => {
    expect(reviewedPrText({ repo: "fake-org/test1", number: 14, url: "https://github.com/fake-org/test1/pull/14" })).toBe("PR #14");
    expect(reviewResultText(null)).toBeNull();
    expect(reviewResultText({ round: 1, state: "running", blocking: 0, nits: 0 })).toBeNull();
    expect(reviewResultText({ round: 2, state: "posted", blocking: 0, nits: 3 })).toBe("AI review round 2: nothing blocking");
    expect(reviewResultText({ round: 1, state: "posted", blocking: 2, nits: 0 })).toBe("AI review round 1: 2 blocking");
  });

  it("F-100/c6: the code task's page says its AI review is waiting for a runner, running, or how its round went", () => {
    const review = (state: AiReview["state"], run: AiReview["run"] = { round: 1, state: "running", blocking: 0, nits: 0 }): AiReview => ({ taskId: reviewTaskId, state, run });
    expect(aiReviewLine(review("queued"))).toEqual({ state: "waiting", text: "AI review: waiting for a runner" });
    expect(aiReviewLine(review("preparing"))).toEqual({ state: "running", text: "AI review: running" });
    expect(aiReviewLine(review("running"))).toEqual({ state: "running", text: "AI review: running" });
    expect(aiReviewLine(review("done", { round: 2, state: "posted", blocking: 0, nits: 1 }))).toEqual({ state: "result", text: "AI review round 2: nothing blocking" });
    expect(aiReviewLine(review("done", { round: 1, state: "posted", blocking: 1, nits: 0 }))).toEqual({ state: "result", text: "AI review round 1: 1 blocking" });
    expect(aiReviewLine(review("stopped"))).toEqual({ state: "result", text: "AI review: stopped" });
    expect(aiReviewLine(review("stopped", null))).toBeNull();
  });
});
