import { clampEffort } from "@ostra/protocol";
import type { ApiFormat, ClampedEffort, EffortLevel, ReasoningControls, TaskSpecModelLimits } from "@ostra/protocol";

import { effectiveReasoning } from "./reasoning.ts";
import type { ModelReasoning } from "./reasoning.ts";

// A task's level against its model (F-137, ADR 0066, milestone 4's ticket 59): the model row's
// effective controls, the levels its agent can send for them, and the task's level clamped to
// those. The dispatch, the task spec and a driver's change all read it here, so they agree.

/** What an agent adapter needs to say which levels it can send for a model (ticket 57's `effortLevels`). */
export type AgentEffortLevelsInput = {
  readonly reasoning: ReasoningControls;
  readonly apiFormat: ApiFormat;
  readonly endpointModelId: string;
  readonly limits: TaskSpecModelLimits;
};

/**
 * Core's agent registry: the levels the named agent adapter can send for a model, low to high,
 * `default` first. An adapter it doesn't know offers `default` alone.
 */
export type AgentEffortLevels = (adapter: string, input: AgentEffortLevelsInput) => readonly EffortLevel[];

/** The model row as the effort reads it. */
export type EffortModel = ModelReasoning & {
  readonly endpointModelId: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
};

export type ModelEffort = {
  /** The model's effective controls: the admin's, else the catalog's, else none. */
  readonly reasoning: ReasoningControls;
  readonly limits: TaskSpecModelLimits;
  /** The levels the agent can send for the model, `default` first. */
  readonly levels: readonly EffortLevel[];
  /** The task's level, clamped to `levels`. */
  readonly effort: ClampedEffort;
};

/** A task's level against the model it runs on, with the agent's levels for it. */
export const modelEffort = (
  levelsFor: AgentEffortLevels,
  input: { readonly adapter: string; readonly apiFormat: ApiFormat; readonly model: EffortModel; readonly level: EffortLevel },
): ModelEffort => {
  const reasoning = effectiveReasoning(input.model);
  const limits: TaskSpecModelLimits = { contextWindow: input.model.contextWindow, maxOutputTokens: input.model.maxOutputTokens };
  const offered = levelsFor(input.adapter, { reasoning, apiFormat: input.apiFormat, endpointModelId: input.model.endpointModelId, limits });
  // `default` is always a level: an adapter's list that left it out still offers it.
  const levels: readonly EffortLevel[] = offered.includes("default") ? offered : ["default", ...offered];
  return { reasoning, limits, levels, effort: clampEffort(input.level, levels) };
};

/** The first protocol minor that carries a level (`agent.effort`, `set-effort`). */
export const EFFORT_MINOR = 3;
