import path from "node:path";
import { tmpdir } from "node:os";

import { ok } from "@ostra/adapter-sdk";
import type { EffortModel, PrepareLaunchInput } from "@ostra/adapter-sdk";
import { memoryAdapterContext } from "@ostra/adapter-sdk/testing";
import type { ApiFormat, EffortLevel, ReasoningControls } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OPENCODE_VERSION } from "./binary.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

// Ticket 57 (F-137, ADR 0066): OpenCode's levels per model, ported from its `Variant.resolve`
// (research `opencode-reasoning-effort.md`, sections 1.3 and 1.4), and the config that carries the
// model's controls and real limits. The contract suite checks the same levels against the pinned
// binary's `session/new`; this table covers every branch, cheaply.

const adapter = () =>
  new OpenCodeAdapter(
    { resolveBinary: () => Promise.resolve(ok({ path: path.join(tmpdir(), "opencode-not-run"), packageName: "@opencode/cli-test", packageVersion: OPENCODE_VERSION, sha256: "0".repeat(64) })) },
    memoryAdapterContext(),
  );

const model = (apiFormat: ApiFormat, endpointModelId: string, reasoning: ReasoningControls, maxOutputTokens: number | null = null): EffortModel => ({
  apiFormat,
  endpointModelId,
  reasoning,
  limits: { contextWindow: null, maxOutputTokens },
});

const EFFORT: ReasoningControls = { supported: true, effort: ["none", "low", "medium", "high", "xhigh", "max"] };
const TOGGLE: ReasoningControls = { supported: true, toggle: true };
const BUDGET: ReasoningControls = { supported: true, budget: { min: 1024 } };
const BOTH: ReasoningControls = { supported: true, toggle: true, effort: ["low", "high", "max"] };

const rows: readonly (readonly [string, EffortModel, readonly EffortLevel[]])[] = [
  // OpenAI-compatible: an effort list alone.
  ["OpenAI: an effort list gives its levels", model("openai-compatible", "gpt-5.5", EFFORT), ["default", "none", "low", "medium", "high", "xhigh", "max"]],
  ["OpenAI: a toggle alone gives none", model("openai-compatible", "gpt-5.5", TOGGLE), ["default"]],
  ["OpenAI: a budget alone gives none", model("openai-compatible", "gpt-5.5", BUDGET), ["default"]],
  ["OpenAI: a toggle beside an effort list adds nothing", model("openai-compatible", "deepseek-v4-pro", BOTH), ["default", "low", "high", "max"]],
  ["OpenAI: reasoning with no control gives none", model("openai-compatible", "gpt-5.5", { supported: true }), ["default"]],
  ["OpenAI: a model that doesn't reason gives none", model("openai-compatible", "gpt-5.5", { supported: false }), ["default"]],
  // Anthropic-compatible, a current Claude or any other ID.
  ["Anthropic: a current Claude's effort list", model("anthropic-messages", "claude-sonnet-5", EFFORT), ["default", "none", "low", "medium", "high", "xhigh", "max"]],
  ["Anthropic: an ID that isn't a Claude is a current one", model("anthropic-messages", "glm-5.3", EFFORT), ["default", "none", "low", "medium", "high", "xhigh", "max"]],
  ["Anthropic: a toggle gives none and on", model("anthropic-messages", "claude-sonnet-5", TOGGLE), ["default", "none", "on"]],
  ["Anthropic: a toggle beside an effort list adds none", model("anthropic-messages", "claude-sonnet-5", BOTH), ["default", "none", "low", "high", "max"]],
  ["Anthropic: a budget gives high and max", model("anthropic-messages", "claude-sonnet-5", BUDGET), ["default", "high", "max"]],
  ["Anthropic: a budget with no room gives none", model("anthropic-messages", "claude-sonnet-5", BUDGET, 1), ["default"]],
  // A manual Claude: 3.7, and 4.0 to 4.5 but Opus 4.5.
  ["Anthropic: a manual Claude's effort list becomes high and max", model("anthropic-messages", "claude-sonnet-4-5", EFFORT), ["default", "high", "max"]],
  ["Anthropic: Claude 3.7, named version first, is manual", model("anthropic-messages", "claude-3-7-sonnet-latest", EFFORT), ["default", "high", "max"]],
  ["Anthropic: a manual Claude's toggle gives none and on", model("anthropic-messages", "claude-opus-4-1", TOGGLE), ["default", "none", "on"]],
  ["Anthropic: Opus 4.5 keeps its effort list", model("anthropic-messages", "claude-opus-4-5", EFFORT), ["default", "none", "low", "medium", "high", "xhigh", "max"]],
  ["Anthropic: Opus 4.5 with no room for its 1,024-token thinking gives none", model("anthropic-messages", "claude-opus-4-5", EFFORT, 1000), ["default"]],
  // Fable and Mythos always think.
  ["Anthropic: Fable has no none", model("anthropic-messages", "claude-fable-5", EFFORT), ["default", "low", "medium", "high", "xhigh", "max"]],
  ["Anthropic: Mythos has no toggle", model("anthropic-messages", "claude-mythos-5", TOGGLE), ["default"]],
  ["Anthropic: a model that doesn't reason gives none", model("anthropic-messages", "claude-sonnet-5", { supported: false }), ["default"]],
];

describe("OpenCode's reasoning levels", () => {
  it.each(rows)("F-137/c1: the levels mirror OpenCode 2.3.2's Variant.resolve: %s", (_name, effortModel, levels) => {
    // Checked on this version: a bump must be checked again (the contract suite runs it on the binary).
    expect(OPENCODE_VERSION).toBe("2.3.2");
    expect(adapter().effortLevels(effortModel)).toEqual(levels);
  });

  it("F-137: OpenCode names on thinking, and every other level by its own name", () => {
    const opencode = adapter();
    const any = model("anthropic-messages", "claude-sonnet-5", TOGGLE);
    expect(opencode.effortValue("on", any)).toBe("thinking");
    for (const level of ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(opencode.effortValue(level, any)).toBe(level);
    }
  });

  it("F-137/c13: OpenCode declares the session-option capability", () => {
    expect(adapter().capabilities.reasoningEffort).toBe("session-option");
  });
});

const input = (modelOverrides: Partial<PrepareLaunchInput["model"]>): PrepareLaunchInput => ({
  taskId: fixtureIds.task,
  sessionId: fixtureIds.session,
  workspaceDir: path.join(tmpdir(), "task", "workspace"),
  agentDir: path.join(tmpdir(), "task", "agent"),
  model: { endpointModelId: "claude-sonnet-5", apiFormat: "anthropic-messages", baseUrl: "http://127.0.0.1:8123/v1", placeholderKey: "ostra-fake-key-abc", ...modelOverrides },
  mcp: { url: "http://127.0.0.1:8124/mcp" },
  instructions: null,
  extraEnv: {},
});

const fileJson = async (overrides: Partial<PrepareLaunchInput["model"]>, suffix: string): Promise<unknown> => {
  const prepared = await adapter().prepareLaunch(input(overrides));
  if (!prepared.ok) throw new Error(prepared.error.message);
  const file = prepared.value.files.find((candidate) => candidate.path.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${suffix}`);
  return JSON.parse(file.content);
};

const configModel = async (overrides: Partial<PrepareLaunchInput["model"]>): Promise<unknown> => {
  const config = z.looseObject({ providers: z.looseObject({ ostra: z.looseObject({ models: z.record(z.string(), z.unknown()) }) }) }).parse(await fileJson(overrides, "opencode.json"));
  return config.providers.ostra.models[overrides.endpointModelId ?? "claude-sonnet-5"];
};

const catalogModel = async (overrides: Partial<PrepareLaunchInput["model"]>): Promise<unknown> => {
  const catalog = z.looseObject({ ostra: z.looseObject({ models: z.record(z.string(), z.unknown()) }) }).parse(await fileJson(overrides, "models.json"));
  return catalog.ostra.models[overrides.endpointModelId ?? "claude-sonnet-5"];
};

describe("OpenCode's config: the model's controls and limits", () => {
  it("F-137/c5: the config carries the model's controls as capabilities.reasoning, and { supported: false } when it has none", async () => {
    expect(await configModel({ reasoning: BOTH })).toMatchObject({ capabilities: { reasoning: BOTH } });
    expect(await configModel({ reasoning: BUDGET })).toMatchObject({ capabilities: { reasoning: BUDGET } });
    expect(await configModel({})).toMatchObject({ capabilities: { reasoning: { supported: false } } });
  });

  it("F-137/c10: the config's limit is the model's real one, each falling back alone to 128,000 and 16,000", async () => {
    expect(await configModel({ limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 } })).toMatchObject({ limit: { context: 1_000_000, output: 128_000 } });
    expect(await configModel({ limits: { contextWindow: 200_000, maxOutputTokens: null } })).toMatchObject({ limit: { context: 200_000, output: 16_000 } });
    expect(await configModel({ limits: { contextWindow: null, maxOutputTokens: 64_000 } })).toMatchObject({ limit: { context: 128_000, output: 64_000 } });
    expect(await configModel({})).toMatchObject({ limit: { context: 128_000, output: 16_000 } });
  });

  it("F-137: the catalog file has a release_date, the same reasoning in models.dev's v1 shape, and the same limits", async () => {
    expect(await catalogModel({ reasoning: { supported: true, toggle: true, effort: ["low", "high"], budget: { min: 1024, max: 8000 } }, limits: { contextWindow: 400_000, maxOutputTokens: 32_000 } })).toEqual({
      id: "claude-sonnet-5",
      name: "claude-sonnet-5",
      release_date: "2026-01-01",
      tool_call: true,
      reasoning: true,
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }, { type: "budget_tokens", min: 1024, max: 8000 }],
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 400_000, output: 32_000 },
    });
    expect(await catalogModel({ reasoning: { supported: true } })).toMatchObject({ reasoning: true });
    expect(await catalogModel({ reasoning: { supported: true } })).not.toHaveProperty("reasoning_options");
    expect(await catalogModel({})).toMatchObject({ reasoning: false, release_date: "2026-01-01" });
  });
});
