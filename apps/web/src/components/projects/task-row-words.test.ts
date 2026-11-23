import { memberIdSchema, repoIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { doingNow, ledeCounts, taskMark } from "./task-row-words";
import type { Segment, TaskRow } from "./task-row-words";

const row = (overrides: Partial<TaskRow>): TaskRow => ({
  id: taskIdSchema.parse("01a1f173-8696-70be-a85a-85223964702f"),
  key: "3964702f",
  title: "Add a history panel",
  connection: null,
  kind: "code",
  reviewOf: null,
  state: "running",
  subState: null,
  reason: null,
  needsYouReason: null,
  stoppedReason: null,
  group: "running",
  waiting: null,
  queue: null,
  doing: null,
  runner: { id: runnerIdSchema.parse("01a1f173-0000-7000-8000-000000000001"), name: "alex-mbp", kind: "personal", executor: "host", isolated: false },
  driver: { memberId: memberIdSchema.parse("m-1"), name: "Alex Kim" },
  prs: [],
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const text = (segments: readonly Segment[]): string => segments.map((segment) => segment.text).join("");

describe("doingNow (project.md, States and copy)", () => {
  it("names the approval's command and the question for a task that needs the member", () => {
    const approval = doingNow(row({ state: "needs_you", needsYouReason: "approval", doing: { kind: "approval.requested", detail: "pnpm db:migrate", toolKind: "execute" } }));
    expect(text(approval)).toBe("Approval: pnpm db:migrate");
    expect(approval[1]).toEqual({ text: "pnpm db:migrate", style: "code" });
    const question = doingNow(row({ state: "needs_you", needsYouReason: "question", doing: { kind: "question.asked", detail: "keep the old retry header?", toolKind: null } }));
    expect(text(question)).toBe("Question: keep the old retry header?");
  });

  it("falls back to the reason, then to waiting words, when the event says nothing", () => {
    expect(text(doingNow(row({ state: "needs_you", needsYouReason: "no_changes" })))).toBe("Ended without changes");
    expect(text(doingNow(row({ state: "needs_you", needsYouReason: "approval", doing: { kind: "approval.requested", detail: null, toolKind: null } })))).toBe("Waiting for an approval");
  });

  it("words a running task's tool call as a verb and its command or path in mono", () => {
    expect(doingNow(row({ doing: { kind: "tool.called", detail: "pnpm test percent", toolKind: "execute" } }))).toEqual([
      { text: "Running ", style: "plain" },
      { text: "pnpm test percent", style: "code" },
    ]);
    expect(text(doingNow(row({ doing: { kind: "tool.called", detail: "src/display/format.ts", toolKind: "edit" } })))).toBe("Editing src/display/format.ts");
    expect(text(doingNow(row({ doing: { kind: "tool.called", detail: "README.md", toolKind: "read" } })))).toBe("Reading README.md");
    expect(doingNow(row({ doing: { kind: "tool.called", detail: "subagent", toolKind: null } }))).toEqual([{ text: "subagent", style: "plain" }]);
    expect(text(doingNow(row({ doing: { kind: "agent.thought", detail: null, toolKind: null } })))).toBe("Thinking");
    expect(doingNow(row({ doing: null }))).toEqual([]);
  });

  it("says what a task waits for before and after it runs", () => {
    expect(text(doingNow(row({ state: "preparing" })))).toBe("Preparing · running the setup script");
    expect(text(doingNow(row({ state: "queued", runner: null })))).toBe("Waiting for a runner");
    const review = doingNow(row({ state: "in_review", prs: [{ repoId: repoIdSchema.parse("r-1"), number: 48, url: "https://github.com/acme/calculator/pull/48", state: "pr_open" }] }));
    expect(text(review)).toBe("PR #48 · open");
    expect(review).toContainEqual({ text: "#48", style: "strong" });
    expect(text(doingNow(row({ state: "stopped", stoppedReason: "requested" })))).toBe("Stopped: asked to stop");
    expect(text(doingNow(row({ state: "merged" })))).toBe("Merged");
  });
});

describe("taskMark", () => {
  it("is amber only for what waits on the member", () => {
    expect(taskMark("needs_you")).toBe("amber");
    expect(taskMark("awaiting_approval")).toBe("amber");
    expect(taskMark("running")).toBe("green");
    expect(taskMark("preparing")).toBe("preparing");
    expect(taskMark("in_review")).toBe("review");
  });
});

describe("ledeCounts", () => {
  it("leaves out a count of 0", () => {
    expect(ledeCounts(2, 3)).toEqual(["2 waiting on you", "3 running"]);
    expect(ledeCounts(0, 1)).toEqual(["1 running"]);
    expect(ledeCounts(0, 0)).toEqual([]);
  });
});
