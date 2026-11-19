# 57: Agent SDK and OpenCode: the effort capability, the levels and the real limits

Status: done
Builder: adapters
Blocked by: 02, 07, 56
Features: F-137, F-019
Packages: `packages/adapter-sdk` (`src/agent/capabilities.ts`, `src/agent/base.ts`, `src/agent/acp/driver.ts`, `src/agent/acp/map.ts`, `src/model/usage.ts`, `src/testing/fake-acp-agent/`, the agent contract suite), `packages/adapters/adapter-opencode` (`src/config.ts`, `src/opencode-adapter.ts`, its contract and live tests)
Spec: `../spec.md`, sections 4 ("Reasoning effort") and 5.6; ADR 0066; `context/research/opencode-reasoning-effort.md`, sections 1 and 7

## What to build

- **The capability** (`AgentCapabilities`): `reasoningEffort: "session-option" | "relaunch" | "none"`, documented like `planMode`. OpenCode declares `session-option`.
- **The levels.** The base class gains abstract `effortLevels({ reasoning, apiFormat, endpointModelId, limits })`, which returns the levels the agent can send for that model, low to high, with `default` first. An adapter with `none` returns `[default]`. It also gains `effortValue(level, sameInput)`, the agent's own value for a level.
- **Setting it.**
  - The driver's `newSession` and `loadSession` return the session's `configOptions` (the `/unstable` field), parsed loosely, since the agent owns their shape.
  - The base class's `setEffort(session, level)`:
    - with `session-option`: finds the option whose category is `thought_level`, clamps the level to the values it advertises (through `effortValue` and ticket 56's `clampEffort`), calls `setConfigOption`, and returns the `session.config_changed` event and the level used
    - with `relaunch`: goes through `StartSessionInput.relaunch`, as `planMode` does
    - with `none`: does nothing
  - A level the agent doesn't advertise is never sent.
- **The launch input.** `PrepareLaunchInput.model` gains `reasoning` and `limits`.
- **OpenCode's levels mirror its own `Variant.resolve` at 2.3.2** (research sections 1.3 and 1.4):
  - **OpenAI-compatible:** an effort list gives those levels, and a toggle or a budget alone gives none.
  - **Anthropic-compatible**, by the model ID's Claude family and version:
    - a current Claude, or any ID that isn't a Claude: the effort list; a toggle gives `none` and `on`; a budget gives `high` and `max`
    - a manual Claude (3.7, 4.0 to 4.5, but not Opus 4.5): an effort list becomes `high` and `max`
    - Fable and Mythos: no `none`
  - `effortValue` maps `on` to `thinking`, and every other level to its own name.
  - The test names the OpenCode version it was checked on.
- **OpenCode's config:**
  - `capabilities.reasoning` from the model's controls, or `{ supported: false }` when it has none
  - `limit: { context, output }` from `limits`, each falling back to today's 128,000 and 16,000 alone
  - the catalog file: add its `release_date` and the same reasoning fields so it decodes and agrees, or stop writing it. Pick one, and test that OpenCode still fetches nothing (`OPENCODE_DISABLE_MODELS_FETCH`, research section 7, item 7).
- **The usage meter:** Anthropic's `output_tokens_details.thinking_tokens` from the final `message_delta`, into `reasoning`, which stays a part of `output`.
- **The scripted fakes:** a `session-option` fake advertises a `thought_level` option and records each value set, and the existing fakes declare `none`.
- **The agent contract suite** gains cases that run, for OpenCode, against the pinned binary and an e2e stub endpoint recording request bodies, and on every OpenCode bump. They are the research's probe (section 1.7):
  - for each control shape (an effort list, a toggle, a budget, none, `supported: false`) in both formats, the levels `effortLevels` computes equal the values OpenCode advertises at `session/new`
  - each level reaches the next request's body: `reasoning_effort`; adaptive `thinking` with `output_config.effort`; `budget_tokens`; and `thinking: {type: "disabled"}` for `none`
  - `default` sends none of them
  - a level OpenCode doesn't advertise is clamped and never sent
  - a level survives a kill and `session/load`
  - the request's `max_tokens` or `max_completion_tokens` is the model's output limit

## Done when

- [x] Tests named `it("F-137: ...")`: every case above, on OpenCode and on the fakes (`session-option` and `none`).
- [x] The capability is declared by every adapter, and the fakes keep adapter parity tested (`AGENTS.md`).
- [x] The whole-repo checks pass (spec section 9): it runs agent output.
- [x] Committed as `✨ add reasoning effort to the agent interface`.

## Comments

- 2026-11-19: built in `✨ add reasoning effort to the agent interface`. `AgentCapabilities.reasoningEffort` is declared by every adapter (OpenCode `session-option`; the existing fakes, the tiny agent and the docs' sample `none`; a new `session-option` fake, `new FakeAgentAdapter("rich", undefined, undefined, "mcp", "session-option")`, whose option's ID is `reasoning`, not OpenCode's `effort`, so the base class finds it by category). The base class has abstract `effortLevels(model)`, `effortValue(level, model)` and `setEffort(session, level, model)`: it takes the model (`effortModelOf(spec model)`) because `effortValue` reads it; the runner (ticket 60) passes the spec's. The driver's `newSession` and `loadSession` return the session's `configOptions`, and `PrepareLaunchInput.model` gains `reasoning` and `limits`. OpenCode's levels are a port of its `Variant.resolve` at 2.3.2 (`adapter-opencode/src/effort.ts`, read from the tag's `packages/core/src/variant.ts`). The config carries `capabilities.reasoning` and the real `limit`; the catalog file now decodes (a `release_date`, the v1 reasoning fields, the same limits), and a recording proxy shows OpenCode still fetches nothing (removing `OPENCODE_DISABLE_MODELS_FETCH` makes it call `models.opencode.ai`). The key proxy reads Anthropic's `thinking_tokens`. The shared suite's cases are `adapter-sdk/src/testing/agent-effort-cases.ts`; the proof cites the OpenCode-named and fake-named tests, since `check:proof` takes `*.test.ts` files only. Proofs in `context/proof/F-137.md`.
