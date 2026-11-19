# Target: a model's reasoning (milestone 4, screen 26)

> **Committed image:** `model-reasoning.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `model-reasoning.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved `models-keys` 2048 original (target 19, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/organization/models/page.tsx` → `components/models/models-view.tsx` (a `Models` tab beside `Keys`) and `components/models/model-editor.tsx` (the panel).
- **Features:** F-137 (reasoning effort), F-088 (models and providers). ADR 0066 ("The level": a custom model, or an endpoint that differs from its catalog entry; "Cost"). Tickets 58 (the catalog's controls and the override), 61 (`models.setReasoning`, `models.useCatalogReasoning`), 63 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 62's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin sees, for every model a key lists, whether it reasons, the levels it takes and where they come from, and fixes them when an endpoint differs from its catalog entry or when the model is custom. Until someone says, a custom model doesn't reason, so no task sends it a level it refuses.

The `Keys` tab is target 19's `models-keys`, unchanged.

## The Models tab

Two text tabs under the lede (14px 500; active `--text` with a 2px `--text` underline, inactive `--muted`; counts mono `--faint`): `Keys {n}` and `Models {n}`. The URL keeps the tab (`?tab=models`).

A table, rows 56px, hairlines between, no boxes. Columns:
1. **Model:** the logo (16px, monochrome; a custom model Lucide `box`), the name (14px `--text`), and under it the catalog ID in mono 12px `--faint` (a custom model: its endpoint ID as the name, mono, and `custom model` under it).
2. **Listed by:** the keys that list it, mono 13px `--muted`, comma-joined (more than two: the first two and `+{n}`).
3. **Window:** the context window, mono, from the catalog or the admin; `—` when unknown.
4. **Reasoning:** line 1, 13.5px `--text`: the levels' labels, comma-joined, without `Default` (`Off, Low, Medium, High, Extra high`); `Doesn't reason` or `Not set` in `--muted`. Line 2, 12px `--faint`: the source, `from the catalog` or `set by an admin`, and for an override ` · ` and a teal `Use the catalog's`; for an unset custom model `doesn't reason until an admin says`.
5. **The reasoning-price mark,** after line 1: an outlined tag (11.5px, 1px `--line-2`, radius 4px, `--muted`) `reasoning priced apart`, on a model whose catalog lists a `cost.reasoning` different from its output price.

Clicking a row opens it in the panel. Sorted by name; custom models last.

Under the table, when any row has the mark, one line 12.5px `--faint`: `Reasoning priced apart: the catalog lists a separate price for this model's reasoning tokens. In v1, ostra prices reasoning tokens as output.`

## The panel (the model's editor)

320px, milestone 1's model editor grown:
- **Head:** a faint label (`Custom model`, or `Model`), the name (a custom model's ID in mono 20px), and 13px `--muted` `Listed by {keys} · {format}`.
- **Limits:** `Context window` and `Output limit`, mono inputs for a custom model; text with `from the catalog` for a catalog model. ADR 0066's real limits go to the agent from these.
- **Reasoning:**
  - A catalog model: the levels as text, the source line, and two buttons for an organization admin: `Edit` (outline) and, on an override, `Use the catalog's` (ghost). `Edit` turns the group into the form below, prefilled with the catalog's values; the catalog's value stays shown under the form, 12.5px `--faint`: `The catalog says: Off, Low, Medium, High, Extra high.`
  - A custom model, or editing: `Reasons` with a segmented control `No` / `Yes`. With `Yes`: the label `Levels its endpoint takes` and one 28px checkbox row per effort level, Off to Max in models.dev's order, then a hairline and `Only on or off` (a toggle with no levels; ticking it clears and disables the levels above). Under them, 12.5px `--faint`, the levels profiles will offer: `Profiles on this model offer Default, Low, Medium and High.`
  - `Yes` with nothing ticked: `Save` is disabled and the line reads `Tick the levels the endpoint takes, or Only on or off.`
- **Footer:** `Cancel` (outline) and `Save` (primary), only while editing.
- **The price mark,** for a model that has it: under the head, 12.5px `--muted` with Lucide `info`: `Its catalog prices reasoning at $X per million, apart from output. ostra v1 prices it as output.`

## States and copy

| State | What shows |
|---|---|
| **A custom model, editing** (the picture) | as above |
| **A catalog model** | the read view; `Edit` for an admin |
| **An override** | `set by an admin · Use the catalog's` on the row and in the panel. `Use the catalog's` confirms in place: `Use the catalog's levels for DeepSeek V4 Pro? Profiles and tasks on it will offer Default, Low, Medium, High and Max.` |
| **A save that drops a level profiles use** | the save's confirmation lists them: `2 profiles are set to Max. Their tasks will run at High.` (the clamp, ADR 0066) |
| **Read-only** (a project admin or member) | the tab and the table; the panel without `Edit`, `Use the catalog's` or the form |
| **No model** | `No model yet. Add a provider, and the models its key lists show here.` |
| **Loading** | five skeleton rows |
| **Narrow** | `Listed by` and `Window` move under the name; the panel becomes a sheet |

Demo data (fixtures): keys as in `models-keys`; DeepSeek V4 Pro with an admin's override on `globex-openrouter` and a catalog reasoning price; `acme/sql-coder-ft` a custom model on `globex-openrouter`.

## Components

`UnderlineTabs` (exists), `Table` rows as milestone 1's, `ToggleGroup` (exists) for `No` / `Yes`, `Checkbox`, `Input`, `Button`, `Skeleton`, `Tooltip`. Icons: `box`, `info`. No new package.

## Tokens

The approved pictures' scale. No colour on a level. Teal for `Use the catalog's` (a link, no underline).

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 62's `## Comments`)

1. **A tab or a section for models.** Settled: a tab. The `Keys` tab is already full (target 19), and models are listed across keys, so they're their own list.
2. **An override per key or per model.** Settled: per key's listing (ADR 0066: a relay's controls differ, not the model's). The panel edits the listing of the key the row's first key names; a model on several keys with different overrides shows one row per key. Rare enough not to need its own design.
3. **Toggle-only endpoints in the custom form.** Settled: `Only on or off`, exclusive with the levels, so `on` and an effort level are never both offered.

## Differences from the current code

1. `models-view.tsx` gains the tabs and the `Models` table.
2. `model-editor.tsx` gains `Reasoning` and, for a custom model, editable limits.
3. Messages: `models.reasoning.*`, sharing `effort.levels.*`.

## Wrong in the image

- **`Models 6`** counts six; the table has five rows. The count is from the data.
- **The footnote** starts lowercase (`reasoning priced apart:`); it's `Reasoning priced apart:`.
- **`Use the catalog's`** is underlined; teal links have no underline.
- **The custom form** has no `Only on or off` row; it goes after a hairline under `Max`.
- **The DeepSeek and Meta logos** are drawn freehand; use the vendor marks the app already ships, or the generic `box`.
- **`Reasoning` and `Limits`** are drawn as 16px titles; they're the panel's 12px 500 `--faint` group labels.
- **The panel** starts at about x=1063, about 377px. It's 320px.
- **The sidebar** comes from the shell.
- The picture has no catalog-model, override-confirm, read-only, empty, loading or narrow states.

All other visible copy is spelled right.
