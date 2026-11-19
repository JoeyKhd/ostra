# 29: API: the Inbox, tasks from tickets, "Create ticket"

Status: done
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

- [x] Tests: filters and paging; the existing task shows; starting twice is refused; a member of another project, or a restricted project's non-member, sees nothing; "Create ticket" links both ways once.
- [x] Committed as `✨ add the Inbox and tasks from tickets`.

## Comments
- 2026-11-19, api: done (`✨ add the Inbox and tasks from tickets`, `6e1728b`). For tickets 14, 15, 18, 35 and 36:
  - **`inbox.list { projectId, boardId?, status, labels?, priorities?, assignees?, text?, cursor?, limit }`:** `status` takes tokens, default `["open"]`: `open` (each board's mapped open statuses), `started` and `done` (the status categories; `done` includes cancelled), or a status ID. Newest change first, then ID, so tickets changed at one instant page without a repeat; `nextCursor` is opaque, and `total` is over every page. Each ticket carries `task`: its active code task, else the latest finished one with `active: false` (the target's "An earlier task … is stopped"). `source` has the boards, the connection (workspace, state, mode, poll interval), `cacheUpdatedAt` (the newest of the boards' last poll and the connection's last event) and `stale`. **A read never calls the tracker.** `inbox.get { projectId, ticketId }` adds the description (markdown, untrusted), `imageCount`, `parentKey` and the active task's `driver`. `inbox.filters { projectId }` gives the filters their statuses, labels and assignees. `projects.list` and `projects.get` gain `inboxCount` (one grouped query over the visible projects' boards).
  - **A column the spec didn't list:** the Inbox filters and shows the assignee, but the cache had none, so `Ticket.assigneeId` and `assigneeName` came in their own additive migration (`20261120020000_ticket_assignee`). **Ticket 14 must write them** when it upserts a cached ticket (from `Ticket.assignee` once the adapters carry it: the SDK's `Ticket` has no assignee yet, so the filter shows nothing until then). The comments count of the panel's "context line" isn't cached either, so `inbox.get` gives the image count and the parent only.
  - **`tasks.startFromTicket { projectId, ticketId, kind?, agentProfileId?, runnerId? }`** (domain `startTicketTask`, written): refreshes the repos' branch rules, then in one transaction locks the ticket row (so two members at once serialize and the second gets `CONFLICT` naming the first task: "This ticket already has an active task, <id>."), creates the task (source `ticket`, `ticketId`, `boardId`, `ticketKey`, the branch `ostra/<key>-<last 8 hex>-<slug>`, a null prompt, the member as driver and co-author, a `starting` session), writes three `TicketWrite` rows (`move started`, `comment` "ostra is working on this: <task URL>", `link_task`), each with its `ticket.sync` job (grouped by the connection), and sends `ticket.fetch-context`. **Ticket 18's job renders the prompt, appends the first `user.message`, and sends `task.dispatch`**: this use case sends no dispatch. A detached board, a removed ticket and a revoked connection are refused (`NOT_FOUND`), and so are the signed-commit repos (`repo-unsupported`). `StartTicketTaskDeps` gained `publicUrl`.
  - **`tasks.createTicket { taskId, boardId, title?, description? }`** (domain `createTicketForTask`, written) writes the `create` `TicketWrite` (title defaults to the task's, description to its prompt) and its `ticket.sync` job, under the task's lock; a second ask, or a task that already holds a ticket, is `CONFLICT`. **Ticket 15 must set `task.ticketId`, `ticketKey` and `boardId` when it applies the write, and link the task on the new ticket.**
