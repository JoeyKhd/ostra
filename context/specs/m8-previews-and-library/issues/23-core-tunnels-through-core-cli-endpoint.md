# 23: Core: tunnels through core, and `ostra preview`'s endpoint

Status: ready-for-agent
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

- [ ] Tests named for `F-143`:
  - a ticket used twice refused, and one after 60 s refused (break-it: skip the use mark, and the case fails);
  - a port outside the previews refused;
  - a revoked CLI session ending the tunnel;
  - a CONNECT carried from a fake CLI through core to the fixture app on `host`;
  - two replicas with the box on the other.
- [ ] The whole-repo checks pass, since this touches auth (spec section 10).
- [ ] Committed as `✨ add tunnels through core for the CLI`.

## Comments

- 2026-11-21, core (ticket 19): the seam for the tunnel is `apps/core/src/previews/previews.ts`'s upgrade, which refuses a view whose mode isn't `stream` (404) until this ticket takes the `ostra-preview-tunnel.v1` subprotocol there. The view's presence (`PreviewView.replicaUrl`), the replica signature (`x-ostra-replica-signature`, taken alone on a forwarded request) and the lease check (`checkBoxLease`) are shared; `forward` streams a request on to the holding replica.
