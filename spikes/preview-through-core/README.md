# Spike: `preview-through-core`

Throwaway code for milestone 8's ticket 08 (`context/specs/m8-previews-and-library/issues/08-spike-dev-server-through-core-http2.md`). Its finding is `context/research/spike-preview-through-core.md`. Product code never imports this folder: tickets 22, 23 and 25 copy what they need, with a provenance line.

## The question

Does Node's own `http2`, run over a `ws` WebSocket's duplex stream, carry a real Vite and a real Next.js 16 dev server, HMR included, from a member's browser through a relay shaped like core to a "sidecar", with the `Host` and `Origin` rewrite? Do the cookie and the hosts behave as ADR 0068 assumes?

## The shape

```
member's browser ──http(s)://5173-p1.preview.localhost:8800──▶ core (src/tunnel/core.ts)
                                                              preview hosts: cookie handshake (/.ostra/enter),
                                                              Host/Origin rewrite, Location back, framing headers
member's CLI ──ws /cli/v1/tunnel?ticket=… (HTTP/2, CLI is client)──▶ core: each CONNECT bridged to the box
   (src/tunnel/cli.ts: localhost:15173 → CONNECT localhost:5173)
                                                                  │ HTTP/2, core is the client
                                          ws /runner/v1/preview?view=v1 (dialled by the sidecar)
                                                                  │
sidecar (src/tunnel/sidecar.ts): http2.createServer({ enableConnectProtocol }) on the WebSocket's duplex
   request → HTTP/1.1 to the port; CONNECT + :protocol websocket → HTTP/1.1 upgrade; CONNECT → raw TCP
                                                                  │
the box's processes: the API (apps/api, :3001), Vite + React (apps/vite, :5173, server.proxy /api),
Next.js 16 (apps/next, :3002), webpack-dev-server 5 (apps/wds via src/servers/wds.ts, :8080)
```

- **Two previews:** `p1` rewrites `Host` and `Origin` to `localhost:<port>` (ADR 0068's default); `p2` has the rewrite off and sends `X-Forwarded-Host` and `X-Forwarded-Proto`.
- **Two preview domains:** `preview.localhost`, which browsers resolve by themselves, and `preview.example.test`, a stand-in for a real domain, mapped to loopback with Chromium's `--host-resolver-rules` and sent as a `Host` header by the Node clients. Every dev server here allows `*.localhost` on its own, so only the second shows what the rewrite is for.
- **The cookie:** `/.ostra/enter?code=…` takes a one-time code (60 s, one use, bound to the host) and sets `__Host-ostra-preview` (`Secure; HttpOnly`, and `SameSite=None; Partitioned` cross-site or `SameSite=Lax` same-site), then redirects. Core answers 401 without it.
- **The forwarder** (`src/tunnel/forwarder.ts`) is the `docker` init's logic on loopback aliases: it listens on 127.0.0.3, takes connections only from 127.0.0.2 (the sidecar binds its outgoing socket there) and dials the app at `localhost`.
- **`src/harness/run.ts`** starts everything and runs the checks: Node clients for exact headers, and Playwright (`playwright-core`) driving Chrome for Testing, Edge and Firefox.

## How to run it

```sh
cd spikes/preview-through-core
pnpm install
node node_modules/playwright-core/cli.js install firefox   # once: Playwright's Firefox
pnpm typecheck && pnpm lint
pnpm spike          # a few minutes; results/<run>/run.log and results.json
```

It needs `openssl` on the path for the self-signed certificate of the TLS listeners (`.certs/`, never committed), and ports 3001, 3002, 3410, 3443, 5173, 8080, 8443, 8800, 13002, 15173 and 18080. Every child ends with the run, and the edited message files are put back.

## What it can't do here

The `docker` forwarder in a real container on the box network (Linux with Docker), and Safari's partitioned cookie (a Mac). Both wait.
