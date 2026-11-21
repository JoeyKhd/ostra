# 24: CLI: `ostra preview`

Status: done
Builder: runner
Blocked by: 22, 23
Features: F-143
Packages: `apps/runner` (`cli/`), `docs/` (the CLI's reference page, which `cli-docs-reference.test.ts` checks)
Spec: `../spec.md`, sections 3 (step 9) and 4; ADR 0068 ("`ostra preview`")

## What to build

- **`ostra preview <task> [port] [--local <port>]`:**
  - `<task>` takes a ticket key, an ID or a URL, as `ostra checkout` does;
  - it gets a ticket (ticket 23) with the CLI session, opens `wss://<core>/cli/v1/tunnel?ticket=…`, and speaks HTTP/2 as the client on it;
  - it listens on `127.0.0.1:<local>` only, never on another interface. The local port defaults to the remote's, or the next free one;
  - each accepted TCP connection becomes one `CONNECT` stream;
  - it prints `http://localhost:<port>` and the preview's label, and ends cleanly on Ctrl+C;
  - it reconnects with a new ticket after a dropped connection, up to three times, and says so.
- **No box:** "This task's box isn't running. Start the app? [y/N]", which calls the CLI's start route (ticket 23) and waits for the primary to be ready.
- **Refusals** in the CLI's words: not found, the port isn't one of this task's previews, the runner can't tunnel (HTTP only, or too old), signed out.
- **The help text and the CLI's reference page** gain the command.
- **The glossary's CLI session** line (this spec's commit) says a CLI session can also open a preview.

## Done when

- [x] Tests named for `F-143`:
  - the command against a fake core: a local HTTP request and a WebSocket carried at once;
  - it listens on loopback only (break-it: listen on `0.0.0.0`, and the case fails);
  - each refusal's words;
  - the reconnect.
  *2026-11-21: and against the real web app route, core and the runner's side on `host` with the fixture's Vite (`cli-preview.test.ts`). No break-it pass ran (the maintainer, 2026-11-21): the loopback case reads the address the listener is bound to, which `0.0.0.0` would change.*
- [ ] Checked by hand: `ostra preview` against the fixture app on this machine, HMR seen in a browser tab, recorded under `## Comments`. *Changed 2026-11-21: its log was to be kept in `context/proof/`, gone with the proof files.* *2026-11-21: not done by hand. A browser-free client carries the page, `/api`, the API's WebSocket echo and Vite's HMR through the real command, route, core and runner on this machine (`cli-preview.test.ts`); a browser tab waits for the launch-gate demo.*
- [x] `cli-docs-reference.test.ts` passes with the new page.
- [x] Checks for `apps/runner` pass (spec section 10). *Run as the lead's rules of 2026-11-20 say: typecheck, lint and tests of the touched packages (protocol, domain, api, runner, core); GitHub CI runs the rest.*
- [x] Committed as `✨ add ostra preview`.

## Comments

- 2026-11-21, runner (ticket 24): built as `✨ add ostra preview`, on tickets 22 and 23. `apps/runner/src/cli/preview.ts` is the command, `preview-client.ts` its two ends on the member's machine: core's tunnel (the ticket in the URL only, `ostra-cli-tunnel.v1`, no `Origin`, the runner's own `webSocketDuplex` under HTTP/2 as the client, with the box's 1 MiB and 16 MiB windows, through the environment's proxy as a runner's link is) and the listener on `127.0.0.1`, each local connection one plain `CONNECT` joined with `spliceStreams`. Readings and decisions:
  - **The label:** the ticket's answer had no label to print, so the grant gains `label` (the preview's, from `issueCliTicket`), additive. **`core-unreachable`:** the start route's refusals gain it, additive, with its `503`; the route no longer words it as `no-runner`.
  - **The local port** is chosen before the ticket is used: the preview's own when nothing on this machine listens on it, over IPv4 or IPv6, since a browser's `localhost` may try `::1` first and reach another program there (Vite listens on `localhost`); else the next of 20, else one the system picks. `--local` is exact, and a taken one is refused.
  - **It waits for the app** before it prints the address: one `CONNECT`, whose `200` the box sends once the app's port answers (up to its ready wait, ADR 0068's "the way to a port"). A `403` there ends it with core's words; anything else warns and serves anyway.
  - **The reconnect:** 4401 and 4410 end it with their words; 4404, 1001 and a dropped network open it again with a new ticket for the same port, after 1, 2 and 4 s, saying so each time, and give up after three. The count starts afresh once a tunnel stayed up 30 s. A refusal a new ticket can't change (not found, the port, the carrier, no box, a revoked session) ends it at once.
  - **"Start the app?":** `CliDeps.ask` (readline on the process's streams; a TTY's Ctrl+C there ends the command as anywhere else). With no answer, nothing starts. After a yes, it asks for a ticket every 2 s until the box is up, for up to 10 minutes *(working value)*.
  - **Tests:** `apps/runner/src/cli/preview.test.ts`, against a fake of the web app's routes and core's tunnel (`testing/fake-preview-server.ts`) bridged to a small app here: `F-143/c2` (a request and a WebSocket at once, each a CONNECT; the subprotocol, no `Origin`, the ticket never printed; Ctrl+C ends with 1000 and the port closes), `F-143/c1` (the preview's own port, `127.0.0.1` only, as no other interface of this machine reaches it and the bound address in the log says; the next free port; `--local`; not found, signed out, revoked), `F-143/c3` (port 22 at the ticket, and the box's 403 mid-session), `F-143/c6` (the carrier's refusal at the ticket and at core's upgrade), `F-143/c4` (a spent ticket; 4401 ends with no new ticket), `F-143/c2` (4404, a network drop and 1001 each reconnected, then three refusals and it gives up; 4410 ends) and `F-143/c5` (yes starts and serves; no, or nobody to ask, starts nothing; every start refusal's words, `core-unreachable` among them). `apps/core/src/previews/cli-preview.test.ts` runs the real command against the web app's real route (`handleCliRequest` on a loopback port), core's real tunnel and the runner's real side on `host` with the fixture's Vite and API, the CLI reaching core through a relay the test can cut: `F-143/c2` (the page, `/api`, the API's echo at once, Vite's HMR with an edit, the printed `localhost` address, the next free port since Vite holds its own, Ctrl+C closing the view), `F-143/c2` (the box's connection dropped, then the member's network to core cut with a connection open: each reconnected on the same port, core still up), `F-143/c3` (22 and the API's port), `F-143/c4` (a session revoked mid-tunnel: 4401, no new ticket), `F-143/c2` (a view core closes: 4410) and `F-143/c6` (the runner on the HTTP carrier). `cli-http.preview.test.ts` checks the grant's label and `core-unreachable`.
  - **A finding for ticket 23's code:** `ws`'s `createWebSocketStream` under an HTTP/2 session asserts inside Node (`ERR_INTERNAL_ASSERTION`, an uncaught exception) when its own side terminates the WebSocket while the session is live: the stream's `_final` waits for a `finish` that never comes, and the session's next write trips `JSStreamSocket`. The fake hit it at once, and uses `webSocketDuplex` instead. Core's tunnel survived a cut network here (`cli-preview.test.ts`), since core destroys its sessions before it closes a socket. One path looks open: a CLI that never answers core's close frame, whose socket `ws` destroys after 30 s while the CLI's HTTP/2 session there still lives (`cli-tunnel.ts`'s `end` closes the socket only). Moving `webSocketDuplex` to a shared package for core would close it; not done here.
  - **Left open:** the browser tab by hand waits for the launch-gate demo; the `docker` forwarder's live run waits for the launch-gate Proof run (ticket 22). A reconnect keeps the first ticket's port, so a primary that changes meanwhile isn't followed.
