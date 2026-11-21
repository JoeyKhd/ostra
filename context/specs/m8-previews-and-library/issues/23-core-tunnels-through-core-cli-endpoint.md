# 23: Core: tunnels through core, and `ostra preview`'s endpoint

Status: done
Builder: core
Blocked by: 08, 19
Features: F-143
Packages: `apps/core` (`previews/`, `cli/`), `apps/web/src/app/api/cli/v1/` (the ticket route), `packages/domain` (bodies)
Spec: `../spec.md`, sections 4 ("A tunnel") and 5.1; ADR 0068 ("`ostra preview`")

## What to build

- **Core as the HTTP/2 client** on a view in `tunnel` mode: open the box's HTTP/2 connection once per view, keep it while the view lives, and close it with the view. Forwarding between replicas works as ticket 19's, for tunnel views too.
- **The ticket:**
  - `POST /api/cli/v1/tasks/:ref/previews/tunnel` on the web app, through its CLI route as `ostra checkout`'s;
  - for a member whose CLI session can open the task, it resolves the port (the primary's when none is given), checks `mayReach`, and returns `{ coreUrl: OSTRA_CORE_PUBLIC_URL, ticket, port }`;
  - or a refusal: `not-found`, `port-not-allowed`, `runner-cannot-tunnel` (the HTTP carrier or a minor-6 runner) or `no-box`.

  The ticket is single use, lasts 60 s, and is bound to the member, the task, the port and the lease epoch (ticket 05).
- **`GET /cli/v1/tunnel?ticket=…`** on core:
  - it redeems the ticket, opens a view in `cli` mode with its audit entry, and upgrades to a WebSocket;
  - it serves an HTTP/2 connection to the CLI, as the server, where each of the CLI's `CONNECT` streams is bridged to a `CONNECT` stream on the box's connection;
  - it checks the CLI session again every 5 minutes, and ends the tunnel when the session is revoked.
- **No box running:** the ticket route says `no-box`, and the CLI offers "Start the app" (ticket 24) through `POST /api/cli/v1/tasks/:ref/app/start`, which calls `startApp` (ticket 19) for the session's member.

## Done when

- [x] Tests named for `F-143`:
  - a ticket used twice refused, and one after 60 s refused (break-it: skip the use mark, and the case fails);
  - a port outside the previews refused;
  - a revoked CLI session ending the tunnel;
  - a CONNECT carried from a fake CLI through core to the fixture app on `host`;
  - two replicas with the box on the other.
- [x] The whole-repo checks pass, since this touches auth (spec section 10). *Run as the lead's rules of 2026-11-20 say: typecheck, lint and tests of the touched packages (protocol, db, domain, api, core); GitHub CI runs the rest.*
- [x] Committed as `✨ add tunnels through core for the CLI`.

## Comments

- 2026-11-21, core (ticket 19): the seam for the tunnel is `apps/core/src/previews/previews.ts`'s upgrade, which refuses a view whose mode isn't `stream` (404) until this ticket takes the `ostra-preview-tunnel.v1` subprotocol there. The view's presence (`PreviewView.replicaUrl`), the replica signature (`x-ostra-replica-signature`, taken alone on a forwarded request) and the lease check (`checkBoxLease`) are shared; `forward` streams a request on to the holding replica.
- 2026-11-21, core (ticket 23): built as `✨ add tunnels through core for the CLI`. Tests: `apps/core/src/previews/tunnels.test.ts` (`F-143/c2`: the fixture's real Vite and its API on free ports of this machine, through a fake `ostra preview`, core and a fake box on `host`: the page, `/@vite/client`, `/api/hello` through Vite's proxy, the API's WebSocket echo, Vite's HMR socket with an edit reaching it, and an extended CONNECT on the box's session to Vite's HMR, as ticket 25's proxy will send one; `F-143/c4`: a ticket used twice and one 61 s old by core's `Clock` refused, its row a hash bound to the CLI session, and an upgrade with an `Origin` refused; `F-143/c3`: a port outside the previews refused at the ticket and as a CONNECT in the tunnel, the box never reached; `F-143/c4`: a revoked CLI session ends the tunnel with 4401 and closes the view), `replicas.test.ts` (`F-143/c2`: two core processes, the CLI's tunnel on B and the box's connection on A, a page and 2 MiB whole through B's relay, and another port refused on A), and `packages/api/src/services/cli-http.preview.test.ts` (`F-143/c1`, `c3`, `c5`, `c6`: the ticket for the primary's port with core's address, another organization's member and no session refused, ports outside the previews and below 1024, the HTTP carrier and minor 6, `no-box`, and the start route sending `app.start`). The condition keys follow the ledger row's sentences, as ticket 03's did: c1 the member's session and the primary's port, c2 a connection through core to the box, c3 only the previews' ports, c4 the ticket and the session, c5 "Start the app", c6 the HTTP carrier and minor 6. Readings and decisions:
  - **Where things live:** the rows in `packages/domain/src/previews/cli-tunnel.ts` (`issueCliTicket`, `redeemPreviewCodeInTx` and `redeemCode`, which ticket 25's handshake can call for `enter`, `openCliView`, `checkCliTunnel`); the bytes in `apps/core/src/previews/tunnels.ts` (the box's HTTP/2 client session per tunnel view, and the CLIs' HTTP/2 servers, each CONNECT spliced with `spliceStreams`) and `cli-tunnel.ts` (`/cli/v1/tunnel`, the forwarding, the heartbeat and the 5-minute check); the routes in `packages/api/src/services/cli-http.ts`, behind the web app's existing catch-all CLI route.
  - **The ticket is bound to the CLI session** too: a small additive migration (`20261201160000_preview_code_cli_session`) adds `PreviewCode.cliSessionId`, since core can't check a session it can't name. `IssueCliTicket` and `RedeemCode` take narrower deps than ticket 05's signatures (the database, the clock and core's address).
  - **The upgrade waits for the box** (10 s, the stream's wait): a refusal is an HTTP answer with `cliTunnelErrorSchema`'s code and words, and an open tunnel is one that carries. A refused ticket is spent. The protocol gains `cliTunnelErrorSchema`, `cliTunnelErrorWords`, `cliTunnelCloseCodes` (4401 session ended, 4410 view closed, 4404 box gone, and 1001) and `cliTunnelCloseWords`, for ticket 24 to print, and `previewTunnel.messageMaxBytes` (16 MiB) for both ends of a tunnel.
  - **Across replicas,** the replica with the CLI's socket relays its WebSocket messages as they are to the holder over a signed WebSocket (`/cli/v1/tunnel?view=&port=`, the signature over both), pausing its reader while 64 messages are unsent. The holder serves the HTTP/2, so the CONNECT check and the box's session stay in one place.
  - **The heartbeat:** the cli view lapses after 2 minutes without one like any view, so the replica with the CLI's socket writes it every 30 s with `heartbeatView`, which also writes `Box.previewWatchedAt`: an open `ostra preview` counts as watching, to the same warm cap. ADR 0068 and `domain-model.md` say so.
  - **The ADR's "dial 127.0.0.1"** in `previewTunnel`'s comment now says `localhost` over IPv6 and IPv4, as spike 08 amended it.
  - **Seams for the next tickets:** ticket 22's sidecar opens `/runner/v1/preview?view=&leaseEpoch=` with the `ostra-preview-tunnel.v1` subprotocol for a view in `cli` (or `native`) mode and serves HTTP/2 on it with `enableConnectProtocol`; core sends plain `CONNECT`s with `:authority` `localhost:<port>` and expects the sidecar's own `mayReach` refusal as a non-200 status, which reaches the CLI. `apps/core/src/testing/tunnels.ts`'s fake box is that contract in miniature. Ticket 24's CLI posts the ticket route, opens `<coreUrl>/cli/v1/tunnel?ticket=…` with the `ostra-cli-tunnel.v1` subprotocol and no `Origin`, speaks HTTP/2 as the client, and reads `cliTunnelErrorSchema` on a refused upgrade and `cliTunnelCloseCodes` on a close; the fake CLI there is its outline. Ticket 25's proxy sends on `previews.tunnels.session(viewId)` once its view is in `native` mode.
  - **Left open:** the real sidecar (22) and CLI (24); the native preview's forwarding across replicas (25: the tunnel hub holds the session only on the box's replica); the check every 5 minutes reads the session and the member's access, not the box's lease, which the views' check already follows (a stale lease ends the tunnel with 4404).
