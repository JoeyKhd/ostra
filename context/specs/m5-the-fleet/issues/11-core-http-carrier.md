# 11: Core: the HTTP carrier

Status: done
Builder: core
Blocked by: 01
Features: F-013, F-045, F-061
Packages: `apps/core` (`src/gateway/http-carrier.ts` (new), `src/gateway/connections.ts`, `src/gateway/endpoints.ts`)
Spec: `../spec.md`, section 4 ("The HTTP carrier"); ADR 0034

## What to build

Ported from `spikes/runner-transport/src/server/replica.ts`, onto the gateway's own session code, so a WebSocket and an HTTP connection are two carriers of one session.

- **`POST /runner/v1/hello`:** the access token, the `hello` body; answers `welcome` with a new connection epoch, written to the presence row with `carrier: "http"`. A newer connection on either carrier evicts the older one.
- **`POST /runner/v1/up`:** a batch of up frames with `x-ostra-epoch` and `x-ostra-minor`; the same ingest transaction, idempotent on `(session_id, seq)`, acked after the commit; `409 { code: "superseded" }` when the epoch isn't the presence row's.
- **`GET /runner/v1/down?after=<seq>`:** commands after `seq` from the outbox, or a hold of up to 25 s woken by the replica's `LISTEN` (or the 2 s sweep), then `204`. Commands acked by `after`.
- **Liveness:** an HTTP connection is alive while a `down` poll is open or ended under 45 s ago; presence, the offline time and the grace work unchanged.
- **Version and revoke:** the minor window and its message on `hello`; a revoked runner's access token refused on every HTTP call (milestone 2's `runnerIsLive`).
- A sidecar's task token works on the HTTP carrier as on the WebSocket.

## Done when

- [x] Tests against the fake peer over HTTP, named for `F-013`: a batch stored once across a resend; a gap answered `resendFrom`; a held `down` woken by a command within 500 ms; a superseded epoch refused with `409` on `up` and `down`; a revoked token refused; a minor outside the window refused with the fix; a steer from another replica reaches the HTTP peer.
- [x] Break-it: acking before the commit fails the stored-once test; recorded in `context/proof/F-013.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the HTTP carrier`.

## Comments

- 2026-11-20: built. `apps/core/src/gateway/http-carrier.ts` serves `POST /hello`, `POST /up` and `GET /down?after=` on the gateway's own session code: `connections.ts` hands it the WebSocket's `acceptHello`, its per-frame handling (ingest, command acks, status, live text, runner events), its command acks and its presence close (`CarrierSession`), and routes its LISTEN notices, sweep, presence pass and stop to it. A hello writes the presence row with `carrier: "http"` and a new epoch, as the WebSocket's does, so a newer connection on either carrier supersedes the older: an older WebSocket held here is evicted at once (and on other replicas by the `connected` NOTIFY), and an older HTTP connection's requests, held polls included, get `409 { code: "superseded" }`. The epoch is checked against the presence row on every request, so any replica serves any request. `up` answers an events frame's acks only after its transaction committed. `down` acks the commands up to `after`, answers the ones after it, or holds up to `longPollMs` (25 s, a new gateway timer), woken by the LISTEN's `command` notice or the 2 s sweep, then `204`. A runner on HTTP stays connected while a poll is open or ended under the dead time (45 s); the replica that served it then closes its presence as a WebSocket's close does, unless another replica refreshed it since. The access token is checked on every call, and `runnerIsLive` refuses a revoked runner's (`403`); a version outside the window is refused at `hello` with `426` and the WebSocket's message with the fix.
- Departures: (1) a box's sidecar keeps the WebSocket: a task token on the HTTP carrier is refused with `400` and says so. The sidecar's own HTTP fallback needs its session (`sidecars.ts`) on this carrier and comes with the runner's fallback (ticket 18) or ticket 20. (2) An `up` batch whose frame doesn't parse is refused whole with `400`; the WebSocket's salvage of an events frame with one bad body isn't ported to the batch. (3) The tests are named for F-013 only, so F-045's and F-061's rows don't cite them yet.
- Tests: `apps/core/src/gateway/http-carrier.test.ts`, eight, against a fake peer over HTTP (`apps/core/src/testing/fake-http-peer.ts`) on two replicas of the real gateway with the real ingest and one database. Break-its: acks answered before the commit (the stored-once and gap tests failed), the epoch check, the revoke check and the quiet-connection close dropped, and held polls not woken on a command's NOTIFY (each failed its test). Proof: `context/proof/F-013.md`, the fallback row, `partial` until the runner's fallback (ticket 18). Checks: typecheck and lint of `@ostra/core` and its dependents, the tests of `@ostra/core`, `check:licenses`, `check:proof`.
- 2026-11-20: commit d94ee8d9 (`✨ add the HTTP carrier`).
