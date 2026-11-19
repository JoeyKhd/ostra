# Target: a task's effort (milestone 4, screen 25)

> **Committed image:** `task-effort.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `task-effort.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved `app-targets/m1/task` 2048 original (spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx`, its properties panel and the thread.
- **Features:** F-137 (reasoning effort), F-024 (steering: only the driver changes it), F-084 (usage per turn). ADR 0066 ("Changing it on a running task", "A level the model doesn't have", "Cost"). Tickets 59 (`effort.changed`, `turn.started.effort`), 60 (the runner applies it), 61 (`tasks.setEffort`, the turn's level and reasoning tokens), 63 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 62's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The driver can turn a task's thinking up or down while it runs, and everyone can see what each turn ran at and what its thinking cost. A change never splits a turn: it applies from the next one (ADR 0066), and the page says so.

Everything else is milestone 1's `task` with milestone 4's growth (spec section 12), unchanged.

## The properties panel

A row `Effort` after `Key` (ticket 53's row after `Model`):
- **The driver** (the picture): a compact select trigger (28px, `--surface`, 1px `--line-2`, radius 6px, 200px) with the level's label and `chevron-down`. It opens a `Select` with the model's levels (`tasks.effortLevels`), `Default` first, each with its label and the profile editor's hint (`agent-profile-effort`) in 12.5px `--muted`. Choosing one calls `tasks.setEffort`.
- **While a turn runs and the chosen level differs from the running turn's,** under the trigger, 12.5px `--muted`, two lines: `From the next turn.` / `This turn runs at {level}.` They go when the next turn starts.
- **Everyone else:** the level as text (`High`), and after it ` · ` and a teal link `Take over to change` (F-024's take-over). A member who can't take over sees the level alone.
- **A model with no levels** (`Default` alone): the row reads `Default`, no trigger, for everyone.

`Tokens` keeps `211k in · 38k out`; a new row `Reasoning` after it, mono `19k tokens` (the task's sum of its turns' reasoning tokens; `—` when no turn reported any). Reasoning is inside `out`, so the rows don't add up to more than the total: the row's tooltip says `Counted inside out. Priced as output.`

## The thread

1. **Each turn's usage line,** under its last item, mono 12.5px `--faint`, ` · `-joined: `Turn {n}`, the level it ran at (its label; omitted at `Default`), `{in} in`, `{out} out`, `{reasoning} reasoning` (omitted when the endpoint reported none), the turn's spend. Milestone 3's per-turn usage (F-084) gains the two fields.
2. **A clamped turn** (`turn.started.effort.adjustedFrom`), one line under the usage line, 12.5px `--muted`, Lucide `info` 14px: `Ran at {level}: this model has no {asked}.` For a model with no levels at all: `Ran at the default: this model takes no effort level.`
3. **The marker** (`effort.changed`), a system row like milestone 1's other markers: Lucide `sliders-horizontal` 15px `--muted`, 13px `--muted` text `{member} set effort to {level}, from the next turn` (`, from the next turn` only when a turn was running), and the time in mono `--faint`. It sits in time order among the thread's items.

## States and copy

| State | What shows |
|---|---|
| **The driver changed it during a turn** (the picture) | the trigger with the new level, the two lines, the marker |
| **The driver changes it between turns** (waiting, or needs you) | the trigger with the new level; the marker without `, from the next turn`; no lines under the trigger |
| **Not the driver** | the level as text and `Take over to change` |
| **The change fails** (the runner refused, or the task ended) | the trigger goes back to the task's level, and under it, 12.5px `--red`: `The effort didn't change. {reason}` |
| **A task on a minor-2 runner** (`needs-protocol`) | milestone 3's `needs-protocol` reason on the task; the panel's row as for anyone |
| **Agent with no effort control** | the row reads `Default`, no trigger; the turns' usage lines carry no level |
| **Done or stopped** | the level as text, for everyone |
| **Loading** | the row a `Skeleton` |

Demo data (fixtures): `CALC-161` on DeepSeek V4 Pro through `acme-openrouter`, created from `Careful` at Extra high (clamped to Max, turn 1), driven by Alex Kim, who set Low during turn 2.

## Components

`Select` (exists), `PropRow`, the thread's marker row (exists), `Tooltip`, `Skeleton`. Icons: `chevron-down`, `info`, `sliders-horizontal`. No new package.

## Tokens

The approved pictures' scale. No colour for a level. Teal only for `Take over to change`; `--red` only for the failed change's line.

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 62's `## Comments`)

1. **The control in the header or the panel.** Settled: the panel, beside `Model` and `Key`, where the run's other settings are. The header keeps its PR and Stop.
2. **Where the marker sits when it's made during a turn.** Settled: in time order, so after the running turn's items so far, which keep streaming above it while the turn runs. The picture puts it above turn 2; see "Wrong in the image".
3. **Showing the reasoning tokens.** Settled: on every turn's usage line and as the task's `Reasoning` row; spend stays one number, since v1 prices reasoning as output (ADR 0066, "Cost").

## Differences from the current code

1. `task-view.tsx`'s properties panel gains `Effort` and `Reasoning`.
2. The thread's turn usage line gains the level and reasoning tokens, and the clamp line; a new marker for `effort.changed`.
3. Messages: `tasks.effort.*`, sharing `effort.levels.*` with the profile editor.

## Wrong in the image

- **The marker** is drawn above turn 2 (14:11 before 14:09); it goes in time order, after the items turn 2 had made by 14:11.
- **`src/caculator/state.ts`** is misspelled; it's `src/calculator/state.ts`, from the data.
- **`you`** after `Alex Kim` is drawn teal; it's `--muted` (it isn't a link).
- **The thread** lost milestone 1's plan; a task's plan, tool rows and approvals render as before.
- **The panel** starts at about x=1102, as milestone 1's picture does; it's 320px.
- **The sidebar** comes from the shell.
- The picture has no non-driver, between-turns, failed, finished, loading or no-control states.

All other visible copy is spelled right.
