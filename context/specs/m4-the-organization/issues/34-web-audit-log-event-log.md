# 34: Web: the audit log and the task's event log

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-073: ...")`: an admin filters by actor and action and exports the same rows; a task entry opens the event log at that task; a tool call's command and folder show in full.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add the audit log and the event log`.

## Comments
