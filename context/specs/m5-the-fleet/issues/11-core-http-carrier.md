# 11: Core: the HTTP carrier

Status: ready-for-agent
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

- [ ] Tests against the fake peer over HTTP, named for `F-013`: a batch stored once across a resend; a gap answered `resendFrom`; a held `down` woken by a command within 500 ms; a superseded epoch refused with `409` on `up` and `down`; a revoked token refused; a minor outside the window refused with the fix; a steer from another replica reaches the HTTP peer.
- [ ] Break-it: acking before the commit fails the stored-once test; recorded in `context/proof/F-013.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the HTTP carrier`.

## Comments
