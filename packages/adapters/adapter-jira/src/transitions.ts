import { MAX_ROUTE_STEPS, mergeWorkflows, routeTo } from "@ostra/adapter-sdk";
import type { TicketStatus, TicketStatusCategory, TrackerStatus, TrackerWorkflow, WorkflowTransition } from "@ostra/adapter-sdk";

import type { JiraWorkflowJson, JiraWorkflowStatusJson } from "./schemas.ts";

// Jira moves an issue only along its workflow's transitions (research/trackers.md §2.4, ADR 0047):
// a status can't be written directly, and a move can take several steps. This file is the pure
// part: Jira's workflows read into the tracker contract's `TrackerWorkflow`, and which of an
// issue's available transitions to take next. The route itself (the shortest way of at most
// `MAX_ROUTE_STEPS`, never through a done or cancelled status) is `routeTo` in `@ostra/adapter-sdk`,
// the one the domain's mapping check reads too (spec section 5.2).

/** Jira's three status categories (`statusCategory.key`). */
export type JiraCategoryKey = "new" | "indeterminate" | "done";

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

/** The workflows API's category (`TODO`, `IN_PROGRESS`, `DONE`) as the key the rest of Jira's API uses. */
export const workflowCategoryKey = (category: string | undefined): JiraCategoryKey | undefined => {
  switch (category) {
    case "TODO":
      return "new";
    case "IN_PROGRESS":
      return "indeterminate";
    case "DONE":
      return "done";
    case undefined:
    default:
      return undefined;
  }
};

/** What Jira's workflows API answers (`/workflows/search` or the bulk read): its workflows, and the statuses they reference. */
export type JiraWorkflowsAnswer = {
  readonly workflows: readonly JiraWorkflowJson[];
  readonly statuses: readonly JiraWorkflowStatusJson[];
};

/**
 * Jira's workflows as one `TrackerWorkflow`: their union, each transition once per
 * `(from, to, name)` (spec section 5.2). The workflows API names a status by a reference, which
 * the answer's status list turns into the status's ID. A global transition is from `any`; Jira's
 * initial transition (the one that creates an issue) and a transition from or to a status the
 * answer doesn't name are left out, since no move can take them.
 *
 * `board`: the board's statuses (`listStatuses`). Given, they're the workflow's statuses, and a
 * transition is kept only between them. `null`: the statuses are the workflows' own, in their order.
 * `readable` is true: the caller decides when the token couldn't read the graph.
 */
export const readJiraWorkflows = (answer: JiraWorkflowsAnswer, board: readonly TrackerStatus[] | null): TrackerWorkflow => {
  const byReference = new Map(answer.statuses.map((status) => [status.statusReference, status]));
  const known = new Set(board?.map((status) => status.id) ?? answer.statuses.map((status) => status.id));
  // A reference the list doesn't hold may be the status's ID itself.
  const idOf = (reference: string | undefined): string | undefined => {
    if (reference === undefined) return undefined;
    const id = byReference.get(reference)?.id ?? reference;
    return known.has(id) ? id : undefined;
  };
  const parts = answer.workflows.map((workflow): TrackerWorkflow => {
    const own: TrackerStatus[] = [];
    // A workflow that lists no statuses of its own has the answer's.
    for (const reference of workflow.statuses ?? answer.statuses) {
      const status = byReference.get(reference.statusReference);
      if (status === undefined || own.some((one) => one.id === status.id)) continue;
      const key = workflowCategoryKey(status.statusCategory);
      own.push({ id: status.id, name: status.name, category: jiraStatusCategory(key, status.name), vendorType: key ?? "undefined", position: own.length });
    }
    const transitions: WorkflowTransition[] = [];
    for (const transition of workflow.transitions ?? []) {
      const to = idOf(transition.toStatusReference);
      if (transition.type === "INITIAL" || to === undefined) continue;
      if (transition.type === "GLOBAL") {
        transitions.push({ id: transition.id, name: transition.name, from: "any", to });
        continue;
      }
      const from = [...new Set((transition.links ?? []).flatMap((link) => idOf(link.fromStatusReference) ?? []))];
      // A directed transition from no status the answer names can't be taken.
      if (from.length > 0) transitions.push({ id: transition.id, name: transition.name, from, to });
    }
    return { readable: true, statuses: board ?? own, transitions };
  });
  return parts.length === 0 ? { readable: true, statuses: board ?? [], transitions: [] } : mergeWorkflows(parts);
};

/** A transition an issue can take now (`GET /issue/{id}/transitions`), in the adapter's terms. */
export type AvailableTransition = { readonly id: string; readonly name: string; readonly to: TicketStatus };

const isFinal = (category: TicketStatusCategory): boolean => category === "done" || category === "cancelled";

const RANK: Readonly<Record<TicketStatusCategory, number>> = { open: 0, started: 1, done: 2, cancelled: 2 };

/**
 * Which of an issue's transitions to take toward `goal`: the goal itself first, and otherwise never
 * a done or cancelled status, nor one the walk has been at. With the workflow, the step whose route
 * on to the goal (`routeTo`, within the steps left) is shortest. Without it (no
 * `read:workflow:jira`), a step toward the goal's category, closest first: a guess, which can stop
 * short where the workflow would have gone round. `null`: no way on.
 */
export const nextTransition = (input: {
  readonly available: readonly AvailableTransition[];
  readonly goal: string;
  readonly goalCategory: TicketStatusCategory | null;
  readonly currentCategory: TicketStatusCategory;
  readonly visited: ReadonlySet<string>;
  readonly workflow: TrackerWorkflow | null;
  /** How many transitions the move may still take, this one included. Default `MAX_ROUTE_STEPS`. */
  readonly stepsLeft?: number;
}): AvailableTransition | null => {
  const direct = input.available.find((transition) => transition.to.id === input.goal);
  if (direct !== undefined) return direct;
  const usable = input.available.filter((transition) => !input.visited.has(transition.to.id) && !isFinal(transition.to.category));
  if (input.workflow !== null) {
    const { workflow } = input;
    const after = (input.stepsLeft ?? MAX_ROUTE_STEPS) - 1;
    let best: { readonly transition: AvailableTransition; readonly steps: number } | null = null;
    for (const transition of usable) {
      const route = routeTo(workflow, transition.to.id, input.goal, after);
      if (route !== null && (best === null || route.length < best.steps)) best = { transition, steps: route.length };
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
