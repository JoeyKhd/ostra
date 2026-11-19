# 31: Web: automations, the editor, the dry run and the history

Status: ready-for-agent
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

- [ ] Playwright: create a rule, see its dry run, "Start all", see the history; create a schedule with a preset and a zone, see its next occurrences, pause it.
- [ ] Each screen checked against its target at 1440 px and at phone width, in dark and light, with the differences noted in `## Comments`.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the automations screens`.

## Comments
