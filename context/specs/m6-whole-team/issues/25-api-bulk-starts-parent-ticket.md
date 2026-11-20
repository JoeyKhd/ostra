# 25: API: bulk starts and the parent ticket

Status: done
Builder: api
Blocked by: 11, 12
Features: F-107, F-077, F-010
Packages: `packages/api` (`src/routers/inbox.ts`, `src/routers/tickets.ts`)
Spec: `../spec.md`, section 4 ("A bulk start", "Sub-issues")

## What to build

- `inbox.startMany({ projectId, ticketIds, kind, agentProfileId, requestKey })` → the bulk start's ID; `inbox.bulkStart({ id })` and a live subscription of its items' outcomes.
- `inbox.list` gains each ticket's sub-issue count and "starts N tasks" for a code start.
- `tickets.parent({ ticketId })` → the children with their tasks' states, PRs and needs-you, the children on no board of the project, and the parent's refine task; `tickets.startSubIssues({ ticketId, requestKey })`.

## Done when

- [x] Tests: 50 accepted, 51 refused; a replayed request key returns the same bulk start; outcomes stream; the parent's view for a three-level tree; access as the project's.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add bulk starts and the parent ticket API`.

## Comments

- 2026-11-20, api: built as `✨ add bulk starts and the parent ticket API` (47bfef72). `inbox.startMany`, `inbox.bulkStart` and the Inbox's new fields are in `packages/api/src/routers/inbox.ts`; `tickets.parent` and `tickets.startSubIssues` in `tickets.ts`, with the tree in `ticket-tree.ts`; tests in `bulk-starts.test.ts` and `tickets.test.ts` (on Linear's adapter against the fake Linear server), and the isolation suite reads both. Readings and differences:
  - **The outcomes' stream:** no second subscription. ADR 0035 gives a tab one stream; each decided item sends the project's change notice on it (ticket 11's `startBulkItem`), and the panel reads `inbox.bulkStart` again. The test opens the stream, runs the items and sees the notice, then the outcomes.
  - **`inbox.startMany`** takes `kind` as `code` or `refine`; over `OSTRA_BULK_START_MAX` (50) it's `BAD_REQUEST` with nothing written.
  - **`inbox.list`** (and `get`) gain `subIssues` (open sub-issues in the cache) and `codeStart: { tasks, overLimit }`: how many tasks a code start starts, by the domain's leaf walk over the cache. The Inbox never calls the tracker.
  - **`tickets.parent`** reads the tree from the tracker, read-only (one `getTicketContext` per open ticket on the project's boards, to `OSTRA_SUB_ISSUES_DEPTH` levels), so a child on another team is listed `elsewhere` even when it was never cached; when the tracker can't be read it falls back to the cache (`source: cache`). A cached row on another project's board shows its key and link only. Each child carries its code task (state, needs-you reason, PRs) and whether a start would take it; the parent carries its latest refine task.
  - **`tickets.startSubIssues`** takes the `requestKey` the ticket names but needs no store for it: ticket 12's start is idempotent by the leaves' tasks (a repeat is `skipped: has-task`). The parent never gets a code task (`has-sub-issues`, ticket 12).
  - Proof: rows added to `context/proof/F-107.md`, `F-077.md` and a new `F-010.md`, all `partial` until ticket 32's screens; break-its recorded there (the limit, the request key, the item's notice, the walk's depth, the cache fallback, the leaf count, the access check).
