# 53: Web: Models, a project's Models and keys, the profile's model and "no key"

Status: resolved
Builder: web
Blocked by: 36 (the spend page), 50, 52
Features: F-135, F-021, F-037
Packages: `apps/web` (the organization's Models page, a project's settings `models/` (new), the agent profile editor, New task, the task page, Home's needs-you, the spend page, New project)
Spec: `../spec.md`, sections 3 (steps 16 and 17) and 12; targets `models-keys`, `project-models-keys`, `agent-profile-model`, `no-key-for-model`

## What to build

- **Organization, "Models"** to the `models-keys` target: each provider with the projects that use it and its month's spend, the default list with "Edit", "Add provider" with no list ticked, and the upgrade's choices to confirm.
- **A project's settings, "Models and keys"** to `project-models-keys`: follow the default or use the project's own list, each model with its provider and "Change", the save's preview, and the read-only view for a project admin or member.
- **The agent profile editor's model** to `agent-profile-model`: a model name, with the providers that list it and the projects where none serves it.
- **"No key"** to `no-key-for-model`: on New task before Start with Start disabled, on a queued task, as a held message's line, and as Home's needs-you row for organization admins.
- **The screens that only grow** (section 12): the task page's "Key · <provider>", spend by key, and the provider list at project creation.

## Done when

- [x] Playwright cases named `F-135: ...`:
  - an organization admin gives a project its own list, and sees the preview before the save
  - a project admin and a member see the view, with no edit and no token
  - New task shows "no key" with Start disabled
  - the needs-you row shows for an organization admin and not for a member
  - the task page names its key
  - a profile's model picked by name
- [x] Every string is in the message files; dark and light; phone width.
- [x] Committed as `✨ add keys per project to the panel`.

## Comments

- 2026-11-19 (ticket 52): targets approved (`app-targets/m4/models-keys`, `project-models-keys`, `agent-profile-model`, `no-key-for-model`), so the UI can start. Their open points are settled in each build spec; record them here as built. **The screens that only grow**, built against their existing targets with no new picture:
  - `app-targets/m1/task`: `Key · <provider>` beside the model in the properties panel (the key's name in mono, `--muted` before it), and the held-turn marker's no-key line (`no-key-for-model.md`, section 3).
  - `app-targets/m4/spend-budgets`: a third grouping, `Keys`, beside Projects and Models: one row per provider with the month's spend and token counts, as the Models table's columns (ticket 50's per-provider grouping); a provider with no spend reads `$0.00`.
  - `app-targets/m1/project-new`: a `Keys` field, organization admins only: `Follow the organization's default` (default, with `Today: acme-anthropic.`) or `Use its own list` with the providers as checkboxes; a project admin who isn't an organization admin sees the default and no field.
  - `app-targets/m3/needs-you` and `app-targets/m1/home`: the `no_provider_for_model` row for organization admins (`no-key-for-model.md`, section 4).
  - `app-targets/m2/task-limits`: a task queued with no key (`no-key-for-model.md`, section 2).
  - The project's settings tab row (`project-access`, `project-repos`) gains `Models and keys` between `Repos` and `Access`.
- 2026-11-20 (web builder), `✨ add keys per project to the panel`, after `✨ show when no key serves a task's model` (311ee10), which shipped the no-key words for New task, the queued task, the held message and Home: built against ticket 50's API as it landed (f8bb4f6, with the lead's added fields).
  - **Organization › Models:** each key with its logo by host, format, model count, month's spend and the projects that use it (`default list` or `own list`). The default list has `Edit` (checkboxes, the save's preview in the panel, and `Save list` sent with the preview's version). Also `To confirm` (`providers.choicesToConfirm`: `Change` offers the alternatives as radios, then `Confirm`). The key's panel gains `Projects`, `Models it lists` and `This month` (spent, tasks). `Add provider` says which list it joins.
  - **A project's settings › Models and keys** (`/projects/[id]/settings/models`, a tab between `Repos` and `Access`; members see it too): follow the default or use its own list. Each model has the key serving it and `Change` (radios of the keys on the list that list it). The preview is limited to the models the profiles use, with `What happens`, and a stale preview reads as a conflict. A project admin or member gets the read-only view.
  - **The profile's model:** a combobox over `agentProfiles.modelOptions` (search, the keys listing each, `No key in …`, a custom model by its endpoint ID) that saves `modelName`. The panel shows `{model} in each project` with each project's key. The effort levels read the first listing key's row.
  - **No key:** New task gains the panel's `Key` row (the serving key, or `None in {project}`) and `{project}'s keys`. When no key serves the model, Start is the outline button, disabled. The task page names `Key · <provider>`. The needs-you rows (Home and the Needs you page) open the project's Models and keys and name the model when the item carries it. The wait words for `provider-not-allowed` and `installation-not-linked` are on the task page.
  - **New project:** an organization admin gets the `Keys` field (follow the default, or its own list as checkboxes). The own list is applied after the create, through the preview's version.
  - **Open points, as built:** no amber on the queued task; one needs-you row per item, worded per model; admins named by name only.
  - **Proof:** `apps/web/e2e/09-keys-per-project.spec.ts`, seven cases at 1440 px, and the five not marked desktop-only again at phone width (Pixel 7), all passing. Each case failed under its own break-it: no preview; edit for anyone; Start enabled with no key; the needs-you action to the task; the task page's key dropped; the picker ignoring a pick. Rows added to `context/proof/F-135.md`.
  - **Dark and light:** the panel ships one theme, dark (`globals.css`: "a light theme is left for later"). Checked dark at 1440 px and phone width. The finals are `m4-models-keys`, `m4-models-keys-provider`, `m4-project-models-keys`, `m4-project-models-keys-preview`, `m4-agent-profile-model`, `m4-no-key-for-model` and `m4-no-key-queued` (`-final.png` and `-phone-final.png`) in the run's ui-check folder.
  - **Left:** the Spend page's `Keys` grouping waits for ticket 36's Spend page, which isn't built yet. `serves {projects}` under `Models it lists` waits for ticket 50's optional item 9.
  - **Not mine, seen while running the setup specs:** `01-shell` (the checklist's Linear row no longer says "milestone 2") and `02-setup` (the checklist's order) fail on main as it stands. So `03-first-run` and `08-agent-profiles` can't reach their projects in a full run. `09-keys-per-project.spec.ts` finishes the setup itself when run alone.
- 2026-11-20 (the maintainer's change, ADR 0065 amended, F-135, F-021; target `agent-profile-model.md` updated): the profile editor reads Agent, then **Provider** (a `Select` of the organization's providers by name), then **Model** (the combobox, over only that provider's models, with its search, display names and disambiguators; no keys column and no by-name `No key in …` line once a provider is picked), then Effort (the provider's row's levels). Changing the provider clears a model it doesn't list; Save waits for a provider. A profile saved before, with none, shows "Pick the provider this profile's tasks use. Until then, each project's own key serves {model}." The panel's group becomes `{provider} in each project`, with `Not allowed` where a project's list doesn't hold it. A project's default choices, New task's profiles (through `forStart`), the no-key sentences (New task, the task page, Home's needs-you row) and the project's Models and keys rows (`the profile's key`, `Not allowed here`) follow. The Playwright case "F-135, F-021: a profile picks its provider first, then one of that provider's models, with the projects that don't allow it" replaces the by-name picker case.
