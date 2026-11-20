# 31: Web: automations, the editor, the dry run and the history

Status: done
Builder: web
Blocked by: 24, 30
Features: F-011, F-106, F-107
Packages: `apps/web` (`src/routes/projects/$projectId/automations/`)
Spec: `../spec.md`, section 12 (`automations`, `automation-edit`, `automation-history`)

## What to build

- The project's "Automations" list, the rule and schedule editor with the live dry run and "Start all N", the schedule's preview, and a rule's history, to their approved targets.
- The sidebar's "Automations" under each project; the paused rule's needs-you row on Home.
- English text in message files; dark first; responsive to phone width.

## Done when

- [x] Playwright: create a rule, see its dry run, "Start all", see the history; create a schedule with a preset and a zone, see its next occurrences, pause it.
- [x] Each screen checked against its target at 1440 px and at phone width, in dark and light, with the differences noted in `## Comments`.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the automations screens`.

## Comments

- 2026-11-20, web: built as `✨ add the automations screens`. The list (`/projects/[project-id]/automations`), the editor (`/automations/new?starts=match|schedule` and `/automations/[automation-id]`) and the history (`/automations/[automation-id]/history`) are in `apps/web/src/components/automations/`; "Automations" is under each project in the sidebar, and a rule its hourly limit paused is a row in Home's Needs you for the project's admins. Proved by `apps/web/e2e/18-automations.spec.ts` (create a rule, its dry run, "Start all" through core's `bulk.start-item` worker, its history; a schedule from a preset in Europe/Amsterdam with its three next occurrences, refused under the minimum interval, paused and resumed; a member reads only; Home's paused row; phone width), with break-its (the switch never pausing, "Start all" doing nothing, `pausedByLimit` without its admin check) recorded in `context/proof/F-011.md`, `F-106.md` and `F-107.md`.
  - **API, additive:** `automations.list` gains each automation's `counts` (started, skipped, missed, and starts in the last hour; a "Start all" press's own run isn't a start), the last run's `ticketKey`, and the install's `limits`; `automations.pausedByLimit` lists the rules the hourly limit paused in projects the member is an admin of (a notification has no automation ID, so Home reads the automations). Tested in `automations.test.ts` and the isolation suite.
  - **Checked against the targets** at 1440 px and 412 px, dark and light (`_lead/ui-check/m6-automations*-final.png`, `m6-automation-edit*`, `m6-automation-history*`, `m6-light-*`). Differences:
    - The filter in words is the panel's (`automation-words.ts`), not the domain's: the domain has no such function, and the words need the board's names, which only the panel's queries hold.
    - An empty filter isn't allowed (ticket 06: a filter names one condition at least), so the dry run asks for a condition instead of counting every open ticket.
    - The dry run has no "queued" outcome (ticket 24's `dryRun` doesn't run admission); a bulk start's results say "Queued" when it happens. A parent ticket reads "Skipped: it has N sub-issues; start them from its page", as ticket 24's `has-sub-issues` outcome says, not "Starts 3 tasks".
    - "Started by hand" names no member (`history` doesn't return the bulk start's member), and a prompt schedule's column lists three next occurrences (`previewSchedule` returns three), not five.
    - The tracker's project field is a free-text ID: the cache has no tracker projects to offer (ticket 06's note).
    - "Leave without saving?" is the browser's own prompt on unload, not an in-app dialog: the App Router has no navigation guard to hook.
    - The switch is the app's green `Switch`, as `automations.md` says to use it unchanged.
  - **Not mine:** on this base, `02-setup.spec.ts` ("Add a model provider", at "Allow on personal runners") and `03-first-run.spec.ts`'s last test fail at steps this change doesn't touch; the spec seeds the built-in profile's model and an online runner when they're missing, so it doesn't depend on them.
