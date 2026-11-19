# Target: the profile's effort (milestone 4, screen 24)

> **Committed image:** `agent-profile-effort.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `agent-profile-effort.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved `agent-profile-model` 2048 original (target 21, which starts from `app-targets/m3/agent-profile`; spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/organization/agent-profiles/[profile-id]/page.tsx` (and `new/`) → `components/agent-profiles/agent-profile-editor.tsx`, under its Model field, and `profile-editor-panel.tsx`.
- **Features:** F-137 (reasoning effort), F-021 (agent profiles). ADR 0066 ("The level", "A level the model doesn't have"). Tickets 56 (the `Effort` union), 58 (the catalog's controls), 61 (`profiles.effortLevels`, the save taking `effort`), 63 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 62's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A profile sets how long its model thinks before it acts. The control offers exactly the levels this model takes (its catalog entry, as far as its agent can send them), so nobody picks a level the endpoint refuses, and each level says in one line what it trades: speed and cost against depth.

Everything else on the editor is target 21's `agent-profile-model` and milestone 3's `agent-profile`, unchanged.

## The Effort field

A field inside `Agent and model`, under the row of Name, Agent and Model, full column width.

1. **Label row:** `Effort` (the fields' label style: 13px 500 `--muted`, like `Name`; see "Wrong in the image"), then, 12px after it, 12.5px `--faint`: `How long {model} thinks before it acts. Its own levels.`
2. **The levels:** a `RadioGroup`, one 34px row per level the agent can send for this model (`profiles.effortLevels`), `Default` first, then low to high on models.dev's scale. Rows are separated by hairlines, not boxed. Each row: the radio (16px), the level's name (14px `--text`) in a 220px column, and its hint (13px `--muted`). The chosen row is `--sel`. Hover `--sel` at half strength. Keyboard: arrows move and choose, as a radio group does.
3. **The note,** 12.5px `--faint`, 8px under the list: `A running task keeps its own level. A change here applies to new tasks.`

The labels and hints (messages `agentProfiles.editor.effort.*`):

| Level | Label | Hint |
|---|---|---|
| `default` | Default | The endpoint's own default. ostra sends nothing. |
| `none` | Off | No thinking. Fastest and cheapest. |
| `minimal` | Minimal | Barely any thinking. Nearly as fast as off. |
| `low` | Low | A little thinking. Quick and cheap. |
| `medium` | Medium | Balanced speed, cost and depth. |
| `high` | High | Thinks longer on hard steps. Slower, costs more. |
| `xhigh` | Extra high | The deepest thinking. Slowest and costliest. |
| `max` | Max | As much thinking as the model allows. Slowest and costliest. |
| `on` | On | Thinks before it acts. The model has no levels, only on or off. |

When `max` and `xhigh` are both offered, `xhigh`'s hint is `Very deep thinking. Slow and costly.` so the two don't read the same.

The examples from the research (section 2), as the fixture catalog has them:
- **GPT-5.5** (the picture): Default, Off, Low, Medium, High, Extra high.
- **DeepSeek V4 Pro**: Default, Low, High, Max.

### Properties panel

The `Profile` group gains a row `Effort` with the saved level's label (`High`). The `{model} in each project` group (target 21) is unchanged.

## States and copy

| State | What shows |
|---|---|
| **A model with levels** (the picture) | as above |
| **A model that doesn't reason, or reasons with no control** (its levels are `Default` alone) | no radio list; under the label, one line 13px `--muted`: `Claude Haiku 5 doesn't take an effort level. Tasks run at the endpoint's default.` The panel's `Effort` row reads `Default`. |
| **A stored level the model lacks** (the model changed, or an admin changed its controls) | the list shows the model's levels with none chosen, and above it one line 13px `--text` with Lucide `info` 14px `--muted`: `Saved as Extra high. DeepSeek V4 Pro has no Extra high, so new tasks run at Max.` The run-at level comes from ADR 0066's clamp, the same function core uses (ticket 56). Choosing a level clears the line. Saving without choosing keeps the stored level. |
| **The model changes in the editor** | the list is rebuilt from the new model's levels. A chosen level the new model has stays chosen; otherwise the line above shows what it would run at, as in the row above. |
| **A custom model whose reasoning nobody set** | no list; 13px `--muted`: `Nobody has said whether acme/sql-coder-ft reasons, so tasks run without an effort level.` and, for an organization admin, a teal link `Set it in Models` to that model on `model-reasoning`. A member sees the sentence without the link. |
| **An agent that can't set an effort** (`reasoningEffort: "none"`) | no list; 13px `--muted`: `{agent} doesn't take an effort level. Tasks run at the model's default.` |
| **Read-only** (a member) | the chosen level as text with its hint, no radios |
| **Loading** | four skeleton rows |
| **Narrow** | the hint wraps under the label in each row (rows grow to 52px) |

Demo data (fixtures): profile `Careful`, default for review tasks in `calculator` and `globex-shop`, model GPT-5.5, effort `high`; keys as in `models-keys`.

## Components

`RadioGroup` (exists, from milestone 3's "Who may use it"), `Skeleton`, `PropRow`. Icons: `info`. No new package.

## Tokens

The approved pictures' scale. `--sel` for the chosen row only; no colour on any level (a level isn't good or bad).

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 62's `## Comments`)

1. **Radio list or a select.** Settled: a radio list. The levels are few (two to six), and each hint is the point: a select would hide them until opened.
2. **Where the stored-level line sits.** Settled: above the list, so it's read before a level is chosen; the clamp's result is named, never an error (ADR 0066, Q289).
3. **Showing levels for a model that reasons with no control.** Settled: none. `Default` alone offers no choice, so the quiet line replaces the control.

## Differences from the current code

1. `agent-profile-editor.tsx` gains the field and saves `effort` (ticket 61's `profiles.save`).
2. `profile-editor-panel.tsx`'s `Profile` group gains `Effort`.
3. Messages: `agentProfiles.editor.effort.*`, the level labels and hints shared with the task page (`effort.levels.*`).

## Wrong in the image

- **`Effort`** is drawn as a section title (15px 600 `--text`); it's a field label like `Name` (13px 500 `--muted`), inside `Agent and model`.
- **The Model trigger** is drawn with the focused 1px light border while nothing is open; at rest it's 1px `--line-2`.
- **The hint column** starts at about x=492; it's the 220px label column's end, about x=520 from the list's left edge. Build from the column.
- **`Approval rules`** (milestone 3) is missing below `MCP servers`; it stays.
- **The panel** starts at about x=1045, about 395px. It's 320px.
- **The sidebar** comes from the shell.
- The picture has no no-reasoning, stored-level, custom-model, read-only, loading or narrow states.

All visible copy is spelled right.
