# 24: API: automations

Status: ready-for-agent
Builder: api
Blocked by: 10, 11
Features: F-011, F-106
Packages: `packages/api` (`src/routers/automations.ts`)
Spec: `../spec.md`, sections 4 and 5.4

## What to build

- `automations.list`, `get`, `create`, `update`, `pause`, `resume`, `delete` (soft, so history stays) for a project admin; `list` and `history` for any member who can open the project.
- `automations.dryRun({ filter | automationId })` → the matches with what each would do; `automations.startAll({ automationId, requestKey })` → a bulk start (ticket 11).
- `automations.previewSchedule({ cron, timeZone })` → the sentence, the next three occurrences, and the refusal when the interval is under `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`.
- `automations.history({ automationId, cursor })` → runs with their state, reason and task.
- Each mutation an audit entry; the inputs checked by the domain's schemas; a rule never names a repo; its profile must be one the project's members may use, and its pool labels are checked against the project's pools (milestone 5).

## Done when

- [ ] Tests: the access matrix (a project admin writes, a member reads, another project's member sees nothing); the schedule preview's refusal; a dry run equals what `startAll` then does; pause and resume; delete keeps the history.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the automations API`.

## Comments
