# Research: the runner ↔ server transport

**Status:** Research, 2026-11-18. One of the Tier 1 studies (Q22 in `open-questions.md`). Feeds spike 5 (the runner), ADR 0011 (reliability), ADR 0012 (server and runners), ADR 0016 (core service), ADR 0017 (Postgres only), ADR 0022 (versions), F-013, F-045, F-061 and the Q18 scale target.
**Method:** Official docs, specs and source code, read on 2026-11-18. Repo and package facts come from the npm registry, GitHub release pages and the GitHub REST API on the same day. Claims I couldn't confirm against a primary source are marked **unverified**. Numbers marked *(working value)* are my proposals, to be tuned in spike 5.
**Related:** `research/platform-auth-github.md` §1.7 (runner identity), `research/landscape.md` (Claude Code self-hosted environments, Multica, Omnara). Fan-out of agent events to browsers is `research/live-sync.md`'s topic, not this one.

**Versions checked (2026-11-18)**

| Thing | Version, date | License | Signal | Source |
|---|---|---|---|---|
| `ws` | 8.23.0, 2026-11-12 | MIT | ~415M npm downloads/week, no runtime dependencies, @@websockets/ws@@ stars | https://www.npmjs.com/package/ws |
| `@types/ws` | 8.18.2 | MIT | | npm |
| uWebSockets.js | v20.71.0 | Apache-2.0 | not on npm, @@uNetworking/uWebSockets.js@@ stars | https://github.com/uNetworking/uWebSockets.js |
| `partysocket` | 1.3.0, 2026-06-23 | MIT | ~5.0M/week, bundled types | https://www.npmjs.com/package/partysocket |
| `socket.io` / `socket.io-client` | 4.8.4, 2026-09-25 | MIT | ~25.3M/week, @@socketio/socket.io@@ stars | https://www.npmjs.com/package/socket.io |
| `@socket.io/postgres-adapter` | 0.5.0, 2025-11-05 | MIT | ~123k/week | npm |
| `@connectrpc/connect`, `-node` | 2.3.0, 2026-10-27 | Apache-2.0 | ~9.4M/week, @@connectrpc/connect-es@@ stars | https://www.npmjs.com/package/@connectrpc/connect |
| nats-server / `@nats-io/transport-node` | v2.15.3 / 3.5.0, 2026-11-16 | Apache-2.0 | ~1.1M/week (client), @@nats-io/nats-server@@ stars | https://github.com/nats-io/nats-server |
| Centrifugo / `centrifuge` (JS client) | v6.10.3 / 5.8.0, 2026-10-20 | Apache-2.0 / MIT | ~2.2M/week (client), @@centrifugal/centrifugo@@ stars | https://github.com/centrifugal/centrifugo |
| Rivet engine / `rivetkit` | v2.3.32 (GitHub latest) / 3.1.1 (npm `latest`, 2026-11-11) | Apache-2.0 | ~236k/week, @@rivet-dev/rivet@@ stars | https://github.com/rivet-dev/rivet |
| `@fails-components/webtransport` | 1.6.12, 2026-11-14 | BSD-3-Clause | native addon | npm |
| `pg` | 8.23.1 | MIT | `@prisma/adapter-pg` 7.10.1 depends on it | npm |
| Node.js docs | v26.13.1 | | | https://nodejs.org/api/ |
| actions/runner | v2.338.2 | MIT | @@actions/runner@@ stars | https://github.com/actions/runner |
| buildkite/agent | v4.11.0 | MIT | @@buildkite/agent@@ stars | https://github.com/buildkite/agent |
| Multica | v0.10.0 | "Multica License" (not OSI) | @@multica-ai/multica@@ stars | https://github.com/multica-ai/multica |
| Omnara / omnarad | cluster-v0.2.25 / omnarad v0.2.25, 2026-11-18 | Apache-2.0 | @@omnara-ai/omnara@@ stars | https://github.com/omnara-ai/omnara |
| Tailscale | v1.104.7 | BSD-3-Clause | @@tailscale/tailscale@@ stars | https://github.com/tailscale/tailscale |
| cloudflared | 2026.11.1 | Apache-2.0 | @@cloudflare/cloudflared@@ stars | https://github.com/cloudflare/cloudflared |

---

## Summary

**Recommendation: a small protocol of ostra's own, on a plain WebSocket (`ws`), with Postgres doing the routing.** No broker, no Redis, no messaging framework.

- **One session, two carriers.**
  - The runner protocol is a session of numbered, acknowledged messages, defined once as Zod schemas in a shared package (ADR 0008).
  - The main carrier is one WebSocket per runner on port 443.
  - The fallback carrier is plain HTTP: POSTs from runner to server, and a 25-second long poll from server to runner. Both carriers move the same envelopes, so the reliability logic is written once.
- **Runner → server (agent events):**
  - The runner numbers every event per session and keeps it in a disk spool until the server acks it.
  - The server writes each batch in one transaction, idempotent on `(session_id, seq)`, and acks only after the commit. That is ADR 0011's "saved before ostra acts on it".
  - After any drop, the runner resends from its first unacked event.
- **Server → runner (dispatch, steer, interrupt, approvals):**
  - Every command is a row in a Postgres outbox table, numbered per runner, written in the same transaction as the change that caused it. The panel (Next.js) sends commands this way too, so it never talks to the core service directly (ADR 0016).
  - The replica holding the runner's socket delivers the command. The runner applies it idempotently and acks it, and on reconnect it says which command it applied last.
- **Cross-replica routing without Redis:**
  - A presence table records which replica holds runner X.
  - A `NOTIFY` wakes that replica, and a sweep every 2 s catches anything a notification missed.
  - `NOTIFY` carries only commands and evictions (tens per second), never agent events. That keeps it well clear of the commit lock that limits `NOTIFY` throughput (Recall.ai, DBOS).
  - It needs no sticky sessions and no traffic between replicas.
- **Leases, two timers:**
  - A fast liveness timer: the panel shows a runner offline after about 45 s.
  - A slow task lease: 10 minutes, then the task stops cleanly (F-045).
  - Every dispatch carries a lease epoch, so a runner that comes back after its tasks were stopped can't save anything or get a push token (fencing, as Omnara does).
- **Auth:**
  - A device-code login (better-auth, RFC 8628) or a one-time registration token.
  - An Ed25519 key on the runner, and 10-minute access tokens on the connection.
  - This is what `research/platform-auth-github.md` §1.7 already recommends. GitHub Actions does the same with an RSA key.
- **Versioning:**
  - `hello` and `welcome` messages negotiate a version.
  - Both sides keep codecs for the current and the previous minor, and each side encodes down to the negotiated one. This is needed because ostra's own schemas reject unknown fields (AGENTS.md). Omnara's server does exactly this per daemon version.

**The comparable systems all converge on one pattern:**
- outbound HTTPS on 443
- a lease that normal traffic renews
- a polling path that always works, with a faster push path when the network allows

GitHub Actions and Claude Code self-hosted environments poll for work. Buildkite and Multica push and keep polling underneath. Omnara pushes over a WebSocket and keeps its state in Postgres.

**Rejected:**
- **Socket.IO:** at-most-once by default, and its recovery lasts about 2 minutes, in memory. Its Postgres adapter doesn't support recovery at all.
- **Connect-RPC bidirectional streaming:** needs HTTP/2 end to end, and its types come from protobuf, not Zod.
- **NATS, Centrifugo, Rivet:** each adds a service, and a second store, to a Postgres-only install (ADR 0017).
- **WebTransport:** Node can't do it yet, and UDP is the first thing corporate networks block.
- **uWebSockets.js:** not needed at this scale, and it isn't on npm.
- **partysocket:** at most optional. Its unbounded in-memory buffer would compete with the spool.

**Biggest risks:**
1. **A runner newer than its server.**
   - `npx ostra-runner` fetches the newest runner, while each team upgrades its server on its own schedule (ADR 0001).
   - So the normal case is a runner *ahead* of the server, which ADR 0022 doesn't cover. It only allows runners one minor behind.
   - Rivet shipped exactly this failure ([rivet#5484](https://github.com/rivet-dev/rivet/issues/5484)).
   - Fix: the runner speaks one minor older as well, or pins itself to the server's version at login.
2. **Corporate proxies.**
   - The least predictable parts are WebSocket upgrades through TLS-inspecting proxies, proxy authentication, custom CAs, and Bun's proxy behaviour.
   - Tailscale and Cloudflare both had to add fallbacks and manual overrides.
   - Spike 5 must test against a real intercepting proxy.
3. **Event volume into Postgres at 1,000 tasks.**
   - It depends on how chatty ACP is (spike 1).
   - It also depends on whether streaming text deltas count as agent events that ADR 0011 must save.

---

## Comparison

### Table 1: candidate transports and libraries

| Candidate | License | Delivery guarantees | Reconnect and resume | Cross-replica routing without Redis | Corporate proxies | TypeScript types | Self-hosting weight | Maturity |
|---|---|---|---|---|---|---|---|---|
| **`ws`** | MIT | TCP order within one connection; nothing across reconnects | None built in | n/a (a connection library) | Good: one upgrade on 443; proxying needs an `http.Agent` | `@types/ws` | A library, no dependencies | Very high |
| **uWebSockets.js** | Apache-2.0 | Same as `ws` | None | n/a | Same as `ws` (server only) | Bundled (**unverified**) | Native binary per platform and Node ABI, installed from GitHub | High; Bun's server is built on uWebSockets |
| **partysocket** | MIT | None; holds unsent messages in memory | Reconnects with backoff; no replay | n/a | Client only, as `ws` | Bundled | A library | Wide use (~5M/week) |
| **Socket.IO** | MIT | At-most-once by default; at-least-once client → server with `retries`; ordered | "Connection state recovery", 2 min in the example, kept by the adapter; not with the Postgres adapter | Postgres adapter (LISTEN/NOTIFY) for broadcasts; sticky sessions unless WebSocket-only | Long-polling fallback built in, but it needs sticky sessions | Generic event maps, not Zod | A library plus an adapter | Very high |
| **SSE + HTTP POST** | Web standards | Ours; `id` + `Last-Event-ID` as the cursor | EventSource reconnects with `Last-Event-ID`; replay is ours | Same Postgres routing as below | Good, except proxies that buffer `text/event-stream` | Ours; Node's `EventSource` is still experimental | None | Standard; MCP's Streamable HTTP is built this way |
| **Connect-RPC (HTTP/2, gRPC)** | Apache-2.0 | Ours; a stream dies with its connection | None | n/a | Bidirectional streaming needs HTTP/2 end to end; server streams plus unary calls work on HTTP/1.1 | Generated from protobuf, not Zod | A library plus a protobuf toolchain | High |
| **NATS / JetStream** | Apache-2.0 | Core: at-most-once. JetStream: at-least-once, exactly-once with `Nats-Msg-Id` | Durable consumers resume from the last ack | Solves it, as another server | WebSocket listener on 443 possible | nats.js v3, TypeScript, no Zod | One more stateful service with its own storage | Very high (CNCF) |
| **Centrifugo** | Apache-2.0 (server), MIT (JS client) | At-most-once live; recovery from stream history (offset + epoch) | Automatic within the history window | PostgreSQL broker, **experimental**, polls every 100 ms (optionally LISTEN/NOTIFY), "low thousands" of publishes/s | WebSocket and HTTP-based transports | JS client in TS; client → server goes through an RPC proxy to our backend | One more Go service | High (v6); its Postgres broker is new |
| **Rivet Actors** | Apache-2.0 | Durable actor state | The engine routes clients to actors | The engine routes; multi-node on Postgres is "experimental", the Kubernetes recipe also runs NATS | WebSocket; asks for 1-hour load-balancer timeouts | RivetKit in TS | A Rust engine (plus NATS) | Fast-moving (2.x → 3.x in 2026), protocol-version incidents |
| **WebTransport** | W3C / IETF | Streams and datagrams; ours | None | n/a | Poor: QUIC is UDP, commonly blocked | No native Node support | A native addon | Immature on Node |
| **Postgres LISTEN/NOTIFY** | PostgreSQL License | At-most-once, only to connected listeners; delivered at commit; 8,000-byte payloads | Notifications sent while a listener is down are lost | Yes, as a wake-up signal | n/a (server side) | `pg` | None (inside Postgres) | Very high; NOTIFY's commit lock limits its rate |
| **Postgres outbox (queue) table** | n/a | Durable; at-least-once with acks | A cursor per runner | Yes: any replica reads it | n/a | Prisma or `pg` | None | The pattern behind Omnara's design and Centrifugo's Postgres broker |

### Table 2: how comparable systems do it

| System | Carrier | Liveness and lease | Resume and acks | Many server nodes | Proxies | Machine auth | Lesson for ostra |
|---|---|---|---|---|---|---|---|
| **Claude Code self-hosted environments** | HTTPS polling (10 s per poll); SSE for each session's stream | Each poll renews the lease; it lapses after ~60 s | Anthropic keeps the transcript; released sessions resume on another runner | n/a (Anthropic's side) | `HTTPS_PROXY`, `NO_PROXY`, mTLS, rotating proxy-auth hooks; "must not buffer" | Environment secret → runner token; per-session OAuth token | Renew the lease with traffic that happens anyway; a proxy's HTML page is a network error |
| **GitHub Actions runner** | HTTPS long poll, 50 s | Job renewed every 60 s, locked ~10 min, retried until the lock + 5 min | `lastMessageId` cursor; the server can move a runner to another broker | Broker migration message | 443 only; `https_proxy`, `no_proxy` | RSA key, signed JWT → OAuth token | F-045's 10 minutes equals GitHub's job lock; server-directed moves; signed assertions on the wire |
| **Buildkite agent** | HTTP polling, plus an optional Connect server stream; `auto` runs both | Heartbeats; "lost" after 3 minutes without one | Log chunks carry sequence, offset and size | n/a | `poll-only` switch | Agent token | Push is an optimization over a polling baseline; give operators a switch |
| **Multica daemon** | WebSocket as a doorbell, plus HTTP claims; polls every 30 s, and every 3 min even when the socket is healthy | Heartbeat 15 s; offline within ~3 min; 3-hour reconnect grace | A restarted daemon reclaims its runs | Redis for realtime fan-out and "channel leases"; one feature is still single-replica | Autostart doesn't inherit `HTTPS_PROXY` | Task tokens ≤ 24 h | The doorbell-plus-poll shape; the exact cross-replica gap ostra has to close without Redis |
| **Omnara `omnarad`** | WebSocket with typed JSON envelopes; HTTP for files | Server-paced heartbeat (`next_heartbeat_after_ms`); offline after 30 s | Offer → accept → ack; reports acked as committed, transient or rejected | State in Postgres; Redis Pub/Sub wake-ups, with a 30 s fallback drain | Not documented | Machine token | The closest design to this one; down-level encoding per daemon version |
| **Tailscale DERP** | HTTP upgrade to its own binary protocol; WebSocket fallback | Keepalive 60 s | n/a (WireGuard handles loss) | Regional mesh: servers watch each other's connections and forward | CONNECT proxies; WebSocket for TLS-inspecting proxies that refuse `Upgrade: DERP` | Node keys | Use the standard WebSocket upgrade; presence + forwarding replaces a broker |
| **Cloudflare Tunnel** | QUIC on UDP 7844, HTTP/2 on TCP 7844 as the fallback; 4 connections | n/a | n/a | Many edge nodes | Port 7844, not 443; automatic fallback has failed in the field; `--protocol http2` override | Tunnel token | Stay on TCP 443; test the fallback; ship a manual override |

---

## The candidates

### `ws`

- **What it is:** the standard WebSocket server and client for Node, with no runtime dependencies. 8.23.0, published 2026-11-12, MIT, about 415M npm downloads a week ([npm](https://www.npmjs.com/package/ws)).
- **Guarantees:** a WebSocket keeps order within one connection and nothing more. Acks, replay and deduplication belong to the application.
- **Liveness:** the README's heartbeat recipe has the server `ping()` each client on an interval and terminate those that don't `pong`. "Pong messages are automatically sent in response to ping messages as required by the spec" ([README](https://github.com/websockets/ws#how-to-detect-and-close-broken-connections)).
- **Compression:** permessage-deflate "is disabled by default on the server and enabled by default on the client", and the README warns of memory fragmentation and slow performance with it. → Turn it off on both sides. If batches need compressing, gzip them in the application, as Buildkite does with log chunks.
- **Proxies:**
  - The README says: "Use a custom `http.Agent` implementation like https-proxy-agent or socks-proxy-agent".
  - Node 24.5 and 22.21 added built-in proxy support: a `proxyEnv` option on `http.Agent`, and `NODE_USE_ENV_PROXY=1` for the global agent. It is "Stability: 1.1 - Active development" ([Built-in Proxy Support](https://nodejs.org/api/http.html#built-in-proxy-support), [`NODE_USE_ENV_PROXY`](https://nodejs.org/api/cli.html#node_use_env_proxy1)).
  - `ws` always passes its own `createConnection` to `https.request` ([lib/websocket.js](https://github.com/websockets/ws/blob/master/lib/websocket.js)). So `NODE_USE_ENV_PROXY=1` alone probably doesn't reach it. Passing `agent: new https.Agent({ proxyEnv: process.env })` might, which would avoid a proxy dependency (**unverified**; spike 5).
- **Bun:**
  - Bun's own `WebSocket` is built on uWebSockets ([Bun docs](https://bun.com/docs/runtime/http/websockets)), and the `ws` package runs under Bun.
  - One open Bun bug: through an HTTP CONNECT proxy, Bun sends `Sec-WebSocket-Extensions` even with `perMessageDeflate: false`, which some gateways reject ([bun#29684](https://github.com/oven-sh/bun/issues/29684), Bun 1.3.13).
- **Node's global client:** Node also has a browser-style global `WebSocket`, "No longer experimental" since v22.4.0. Its docs say nothing about proxies or custom headers ([globals](https://nodejs.org/api/globals.html#websocket)). Using `ws` on both Node and Bun gives one client, with an `Authorization` header and an agent.
- **Fit:** ✓ **The carrier.** Everything above it is ostra's, and has to be: ADR 0011's guarantees can't be delegated to a transport that forgets on reconnect.

### uWebSockets.js

- Apache-2.0, v20.71.0. The README says: "We aren't in the NPM registry but you can easily install it with the NPM client: `npm install uNetworking/uWebSockets.js#v20.70.0`" ([README](https://github.com/uNetworking/uWebSockets.js)). It ships native binaries per platform and Node version.
- It's fast: on Bun's chat-room benchmark, `Bun.serve` (built on uWebSockets) handles about 7× the messages per second of Node with `ws` ([Bun docs](https://bun.com/docs/runtime/http/websockets)).
- **Fit:** ✗ **Not now.**
  - Thousands of runners across several replicas means a few thousand sockets per replica, which `ws` should handle (to measure in spike 5).
  - Installing from GitHub instead of npm hurts reproducible installs and image builds.
  - It covers only the server side.
  - It stays an option behind the session layer if one replica ever needs tens of thousands of sockets.

### partysocket

- MIT, 1.3.0 (2026-06-23), about 5M downloads a week, with bundled types. It's "Forked from the wonderful reconnecting-websocket" ([README](https://github.com/cloudflare/partykit/tree/main/packages/partysocket)). It:
  - "Reconnects when a connection drops"
  - "Buffers messages when not connected, and sends accumulated messages when open"
  - runs in Node when given `ws` as its `WebSocket`
- Defaults: a minimum delay of `1000 + Math.random() * 4000` ms, a maximum of 10 s, growth ×1.3, `maxRetries: Infinity` and **`maxEnqueuedMessages: Infinity`**.
- **Fit:** ✗ **Not needed.**
  - Its buffer lives in memory, is unbounded by default, and replays messages without sequence numbers. ostra would have to switch it off (`maxEnqueuedMessages: 0`) and use the disk spool instead.
  - What remains is a reconnect loop with jitter, about 100 lines that ostra can own.

### Socket.IO

- MIT, 4.8.4 (2026-09-25).
- **Delivery** ([delivery guarantees](https://socket.io/docs/v4/delivery-guarantees)):
  - "By default, Socket.IO provides an at most once guarantee of delivery". There's no retry on reconnect, and "there is no such buffer on the server".
  - Clients reach at-least-once with `retries` and `ackTimeout`.
  - "additional delivery guarantees must be implemented in your application".
  - Order holds, even across the upgrade from long polling to WebSocket.
- **Recovery** ([connection state recovery](https://socket.io/docs/v4/connection-state-recovery)):
  - The adapter keeps sessions and packets for `maxDisconnectionDuration` (2 minutes in the example). The docs call it "designed for dealing with intermittent disconnections".
  - The adapter table lists the Postgres adapter as "WIP". The Postgres adapter's own feature table lists connection state recovery as "❌ NO" ([Postgres adapter](https://socket.io/docs/v4/postgres-adapter/)).
- **Several nodes:**
  - The Postgres adapter relies on NOTIFY and LISTEN. Payloads over 8,000 bytes go into an attachments table, and nodes heartbeat every 5 s (same page).
  - Sticky sessions are required, unless the client is WebSocket-only. That gives up the long-polling fallback, so "clients on restrictive networks may fail to connect" ([multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/)).
- **Fit:** ✗ **Rejected.**
  - Its value is fallback, reconnect and acks. But its durability (minutes, in memory, and not at all with Postgres) falls far short of F-045's 10 minutes and ADR 0011, so sequence numbers and replay would sit on top of it anyway.
  - Its fallback needs sticky sessions.
  - Its wire format is its own, which matters for a Bun binary and for any future non-JS runner.

### SSE plus HTTP POST

- **The pattern:** the server streams `text/event-stream` with `id:` fields, and clients resume with `Last-Event-ID`. The client sends with POSTs.
- **MCP's Streamable HTTP** is the best current specification of it ([MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)):
  - "Every JSON-RPC message sent from the client MUST be a new HTTP POST".
  - SSE event IDs are a cursor "on a per-stream basis", and resuming is a GET with `Last-Event-ID`.
  - It has an `MCP-Session-Id` and an `MCP-Protocol-Version` header on every request.
  - Servers "MAY close the connection" and have clients reconnect: a long poll in all but name.
- **Claude Code self-hosted runners use it:** "Session streaming uses server-sent events over HTTPS, so a proxy in the path must not buffer responses" ([self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md)).
- **Node:** `EventSource` is still "1 - Experimental", behind `--experimental-eventsource` ([globals](https://nodejs.org/api/globals.html)). The `eventsource` package (MIT, 5.1.5) or a small fetch-stream parser fills the gap.
- **Proxies:** it passes wherever HTTPS passes, except through proxies that buffer, which hold the stream until it ends. A long poll returns a complete response, so buffering only adds latency.
- **Fit:** ✓ **as the shape of the fallback carrier:** POST up, poll down, a cursor to resume, a version header. For the downlink I'd use a long poll rather than SSE, because of buffering. SSE can become a middle mode if spike 5 finds proxies that block WebSocket but stream SSE without buffering.

### HTTP/2 or gRPC bidirectional streaming (Connect-RPC)

- Apache-2.0, connect-es 2.3.0 (2026-10-27).
- **The limit:**
  - "With HTTP 1.1, the gRPC protocol and bidirectional streaming are not supported" ([Node clients](https://connectrpc.com/docs/node/using-clients)). The same holds for Node servers ([server plugins](https://connectrpc.com/docs/node/server-plugins)).
  - Bidirectional streaming "always requires end-to-end HTTP/2 support", and "Every proxy between the server and client — including those run by cloud providers — must support HTTP/2" ([streaming](https://connectrpc.com/docs/go/streaming)).
- **Buildkite uses the half-duplex shape:**
  - Its streaming job dispatch is a Connect stream (`StreamPings`) from `agent-edge.buildkite.com` ([agent_worker_streaming.go](https://github.com/buildkite/agent/blob/main/agent/agent_worker_streaming.go); `connectrpc.com/connect v1.21.1` in `go.mod`).
  - Everything else is plain HTTP.
  - That it's a server stream, not a bidirectional one, is my reading of the call site (**unverified**).
- **Types:** generated from protobuf. AGENTS.md has the runner protocol as Zod schemas that both sides import, and protobuf would be a second source of truth.
- **Fit:** ✗ **Rejected as the main carrier**, because bidirectional streams can't cross HTTP/1.1 proxies. A server stream plus unary calls is what ostra's HTTP fallback already is, without the protobuf toolchain.

### NATS / JetStream

- nats-server: Apache-2.0, v2.15.3. `@nats-io/transport-node` 3.5.0 (2026-11-16) is TypeScript and runs on Node and Bun ([nats.js](https://github.com/nats-io/nats.js)).
- **Delivery:** core NATS is at-most-once. "If you need higher qualities of service (at least once and exactly once) ... you can use NATS JetStream" ([what is NATS](https://github.com/nats-io/nats.docs/blob/master/nats-concepts/what-is-nats/README.md)). Publishers deduplicate with a `Nats-Msg-Id` header.
- **Proxies:** the WebSocket listener requires TLS "unless `no_tls` is `true`", so it can sit behind 443 ([websocket config](https://docs.nats.io/running-a-nats-service/configuration/websocket/websocket_conf)).
- **Routing:** fully solved: one subject per runner.
- **Fit:** ✗ **Rejected for v1.**
  - It's a second stateful service and a second store. ADR 0017 chose Postgres only so that "a job and the change that caused it are saved in the same transaction" and "one backup covers everything". An event saved in JetStream and a task change saved in Postgres can't commit together.
  - Exposing a broker to runners on laptops means per-runner credentials and subject permissions in NATS's own auth model, a second auth system next to better-auth (my inference).
  - It stays the "later" answer if Postgres routing ever becomes the bottleneck.

### Centrifugo

- The server is Apache-2.0, v6.10.3. The JS client `centrifuge` is MIT, 5.8.0.
- **Recovery:** channels keep a bounded stream (`history_size`, `history_ttl`) addressed by `offset` and `epoch`. When it can't recover, Centrifugo disconnects with "Insufficient state" ([history and recovery](https://centrifugal.dev/docs/server/history_and_recovery), [channels](https://centrifugal.dev/docs/server/channels)).
- **Postgres-only multi-node exists**, with a PostgreSQL broker and controller ([engines](https://centrifugal.dev/docs/server/engines)), but:
  - "The PostgreSQL broker for stream subscriptions is experimental".
  - Each node's outbox worker polls the stream table every 100 ms. `use_notify` adds LISTEN/NOTIFY wake-ups, which are incompatible with PgBouncer in transaction mode.
  - It needs PostgreSQL 16 or later, and it's meant for "the low thousands of publishes per second per broker".
  - Presence is still memory or Redis, and the scaling extras are in the paid PRO edition.
- **Fit:** ✗ **Rejected.**
  - It's a fan-out hub from server to clients. Client-to-server messages go through RPC proxies back into ostra's own backend, so ostra would still own acks and storage, and gain a Go service.
  - Its Postgres broker does, however, confirm the outbox + poll + optional NOTIFY design recommended below.

### Rivet Actors

- **What it is:** Apache-2.0. RivetKit 3.1.1 on npm (2026-11-11); the GitHub release is v2.3.32.
- **Self-hosting:**
  - The control plane is "a single Rust binary", on Postgres or FoundationDB ([repo](https://github.com/rivet-dev/rivet)).
  - "PostgreSQL is the recommended backend for multi-node self-hosted deployments today, but it remains experimental", and a single node uses RocksDB ([production checklist](https://github.com/rivet-dev/skills/blob/main/rivetkit/reference/self-hosting/production-checklist.md)).
  - The Kubernetes recipe also runs NATS, and asks for load-balancer idle timeouts of "at least 1 hour" ([kubernetes](https://github.com/rivet-dev/skills/blob/main/chat-room/reference/self-hosting/kubernetes.md)).
- **Nodes:** Rivet nodes open "an outbound connection to the control plane" and host the actors it assigns ([nodes](https://rivet.dev/docs/deploy/self-host/workers/supabase)). Conceptually that's a runner fleet.
- **The versioning lesson ([rivet#5484](https://github.com/rivet-dev/rivet/issues/5484)):**
  - rivetkit 2.3.8+ couldn't register with an older engine ("protocol_version 7 > engine's 6").
  - "There is no negotiation and no downgrade path".
  - The client "reconnects on a backoff **forever**", and "nothing is logged at error".
- **Fit:** ✗ **Rejected.**
  - An actor per runner would bring routing for free. The price is a Rust engine, plus NATS, beside ostra.
  - A framework would own the protocol, which ADR 0012 keeps as ostra's own.
  - The 2.x → 3.x line is moving fast.
  - Q11 evaluates Rivet's Sandbox Agent for the agent layer. That's a separate question.

### WebTransport

- **Node:**
  - `node:quic` exists behind `--experimental-quic`, but needs Node built from `main`.
  - James Snell (2026-05-07): "WebTransport, and higher-level HTTP semantics ... are not yet available" ([QUIC comes to Node](http://www.jasnell.me/posts/quic-comes-to-node)).
  - The `@fails-components/webtransport` addon (BSD-3-Clause, 1.6.12) is the only route today.
- **Networks:**
  - QUIC runs over UDP. Cloudflare Tunnel defaults to QUIC and falls back to HTTP/2 over TCP when UDP fails.
  - Field reports from November 2026 show that fallback not happening on QUIC-blocking corporate networks ([cloudflared#1798](https://github.com/cloudflare/cloudflared/issues/1798), [t3code#16344](https://github.com/pingdotgg/t3code/issues/16344)).
- **Fit:** ✗ **Rejected for runners.** Nothing ostra sends needs datagrams or freedom from head-of-line blocking.

### Postgres LISTEN/NOTIFY and a queue table (cross-replica routing)

- **NOTIFY's rules** ([NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), PostgreSQL 18):
  - The payload "must be shorter than 8000 bytes". The queue is "8GB in a standard installation", and when it fills, "transactions calling `NOTIFY` will fail at commit".
  - "if a `NOTIFY` is executed inside a transaction, the notify events are not delivered until and unless the transaction is committed".
  - Identical payloads on one channel within a transaction fold into one notification.
  - Only sessions listening at the time receive it.
- **The commit lock:**
  - Committing a transaction that issued NOTIFY takes a global lock, "effectively serializing all commits" ([Recall.ai](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale)).
  - DBOS measured a NOTIFY-per-write design topping out at about 2.9K writes/s ([DBOS, 2026-07-24](https://www.dbos.dev/blog/postgres-listen-notify-scalability)).
  - Buffering notifications and flushing them in batches reached 60K/s, with "readers also poll at a low frequency" to cover lost ones.
  - The patch slated for Postgres 19 "does not remove the global lock".
- **Connections:**
  - LISTEN needs a dedicated, direct connection; PgBouncer in transaction mode breaks it ([Centrifugo engines](https://centrifugal.dev/docs/server/engines)).
  - Prisma's own Postgres docs send "workloads that need session state or `LISTEN`/`NOTIFY`" to the direct host ([Prisma](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql)).
  - Prisma Client has no LISTEN API that I could find (**unverified**). A plain `pg` client works, and `@prisma/adapter-pg` already depends on `pg`.
- **Advisory locks per runner, as the ownership record, are too risky:**
  - They share a memory pool sized by `max_locks_per_transaction` and `max_connections`, "typically in the tens to hundreds of thousands" of locks.
  - If it runs out, "the server will be unable to grant any locks at all" ([explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)).
  - That's not worth it for thousands of runners when a presence row does the job.
- **The queue (outbox) table:**
  - It's durable, replayable, and any replica can read it. Its cost is polling, which NOTIFY reduces to a wake-up.
  - Omnara does this with Redis Pub/Sub as the doorbell ("Redis Pub/Sub wakeups are best-effort; this is the API-side fallback drain floor", 30 s, [.env.example](https://github.com/omnara-ai/omnara/blob/main/.env.example)).
  - Centrifugo's Postgres broker does it with NOTIFY.
- **Fit:** ✓ **Chosen.** The table is the truth, NOTIFY is the doorbell, and a sweep is the safety net.

---

## Reference systems

### Claude Code self-hosted environments

Checked 2026-11-18 against [self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md) and [deploy](https://code.claude.com/docs/en/self-hosted-environments-deploy.md).

- **Polling:**
  - "The runner gives each poll request 10 seconds."
  - On a timeout, a lost request or an unparseable answer, it retries after a second or two, doubling up to 20 s, "and shortens the gap whenever the lease is close to expiring".
  - "an intercepting proxy that answers the poll with its own page produces a response the runner can't parse".
- **Lease:**
  - "each poll refreshes the lease and doubles as the heartbeat".
  - "its lease lapses after about 60 seconds. The server can then take a few minutes and sometimes longer to requeue the session".
- **Streams:** each child Claude Code process "holds the session's event stream to `api.anthropic.com`", over SSE, so the proxy "must not buffer responses".
- **Proxies:**
  - It honours `HTTPS_PROXY`, `NO_PROXY` and mTLS settings.
  - For proxies whose `Proxy-Authorization` rotates, there are `--proxy-authorization-command` and `--proxy-authorization-file`. They start a local forward proxy on `127.0.0.1` that adds the header to each new upstream connection.
- **Auth:**
  - A shared "environment secret" registers runners, and runners receive a runner token.
  - Each session authenticates with "an Anthropic-issued, session-scoped OAuth token".
  - Revoking the secret makes runners exit.
- **Draining:** on `SIGTERM` the runner "keeps polling during the drain so sessions aren't reassigned". `--retire-at` releases sessions so they resume elsewhere.
- **Lessons:**
  - Polling is enough for dispatch.
  - Renew the lease with traffic the runner sends anyway.
  - Treat a proxy's HTML page as a network failure, not a protocol error.
  - Plan for rotating proxy credentials.

### GitHub Actions self-hosted runners

- **Polling:** the runner "uses an HTTP(S) long poll that opens a connection to GitHub for 50 seconds" ([communicating with runners](https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners)).
- **Proxies:** "The connection between self-hosted runners and GitHub is over HTTPS (port 443)". It reads `https_proxy` and `no_proxy`, where lowercase wins on Linux and macOS, or takes them from a `.env` file ([proxy servers](https://docs.github.com/actions/how-tos/managing-self-hosted-runners/using-a-proxy-server-with-self-hosted-runners)).
- **Source** (actions/runner `main`, read 2026-11-18):
  - The listener creates a session, then long-polls `GetAgentMessageAsync(poolId, sessionId, lastMessageId, …)`. `lastMessageId` is the cursor ([MessageListener.cs](https://github.com/actions/runner/blob/main/src/Runner.Listener/MessageListener.cs)).
  - A `BrokerMigrationMessage` tells the runner to switch to another broker URL.
  - Errors back off at random, 15–30 s and then 30–60 s.
- **Leases:**
  - `JobDispatcher` renews each job "after 60 sec delay" ([JobDispatcher.cs](https://github.com/actions/runner/blob/main/src/Runner.Listener/JobDispatcher.cs)), and the logs show each renewal valid for 10 more minutes ([runner#3539](https://github.com/actions/runner/issues/3539)).
  - On errors it keeps retrying "till reach lockeduntil + 5 mins extra buffer".
  - The failure users see is "The self-hosted runner: X lost communication with the server" ([runner#1546](https://github.com/actions/runner/issues/1546)).
- **Auth:** a `VssOAuthJwtBearerClientCredential`, signed by an RSA key the runner keeps, is exchanged for OAuth access tokens ([OAuthCredential.cs](https://github.com/actions/runner/blob/main/src/Runner.Listener/Configuration/OAuthCredential.cs)).
- **An outage worth noting:** when a GitHub Actions certificate expired on 2026-07-19, every long-polling runner dropped at once. Runners under a supervisor that restarts them reconnected on their own ([RedEye Security](https://threat-intelligence.redeyesecurity.com/blog/github-actions-cert-expiry-runner-outage-2026); secondary source).
- **Lessons:**
  - A 10-minute lease renewed every minute is GitHub's answer to the same question F-045 asks.
  - The server can tell a runner to move.
  - A signed assertion travels on the wire, not a long-lived secret.
  - Runners run under a supervisor.

### Buildkite agents

- **Dispatch modes** ([job dispatch](https://buildkite.com/docs/agent/self-hosted/configure/job-dispatch)):
  - `--ping-mode auto` (the default) "Uses streaming when available, and falls back to polling if the streaming connection fails". In `auto`, "both mechanisms run concurrently".
  - `poll-only` is for networks where streaming fails, and `stream-only` has no fallback.
  - Streaming arrived in agent v3.122.0, through `https://agent-edge.buildkite.com/v3`.
- **The stream:**
  - It's a Connect RPC, `StreamPings` ([agent_worker_streaming.go](https://github.com/buildkite/agent/blob/main/agent/agent_worker_streaming.go)).
  - It reconnects after a jitter inside a window that doubles from 1 s up to 2⁶ s.
  - A reconnect "after deadline-exceeded" is routine: streams are cut on purpose.
- **Liveness:** "If the Buildkite API does not receive any heartbeat requests from an agent for three consecutive minutes, that agent is marked as lost within the next 60 seconds" ([lifecycle](https://buildkite.com/docs/agent/lifecycle)).
- **Logs:** uploaded as gzip chunks carrying `sequence`, `offset` and `size` ([api/chunks.go](https://github.com/buildkite/agent/blob/main/api/chunks.go)). That's an ordered, idempotent upload over plain HTTP.
- **Lessons:**
  - Push is an optimization layered on a polling baseline, with both running.
  - Operators get a switch.
  - Streams are expected to be cut and resumed.

### Multica's daemon

- **Docs** ([daemon runtimes](https://www.multica.ai/docs/daemon-runtimes)):
  - "the daemon also polls periodically so a dropped connection does not lose the notification".
  - It heartbeats every 15 s, and a runtime is offline "within about 3 minutes at the latest".
  - `MULTICA_RUNTIME_RECONNECT_GRACE` defaults to 3 h. Runs never move machines, and a restarted daemon reclaims its runs.
- **Config** ([.env.example](https://github.com/multica-ai/multica/blob/main/.env.example)):
  - `MULTICA_DAEMON_POLL_INTERVAL=30s`
  - `MULTICA_DAEMON_WS_CLAIM_POLL_INTERVAL=3m`, an "Independent healthy-WebSocket safety poll upper bound"
  - `MULTICA_DAEMON_HEARTBEAT_INTERVAL=15s`
- **Several replicas** (same file):
  - Redis is optional and backs "realtime fan-out, channel leases, rate limits, and token caches".
  - The WeCom bot carries a "SINGLE-REPLICA CONSTRAINT", because "responses produced on a replica that does not hold the lease are dropped ... Until cross-replica outbound routing lands".
  - The stack is Go with gorilla/websocket (`landscape.md`).
- **Lessons:**
  - A WebSocket doorbell plus a poll is robust.
  - Delivering to a connection held by another replica is the hard part, and Multica solves it with Redis.

### Omnara's `omnarad`

- **Shape:** the daemon "connects outbound to the control plane", with no inbound ports ([machines](https://docs.omnara.com/machines/overview.md)). It's Go, on `github.com/coder/websocket` (`go.mod`).
- **The protocol** ([internal/daemonprotocol/protocol.go](https://github.com/omnara-ai/omnara/blob/main/internal/daemonprotocol/protocol.go)):
  - Typed JSON envelopes.
  - `heartbeat` / `heartbeat_ack` with `next_heartbeat_after_ms`, so the server sets the pace.
  - `process_offer` → `process_accept` → `process_accept_ack`, and an `action_offer` with a `seq`.
  - `report` → `report_ack`, with the statuses `committed`, `cleanup_only`, `permanent_reject` and `transient_error`.
  - Errors including `presence_replaced`, `authorization_revoked` and `machine_decommissioned`.
  - A 1 MiB message cap, with files over HTTP under a digest header.
- **Versioning:** the backend socket encodes per daemon version. `encodeForDaemon(daemonVersion, message)` strips or clamps fields older daemons reject: "Daemons before 0.2.6 reject read waits over 10s" ([transformer.go](https://github.com/omnara-ai/omnara/blob/main/internal/daemonprotocol/transformer.go)).
- **Routing:**
  - State lives in Postgres.
  - "Redis Pub/Sub wakeups are best-effort", with a 30 s fallback drain for connected daemon sockets ([.env.example](https://github.com/omnara-ai/omnara/blob/main/.env.example)).
  - `compose.yaml` runs Valkey.
- **Failure rules** ([failure handling](https://docs.omnara.com/agents/failure-handling.md)):
  - "Commands it hasn't accepted never run late": a command fails if the machine doesn't accept it within five minutes, or after 30 s offline.
  - Worker leases renew about every 30 s, and "A worker that has lost its lease can't save anything afterward".
- **Lesson:** this is the closest design to the one below. ostra swaps Redis for NOTIFY.

### Tailscale DERP

- **Upgrade:**
  - DERP over HTTP "makes DERP look exactly like WebSockets", "even if the TLS connection [is] intercepted using a fake root CA" ([derphttp_client.go](https://github.com/tailscale/tailscale/blob/main/derp/derphttp/derphttp_client.go)).
  - Even so, Tailscale added a hook "to get past HTTP proxies that intercept TLS and refuse the 'Upgrade: DERP' request but allow WebSocket upgrades, like browsers use". After one failure, the client keeps using WebSocket for its reconnects.
  - It honours HTTP CONNECT proxies from the environment.
- **Mesh:**
  - The DERP servers of a region share a mesh key ([derpserver.go](https://github.com/tailscale/tailscale/blob/main/derp/derpserver/derpserver.go)).
  - Each server watches the others' connections (`FrameWatchConns`, `FramePeerPresent`) and forwards packets for peers connected elsewhere (`FrameForwardPacket`) ([derp.go](https://github.com/tailscale/tailscale/blob/main/derp/derp.go)).
  - `KeepAlive` is 60 s and `ProtocolVersion` is 2 (derp.go). Overview: [DERP servers](https://tailscale.com/docs/reference/derp-servers).
- **Lessons:**
  - Use the standard WebSocket upgrade: inspecting proxies refuse custom ones.
  - Presence plus forwarding is the broker-free way to reach a connection on another node. ostra keeps the presence part in Postgres, without the mesh.

### Cloudflare Tunnel

- **Connections:**
  - `cloudflared` connects out to `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com` on **port 7844**, TCP and UDP ([firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)).
  - `--protocol auto` "will automatically configure the quic protocol. If cloudflared is unable to establish UDP connections, it will fallback to using the http2 protocol" ([run parameters](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/run-parameters)).
  - Logs show 4 registered connections ([t3code#16344](https://github.com/pingdotgg/t3code/issues/16344)).
- **In the field:**
  - cloudflared 2026.11.0 kept trying QUIC after its own precheck said to use HTTP/2 ([#1798](https://github.com/cloudflare/cloudflared/issues/1798)).
  - A corporate VPN that drops UDP kept a tunnel down until it was forced to HTTP/2 (t3code#16344).
  - WebSocket upgrades lose their `Upgrade` header on QUIC ([#1652](https://github.com/cloudflare/cloudflared/issues/1652)).
- **Lessons:**
  - Stay on TCP 443.
  - Automatic fallback is a source of bugs, so test it, and give operators a `--transport` override.

### What they agree on

1. **Outbound HTTPS to one host on 443**, with the standard proxy variables. Only cloudflared leaves 443, and it pays for it.
2. **A lease renewed by normal traffic:**
   - polls (Claude Code)
   - renewals every 60 s against a 10-minute lock (GitHub)
   - heartbeats, with "lost" after 3 minutes (Buildkite)
3. **A polling path that always works.** Push is added on top (Buildkite, Multica, Omnara's fallback drain).
4. **The server sets the pace and can redirect:** `next_heartbeat_after_ms` (Omnara), broker migration (GitHub).
5. **Cursors and acks per stream:** `lastMessageId`, log `sequence`, `report_ack`.
6. **A long-lived machine identity that only ever mints short-lived tokens.**

---

## Recommended design

### 1. Shape: one session, two carriers

```
runner ──wss://server/runner/v1/connect──▶ core service replica ──▶ Postgres
   │      (fallback: POST /runner/v1/up + GET /runner/v1/down long poll)
   └──── bulk files: HTTPS PUT/GET with chunks and a digest (never on the session)
```

- **Two streams.** The protocol is a session between one runner and the server, carrying two ordered, acknowledged streams:
  - **up**: events and results, runner → server
  - **down**: commands, server → runner
- **Unsequenced alongside them:**
  - control messages (`hello`, `welcome`, `ack`, `credit`, `goaway`, `error`)
  - request/response calls (`rpc`) for things that must not be stored, such as tokens
- **Carriers:**
  - **WebSocket:** a single `wss://` connection, text frames, one JSON envelope per frame.
  - **HTTP fallback:** the same envelopes. `POST /runner/v1/up` takes a batch and returns acks. `GET /runner/v1/down?after=<seq>` holds for up to 25 s and returns commands, or 204.
- **Bulk data stays off the session:**
  - It covers session archives for ADR 0006 step 2, workspace snapshots and large attachments.
  - It goes over plain HTTPS: chunked, resumable, with a digest. That's what Omnara (digest header) and Buildkite (log chunks) do.
  - Frames are capped at **1 MiB** *(working value; Omnara uses 1 MiB)*.
- **Any replica can serve any request on either carrier.** State lives in Postgres, so the load balancer needs no sticky sessions. Self-hosters only have to pass the WebSocket upgrade through.

### 2. Framing

Each direction is a Zod discriminated union on `type`, in the shared protocol package. Schemas are strict (`z.strictObject`), because the format is ostra's (AGENTS.md); §9 explains how that coexists with an older peer. IDs are branded (`RunnerId`, `TaskId`, `SessionId`, `CommandId`).

| Direction | Message | Sequenced | Purpose |
|---|---|---|---|
| up | `hello` | no | Protocol minor, runner version, features, last applied command seq, open sessions with their lease epochs and next event seq |
| down | `welcome` | no | Negotiated minor, server time, credit window, heartbeat interval, connection ID |
| up | `events` | yes, per session | A batch of agent events `{sessionId, leaseEpoch, fromSeq, items[]}` |
| down | `ack` | no | `{sessionId, upTo}` once committed, or `{resendFrom}` when there's a gap |
| down | `credit` | no | A new send window |
| down | `command` | yes, per runner | `{seq, id, kind, body, notAfter?}`: dispatch, steer, interrupt, stop, approval decision, drain, update hint |
| up | `command.ack` | no | `{upTo}`, plus a result per command: `accepted`, `rejected{reason}`, `done`, `outcome-unknown` |
| up | `status` | no (latest wins) | Capacity, running sessions, agents found, labels |
| both | `rpc` / `rpc.result` | no (the caller retries) | Push tokens, model-key leases, upload URLs; never stored and never logged |
| down | `goaway` | no | Reconnect after `{ms}`: draining, rebalancing, maximum connection age |
| both | `error` | no | Typed codes (below) |

- **Close codes** use the 4000–4999 application range, mirroring HTTP:
  - `4400` protocol violation
  - `4401` token expired
  - `4403` runner revoked
  - `4409` replaced by a newer connection (Omnara's `presence_replaced`)
  - `4426` upgrade required
  - `4503` server draining
- **In HTTP mode**, the same codes come back as HTTP statuses with the same JSON body.

### 3. Runner → server: sequence numbers, the spool and acks

- **Numbering and the spool:**
  - The runner gives each event of a session the next `seq` (1, 2, 3, …).
  - It appends the event to a local **spool** (append-only files per session) before sending it.
  - Files work the same on Node and Bun, with no SQLite binding in either: `node:sqlite` is still "1.2 - Release candidate" ([sqlite](https://nodejs.org/api/sqlite.html)).
- **Coalescing:** consecutive text deltas of one message become a single event every **250 ms** *(working value)*. That bounds the event rate without hurting the live view much.
- **Saving on the server:**
  - The server inserts each batch in one transaction: `INSERT … ON CONFLICT (session_id, seq) DO NOTHING`.
  - In the same transaction, it advances the session's ingest cursor and enqueues any reactions in the durable queue (ADR 0011, ADR 0017).
  - It sends `ack {upTo}` only **after commit**. Then the runner drops that part of the spool.
- **Why replay is safe:**
  - A crash anywhere just leads to a resend, and the unique key turns duplicates into no-ops.
  - A batch that doesn't start at the cursor + 1 gets `ack {resendFrom}` instead, so a gap can never be committed.
- **The lease check:** each batch carries the `leaseEpoch` of its dispatch. A batch from a stale epoch is refused and never stored (§6).
- **A full spool:** the spool has a quota of **1 GiB per runner** *(working value)*. When it's full, the runner stops reading the agent's output. The agent then blocks on its own stdout pipe, which is backpressure all the way to the agent. Events are never dropped.
- **Runner state:** capacity, the agents found and labels aren't a stream. The latest `status` wins, and the runner sends it in full after each `hello`.

### 4. Server → runner: commands in an outbox table

```sql
-- sketch, not a migration
runner_command (
  runner_id   uuid,
  seq         bigint,          -- per runner, gap-free, in commit order (see below)
  id          uuid unique,     -- idempotency key
  kind        text,            -- dispatch | steer | interrupt | stop | approval | drain | ...
  body        jsonb,           -- references, never secrets
  not_after   timestamptz,     -- optional: don't apply after this
  created_at  timestamptz,
  acked_at    timestamptz,
  result      jsonb,
  primary key (runner_id, seq)
)
```

- **Writing a command:**
  - Whoever changes the domain writes the command in the same transaction: the panel when a member steers, a queue job when it dispatches, a timer when it stops a task.
  - `seq` comes from `UPDATE runner SET last_command_seq = last_command_seq + 1 … RETURNING`. The row lock serializes command inserts per runner, so seq order equals commit order, and a reader following a cursor can never skip a row that commits late. A global `bigserial` doesn't give that.
  - Transactions that write commands are kept short.
- **Delivery:**
  - The replica holding the runner sends commands with `seq > lastSent`.
  - The runner records each command ID as started before applying it, then as done, and acks the highest contiguous seq.
  - On reconnect, `hello.lastCommandSeq` tells the server where to resume.
- **Applying commands:**
  - Every command is idempotent by `id`.
  - A command whose `notAfter` has passed is answered `rejected{expired}`, never applied late (Omnara's rule).
  - The runner judges `notAfter` by server time, using the offset from `welcome.serverTime`, so laptop clock skew doesn't matter. GitHub's listener has explicit clock-skew retries.
- **Dispatch is an offer:**
  - The runner answers `accepted` or `rejected{capacity | agent-missing | label-mismatch}`.
  - An offer not accepted within **2 minutes** *(working value; Omnara uses 5)* goes back to the queue (F-067) and on to another runner (F-069).
- **Uncertain outcomes:** if a runner crashes between starting and finishing a steer, it can't know whether the agent got the message. It reports `outcome-unknown`, and the panel shows it, the way Omnara tells its agent that an interrupted call's "external outcome is unknown".
- **Secrets:** commands never carry secrets. Environment secrets (F-050), push tokens and team API keys (ADR 0014) are fetched by `rpc` when needed, after the server checks the lease epoch. So they never sit at rest in the command table, in the spool or in a log.
- **Retention:** acked commands are deleted after a retention period (F-079).

### 5. Backpressure

- **The runner's send window:**
  - The runner never has more than a window of unacked frames in flight: **256 frames or 4 MiB** *(working value)*.
  - `welcome` grants the window, and acks and `credit` refresh it.
  - A slow database slows acks, the window fills, and runners spool to disk. No memory grows on the server.
- **The server's limits:**
  - Each replica caps its database work per connection: one batch in flight per runner, and a bounded pool.
  - Under load it slows heartbeats through `welcome` / `status` replies (Omnara's `next_heartbeat_after_ms`).
  - Past its connection limit, it refuses new connections with `503` and `Retry-After`.
- **The downlink:** before writing to a socket, the server checks `ws.bufferedAmount`. Commands that wait stay in the table, so nothing is lost.
- **Reconnect storms:** a replica restart drops thousands of runners at once.
  - Runners reconnect with **full jitter, starting at 1 s and doubling to 60 s** *(working value; Buildkite doubles from 1 s to 64 s, GitHub waits 15–60 s)*.
  - Replicas admit new sessions at a capped rate.

### 6. Heartbeats, presence and leases (F-045)

There are two separate timers, as GitHub has (renew every 60 s, locked for 10 minutes).

| Timer | Value | What happens |
|---|---|---|
| WebSocket ping from the server | every **20 s** | Stays under nginx's default "closed if the proxied server does not transmit any data within 60 seconds" ([nginx](https://nginx.org/en/docs/http/websocket.html)) and DERP's 60 s keepalive |
| Dead connection | no frame for **45 s** | Either side closes and the runner reconnects |
| Runner `status` heartbeat | **15 s**, set by the server | Capacity and running sessions (Multica uses 15 s) |
| Presence write | one `UPDATE` per replica every **10 s** for all its sockets | Constant database load, whatever the runner count |
| Panel shows offline | no presence for **45 s**, or the holding replica is dead | F-013 |
| Task grace | **10 minutes** without the runner (F-045) | A durable-queue timer stops the task cleanly, ready to reopen elsewhere (ADR 0006) |
| Runner self-fence | **9.5 minutes** without reaching the server | The runner stops its agents cleanly and keeps the workspace and branch |

All values are *(working values)*.

- **Fencing:**
  - Each dispatch or reopen increments the task's `lease_epoch`.
  - The runner sends the epoch with events, results and token requests.
  - After the task grace, the epoch the runner holds is stale. The server refuses its events and won't mint it a push token, so a runner that wakes up after an hour can't push to a branch that is being worked elsewhere. Omnara: "A worker that has lost its lease can't save anything afterward".
  - Self-fencing on the runner is a courtesy. The server's refusal is the guarantee.
- **Laptop sleep:**
  - A laptop that sleeps through the grace period comes back holding a stale epoch, and fencing covers it.
  - Whether the runner's monotonic clock counts sleep time differs by OS and runtime (**unverified**; spike 5).

### 7. Cross-replica routing without Redis

```sql
runner_presence (runner_id pk, replica_id, conn_epoch bigint, connected_at, last_seen_at)
core_replica    (id pk, started_at, last_seen_at)   -- each replica heartbeats here
```

- **Connect:**
  - The replica that accepts a `hello` upserts `runner_presence` with `conn_epoch + 1`.
  - If another replica held the runner, it sends `pg_notify('ostra_runner', '{"k":"evict","r":…,"e":…}')`. The old replica closes its socket with `4409`; DERP and Omnara handle takeover the same way.
  - Replicas deliver only to sockets whose epoch matches, so a half-open connection on the old replica goes quiet at once.
- **Send:**
  - The writer inserts the `runner_command` row and calls `pg_notify('ostra_runner', '{"k":"cmd","r":…}')` in the same transaction. Postgres delivers it only after commit.
  - Every replica listens on one channel and ignores runners it doesn't hold.
  - With a handful of replicas, broadcasting is cheaper than looking up the owner first.
- **The safety net:**
  - Every **2 s** *(working value)*, each replica runs one query for undelivered commands of the runners it holds.
  - Notifications can be lost (a listener reconnecting, a replica restarting) without losing a command. They only cost up to 2 s.
  - Omnara's floor is 30 s, Centrifugo polls every 100 ms, and DBOS polls "at a low frequency".
- **Keeping NOTIFY cheap:**
  - Only commands, evictions and revocations use it: tens per second at 1,000 tasks, well under the ~2.9K/s where DBOS saw the commit lock bite.
  - Agent events never use NOTIFY. If live-sync needs to wake browsers on other replicas, it must batch its notifications per session, as DBOS did (`live-sync.md`).
- **Connections:** each replica holds **one dedicated `pg` connection for LISTEN**, direct to Postgres, never through PgBouncer in transaction mode.
- **Runner → server traffic needs no routing.** The replica holding the socket writes to Postgres directly.
- **Draining and rebalancing:**
  - A stopping replica sends `goaway` to its runners in jittered waves, so they move to the others.
  - A connection older than **60 minutes** *(working value)* is asked to reconnect, which spreads runners evenly after a scale-out.
  - Google's load-balancer guidance recommends capping connection lifetimes, "for example, between 10 and 20 minutes", and its global load balancer closes WebSockets after 24 hours regardless ([best practices](https://cloud.google.com/load-balancing/docs/https/http-load-balancing-best-practices), [request distribution](https://cloud.google.com/load-balancing/docs/https/request-distribution)).
- **Considered and set aside:**
  - **Sticky routing by runner ID at the load balancer:** it doesn't help messages that start on the server.
  - **Replica-to-replica forwarding** (DERP's mesh): lower latency, but replicas must find and trust each other.
  - **An advisory lock per runner:** limited by the shared lock pool (above).

### 8. Auth

This follows `research/platform-auth-github.md` §1.7, adjusted to a TypeScript server.

1. **Registration:**
   - **On a laptop:** `ostra-runner login <url>` runs better-auth's device authorization flow (RFC 8628). The member approves the code in the panel. The CLI uses the resulting session token once, to register.
   - **On servers, Docker and elastic sandboxes:** an admin creates a one-time registration token. GitHub's equivalent expires after an hour. For sandboxes that serve a single task, the token can be bound to that task, like GitHub's `generate-jitconfig` and Claude Code's "single-use work order".
2. **Identity:**
   - The runner generates an **Ed25519 key pair** and registers the public key.
   - The private key is the only secret it keeps at rest: a file readable only by its user, or a Docker volume. The OS keychain comes later.
3. **Connecting:**
   - The runner posts a signed assertion (runner ID, server URL as audience, a `jti`, a lifetime of 60 s or less) to `POST /runner/v1/token` and gets a **10-minute access token** *(working value)*.
   - It opens the WebSocket with `Authorization: Bearer`, and the server checks the token at the upgrade.
   - GitHub's runner does the same with an RSA key.
   - A TLS-inspecting proxy sees request headers, so what leaks there is a token that expires in minutes, never the key.
4. **Long connections:**
   - The server doesn't re-check the token mid-connection. It caps the connection's age instead (§7).
   - Revocation is pushed: deleting a runner sends `evict`, the socket closes with `4403`, and reconnecting fails.
5. **Per-task credentials** (push tokens, team API keys, environment secrets) come by `rpc`, tied to a task and its lease epoch (ADR 0014). They're never logged.
6. **ADR 0012's wording:** it says "A runner holds no long-lived secrets". The runner key is long-lived, but it's an identity, not access. On its own it lets a runner connect and receive the tasks dispatched to it, while every credential for code or models stays short-lived and per task. The ADR could say so in one line.

### 9. Versioning (ADR 0022)

- **The handshake:**
  - The URL path carries the major: `/runner/v1/…`.
  - `hello` carries `protocolMinor`, `runnerVersion` and `features[]`.
  - The server picks `negotiated = min(server, runner)` when the majors match and the minors are at most one apart.
  - Otherwise it closes with `4426` and a JSON body: `{serverVersion, supported: {min, max}, hint}`.
- **Strict schemas against an older peer:**
  - A peer must never receive a field or message type it doesn't know, because ostra's own schemas reject unknown fields.
  - So each side keeps **codecs for the current and the previous minor** and encodes down to the negotiated one.
  - Omnara's `encodeForDaemon(daemonVersion, …)` does exactly this.
  - `hello` is the one message that tolerates unknown fields, because it is the negotiation.
  - Optional features are named in `features[]`. That's also how adapters declare optional capabilities, per AGENTS.md's adapter parity rule.
- **The runner ahead of the server (risk 1):**
  - ADR 0022 allows runners one minor *behind*. But `npx ostra-runner` floats to the newest version, while servers upgrade on their teams' schedules (ADR 0001).
  - Two ways out, for the maintainer to choose:
    - (a) the window is ±1 minor, so a runner also speaks one minor older
    - (b) `ostra-runner login` reads `/runner/v1/info` and pins the runner to the server's version (`npx ostra-runner@<version>`)
  - I'd do both.
- **A refused runner says so:**
  - It logs at error level with the fix and retries every 5 minutes, not in a tight loop.
  - It shows the reason in `ostra-runner status`, and the panel lists it as outdated (F-061).
  - Rivet's silent, endless reconnect loop is the failure to avoid.
- **CI:** a compatibility matrix of runner N−1, N and N+1 against server N, run over recorded fixtures.

### 10. Corporate networks and the fallback

- **One origin:**
  - Everything goes to `https://<server>/runner/v1/*` on 443, so allow-listing is a single host, as with GitHub and Claude Code.
  - Agents' own traffic (model APIs, git) is separate and not this protocol's concern.
- **Proxy settings:**
  - The runner honours `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms (lowercase wins, as with GitHub), and Basic credentials in the proxy URL.
  - Rotating proxy credentials can follow Claude Code's command-or-file hook later.
- **TLS inspection:**
  - The runner honours `NODE_EXTRA_CA_CERTS`, and `--use-system-ca` or `NODE_USE_SYSTEM_CA=1` (Node 23.8+, and 24.6+ / 22.19+ for the variable, [cli](https://nodejs.org/api/cli.html)).
  - What a Bun-compiled binary honours is **unverified**.
- **Recognizing a proxy's answer:**
  - A handshake or poll response that fails to parse as an ostra envelope (a proxy's HTML page) is a network failure, not a protocol error.
  - The runner says: "a proxy answered instead of the ostra server".
- **When to fall back:** any of these switches the runner to HTTP mode:
  - the upgrade gets a non-101 answer after TLS succeeded
  - the socket dies within 10 s of opening three times in a row
  - two heartbeat periods pass with no frames
- **Coming back:** in HTTP mode the runner tries WebSocket again every **10 minutes** *(working value)*. DERP sticks with whatever worked last, and Buildkite runs both.
- **A manual switch:** `--transport auto|websocket|http`, like Buildkite's `--ping-mode` and cloudflared's `--protocol`, because automatic fallback has failed in the field.
- **HTTP mode:**
  - The long poll itself is the heartbeat (as with Claude Code), and an idle runner also posts `status`.
  - At 5,000 runners with a 25 s hold, that's about 200 requests per second across the replicas.
  - Any replica can answer a poll. It reads the command table and waits on its own LISTEN connection for that runner.
- **Self-hosting docs need to say:**
  - pass the WebSocket upgrade through
  - nginx closes idle proxied connections after 60 s by default, which the 20 s ping covers
  - Google's classic Application Load Balancer closes WebSockets "whether idle or active" when the backend service timeout expires, 30 s by default ([request distribution](https://cloud.google.com/load-balancing/docs/https/request-distribution)), so raise it

### 11. What this asks of the maintainer

AGENTS.md says to ask before adding dependencies. This design adds:
- **`ws`** and **`@types/ws`** on both the server and the runner
- **`pg`** used directly, for each replica's LISTEN connection (`@prisma/adapter-pg` already depends on it)
- possibly **`https-proxy-agent`**, only if Node's `proxyEnv` agent and Bun can't proxy the WebSocket upgrade (spike 5)

No broker, no Redis, no Socket.IO, no protobuf.

The transport choice is hard to reverse, so after spike 5 it belongs in an ADR, for example "Runner protocol: one session over WebSocket with an HTTP fallback, routed through Postgres". New glossary candidates: **lease** (with its epoch) and **command**.

---

## Unknowns / spike

### Add to spike 5 (the runner)

Spike 5 already covers "spawning `claude-agent-acp` and reconnecting to a server" on Node and Bun, on three operating systems. The transport adds these questions, each with a pass condition.

1. **Through real networks.**
   - **Setup:** the `ws` client on Node 26 and the Bun-compiled binary, against:
     - a direct connection
     - squid as a CONNECT proxy
     - squid with Basic auth
     - mitmproxy intercepting TLS with a custom CA
     - nginx with default settings
     - a Cloudflare-proxied hostname
   - **Also check:**
     - whether `new https.Agent({ proxyEnv })` proxies `ws`'s upgrade
     - what Bun honours (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, the system CA)
     - whether bun#29684's extension header breaks any of them
   - **Pass:** each case connects, or falls back to HTTP by itself within 30 s. If neither works, the runner prints an error that names the proxy.
2. **No loss, no duplicates.**
   - **Setup:**
     - `kill -9` the runner mid-stream
     - cut the network for 30 s, 5 minutes and 11 minutes
     - restart the replica holding the runner
   - **Pass:**
     - every event the agent produced is in `agent_event` exactly once
     - after 11 minutes the task stops cleanly
     - the runner fences itself and gets its stale-epoch writes refused (F-045, F-048)
3. **Two replicas, one Postgres.**
   - **Setup:**
     - measure steer latency (p50 and p99) with NOTIFY, and with NOTIFY switched off (sweep only)
     - kill the replica holding a runner
     - create a half-open connection and check that the old replica evicts it
   - **Pass:** p99 is under 500 ms with NOTIFY and under 2.5 s without it *(working values)*.
4. **Load.**
   - **Setup:** a small harness of 5,000 simulated runners and 1,000 sessions sending coalesced events, at rates taken from spike 1's ACP traces.
   - **Measure:**
     - memory per 1,000 sockets
     - Postgres rows per second
     - ack latency
     - notifications per second
   - **Pass:** one replica holds at least 2,000 runners, and three replicas with one Postgres reach the Q18 target. If they don't, look at batching first, then uWebSockets.js.
5. **Versions.**
   - **Setup:** runners N−1, N and N+1 against server N, with strict schemas.
   - **Pass:** each pair either works, or refuses with a clear message and slow retries.
6. **Laptop sleep.**
   - **Check:**
     - whether `performance.now()` advances during sleep on macOS, Windows and Linux, under Node and Bun
     - how fast a zombie socket is detected after wake
   - **Pass:** a laptop that sleeps through the task grace never applies a stale command and never gets a write accepted.

### For other spikes and research

- **Spike 1 (ACP):** record events per second per busy session, before and after 250 ms coalescing. It sizes item 4.
- **Spike 6 (durable queue):** the candidate Postgres queue libraries also use LISTEN. Decide whether they share the per-replica LISTEN connection, or each keeps its own.
- **`live-sync.md`:** agent events reach browsers on other replicas or in Next.js. That fan-out must not NOTIFY per event (§7).

### Questions for the maintainer (candidates for `open-questions.md`)

1. **A runner newer than its server.** Allow ±1 minor, pin the runner to the server's version at login, or both? (Recommended: both.)
2. **Text deltas and ADR 0011.**
   - Are streaming text deltas "agent events" that must be saved one by one?
   - Recommended: no. Save coalesced deltas and the final message, as Omnara saves the finished response and not its deltas.
3. **HTTP fallback timing.** In v1, with remote and local runners in milestone 4, or later? (Recommended: v1. It's the same session layer, and "works behind corporate networks" is part of F-013's promise.)
4. **Dependencies.** Approve `ws`, `@types/ws` and direct use of `pg`, plus `https-proxy-agent` if spike 5 shows it's needed.
5. **ADR 0012's wording** on long-lived secrets, given the runner's identity key (§8).

### Unverified, listed together

- That uWebSockets.js bundles TypeScript types.
- That Buildkite's `StreamPings` is a server stream, not a bidirectional one.
- That Prisma Client has no LISTEN API.
- That Node's `proxyEnv` agent proxies `ws`'s upgrade request.
- What Bun honours for proxies and CAs.
- How monotonic clocks behave across sleep.
- The details of the GitHub certificate outage, which come from a secondary source.
- The capacity numbers: sockets per replica, and rows per second at 1,000 tasks. They are estimates until spike 5 measures them.
