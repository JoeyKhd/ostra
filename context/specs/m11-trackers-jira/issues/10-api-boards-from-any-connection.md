# 10: API: boards from any connection, and the ticket's tracker everywhere

Status: ready-for-agent
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

- [ ] Tests named for `F-152/c4`: `boards.attachable` groups two Linear and two Jira connections, marks attached boards, and lists a pending or failed connection with no items; one project attaches a Linear team and two Jira projects with the same external ID from two sites; every ticket payload names its connection's kind and name.
- [ ] Tests named for `F-152/c5`: a disconnected connection's board reads `paused`, its mapping can't be saved, and its tickets show in the Inbox but can't start a task.
- [ ] Tests named for `F-008/c5`: `boards.workflow` answers the statuses, transitions and each step's `by` line and warnings against the fake Jira, and `readable: false` without workflow access; a mapping naming an unknown status is refused.
- [ ] Tests named for `F-008/c7`: `setDoneBy` on a Jira board; the prompt-ticket board on a Jira board.
- [ ] Checks for `packages/api` pass (spec section 10).
- [ ] Committed as `✨ attach boards from any tracker connection`.

## Comments
