import type { CatalogEntry } from "@ostra/adapter-sdk";
import type { InputModality } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { loadBundledCatalog, parseModelsDevCatalog } from "./catalog.ts";

// Milestone 9 (F-148, ADR 0070, Q335): each catalog model's input modalities, from models.dev's
// `modalities.input`, so OpenCode is told which models see images (research
// `attachments-for-agents.md` §1: an entry without `modalities` is text only to OpenCode).

/** One model in the live v1 API's shape (fields as `https://models.dev/api.json` spells them). */
const liveShaped = (id: string, extra: Record<string, unknown>) => ({
  id,
  name: id,
  attachment: true,
  reasoning: false,
  tool_call: true,
  release_date: "2026-01-01",
  last_updated: "2026-01-01",
  open_weights: false,
  limit: { context: 200_000, output: 64_000 },
  cost: { input: 1, output: 4 },
  ...extra,
});

const entriesOf = (models: Record<string, Record<string, unknown>>): readonly CatalogEntry[] => {
  const parsed = parseModelsDevCatalog({ acme: { id: "acme", name: "Acme", npm: "@ai-sdk/anthropic", models } });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
};

const modalitiesById = (entries: readonly CatalogEntry[]): Record<string, readonly InputModality[] | null> =>
  Object.fromEntries(entries.map((entry) => [entry.catalogId, entry.inputModalities]));

describe("the catalog's input modalities (F-148)", () => {
  it("F-148/c5: catalogEntries keeps modalities.input, drops unknown values, and gives null without it", () => {
    const entries = entriesOf({
      vision: liveShaped("vision", { modalities: { input: ["text", "image", "pdf"], output: ["text"] } }),
      "text-only": liveShaped("text-only", { modalities: { input: ["text"], output: ["text"] } }),
      // models.dev's order isn't ostra's, a value it may add later is dropped, and each is kept once.
      unordered: liveShaped("unordered", { modalities: { input: ["video", "image", "hologram", "text", "image", 7, null, "audio"], output: ["text", "image"] } }),
      // Nothing ostra names: an empty list, which is still a statement, not unknown.
      strange: liveShaped("strange", { modalities: { input: ["smell"], output: ["text"] } }),
      // No `modalities`, or one without a list: nobody said.
      silent: liveShaped("silent", {}),
      "null-modalities": liveShaped("null-modalities", { modalities: null }),
      "no-input": liveShaped("no-input", { modalities: { output: ["text"] } }),
      "input-not-a-list": liveShaped("input-not-a-list", { modalities: { input: "text,image", output: ["text"] } }),
    });
    expect(modalitiesById(entries)).toEqual({
      "acme/vision": ["text", "image", "pdf"],
      "acme/text-only": ["text"],
      "acme/unordered": ["text", "image", "audio", "video"],
      "acme/strange": [],
      "acme/silent": null,
      "acme/null-modalities": null,
      "acme/no-input": null,
      "acme/input-not-a-list": null,
    });
  });

  it("F-148/c5: the bundled copy keeps each model's modalities.input, so a server that never fetches still knows which models see images", async () => {
    const byId = modalitiesById((await loadBundledCatalog()).entries);
    expect(byId["anthropic/claude-sonnet-4-5"]).toEqual(["text", "image", "pdf"]);
    expect(byId["openai/gpt-5"]).toEqual(["text", "image"]);
    expect(byId["deepseek/deepseek-v4-pro"]).toEqual(["text"]);
    // Every entry the refresh kept carries the list, as models.dev gives one for every model.
    expect(Object.values(byId).filter((modalities) => modalities === null)).toEqual([]);
  });

  it("F-148/c5: a malformed modalities costs that model its modalities alone, never its other fields or the catalog", () => {
    const entries = entriesOf({
      broken: liveShaped("broken", { modalities: { input: { image: true } } }),
      fine: liveShaped("fine", { modalities: { input: ["text", "image"], output: ["text"] } }),
    });
    const broken = entries.find((entry) => entry.catalogId === "acme/broken");
    expect(broken).toMatchObject({ name: "broken", contextWindow: 200_000, maxOutputTokens: 64_000, inputModalities: null });
    expect(entries.find((entry) => entry.catalogId === "acme/fine")?.inputModalities).toEqual(["text", "image"]);
  });
});
