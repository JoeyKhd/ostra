import { openCodeEffort } from "@ostra/adapter-opencode/effort";
import { effectiveReasoning } from "@ostra/domain";
import { apiFormatFromDb } from "@ostra/db";
import type { DbOrTx } from "@ostra/db";
import { effortLevelSchema, reasoningControlsSchema } from "@ostra/protocol";
import type { ApiFormat, EffortLevel, OrganizationId, ReasoningControls } from "@ostra/protocol";
import { z } from "zod";

// F-137 (ADR 0066, tickets 57 and 61): the levels a model offers, as far as its agent can send
// them. The agent adapter owns that mapping (its `reasoningEffort` capability and `effortLevels`);
// the API and core ask it through this port, so the panel offers, and the dispatch sends, exactly
// what a turn will send. An agent no adapter declares offers `default` alone.

/** How an agent takes a level (ADR 0066): over an ACP session option, by a relaunch, or not at all. */
export type ReasoningEffortCapability = "session-option" | "relaunch" | "none";

/** What an agent's levels depend on: the model's controls, its API format, its ID and its limits. */
export type EffortLevelsInput = {
  readonly reasoning: ReasoningControls;
  readonly apiFormat: ApiFormat;
  readonly endpointModelId: string;
  readonly limits: { readonly contextWindow: number | null; readonly maxOutputTokens: number | null };
};

export type AgentEffort = {
  readonly capabilityOf: (adapter: string) => ReasoningEffortCapability;
  /** The levels the agent can send for the model, `default` first, then low to high. `[default]` for none. */
  readonly levelsFor: (adapter: string, input: EffortLevelsInput) => readonly EffortLevel[];
};

/** What the port reads off an agent adapter: its declared capability and its levels per model. */
export type EffortAgent = {
  readonly capabilities: { readonly reasoningEffort: ReasoningEffortCapability };
  readonly effortLevels: (model: EffortLevelsInput) => readonly EffortLevel[];
};

/** The port over the agent adapters' own declarations, by adapter name. */
export const adapterAgentEffort = (agents: ReadonlyMap<string, EffortAgent>): AgentEffort => ({
  capabilityOf: (adapter) => agents.get(adapter)?.capabilities.reasoningEffort ?? "none",
  levelsFor: (adapter, input) => {
    const agent = agents.get(adapter);
    return agent === undefined || agent.capabilities.reasoningEffort === "none" ? ["default"] : agent.effortLevels(input);
  },
});

/** The shipped agents: OpenCode, whose levels are a port of its own `Variant.resolve` (ticket 57). */
export const shippedAgentEffort: AgentEffort = adapterAgentEffort(new Map([["opencode", openCodeEffort]]));

// ---------- the views ----------

/** One level as the panel offers it: the level, and the key of its label and hint (`effort.levels.*`). */
export const effortLevelViewSchema = z.object({ level: effortLevelSchema, labelKey: z.string() });
export type EffortLevelView = z.infer<typeof effortLevelViewSchema>;

export const toLevelViews = (levels: readonly EffortLevel[]): EffortLevelView[] => levels.map((level) => ({ level, labelKey: `effort.levels.${level}` }));

/** Where a model's controls come from: the catalog, an admin, or nobody yet (a custom model). */
export const reasoningSourceSchema = z.enum(["catalog", "admin"]).nullable();

/** The model row's fields the levels need. */
const modelEffortSelect = {
  endpointModelId: true,
  catalogId: true,
  contextWindow: true,
  maxOutputTokens: true,
  catalogReasoning: true,
  adminReasoning: true,
  provider: { select: { apiFormat: true } },
} as const;

const controls = reasoningControlsSchema.nullable();

type ModelEffortRow = {
  readonly endpointModelId: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly catalogReasoning: unknown;
  readonly adminReasoning: unknown;
  readonly provider: { readonly apiFormat: keyof typeof apiFormatFromDb };
};

/** A model row's reasoning: the effective controls, both sources, and where they came from. */
export const reasoningOf = (row: Pick<ModelEffortRow, "catalogReasoning" | "adminReasoning">) => {
  const catalog = controls.parse(row.catalogReasoning);
  const admin = controls.parse(row.adminReasoning);
  return {
    controls: effectiveReasoning({ catalogReasoning: catalog, adminReasoning: admin }),
    catalog,
    admin,
    source: admin === null ? (catalog === null ? null : ("catalog" as const)) : ("admin" as const),
  };
};

/** The levels an agent offers on one model row. */
export const levelsOfModel = (effort: AgentEffort, adapter: string, row: ModelEffortRow): readonly EffortLevel[] =>
  effort.levelsFor(adapter, {
    reasoning: reasoningOf(row).controls,
    apiFormat: apiFormatFromDb[row.provider.apiFormat],
    endpointModelId: row.endpointModelId,
    limits: { contextWindow: row.contextWindow, maxOutputTokens: row.maxOutputTokens },
  });

/** A model's levels for an agent, and where its controls came from; `null` when the organization has no such model. */
export const loadModelEffort = async (db: DbOrTx, effort: AgentEffort, organizationId: OrganizationId, modelId: string, adapter: string) => {
  const row = await db.model.findFirst({ where: { id: modelId, organizationId }, select: modelEffortSelect });
  if (row === null) {
    return null;
  }
  return { levels: levelsOfModel(effort, adapter, row), source: reasoningOf(row).source, custom: row.catalogId === null };
};

/** The refusal of a level the model doesn't offer, naming the levels it does. */
export const levelRefusal = (level: EffortLevel, levels: readonly EffortLevel[]): string =>
  `This model has no ${level} level: it takes ${levels.join(", ")}`;
