# 08: Spike: a dev server through core over HTTP/2

Status: resolved
Builder: runner
Blocked by: none
Features: F-143, F-144 (the transport they rest on)
Packages: `spikes/preview-through-core/` (new, throwaway), `context/research/spike-preview-through-core.md` (new)
Spec: `../spec.md`, section 11; ADR 0068 ("The preview connection", "The native preview", "If a spike fails"); `research/live-previews.md` §2.1, §5 and §7, recommendation 7

## The question

Does Node's own `http2`, run over a `ws` WebSocket's duplex stream, carry a real Vite and a real Next.js 16 dev server, HMR included, from a member's browser through a relay shaped like core to a "sidecar", with the `Host` and `Origin` rewrite? Do the cookie and the hosts behave as ADR 0068 assumes?

## What to try

Throwaway code, in `spikes/preview-through-core/`:
1. **The tunnel.** A "core" that is the HTTP/2 client, and a "sidecar" that is the HTTP/2 server, over one WebSocket, with `enableConnectProtocol` on. Plain requests, RFC 8441 extended CONNECT for the browser's WebSockets, and plain `CONNECT` streams of raw TCP for an `ostra preview`-like local forward.
2. **The rewrite.** `Host` and `Origin` set to `localhost:<port>` and `Location` rewritten back; then the same with the rewrite off and `X-Forwarded-Host` set.
3. **The dev servers:** Vite 6 or later (its `allowedHosts` check and its HMR token), Next.js 16.2 (`allowedDevOrigins`, and the `Origin: null` case), and webpack-dev-server 5, each with HMR edited live.
4. **The `docker` forwarder** (on Linux with Docker): a listener in the "agent's" container on its box-network address, accepting only the "sidecar's" address, dialing `127.0.0.1:<port>`.
5. **The cookie.** A `__Host-` cookie set by a one-time-code redirect on a preview host, `SameSite=None; Partitioned` in a cross-site iframe, on Chrome, Edge and Firefox here, and on Safari on a Mac if one is at hand. Then the same host top-level in a new tab.
6. **`*.localhost`:** whether Chrome, Edge and Firefox resolve `5173-x.preview.localhost` to loopback, and whether a `Secure` cookie is kept on `http://` there.
7. **The cost:** a cold page load of the Vite app through the tunnel against direct, measured, with the number of requests.

## Passes when

- Vite's and Next.js 16's pages load through the tunnel and their HMR updates a page after an edit, with the rewrite on and no project change.
- With the rewrite off, `X-Forwarded-Host` reaches the app.
- A local forward carries a WebSocket and an HTTP request at once.
- The partitioned cookie holds in a cross-site frame on Chrome, Edge and Firefox.
- The finding records the page load's added time, and what `*.localhost` does in each browser.

**If it fails:** ADR 0068's fallback, as written there: `yamux-js` in place of `http2`, which needs the maintainer's yes with its ADR 0007 line drafted (ticket 34), or "Open in a new tab" in place of the frame on a browser whose cookie doesn't hold.

## Done when

- [x] `context/research/spike-preview-through-core.md` holds every result, cited to its run's log in the spike's folder. Safari and the `docker` forwarder are marked as waiting when they haven't run, never as passed.
- [x] Spec section 11's port line names what tickets 22, 23 and 25 take from the spike.
- [x] Committed as `✨ spike a dev server through core`, and the finding as `📝 add the preview tunnel spike's finding`.

## Comments

- 2026-11-21, runner: the spike is commit `44c4d31e`. The finding, the HTTP-cookie check `src/harness/secure-cookie.ts` with its log, ADR 0068's amendment and ticket 22's two lines are this commit. It passes (`research/spike-preview-through-core.md`, section 2):
  - Node's `http2` over the `ws` duplex carried Vite's and Next.js 16's pages and HMR through core, with the rewrite on and no project change, on an HTTPS non-localhost domain and on `preview.localhost`;
  - `X-Forwarded-Host` reached the app with the rewrite off;
  - one local forward carried a WebSocket and HTTP at once;
  - the partitioned cookie held in a cross-site frame on Chrome for Testing 159, Edge 157 and Firefox 159;
  - a cold page load took 105 ms against 75 ms direct.

  `yamux-js` isn't needed, so ticket 22 adds no dependency. Three findings change the build:
  - dial the app at `localhost` with IPv6 and IPv4, since Vite and webpack-dev-server listened on `::1` only (ADR 0068 and spec sections 5.2 and 6 amended, and ticket 22; ticket 03's forward still says `127.0.0.1`, left for its builder);
  - join raw streams with `splice`, never `stream.pipeline`, which lost a response's tail;
  - webpack-dev-server's HMR needs `client.webSocketURL: "auto://0.0.0.0:0/ws"` in the native preview when a project sets its port.

  Of the run's 65 checks, 5 failed, and all 5 are these findings: webpack-dev-server's default client, and Playwright's Firefox, which turns cookie partitioning off. Waiting: the `docker` forwarder in a container (its logic ran on loopback aliases), and Safari. The lead asked for one commit per spike; this follows the ticket's two.
