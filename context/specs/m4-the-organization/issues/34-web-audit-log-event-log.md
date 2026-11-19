# 34: Web: the audit log and the task's event log

Status: resolved
Builder: web
Blocked by: 25, 31
Features: F-073
Packages: `apps/web` (`src/app/(panel)/organization/audit/`, `src/app/(panel)/projects/[project-id]/settings/audit/`, `src/task/`)
Spec: `../spec.md`, sections 3 (step 10) and 12; targets `audit-log`, `task-event-log`

## What to build

- **The audit log** (`/organization/audit`) to the `audit-log` target: the table with its filters in the URL, an entry's detail with its data, a link to the task's event log for a task entry, "Export CSV" with the current filters. Virtualised with `@tanstack/react-virtual` (approved, ADR 0007).
- **A project's audit** in its settings, for its project admins: the same table, fixed to the project.
- **The task's event log** to `task-event-log`, a tab beside Activity, Changes and Checks: every event in order with kind filters, each tool call with its full input, status and error, each approval with its command; long inputs wrapped with "Show all"; the line on what a record can't show (ADR 0054).
- **Growing:** `app-targets/m1/task` gains the "Event log" tab; write the changes against it under `## Comments`.

## Done when

- [x] Playwright, named `it("F-073: ...")`: an admin filters by actor and action and exports the same rows; a task entry opens the event log at that task; a tool call's command and folder show in full.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add the audit log and the event log`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **One row per tool call** (`task-event-log.md`, open point 1): the completion folds into its `tool.called` row, with its status; the row's details show both events' `seq`, so an audit can cite either.
- **No export of the event log** in milestone 4 (open point 2): ADR 0054 exports only the audit log, as CSV.

## Comments

- 2026-11-20, builder: the audit log (`/organization/audit`, and a project's in its settings for its admins, `components/organization/audit-view.tsx`), virtualised with `@tanstack/react-virtual`, filters in the URL, day bands, the entry's panel with its data, `Entries about this …`, the link to the event log, and `Export CSV` (organization admins) on ticket 25's `/api/audit/export` with the same filters. The task's Event log tab (`components/tasks/task-event-log/`, `?tab=events`, `&seq=` opens and selects an event): one row per event with a call's completion folded in, kind chips, `Failed or refused`, the order, turn bands, the record line by executor, and each open row's input as stored (40 lines, then `Show all`), its error and `Copy input`. Proved in `apps/web/e2e/12-audit.spec.ts` and the unit tests beside each `*-words.ts`; break-its in `context/proof/F-073.md`.
- 2026-11-20, builder, growing `app-targets/m1/task`: its tab list gains `Event log` after `Checks`; `?tab=events` joins the tab parameter's values, with `&seq={n}`.
- 2026-11-20, builder, by-eye check at 1440 px and Pixel 7 width (the finals are `m4-<screen>-final.png` and `m4-<screen>-phone-final.png` in the builder's scratchpad `ui-check` folder). The panel has no light theme yet (`apps/web/src/app/globals.css` leaves it for later), so each screen was checked dark only. Differences left, for want of data in `audit.list` and `tasks.eventLog`: the count reads the loaded entries (`{n}+ entries` while more pages remain) and so do the day bands; the Entity column shows the kind and a short ID, not a label; the Actor filter lists members only (no `Runners` or `System`) and the Project filter has no `No project`; the Event log tab has no total marker and its footer no total; new events show on the tab's next load, not live.
