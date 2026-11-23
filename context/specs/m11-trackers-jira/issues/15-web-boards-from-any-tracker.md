# 15: Web: a project's Boards from any tracker

Status: done
Builder: web
Blocked by: 10, 11
Features: F-152, F-008, F-007, F-097
Packages: `apps/web` (`src/components/boards/boards-view.tsx`, `prompt-tickets.tsx`, new `src/components/boards/attach-picker.tsx` and `jira-mapping.tsx`, `src/components/projects/new-project-view.tsx`), `apps/web/messages/` (`boards.*`)
Spec: `../spec.md`, sections 1, 4 ("A move") and 13
Targets: `context/brand/app-targets/m11-trackers/boards-mixed.md` (`boards-mixed`, `boards-mixed-light`, `boards-attach`, `boards-attach-light`, `boards-states`, `boards-phone`)

## What to build

Built to the approved target, at its sizes, in both themes and at the phone width.

- **The attached rows:** the kind's 18px brand mark, the name over `<connection> · team` / `<connection> · project`, the key, open count, activity, Detach.
- **The attach line and picker:** one select of every connection's boards from `boards.attachable`, grouped by connection (its mark, name, `teams`/`projects`), attached ones faint and unpickable, a pending or failed connection's head with its line, typing filtering across groups; `boards.attach` with the connection.
- **A Jira board's mapping:** the note; Open's multi-select with category squares; a target-status select per step with its `by …` line; the unreachable warning with `Workflow in Jira ↗`; `Done is moved by` (`Jira automation` / `ostra`) and its help; the target-status picker grouped by category with its reach; the "workflows not readable" line. No magic-word row without `magicWords`.
- **A Linear board's mapping** as today, plus `Tracker` in the panel and `Agent mode · Takes delegations` when it's on.
- **The panel:** `Tracker` (mark and connection name); Jira's `Workflow for <key>` and `Transitions`.
- **Paused and failed boards:** the muted row, the grey or red dot, the pause line with `Trackers →`, the mapping read only.
- **Prompt tasks** (`prompt-tickets.tsx`): the board picker with each board's mark.
- **Create a project** (`new-project-view.tsx`): the tracker choice picks a board from any connection, grouped as the attach picker groups them (the m2 target, grown; the changes listed under `## Comments`).
- **The keyboard** as today; the marks `aria-hidden` beside the via line.

## Done when

- [x] The targets are approved, recorded under `## Comments` with the date and the maintainer's words.
- [x] Tests named for `F-152/c4`: a Playwright spec (`apps/web/e2e/31-boards-mixed.spec.ts`, run once at the milestone's end) attaches a Linear team and a Jira project from two connections to one project, each row with its mark and connection's name.
- [x] Tests named for `F-008/c5`: the Jira board's mapping shows each step's transition line and the unreachable warning from the fake Jira's workflow, and the "not readable" line without workflow access.
- [x] Tests named for `F-008/c7`: `Done is moved by` switches and its Jira-automation line shows.
- [x] Tests named for `F-152/c5`: a disconnected connection's board is paused, read only, with its line and link.
- [x] Screenshots at 1440 px and 390 px, both themes, compared with the targets, under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ attach boards from any tracker`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
- 2026-11-23, web (t15): built to `boards-mixed.md`: the attached rows with each kind's 18px mark and `<connection> · team|project`, the attach picker grouped by connection with attached/pending/failed rows and typing filter, the Jira mapping (category squares, per-step target status with its reach, `by …` lines, the unreachable warning with `Workflow in Jira ↗`, `Done is moved by`, the not-readable line, no magic row without `magicWords`), the panel's `Tracker`/`Workflow for`/`Transitions`, paused and failed rows with their lines, prompt tasks' marks, and New project's grouped tracker choice. Screenshots at 1440 and 390, both themes: `_lead/ui-check/m11/15/` (`boards-mixed-1440-*`, `boards-mixed-390-*`, `boards-attach-1440-*`).
- 2026-11-23, web (t15), design gap: the m2 `project-new` target is missing from `context/brand/app-targets/m2/`, so New project's tracker choice reuses the existing screen's patterns (the `None`/`A board` radio group and a grouped select with each connection's mark), kept minimal; a target is still owed.
- 2026-11-23, web (t15), checks: `boards-view.test.tsx` (27) and `new-project-view.test.ts` (2) pass; `messages.check.test.ts` (6) passes; `31-boards-mixed.spec.ts` passes on `--project desktop --project phone --no-deps`. Web typecheck of the touched files is clean; package-wide `tsc` is still red on `inbox-view.tsx` and the task fixtures, pre-existing on `main` and owned by tickets 12/13.
