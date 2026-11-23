# 07: Core: Jira's webhook and polling, routed by connection

Status: ready-for-agent
Builder: core
Blocked by: 03, 05, 06
Features: F-008, F-152, F-042, F-044
Packages: `apps/core` (`tracker/connections.ts`, `webhooks/inbox.ts`, `webhooks/process.ts`, `tracker/ingest.ts`, new `tracker/token-expiry.ts`, the composition root, `main.ts`'s settings)
Spec: `../spec.md`, sections 4 ("An event", "Polling", "The token's date") and 6; ADR 0047, ADR 0071, ADR 0011

## What to build

- **The adapter per connection:** `createConnectionTrackers`'s `build` makes `JiraAdapter` for `jira` (with the cloud ID, the service account's email and the token from the secret store, `OSTRA_JIRA_API_URL` when set), and the connection's `appUserId` as its own user; `TrackerLookup` carries `kind` and `name`.
- **The webhook route:** `POST /webhooks/jira/:connectionId` beside Linear's and GitHub's (`webhookKinds` gains `jira`, `trackerVerifiers` a `jira` verifier). It finds the connection (`revoked` or unknown: `410`, nothing stored), verifies with that connection's secret only, claims `(connectionId, deliveryId)` and the signature's hash in one insert, answers 200, then enqueues the processing job. A pending connection's first valid delivery calls `activateOnFirstDelivery` in the claim's transaction; a bad signature on any Jira connection sets `badSignatureAt` and is answered 401. `OSTRA_DEV_BLOCK_WEBHOOKS` takes `jira`.
- **Processing:** `webhooks/process.ts` handlers by kind, Jira's the same shape as Linear's: parse the hint, record and skip an echo of the service account, fetch the ticket through the board's connection, ingest. A hint for a project no board of the connection holds is recorded and dropped.
- **Polling every kind:** `tracker/ingest.ts` polls every board whose `boardStateOf` is `attached`, by its own connection's adapter, whatever the kind: every `OSTRA_TRACKER_POLL_SECONDS` for a polling connection, every 5 minutes as the backstop for a webhook one; the drift check sets `webhooksSilentSince` for Jira as for Linear.
- **The token's date:** `tracker.token-expiry`, a daily job: the needs-you item for the organization's admins from 14 days before, once per connection and date; `failConnection(…, "token-expired")` on the day. A 401 from Jira on a saved token fails the connection with `token-refused` at once, and its needs-you item opens.
- **Linear-only paths gated by capability:** agent mode's event route and the token refresh run only for connections whose adapter declares them, per connection.

## Done when

- [ ] Tests named for `F-008/c3`: a signed delivery from the fake Jira is claimed once, answered before its job runs, and its ticket fetched before ingest; five replays make one row and one action; a wrong signature is 401 and stored nowhere; an echo of the service account is recorded and not acted on (break-it: verify with another connection's secret, and the isolation case fails).
- [ ] Tests named for `F-008/c1`: a pending Jira connection's first valid delivery activates it; a bad one sets `badSignatureAt` and leaves it pending.
- [ ] Tests named for `F-008/c4`: with no webhook, a ticket edited on the fake Jira is ingested by polling within one poll period; with webhooks, the 5-minute backstop finds a change no delivery brought and sets `webhooksSilentSince`.
- [ ] Tests named for `F-152/c3`: two Jira connections and two Linear connections in one organization: a delivery to one's URL signed with the other's secret is refused; each poll and fetch uses its own connection's credential (the fakes' request records).
- [ ] Tests named for `F-152/c5`: a revoked connection's URL answers `410`; its boards aren't polled; after a resume they're polled from their cursors.
- [ ] Tests named for `F-008/c8`: the expiry job opens one needs-you item 14 days before and fails the connection on the day; a 401 fails it at once.
- [ ] Checks for `apps/core` pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ take Jira's webhook and poll every tracker`.

## Comments
