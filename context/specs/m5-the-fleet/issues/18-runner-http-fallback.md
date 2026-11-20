# 18: Runner: the HTTP fallback

Status: done
Builder: runner
Blocked by: 01, 06
Features: F-013
Packages: `apps/runner` (`src/connection/peer.ts`, `src/connection/http-carrier.ts` (new), `src/cli/`)
Spec: `../spec.md`, section 4 ("The HTTP carrier"); ADR 0034 ("Networks")

## What to build

Ported from `spikes/runner-transport/src/runner/peer.ts` and `run-runner.ts`, onto the runner's own peer, so both carriers share the spool, the credit window and the command handling.

- **The HTTP carrier:** `hello`, then a loop of `up` batches from the spool and `down` polls, with the epoch and minor headers; `409` means another connection holds the runner, so this one stops and reconnects from scratch.
- **The triggers** (ADR 0034): the upgrade gets a non-101 answer after TLS succeeded; the socket dies within 10 s three times in a row; or the upgrade succeeds and no `welcome` arrives within 10 s. After a `welcome`, silence is a network failure and never a reason to fall back. An answer that isn't an ostra envelope (a proxy's HTML) is a network failure, logged as such.
- **Back to WebSocket** every `OSTRA_RUNNER_WS_RETRY_MINUTES`, while HTTP keeps working.
- **`--transport auto|websocket|http`** and `OSTRA_RUNNER_TRANSPORT`.
- **Proxies:** `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS` through Node's own `https.Agent` with `proxyEnv`, on both carriers (no new dependency).
- `ostra runner status` shows the carrier and why it fell back.

## Done when

- [x] Tests against ticket 06's proxies and core's carrier (ticket 11), named for `F-013`: each trigger falls back within 30 s; the CONNECT proxy, with and without Basic auth, stays on WebSocket; a TLS proxy that answers 101 and holds falls back on the missing `welcome`; a silent connection after `welcome` reconnects without falling back; the retry returns to WebSocket; every event stored once across a switch; a steer arrives over HTTP.
- [x] Break-it: removing the `welcome` timeout leaves the holding proxy's runner stuck and fails its test; recorded in `context/proof/F-013.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the runner's HTTP fallback`.

## Comments

- 2026-11-20: built. `apps/runner/src/connection/peer.ts` runs both carriers on one session: a `Link` per connection carries the frames, so the spool, the credit window, the command chain and the runner events are the same on a WebSocket and on HTTP. The HTTP carrier says `hello` (`POST /hello`, the welcome's epoch), then runs a `down` loop (`GET /down?after=<lastContiguousSeq>`, once the commands in hand are applied) and an `up` loop (the outbox in batches under core's 2 MiB cap), every request with the access token, `x-ostra-minor` and `x-ostra-epoch`; a `409 superseded` says hello again from scratch. `auto` falls back on ADR 0034's three triggers: an upgrade answered by something that isn't ostra (ostra's 401, 403 and 5xx keep their meaning; ostra's own 426 for a GET without Upgrade, as behind nginx, counts as dropped on the way), an upgraded socket with no `welcome` within the handshake timeout, and three sockets in a row that the far side closed within 10 s of opening; a silent connection that the runner's own dead check ends is never counted. On HTTP it tries the WebSocket again every `OSTRA_RUNNER_WS_RETRY_MINUTES`. A proxy's page on either carrier is a network failure, logged as such. `src/connection/http-carrier.ts` holds the agents (`https.Agent` with Node's own `proxyEnv`) and the request and answer readers; `main.ts` also calls `http.setGlobalProxyFromEnv` where Node has it, so the CLI's fetch calls (the token, the spec) go through the proxy too. `ostra runner status` shows the carrier and why it fell back (`status.json`'s new `carrier`).
- Tests: `apps/core/src/gateway/runner-fallback.test.ts` runs the real `startConnection` (now exported from `@ostra/runner`) against core's real gateway, HTTP carrier and ingest, through ticket 06's CONNECT proxy (with and without Basic auth), its TLS-inspecting proxy (block and hold), its nginx emulation, and a TLS front of the test's own that kills or silences upgraded sockets, on the runner's real 10 s timers; plus a status test in `cli.test.ts`. Break-its, each failing its test: the welcome timeout removed, no fallback on a refused upgrade, no quick deaths counted, a silent connection counted as one, no WebSocket retry, events dropped from the HTTP batches, commands ignored on `down`, and the agents built without the proxy settings. Two first tries didn't fail and were replaced (dropping the resend pointer: core's `resendFrom` covers it; `after=0`: the command-ack frame acks too). Proof: `context/proof/F-013.md`, row 4 `proved`.
- Departures: (1) the tests are in `apps/core`, where core's real carrier is, against the runner's connection; the runner's fake gateway stays WebSocket only. (2) `startConnection`'s default transport is `websocket`, so a box's sidecar (whose task token core refuses on HTTP, ticket 11) keeps its WebSocket; the runner passes its `--transport`. (3) The fake gateway's refused upgrade now carries ostra's error body, as core's does, since a bodiless 401 now reads as a proxy's.
