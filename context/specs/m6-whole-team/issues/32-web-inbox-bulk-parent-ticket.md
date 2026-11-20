# 32: Web: the Inbox's bulk start and the parent ticket

Status: done
Builder: web
Blocked by: 25, 30
Features: F-107, F-077, F-010
Packages: `apps/web` (the Inbox, `src/routes/projects/$projectId/tickets/$ticketId.tsx`)
Spec: `../spec.md`, section 12 (`inbox-bulk-start`, `ticket-parent`, and the Inbox and New task growing)

## What to build

- The Inbox's checkbox column, the selection bar, the kind and profile for all, and each ticket's streamed result; sub-issues folded under their parent with "starts N tasks".
- The parent ticket's page with its children, their tasks and PRs, the children elsewhere, and "Start sub-issues".
- New task: "This starts N tasks, one for each sub-issue".

## Done when

- [x] Playwright: select four tickets and start them, one skipped with its reason; open a parent's page and see its children move.
- [x] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add bulk starts and the parent ticket`.

## Comments

- 2026-11-20, web: built as `✨ add bulk starts and the parent ticket` (3d920128). The Inbox's tick column (`x` ticks the focused row, Shift-click a range, ⌘A/Ctrl+A every loaded row, Esc clears), the selection bar in place of the filters, and the bulk-start panel in place of the ticket's (`apps/web/src/components/inbox/bulk-start.tsx`); the parent's page at `/projects/[project-id]/tickets/[ticket-id]` (`apps/web/src/components/tickets/`), linked from a parent's `N sub-issues` chip; and a parent's start sheet, which says "This starts N tasks, one for each sub-issue" and starts them through `tickets.startSubIssues`. Proved by `apps/web/e2e/19-inbox-bulk.spec.ts` on the stack's fake Linear (four ticked, three started through core's `bulk.start-item` worker, the one with a task skipped with "it already has a task"; a parent's chip, its "starts 2 tasks", its page, and "Start 2 sub-issues" moving both rows to Queued) and `bulk-start.test.tsx`, with break-its recorded in `context/proof/F-107.md`, `F-077.md` and `F-010.md`.
  - **Checked against the targets** at 1440 px and 412 px, dark and light (`_lead/ui-check/m6-inbox-bulk-*`, `m6-ticket-parent*`, `m6-light-inbox-bulk-start`, `m6-light-ticket-parent`). Differences:
    - **A ticked parent goes to `tickets.startSubIssues`, not `inbox.startMany`:** the bulk start skips a parent (`has-sub-issues`, ticket 11: a parent never runs code), so the panel starts a ticked parent's leaves through the parent's own start, as its page does. The rest go to `inbox.startMany` as one bulk start, the ticket with a task included, so the server says why it's skipped.
    - **The preview is what the Inbox knows** (a task already, sub-issues, over the limit, no leaf on the boards), as `inbox-bulk-start.md` allows: there is no `inbox.previewStart`, so "Queued: build-fleet is full" shows only once a result says it. "Run on" is the project's pools, as text: a bulk start never goes to a personal runner.
    - **Sub-issues aren't folded under their parent in the list:** `inbox.list`'s rows don't say their parent. A parent carries its `N sub-issues` chip (counting every open sub-issue, on any board), which opens its page; a child is a row of its own.
    - **The parent's page:** the Now column says the task's state in words (Home's reason line isn't in `tickets.parent`); there's no "On Linear" sync group or "Started by" group (not in the API); a mid-level child shows as one row ("Has sub-issues of its own"). The open points take the recommendations: a stopped child isn't done; any member who can open the project may press Start.
    - The bulk start's results come from `inbox.bulkStart`, polled every second until done; the project's change notice also refreshes it (ticket 25's note).
  - The checkbox gained its indeterminate state (a minus), for the selection bar's.
