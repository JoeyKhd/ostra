# 28: API: boards and their mapping

Status: ready-for-agent
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

## Done when

- [ ] Tests against the fake Linear server and the Jira fake: attach drafts the mapping each tracker's statuses give; an edited mapping is saved and checked; detach stops polling; a member, and another project's admin, are refused.
- [ ] Committed as `✨ add boards and their mapping`.

## Comments
