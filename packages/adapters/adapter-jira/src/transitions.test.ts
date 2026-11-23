import { describe, expect, it } from "vitest";

import { distancesTo, findTransitionPath, jiraStatusCategory, nextTransition, planMapping } from "./transitions.ts";
import type { AvailableTransition, WorkflowGraph } from "./transitions.ts";

// A Jira workflow as a graph: the way to a status, what a board's mapping reaches, and which of an
// issue's transitions to take next (boards-mixed.md, choice 7).

const graph: WorkflowGraph = {
  name: "Software workflow",
  statuses: [
    { id: "1", name: "Backlog", category: "open" },
    { id: "2", name: "To Do", category: "open" },
    { id: "3", name: "In Progress", category: "started" },
    { id: "4", name: "In Review", category: "started" },
    { id: "5", name: "Blocked", category: "started" },
    { id: "6", name: "Done", category: "done" },
    { id: "7", name: "Won't Do", category: "cancelled" },
  ],
  transitions: [
    { id: "11", name: "Start progress", from: ["1", "2"], to: "3" },
    { id: "21", name: "Ready for review", from: ["3"], to: "4" },
    { id: "31", name: "Back to work", from: ["4"], to: "3" },
    { id: "41", name: "Done", from: ["4"], to: "6" },
    { id: "51", name: "Won't do", from: "any", to: "7" },
    { id: "61", name: "Reopen", from: ["6", "7"], to: "2" },
    { id: "71", name: "Block", from: ["3"], to: "5" },
  ],
};

const status = (id: string) => {
  const found = graph.statuses.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no status ${id}`);
  return found;
};
const available = (...pairs: (readonly [string, string])[]): AvailableTransition[] => pairs.map(([id, to]) => ({ id, name: id, to: status(to) }));

describe("a Jira workflow", () => {
  it("finds the shortest walk to a status, and none to one nothing reaches", () => {
    expect(findTransitionPath(graph, "2", "6")?.map((transition) => transition.name)).toEqual(["Start progress", "Ready for review", "Done"]);
    expect(findTransitionPath(graph, "6", "3")?.map((transition) => transition.name)).toEqual(["Reopen", "Start progress"]);
    // A global transition is taken from anywhere.
    expect(findTransitionPath(graph, "5", "7")?.map((transition) => transition.name)).toEqual(["Won't do"]);
    expect(findTransitionPath(graph, "3", "3")).toEqual([]);
    // Nothing leaves Blocked but Won't do, which a walk never passes through (it would close the
    // ticket on the way), and nothing at all goes back to Backlog.
    expect(findTransitionPath(graph, "5", "4")).toBeNull();
    expect(findTransitionPath(graph, "2", "6")?.some((transition) => transition.to === "7")).toBe(false);
    expect(findTransitionPath(graph, "2", "1")).toBeNull();
  });

  it("counts each status's steps to a target, leaving out the ones that can't reach it", () => {
    const distances = distancesTo(graph, "4");
    // Done and Won't Do reopen to To Do first; Blocked only leaves by Won't Do, which a walk never passes through.
    expect(Object.fromEntries(distances)).toEqual({ "1": 2, "2": 2, "3": 1, "4": 0, "6": 3, "7": 3 });
    expect(distances.has("5")).toBe(false);
  });

  it("plans a board's mapping: the transitions into each target, the way from every status, and a warning where none reaches", () => {
    const [started, inReview, done] = planMapping(graph, { started: "3", inReview: "4", done: "6" });
    expect(started?.direct.map(({ transition, from }) => [transition.name, from])).toEqual([["Start progress", ["1", "2"]], ["Back to work", ["4"]]]);
    expect(inReview?.direct.map(({ transition, from }) => [transition.name, from])).toEqual([["Ready for review", ["3"]]]);
    // No transition reaches In Review from Blocked: a ticket there stays put.
    expect(inReview?.unreachableFrom).toEqual(["5"]);
    expect(inReview?.via.find((step) => step.from === "2")).toMatchObject({ transition: { name: "Start progress" }, steps: 2 });
    expect(done?.unreachableFrom).toEqual(["5"]);
    expect(planMapping(graph, { started: "3", inReview: "4", done: "1" })[2]).toMatchObject({ unknownTarget: false, unreachableFrom: ["2", "3", "4", "5", "6", "7"] });
    expect(planMapping(graph, { started: "3", inReview: "4", done: "99" })[2]?.unknownTarget).toBe(true);
  });

  it("takes the goal first, then the transition with the fewest steps left, never back where it's been", () => {
    const fromToDo = available(["11", "3"], ["51", "7"]);
    expect(nextTransition({ available: fromToDo, goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(["2"]), graph })?.id).toBe("11");
    const fromProgress = available(["21", "4"], ["71", "5"], ["51", "7"]);
    expect(nextTransition({ available: fromProgress, goal: "6", goalCategory: "done", currentCategory: "started", visited: new Set(["2", "3"]), graph })?.id).toBe("21");
    expect(nextTransition({ available: available(["41", "6"], ["31", "3"]), goal: "6", goalCategory: "done", currentCategory: "started", visited: new Set(), graph })?.id).toBe("41");
    // From Blocked only Won't do is open, and it doesn't lead to In Review.
    expect(nextTransition({ available: available(["51", "7"]), goal: "4", goalCategory: "started", currentCategory: "started", visited: new Set(["5"]), graph })).toBeNull();
  });

  it("without the workflow, steps toward the goal's category and never into a final status it didn't ask for", () => {
    const fromToDo = available(["51", "7"], ["11", "3"]);
    expect(nextTransition({ available: fromToDo, goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(["2"]), graph: null })?.id).toBe("11");
    // Won't Do is done-like, but not the goal: a guess never ends a ticket there.
    expect(nextTransition({ available: available(["51", "7"]), goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(), graph: null })).toBeNull();
    // Out of Done, a reopen; anywhere else, never a step away from the goal's category.
    expect(nextTransition({ available: available(["61", "2"]), goal: "3", goalCategory: "started", currentCategory: "done", visited: new Set(["6"]), graph: null })?.id).toBe("61");
    expect(nextTransition({ available: available(["11", "3"]), goal: "1", goalCategory: "open", currentCategory: "open", visited: new Set(["2"]), graph: null })).toBeNull();
    expect(nextTransition({ available: available(["31", "3"], ["71", "5"]), goal: "2", goalCategory: "open", currentCategory: "started", visited: new Set(["4"]), graph: null })?.id).toBe("31");
  });

  it("reads Jira's three categories into ostra's four", () => {
    expect([jiraStatusCategory("new", "To Do"), jiraStatusCategory("indeterminate", "In Progress"), jiraStatusCategory("done", "Done"), jiraStatusCategory("done", "Won't Do"), jiraStatusCategory("done", "Cancelled"), jiraStatusCategory(undefined, "Odd")]).toEqual([
      "open",
      "started",
      "done",
      "cancelled",
      "cancelled",
      "open",
    ]);
  });
});
