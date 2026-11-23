import type { TicketStatusCategory, TrackerStatus } from "./base.ts";

// Milestone 11 (F-008, spec section 5.2, Q352): a tracker's workflow, as a board's statuses and the
// transitions between them, and the pure reading of it that the domain's mapping check and a
// transitions tracker's `moveTicket` share. A move takes the shortest route of at most three
// transitions; more, or none, and the ticket stays where it is. A route never passes through a
// done or cancelled status on its way, so a move never closes a ticket and reopens it (a global
// "Won't do" then "Reopen" would otherwise reach anything).

/** A transition: from these statuses, or from any (`"any"`, Jira's global transition), to one. */
export type WorkflowTransition = {
  readonly id: string;
  readonly name: string;
  readonly from: readonly string[] | "any";
  readonly to: string;
};

/**
 * A board's workflow (`readWorkflow`). `readable: false` when the credential can't read the graph
 * (Jira without `read:workflow:jira`): the statuses alone, no transitions. A board whose issue
 * types use several workflows reads as their union, each transition once per `(from, to, name)`.
 */
export type TrackerWorkflow = {
  readonly readable: boolean;
  readonly statuses: readonly TrackerStatus[];
  readonly transitions: readonly WorkflowTransition[];
};

/** A transition a move took, for the task's "On Jira" rows: its ID and name, nothing more. */
export type TransitionTaken = { readonly id: string; readonly name: string };

/** How many transitions a move may take before the ticket stays put (Q352, a working value). */
export const MAX_ROUTE_STEPS = 3;

const isFinal = (category: TicketStatusCategory): boolean => category === "done" || category === "cancelled";

const takeableFrom = (transition: WorkflowTransition, at: string): boolean => transition.from === "any" || transition.from.includes(at);

/** Whether a route may pass through a status on its way: never a done or cancelled one. One the workflow doesn't list may. */
const passable = (workflow: TrackerWorkflow, statusId: string): boolean => {
  const status = workflow.statuses.find((one) => one.id === statusId);
  return status === undefined || !isFinal(status.category);
};

/**
 * The shortest list of transitions from one status to another, at most `maxSteps` long, or `null`
 * when none reaches it. A global transition (`from: "any"`) is one step from anywhere; a
 * transition to the status it starts from isn't a step. `[]` when the ticket is there already.
 * Ties go to the transition the workflow lists first.
 */
export const routeTo = (workflow: TrackerWorkflow, fromStatusId: string, targetStatusId: string, maxSteps: number = MAX_ROUTE_STEPS): readonly WorkflowTransition[] | null => {
  if (fromStatusId === targetStatusId) {
    return [];
  }
  const cameBy = new Map<string, { readonly at: string; readonly by: WorkflowTransition }>();
  const seen = new Set<string>([fromStatusId]);
  let level: readonly string[] = [fromStatusId];
  for (let steps = 1; steps <= maxSteps && level.length > 0; steps += 1) {
    const next: string[] = [];
    for (const at of level) {
      if (at !== fromStatusId && !passable(workflow, at)) {
        continue;
      }
      for (const transition of workflow.transitions) {
        if (transition.to === at || !takeableFrom(transition, at) || seen.has(transition.to)) {
          continue;
        }
        seen.add(transition.to);
        cameBy.set(transition.to, { at, by: transition });
        if (transition.to === targetStatusId) {
          const route: WorkflowTransition[] = [];
          for (let step = cameBy.get(targetStatusId); step !== undefined; step = step.at === fromStatusId ? undefined : cameBy.get(step.at)) {
            route.unshift(step.by);
          }
          return route;
        }
        next.push(transition.to);
      }
    }
    level = next;
  }
  return null;
};

/** How a status reaches a target: it's the target, its route's first transition and length, or no route. */
export type StatusReach =
  | { readonly kind: "here" }
  | { readonly kind: "route"; readonly first: WorkflowTransition; readonly steps: number }
  | { readonly kind: "unreachable" };

/**
 * For each status of the workflow, in its order, how a ticket there reaches `targetStatusId`: the
 * Boards page's `by <transition>, from <statuses>` lines and its warnings (boards-mixed.md).
 */
export const reachability = (
  workflow: TrackerWorkflow,
  targetStatusId: string,
  maxSteps: number = MAX_ROUTE_STEPS,
): readonly { readonly status: TrackerStatus; readonly reach: StatusReach }[] =>
  workflow.statuses.map((status) => {
    const route = routeTo(workflow, status.id, targetStatusId, maxSteps);
    const first = route?.[0];
    const reach: StatusReach = status.id === targetStatusId ? { kind: "here" } : route === null || first === undefined ? { kind: "unreachable" } : { kind: "route", first, steps: route.length };
    return { status, reach };
  });

const transitionKey = (transition: WorkflowTransition): string =>
  JSON.stringify([transition.from === "any" ? "any" : [...new Set(transition.from)].sort(), transition.to, transition.name]);

/**
 * Several workflows as one (a board whose issue types use several): every status once, in the order
 * first seen, and every transition once per `(from, to, name)`. Readable only when each part is.
 */
export const mergeWorkflows = (parts: readonly TrackerWorkflow[]): TrackerWorkflow => {
  const statuses = new Map<string, TrackerStatus>();
  const transitions = new Map<string, WorkflowTransition>();
  for (const part of parts) {
    for (const status of part.statuses) {
      if (!statuses.has(status.id)) statuses.set(status.id, status);
    }
    for (const transition of part.transitions) {
      const key = transitionKey(transition);
      if (!transitions.has(key)) transitions.set(key, transition);
    }
  }
  return { readable: parts.every((part) => part.readable), statuses: [...statuses.values()], transitions: [...transitions.values()] };
};

/** The transitions a route took, as a move answers them (`MoveResult.via`). */
export const transitionsTaken = (route: readonly Pick<WorkflowTransition, "id" | "name">[]): readonly TransitionTaken[] => route.map((transition) => ({ id: transition.id, name: transition.name }));
