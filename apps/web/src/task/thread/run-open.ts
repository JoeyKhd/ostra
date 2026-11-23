"use client";

import { useSyncExternalStore } from "react";

import type { RunItem, RunStep } from "@ostra/task-view";

import { useTaskContext } from "../task-context";

// Owner: ticket 10 (milestone 10, F-151: a run, opened, parts.md part 6). What a viewer opened in
// the thread: which runs, and which steps' outputs, diffs or texts under them. Per viewer and per
// page, never saved; kept beside the thread's own index (one per thread), so it survives new events
// and a run's line and a failure's line under it share it: `details ›` on the failure opens its run
// at that step with the step's output open.

export type RunOpenState = {
  /** The runs opened by their line, by the run's ID. */
  readonly runs: ReadonlySet<string>;
  /** The steps a failure's link opened its run at, by the step's ID: their run stays open with them. */
  readonly revealed: ReadonlySet<string>;
  /** The steps whose output, diff or text is open under their row. */
  readonly shown: ReadonlySet<string>;
  /** The step a failure's link just opened: its row scrolls into view and takes the focus, once. */
  readonly focus: string | null;
};

export type RunOpenStore = {
  readonly get: () => RunOpenState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Opens a closed run, or folds an open one (and whatever a failure opened in it). */
  readonly toggleRun: (run: Pick<RunItem, "id" | "steps">) => void;
  /** Opens or closes one step's output under its row. */
  readonly toggleShown: (step: RunStep) => void;
  /** A failure's link: opens the run that holds the step, the step's output under it, and moves there. */
  readonly reveal: (stepId: string) => void;
  /** The row took the focus it was given. */
  readonly focused: () => void;
};

const empty: RunOpenState = { runs: new Set(), revealed: new Set(), shown: new Set(), focus: null };

/** A step is the one a failure names: the step itself, or the shared read that holds its read. */
export const holdsStep = (step: RunStep, stepId: string): boolean => step.id === stepId || (step.kind === "read" && step.toolCallIds.includes(stepId));

/** Whether a run is open: pressed open by its line, or opened by a failure at one of its steps. */
export const isRunOpen = (state: RunOpenState, run: Pick<RunItem, "id" | "steps">): boolean =>
  state.runs.has(run.id) || [...state.revealed].some((id) => run.steps.some((step) => holdsStep(step, id)));

export const createRunOpenStore = (): RunOpenStore => {
  let state = empty;
  const listeners = new Set<() => void>();
  const set = (next: RunOpenState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const without = (from: ReadonlySet<string>, ids: readonly string[]): Set<string> => new Set([...from].filter((id) => !ids.includes(id)));
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggleRun: (run) => {
      if (!isRunOpen(state, run)) {
        set({ ...state, runs: new Set([...state.runs, run.id]) });
        return;
      }
      const held = [...state.revealed].filter((id) => run.steps.some((step) => holdsStep(step, id)));
      set({ ...state, runs: without(state.runs, [run.id]), revealed: without(state.revealed, held) });
    },
    toggleShown: (step) => {
      const held = [...state.shown].filter((id) => holdsStep(step, id));
      set({ ...state, shown: held.length > 0 ? without(state.shown, held) : new Set([...state.shown, step.id]) });
    },
    reveal: (stepId) => {
      set({ ...state, revealed: new Set([...state.revealed, stepId]), shown: new Set([...state.shown, stepId]), focus: stepId });
    },
    focused: () => {
      if (state.focus !== null) set({ ...state, focus: null });
    },
  };
};

/** One store per thread: keyed by the thread's own index store, so a new page starts closed. */
const stores = new WeakMap<object, RunOpenStore>();

export const runOpenStoreOf = (owner: object): RunOpenStore => {
  const known = stores.get(owner);
  if (known !== undefined) return known;
  const created = createRunOpenStore();
  stores.set(owner, created);
  return created;
};

/** The thread's open runs and steps, and what changes them. */
export const useRunOpen = (): { readonly state: RunOpenState; readonly store: RunOpenStore } => {
  const { store: index } = useTaskContext();
  const store = runOpenStoreOf(index);
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { state, store };
};
