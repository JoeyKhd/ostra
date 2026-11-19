import { noReasoning } from "@ostra/protocol";
import type { ReasoningControls } from "@ostra/protocol";

// Reasoning effort's pure core (F-137, ADR 0066). The clamp itself is `@ostra/protocol`'s
// `clampEffort`, because the runner and the agent adapters apply it too and can't import the
// domain (Q190); it's re-exported here beside the rule that picks a model's controls.

export { clampEffort, EFFORT_SCALE, effortLevels } from "@ostra/protocol";
export type { ClampedEffort, EffortLevel, ReasoningControls } from "@ostra/protocol";

/** A model's two sets of controls, as its row keeps them: the catalog's, and an admin's. */
export type ModelReasoning = {
  /** Written by the catalog sync (ticket 58); `null` before it ran, or for a custom model. */
  readonly catalogReasoning: ReasoningControls | null;
  /** Written by an organization admin, never by a sync; `null` to follow the catalog. */
  readonly adminReasoning: ReasoningControls | null;
};

/**
 * The controls a model runs with: the admin's, else the catalog's, else none. A custom model has
 * no catalog entry, so it reasons only when an admin says so (Q286).
 */
export const effectiveReasoning = (model: ModelReasoning): ReasoningControls =>
  model.adminReasoning ?? model.catalogReasoning ?? noReasoning;
