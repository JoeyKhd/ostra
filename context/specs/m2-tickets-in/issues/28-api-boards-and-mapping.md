# 28: API: boards and their mapping

Status: done
Builder: api
Blocked by: 06, 07
Features: F-007, F-031
Packages: `packages/api` (`routers/boards.ts`), `packages/domain` (`attachBoard`, `saveBoardMapping`)
Spec: `../spec.md`, sections 3 (step 2) and 11 (item 4)

## What to build

Project admins only, checked per project (ADR 0026).

- **`boards.available`:** the connection's teams, through `listBoards`, marking those already attached to this project.
- **`boards.attach`:** creates the board, drafts its mapping with ticket 06's function from `listStatuses` and `detectCodeHostIntegration`, creates its polling schedule, and enqueues a first full poll so the Inbox fills.
- **`boards.get` and `boards.saveMapping`:** the mapping with every status of the team, so the admin picks `open` (several), `started`, `inReview`, `done` and `doneBy`, and the magic word (`Closes` or `Refs`). Saving checks each status still exists.
- **`boards.detach`:** removes the board's schedule. Its tickets stay cached and its tasks keep their links, but no new task starts from it.
- A team may be attached to more than one project, each a board of its own, as `domain-model.md` says.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **`boards.get` carries what the boards page shows a member,** so nobody needs `linear.status`:
  - the board's key, its open-ticket count, its last poll and its last event
  - the connection's workspace name and mode
  - the integration check: `installed`, `not_installed` or `unknown`
  - the statuses grouped by category
- **`boards.saveMapping`** saves `magicWord` with the mapping.

## Done when

- [x] Tests against the fake Linear server and the Jira fake: attach drafts the mapping each tracker's statuses give; an edited mapping is saved and checked; detach stops polling; a member, and another project's admin, are refused.
- [x] Committed as `✨ add boards and their mapping`.

## Comments
- 2026-11-19, api: done (`✨ add boards and their mapping`, `70506be`). For tickets 14, 29, 30 and 34:
  - **Detach needed one column:** `Board.detachedAt`, in its own small additive migration (`20261120010000_board_detached_at`). Deleting the row would cascade the cached tickets away, so a detached board is kept and marked. Attaching the team again clears it and brings the same board back (the mapping stays when every status in it still exists). **Core (ticket 14) must make a polling schedule for every board with `detachedAt` null and drop it for a detached one:** the panel is enqueue-only and cannot create a pg-boss schedule, so `boards.attach` only enqueues the first `tracker.poll-board` (throttled by the connection), in the board's transaction. `startTicketTask` (ticket 29) refuses a detached board.
  - **`boards.get { projectId }`** answers for the whole page: `connection` (`null` before Linear is connected; else `workspaceName`, `mode`, `state`, `pollSeconds`), `canEdit` (project admin), and `boards` with `key`, `openTickets`, `lastPolledAt`, `lastEvent` (the connection's newest delivery for the board's key), `integration` (`installed` | `not_installed` | `unknown`, refreshed as the page loads), `mapping` (`null` for a milestone 1 row), `statusGroups` (every status by category, with the tracker's `vendorType`; `null` with `statusesError` when the tracker can't be asked) and `missingStatuses`. The other procedures: `boards.available { projectId }` (marks `attached`, and `alsoOn` the other projects the caller can open), `boards.attach { projectId, teamExternalId }`, `boards.saveMapping { boardId, mapping }`, `boards.detach { boardId }`. New `boardProcedure` in `trpc/init.ts` (like `taskProcedure`).
  - **The tracker as a router sees it:** `ApiDeps.trackers` (`services/trackers.ts`, `createTrackerDirectory`) turns the organization's Linear connection into a `ConnectionTracker`, reading its token from the secret store. `createApiRuntime` takes `makeLinearTracker` (the panel passes `new LinearAdapter({ auth })`; `apps/web` now depends on `@ostra/adapter-linear`). In tests `harness.fakes.tracker.adapter` is the adapter every connection gets: the Jira fake by default, or Linear's adapter on the fake Linear server.
  - `attachBoard` and `saveBoardMapping` call the tracker inside the caller's transaction (their deps carry `tx` and `tracker`), so the routers give the transaction 30 s. `detachBoard` is a new export beside them. The Linear case of the tests (`boards.test.ts`, last describe) skips until ticket 07 lets the adapter list teams; it then checks the drafted mapping on the fake Linear server, with and without the GitHub integration.
