import { z } from "zod";

// Reasoning effort (F-137, ADR 0066, protocol minor 3). The level vocabulary is models.dev's own
// (research `opencode-reasoning-effort.md`, section 2.1), plus `default` (send nothing) and `on`
// (a model whose only control is a toggle). The clamp lives here, not in `packages/domain`,
// because the runner and the agent adapters are Apache-2.0 and can't import the domain (Q190):
// core clamps a task's level before dispatch, and the runner clamps it again to the values the
// agent actually advertised.

/** models.dev's effort values, low to high. The clamp's distances are positions on it. */
export const EFFORT_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A level on models.dev's scale: what a model's controls list. */
export const effortScaleLevelSchema = z.enum(EFFORT_SCALE);
export type EffortScaleLevel = z.infer<typeof effortScaleLevelSchema>;

/** A reasoning level: `default`, one of the scale's, or `on`. A closed union. */
export const effortLevelSchema = z.enum(["default", ...EFFORT_SCALE, "on"]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

/** Every level, in the panel's order: Default, Off, Minimal … Max, On. */
export const effortLevels: readonly EffortLevel[] = effortLevelSchema.options;

const scaleIndex = (level: EffortScaleLevel): number => EFFORT_SCALE.indexOf(level);

const isScaleLevel = (level: EffortLevel): level is EffortScaleLevel => level !== "default" && level !== "on";

const tokenBound = z.number().int().positive();

/**
 * A model's reasoning controls, in models.dev's v2 shape as ostra stores it (ADR 0066): from the
 * catalog, or from an organization admin. ostra owns this shape, so unknown fields are refused.
 */
export const reasoningControlsSchema = z.discriminatedUnion("supported", [
  z.strictObject({ supported: z.literal(false) }),
  z.strictObject({
    supported: z.literal(true),
    /** Reasoning can be switched off and on. */
    toggle: z.boolean().optional(),
    /** The effort values the host takes, from the scale, each once. Never `default`. */
    effort: z
      .array(effortScaleLevelSchema)
      .min(1)
      .max(EFFORT_SCALE.length)
      .refine((levels) => new Set(levels).size === levels.length, "each level once")
      .optional(),
    /** A thinking budget in tokens. */
    budget: z.strictObject({ min: tokenBound.optional(), max: tokenBound.optional() }).optional(),
  }),
]);
export type ReasoningControls = z.infer<typeof reasoningControlsSchema>;

/** A model that doesn't reason, or whose controls nobody stated. */
export const noReasoning: ReasoningControls = { supported: false };

/** The outcome of the clamp: the level the turn runs at, and whether it differs from the one asked for. */
export type ClampedEffort = { readonly level: EffortLevel; readonly adjusted: boolean };

const nearestOnScale = (requested: EffortScaleLevel, offered: readonly EffortScaleLevel[]): EffortScaleLevel | undefined => {
  const target = scaleIndex(requested);
  let best: EffortScaleLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of offered) {
    const distance = Math.abs(scaleIndex(level) - target);
    // Ties go to the higher level.
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && scaleIndex(level) > scaleIndex(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
};

const clampLevel = (requested: EffortLevel, offered: readonly EffortLevel[]): EffortLevel => {
  // 1. `default` stays `default`.
  if (requested === "default") {
    return "default";
  }
  // 2. A level the model has stays.
  if (offered.includes(requested)) {
    return requested;
  }
  const scale = offered.filter(isScaleLevel);
  const effortLevelsOffered = scale.filter((level) => level !== "none");
  // 3. On a toggle-only model, `none` stays `none` (rule 2, when offered) and anything else is
  // `on`. A toggle that can't be switched off leaves `none` at `default`.
  if (offered.includes("on") && effortLevelsOffered.length === 0) {
    return requested === "none" ? "default" : "on";
  }
  // 4. `on` on a model with effort levels is `default`.
  if (requested === "on") {
    return "default";
  }
  // 5. The nearest level on the scale, the higher of two equally near; 6. no levels runs at `default`.
  return nearestOnScale(requested, scale) ?? "default";
};

/**
 * ADR 0066's clamp: the level a turn runs at, given the level asked for and the levels the model
 * offers (as its agent can send them). Never an error: a level that stopped fitting moves to the
 * nearest one the model has.
 */
export const clampEffort = (requested: EffortLevel, offered: readonly EffortLevel[]): ClampedEffort => {
  const level = clampLevel(requested, offered);
  return { level, adjusted: level !== requested };
};
