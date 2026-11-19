import { recordingLogger } from "@ostra/adapter-sdk/testing";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import type { ReasoningControls } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { loadBundledCatalog, parseModelsDevCatalog } from "./catalog.ts";

// F-137 (ADR 0066, ticket 58): each catalog model's reasoning controls, in models.dev's v2 shape,
// converted from v1's `reasoning` and `reasoning_options` the way OpenCode converts them
// (research `opencode-reasoning-effort.md`, sections 1.2 and 2).

/** One model in the live v1 API's shape (fields as `https://models.dev/api.json` spells them). */
const liveShaped = (id: string, extra: Record<string, unknown>) => ({
  id,
  name: id,
  attachment: false,
  reasoning: true,
  tool_call: true,
  temperature: true,
  release_date: "2026-01-01",
  last_updated: "2026-01-01",
  modalities: { input: ["text"], output: ["text"] },
  open_weights: false,
  limit: { context: 200_000, output: 64_000 },
  cost: { input: 1, output: 4 },
  ...extra,
});

const entriesOf = (models: Record<string, Record<string, unknown>>): readonly CatalogEntry[] => {
  const parsed = parseModelsDevCatalog({ acme: { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", models } });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const reasoningById = (entries: readonly CatalogEntry[]): Record<string, ReasoningControls> =>
  Object.fromEntries(entries.map((entry) => [entry.catalogId, entry.reasoning]));

describe("the catalog's reasoning controls (F-137)", () => {
  const rows: readonly { readonly name: string; readonly model: Record<string, unknown>; readonly controls: ReasoningControls }[] = [
    { name: "reasoning false", model: { reasoning: false }, controls: { supported: false } },
    { name: "reasoning missing", model: { reasoning: undefined }, controls: { supported: false } },
    { name: "a toggle option", model: { reasoning_options: [{ type: "toggle" }] }, controls: { supported: true, toggle: true } },
    {
      name: "an effort option, with null, \"null\" and default dropped, in the scale's order",
      model: { reasoning_options: [{ type: "effort", values: ["max", null, "low", "null", "default", "high", "none"] }] },
      controls: { supported: true, effort: ["none", "low", "high", "max"] },
    },
    {
      name: "a budget_tokens option's min and max",
      model: { reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32_000 }] },
      controls: { supported: true, budget: { min: 1024, max: 32_000 } },
    },
    { name: "a budget_tokens option with no bounds", model: { reasoning_options: [{ type: "budget_tokens" }] }, controls: { supported: true, budget: {} } },
    { name: "reasoning true with no option", model: {}, controls: { supported: true } },
    {
      name: "a toggle and an effort option together",
      model: { reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] },
      controls: { supported: true, toggle: true, effort: ["low", "medium", "high", "xhigh", "max"] },
    },
    { name: "an effort option of default alone", model: { reasoning_options: [{ type: "effort", values: ["default"] }] }, controls: { supported: true } },
    { name: "a control type ostra doesn't know", model: { reasoning_options: [{ type: "dial", steps: 3 }, { type: "toggle" }] }, controls: { supported: true, toggle: true } },
  ];

  it.each(rows)("F-137: the conversion: $name", ({ model, controls }) => {
    const [entry] = entriesOf({ m: liveShaped("m", model) });
    expect(entry?.reasoning).toEqual(controls);
  });

  it("F-137: the bundled copy holds the controls research section 2.2 lists, with its fetch date", async () => {
    const { fetchedAt, entries } = await loadBundledCatalog();
    expect(Date.parse(fetchedAt)).toBeGreaterThanOrEqual(Date.parse("2026-11-19"));
    const byId = reasoningById(entries);
    expect({
      sonnet5: byId["anthropic/claude-sonnet-5"],
      sonnet45: byId["anthropic/claude-sonnet-4-5"],
      gpt55: byId["openai/gpt-5.5"],
      gpt52pro: byId["openai/gpt-5.2-pro"],
      deepseekV4Pro: byId["deepseek/deepseek-v4-pro"],
    }).toEqual({
      sonnet5: { supported: true, toggle: true, effort: ["low", "medium", "high", "xhigh", "max"] },
      sonnet45: { supported: true, budget: { min: 1024 } },
      gpt55: { supported: true, effort: ["none", "low", "medium", "high", "xhigh"] },
      gpt52pro: { supported: true, effort: ["medium", "high", "xhigh"] },
      deepseekV4Pro: { supported: true, toggle: true, effort: ["low", "high", "max"] },
    });
    // The fetch keeps them for most reasoning models, not for a handful.
    expect(entries.filter((entry) => entry.reasoning.supported && entry.reasoning.effort !== undefined).length).toBeGreaterThan(3000);
  });

  it("F-137: a malformed reasoning_options refuses the reasoning alone, and logs a count, never the entry's text", () => {
    const logger = recordingLogger();
    const parsed = parseModelsDevCatalog(
      {
        acme: {
          models: {
            broken: liveShaped("broken", { name: "Secret Broken Model", reasoning_options: [{ type: "effort", values: ["warp-speed"] }] }),
            notalist: liveShaped("notalist", { reasoning_options: "toggle" }),
            badbudget: liveShaped("badbudget", { reasoning_options: [{ type: "budget_tokens", min: -5 }] }),
            fine: liveShaped("fine", { reasoning_options: [{ type: "toggle" }] }),
          },
        },
      },
      { logger },
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const broken = parsed.value.find((entry) => entry.catalogId === "acme/broken");
    // The rest of the model stays.
    expect(broken).toMatchObject({ name: "Secret Broken Model", contextWindow: 200_000, maxOutputTokens: 64_000, inputPricePerMTok: 1, reasoning: { supported: false } });
    expect(reasoningById(parsed.value)).toEqual({
      "acme/broken": { supported: false },
      "acme/notalist": { supported: false },
      "acme/badbudget": { supported: false },
      "acme/fine": { supported: true, toggle: true },
    });
    expect(logger.records.map((record) => [record.message, record.fields])).toEqual([["catalog.reasoning-refused", { entries: 3 }]]);
    expect(JSON.stringify(logger.records)).not.toMatch(/warp-speed|Secret Broken|broken/);
  });

  it("F-137: reasoningPriceDiffers for alibaba/qwen3-32b, and not for a model whose two prices match", async () => {
    const { entries } = await loadBundledCatalog();
    const byId = new Map(entries.map((entry) => [entry.catalogId, entry] as const));
    expect(byId.get("alibaba/qwen3-32b")?.reasoningPriceDiffers).toBe(true);
    // DeepSeek V4 Pro lists a reasoning price equal to its output price.
    expect(byId.get("deepseek/deepseek-v4-pro")?.reasoningPriceDiffers).toBe(false);
    const fixture = entriesOf({
      differs: liveShaped("differs", { cost: { input: 0.7, output: 2.8, reasoning: 8.4 } }),
      same: liveShaped("same", { cost: { input: 0.66, output: 1.98, reasoning: 1.98 } }),
      unlisted: liveShaped("unlisted", { cost: { input: 1, output: 4 } }),
      malformed: liveShaped("malformed", { cost: { input: 1, output: 4, reasoning: "lots" } }),
    });
    expect(Object.fromEntries(fixture.map((entry) => [entry.catalogId, entry.reasoningPriceDiffers]))).toEqual({
      "acme/differs": true,
      "acme/same": false,
      "acme/unlisted": false,
      "acme/malformed": false,
    });
  });
});
