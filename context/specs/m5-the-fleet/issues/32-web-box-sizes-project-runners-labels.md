# 32: Web: box sizes, project runners and profile labels

Status: done
Builder: web
Blocked by: 27, 29
Features: F-095, F-069, F-086
Packages: `apps/web` (`src/app/(panel)/organization/box-sizes/`, `src/app/(panel)/projects/[slug]/settings/runners/`, `src/components/agent-profiles/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (steps 1, 5 and 7) and 12

## What to build

- **Box sizes** (`m5/box-sizes`): the three sizes, editable by admins, where each is a project's default, and the `host` line.
- **A project's Runners** (`m5/project-runners`): the allowed pools in order with drag and keyboard reorder, each share, the default size, and the line on personal runners.
- **The profile's "Runner labels"** against `app-targets/m3/agent-profile`, with the reserved prefixes refused inline.

## Done when

- [x] Playwright, named for `F-095`, `F-086` and `F-069`: an admin edits a size; a project admin reorders pools with the keyboard and sets a share; a label with a reserved prefix is refused.
- [x] Committed as `✨ add sizes, project runners and labels`.

## Comments

- 2026-11-20: built in `apps/web` (`organization/box-sizes/` with `components/organization/box-sizes-view.tsx`; `projects/[project-id]/settings/runners/` with `components/projects/project-runners-view.tsx` and the Runners tab between Access and Audit log; `components/agent-profiles/runner-labels-section.tsx` in the profile editor; Box sizes and Registry in the sidebar) and, additively, `packages/api` (`fleetUse.boxSizes` and `fleetUse.project` in `src/routers/fleet-use.ts`: the counts and names the targets need beyond ticket 27; `tasks.get`'s `box` gains `size` and `waiting`). Tests: `apps/web/e2e/15-fleet-settings.spec.ts` (with `seed-m5-settings.ts`), `packages/api/src/routers/fleet-use.test.ts` and the words' unit tests; proof rows in `context/proof/F-095.md`, `F-086.md` and `F-069.md`. Each screen was screenshot at 1440 wide and compared with its target by eye. Decisions:
  - Box sizes: each changed size is its own `boxSizes.update` (ticket 27 names no batch), in order; a failure shows under the table and keeps the typed values. The panel's Bounds group shows the smallest size only. A member sees the page read-only; the room warning is an admin's.
  - A project's Runners tab is for the project's admins and the organization's (`fleetUse.project` asks for `admin`); a project member is sent to Models and keys. The API keeps at least one pool on a project's list (`setPools` takes `min(1)`), so the last pool's Remove is disabled with that reason, rather than the target's "will have no pool" dialog line (open point 1 is moot until a project may list none). A share above the pool's cap is refused (open point 2). The audit actions are ticket 27's `project.pools-set` and `project.default-box-size-set` (open point 3); `project.pools-set` holds IDs only, so the Last change sentence reads "changed {project}'s pools".
  - Reorder by drag uses the handle's pointer events and no new dependency; the keyboard model and its live region are as the target says.
  - A profile's runner labels apply at once through `agentProfiles.setRunnerLabels`, apart from the editor's Save; a new profile asks to be saved first. Reserved prefixes are refused inline, as ticket 27 refuses them.
  - The change notices refresh `boxSizes` and `fleetUse` (`apps/web/src/task/change-scopes.ts`).
