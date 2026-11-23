# 08: Core: ticket sync, context and writes on a Jira board

Status: ready-for-agent
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

- [ ] Tests named for `F-008/c5`: through core against the fake Jira, a task's start, first PR and merge move the ticket by its transitions with `via` kept; a ticket in a status with no route stays put and the progress comment says so (break-it: call `updateStatus` instead, and the fake refuses it).
- [ ] Tests named for `F-008/c6`: a task started from a Jira ticket gets its description and comments as markdown, its sub-tasks and its files in the first message; ostra's comment is posted once in ADF and edited in place; the task's and the PR's remote links are made once each across a replay.
- [ ] Tests named for `F-008/c7`: an intake rule on a Jira board starts its task; Create ticket and a prompt task with the setting on make a Jira ticket; a reopen reads the ticket again; with `doneBy` `tracker` nothing moves at merge.
- [ ] Tests named for `F-149/c1` and `F-149/c7` on a Jira board: the files cases and a reopen's changes, through core.
- [ ] Checks for `apps/core` and `packages/domain` pass (spec section 10).
- [ ] Committed as `✨ sync Jira tickets through their workflow`.

## Comments
