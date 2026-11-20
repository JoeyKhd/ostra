# 24: API: automations

Status: done
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

- [x] Tests: the access matrix (a project admin writes, a member reads, another project's member sees nothing); the schedule preview's refusal; a dry run equals what `startAll` then does; pause and resume; delete keeps the history.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the automations API`.

## Comments

- 2026-11-20, api: built as `✨ add the automations API` (afb00876), on `✨ add the schedule's sentence` (the domain's `cronSentence`, the editor's grammar from `automation-edit.md`, which ticket 06 hadn't built). The router is `packages/api/src/routers/automations.ts`, its tests `automations.test.ts`, and the isolation suite has its five reads. Readings and differences:
  - **Who reads what:** `list`, `get`, `dryRun` and `history` are any member's who can open the project, and `previewSchedule` any member's; the writes and `startAll` a project admin's. The ticket lists `get` with the admin's procedures; the screen target shows a member the editor read-only, so `get` is a read (`canEdit` says which). `get`, `update`, `pause`, `resume`, `delete`, `startAll` and `history` take the automation's ID and find its project themselves (another organization's, or a restricted project's the member isn't on, is `NOT_FOUND`); `history` still reads a deleted automation.
  - **The profile** must be one every member who can open the project may use: built-in, open to everyone, or listed with each of them on its list (organization admins may use any). An archived one is refused.
  - **The pool labels** are checked against the project's pools without refusing: `labelsNoRunnerHas` lists each label no runner of them carries, as the editor's "its tasks would wait" line wants.
  - **The dry run** adds the ticket's title, the task a `has-task` skip names, and `has-sub-issues` for a code start on a parent (F-077: a parent never runs code), so `startAll` starts exactly the `would-start` rows. It doesn't say whether a task would wait for approval: "Start all" is a member's press, and its tasks start as theirs (ticket 11).
  - **`startAll`** over `OSTRA_BULK_START_MAX` would-start tickets is refused (`BAD_REQUEST`), as the bulk start is. The same request key answers the first press.
  - Proof: rows added to `context/proof/F-011.md`, `F-106.md` and `F-107.md`, each with its break-it (the access check skipped, the profile check skipped, the minimum interval skipped, the resume's recompute dropped, the parent's mark dropped, a deleted automation's history refused, the sentence's weekday).
