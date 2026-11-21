# Research: Spike `preview-through-core`: does Node's own HTTP/2 over a WebSocket carry real dev servers through core?

**Status:** Research, 2026-11-21. Milestone 8's ticket 08. Feeds ADR 0068 ("The preview connection", "`ostra preview`", "The native preview", "If a spike fails"), F-143 and F-144, and tickets 22, 23 and 25.

**Method:**
- One run of `pnpm spike` in `spikes/preview-through-core/`, on 2026-11-21 from 02:43 UTC, with 65 checks: 60 passed and 5 failed. The 5 failures are findings, not faults of the tunnel (section 2). It wrote `run.log`, `results.json` and each process's log to `SPIKE/results/2026-11-21T02-43-25/` (below, `RUN` and `JSON`). A result is cited by the label of its line in `RUN`; `JSON` has every check with its details under `checks`. Earlier `--quick` runs and a debugging run were for development and aren't cited, except for one figure in section 4.1. `secure-cookie.log` in the same folder is a check run after it (section 3.5).
- **The machine:** Windows 11 Pro 10.0.26200, Intel Core i9-13900K, Node 24.14.0 (`RUN`, `machine`).
- **The servers:** Vite 8.3.8 with React; Next.js 16.4.6 with Turbopack (the version `apps/web` pins; the ticket's 16.2 is the minor that brought the cross-origin block); webpack 5.112.2 with webpack-dev-server 5.2.7; `ws` 8.23.0, as in `apps/runner` and `apps/core` (`RUN`, `machine`).
- **The browsers,** driven with `playwright-core` 1.65.1:
  - Chrome for Testing 159.0.8154.6: Playwright's `chromium` build, whose executable's product name is "Google Chrome for Testing". No Chrome is installed on this machine.
  - Microsoft Edge 157.0.4341.60, as installed.
  - Playwright's Firefox 159.0 (build 1572).
- **No Safari and no Docker here.** Both parts wait (section 5).
- RFC and Node quotes are from [RFC 8441](https://www.rfc-editor.org/rfc/rfc8441.txt) and Node 24's [`http2.md`](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/http2.md), read 2026-11-21. Dev-server behaviour is cited to the installed sources in `SPIKE/node_modules/` at the versions above.

**Source links.** `SPIKE` is `spikes/preview-through-core`. A cite such as `SPIKE/src/tunnel/core.ts:101-117` is a file and its lines.

---

## 1. The question, and the answer

**Question** (the ticket): does Node's own `http2`, run over a `ws` WebSocket's duplex stream, carry a real Vite and a real Next.js 16 dev server, HMR included, from a member's browser through a relay shaped like core to a "sidecar", with the `Host` and `Origin` rewrite? Do the cookie and the hosts behave as ADR 0068 assumes?

**Answer: yes. `yamux-js` isn't needed.** Ticket 22 needs no new dependency.
- **One WebSocket carried everything:**
  - plain requests;
  - every browser WebSocket as an RFC 8441 extended CONNECT;
  - `ostra preview`'s raw TCP as plain `CONNECT` streams.

  Core was the HTTP/2 client and the sidecar the server, from `http2.connect({ createConnection })` and `http2.createServer({ settings: { enableConnectProtocol: true } })` fed the duplex with `emit("connection")`. Vite's and Next.js's pages loaded through it, and an edit updated each by HMR without a reload, with the rewrite on and no project change, on a non-localhost HTTPS preview domain and on `preview.localhost`.
- **Three things to carry into the product.**
  1. Join a tunnel's two ends with `pipe` both ways and a graceful `end`, never `stream.pipeline` (section 4.1). The first version lost the end of a 2 MiB response and then the whole tunnel.
  2. Dial the app at `localhost`, trying IPv6 and IPv4, not at `127.0.0.1`. On this machine, Vite and webpack-dev-server listened on `::1` only (section 4.2).
  3. webpack-dev-server with its port set puts that port in its client, so its HMR socket bypasses the native preview's proxy. It needs `client.webSocketURL: "auto://0.0.0.0:0/ws"` (section 3.3). Its page loads through the tunnel either way.
- **The cookie.** `__Host-ostra-preview` with `Secure; HttpOnly; SameSite=None; Partitioned`, set by a one-time-code redirect inside a cross-site frame:
  - it held in the frame on Chrome for Testing, Edge and Firefox (the page, `/api` and the HMR socket all carried it);
  - on Chrome, Edge, and Firefox with release Firefox's Total Cookie Protection, the same host in a new tab had no cookie until its own handshake, as ADR 0068 expects.
- **`*.localhost`:** all three browsers resolved `5173-p1.preview.localhost` and `5173-p1.preview.ostra.localhost` to loopback with no setting, and kept a `Secure` cookie on `http://` there.
- **The cost:** a cold load of the Vite app took 105 ms through the tunnel against 75 ms direct, medians of 8 loads. That's 30 ms more for 14 requests and 3.6 MB on loopback.

---

## 2. Against the ticket's bar

| Bar (ticket 08, "Passes when") | Result | Evidence (`RUN`) |
|---|---|---|
| Vite's and Next.js 16's pages load through the tunnel, and HMR updates a page after an edit, with the rewrite on and no project change | **Passes.** Over HTTPS on `preview.example.test` (not under `.localhost`, so the dev servers' host checks apply), over HTTP on `preview.localhost`, and through the local forward. Each edit landed in 20 to 34 ms, with no reload | `vite via tunnel (https, rewrite on, preview.example.test)`, `next via tunnel (https, …)`, the `(http, …)` and `local forward` lines |
| With the rewrite off, `X-Forwarded-Host` reaches the app | **Passes.** It reached Vite, the API behind Vite's proxy, and a Next.js route handler | `rewrite off: X-Forwarded-Host and -Proto reach Vite…`, `…reaches the API behind Vite's proxy`, `…reaches a Next.js route handler` |
| A local forward carries a WebSocket and an HTTP request at once | **Passes.** Over one tunnel: 50 WebSocket echoes, in order; 20 `GET /api/hello`; and three 2 MiB responses, all complete, in 539 ms. Vite's HMR socket opened on the member's `localhost` | `local forward: a WebSocket and HTTP requests at once over one tunnel`, `local forward: Vite's HMR socket on the member's localhost` |
| The partitioned cookie holds in a cross-site frame on Chrome, Edge and Firefox | **Passes**, over HTTP and HTTPS. On Playwright's Firefox as shipped, the cookie holds but isn't partitioned, because Playwright turns partitioning off (section 3.5) | `chrome …`, `edge …`, `firefox …`, `firefox-tcp …` lines |
| The finding records the page load's added time, and what `*.localhost` does in each browser | Section 3.6 and section 3.5 | `page load`; the `resolved` field of each cookie line |

**The 5 failed checks** are three webpack-dev-server routes with its default client (section 3.3) and two Firefox lines with Playwright's own cookie settings (section 3.5). The same checks pass with `client.webSocketURL` set and with release Firefox's cookie setting.

---

## 3. The results

### 3.1 The tunnel

- **The connection.** The sidecar dials `ws://<core>/runner/v1/preview?view=v1&mode=tunnel` and hands the WebSocket's duplex to an HTTP/2 server with `enableConnectProtocol` (`SPIKE/src/tunnel/sidecar.ts:152`, `:177-185`). Core opens an HTTP/2 client session on its side of the same socket (`SPIKE/src/tunnel/core.ts:53-66`).
  - Node documents `createConnection` as returning "any `Duplex` stream that is to be used as the connection for this session".
  - The server's settings line up with RFC 8441: "Upon receipt of SETTINGS_ENABLE_CONNECT_PROTOCOL with a value of 1, a client MAY use the Extended CONNECT".

  Core stores the session only after the sidecar's settings arrive.
- **Plain requests** become HTTP/1.1 requests to the port, on a keep-alive agent (`SPIKE/src/tunnel/sidecar.ts:67-96`). HTTP/2 refuses connection-specific headers, so `connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, `te` and the like are dropped at each hop (`SPIKE/src/tunnel/headers.ts:8-17`).
- **Browser WebSockets.** Core answers the browser's upgrade itself: it checks the cookie and that `Origin` is the preview's own origin, opens `CONNECT` with `:protocol: websocket`, and on `200` writes the `101` with its own `Sec-WebSocket-Accept` (`SPIKE/src/tunnel/core.ts:214-266`). That follows RFC 8441: extended CONNECT "do[es] not do the processing of the Sec-WebSocket-Key and Sec-WebSocket-Accept header fields", while `Origin`, `Sec-WebSocket-Protocol` and `Sec-WebSocket-Extensions` travel in the CONNECT request and response. The sidecar makes a fresh HTTP/1.1 upgrade to the port, then the frames pass as bytes (`SPIKE/src/tunnel/sidecar.ts:98-127`).
- **`ostra preview`'s forward.**
  - The CLI is an HTTP/2 client on `ws://<core>/cli/v1/tunnel?ticket=…` (`SPIKE/src/tunnel/cli.ts:32`, `:42-56`).
  - Core is an HTTP/2 server for it, and bridges each of its `CONNECT` streams to a `CONNECT` on the box's session for the ticket's port only (`SPIKE/src/tunnel/core.ts:270-313`).
  - The sidecar dials the port (`SPIKE/src/tunnel/sidecar.ts:129-150`).
- **What crossed it in the run:**
  - 732 preview requests;
  - 63 browser WebSockets;
  - 104 CLI streams;
  - 139 MB to browsers.

  None of it broke the session (`JSON`, `enterRequests`: `previewRequests`, `previewUpgrades`, `cliStreams`, `bytesToBrowser`).

### 3.2 The rewrite, the host checks and the headers

Preview `p1` rewrites `Host` to `localhost:<port>` (as `:authority`), and `Origin` when it's the preview's own origin. Preview `p2` keeps the preview host and adds `X-Forwarded-Host` and `X-Forwarded-Proto` (`SPIKE/src/tunnel/core.ts:101-117`).

| Check | Result |
|---|---|
| Vite, rewrite on, Host `5173-p1.preview.example.test` | 200, the page |
| Vite, rewrite off, the same domain | 403, "Blocked request. This host ("5173-p2.preview.example.test") is not allowed." |
| Vite, rewrite off, on `*.preview.localhost` | 200: Vite allows names under `.localhost` by itself |
| webpack-dev-server, rewrite on / off | 200 / 403 "Invalid Host header" |
| Next.js, rewrite on | 200. Next.js doesn't check `Host` on pages |
| What Vite saw with the rewrite on | `host: localhost:5173`, no `X-Forwarded-Host` |
| …with the rewrite off | `host` and `x-forwarded-host` both `5173-p2.preview.localhost:8800`, `x-forwarded-proto: http` |
| A client's own `X-Forwarded-Host: evil.example` | never reached the app |
| Core's cookie | never reached the app |
| A `Location: http://localhost:5173/` | came back as `http://5173-p1.preview.example.test:8800/` |
| A page with `X-Frame-Options: DENY` and `frame-ancestors 'none'` | `X-Frame-Options` removed; CSP `frame-ancestors` replaced by the panel's origins |
| A page on an origin not in that list (`127.0.0.1:3410`) framing the preview | the frame showed Chrome's error page, not the app |

Source: `RUN`, section A, and `framing: an origin outside frame-ancestors (127.0.0.1) gets no app in its frame`.

**Every dev server here allows `*.localhost` on its own:**
- Vite;
- webpack-dev-server: `hostname.endsWith(".localhost")`, `SPIKE/node_modules/webpack-dev-server/lib/Server.js:3399`;
- Next.js: `'**.localhost'` in its default allowed origins, `SPIKE/node_modules/next/dist/server/lib/router-utils/block-cross-site-dev.js:77`.

So on a development install with `preview.localhost` the rewrite isn't what makes it work. On a real preview domain it is.

### 3.3 HMR, each server, each route

An edit writes a new text to the module the page shows, and the check waits for it with no reload (`SPIKE/src/harness/run.ts`, `hmr`). It also checks that each HMR socket went to the page's own host. One that dials the dev server's own port only works here because the "box" is this machine.

| Server | Direct | Tunnel, HTTPS, `preview.example.test` | Tunnel, HTTP, `preview.localhost` | Local forward |
|---|---|---|---|---|
| Vite (with `/api` through its proxy) | 121 ms | 34 ms | 32 ms | 32 ms |
| Next.js 16.4.6 | 127 ms | 22 ms | 20 ms | 21 ms |
| webpack-dev-server 5.2.7, as configured with `port` and `host` | 54 ms | **fails**: no update in 30 s | **fails** | updated in 59 ms, but its socket went to `localhost:8080`, past the forward |
| The same, with `client.webSocketURL: "auto://0.0.0.0:0/ws"` | 41 ms | 50 ms | 43 ms | 42 ms |

Source: `RUN`, section B; `JSON`, `hmr`. The first edit of each server includes its watcher's start, so the direct column isn't a fair comparison with the others.

**Why webpack-dev-server fails as configured.** Given a `host` or a `port`, it bakes them into its client's socket URL (`SPIKE/node_modules/webpack-dev-server/lib/Server.js:704-735`). So the page opened `ws://localhost:8080/ws` from a page on another origin. Its own check then refused the socket, "Invalid Host/Origin header", because the `Origin` and `Host` hosts differ (`RUN`, the failing lines' `console`).
- With `client.webSocketURL: "auto://0.0.0.0:0/ws"`, which research §5.2 names, the client uses the page's own host and port, and every route works.
- Through `ostra preview`, the same thing works without the setting when the local port is the box's port, which is ADR 0068's default ("the same local port when that's free"). The run couldn't show it, because the box and the member are one machine here.

**Vite and Next.js need nothing:**
- Vite's client takes the page's host (`importMetaUrl.hostname`, `SPIKE/node_modules/vite/dist/client/client.mjs:939`) and its token from the served client (`:943`).
- Next.js's takes the page's origin.

### 3.4 The WebSocket checks

| Check | Result |
|---|---|
| Vite's HMR socket through the tunnel, with the token from `/@vite/client` | opened |
| …without the token | refused by Vite, HTTP 400 |
| A WebSocket behind Vite's proxy (`ws: true`) through the tunnel | opened |
| Next.js's `/_next/hmr` through the tunnel, rewrite on | opened |
| …rewrite off, `Origin` on the non-localhost preview domain | refused (Next.js logged "Blocked cross-origin request to Next.js dev resource /_next/hmr from "3002-p2.preview.example.test"", `SPIKE/results/2026-11-21T02-43-25/next.log`) |
| Next.js direct, `Origin: null` on `/_next/hmr` | refused: Next.js writes "Unauthorized" to the raw socket, so the client sees no HTTP answer, only a parse error |
| Next.js direct, `Origin: localhost` / `*.localhost` | both opened |
| Next.js direct, a dev asset with `Origin: null`, or a `no-cors` load from another site | 403 and 403 (a plain request: 200) |
| Core, a WebSocket whose `Origin` isn't the preview's | 403 |
| Core, `Origin: null` | 403 |
| webpack-dev-server's `/ws` through the tunnel, from a Node client with the preview's origin | opened |

Source: `RUN`, section A, "WebSockets". So the `Origin: null` case is closed twice:
- Next.js refuses an opaque origin's dev assets and HMR (`block-cross-site-dev.js:58`, `:102`);
- core refuses `Origin: null` on any upgrade.

That's why ADR 0068's frame keeps `allow-same-origin`.

### 3.5 The cookie, and `*.localhost`

The panel's page frames `/.ostra/enter?code=…` with ADR 0068's `sandbox` (`SPIKE/src/harness/run.ts`, `panelPage`). Core takes the code once, sets the cookie and redirects (`SPIKE/src/tunnel/core.ts:148-172`).
- **Cross-site:** the panel on `localhost`, the preview on `5173-p1.preview.localhost`.
- **Same-site:** the panel on `ostra.localhost`, the preview on `5173-p1.preview.ostra.localhost`.

Each browser's own `Sec-Fetch-Site` on the framed handshake confirms the layouts: `cross-site` 9 times and `same-site` 8 times, across the browsers (`JSON`, `enterRequests.enterLog`).

| Browser | Layout | In the frame: page, `/api`, HMR | Stored cookie | A new tab before its own handshake | After it |
|---|---|---|---|---|---|
| Chrome for Testing 159 | cross-site, HTTP and HTTPS | app, yes, yes | `SameSite=None`, partition key `http://localhost` / `https://localhost` | no cookie | app |
| | same-site | app, yes, yes | `Lax`, not partitioned | app (one cookie, as expected) | app |
| Edge 157 | cross-site, HTTP and HTTPS | app, yes, yes | `None`, partition key `http(s)://localhost` | no cookie | app |
| | same-site | app, yes, yes | `Lax` | app | app |
| Firefox 159, Playwright's settings | cross-site, HTTP and HTTPS | app, yes, yes | `None`, no partition key | **app**: shared with the top level | app |
| | same-site | app, yes, yes | `Lax` | app | app |
| Firefox 159, `network.cookie.cookieBehavior` 5 | cross-site, HTTP and HTTPS | app, yes, yes | `None` | no cookie | app |
| | same-site | app, yes, yes | `Lax` | app | app |

Source: `RUN`, section E, F.

**About Firefox.** Playwright's Firefox ships with "Disable first-party-based cookie partitioning", setting `network.cookie.cookieBehavior` to 4, and `defaultPref("network.cookie.CHIPS.enabled", false)` (`playwright.cfg` in Playwright's `firefox-1572` folder, lines 47-54). Release Firefox uses Total Cookie Protection, which confines embedded content's cookies to the top site's jar ([Mozilla](https://blog.mozilla.org/en/mozilla/firefox-rolls-out-total-cookie-protection-by-default-to-all-users-worldwide)). With `cookieBehavior` 5 restored, the frame's cookie stayed in the panel's partition, as on Chrome and Edge. Two consequences:
- **This run is not release Firefox.** A check against release Firefox itself would settle it, by hand.
- **Ticket 25's and 26's Playwright tests on Firefox must set `cookieBehavior` 5**, or they test a browser no member runs.

**`*.localhost`:**
- Every browser loaded `*.preview.localhost` and `*.preview.ostra.localhost` with no host rules and no setting. Core listened on `127.0.0.1` only. That answers research §3.5's "unconfirmed".
- Each kept a `Secure` cookie set on `http://` there, so a development install can use `preview.localhost` over HTTP.
- On a non-localhost domain over HTTP, all three dropped the `__Host-` cookie: `http://5173-p1.preview.example.test` stored none and answered "no preview cookie", while `http://5173-p1.preview.localhost` stored it. `SPIKE/src/harness/secure-cookie.ts` checked this after the run, on the same browsers (`SPIKE/results/2026-11-21T02-43-25/secure-cookie.log`). So a real preview domain needs HTTPS, as ADR 0068's wildcard certificate already gives it.

### 3.6 The cost of a page load

A new browser context for each load, so nothing was cached. Chrome for Testing loaded the Vite app, and the time ran to the `load` event and to the app's `/api` answer on the page. There were nine rounds, and the first was dropped as a warm-up (`SPIKE/src/harness/run.ts`, section G).

| Route | `load`, median of 8 | App ready, median | Requests | Transferred |
|---|---|---|---|---|
| Direct, `localhost:5173` | 75 ms (68 to 83) | 95 ms | 14 | 3,627 KB |
| Through core (preview host, HTTP) | 105 ms (94 to 117) | 128 ms | 14 | 3,629 KB |
| Through `ostra preview`'s forward | 108 ms (96 to 119) | 127 ms | 14 | 3,627 KB |

Source: `RUN`, `page load`; `JSON`, `pageLoad`.
- **The tunnel added about 30 ms,** 40%, to a cold load on loopback, with two hops and HTTP/2 framing on a WebSocket.
- **It wasn't measured over a real network.** There, each request also pays the round trip to core. A Vite app that loads its modules as a waterfall of imports pays it once a level.
- **HTTP/2's windows were left at Node's defaults.** They carried 2 MiB responses without trouble here.

---

## 4. What the spike had to fix, which the product must not repeat

### 4.1 Never `pipeline` a tunnel's two ends

The first version joined each tunnel's ends with `stream.pipeline` both ways.
- A 2 MiB response through the local forward lost its last 33 KB, and undici reported "Response body length does not match content-length header".
- The tunnel then closed with 1006 on both the CLI's and the sidecar's WebSockets.
- A trace showed the sidecar had read all 2,097,306 bytes from the app, while core received 2,064,353 before both streams ended with `RST_STREAM` code 2 (INTERNAL_ERROR). That was a debugging run of the forward alone, whose logs weren't kept.

When the app's socket closed after the response, `pipeline` destroyed the HTTP/2 stream instead of ending it, dropping what was still queued. `SPIKE/src/tunnel/headers.ts:35-50` (`splice`) pipes both ways and ends the other side gracefully on `close`, and tears both down only on an error. With it, every transfer in the run completed, and every stream ended with code 0. **Tickets 22 and 23 take `splice`, not `pipeline`, for every raw stream:** the CONNECT bridges, the WebSocket bridges and the forwarder.

### 4.2 Dial `localhost`, both families

On this machine (`RUN`, `machine.devServerBindings`):
- Vite and webpack-dev-server, both given `localhost`, listened on `::1` only;
- Next.js listened on `::` (both families);
- the API listened on `127.0.0.1`.

A sidecar that dialled `127.0.0.1:<port>` would have reached neither Vite nor webpack-dev-server. The spike dials `localhost` with Node's `autoSelectFamily`, which tries both (`SPIKE/src/tunnel/sidecar.ts:34-38`; the forwarder, `SPIKE/src/tunnel/forwarder.ts:36`). The same can happen in a Linux box, depending on how its resolver orders `localhost` *(inference: not run here)*. ADR 0068 said "dial `127.0.0.1:<port>`", and is amended to say `localhost`, IPv6 and IPv4.

---

## 5. What isn't run, and waits

- **The `docker` forwarder in a container** on the box network (Linux with Docker; the `live-docker` job). Its logic ran on loopback aliases:
  - it listened on `127.0.0.3`, took the sidecar's connections from `127.0.0.2`, and carried the page and Vite's HMR socket;
  - it refused a connection from `127.0.0.4` (`RUN`, section D; `SPIKE/results/2026-11-21T02-43-25/forwarder.log`, "refused 127.0.0.4 on 5173").

  The container networking itself is **waiting**.
- **Safari's partitioned cookie** in the frame (a Mac): **waiting**.
- **Release Firefox,** as against Playwright's Firefox with `cookieBehavior` 5: not run.
- **A real network** between the member, core and the box: not run (section 3.6).

---

## 6. What tickets 22, 23 and 25 take

**Ticket 22 (the runner's tunnel and the `docker` forwarder):**
- the sidecar's HTTP/2 server on the preview connection's duplex (`SPIKE/src/tunnel/sidecar.ts`): plain requests to the port, extended CONNECT to an HTTP/1.1 upgrade, plain CONNECT to a raw socket;
- the port check (the task's ports only, none below 1024);
- dialling `localhost` with both families;
- `splice`;
- the forwarder's address check (`SPIKE/src/tunnel/forwarder.ts`).

No new dependency: Node's `http2` and the `ws` already in the runner.

**Ticket 23 (tunnels through core, and `ostra preview`'s endpoint):**
- core's HTTP/2 client session per preview connection, stored once the sidecar's settings arrive;
- the CLI tunnel as an HTTP/2 server on the CLI's WebSocket, bridging each `CONNECT` for the ticket's port to the box's session with `splice` (`SPIKE/src/tunnel/core.ts:270-313`);
- the single-use ticket.

**Ticket 25 (the preview domain):**
- the host parser;
- the handshake (a single-use code bound to the host; `__Host-ostra-preview` with `Secure; HttpOnly`, plus `SameSite=None; Partitioned` cross-site or `SameSite=Lax` same-site; a redirect to a same-origin path);
- the request and response rewrites (`SPIKE/src/tunnel/core.ts:101-139`);
- answering a browser's upgrade with extended CONNECT and its own `Sec-WebSocket-Accept`, after the cookie and `Origin` checks (`:214-266`).

Its Playwright tests on Firefox set `network.cookie.cookieBehavior` to 5 (section 3.5). The docs say a real preview domain is HTTPS, and that webpack-dev-server needs `client.webSocketURL: "auto://0.0.0.0:0/ws"` for HMR in the native preview (section 3.3).

---

## 7. What this means for ostra

- ADR 0068's preview connection works as designed with what the runner and core already carry. `yamux-js`, the named fallback, isn't needed, so nothing goes to the maintainer.
- The `Host` and `Origin` rewrite is what lets Vite, Next.js and webpack-dev-server serve a real preview domain with no project change. On `preview.localhost` it isn't even needed.
- One server needs a line of config for HMR in the native preview: webpack-dev-server, when the project sets its port. Its page works without it.
- The partitioned cookie behaves as ADR 0068 assumes on Chrome and Edge, and on Firefox with its real cookie setting. Safari waits for a Mac.
