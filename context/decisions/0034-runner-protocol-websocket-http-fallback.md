# The runner protocol: one session over WebSocket with an HTTP fallback, routed through Postgres

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Records the outcome of the Q22 study (`research/runner-transport.md`), and settles the HTTP fallback, the version window and the dependencies that the answers took from it. Covers F-013, F-045 and F-061. It carries the transport and wording parts of ADR 0012, which ADR 0029 supersedes, and amends ADR 0022.

The protocol is ostra's own: a session of numbered, acknowledged messages between the server and one peer, defined once as Zod schemas in the shared `protocol` package (ADR 0008). Messages are strict objects, discriminated on `type`, with branded IDs (`RunnerId`, `TaskId`, `SessionId`, `CommandId`). The server routes through Postgres. There's no broker and no Redis.

**Who connects.** A pool runner or a personal runner joins the server and receives dispatches. Inside a box, the sidecar connects to the server itself, with a short-lived token for that one task, tied to its lease (Q38, ADR 0029). Both speak this protocol. On the `host` executor the runner and the sidecar are one process.

**One session, two carriers:**
- **WebSocket**, the main carrier: one connection on port 443, through `ws`, with text frames, one JSON envelope per frame, and compression off. It's built in milestone 1.
- **HTTP**, the fallback: the same envelopes. `POST /runner/v1/up` takes a batch and returns acks. `GET /runner/v1/down?after=<seq>` holds for up to 25 s and returns commands, or 204. It's built with the fleet in milestone 5, and it's part of v1 (F-013).
- **Bulk data** stays off the session: session archives and files go over chunked, resumable HTTPS with a digest, through the server, so a runner needs one address only (ADR 0043). Frames are capped at 1 MiB *(working value)*.
- Any replica serves any request on either carrier. State lives in Postgres, so the load balancer needs no sticky sessions.

**Up, from peer to server: events**
- The peer numbers every event of a session and keeps it in a disk spool until the server acks it.
- The server saves each batch in one transaction, idempotent on `(session_id, seq)`. In the same transaction it advances the ingest cursor and enqueues reactions (ADR 0037). It acks only after the commit, which is ADR 0011's "saved before ostra acts on it".
- A batch that doesn't start at the cursor plus one gets `ack {resendFrom}`, so a gap can't be committed. After any drop, the peer resends from its first unacked event.
- Partial text isn't an event. It travels as unsequenced live frames, at most every 250 ms, and isn't spooled (ADR 0035).
- The spool has a quota of 1 GiB per runner *(working value)*. When it's full, the peer stops reading the agent's output, the agent blocks on its own pipe, and events are never dropped.

**Down, from server to peer: commands**
- A command is a row in a Postgres outbox table, numbered per runner and written in the same transaction as the change that caused it. The panel sends commands this way too, so it never talks to the core service directly (ADR 0016).
- The number comes from a counter on the runner's row, taken under its lock, so numbers are gap-free and in commit order. A global `bigserial` doesn't give that.
- Commands are dispatch, steer, interrupt, stop, an approval's answer, drain and update hints. They carry references, never secrets. Keys and tokens are fetched by a separate call after the server checks the lease epoch.
- The peer applies each command once by its `id`, acks the highest contiguous number, and on reconnect says which it applied last. A command past its `notAfter` is rejected, never applied late. The peer judges `notAfter` by server time, so a laptop's clock doesn't matter.
- A dispatch is an offer. The peer answers `accepted` or `rejected`. An offer not accepted in 2 minutes *(working value)* goes back to the queue. A pool runner in front of an autoscaling cluster must accept at once and report "waiting for a node", or the timeout fires while the cluster adds one.
- If a peer crashes between starting and finishing a steer, it reports `outcome-unknown`, and the panel shows that.

**Routing between replicas**
- A presence table records which replica holds which peer, with a connection epoch. A new connection evicts the old one, and the old replica closes its socket with `4409`.
- A command insert and a `NOTIFY` on one channel commit together. Every replica listens and ignores peers it doesn't hold. A sweep every 2 s *(working value)* catches any notification that was missed, so a lost notification costs up to 2 s and never a command.
- `NOTIFY` carries only commands, evictions and revocations: tens a second at 1,000 tasks. It never carries agent events. Committing a transaction that sends one takes a global lock, which limited a design with one notification per write to about 2.9K writes a second.
- Each replica holds one dedicated, direct `pg` connection for `LISTEN`, never through a pooler in transaction mode.
- A draining replica sends `goaway` in jittered waves. A connection older than 60 minutes *(working value)* is asked to reconnect, which spreads peers evenly after a scale-out.

**Liveness, leases and fencing (F-045).** All values are working values.

| Timer | Value | What happens |
|---|---|---|
| Server ping | every 20 s | Stays under nginx's 60 s idle close |
| Dead connection | no frame for 45 s | Either side closes, and the peer reconnects |
| Presence | one write per replica every 10 s | Constant load whatever the peer count |
| Panel shows offline | no presence for 45 s | |
| Task grace | 10 minutes without the peer | A timer stops the task cleanly, ready to reopen elsewhere |
| Self-fence | 9.5 minutes without the server | The peer stops its agents and keeps the workspace and branch |

Each dispatch raises the task's lease epoch, and the peer sends the epoch with every event, result and token request. After the task grace, the epoch it holds is stale: the server refuses its writes and won't mint it a token. So a laptop that sleeps through the grace period can't write afterwards. The server's refusal is the guarantee. The self-fence is a courtesy.

**Auth (Q48, Q94):**
- A personal runner signs in with a device code that the member approves in the browser (RFC 8628, through better-auth).
- A pool runner starts with its pool's join token and trades it for an identity: an Ed25519 key pair whose private half never leaves the runner.
- To connect, the runner posts a signed assertion and receives a 10-minute access token *(working value)*, which it sends at the WebSocket upgrade. The server caps a connection's age instead of re-checking the token. Revoking a runner sends `evict`, closes the socket with `4403`, and reconnecting fails.
- **A runner holds no long-lived credential for code or models.** Its identity key is long-lived, but it grants only the right to connect and receive what's dispatched to it. This replaces ADR 0012's "a runner holds no long-lived secrets".

**Versions (ADR 0022):**
- The URL carries the major, `/runner/v1/`. `hello` and `welcome` negotiate the minor.
- The server accepts a runner **one minor behind or ahead**, and a runner is **pinned to its server's version when it joins**: `ostra runner` reads `/runner/v1/info` and installs that version. A freshly installed runner is usually newer than its server, which ADR 0022 didn't cover.
- Each side keeps codecs for its own minor and the one before, and encodes down to the negotiated one, because ostra's schemas reject unknown fields. `hello` is the one message that tolerates them.
- A refused runner logs at error level with the fix, retries every 5 minutes, shows the reason in `ostra runner status`, and appears in the panel as outdated.

**Networks:**
- All traffic goes to `https://<server>/runner/v1/*` on 443, so one host is allow-listed.
- The runner honours `HTTPS_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS`. An answer that isn't an ostra envelope, such as a proxy's HTML page, is a network failure, and the runner says so.
- It falls back to HTTP when the upgrade gets a non-101 answer after TLS succeeded, when the socket dies within 10 s three times in a row, or when two heartbeat periods pass with no frames. It tries WebSocket again every 10 minutes. `--transport auto|websocket|http` overrides it.

## Considered options

- **Socket.IO.** Rejected: at-most-once by default, recovery lasts about two minutes in memory, its Postgres adapter has no recovery, and its fallback needs sticky sessions.
- **Connect-RPC streaming.** Rejected: bidirectional streams need HTTP/2 end to end, and its types come from protobuf, a second source of truth beside Zod.
- **NATS, Centrifugo or Rivet Actors.** Rejected: each adds a service and a second store to a Postgres-only install (ADR 0017), and an event saved there can't commit with a task change in Postgres. Centrifugo's own Postgres mode confirms the outbox design.
- **WebTransport.** Rejected: Node can't do it yet, and UDP is the first thing corporate networks block.
- **uWebSockets.js and `partysocket`.** Not needed. The first isn't on npm and covers only the server. The second buffers in memory without sequence numbers, which would compete with the spool.
- **SSE for the downlink.** Rejected for the fallback: a proxy that buffers holds the stream. A long poll returns a whole response, so buffering only adds latency. The POST-up, poll-down shape follows MCP's Streamable HTTP.
- **Polling only,** as GitHub Actions and Claude Code's self-hosted environments do. Kept as the fallback carrier, but a push path is needed for steers, which spike 6 holds to under 500 ms.
- **An advisory lock per runner,** as the ownership record. Rejected: the lock pool is shared and finite, and a presence row does the job.
- **Replica-to-replica forwarding and sticky routing.** Set aside: replicas would have to find and trust each other, and sticky routing doesn't help messages that start on the server.

## Consequences

- `ws` and `@types/ws` join the server and the runner, and `pg` is used directly for the listen connection. `https-proxy-agent` is added only if spike 6 needs it.
- Spike 6 (`runner-transport`) gates this, on Node only, on Windows, macOS and Linux. Its bars are in the build order: a connection or an automatic fallback through a CONNECT proxy, a TLS-inspecting proxy and nginx's defaults; every event stored once after `kill -9` and network cuts of 30 s, 5 min and 11 min; a steer in under 500 ms at p99 with two replicas; 2,000 connections on one replica; and 1,000 sessions on three replicas. If it fails, batch harder first, then weigh another WebSocket server.
- A compatibility matrix of runner N-1, N and N+1 against server N runs in CI, over recorded fixtures.
- Credit-based backpressure keeps server memory flat: a window of 256 frames or 4 MiB *(working value)*. Reconnects use full jitter from 1 s to 60 s.
- F-045 and F-047 apply to a box's sidecar as well as to a runner. A lost box is one more case of reopening on a fresh one.
- The self-hosting docs say to pass the WebSocket upgrade through, and to raise the idle timeout on a load balancer that closes WebSockets on its own schedule.
- The glossary gains **lease** (with its epoch) and **command**.
- ADR 0022's "one minor behind" becomes one behind or ahead, and F-061 follows.
- It's hard to reverse once runners are installed in the field, which is why it's an ADR.
