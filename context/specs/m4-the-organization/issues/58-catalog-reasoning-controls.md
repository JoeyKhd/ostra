# 58: Model catalog: each model's reasoning controls

Status: done
Builder: adapters
Blocked by: 04, 56
Features: F-137, F-088
Packages: `packages/adapters/adapter-model-endpoint` (`src/catalog.ts`, `scripts/refresh-catalog.ts`, `catalog/models-dev.json`), `packages/adapter-sdk` (`src/model-provider/base.ts`: `CatalogEntry`, the `ModelProviderAdapter` contract suite)
Spec: `../spec.md`, section 5.6; ADR 0066, ADR 0033 (amended); `context/research/opencode-reasoning-effort.md`, section 2

## What to build

- **The parse.** The catalog schema keeps `reasoning`, `reasoning_options` and `cost.reasoning`, which models.dev owns, so unknown fields are tolerated. Each entry becomes ticket 56's `reasoningControls` in v2's shape, the conversion OpenCode makes (research section 1.2):
  - `reasoning` false or missing → `{ supported: false }`
  - a `toggle` option → `toggle: true`
  - an `effort` option's values, with `null`, `"null"` and `default` dropped, in the scale's order → `effort`
  - a `budget_tokens` option's `min` and `max` → `budget`
  - `reasoning: true` with no option → `{ supported: true }`, which has no control
- **`CatalogEntry`** gains `reasoning` and `reasoningPriceDiffers` (models.dev lists a `cost.reasoning` that isn't its output price).
- **The refresh script** keeps those fields for every model it keeps. The bundled copy is refreshed with it, and its fetch date updated.
- **A malformed entry** loses its reasoning (`{ supported: false }`) and keeps the rest of the model and of the catalog, with a logged count, never the entry's text.

## Done when

- [x] Tests named `it("F-137: ...")`:
  - the conversion table above, each row from a fixture shaped like the live API's
  - the bundled copy holds the controls of `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-4-5`, `openai/gpt-5.5`, `openai/gpt-5.2-pro` and `deepseek/deepseek-v4-pro` as research section 2.2 lists them
  - a malformed `reasoning_options` refuses the reasoning alone
  - `reasoningPriceDiffers` for `alibaba/qwen3-32b`, and not for a model whose two prices match
- [x] The `ModelProviderAdapter` contract suite passes with the new fields.
- [x] Committed as `✨ keep each catalog model's reasoning controls`.

## Comments

- 2026-11-19: built in `✨ keep each catalog model's reasoning controls`. `CatalogEntry` gains `reasoning` (models.dev's v2 shape, `{ supported: false }` when an entry's controls don't parse, with the count logged as `catalog.reasoning-refused`) and `reasoningPriceDiffers`. The catalog schema reads `reasoning`, `reasoning_options` and `cost.reasoning` loosely and converts per model (`reasoningOf`), so a malformed entry never costs the catalog. The refresh script keeps the three fields, and the bundled copy is refreshed (2026-11-19, 9,022 tool-calling models). A control type ostra doesn't know is skipped, and an effort value off the scale refuses the entry's reasoning. Writing `catalogReasoning` on each model row is ticket 59's sync. Proofs in `context/proof/F-137.md`.
