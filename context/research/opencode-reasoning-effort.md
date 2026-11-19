# Reasoning effort in OpenCode 2.3.2, models.dev and ACP

**Question.** The maintainer, 2026-11-19: "it doesn't seem that our models have support for the reasoning effort towards opencode?" How does OpenCode 2.3.2 take a reasoning effort for the two provider packages ostra uses? Does models.dev say which models reason, and which levels each one takes? Can an ACP client change the effort during a session? And what do the fixed limits in ostra's per-task config do to OpenCode?

**Checked:** 2026-11-19, against OpenCode's source at the pinned tag, its docs at the same tag, models.dev's source and its live API, the ACP spec and the installed ACP SDK, and Anthropic's and OpenAI's own docs. Every claim cites a source key from the list below. A claim no source settles is marked **inferred** or **unverified**.

**How it was read.** OpenCode's repo was cloned at the tag `v2.3.2`, into a folder of its own, and read, never built. That tag is commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` (2026-11-18 00:28 UTC), and the repo is the one `@opencode/cli` 2.3.2's `package.json` names (`git+https://github.com/anomalyco/opencode.git`). models.dev's repo was read at its `HEAD` of the day, and both of its APIs were downloaded and counted with a small script.

**How it was run.** A probe drove the pinned binary, the `@opencode/cli-windows-x64@2.3.2` that `pnpm install` puts in the repo, over ACP on stdio, with plain JSON-RPC. It wrote the per-task files with ostra's own `launchFiles`, `buildAgentEnv` and `taskDirs` (`packages/adapters/adapter-opencode/src/config.ts`, imported as is), and it pointed the provider at a local stub. Then it sent `initialize`, `session/new`, `session/set_config_option` and `session/prompt`, and once a kill and a `session/load`. The stub answered every call with a one-word reply in the right format and recorded the body fields that matter. Each scenario changed one thing in the files ostra writes (table in section 1.7). This was on Windows 11 with Node 24.14.0, on 2026-11-19, and the cites are `[RUN Sn]`. The probe was a scratch script outside the repo, not a spike. The contract test that ticket 57 adds runs the same cases (section 7).

## Summary

1. **OpenCode takes effort as a model *variant*.** A variant is a named overlay of `settings`, `headers` and `body` applied after the provider's and the model's ([OC] `packages/core/src/model-resolver.ts:166-191`; [OCD] `models.mdx:81-125`). OpenCode builds each model's variants from models.dev's `capabilities.reasoning`, spelled for the model's provider package ([OC] `packages/core/src/variant.ts:13-38`). **OpenAI-compatible:** each level becomes `reasoning_effort: "<level>"` in the request ([OC] `variant.ts:90-93`; `openai-chat.ts:860`). **Anthropic-compatible:** the model ID decides. A current Claude, or any non-Claude ID, gets `thinking: {type: "adaptive"}` plus `output_config.effort`. An older Claude gets `thinking.budget_tokens`. And `none` turns thinking off ([OC] `variant.ts:325-355`). `default`, or no variant, sends nothing, so the endpoint's own default applies ([OC] `model-resolver.ts:170`). A model with `reasoning.supported: false`, or one that reasons with no control listed, gets no variants and no effort ([OC] `variant.ts:14`; [OCD] `models.mdx:151`).
2. **models.dev lists the levels per model.** It's not a yes/no. Its v1 API, the one ostra fetches, has `reasoning` (a boolean) and `reasoning_options`: a list of `{type: "toggle"}`, `{type: "effort", values}` and `{type: "budget_tokens", min, max}` ([MD] `packages/core/src/schema.ts:25-70,257-258`). In the live v1 API of 2026-11-19, 7,732 tool-calling models reason. 5,476 of them list effort values, and the sets differ: `["none","low","medium","high","xhigh"]` for GPT-5.5, `["medium","high","xhigh"]` for GPT-5.2 Pro, `["low","high","max"]` for DeepSeek V4 Pro ([MDV1]). Others list only a toggle or a budget, and 1,174 reasoning models list no control. ostra's bundled copy keeps none of this: its refresh script drops `reasoning` and `reasoning_options` ([OS] `adapter-model-endpoint/scripts/refresh-catalog.ts:43-53`).
3. **ACP can change it mid-session, and OpenCode 2.3.2 supports it.** The spec reserves the config-option category `thought_level` and lets a client change an option "at any point during a session, whether the Agent is idle or generating a response" ([ACP] lines 227, 255). OpenCode advertises an option `effort` (category `thought_level`) whenever the model has variants. Its values are the variants plus `default`, and `session/set_config_option` switches the session's variant ([OC] `packages/cli/src/acp/config-option.ts:22-68,87-92`; [OCD] `cli/acp.mdx:158-172`). The probe saw the next request carry the new level, saw the level survive a kill and a `session/load`, and saw a level the model lacks refused with `-32602` ([RUN S1, S2, S13, S14]).
4. **Today ostra's tasks already advertise an effort, with guessed levels, and never use it.** The catalog file ostra writes for OpenCode lacks `release_date`, so OpenCode drops its one model ([OC] `models-dev/v1.ts:33,107`; [RUN S4]). The model then comes only from the config, as a custom model, and a custom model gets OpenCode's default effort variants: `low, medium, high` on OpenAI-compatible, `low` to `max` on Anthropic-compatible, whatever the real model is ([OC] `config/plugin/provider.ts:120-137`; [RUN S1, S2, S3]). ostra never sets one, so every request goes at `default` and sends no effort ([RUN S1, S2]).
5. **The fixed limits are wrong in both directions.** OpenCode asks each primary request for up to `limit.output` tokens. That's 16,000 from ostra today ([OC] `session/model-request.ts:96-104`; [RUN S1, S2]). Anthropic counts thinking inside `max_tokens` ([ANT-T] line 284). OpenCode also compacts at the window minus the larger of 15% and 16,000 tokens. With ostra's 128,000, that's at 108,800 tokens on every model ([OC] `session/compaction.ts:126-132,1151-1159`). A 1,000,000-token model compacts at about a tenth of its window, a model at high effort is cut off at 16,000 tokens of thinking and reply together, and a model with a smaller window than 128,000 is sent more than it takes.
6. **Cost: the count needs no change, but the price can.** Both formats bill reasoning as output and count it inside the output figure ([OAI-G]; [ANT-T] line 296). ostra's meter counts output that way, so the totals and the spend are right wherever reasoning is priced as output ([OS] `adapter-sdk/src/model/usage.ts:23,138-148`). ostra keeps the reasoning subset only for OpenAI, stores it nowhere, and doesn't read Anthropic's `output_tokens_details.thinking_tokens` ([OS] `usage.ts:177-186`). In the live v1 API, 99 models list a `cost.reasoning` that differs from their output price, and ostra applies none of them ([MDV1]).

## Sources

| Key | Source |
|---|---|
| [OC] | OpenCode at tag `v2.3.2`, commit `c0ad18b`, `https://github.com/anomalyco/opencode`. Paths are under `packages/` unless they start with `services/` |
| [OCD] | OpenCode's docs at the same commit, `services/site/src/docs/content/`: `models.mdx`, `config.mdx`, `cli/acp.mdx` (published at `https://opencode.ai/docs/`) |
| [SNAP] | OpenCode's bundled copy of models.dev's v2 catalog at the same commit: `packages/core/src/models-dev/snapshot.txt` (8,197,545 bytes) |
| [MD] | models.dev's source, `https://github.com/anomalyco/models.dev` at `ba846a5` (2026-11-19 12:31 UTC): `packages/core/src/schema.ts`, `packages/core/src/schema-v2.ts`, `README.md`, `.opencode/skills/audit-reasoning-options/SKILL.md` |
| [MDV1] | `https://models.dev/api.json`, fetched 2026-11-19 15:30 UTC, 6,769,506 bytes, 10,010 models |
| [MDV2] | `https://models.dev/experimental/v2.0/api.json?type=chat`, fetched 2026-11-19 15:30 UTC, 11,215,920 bytes, 9,482 models. The same request to `https://models.opencode.ai`, OpenCode's default source ([OC] `core/src/models-dev.ts:505,508`), returned the same size |
| [ACP] | ACP, "Session Config Options" (v1), `https://agentclientprotocol.com/protocol/v1/session-config-options.md`, read 2026-11-19 |
| [SDK] | `@agentclientprotocol/sdk` 2.7.0 as installed: `dist/v1/schema/types.gen.d.ts`, `MIGRATION_STABLE_UNSTABLE.md` |
| [ANT-T] | Anthropic, "Extended thinking", `https://platform.claude.com/docs/en/build-with-claude/extended-thinking.md`, read 2026-11-19 |
| [ANT-E] | Anthropic, "Effort", `https://platform.claude.com/docs/en/build-with-claude/effort.md`, read 2026-11-19 |
| [OAI-G] | OpenAI, "Reasoning models", `https://platform.openai.com/docs/guides/reasoning`, read 2026-11-19 |
| [OAI-S] | OpenAI's OpenAPI document, `https://github.com/openai/openai-openapi`, branch `manual_spec` at `498c71d`: `CompletionUsage`. It's an older document: its `ReasoningEffort` enum still reads "o-series models only", so it's cited for the usage field's shape alone |
| [OS] | ostra at `origin/main` `6f33bbb`, paths under `packages/` |
| [RUN Sn] | The probe (method above), scenario n of section 1.7 |
| [SPIKE1] | `context/research/spike-how-should-the-runner-drive-opencode.md` |

## 1. How OpenCode 2.3.2 takes a reasoning effort

### 1.1 The mechanism: variants

- A model is selected as `provider/model`, with an optional `#variant` ([OC] `schema/src/config/model.ts:18-36`; [OCD] `models.mdx:542-554`). "Variants are named options for one model, often used for reasoning effort or token budgets" ([OCD] `models.mdx:81`).
- A variant carries `settings`, `headers` and `body`, "applied after provider and model values" ([OCD] `models.mdx:125`; [OC] `schema/src/config/provider.ts:97-107`). The resolver merges the selected variant into the model for that request only ([OC] `core/src/model-resolver.ts:166-191`).
- The ID `default`, or no variant, applies no overlay ([OC] `model-resolver.ts:170`). An ID the model lacks fails with `VariantUnavailableError` ([OC] `model-resolver.ts:171-179`), and the docs say "an unknown variant produces a model-resolution error" ([OCD] `models.mdx:89`).

### 1.2 Where a model's variants come from

- **From models.dev.** OpenCode reads models.dev's v2 catalog, `/experimental/v2.0/api.json` from `https://models.opencode.ai` by default, or a bundled snapshot ([OC] `core/src/models-dev.ts:505-508`). For each model it calls `Variant.resolve` with `Variant.supports(capabilities.reasoning)` and the model's package ([OC] `core/src/models-dev.ts:215-218`).
- **From a catalog file.** A v1 catalog in `OPENCODE_MODELS_PATH` is converted to v2 first ([OC] `core/src/models-dev/v1.ts:3-6,96-112`). v1's `reasoning: true` with `reasoning_options` becomes v2's `{supported: true, toggle, effort, budget}`, and `reasoning` false or absent becomes `{supported: false}` ([OC] `v1.ts:161-181`).
- **From the config.** A model's `capabilities.reasoning` in the config, "in models.dev v2's shape", replaces the variants built from the catalog, and `variants` listed in the config overlay them ([OC] `core/src/config/plugin/provider.ts:239-260`; [OCD] `models.mdx:127-156`).
- **For a custom model, by default.** A configured model with no catalog base and neither `variants` nor `capabilities.reasoning` gets `Variant.resolve(model)` with its default argument `[{type: "effort"}]`. That's effort variants guessed from the package alone ([OC] `config/plugin/provider.ts:120-137`; `variant.ts:29`).
- **What the four fields do** ([OCD] `models.mdx:151-154`): "`supported`: Whether the model reasons. `false`, or `true` without controls, adds no variants." "`toggle`: Adds a `none` variant that turns reasoning off." "`effort`: Effort levels to offer. `default` keeps the provider default and adds no variant." "`budget`: Optional `min` and `max` thinking tokens. Ignored when `effort` is set."

### 1.3 `@opencode/ai/providers/openai-compatible`

`Variant.resolve` maps this package to `openaiCompatible`, which is `openaiChat` for every provider but `nvidia` ([OC] `core/src/variant.ts:249-252,628`).

| Control in `capabilities.reasoning` | Variants | What a variant sends |
|---|---|---|
| `effort: [values]` | one per value, `default` left out ([OC] `variant.ts:17-19`) | `settings.reasoningEffort` → the body's `reasoning_effort` ([OC] `variant.ts:90-93`; `ai/src/protocols/openai-chat.ts:233,860`) |
| none listed (a custom model's default) | `low`, `medium`, `high` ([OC] `variant.ts:40,92`) | the same |
| `toggle` only, or `budget` only | none: `openaiChat` handles only effort ([OC] `variant.ts:90-91`) | nothing |
| `supported: false` | none | nothing |

- The value is passed through as a string ([OC] `ai/src/schema/options.ts:191-199`). OpenCode knows `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, and accepts any string.
- [RUN S1, S6, S7] saw `reasoning_effort` at `high`, `max` and `low`, and none at `default`.

### 1.4 `@opencode/ai/providers/anthropic-compatible`

This package maps to `anthropicMessages` ([OC] `variant.ts:658`), which reads the Claude family and version from the model ID ([OC] `variant.ts:68-82`).

| Model ID | `effort` listed (or a custom model's default) | `toggle` | `budget` |
|---|---|---|---|
| Claude 4.6 and later, and **any ID that isn't a Claude** | each value: `thinking: {type: "adaptive", display: "summarized"}` and `effort: <value>`. `none` sends `thinking: {type: "disabled"}`. A custom model's default is `low, medium, high, xhigh, max`, or `low, medium, high, max` for 4.6 ([OC] `variant.ts:329-339`) | `none` and `thinking`: disabled, or adaptive ([OC] `variant.ts:341-346`) | `high` and `max`, as `thinking: {type: "enabled", budgetTokens}` ([OC] `variant.ts:347-353`) |
| Claude 3.7 and 4.0 to 4.5 ("manual"), Opus 4.5 aside | an effort list is turned into a budget, `high` and `max` ([OC] `variant.ts:79,330`) | `none` and `thinking`, thinking with a 16,000-token budget ([OC] `variant.ts:84-88`) | as above |
| Fable and Mythos ("always thinks") | as the first row, without `none` ([OC] `variant.ts:80,334`) | none | as above |

- **The budget's two levels.** `high` is half the ceiling and `max` is the ceiling less one. The ceiling is the smallest of the listed `max`, the model's `limit.output` and 32,000 ([OC] `variant.ts:43,54-64`). The protocol then fits the budget under `max_tokens` ([OC] `ai/src/protocols/anthropic-messages.ts:1011-1018`).
- **On the wire,** `effort` reaches the body as `output_config.effort` ([OC] `anthropic-messages.ts:1023-1047`). [RUN S2] saw `{thinking: {type: "adaptive", display: "summarized"}, output_config: {effort: "high"}}`, then `"max"`. [RUN S9] saw `thinking: {type: "disabled"}` for `none`. [RUN S10] saw `budget_tokens` of 16,000 and 31,999 for a Claude Sonnet 4.5 ID with a 64,000-token output limit.
- **Unverified:** whether a non-Claude model behind an Anthropic-format endpoint accepts `thinking: {type: "adaptive"}`. OpenCode sends it for any ID that isn't a Claude ([OC] `variant.ts:329-332`; [RUN S11]). The probe's stub accepts everything.
- Anthropic's own docs agree on the levels. Effort runs `low`, `medium`, `high`, `xhigh` and `max`, "Not every model that supports `max` supports `xhigh`", and manual `budget_tokens` is deprecated: "Claude 4.7 and later models … reject requests that use it" ([ANT-E] lines 257-267; [ANT-T] line 26).

### 1.5 A model that doesn't reason

`{supported: false}`, or `true` with no control, gives no variants ([OC] `variant.ts:14`). The ACP agent then advertises no effort option ([OC] `cli/src/acp/config-option.ts:36`), and nothing is sent ([RUN S4, S5, S8]).

### 1.6 Which variant a session uses

- A session uses its own model if it has one, else its agent's model (with the agent's variant), else the default model with **no** variant ([OC] `core/src/session/runner/model.ts:89-99`).
- The config's root `model` keeps no variant. The model editor's `default.set` takes only a provider and a model ([OC] `plugin/src/effect/model.ts:14-17`; `config/plugin/provider.ts:101`), and the docs say so: "The root `model` currently retains only the default provider and model, not a variant" ([OCD] `models.mdx:57,582-583`).
- An agent's `model` in the config does keep `#variant` ([OC] `core/src/config/plugin/agent.ts:86-91`), and [RUN S12] saw its requests carry it. **But ACP's effort option still said `default`** in that run, because the ACP side reads the session's own model, which a new session doesn't have ([OC] `cli/src/acp/config-option.ts:18-20`; `sessions.ts:131`). So a level set only in the config is applied and misreported.
- Title calls take the lowest of `none`, `minimal` and `low` that the model has, but `low` only when it's below the session's level ([OC] `core/src/session/context.ts:201-214`). [RUN S6, S12, S14] saw the title call carry `low`.

### 1.7 The probe's scenarios

"Today" means ostra's files exactly as `launchFiles` writes them ([OS] `adapters/adapter-opencode/src/config.ts:97-166`). Each other row changes one thing.

| # | Files (format, model ID) | `effort` option at `session/new` | What the requests carried |
|---|---|---|---|
| S1 | today, OpenAI-compatible, `gpt-5.5` | `low, medium, high, default`; current `default` | at `default`: no `reasoning_effort`, `max_completion_tokens: 16000`. After `effort=high`: `reasoning_effort: "high"` |
| S2 | today, Anthropic, `claude-sonnet-5` | `low, medium, high, xhigh, max, default` | at `default`: no `thinking`, no `output_config`, `max_tokens: 16000`. At `high` and `max`: adaptive thinking and `output_config.effort` |
| S3 | today, Anthropic, `glm-5.3` | `low` to `max`, `default` | at `default`: neither |
| S4 | the catalog entry plus `release_date` only | **none** | (the entry now decodes, with no `reasoning`) |
| S5 | catalog plus `release_date`, `reasoning: false` | none | |
| S6 | catalog plus `release_date`, `reasoning: true`, `reasoning_options: [toggle, effort low/high/max]` | `low, high, max, default` | `max` → `reasoning_effort: "max"` |
| S7 | config `capabilities.reasoning: {supported, toggle, effort: [low, high, max]}`, OpenAI-compatible | `low, high, max, default` | `low` → `reasoning_effort: "low"` |
| S8 | config `{supported: false}`, Anthropic | none | no `thinking` |
| S9 | config `{supported, toggle}`, Anthropic, `claude-sonnet-5` | `none, thinking, default` | `thinking` → adaptive; `none` → `{type: "disabled"}` |
| S10 | config `{supported, budget: {min: 1024}}`, `claude-sonnet-4-5`, limit 200,000 / 64,000 | `high, max, default` | `budget_tokens` 16,000, then 31,999; `max_tokens: 64000` |
| S11 | config `effort: [low, high, max]`, Anthropic, `glm-5.3` | `low, high, max, default` | adaptive and `output_config.effort: "low"` |
| S12 | today, plus `agents.build.model: "ostra/gpt-5.5#high"` | current **`default`** | `reasoning_effort: "high"` |
| S13 | S1, then `effort=xhigh` | | refused: `-32602 Invalid params: effort not found: xhigh` |
| S14 | S1, `effort=high`, a prompt, kill, `session/load` | after the load: current `high` | `reasoning_effort: "high"` |
| S15 | S2 with limit 1,000,000 / 128,000, `effort=high` | | `max_tokens: 128000` |

## 2. models.dev: which models reason, and which levels each takes

### 2.1 The schema

- **v1, the API ostra fetches** (`/api.json`). `reasoning` is a required boolean. `reasoning_options` lists the controls: `{type: "toggle"}`, `{type: "effort", values: [...]}` with values from `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `default`, and `{type: "budget_tokens", min?, max?}` ([MD] `schema.ts:25-70,257-258`). A reasoning model must set it, and a non-reasoning one must not ([MD] `schema.ts:318-333`). `cost.reasoning` is "Cost per million reasoning tokens" ([MD] `schema.ts:76`; `README.md:265`). The README says `reasoning_options` is derived "from `capabilities.reasoning`" ([MD] `README.md:236`).
- **v2.** `capabilities.reasoning` is `{supported: false}` or `{supported: true, default?, toggle?, effort?, budget?}`. `default` is `{type: "toggle" | "effort" | "budget", value}` ([MD] `schema-v2.ts:144-204`). `capabilities.effort_updates` is always stated in the API ([MD] `schema-v2.ts:277-300`).
- **The controls are per host.** "Reasoning controls … are per host and go in provider files" ([MD] `README.md:134`). The audit skill: "Provider capability = this host's HTTP request surface", effort values are "sorted low to high", and "`reasoning = { supported = true }` with no `toggle` / `effort` / `budget` = model reasons, **no** caller control" ([MD] `SKILL.md:10,24,26`).

### 2.2 The data

| | live v1 [MDV1] | live v2 [MDV2] | OpenCode's snapshot [SNAP] |
|---|---|---|---|
| Models | 10,010 | 9,482 | 8,787 |
| That reason | 7,924 | 7,805 | 6,763 |
| That reason and call tools | 7,732 | 7,670 | 6,548 |
| … of which list effort values | 5,476 | 5,421 | 4,395 |
| List a toggle / a budget (any model) | 1,612 / 626 | 1,623 / 624 | 1,441 / 604 |
| Reason with no control listed | 1,174 | 1,148 | 1,135 |

The most common effort sets in [MDV1] are `low…max` (834 models), `low, medium, high` (807), `low, high, max` (608) and `none…max` (389). Individual models differ ([MDV1]):

| Model | `reasoning_options` |
|---|---|
| `anthropic/claude-sonnet-5` | toggle, effort `low, medium, high, xhigh, max` |
| `anthropic/claude-sonnet-4-5` | budget, min 1,024 |
| `openai/gpt-5.5` | effort `none, low, medium, high, xhigh` |
| `openai/gpt-5.2-pro` | effort `medium, high, xhigh` |
| `deepseek/deepseek-v4-pro` | toggle, effort `low, high, max` |
| `zai/glm-5.2` | toggle, effort `high, max` |

### 2.3 What ostra keeps

ostra's catalog schema reads `id`, `name`, `tool_call`, `limit` and `cost` ([OS] `adapters/adapter-model-endpoint/src/catalog.ts:14-20`). The refresh script writes only those ([OS] `scripts/refresh-catalog.ts:43-53`), and the bundled copy (fetched 2026-11-18 20:52 UTC, 8,972 models) holds no `reasoning` field (counted). `Model` has `contextWindow` and `maxOutputTokens`, and nothing about reasoning ([OS] `db/prisma/schema.prisma:456-486`).

## 3. ACP: changing the effort during a session

- **The spec.** A config option may carry a `category`. `thought_level` is reserved for "Thought/reasoning level selector", and categories "MUST NOT be required for correctness" ([ACP] lines 213-227). "The current value of a config option can be changed at any point during a session, whether the Agent is idle or generating a response" ([ACP] line 255). The response to `session/set_config_option` holds "the **complete** configuration state", because "changing the model may change the available reasoning options" ([ACP] lines 304, 374-377). The SDK types `thought_level` in the stable v1 schema ([SDK] `types.gen.d.ts:2047`), but `configOptions` on `session/new` and `session/load` still needs its `/unstable` entry ([SDK] `MIGRATION_STABLE_UNSTABLE.md:118`). ostra's driver already imports it ([SPIKE1] section 3, item 14).
- **What OpenCode advertises.** `session/new`, `session/load`, `session/resume` and `session/fork` return `model`, then `effort` (category `thought_level`, "Present only for models with variants"), then `mode` ([OCD] `cli/acp.mdx:158-172`; [OC] `cli/src/acp/config-option.ts:22-68`). The `effort` values are the model's variant IDs plus `default`, and the current value is the session's variant or `default` ([OC] `config-option.ts:44-45,138-143`). [RUN S1] saw `model:model, effort:thought_level, mode:mode`.
- **Setting it.** `session/set_config_option {configId: "effort", value}` checks the value against the model's variants ([OC] `config-option.ts:87-92`). OpenCode then calls its server's `session.switchModel` with the model and the variant ([OC] `cli/src/acp/sessions.ts:183-191`), and answers with the full option list ([OC] `service.ts:244-250`). A value the model lacks is `InvalidEffortError`, retried once after a catalog reload ([OC] `service.ts:81-86`), and the probe saw it reach the client as `-32602` ([RUN S13]). The model option takes `provider/model/variant` too ([OCD] `cli/acp.mdx:165`). OpenCode sent no `config_option_update` for a change the client made ([RUN S1] counted none; [SPIKE1] item 12 saw the same for a mode change), so the client reports its own change, as ostra's driver already does for the model ([OS] `adapter-sdk/src/agent/acp/driver.ts:440-445`).
- **When it takes effect.** At the next model request. "A model request already in progress keeps the settings it started with" ([OCD] `models.mdx:587-588`). A model set the same way during a turn took effect at that turn's next call ([SPIKE1] T10). That an effort set mid-turn behaves the same is **inferred**: it goes through the same `switchModel`.
- **It's kept with the session.** The variant is part of the session's model ([OC] `session/runner/model.ts:89-91`). After a kill and a `session/load`, the option read `high` and the next request carried it ([RUN S14]). **Untested:** a session moved by `opencode session export` and `import` (ADR 0039's fresh box). A rebuild-template session is a new session, so it starts at `default`.

## 4. The limits: what OpenCode does with `limit.context` and `limit.output`

- **The output limit.** Each primary request asks for `min(limit.output, 256,000)`, lowered to the room the prompt leaves in the window less 1%, and never below 1,024 ([OC] `core/src/session/model-request.ts:55-65,96-104,299-305`). Title calls set none ([OC] `model-request.ts:292-305`), so the Anthropic protocol falls back to 32,000 ([OC] `anthropic-messages.ts:41,1048`; [RUN S2]). The field is `max_completion_tokens`, or `max_tokens` for the providers that need it ([OC] `openai-chat.ts:765-801,906-908`).
- **The context window and compaction.** Automatic compaction starts at the usable window (`limit.input` if smaller) minus the larger of 15% and 16,000 tokens. The 16,000 applies only when the window is at least 32,000 ([OC] `core/src/session/compaction.ts:126-132,1151-1159,1173-1174`). An unknown window never compacts automatically ([OC] `compaction.ts:291`), and a provider's "too long" rejection triggers an overflow compaction that retries at 85% of the rejected size ([OC] `compaction.ts:123-124,313-317`). The `buffer` setting overrides the share ([OCD] `config.mdx:356-372`).
- **Reasoning shares both limits.** Anthropic: "Thinking tokens count toward the `max_tokens` limit", and "`max_tokens` remains the hard ceiling on total output" ([ANT-T] lines 284, 287). For agentic coding it says "set `max_tokens` to 128,000, the model's maximum", and "At `high` and above, set a large `max_tokens`" ([ANT-E] lines 283, 309). OpenAI: reasoning tokens "occupy space in the model's context window and are billed as output tokens". A reply that reaches `max_output_tokens` or the window ends `incomplete`, "meaning you could incur costs for input and reasoning tokens without receiving a visible response" ([OAI-G]).
- **What ostra sends.** Every model gets `limit: {context: 128000, output: 16000}`, in the config and in the catalog file ([OS] `adapters/adapter-opencode/src/config.ts:36-37,101,162`). With a real limit, OpenCode asks for it ([RUN S15]: `max_tokens: 128000`).

| The model's real limit | What goes wrong with ostra's fixed values |
|---|---|
| Window above 128,000 (Claude Sonnet 5 and GPT-5.5 list about 1,000,000 [MDV1]) | Compaction at 108,800 tokens, about 11% of a 1,000,000 window. Summaries cost calls and lose detail long before they're needed |
| Window below 128,000 | OpenCode sends up to 108,800 tokens before compacting. Past the real window, the provider rejects the request, and OpenCode recovers by an overflow compaction and a retry (cost and latency) |
| Output above 16,000 (128,000 on both models above) | Thinking and reply together stop at 16,000. At `high` effort a long edit or a long thought is cut (`length`), and with OpenAI the reasoning is billed with no visible answer. Budget variants are sized from 16,000 too: 8,000 and 15,999 instead of 16,000 and 31,999 ([OC] `variant.ts:54-64`; [RUN S10]) |
| Output below 16,000 | OpenCode asks for more than the model gives. Whether an endpoint rejects it or clamps it is **unverified** |

## 5. Cost: are reasoning tokens counted?

- **OpenAI-compatible.** Reasoning tokens "are billed as output tokens", and the usage object reports them as a subset, under `output_tokens_details.reasoning_tokens` in the Responses API ([OAI-G]). Chat Completions has `completion_tokens_details.reasoning_tokens`, "Tokens generated by the model for reasoning" ([OAI-S] `CompletionUsage`). OpenCode reads `completion_tokens` as the inclusive total with `reasoning_tokens` inside it. It adds the two only when `total_tokens` shows a provider counted reasoning beside the completion (Copilot's Gemini) ([OC] `ai/src/protocols/openai-chat.ts:960-1000`).
- **Anthropic Messages.** Thinking counts toward `max_tokens` ([ANT-T] line 284). `usage.output_tokens_details.thinking_tokens` "reports how many of the billed output tokens were internal reasoning", and when streaming "this breakdown appears only on the final `message_delta` event" ([ANT-T] line 296). OpenCode reads it the same way ([OC] `anthropic-messages.ts:1095-1131`).
- **ostra's count.** The key proxy's `output` is `completion_tokens` or `output_tokens`, so it includes reasoning in both formats. Its `reasoning` field is "informational: already included in `output`" ([OS] `adapter-sdk/src/model/usage.ts:17-25,138-160`). For Anthropic it's always 0 ([OS] `usage.ts:177-186`). It isn't on `usage.recorded` ([OS] `protocol/src/events/agent-events.ts:648-658`), nor on `Session` or `Turn` ([OS] `schema.prisma:1355-1359,1401-1407`).
- **So:** the token count is right, and spend is right wherever reasoning is priced as output. That's every model but the ones whose catalog lists a separate reasoning price: 243 models in [MDV1] list `cost.reasoning`, and 99 of them differ from their output price (`alibaba/qwen3-32b` lists 2.8 for output and 8.4 for reasoning, `perplexity/sonar-deep-research` 8 and 3). ostra prices those reasoning tokens at the output price.

## 6. What's still unverified

- **Real endpoints.** Every request in section 1.7 went to a stub. Three things need a live run: whether the endpoints in `model.env` accept each level, whether an OpenAI-compatible relay passes `reasoning_effort` through, and whether a non-Claude Anthropic-format endpoint takes adaptive thinking. Because models.dev's controls describe one host, a relay's real controls may differ from the first-party entry ostra matched ([MD] `README.md:134`; `SKILL.md:30-40`).
- **One platform.** Windows only, like [SPIKE1]. Linux and macOS didn't run.
- **Mid-turn.** A level set during a running turn, on a real model with several calls in the turn, wasn't run (section 3).
- **A fresh box.** Whether `session export` and `import` keep the variant (section 3).
- **An output limit below 16,000.** What an endpoint does with a larger `max_tokens` (section 4).
- **OpenAI's Chat Completions reference** renders client-side and couldn't be read, so the field's shape is from the older OpenAPI document [OAI-S], and its current values from the guide [OAI-G].

## 7. What this means for ostra

1. **The maintainer's suspicion is right, with a twist.** OpenCode 2.3.2 takes an effort, and ostra's tasks already advertise one. It's guessed from the API format, not taken from the model, because ostra's catalog file is skipped (no `release_date`) and its model is treated as custom. ostra never sets a level, so every task runs at the endpoint's default.
2. **The levels come from models.dev, per model.** Keep `reasoning` and `reasoning_options` in the bundled catalog and the daily fetch, and store them on each `Model` row. Offer a profile exactly the levels its model has, as far as the agent can send them: OpenCode on OpenAI-compatible can't send a toggle or a budget, and an older Claude's effort becomes a budget (sections 1.3, 1.4). Always offer `Default`, which sends nothing. Show no control for a model that doesn't reason, or that reasons with no control.
3. **Deliver the level over ACP, not as a config variant.** Set it with `session/set_config_option` on the option whose category is `thought_level` (OpenCode's `effort`), after every `session/new` and `session/load`. Then ACP's state and the requests agree (section 1.6, [RUN S12]), and a change on a running task is the same call. The per-task config should carry the model's own controls as `capabilities.reasoning`, so OpenCode's variants are the model's (section 1.2, [RUN S7 to S11]). A model without them gets `{supported: false}` (no effort at all), not OpenCode's guesses.
4. **A change on a running task is supported natively.** `session/set_config_option` works mid-session, takes effect at the next request, and survives `session/load` ([RUN S14]). For one level per turn, ostra should send it when the running turn has ended, not during it, and record each turn's level. A future agent without a `thought_level` option would need a relaunch with a new config and `session/load` (spike 1 measured 270 ms from spawn to `initialize` and 986 ms to a first token against a stub, [SPIKE1] T16, plus the replay of `session/load`), or no control at all. That's an optional capability.
5. **Never fail on a level.** OpenCode refuses a level the model lacks ([RUN S13]). Validate against the options OpenCode advertised for the session, and clamp a stored level the model doesn't have (after a model or catalog change) to the nearest one it does, before sending.
6. **Write the real limits.** The model's `contextWindow` and `maxOutputTokens` (catalog or admin) go into `limit`. Keep 128,000 and 16,000 only when neither is known (section 4, [RUN S15]). This matters most at high effort, where thinking spends the output limit.
7. **Fix or drop the catalog file.** At 2.3.2 it contributes nothing (section 1.7, S4). Either add `release_date` and the reasoning fields, so it agrees with the config, or stop writing it. The config alone defines the model either way. That OpenCode still fetches nothing without the file rests on `OPENCODE_DISABLE_MODELS_FETCH` ([SPIKE1] section 3, item 8), which this probe didn't test.
8. **Cost needs one small change.** The token count is right. Record the reasoning subset per call, including Anthropic's `thinking_tokens` from the final `message_delta`, so a turn can show what its effort cost. Applying models.dev's separate `cost.reasoning` for the 99 models where it differs belongs with F-037's prices.
9. **A custom model needs an admin's word.** Without a catalog entry there's nothing to read. An organization admin says whether it reasons, and which levels its endpoint takes. The same override helps a relay whose real controls differ from the entry ostra matched (section 6).
10. **Test it on every OpenCode bump.** The mapping in sections 1.3 and 1.4 is OpenCode's code, and the ACP option's ID is OpenCode's own. The agent contract suite should run section 1.7's cases against the pinned binary: each control shape and format, the advertised levels equal to what ostra offers, and the request body carrying each one.
