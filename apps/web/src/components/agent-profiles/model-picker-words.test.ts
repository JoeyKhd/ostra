import { describe, expect, it } from "vitest";

import { disambiguatorsOf } from "./model-picker-words";

// F-088: the profile's model picker tells apart two models of one name that one key lists.

const option = (text: string, displayName: string, providers: readonly (readonly [string, string])[], kind: "catalog" | "custom" = "catalog") => ({
  name: { kind },
  text,
  displayName,
  providers: providers.map(([providerId, endpointModelId]) => ({ providerId, endpointModelId })),
});

describe("the model picker's endpoint IDs", () => {
  it("F-088: two listed models of one name on one key show that key's endpoint IDs; on different keys, or with their own names, none", () => {
    const options = [
      // One key lists two catalog models the catalog gives one name.
      option("alibaba/qwen3.8-max-0902", "Qwen3.8 Max 0902", [["dev", "qwen/qwen3.8-max-0902"], ["acme", "qwen3.8-max"]]),
      option("qwen/qwen3.8-max-0902", "Qwen3.8 Max 0902", [["dev", "qwen/qwen3.8-max-0902-preview"]]),
      // One name on two keys that don't share one: the keys column tells them apart.
      option("anthropic/claude-sonnet", "Claude Sonnet", [["anthropic", "claude-sonnet-5"]]),
      option("openrouter/claude-sonnet", "Claude Sonnet", [["openrouter", "anthropic/claude-sonnet-5"]]),
      // A custom model is shown by its endpoint ID, so a catalog model's name doesn't clash with it.
      option("qwen3.8-27b-ft", "Qwen3.8 27B", [["dev", "qwen3.8-27b-ft"]], "custom"),
      option("qwen/qwen3.8-27b", "Qwen3.8 27B", [["dev", "qwen/qwen3.8-27b"]]),
    ];
    expect(Object.fromEntries(disambiguatorsOf(options))).toEqual({
      "alibaba/qwen3.8-max-0902": "qwen/qwen3.8-max-0902",
      "qwen/qwen3.8-max-0902": "qwen/qwen3.8-max-0902-preview",
    });
  });
});
