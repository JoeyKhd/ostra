import { describe, expect, it } from "vitest";

import type { SubagentNode, SubagentTree } from "@ostra/task-view";

import { badgeName, badgeState, badgeStateText, cardName, descendantCount, durationWords, initialSelection, nodeLine, shortDuration, subagentCount, subagentLabel } from "./subagent-words";

// F-138: the subagents' words (task-subagents-tree.md): the badge's count and the one state that
// matters most, the cards' lines and their names for a reader, and where the window opens.

const node = (id: string, patch: Partial<SubagentNode> = {}): SubagentNode => ({
  id,
  parentId: null,
  depth: 1,
  type: "explore",
  description: "Find the version source",
  state: "done",
  startedAt: 1_000,
  endedAt: 73_000,
  startedBy: `call-${id}`,
  rounds: [],
  callCount: 14,
  children: [],
  orphan: false,
  ...patch,
});

const tree = (nodes: readonly SubagentNode[]): SubagentTree => {
  const count = (state: SubagentNode["state"]) => nodes.filter((one) => one.state === state).length;
  return { nodes, rootCalls: 3, counts: { total: nodes.length, running: count("running"), needsApproval: count("needs-approval"), failed: count("failed"), stopped: count("stopped"), done: count("done") } };
};

describe("the subagents' words (F-138)", () => {
  it("F-138/c2: the badge reads the count, nested ones included, then approval, failure, running or stopped, in that order", () => {
    const four = tree([node("a"), node("b"), node("c", { state: "running" }), node("d", { parentId: "c", depth: 2 })]);
    expect(subagentCount(4)).toBe("4 subagents");
    expect(subagentCount(1)).toBe("1 subagent");
    expect(badgeName(four.counts)).toBe("4 subagents, 1 running");
    const failing = tree([node("a", { state: "failed" }), node("b", { state: "running" })]);
    expect(badgeState(failing.counts)).toEqual({ state: "failed", n: 1 });
    const asking = tree([node("a", { state: "failed" }), node("b", { state: "needs-approval" }), node("c", { state: "needs-approval" })]);
    expect(badgeStateText({ state: "needs-approval", n: 1 })).toBe("1 needs approval");
    expect(badgeName(asking.counts)).toBe("3 subagents, 2 need approval");
    expect(badgeName(tree([node("a"), node("b")]).counts)).toBe("2 subagents");
    expect(badgeName(tree([node("a", { state: "stopped" })]).counts)).toBe("1 subagent, 1 stopped");
  });

  it("F-138: a node's line and its name for a reader; a running one's time is live", () => {
    expect(nodeLine(node("a"), 0)).toBe("explore · 1m 12s · 14 calls");
    expect(nodeLine(node("a", { state: "running", endedAt: null, callCount: 1 }), 32_000)).toBe("explore · 31s · 1 call");
    expect(cardName(node("a"), 0)).toBe("explore subagent, Find the version source, done, 1 minute 12 seconds, 14 calls");
    expect(subagentLabel(node("a"))).toBe("explore · Find the version source");
    expect(shortDuration(124_000)).toBe("2m 04s");
    expect(shortDuration(3_725_000)).toBe("1h 02m");
    expect(durationWords(61_000)).toBe("1 minute 1 second");
    expect(durationWords(0)).toBe("0 seconds");
  });

  it("F-138: the window opens on the subagent clicked, else the first that needs approval, else the first running, else the first", () => {
    const nodes = tree([node("a"), node("b", { state: "running" }), node("c", { state: "needs-approval" })]);
    expect(initialSelection(nodes, "a")).toBe("a");
    expect(initialSelection(nodes, null)).toBe("c");
    expect(initialSelection(tree([node("a"), node("b", { state: "running" })]), null)).toBe("b");
    expect(initialSelection(tree([node("a"), node("b")]), "gone")).toBe("a");
    expect(initialSelection(tree([]), null)).toBeNull();
  });

  it("F-138: a folded node counts every subagent below it", () => {
    const nested = tree([node("a", { children: ["b"] }), node("b", { parentId: "a", depth: 2, children: ["c", "d"] }), node("c", { parentId: "b", depth: 3 }), node("d", { parentId: "b", depth: 3 })]);
    expect(descendantCount(nested, "b")).toBe(2);
    expect(descendantCount(nested, "a")).toBe(3);
  });
});
