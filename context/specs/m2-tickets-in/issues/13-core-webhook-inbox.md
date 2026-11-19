# 13: Core: the webhook inbox

Status: ready-for-agent
Builder: core
Blocked by: 05, 06
Features: F-043, F-046, F-005, F-031
Packages: `apps/core` (`src/webhooks/`)
Spec: `../spec.md`, section 4 ("A webhook")

## What to build

- **Two routes on core's public address:** `POST /webhooks/linear/:connectionId` and `POST /webhooks/github/:connectionId`. The connection's ID routes the delivery to its organization (ADR 0047's per-connection URL); an unknown or revoked connection answers 404 and stores nothing.
- **The order, and nothing else before the 200** (ADR 0013): read the raw body (capped at 1 MiB *(working value)*), verify with the connection's secret through the adapter, then one transaction: insert the `WebhookDelivery` (payload, delivery ID, signature hash, transit time) claimed by the unique `(connectionId, deliveryId)` and, for Linear, `(connectionId, signatureHash)`, and enqueue `webhook.process` with the delivery's ID. Then 200. A duplicate delivery answers 200 and enqueues nothing.
- **The deadline:** the insert gets `OSTRA_WEBHOOK_INSERT_DEADLINE_MS` (2000). Past it, or on any failure, the answer is 503, so Linear retries (after 1 min, 1 h, 6 h) instead of losing an event behind a 200.
- **A bad signature or a stale timestamp** answers 400, stores nothing, and logs the connection, the reason and the transit, never the body.
- **Transit and skew:** each delivery's transit (our receipt minus the sender's timestamp) is stored; a skew over 10 s logs a warning naming the connection, because a clock a minute off would refuse every webhook.
- **`lastEventAt`** on the connection, for the panel's "last event received".
- **`webhook.process`** dispatches by connection kind to ticket 14's and ticket 16's handlers, marks the delivery `processed` or `failed` with a reason in words, and never acts twice on one delivery.
- **`OSTRA_DEV_BLOCK_WEBHOOKS`** (development only, a comma list of `linear`, `github`): the routes answer 503 without storing, for the demo's and the failure suite's "drop webhooks". Its line goes in the development part of `docs/configuration.md`.

## Port from

`spikes/linear-agent-mode/src/server.ts` (verify, claim, 200, then work).

## Done when

- [ ] Tests: a valid delivery is stored once and processed once, also when it's sent twice at the same moment; a replay of every stored delivery changes nothing; a slow insert answers 503 and stores nothing half-done; a bad signature, a stale timestamp and another organization's connection ID are refused; the body never reaches a log line.
- [ ] Measured on this machine against embedded Postgres: the time to the 200 at p50 and p99 over 200 deliveries, recorded under `## Comments`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the webhook inbox`.

## Comments
