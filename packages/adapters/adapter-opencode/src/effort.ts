import { orderedEffortLevels } from "@ostra/adapter-sdk";
import type { EffortModel } from "@ostra/adapter-sdk";
import { effortLevelSchema } from "@ostra/protocol";
import type { EffortLevel } from "@ostra/protocol";

import { DEFAULT_OUTPUT } from "./config.ts";

// The reasoning levels OpenCode advertises for a model (F-137, ADR 0066): a port of its own
// `Variant.resolve` at 2.3.2 (`packages/core/src/variant.ts`, research
// `opencode-reasoning-effort.md`, sections 1.3 and 1.4), for the two packages ostra writes. Each
// variant OpenCode builds is a value of its ACP `effort` option, beside `default`. The agent
// contract suite checks this port against the pinned binary, so a bump that changes it fails there.

/** One of a model's reasoning controls, as OpenCode's `Variant.supports` reads it. */
type Support =
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number | undefined; readonly max?: number | undefined };

/** OpenCode's `Variant.supports`: the controls of models.dev v2's shape, `default` aside. */
const supportsOf = (model: EffortModel): readonly Support[] => {
  const { reasoning } = model;
  if (!reasoning.supported) {
    return [];
  }
  return [
    ...(reasoning.toggle === true ? [{ type: "toggle" as const }] : []),
    ...(reasoning.effort === undefined ? [] : [{ type: "effort" as const, values: reasoning.effort }]),
    ...(reasoning.budget === undefined ? [] : [{ type: "budget_tokens" as const, min: reasoning.budget.min, max: reasoning.budget.max }]),
  ];
};

/** The output limit OpenCode reads: what ostra writes into the config's `limit.output`. */
const outputLimitOf = (model: EffortModel): number => model.limits.maxOutputTokens ?? DEFAULT_OUTPUT;

/** OpenCode's `budgets`: two variants, `high` (half the ceiling) and `max` (the ceiling less one). */
const budgets = (model: EffortModel, support: Extract<Support, { type: "budget_tokens" }>, ceiling: number): readonly string[] => {
  const output = outputLimitOf(model);
  const maximum = Math.min(support.max ?? ceiling - 1, output - 1, ceiling - 1);
  return maximum <= 0 ? [] : ["high", "max"];
};

/** OpenCode's `claudeInfo`: the Claude family and version in a model ID. */
const claudeInfo = (modelId: string) => {
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(modelId);
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(modelId);
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase();
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1]);
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0);
  return {
    family,
    major,
    minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === "fable" || family === "mythos" || modelId.toLowerCase().includes("mythos-preview"),
  };
};

const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000;

/** OpenCode's `openaiChat`: an effort list alone; a toggle or a budget gives nothing. */
const openaiChat = (_model: EffortModel, support: Support): readonly string[] => (support.type === "effort" ? support.values : []);

/** OpenCode's `manualThinking`: a 16,000-token budget, or nothing when the output limit is under 1,024 more. */
const manualThinkingFits = (model: EffortModel): boolean => Math.min(16_000, outputLimitOf(model) - 1) >= 1024;

/** OpenCode's `anthropicMessages`, by the model ID's Claude family and version. */
const anthropicMessages = (model: EffortModel, support: Support): readonly string[] => {
  const info = claudeInfo(model.endpointModelId);
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5;
  switch (support.type) {
    case "effort": {
      if (info.manual && !opus45) {
        return anthropicMessages(model, { type: "budget_tokens", min: 1024 });
      }
      if (opus45 && !manualThinkingFits(model)) {
        return [];
      }
      return support.values.filter((effort) => !info.always || effort !== "none");
    }
    case "toggle":
      if (info.always || (info.manual && !manualThinkingFits(model))) {
        return [];
      }
      return ["none", "thinking"];
    case "budget_tokens":
      return budgets(model, support, ANTHROPIC_OUTPUT_TOKEN_MAX);
    default:
      return support satisfies never;
  }
};

/** OpenCode's `Variant.resolve`: the variant IDs it builds for the model, in its order. */
export const openCodeVariants = (model: EffortModel): readonly string[] => {
  const protocol = model.apiFormat === "openai-compatible" ? openaiChat : anthropicMessages;
  const supports = supportsOf(model);
  const toggle = supports.some((support) => support.type === "toggle") ? protocol(model, { type: "toggle" }) : [];
  const effort = supports.find((support) => support.type === "effort");
  const budget = supports.find((support) => support.type === "budget_tokens");
  const main = effort === undefined ? (budget === undefined ? toggle : protocol(model, budget)) : protocol(model, effort);
  const variants = [...toggle.filter((variant) => variant === "none"), ...main];
  return variants.filter((variant, index) => variants.indexOf(variant) === index);
};

/** OpenCode names the toggle's "on" `thinking`; every other level is its own name. */
export const OPENCODE_ON_VARIANT = "thinking";

/** A variant's level: `thinking` is `on`; one off ostra's scale (OpenCode's own defaults aside) is none. */
const levelOfVariant = (variant: string): EffortLevel | undefined => {
  if (variant === OPENCODE_ON_VARIANT) {
    return "on";
  }
  const parsed = effortLevelSchema.safeParse(variant);
  return parsed.success && parsed.data !== "on" && parsed.data !== "default" ? parsed.data : undefined;
};

/** The levels OpenCode takes for the model, low to high, `default` first. */
export const openCodeEffortLevels = (model: EffortModel): readonly EffortLevel[] =>
  orderedEffortLevels(openCodeVariants(model).flatMap((variant) => levelOfVariant(variant) ?? []));

