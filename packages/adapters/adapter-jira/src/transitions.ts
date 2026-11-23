import type { StatusMapping, TicketStatusCategory } from "@ostra/adapter-sdk";

// Jira moves an issue only along its workflow's transitions (research/trackers.md §2.4, ADR 0047):
// the same status can't be written directly, and a move can take several steps. This file is the
// pure part: the workflow as a graph, the shortest way to a status, what a board's mapping can and
// can't reach (the Boards page's `by …` lines and warnings, boards-mixed.md, choice 7), and which
// of an issue's available transitions to take next.

/** Jira's three status categories (`statusCategory.key`). */
export type JiraCategoryKey = "new" | "indeterminate" | "done";

/** A status of a workflow, as the mapping shows it. */
export type WorkflowStatus = { readonly id: string; readonly name: string; readonly category: TicketStatusCategory };

/** A transition of a workflow: from these statuses, or from any (`from: "any"`, a global transition). */
export type WorkflowTransition = {
  readonly id: string;
  readonly name: string;
  readonly from: readonly string[] | "any";
  readonly to: string;
};

export type WorkflowGraph = {
  readonly name: string;
  readonly statuses: readonly WorkflowStatus[];
  readonly transitions: readonly WorkflowTransition[];
};

/** Jira's category, in the four ostra shares; a done status named like "won't do" reads as cancelled. */
export const jiraStatusCategory = (key: string | undefined, name: string): TicketStatusCategory => {
  switch (key) {
    case "new":
      return "open";
    case "indeterminate":
      return "started";
    case "done":
      return /won'?t|cancel|declin|reject|duplicate|abandon/i.test(name) ? "cancelled" : "done";
    case undefined:
    default:
      // `undefined` (Jira's "No category") and any key Jira adds later.
      return "open";
  }
};

const takeable = (transition: WorkflowTransition, at: string): boolean =>
  transition.from === "any" || transition.from.includes(at);

const isFinal = (category: TicketStatusCategory): boolean => category === "done" || category === "cancelled";

/**
 * Whether a walk may pass through a status on its way: never a done or cancelled one, so moving a
 * ticket never closes it on the way (a global "Won't do" then "Reopen" reaches anything).
 */
const passable = (graph: WorkflowGraph, id: string): boolean => {
  const status = graph.statuses.find((one) => one.id === id);
  return status === undefined || !isFinal(status.category);
};

/**
 * The shortest walk of transitions from `from` to `to` that passes through no done or cancelled
 * status, or `null` when none reaches it. `[]` when the status is already the goal.
 */
export const findTransitionPath = (graph: WorkflowGraph, from: string, to: string): readonly WorkflowTransition[] | null => {
  if (from === to) return [];
  const previous = new Map<string, { readonly at: string; readonly by: WorkflowTransition }>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const at = queue.shift();
    if (at === undefined) break;
    if (at !== from && !passable(graph, at)) continue;
    for (const transition of graph.transitions) {
      if (!takeable(transition, at) || seen.has(transition.to)) continue;
      seen.add(transition.to);
      previous.set(transition.to, { at, by: transition });
      if (transition.to === to) {
        const path: WorkflowTransition[] = [];
        let step = previous.get(to);
        while (step !== undefined) {
          path.unshift(step.by);
          step = step.at === from ? undefined : previous.get(step.at);
        }
        return path;
      }
      queue.push(transition.to);
    }
  }
  return null;
};

/** How many transitions each status is from `to`, by walks `findTransitionPath` takes; a status that can't reach it is missing. */
export const distancesTo = (graph: WorkflowGraph, to: string): ReadonlyMap<string, number> => {
  const ids = new Set([...graph.statuses.map((status) => status.id), ...graph.transitions.map((transition) => transition.to)]);
  const distances = new Map<string, number>([[to, 0]]);
  // Walk backwards: a status is one further than any status one of its transitions reaches.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (distances.has(id)) continue;
      let best: number | undefined;
      for (const transition of graph.transitions) {
        const there = distances.get(transition.to);
        const through = transition.to === to || passable(graph, transition.to);
        if (there !== undefined && through && takeable(transition, id) && transition.to !== id && (best === undefined || there + 1 < best)) best = there + 1;
      }
      if (best !== undefined) {
        distances.set(id, best);
        changed = true;
      }
    }
  }
  return distances;
};

/** One ostra step, as the mapping shows it on a Jira board. */
export type StepPlan = {
  readonly step: keyof StatusMapping;
  readonly target: string;
  /** The transitions into the target, each from its statuses (`by Start progress, from To Do or Backlog`). */
  readonly direct: readonly { readonly transition: WorkflowTransition; readonly from: readonly string[] | "any" }[];
  /** For every other status, the first transition of the shortest walk there. */
  readonly via: readonly { readonly from: string; readonly transition: WorkflowTransition; readonly steps: number }[];
  /** The statuses from which no walk reaches the target: a ticket there stays put. */
  readonly unreachableFrom: readonly string[];
  /** The target isn't one of the workflow's statuses. */
  readonly unknownTarget: boolean;
};

/** What a board's mapping reaches on one workflow, step by step. */
export const planMapping = (graph: WorkflowGraph, mapping: StatusMapping): readonly StepPlan[] =>
  (["started", "inReview", "done"] as const).map((step) => {
    const target = mapping[step];
    const unknownTarget = !graph.statuses.some((status) => status.id === target);
    const direct = graph.transitions.filter((transition) => transition.to === target).map((transition) => ({ transition, from: transition.from }));
    const via: { readonly from: string; readonly transition: WorkflowTransition; readonly steps: number }[] = [];
    const unreachableFrom: string[] = [];
    for (const status of graph.statuses) {
      if (status.id === target) continue;
      const path = findTransitionPath(graph, status.id, target);
      const first = path?.[0];
      if (path === null || first === undefined) {
        unreachableFrom.push(status.id);
      } else {
        via.push({ from: status.id, transition: first, steps: path.length });
      }
    }
    return { step, target, direct, via, unreachableFrom, unknownTarget };
  });

/** A transition an issue can take now (`GET /issue/{id}/transitions`), in the adapter's terms. */
export type AvailableTransition = { readonly id: string; readonly name: string; readonly to: WorkflowStatus };

const RANK: Readonly<Record<TicketStatusCategory, number>> = { open: 0, started: 1, done: 2, cancelled: 2 };

/**
 * Which of an issue's transitions to take toward `goal`: the goal itself first, and otherwise never
 * a done or cancelled status, nor one the walk has been at. With the workflow, the step that leaves
 * the fewest. Without it (no `read:workflow:jira`), a step toward the goal's category, closest
 * first: a guess, which can stop short where the workflow would have gone round. `null`: no way on.
 */
export const nextTransition = (input: {
  readonly available: readonly AvailableTransition[];
  readonly goal: string;
  readonly goalCategory: TicketStatusCategory | null;
  readonly currentCategory: TicketStatusCategory;
  readonly visited: ReadonlySet<string>;
  readonly graph: WorkflowGraph | null;
}): AvailableTransition | null => {
  const direct = input.available.find((transition) => transition.to.id === input.goal);
  if (direct !== undefined) return direct;
  const usable = input.available.filter((transition) => !input.visited.has(transition.to.id) && !isFinal(transition.to.category));
  if (input.graph !== null) {
    const distances = distancesTo(input.graph, input.goal);
    let best: { readonly transition: AvailableTransition; readonly distance: number } | null = null;
    for (const transition of usable) {
      const distance = distances.get(transition.to.id);
      if (distance !== undefined && (best === null || distance < best.distance)) best = { transition, distance };
    }
    return best?.transition ?? null;
  }
  if (input.goalCategory === null) return null;
  const from = RANK[input.currentCategory];
  const to = RANK[input.goalCategory];
  // Only between here and the goal's category, never away from it; out of a done or cancelled
  // status, any reopen (Jira's reopen goes back to the start).
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const toward = isFinal(input.currentCategory) ? usable : usable.filter((transition) => RANK[transition.to.category] >= low && RANK[transition.to.category] <= high);
  // The step that gets closest to the goal's category, the workflow's order breaking a tie.
  return toward.reduce<AvailableTransition | null>((best, transition) => {
    if (best === null) return transition;
    return Math.abs(RANK[transition.to.category] - to) < Math.abs(RANK[best.to.category] - to) ? transition : best;
  }, null);
};
