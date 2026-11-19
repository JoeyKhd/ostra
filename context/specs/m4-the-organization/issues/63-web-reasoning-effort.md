# 63: Web: the effort on the profile, the task page and the Models page

Status: ready-for-agent
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

- [ ] Component tests named `it("F-137: ...")` for each state of the three targets.
- [ ] A Playwright case against the fixture catalog:
  - `Careful` on GPT-5.5 offers its five levels and `Default`, and a model that doesn't reason offers no control
  - the driver changes a running task's level and sees "from the next turn"
  - a member who isn't the driver sees no control
- [ ] Each screen is screenshotted at 1440 px and compared with its target, and the differences are listed under `## Comments`.
- [ ] Committed as `✨ add the reasoning effort controls`.

## Comments
