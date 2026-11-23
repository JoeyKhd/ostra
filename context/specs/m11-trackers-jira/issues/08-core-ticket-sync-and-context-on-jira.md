# 08: Core: ticket sync, context and writes on a Jira board

Status: done
Builder: core
Blocked by: 03, 05, 07
Features: F-008, F-149, F-097, F-011, F-106, F-032, F-077
Packages: `apps/core` (`tracker/writer.ts`, `tracker/context.ts`, `tracker/read-changes.ts`, `reactions/`, `automations/`, `starts/`, the notification comments), `packages/domain` (`tickets/ticket-writes.ts`'s move outcome)
Spec: `../spec.md`, sections 1, 4 ("A move") and 6; ADR 0047, ADR 0070

## What to build

Prove, and fix where it isn't, that everything core does with a Linear ticket outside agent mode works on a Jira board, through the board's own connection:

- **Moves:** ticket sync's `move` writes keep `via` on the `TicketWrite`; a `conflict` (no route) marks the write done-with-nothing, and the progress comment gains `movedNot`'s line; Done is moved only when the board's `doneBy` is `ostra`.
- **The progress comment** is written in ADF by the adapter from ostra's markdown and edited in place (`OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES` as for Linear); the task's link and each PR's are remote links, once each.
- **Ticket context and files** (milestone 9): `ticket.fetch-context`, a reopen's `ticket.read-changes`, "Send ticket updates" and Retry read a Jira ticket through its adapter (ADF already markdown), its files by `downloadFile`, its sub-tasks as children.
- **Starts:** intake rules (label, status, assignee, the Jira project), schedules' ticket queries, Create ticket and the prompt-ticket setting (F-097) on a Jira board; the Inbox's start; sub-tasks as their own tasks (F-077).
- **PR links:** a Jira board's PRs carry the key in the branch and the title (as today), with no magic word in the body (`magicWords: false`).
- **Agent mode** stays Linear's: nothing here starts for a Jira connection.

## Done when

- [x] Tests named for `F-008/c5`: through core against the fake Jira, a task's start, first PR and merge move the ticket by its transitions with `via` kept; a ticket in a status with no route stays put and the progress comment says so (break-it: call `updateStatus` instead, and the fake refuses it).
- [x] Tests named for `F-008/c6`: a task started from a Jira ticket gets its description and comments as markdown, its sub-tasks and its files in the first message; ostra's comment is posted once in ADF and edited in place; the task's and the PR's remote links are made once each across a replay.
- [x] Tests named for `F-008/c7`: an intake rule on a Jira board starts its task; Create ticket and a prompt task with the setting on make a Jira ticket; a reopen reads the ticket again; with `doneBy` `tracker` nothing moves at merge.
- [x] Tests named for `F-149/c1` and `F-149/c7` on a Jira board: the files cases and a reopen's changes, through core.
- [x] Checks for `apps/core` and `packages/domain` pass (spec section 10).
- [x] Committed as `✨ sync Jira tickets through their workflow`.

## Comments

- 2026-11-23, core: built as `✨ sync Jira tickets through their workflow`. Tests in `apps/core/src/tracker/jira-sync.test.ts` (11, on Postgres, through `attachBoard`, `startTicketTask`, `ticket.fetch-context`, `task.open-pull-requests`, the App's merge webhook, `ticket.sync`, `pollBoard` with `intake.match`, `createTicketForTask`, `createPromptTask` with the setting on, and a reopen's `ticket.read-changes`, against three HTTP fake Jira sites, two of them with project `OJ` and the same issue IDs). Linear's own sync, files and intake tests pass unchanged. Readings and differences:
  - **A move's outcome** (`domain/tickets/ticket-writes.ts`): `ticket.sync` settles a move itself (`settleMoveInTx`) with its `TicketMoveOutcome`: `moved` keeps `MoveResult.via` in `TicketWrite.via` (`[]` for Linear, or when the ticket was already there); `stays` (the adapter's `conflict`, no route) is done with nothing written, `via` `[]`, and `movedNot`'s line in the row's `error`, the names read from the tracker (`getTicket`, `listStatuses`). `moveOutcomeOf(row)` reads a row back; ticket 10's "On Jira" rows should use it rather than read `error` on a done row as a failure. The progress comment shows the newest move's line (`stayedLineInTx`) and drops it once a later move goes through; a change either way writes a `progress` edit (reason `move`) in the same transaction, so the comment follows whatever order the writes apply in.
  - **A refused token:** `failRefusedToken` is wired into `ticket.sync` (the write fails with "the tracker refused the connection's token: replace it, then retry", for Retry sync once the token is replaced), `ticket.fetch-context` and `ticket.read-changes` (the read is `gone`, so a start goes on from the cached ticket). Core passes one `tokenRefused` to ingest, the writer and both reads.
  - **The magic word:** `openPullRequests` takes the kinds' declared capabilities (`trackerCapabilities`, core's `trackerKindCapabilities` from `LINEAR_CAPABILITIES` and `JIRA_CAPABILITIES`); a board whose tracker declares no `magicWords` gets no magic line in the PR body. The key stays in the branch and the title. Without the capabilities, every board keeps its word (the domain's other callers).
  - **Done by ostra** is the draft's default on a Jira board (`attachBoard` drafts with `transitions`); a board set to `integration` ("Jira automation") writes no move at merge.
  - **Not tested separately here,** as they run through the same shared paths: schedules' ticket queries (`listTickets`), "Send ticket updates" and Retry (`ticket.read-changes` with reason `member` and `retry`), sub-tasks as their own tasks (F-077, through `subIssues`), and the tracker notifications' comments (`OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES`, built per connection by `trackers.forConnection`). Agent mode stays Linear's: nothing here reads `agentSessions`. The break-it is dropped (the maintainer, 2026-11-21); the adapter refuses `updateStatus` on its own (ticket 03's tests).
