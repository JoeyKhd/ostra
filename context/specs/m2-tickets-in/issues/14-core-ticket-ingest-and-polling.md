# 14: Core: ticket ingest and polling

Status: done
Builder: core
Blocked by: 01, 07, 08, 13
Features: F-005, F-010, F-042, F-044
Packages: `apps/core` (`src/tracker/`), `packages/domain` (`ingestTicketHint`)
Spec: `../spec.md`, sections 4 ("A ticket change") and 11 (item 10)

## What to build

- **`ingestTicketHint`:** a webhook is a hint. For an `Issue`, `Comment`, `Attachment` or `IssueLabel` delivery on an attached board, fetch the ticket through the adapter and upsert its `Ticket` row by `(boardId, externalId)`, never by the key. A ticket whose team moves to an unattached team is marked removed from that board, not deleted. A change whose actor is the connection's own app user is recorded and not acted on.
- **`tracker.poll-board`:** a schedule per board, created when the board is attached and removed when it's detached. On a `polling` connection it runs every `OSTRA_TRACKER_POLL_SECONDS` (60); on a `webhooks` connection every `OSTRA_RECONCILE_MINUTES` (5), as the drift check (F-044). It lists tickets updated since the board's cursor minus 2 min of overlap, ordered by `updatedAt`, a page per transaction, and moves the cursor after each page commits. A restart picks up from the cursor.
- **`linear.refresh-token`:** a delayed job one hour before the access token expires; it refreshes through ticket 08, stores the rotated pair through the secret store, and reschedules itself. A refused refresh marks the connection `failed` and opens a needs-you item for the organization's admins; polling and writes then stop for that connection, visibly.
- **The rate budget:** every call goes through the connection's budget, so polling many boards never spends the hour's 5,000 requests (ticket 15 backs the store).
- **The mode switch:** a connection whose webhooks go silent while polling still finds changes is flagged in the panel ("webhooks silent since …"), never switched off on its own.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **No own-echo filter without an app user.** A connection with `appUserId` null (the `api_key` seed) has no own-echo filter. The cache upsert always happens either way, since the filter only skips reactions. Ticket 15's marker lookups keep writes from looping.
- **`webhook.process` sets `WebhookDelivery.ticketKey`** once it has read the ticket.

## Done when

- [x] Tests against the fake Linear server: a webhook hint fetches and upserts; a change by the app's own user isn't acted on; a moved ticket keeps its row and gets its new key; polling with webhooks off finds a change within one interval; a cut in the middle of a page loses nothing and stores nothing twice; the cursor survives a restart; the token refreshes before it expires, and a refused refresh fails visibly.
- [x] Gated on `linear.env`: a ticket created in `OST` reaches the cache through polling within 60 s.
- [x] Committed as `✨ add ticket ingest and polling`.

## Comments

- 2026-11-19, core (m2-core-a): built. **Domain:** `tickets/ticket-cache.ts` is `ingestTicketHint`'s body (wired into `use-cases/tickets.ts`), with `upsertTicketCacheInTx` and `markTicketRemovedInTx`. A hint is read through the adapter: the hint's team first, then the teams of the boards holding a copy, then the connection's other boards; the copy is upserted on every attached board of that team, never moved back by an older read; copies on other teams' boards keep their rows, take the new key (and so do their tasks' `ticketKey`) and get `removedAt`. A ticket the tracker no longer shows anywhere is marked removed, not deleted. The own-echo filter applies only with an app user; the cache is upserted either way. **Core:** `tracker/ingest.ts` has `webhook.process`'s Linear handler (it sets `WebhookDelivery.ticketKey`), `tracker.poll-board` (`pollBoard`: from the cursor minus 2 min, `order: "updatedAt"`, a page per transaction with the cursor moved in it, at most 20 pages a run) and the schedules: core makes one per attached board from the rows every 30 s (the panel can't), every `OSTRA_TRACKER_POLL_SECONDS` (rounded to whole minutes: pg-boss's cron) on a polling connection and every `OSTRA_RECONCILE_MINUTES` on a webhooks one, and drops a detached board's. `tracker/refresh-token.ts` is `linear.refresh-token` through ticket 08's `refreshToken`: the rotated pair goes to the secret store, the row points at it, the old pair is deleted; `invalid-grant`/`invalid-client` marks the connection `failed` with the reason and an audit entry (polling then skips it and writes fail visibly). The job can't queue its own next run while it runs (its queue holds one job per key), so core's 30 s tick queues the next refresh for every active app connection that has none. **Contract change, its own commit:** an additive migration `20261120040000_tracker_drift` adds `Connection.webhooksSilentSince` (set when polling finds changes the webhooks never brought, cleared by the next webhook; the mode is never switched) and `Board.lastPollChanged`, for ticket 27's `silentSince` and the panel's "last poll" line. **Not done, needs a schema decision:** a refused refresh can't open a needs-you item for the admins, because `NeedsYouItem` needs a task; the failed connection is what the panel shows. The tracker's `Ticket` has no assignee, so ingest leaves ticket 29's `assigneeId`/`assigneeName` null. The order `listTickets` gets with `order: "updatedAt"` on real Linear is the adapter's (ticket 07); the poll only needs it oldest first per page, which the fake does. Tests: `ingest.test.ts`, 11 cases on the fake Linear server through the real Linear adapter (a cut mid-page is a ticket Postgres refuses, so its page rolls back and the cursor stays). **Live, on `ostra-test`** (`linear.env`, 2026-11-19): a ticket created in `OST` reached the cache through polling in 0.4 s; the test archives it.
