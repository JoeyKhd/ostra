# 63: Web: the effort on the profile, the task page and the Models page

Status: done
Builder: web
Blocked by: 53, 61, 62
Features: F-137, F-021, F-024, F-084
Packages: `apps/web` (`src/components/agent-profiles/agent-profile-editor.tsx`, `src/components/tasks/task-view.tsx` and the thread, `src/components/models/model-editor.tsx`, `src/components/models/models-view.tsx`)
Spec: `../spec.md`, section 12 (targets 24 to 26); ADR 0066

## What to build

The three screens as their approved targets show them:
- **The profile editor's Effort** sits under the model (ticket 53's control by name).
  - It shows exactly the model's levels, `Default` first, and updates when the model changes.
  - It's hidden for a model that doesn't reason.
  - It shows the level a stored one will run at when the model lacks it.
- **The task page:**
  - the level in the properties panel, with the levels for the driver and read-only for everyone else
  - "from the next turn" while a turn runs
  - `effort.changed` in the thread
  - each turn's level, `adjustedFrom` and reasoning tokens in its usage line
- **Models:**
  - a model's reasoning and its source, with "Edit" and "Use the catalog's" for an organization admin
  - a custom model's "Reasons" form beside its limits
  - the reasoning-price mark

## Done when

- [x] Component tests named `it("F-137: ...")` for each state of the three targets.
- [x] A Playwright case against the fixture catalog:
  - `Careful` on GPT-5.5 offers its five levels and `Default`, and a model that doesn't reason offers no control
  - the driver changes a running task's level and sees "from the next turn"
  - a member who isn't the driver sees no control
- [x] Each screen is screenshotted at 1440 px and compared with its target, and the differences are listed under `## Comments`.
- [x] Committed as `✨ add the reasoning effort controls`.

## Comments

- 2026-11-19: built on ticket 61's API (`agentProfiles.effortLevels`, `effortOptions`, `providers.models`' `reasoning`, `tasks.get`'s `effort` and `capabilities.setEffort`, `tasks.setEffort`), with tickets 50, 53 and 59 not yet landed. The profile editor's Effort sits under the model and reads `agentProfiles.effortLevels` for the draft's agent and model (ticket 50's `modelOptions` will carry the levels); the save sends `effort` only when it changed, so a stored level the model lacks is kept. The task page's Effort row sits after Model (ticket 53's Key row isn't there yet), with the level from the newest `effort.changed` on the stream, else `tasks.get`'s. Models: ticket 53's Keys and Models tabs aren't built, so the reasoning sits in today's Models table as a `Reasoning` column (levels, the price mark, the source and `Use the catalog's`), with the footnote under it, and the panel's `Reasoning` group under the model's limits; `ModelsTable` (the target's tab, tested) is ready for ticket 53 to mount. `?model=` on Models opens that model, the profile editor's `Set it in Models` link. Tests: `effort-field.test.tsx`, `model-reasoning.test.tsx`, `task-effort.test.tsx`, `editor-draft.test.ts` and the Playwright cases in `e2e/09-effort.spec.ts` (seeded by `e2e/seed-effort.ts`), each with a break-it. Commits: `✨ show each turn's effort in the thread`, `✨ add the effort field and model reasoning`, `✨ add the reasoning effort controls`.
- 2026-11-19: the 1440px screenshots against the targets (desktop only; the e2e cases are `@desktop-only`, so no phone pass was taken). Differences:
  - **agent-profile-effort:** matches the list, hints, chosen row, note and the panel's `Effort` row (after `Used by`, as drawn). The label is the fields' 13px `--muted` style, not the picture's bold (the spec's "Wrong in the image"). The `GPT-5.5 in each project` group is ticket 53's and isn't there; the model trigger shows the provider name beside the model, as today's select does.
  - **task-effort:** the trigger, `From the next turn.` / `This turn runs at High.` and the marker match. The row follows `Model`, not `Key` (ticket 53). The turn usage line and the clamp line show only once a turn ends with usage, which the seeded running turn hasn't.
  - **model-reasoning:** the levels, their source and the panel's read view with `Edit` match. The page has no Keys/Models tabs, no `Listed by` column and no logos column (ticket 53); the reasoning is one more column of today's table, so the row is 56px only where the cell has two lines.
