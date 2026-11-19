import { projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { actionKey, activityParts, amberRow, formatSpend, reasonParts, summaryText } from "./home-words";
import type { NeedsYouDetail, NeedsYouRow } from "./home-words";

const row = (id: string, detail: NeedsYouDetail, since: number): NeedsYouRow => ({
  taskId: taskIdSchema.parse(id),
  key: id.slice(0, 8),
  title: "A task",
  project: { id: projectIdSchema.parse("p-1"), name: "calculator" },
  detail,
  since,
});

const text = (parts: readonly { readonly text: string }[]): string => parts.map((part) => part.text).join("");

describe("reasonParts", () => {
  it("sets an approval's command in mono", () => {
    expect(reasonParts({ reason: "approval", command: "pnpm add p-retry" })).toEqual([{ text: "Approval: " }, { text: "pnpm add p-retry", code: true }]);
  });

  it("words each reason, with a fallback when the detail is missing", () => {
    expect(text(reasonParts({ reason: "question", question: "Keep the old share API?" }))).toBe("Question: Keep the old share API?");
    expect(text(reasonParts({ reason: "question", question: null }))).toBe("The agent asked a question");
    expect(text(reasonParts({ reason: "draft_ready", prNumber: 2213 }))).toBe("Draft PR #2213 ready");
    expect(text(reasonParts({ reason: "setup_failed", exitCode: 1 }))).toBe("Setup failed: exited 1");
    expect(text(reasonParts({ reason: "stalled", minutes: 12 }))).toBe("No progress for 12 min");
  });
});

describe("actionKey", () => {
  it("answers each reason with its one action", () => {
    expect(actionKey("approval")).toBe("home.action.approve");
    expect(actionKey("question")).toBe("home.action.answer");
    expect(actionKey("draft_ready")).toBe("home.action.reviewPr");
    expect(actionKey("crashed")).toBe("home.action.openTask");
  });
});

describe("amberRow", () => {
  it("is the approval that has waited longest, and nothing without one", () => {
    const rows = [
      row("t-new", { reason: "approval", command: null }, 300),
      row("t-q", { reason: "question", question: null }, 100),
      row("t-old", { reason: "approval", command: null }, 200),
    ];
    expect(amberRow(rows)).toBe("t-old");
    expect(amberRow([rows[1] ?? row("x", { reason: "crashed" }, 0)])).toBeNull();
  });
});

describe("activityParts", () => {
  it("sets a stopped task's key in mono, with its reason", () => {
    expect(activityParts({ kind: "task.stopped", key: "CALC-139", reason: "spend_cap", taskId: taskIdSchema.parse("t") })).toEqual([
      { text: "CALC-139", code: true },
      { text: " stopped: spend cap reached" },
    ]);
  });

  it("names a runner and its pool in mono", () => {
    expect(activityParts({ kind: "runner.registered", runner: "build-17", pool: "build-fleet" })).toEqual([
      { text: "Runner " },
      { text: "build-17", code: true },
      { text: " joined " },
      { text: "build-fleet", code: true },
    ]);
  });
});

describe("the heading and figures", () => {
  it("says the counts in one sentence, with plurals", () => {
    expect(summaryText({ running: 1, projects: 2, queued: 0, prsToday: 3 })).toBe("1 task running across 2 projects, 0 queued. 3 pull requests opened today.");
  });

  it("formats spend in whole dollars, cents under $10, and a dash for none", () => {
    expect(formatSpend(1104.4)).toBe("$1,104");
    expect(formatSpend(4.5)).toBe("$4.50");
    expect(formatSpend(null)).toBe("–");
  });
});
