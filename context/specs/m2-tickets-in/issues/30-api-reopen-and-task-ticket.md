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

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **`tasks.reopen { taskId, clientMessageId, text? }`:** `text` is optional. Without it, ticket 18 writes `reopenCarryOnText`. It is allowed only when the task needs you for `stalled`, `spend_cap` (once the cap is raised), `crashed` or `restore_conflict`. Otherwise it's refused with `text_required`. A task in `merged` is refused with `merged_reopen_later` (ticket 18).
- **`tasks.dismissNeedsYou { taskId, itemId }`:** the driver or a project admin closes an open `restore_conflict` item (`dismissed`, with who and when). That's the target's `Carry on without it`. Other reasons are refused in milestone 2.
- **`capabilities`:** `stop` is false once a limit or a crash has ended the session, and false in `in_review`, `merged` and `done`. `reopen` and `send` are what the composer reads. The client never works out which from the state.
- **`tasks.get`** also returns, for the task-ticket target:
  - the agent and the model
  - the box's state, with the time its idle stop is due
  - the spend, with its cap and the unit (`usd` or `tokens`)
  - the start time and the runner's name
  - each session's `previousBox`
  - each PR's state per repo: `open`, `merged` or `closed`

## Done when

- [ ] Tests: reopening from each allowed state, once per message ID; refusals with their reasons; `tasks.get` returns every new field and nothing from another organization; a watcher can reopen only when they can read the project.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add reopen and the task's ticket`.

## Comments
