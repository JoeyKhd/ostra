# Target: the profile's provider and model (milestone 4, screen 21)

> **Amended 2026-11-20** (the maintainer, on this screen: "you should first select the provider and then you get to see which models are available under that provider"; "sure" to the profile locking its provider, its key and base URL; ADR 0065 amended, F-135, F-021). The field order is now **Agent, then Provider, then Model, then Effort**: a `Provider` select takes the third column of the first row, where `Model` was, and `Model` moves to its own row under it, 520px wide (the picker's width). The picker lists only the chosen provider's models. No new picture: the layout change is one field and one row, so the committed image stays the reference for every control's look; where this file and the picture differ on order, this file wins. The sections marked *2026-11-20* below say what changed.

> **Committed image:** `agent-profile-model.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `agent-profile-model.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: the approved `app-targets/m3/agent-profile` 2048 original (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (existing):** `apps/web/src/app/(panel)/organization/agent-profiles/[profile-id]/page.tsx` (and `new/`) → `components/agent-profiles/agent-profile-editor.tsx`, its Model field, and `profile-editor-panel.tsx`.
- **Features:** F-135 (keys per project), F-021 (agent profiles: the profile names its model by name). ADR 0065, "A profile names its model by name" (Q271, Q272). Tickets 45 (`ModelName`), 50 (`profiles.modelOptions`, the save taking `model: ModelName`), 53 (this screen).
- **Status:** approved 2026-11-19 by the lead on the maintainer's delegation, pending the maintainer's review (ticket 52's `## Comments`).

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

*2026-11-20:* A profile names its **provider**, then one of that provider's models: its tasks use that key and base URL alone, and it runs only in the projects whose list allows the provider. The editor makes that plain: the provider first, then only its models, and, before the save, the projects that don't allow it, so nobody saves a profile without knowing where it can't start.

*Before 2026-11-20 (kept for a profile saved with no provider):* a profile named a **model**, not a key: one profile worked in every client's project, each on its own key, and the picker showed the projects where no key served the chosen model.

Everything else on the editor is milestone 3's `agent-profile` target, unchanged.

## The Provider field (2026-11-20)

The third field of the first row of `Agent and model` (Name 212px, Agent 190px, Provider the rest), label `Provider` (the fields' label style). A `Select` (milestone 3's Agent select: 32px, `--surface`, 1px `--line-2`, radius 7px) of the organization's providers by name (`agentProfiles.providerOptions`), such as `dev endpoint`; placeholder `Pick a provider`. Picking one keeps the chosen model when the new provider lists it, and clears it otherwise (the Model trigger reads `Pick a model`, and Save waits).

Under the grid, 12.5px `--muted`, when some projects' lists don't hold the chosen provider: `globex-shop doesn't allow dev endpoint: tasks on this profile can't start there.` (two or more: `2 projects don't allow dev endpoint: …`).

**A profile saved before, with no provider:** the select shows its placeholder, the Model trigger is disabled and shows the saved model, and under the grid, 13px `--muted` with `triangle-alert` 13px: `Pick the provider this profile's tasks use. Until then, each project's own key serves {model}.` Save waits for a provider. Read-only (a member): `None: each project's own key serves {model}` in `--muted`.

## The Model field

*2026-11-20:* its own row under Name, Agent and Provider, at most 520px wide. With no provider picked yet, a disabled trigger reads `Pick a provider first`. Once one is, the picker lists only that provider's models, as below, with these changes: the group label is `Models {provider} lists`; no keys column on an option (they are all the chosen provider's); no `No key in …` line (the projects that don't allow the provider are said once, under the Provider field, and in the panel); the footer is `Tasks on this profile use {provider}'s key, and run only in projects that allow it.`; a provider that lists no model shows a disabled trigger, `{provider} lists no model yet.`; a saved model the provider no longer lists shows, under the field in 12.5px `--red`, `{provider} doesn't list {model} now. Tasks on this profile wait until it does, or pick another model.` The Effort levels come from the chosen provider's own row of the model.

*Before 2026-11-20:* Milestone 3's third field of `Agent and model`. The trigger (32px, `--surface`, 1px `--line-2`, radius 7px; open: 1px `--text` border): the model's logo, its name in 14px `--text` (a custom model: its endpoint ID in mono), a `chevron-down`. **No provider name in the trigger** (milestone 3's showed `Anthropic`): the profile has none.

### The picker (the picture)

A `Popover` + `Command` (combobox), 520px wide, under the trigger and left-aligned with it, `--surface`, 1px `--line-2`, radius 8px, no shadow:

1. **Search** (40px): Lucide `search` 15px `--faint` and the input (`Search models`), a hairline under it. It filters by name and catalog ID.
2. **Group label** (12px 500 `--faint`): `Models any key lists`.
3. **One option per model name** (`profiles.modelOptions`), 48px, two lines:
   - line 1: a 15px check slot (`check` `--green` on the chosen one), the logo, the name (14px `--text`), and right-aligned the keys that list it, mono 12px `--faint`, comma-joined (more than two: the first two and `+{n}`).
   - line 2 (12.5px `--muted`, indented to the name): Lucide `triangle-alert` 13px `--muted` and `No key in globex-shop` (the projects, among those that can use this profile, where no key on their list serves it; comma-joined, more than two: `No key in 3 projects`). Every project served: no line 2, and the option is 36px.
   - Highlighted (keyboard or hover) `--sel`. Sorted: models every project can use first, then by name.
4. A hairline, then one 36px option: `plus` 15px and `Custom model by its endpoint ID` (`--muted`). It turns the popover into one input, `Endpoint model ID` (mono), with the help `The ID a key lists it under, such as acme/sql-coder-ft.` and `Use this ID`. It's matched by name against every key's listed models, and the same `No key in …` line shows under the input.
5. A footer, 12px `--faint`, a hairline above it: `A profile names a model, not a key. Each project's own key serves it.`

Empty search: `No model matches "{query}". A key lists a model once an admin adds it in Models.` No model at all: the trigger is disabled and reads `No model yet`, with milestone 3's `Add a provider in Models` link.

### Properties panel: the provider in each project (2026-11-20)

With a provider picked, the group is `{provider} in each project`: one 30px row per project, the provider's name in mono `--muted` where the project's list allows it, else `triangle-alert` 13px + `Not allowed` in `--red` (a teal link to that project's `Models and keys` for an organization admin). Under the rows, 12.5px `--faint`: `globex-shop's tasks on this profile can't start until an organization admin allows dev endpoint there.` (two or more: `Tasks on this profile can't start in 2 projects until …`). After a save, the status line reads `Saved. globex-shop doesn't allow dev endpoint yet.` when some project doesn't. With no provider (a profile saved before), the group is the one below.

### Properties panel: the model in each project

A new `PropGroup` after `Profile`, label `{model} in each project` (12px 500 `--faint`). One 30px row per project that can use the profile (its default profiles' projects first, then the rest): the 8px colour square and the project's name (`--text`), and right-aligned the key that serves it there in mono `--muted`, or `triangle-alert` 13px + `No key` in `--red`. Under the rows, when any project has no key, 12.5px `--faint`: `globex-shop's tasks on this profile can't start until an organization admin adds a key that lists it.` (two or more: `Tasks on this profile can't start in 2 projects until an organization admin adds a key that lists it.`). For an organization admin, `No key` is a teal link to that project's `Models and keys`.

The group follows the picker's highlighted option while the popover is open, so it previews before the choice, and the saved model otherwise.

## States and copy

| State | What shows |
|---|---|
| **The picker open** (the picture) | as above |
| **Saved, every project served** | the trigger, and the panel's group with a key on every row; no note |
| **A model no key lists any more** | the trigger shows the name with `triangle-alert` 13px `--red` after it, and under the field, 12.5px `--red`: `No key lists Claude Haiku 5 now. Tasks on this profile wait until one does.` |
| **Saving** | milestone 3's save; a profile saved with a model that has no key in some project saves (it's not an error), and the status line says `Saved. No key serves it in globex-shop yet.` |
| **Read-only** (a member) | milestone 3's read-only editor; the trigger as text, the panel group as is |
| **Loading** | the trigger a `Skeleton`; the panel group three skeleton rows |
| **Narrow** | the popover takes the column's width; the keys move under line 1 |

Demo data (fixtures): profile `Builder`, default for code tasks in `calculator`, `web-storefront` and `northwind-portal`, usable in `globex-shop`; keys as in `models-keys`.

## Components

`Popover` (exists), a combobox listbox (`role="combobox"` on the input, `role="listbox"` and `option`s, roving `aria-activedescendant`) built on the existing `Popover`; `apps/web` has no `cmdk`, so reuse the search palette's list (ticket 35) if it lands first, and ask before adding a package, `Input`, `Button`, `Skeleton`, `PropGroup`, `PropRow`. Icons: `search`, `check`, `triangle-alert`, `plus`, `chevron-down`.

## Tokens

The approved pictures' scale. `--green` only for the chosen option's check; `--red` only for `No key`; `--muted` for the `No key in …` warning line (a fact while picking, not an error yet).

## Open points (settled by recommendation, 2026-11-19; recorded in ticket 53's `## Comments`)

1. **Which projects count for "No key in …".** Settled: the projects where the profile can be used (F-021's access, and every project for an `Everyone` profile), not only those that default to it.
2. **Saving a profile whose model has no key somewhere.** Settled: allowed, with the status line. The block is at task start (`no-key-for-model`), where the reason is shown.
3. **Grouping options by key.** Settled: no. Grouping by key would bring back the idea that a profile picks a key; keys are listed on each option instead.

## Differences from the current code (2026-11-20, built)

1. `agent-profile-editor.tsx`'s `Agent and model` gains the Provider select (`agentProfiles.providerOptions`) and feeds `ModelPicker` only that provider's models (`modelsOfProvider`, `editor-draft.ts`); `withProvider` clears a model the new provider doesn't list; the draft carries `providerId`, and the save sends it.
2. `model-picker.tsx` takes the `provider`, and `ModelInProjects` shows `{provider} in each project`.
3. Messages: `agentProfiles.editor.provider*`, `agentProfiles.editor.modelPicker.groupOf`, `footerOf`, `notListedNow`, `inEachProjectOf`, `notAllowed`, `cantStart*Of`, `savedNotAllowed`.

## Differences from the code before ticket 53

1. `agent-profile-editor.tsx` builds the model `Select` from `providers.list` × `providers.models`, grouped by provider, and saves `modelId`. It becomes the combobox over `profiles.modelOptions`, saving `model: ModelName` (`{ kind: "catalog", catalogId } | { kind: "custom", endpointModelId }`).
2. `profile-words.ts`'s `modelName` drops the provider.
3. `profile-editor-panel.tsx` gains the `{model} in each project` group.
4. Messages: `agentProfiles.editor.modelPicker.*`.

## Wrong in the image

- **The popover** hides `Instructions`' text area, which wraps (`Keep the PR under 400 changed` / `lines.`). The text area is full-width and one line; the popover overlays it.
- **The panel's group label** `Claude Sonnet 5.5 in each project` is drawn 14px bold; it's 12px 500 `--faint`.
- **The panel** starts at about x=1044, about 396px. It's 320px.
- **`Claude Haiku 5`** is listed by `acme-anthropic`, whose line on `models-keys` says `2 models`. Fixture drift: build from the data.
- **The sidebar** comes from the shell.
- The picture has no saved, custom, missing-model, loading or narrow states.

All visible copy is spelled right.
