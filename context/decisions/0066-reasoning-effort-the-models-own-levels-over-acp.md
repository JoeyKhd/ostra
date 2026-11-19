# Reasoning effort: the model's own levels, set over ACP, one level a turn

**Status:** accepted (2026-11-19). Settles Q285 to Q292. Covers F-137. The maintainer answered two questions. A change on a running task is in v1, and a level a model doesn't have is hidden or clamped, never an error at run time. The lead settled the rest by the research's recommendation, pending the maintainer's review when ticket 62's design targets are approved (milestone 4). Amends ADR 0018 (a new optional capability), ADR 0033 (the catalog keeps each model's reasoning controls, and an admin can set a model's) and ADR 0049 (a profile sets an effort for its model). Builds on ADR 0032 (OpenCode over ostra's ACP driver), ADR 0036 (the driver), ADR 0042 (metering at the key proxy) and ADR 0065 (the model by name).

## Why

The maintainer, 2026-11-19: "it doesn't seem that our models have support for the reasoning effort towards opencode?" They are right, with a twist (`research/opencode-reasoning-effort.md`, "Summary"):

- OpenCode 2.3.2 takes an effort as a model variant, and its ACP agent advertises it as a session config option of category `thought_level`. ostra's tasks already advertise one.
- But the levels are guessed from the API format, not taken from the model. ostra's catalog file for OpenCode is skipped, because it has no `release_date`, so OpenCode treats the model as custom.
- ostra never sets a level, so every task runs at the endpoint's default.
- The per-task config also gives every model a 128,000-token window and a 16,000-token output limit. That compacts a 1,000,000-token model at about a tenth of its window, and cuts thinking and reply together at 16,000 tokens.

models.dev lists the levels per model, in `reasoning_options` (v1) and `capabilities.reasoning` (v2). 5,476 of the 7,732 tool-calling models that reason list effort values, and the sets differ from model to model (research, section 2).

## The level

**One vocabulary, models.dev's own** (Q285). A level is one of these:
- `default`: send nothing, so the endpoint's own default applies
- `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`: models.dev's effort values, in its order, low to high (research, section 2.1)
- `on`: reasoning switched on, for a model whose only control is a toggle

It's a protocol type, a closed union, and the panel labels the levels Default, Off, Minimal, Low, Medium, High, Extra high, Max and On.

**A model's levels are what its catalog entry lists, as far as its agent can send them** (Q285).
- Each model row keeps its reasoning controls in models.dev's v2 shape: `{supported: false}`, or `{supported: true, toggle?, effort?, budget?}`. They come from the catalog, or from an organization admin (below).
- The agent adapter turns the controls into the levels it can send for that model and API format, low to high, with `default` first.
- OpenCode's mapping is its own code (research, sections 1.3 and 1.4):
  - an effort list gives those levels
  - a toggle gives `none` and `on` on Anthropic Messages, and nothing on OpenAI-compatible
  - a budget gives `high` and `max`, sized from the model's output limit
  - an older Claude's effort list becomes that budget
- A model that doesn't reason, or reasons with no control, offers `default` alone, and the panel shows no control for it.

**A custom model, or an endpoint that differs from its catalog entry** (Q286).
- A custom model has no catalog entry, so an organization admin says whether it reasons and, if it does, which of the levels its endpoint takes. Until then it doesn't reason.
- The same form lets an admin override a catalog model's controls on one provider's listing. That's for a relay whose real controls differ from the entry ostra matched: models.dev's controls describe one host's API (research, section 6).
- The catalog's value stays beside the override, so a refresh never undoes it.

## Delivering it

**Over ACP, after every session start** (Q287).
- The runner sets the level with `session/set_config_option` on the option whose category is `thought_level`. It does so after every `session/new` and `session/load`, before the first prompt, and only when the level isn't `default`.
- It finds the option by category, not by OpenCode's ID `effort`, and checks the value against the option's advertised values first.
- The per-task config carries the model's controls as `capabilities.reasoning`, so OpenCode's variants are the model's and not its guesses (research, section 1.2). A model without them gets `{supported: false}`, and OpenCode then offers and sends no effort.

**Not as a variant in the config,** for three reasons:
- the root `model` keeps no variant
- an agent's `model` with `#variant` is applied, but ACP still reports `default` (research, section 1.6)
- a change on a running task would need the ACP call anyway

**The real limits** (Q290). The model row's context window and output limit, from the catalog or an admin, go into the config's `limit`. Only a model with neither known keeps today's 128,000 and 16,000. They size OpenCode's output request, its thinking budgets and its compaction point (research, section 4).

## Changing it on a running task

**From the task page, for the next turn** (Q288; the maintainer: "i would say so yes").
- The task's driver (F-024) picks a level from the model's levels. Core records it on the task, writes `effort.changed` in the thread with who and what, and sends the runner `set-effort`.
- The runner applies it when the running turn has ended, before the next prompt, or at the next session's start if none is running. Each turn records the level it ran at, on `turn.started`.
- ACP would take it mid-turn, effective at the agent's next model call (research, section 3). ostra holds it to the turn's end anyway, so a turn has one level, and its spend and its record say which. A member who wants it sooner uses "Interrupt and send" (F-024).
- The task's level is copied from the profile when the task is created. A later edit of the profile changes new tasks only.

**For an agent without a session option** (adapter parity, `AGENTS.md`), the capability is a closed union, like `planMode`:
- `"session-option"`: OpenCode, as above
- `"relaunch"`: an agent that reads its effort only at launch. The runner stops it between turns, writes the new level into its config and resumes it with `session/load`. That costs a process start (spike 1 measured 270 ms to `initialize` and under a second to a first token) and the history's replay.
- `"none"`: no control anywhere, and every task runs at the agent's default

## A level the model doesn't have

**Clamped, shown, never an error** (Q289; the maintainer: "hidden, or clamped to the nearest level the model has, but never an error at run time").
- The panel offers only the model's levels.
- A stored level can still stop fitting: the profile's model changed, the catalog refreshed, an admin changed the controls, or a project serves the model name from a listing with an override (ADR 0065). It's then clamped before the turn, in this order:
  1. `default` stays `default`.
  2. A level the model has stays.
  3. On a toggle-only model, `none` stays `none` and anything else becomes `on`.
  4. `on` on a model with effort levels becomes `default`.
  5. Anything else becomes the nearest level on models.dev's scale, the higher of two equally near.
  6. A model with no levels runs at `default`.
- The runner applies the same rule to the values the agent actually advertised, so a mapping that drifts on an OpenCode bump degrades to the nearest advertised value, never a refused call. OpenCode refuses an unknown value with `-32602` (research, section 3).
- The task page shows the level a turn ran at, and that it was adjusted, with the reason.

## Cost

**Counted as today, shown apart** (Q291).
- Both API formats bill reasoning as output and report it inside the output count. ostra's key proxy already counts it there, so totals and spend need no change (research, section 5).
- The proxy also records the reasoning subset where the endpoint reports it: OpenAI's `completion_tokens_details.reasoning_tokens`, and Anthropic's `output_tokens_details.thinking_tokens` from the final `message_delta`. It goes on `usage.recorded` and the turn, so a member sees what an effort cost.
- models.dev's separate `cost.reasoning`, listed for 243 models and different from the output price for 99 of them, isn't applied in v1. Reasoning tokens are priced as output, and the Models page marks a model whose catalog lists a different reasoning price. Pricing them apart is a later addition to F-037's prices, which this ADR doesn't schedule.

## Where it's built

**Milestone 4, tickets 56 to 63** (Q292).
- It needs the runner protocol's minor 3 (an `agent.effort`, the model's controls and limits in the task spec, a `set-effort` command, `turn.started.effort`, `usage.recorded.reasoningTokens`). Milestone 3 is past its contracts at minor 2, and milestone 4's ticket 01 makes minor 3.
- It sits on ADR 0065's model by name (tickets 45, 50 and 53), so the effort control is designed and built once, next to the model control that milestone 4 redesigns.
- A standalone release between milestones 3 and 4 would take minor 3 itself, and build the control on milestone 3's `modelId`, only for milestone 4 to move it.
- Its tickets depend only on milestone 4's contracts and the keys-per-project tickets, so they can start as soon as those are in.

## Considered options

- **The config's variant, at launch only.** A level in `agents.<name>.model` as `#variant`. Rejected: ACP misreports it, and a change on a running task would need a second path anyway.
- **A fixed set ("Default, Low, Medium, High") mapped per format.** Rejected: models.dev already lists each model's levels, and they differ. GPT-5.2 Pro has no `low`, and DeepSeek V4 has `max` but no `medium`, so a fixed set offers levels a model refuses and hides ones it has.
- **Applying a change at once, mid-turn.** ACP allows it, and OpenCode takes it at its next model call. Rejected for v1: a turn would run at two levels, and its record and spend couldn't say which. "Interrupt and send" covers the urgent case.
- **An error for a level the model lacks.** Rejected by the maintainer's answer. The clamp keeps a task running, and the page says what changed.
- **Keeping OpenCode's guessed levels for custom models.** Rejected: they're guesses from the API format, such as `xhigh` and `max` for any model behind an Anthropic-format endpoint, and the endpoint may refuse them.

## Consequences

- Protocol minor 3 gains the fields above. A task whose level isn't `default` goes only to a minor-3 runner (`needs-protocol`), and a minor-2 runner keeps its fixed limits, since it doesn't read the new fields.
- The agent interface gains `reasoningEffort` and `effortLevels`, so a second agent states both. The scripted fakes cover `session-option` and `none`, and the contract suite runs the research's cases (section 1.7) against the pinned OpenCode on every bump.
- The catalog keeps `reasoning` and `reasoning_options`, in the bundled copy and the daily fetch, and each model row stores the controls with an admin's override beside them.
- `AgentProfile`, `Task` and `Turn` each gain a level, and `Turn` the reasoning tokens. The migration is additive, with `default` as every row's level.
- The audit log gains `model.reasoning-changed` and `task.effort-changed`. A profile's level is part of its save's entry.
- The catalog file the OpenCode adapter writes either gets its `release_date` and reasoning fields, or goes. The config defines the model either way (research, section 7, item 7).
- Not in: a level chosen on the New task page (a later addition, which the task page's control makes easy), and a budget in tokens set by hand.
