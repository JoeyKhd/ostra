import { describe, expect, it } from "vitest";

import type { TicketStatusCategory, TrackerStatus } from "./base.ts";
import { MAX_ROUTE_STEPS, mergeWorkflows, reachability, routeTo, transitionsTaken } from "./workflow.ts";
import type { TrackerWorkflow, WorkflowTransition } from "./workflow.ts";

// Milestone 11 (F-008/c5, spec section 5.2, Q352): the shortest route of at most three transitions,
// a global transition one step from anywhere, never through a done or cancelled status on the
// way; and, per status, how it reaches a target, or that it can't.

const status = (id: string, name: string, category: TicketStatusCategory, position: number): TrackerStatus => ({ id, name, category, vendorType: category, position });

const statuses = [
  status("todo", "To Do", "open", 0),
  status("doing", "In Progress", "started", 1),
  status("review", "In Review", "started", 2),
  status("blocked", "Blocked", "started", 3),
  status("qa", "QA", "started", 4),
  status("done", "Done", "done", 5),
  status("wont", "Won't Do", "cancelled", 6),
  status("stuck", "Stuck", "started", 7),
];

const t = (id: string, name: string, from: readonly string[] | "any", to: string): WorkflowTransition => ({ id, name, from, to });

// To Do → In Progress → In Review → QA → Done, review back to progress (a loop), Blocked to and
// from In Progress, Won't Do from anywhere (global), reopen from Done and Won't Do, and a Stuck
// status no transition leaves: a dead end.
const workflow: TrackerWorkflow = {
  readable: true,
  statuses,
  transitions: [
    t("11", "Start", ["todo"], "doing"),
    t("21", "Review", ["doing"], "review"),
    t("31", "Back to work", ["review"], "doing"),
    t("41", "To QA", ["review"], "qa"),
    t("51", "Ship", ["qa"], "done"),
    t("61", "Won't do", "any", "wont"),
    t("71", "Reopen", ["done", "wont"], "todo"),
    t("81", "Block", ["doing"], "blocked"),
    t("91", "Unblock", ["blocked"], "doing"),
    t("95", "Get stuck", ["blocked"], "stuck"),
  ],
};

const names = (route: readonly WorkflowTransition[] | null): readonly string[] | null => route?.map((transition) => transition.name) ?? null;

describe("routeTo", () => {
  it("F-008/c5: finds the shortest route of transitions, a two-step one in order, and nothing for the status a ticket is in", () => {
    expect(names(routeTo(workflow, "todo", "doing"))).toEqual(["Start"]);
    expect(names(routeTo(workflow, "todo", "review"))).toEqual(["Start", "Review"]);
    expect(names(routeTo(workflow, "blocked", "review"))).toEqual(["Unblock", "Review"]);
    expect(names(routeTo(workflow, "todo", "qa"))).toEqual(["Start", "Review", "To QA"]);
    expect(routeTo(workflow, "review", "review")).toEqual([]);
    // Through the loop (review → progress → review), never round it.
    expect(names(routeTo(workflow, "review", "blocked"))).toEqual(["Back to work", "Block"]);
  });

  it("F-008/c5: a global transition is one step from anywhere, and a transition to where the ticket is isn't a step", () => {
    for (const from of ["todo", "doing", "review", "blocked", "qa", "stuck", "done"]) {
      expect(names(routeTo(workflow, from, "wont")), from).toEqual(["Won't do"]);
    }
    expect(routeTo(workflow, "wont", "wont")).toEqual([]);
  });

  it("F-008/c5: stops at three transitions: four is no route, unless the caller allows more", () => {
    expect(MAX_ROUTE_STEPS).toBe(3);
    expect(routeTo(workflow, "todo", "done")).toBeNull();
    expect(names(routeTo(workflow, "todo", "done", 4))).toEqual(["Start", "Review", "To QA", "Ship"]);
    expect(names(routeTo(workflow, "done", "doing"))).toEqual(["Reopen", "Start"]);
  });

  it("F-008/c5: never passes through a done or cancelled status on its way, and a dead end reaches nothing but the global", () => {
    // Won't do then Reopen would reach To Do from In Review in two; a move never closes a ticket on the way.
    expect(routeTo(workflow, "review", "todo")).toBeNull();
    // From a closed status, leaving it is fine.
    expect(names(routeTo(workflow, "wont", "doing"))).toEqual(["Reopen", "Start"]);
    expect(routeTo(workflow, "stuck", "review")).toBeNull();
    expect(names(routeTo(workflow, "stuck", "wont"))).toEqual(["Won't do"]);
    // A status the workflow doesn't have is reached by nothing.
    expect(routeTo(workflow, "todo", "nowhere")).toBeNull();
  });
});

describe("reachability", () => {
  it("F-008/c5: says per status, in the workflow's order, its route's first transition and length, or that it can't reach the target", () => {
    const reach = reachability(workflow, "review");
    expect(reach.map(({ status: one, reach: how }) => [one.id, how.kind === "route" ? `${how.first.name} (${String(how.steps)})` : how.kind])).toEqual([
      ["todo", "Start (2)"],
      ["doing", "Review (1)"],
      ["review", "here"],
      ["blocked", "Unblock (2)"],
      ["qa", "unreachable"],
      ["done", "Reopen (3)"],
      ["wont", "Reopen (3)"],
      ["stuck", "unreachable"],
    ]);
    // A global target is one step from everywhere but itself.
    expect(reachability(workflow, "wont").filter(({ reach: how }) => how.kind === "route" && how.steps === 1)).toHaveLength(statuses.length - 1);
  });
});

describe("mergeWorkflows", () => {
  it("F-008/c5: joins issue types' workflows, every status once and every transition once per (from, to, name), readable only if each is", () => {
    const task: TrackerWorkflow = { readable: true, statuses: statuses.slice(0, 3), transitions: [t("11", "Start", ["todo"], "doing"), t("21", "Review", ["doing"], "review")] };
    const bug: TrackerWorkflow = {
      readable: true,
      statuses: statuses.slice(1, 4),
      transitions: [t("7", "Start", ["todo"], "doing"), t("21", "Review", ["doing"], "review"), t("81", "Block", ["doing"], "blocked")],
    };
    const merged = mergeWorkflows([task, bug]);
    expect(merged.readable).toBe(true);
    expect(merged.statuses.map((one) => one.id)).toEqual(["todo", "doing", "review", "blocked"]);
    expect(merged.transitions.map((transition) => `${transition.id} ${transition.name}`)).toEqual(["11 Start", "21 Review", "81 Block"]);
    expect(mergeWorkflows([task, { ...bug, readable: false }]).readable).toBe(false);
    expect(transitionsTaken(merged.transitions.slice(0, 2))).toEqual([
      { id: "11", name: "Start" },
      { id: "21", name: "Review" },
    ]);
  });
});
