# 14: Core: ticket ingest and polling

Status: ready-for-agent
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

- [ ] Tests against the fake Linear server: a webhook hint fetches and upserts; a change by the app's own user isn't acted on; a moved ticket keeps its row and gets its new key; polling with webhooks off finds a change within one interval; a cut in the middle of a page loses nothing and stores nothing twice; the cursor survives a restart; the token refreshes before it expires, and a refused refresh fails visibly.
- [ ] Gated on `linear.env`: a ticket created in `OST` reaches the cache through polling within 60 s.
- [ ] Committed as `✨ add ticket ingest and polling`.

## Comments
