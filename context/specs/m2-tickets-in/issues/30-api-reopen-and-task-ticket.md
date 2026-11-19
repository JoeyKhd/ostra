# 30: API: reopen and the task's ticket

Status: done
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

- [x] Tests: reopening from each allowed state, once per message ID; refusals with their reasons; `tasks.get` returns every new field and nothing from another organization; a watcher can reopen only when they can read the project.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add reopen and the task's ticket`.

## Comments
- 2026-11-19, api: done (`✨ add reopen and the task's ticket`, `7a50dc1`). **The reopen cases wait on ticket 18:** `reopenTask` and `dismissNeedsYou` were still stubs on `origin/main`, so the five cases of `task-ticket.test.ts` that go through them skip while they are stubs and run on their own once ticket 18 lands. They passed (all 16) against ticket 18's uncommitted code in `m2-core-b`, copied into this tree for one run and put back; whoever lands 18 should see them go green, or fix them if its behavior differs from the ticket's text. For tickets 18, 36 and 38:
  - **Procedures:** `tasks.reopen { taskId, clientMessageId, text? }` (any member who can read the project; errors map `merged_reopen_later` to PRECONDITION_FAILED, `ticket-has-task` and `not-reopenable` to CONFLICT, `text-required` to BAD_REQUEST), `tasks.dismissNeedsYou { taskId, itemId }` and `tasks.retrySync { taskId }` (domain `retryTicketWrites`: failed writes back to pending, each with its `ticket.sync` job; keys unchanged). The repo's async-APIs lint refuses a call to anything named `...Sync`, so a test (or web code that calls it directly) reads the procedure into a variable first; `.mutationOptions()` is fine.
  - **`tasks.get` gained** (all from the task's own rows in its organization): `ticket` (`{ id, key, title, url, status, cachedAt, removed }`), `contextFiles` (from the newest `ticket.files_ready` and the blobs' sizes), `sync` (each write: kind, state, attempts, error words, times; never its text), `sessions` (origin, state, outcome, times, `limit`, and `previousBox` from `session.restored`), `box` (`starting` | `running` | `idle` | `stopped` | `released` | `failed`, `idleStopDueAt` = idle since + `OSTRA_BOX_IDLE_MINUTES`, release reason, runner name), `spend` (`{ unit: "usd" | "tokens", spent, cap, reached }`, priced by `modelTokenPrices` as ticket 19 does), `limit`, `startedAt`, and each repo's `pr.state` (`open` | `merged` | `closed`).
  - **Capabilities:** `stop` is false in review, merged, done and stopped, and once a limit or a crash ended the session; `reopen` (stopped, in review, done, or needing you for no changes, a stall, the spend cap, a crash, a failed setup, a closed ticket or files outside the repos); `reopenBlocked` says why a task that looks reopenable isn't (`merged_reopen_later`, `ticket_has_task`, `spend_cap`: a task at its cap is refused until the cap is raised); `reopenWithoutText` is the one-click reopen (a stall, the cap, a crash); `retrySync`. `send` and `interrupt` are milestone 1's: a task in review with a warm box is reopened (the dispatch picks `resumed`), since the domain moves a reviewed task to queued on a member's act.
