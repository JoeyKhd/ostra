# 18: Runner: the HTTP fallback

Status: ready-for-agent
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

- [ ] Tests against ticket 06's proxies and core's carrier (ticket 11), named for `F-013`: each trigger falls back within 30 s; the CONNECT proxy, with and without Basic auth, stays on WebSocket; a TLS proxy that answers 101 and holds falls back on the missing `welcome`; a silent connection after `welcome` reconnects without falling back; the retry returns to WebSocket; every event stored once across a switch; a steer arrives over HTTP.
- [ ] Break-it: removing the `welcome` timeout leaves the holding proxy's runner stuck and fails its test; recorded in `context/proof/F-013.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the runner's HTTP fallback`.

## Comments
