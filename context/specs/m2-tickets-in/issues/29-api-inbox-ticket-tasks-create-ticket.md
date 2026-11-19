# 29: API: the Inbox, tasks from tickets, "Create ticket"

Status: ready-for-agent
Builder: api
Blocked by: 14, 15, 28
Features: F-010, F-007, F-097
Packages: `packages/api` (`routers/inbox.ts`, `routers/tasks.ts`), `packages/domain` (`startTicketTask`, `createTicketForTask`)
Spec: `../spec.md`, sections 3 (steps 3 and 4) and 11 (items 10 and 12)

## What to build

- **`inbox.list`:** the project's open tickets from the cache, across its boards, paged by cursor, with filters for status, label, priority, assignee and text, the default filter of spec section 11, item 10, and for each ticket the task it already has (its ID and state). Members who can read the project.
- **`inbox.get`:** one ticket's cached copy, for the preview.
- **`tasks.startFromTicket`:** creates a code task (or the kind given) with the project's default agent profile for that kind, the ticket's ID, key and title, under the one-active-task index, then enqueues `ticket.fetch-context` (ticket 18) in the same transaction. A second active task for the ticket is refused with the existing task's ID. The run-on choice (a personal runner) works as in milestone 1.
- **`tasks.createTicket`:** for a prompt task with no ticket, on one of the project's boards: writes ticket 15's `create` row, and when it's done the task holds the ticket and the ticket the task's link.
- An Inbox read never calls Linear; the cache answers, and its age shows.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **`projects.list` gains `inboxCount`,** the open tickets in the default filter per project, for the sidebar's Inbox count. It's one grouped query, not one per project. There's no separate `inbox.count`.

## Done when

- [ ] Tests: filters and paging; the existing task shows; starting twice is refused; a member of another project, or a restricted project's non-member, sees nothing; "Create ticket" links both ways once.
- [ ] Committed as `✨ add the Inbox and tasks from tickets`.

## Comments
