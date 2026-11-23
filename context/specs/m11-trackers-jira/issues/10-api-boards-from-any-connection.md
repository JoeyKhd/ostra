# 10: API: boards from any connection, and the ticket's tracker everywhere

Status: done
Builder: api
Blocked by: 02, 05, 09
Features: F-152, F-008, F-007, F-097
Packages: `packages/api` (`routers/boards.ts`, `routers/inbox.ts`, `routers/tasks.ts`, `routers/projects.ts`, `routers/search.ts`, the sidebar's live tasks, `routers/automations.ts`'s dry run)
Spec: `../spec.md`, sections 4 and 6; the targets' `boards-mixed.md` and `ticket-chips.md` "Data" sections; ADR 0071

## What to build

- **Boards:**
  - `boards.attachable({ projectId })`: per active connection (and each pending or failed one, with its state and no items), its teams or projects, with `attachedHere` and `alsoOn`; `boards.teams` (Create a project) the same, grouped.
  - `boards.attach({ projectId, connectionId, externalId })`; `requireTracker` goes, and every procedure finds the board's own connection.
  - `boards.get` and `boards.list`: each board's `connection` (`id`, `kind`, `name`, `state`), its `state` (`attached` | `paused` with `pausedBy` and since when), `capabilities`; a paused board reads only.
  - `boards.workflow({ boardId })` (`statusGraph` boards): statuses with categories, transitions, `readable`; with the mapping's reachability (`by` lines, unreachable from-statuses) from `mappingReachability`.
  - `boards.setDoneBy({ boardId, by: "tracker" | "ostra" })` (today's switch, named for both kinds); `boards.saveMapping` refuses a target status the workflow doesn't have.
- **The ticket's tracker everywhere:** every ticket payload adds its board's `connection` (`kind`, `name`): the Inbox's rows, `tasks.get`'s ticket and its "On <tracker>" writes with `via`, "What the agent got", search results, the sidebar's live tasks, New task's prompt-ticket board (`projects.get`'s `promptTicketBoard`), the automations' dry run. Sub-task and sub-issue counts from `ChildTicket`s.
- **The Inbox** lists the open tickets of every attached board of every connection; a paused board's tickets show, and can't start a task.

## Done when

- [x] Tests named for `F-152/c4`: `boards.attachable` groups two Linear and two Jira connections, marks attached boards, and lists a pending or failed connection with no items; one project attaches a Linear team and two Jira projects with the same external ID from two sites; every ticket payload names its connection's kind and name.
- [x] Tests named for `F-152/c5`: a disconnected connection's board reads `paused`, its mapping can't be saved, and its tickets show in the Inbox but can't start a task.
- [x] Tests named for `F-008/c5`: `boards.workflow` answers the statuses, transitions and each step's `by` line and warnings against the fake Jira, and `readable: false` without workflow access; a mapping naming an unknown status is refused.
- [x] Tests named for `F-008/c7`: `setDoneBy` on a Jira board; the prompt-ticket board on a Jira board.
- [x] Checks for `packages/api` pass (spec section 10).
- [x] Committed as `✨ attach boards from any tracker connection`.

## Comments

- 2026-11-23, api: built the boards from every connection, finishing the work a stopped agent left in `ow/m11-t10` (rebased cleanly onto `origin/main` at `72202bd4`). `packages/api/src/services/ticket-trackers.ts` is every ticket payload's tracker (its board's connection, kind and name), built once per call and never for another organization's rows. `routers/boards.ts`: `attachable`/`teams` group every non-revoked connection and list pending/failed ones empty, `attach` takes `{ projectId, connectionId, externalId }` and builds each board's adapter from its own connection, `get` adds each board's `connection`/`state`/`capabilities` (`pausedSinceOf` reads the newest disconnect or failure; a paused board never asks its tracker), `workflow` answers the statuses, transitions, `mappingReachability`'s `by` lines and warnings, `setDoneBy` maps `"tracker"` to the mapping's `integration`, and `saveMapping` refuses an unknown status through the domain. `inbox.list`/`inbox.get` add each row's `connection` and `paused`, list every attached board's tickets (a paused board's tickets show and `startFromTicket` refuses), `tasks.get`'s ticket adds `connection` and the cached sub-issue counts, `ticketContext`, `tasks.list`, `home.board`, `search.tasks`, `projects.get`'s `promptTicketBoard` and `automations.dryRun` name the connection; `task-extras`'s "On <tracker>" rows carry the done move's `via` and keep a `stays` line as no failure. Tests: `boards-trackers.test.ts` (9 cases: F-152/c4, c5, F-008/c5, c7 against two fake Linear workspaces and two Jira fakes, one without workflow access) and the updated `boards`, `inbox`, `isolation` suites. Checks: `pnpm --filter @ostra/api exec tsc --noEmit`, `eslint . --max-warnings 0` and 9 API test files green (see `_lead/STATE.md`).
