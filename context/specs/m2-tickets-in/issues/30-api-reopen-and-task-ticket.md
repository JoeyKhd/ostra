# 30: API: reopen and the task's ticket

Status: ready-for-agent
Builder: api
Blocked by: 18
Features: F-032, F-033, F-064, F-031, F-068
Packages: `packages/api` (`routers/tasks.ts`)
Spec: `../spec.md`, sections 3 (step 8) and 4 ("Reopen")

## What to build

- **`tasks.reopen { taskId, clientMessageId, text }`:** any member who can read the project reopens a task that is stopped, merged, done, in review or needing them, through `reopenTask`. The same `clientMessageId` twice is applied once. Refused, with the reason, at the spend cap or while another active task holds the ticket.
- **`tasks.send`** (milestone 1) keeps working for the next turn of an idle session on a warm box.
- **`tasks.get`** gains: the ticket (key, title, status, URL, the cache's age), the ticket's context files, the sync state (each `TicketWrite` and its state), the sessions with their origin, the box's state (running, idle, stopped, released), the spend so far against the cap, and the limit that stopped it.
- **`tasks.retrySync`:** retries the task's failed ticket writes.
- The stream (milestone 1) carries the new events; the task-view fold renders `session.saved`, `session.restored`, `session.limit_reached` and `ticket.files_ready` (with web's ticket 36).

## Done when

- [ ] Tests: reopening from each allowed state, once per message ID; refusals with their reasons; `tasks.get` returns every new field and nothing from another organization; a watcher can reopen only when they can read the project.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add reopen and the task's ticket`.

## Comments
