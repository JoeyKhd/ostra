import type { TrackerStatus, TrackerWorkflow } from "@ostra/adapter-sdk";
import { describe, expect, it } from "vitest";

import { jiraStatusCategory, nextTransition, readJiraWorkflows, workflowCategoryKey } from "./transitions.ts";
import type { AvailableTransition, JiraWorkflowsAnswer } from "./transitions.ts";

// Jira's workflows read into the tracker contract's shape, and which of an issue's transitions to
// take next (boards-mixed.md, choice 7). The route itself is `routeTo`, tested in adapter-sdk.

const at = (id: string, name: string, category: TrackerStatus["category"], position: number): TrackerStatus => ({ id, name, category, vendorType: category, position });

const workflow: TrackerWorkflow = {
  readable: true,
  statuses: [
    at("1", "Backlog", "open", 0),
    at("2", "To Do", "open", 1),
    at("3", "In Progress", "started", 2),
    at("4", "In Review", "started", 3),
    at("5", "Blocked", "started", 4),
    at("6", "Done", "done", 5),
    at("7", "Won't Do", "cancelled", 6),
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
  const found = workflow.statuses.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no status ${id}`);
  return found;
};
const available = (...pairs: (readonly [string, string])[]): AvailableTransition[] => pairs.map(([id, to]) => ({ id, name: id, to: status(to) }));

/** The workflows API's answer: statuses by a reference that isn't their ID. */
const answer: JiraWorkflowsAnswer = {
  statuses: [
    { id: "1", name: "To Do", statusCategory: "TODO", statusReference: "ref-todo" },
    { id: "2", name: "In Progress", statusCategory: "IN_PROGRESS", statusReference: "ref-progress" },
    { id: "3", name: "Done", statusCategory: "DONE", statusReference: "ref-done" },
    { id: "4", name: "Won't Do", statusCategory: "DONE", statusReference: "ref-wont" },
  ],
  workflows: [
    {
      name: "Task workflow",
      statuses: [{ statusReference: "ref-todo" }, { statusReference: "ref-progress" }, { statusReference: "ref-done" }, { statusReference: "ref-wont" }],
      transitions: [
        { id: "1", name: "Create", type: "INITIAL", toStatusReference: "ref-todo", links: [] },
        { id: "11", name: "Start", type: "DIRECTED", toStatusReference: "ref-progress", links: [{ fromStatusReference: "ref-todo" }, { fromStatusReference: "ref-todo" }] },
        { id: "21", name: "Finish", type: "DIRECTED", toStatusReference: "ref-done", links: [{ fromStatusReference: "ref-progress" }] },
        { id: "51", name: "Won't do", type: "GLOBAL", toStatusReference: "ref-wont", links: [] },
        // From nowhere the answer names, and to a status it doesn't name: neither can be taken.
        { id: "61", name: "Dangling", type: "DIRECTED", toStatusReference: "ref-done", links: [{ fromStatusReference: "ref-gone" }] },
        { id: "71", name: "Elsewhere", type: "DIRECTED", toStatusReference: "ref-gone", links: [{ fromStatusReference: "ref-todo" }] },
      ],
    },
    {
      name: "Bug workflow",
      statuses: [{ statusReference: "ref-todo" }, { statusReference: "ref-done" }, { statusReference: "ref-wont" }],
      transitions: [
        { id: "81", name: "Fix", type: "DIRECTED", toStatusReference: "ref-done", links: [{ fromStatusReference: "ref-todo" }] },
        // The same as the task workflow's: once in the union.
        { id: "51", name: "Won't do", type: "GLOBAL", toStatusReference: "ref-wont", links: [] },
      ],
    },
  ],
};

describe("a Jira workflow", () => {
  it("F-008/c5: reads the workflows API's answer as one workflow: statuses by reference with their categories, a global transition from any, each transition once", () => {
    const read = readJiraWorkflows(answer, null);
    expect(read.readable).toBe(true);
    expect(read.statuses.map((one) => [one.id, one.name, one.category])).toEqual([
      ["1", "To Do", "open"],
      ["2", "In Progress", "started"],
      ["3", "Done", "done"],
      ["4", "Won't Do", "cancelled"],
    ]);
    expect(read.transitions).toEqual([
      { id: "11", name: "Start", from: ["1"], to: "2" },
      { id: "21", name: "Finish", from: ["2"], to: "3" },
      { id: "51", name: "Won't do", from: "any", to: "4" },
      { id: "81", name: "Fix", from: ["1"], to: "3" },
    ]);
    // Given the board's statuses, they're the workflow's, and transitions stay between them.
    const board = [at("1", "To Do", "open", 0), at("2", "In Progress", "started", 1), at("3", "Done", "done", 2)];
    const onBoard = readJiraWorkflows(answer, board);
    expect(onBoard.statuses).toEqual(board);
    expect(onBoard.transitions.map((transition) => transition.name)).toEqual(["Start", "Finish", "Fix"]);
    expect(readJiraWorkflows({ statuses: [], workflows: [] }, board)).toEqual({ readable: true, statuses: board, transitions: [] });
    expect([workflowCategoryKey("TODO"), workflowCategoryKey("IN_PROGRESS"), workflowCategoryKey("DONE"), workflowCategoryKey("LATER")]).toEqual(["new", "indeterminate", "done", undefined]);
  });

  it("takes the goal first, then the transition with the fewest steps left, never back where it's been", () => {
    const fromToDo = available(["11", "3"], ["51", "7"]);
    expect(nextTransition({ available: fromToDo, goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(["2"]), workflow })?.id).toBe("11");
    const fromProgress = available(["21", "4"], ["71", "5"], ["51", "7"]);
    expect(nextTransition({ available: fromProgress, goal: "6", goalCategory: "done", currentCategory: "started", visited: new Set(["2", "3"]), workflow })?.id).toBe("21");
    expect(nextTransition({ available: available(["41", "6"], ["31", "3"]), goal: "6", goalCategory: "done", currentCategory: "started", visited: new Set(), workflow })?.id).toBe("41");
    // From Blocked only Won't do is open, and it doesn't lead to In Review.
    expect(nextTransition({ available: available(["51", "7"]), goal: "4", goalCategory: "started", currentCategory: "started", visited: new Set(["5"]), workflow })).toBeNull();
    // With one step left, only a transition into the goal will do.
    expect(nextTransition({ available: fromToDo, goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(["2"]), workflow, stepsLeft: 1 })).toBeNull();
  });

  it("without the workflow, steps toward the goal's category and never into a final status it didn't ask for", () => {
    const fromToDo = available(["51", "7"], ["11", "3"]);
    expect(nextTransition({ available: fromToDo, goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(["2"]), workflow: null })?.id).toBe("11");
    // Won't Do is done-like, but not the goal: a guess never ends a ticket there.
    expect(nextTransition({ available: available(["51", "7"]), goal: "6", goalCategory: "done", currentCategory: "open", visited: new Set(), workflow: null })).toBeNull();
    // Out of Done, a reopen; anywhere else, never a step away from the goal's category.
    expect(nextTransition({ available: available(["61", "2"]), goal: "3", goalCategory: "started", currentCategory: "done", visited: new Set(["6"]), workflow: null })?.id).toBe("61");
    expect(nextTransition({ available: available(["11", "3"]), goal: "1", goalCategory: "open", currentCategory: "open", visited: new Set(["2"]), workflow: null })).toBeNull();
    expect(nextTransition({ available: available(["31", "3"], ["71", "5"]), goal: "2", goalCategory: "open", currentCategory: "started", visited: new Set(["4"]), workflow: null })?.id).toBe("31");
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
