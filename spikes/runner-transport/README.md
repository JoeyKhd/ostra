# Spike 6: `runner-transport`

Throwaway code for milestone 0 (`context/build-order.md`). It answers one question, and its finding goes to `context/research/` only after the real runs below.

## The question

**Does the protocol lose nothing, through real networks, at the scale floor?**

**Tests the decisions:** ADR 0034 and `research/runner-transport.md`, Q18. F-045 and F-061 rest on it.

**Passes when** (on Node only, on Windows, macOS and Linux):

1. Through a CONNECT proxy, a TLS-inspecting proxy and nginx's defaults, the runner connects, or falls back to HTTP by itself within 30 s.
2. After `kill -9`, and after network cuts of 30 s, 5 min and 11 min, every event is stored exactly once. After 11 min the task stops cleanly and stale writes are refused.
3. With two core replicas, a steer reaches the runner in under 500 ms at p99, and in under 2.5 s with notifications off.
4. One replica holds 2,000 connections. Three replicas and one Postgres carry 1,000 sessions at the event rates spike 1 recorded.
5. A runner one minor older or newer works, or is refused with a clear message.
6. A laptop that sleeps through the grace period can't write afterwards.

**If it fails:** batch harder first. Then weigh another WebSocket server.

## Architecture

```
runner (src/runner) ──wss /runner/v1/connect──▶ LB / proxy / cut (src/harness) ──▶ core replica (src/server) ──▶ Postgres
   │ disk spool, state.json         fallback: POST /runner/v1/up + GET /runner/v1/down (25 s long poll)
   └ fake agent (deterministic events)                        replicas route commands via LISTEN/NOTIFY + a 2 s sweep
```

- **Protocol** (`src/protocol/`): Zod schemas both sides import. They're strict objects, except `hello`. The IDs are branded. Three made-up minors (1, 2, 3) differ by a field, so the version window has something to encode down. Close codes are 4400, 4401, 4403, 4409, 4426 and 4503.
- **Up** (events): the runner appends each event to a per-session segment spool before it sends it. The replica saves a batch in one transaction, idempotent on `(session_id, seq)`. It advances the ingest cursor in the same transaction and acks only after the commit. A batch that skips ahead gets `ack {resendFrom}`, and a batch from a stale lease epoch is refused and logged in `stale_refusal`. The send window is 256 frames.
- **Down** (commands): `enqueue_command()` takes the next number from the counter on the runner's row (gap-free, in commit order), inserts into the `runner_command` outbox and calls `pg_notify`, all in the caller's transaction. Each replica keeps one dedicated `LISTEN` connection, and a 2 s sweep catches missed notifications. The runner applies each command once by its id, records it as in flight before applying it (so a crash shows up as `outcome-unknown`), and judges `notAfter` by server time. A `command.ack` result moves a task only through the command row scoped to the calling runner.
- **Routing:** a `runner_presence` row with a connection epoch. A new connection sends `NOTIFY evict`, and the old replica closes with 4409. Each replica writes presence once every 10 s.
- **Liveness and fencing:** the server pings every 20 s, and 45 s without a frame counts as dead. After a 10 min grace, a sweep stops the task and raises its lease epoch, then sends a `stop` command. The runner self-fences at 9.5 min. The runner falls back to HTTP on a non-101 answer, on three quick deaths, or when no `welcome` comes within the 10 s handshake timeout after a 101, and tries WebSocket again every 10 min.
- **Proxies:** the runner uses Node 24's built-in `https.Agent({ proxyEnv })` for both the WebSocket upgrade and HTTP mode, so `HTTPS_PROXY`, `NO_PROXY`, credentials in the proxy URL and `NODE_EXTRA_CA_CERTS` work. `https-proxy-agent` wasn't needed.
- **Runner entries:** `src/runner/runner.ts` is the CLI, with no test hooks. `src/runner/runner-test.ts` is the harness's twin (it refuses to start without `OSTRA_SPIKE_TEST_HOOKS=1`): it adds `--self-fence=false`, `--crash-on-steer` and the `freeze` stdin command. Both share `run-runner.ts`. The replica's one test hook, `--lose-acks=N`, also needs `OSTRA_SPIKE_TEST_HOOKS=1`.
- **Harness** (`src/harness/`): it starts embedded-postgres (or uses `SPIKE_DATABASE_URL`), keeps every table in the schema `spike_runner_transport` (every pool and replica connection sets `search_path`), and drops only that schema. It makes per-run certificates with the openssl CLI, and deletes them and the Postgres data directory when the run ends; logs and `results.json` stay. Replicas, runners, load generators and nginx run as registered child processes. It also runs a TCP load balancer that cuts the network in two modes: `hold` (bytes and closes wait, new connections hang) and `reset` (the runner's side of every flow is reset, the server's side goes silent, new connections are reset until the cut ends). On top of that come a CONNECT proxy (with and without Basic auth), a TLS-inspecting proxy with its own CA (it passes WebSockets, blocks them with an HTML page, or answers 101 and then holds every frame), an emulation of nginx's defaults, and real nginx if `NGINX_BIN` is set. `kill -9` is `taskkill /T /F` on Windows and `SIGKILL` to the process group elsewhere. Every child exits when the harness does. `/metrics` on a replica needs the run's operator token.
- **Load generator** (`src/loadgen/`): runs thousands of full protocol peers in one process, each with an in-memory spool.

## How to run it

```sh
cd spikes/runner-transport
pnpm install
pnpm check:inputs      # which inputs are present; prints no values
pnpm typecheck && pnpm lint
pnpm spike             # every criterion it can run here, at real timings: about 11 to 12 min
pnpm spike:quick       # timers / 20, for development; timing bars then report SKIPPED
pnpm spike --only=networks,versions,kill9,acks,authz,steer,cuts,sleep,load
pnpm spike:full-load   # 2,000 connections, 1,000 sessions: for the Linux machine
```

Each run writes its logs and `results.json` to `.data/run-<time>/`, which is gitignored.

| Criterion | Inputs it needs |
|---|---|
| 1 networks | openssl CLI (Git for Windows ships it, or set `OPENSSL_BIN`); `NGINX_BIN` for real nginx |
| 2 kill -9, lost acks, cuts | nothing beyond openssl; the 11 min cut needs about 12 min of wall time |
| 3 steer | nothing |
| 4 load | the Linux machine for full scale. The rate comes from `OSTRA_SPIKE1_EVENTS_PER_MIN` (and `OSTRA_SPIKE1_BYTES_PER_EVENT`) if set, else from the highest rate in spike 1's `.runs/*/report.json`, else 120/min |
| 5 versions | nothing |
| 6 sleep | the simulation needs nothing; a real sleep needs a laptop runner and a server on another machine |
| all | macOS and Linux machines for those legs of the bar. `SPIKE_DATABASE_URL` is optional; the spike never reads `DATABASE_URL` |

## Status on this machine (2026-11-18)

The current code ran once at real timings: `.data/run-2026-11-18T17-36-21-838Z`, 11 min 26 s, exit code 0. Where a check is unchanged from the two earlier full runs (`run-2026-11-18T16-49-46-819Z` and `run-2026-11-18T17-04-08-385Z`), the table gives the range over the three. New checks have one run. The machine was Windows 11 with Node 24.14.0. Postgres was embedded-postgres 18 with `fsync` on. Other spikes were running on the same machine at the same time, so the timings include their contention.

**Every check that ran passed, except one that needs a decision** (criterion 2's "every event the agent produced" after 11 min, SKIPPED below). No criterion is PASS for the whole bar yet: the harness prints `PASS (Windows only; macOS, Linux not run)` where every check passed here.

| # | Harness result | Measured here | What keeps it from a full PASS |
|---|---|---|---|
| 1 | SKIPPED | Every proxy case connected or fell back in 0.2 s (3 runs), except the new one (1 run). The CONNECT proxy, the CONNECT proxy with Basic auth and the TLS-inspecting proxy that passes WebSockets stayed on WebSocket. The TLS proxy that blocks WebSockets logged `ws-upgrade-refused` (403, `proxyAnswered: true`). The nginx emulation logged `ws-upgrade-refused` (426 from the ostra server, `proxyAnswered: false`). Both then fell back to HTTP. New: a TLS proxy that answers 101 and then holds every frame. The runner logged `ws-silent-after-upgrade` and was on HTTP 10.2 s after it started. Every case stored all of its events exactly once, and its steer arrived | Real nginx needs `NGINX_BIN` (the emulation isn't the bar); macOS and Linux |
| 2 | SKIPPED | **kill -9** (3 runs): the runner was killed twice and restarted from its spool, then the replica holding it was killed. 548–572 events, all stored exactly once. **Lost acks** (new, 1 run): the replica committed a batch and then dropped the connection before the ack, 3 times per runner. Over WebSocket, 2,400 of 2,400 events were stored exactly once, and the server skipped 3 replayed events it already held. Over HTTP, 2,396 of 2,396, with 3 skipped. **30 s cut, flow reset** (new, 1 run): the runner logged `ws-closed`, reconnected 14.8 s after the cut ended, and stored 275 of 275 events. The steer sent during the cut arrived. **30 s cut, packets held** (3 runs): the WebSocket survived (TCP held it), and 203 of 203 events were stored. **5 min cut, held** (3 runs): the runner reconnected 4.7–34.0 s after the cut ended (full jitter, up to 60 s), and 1,574–1,719 events were all stored. **11 min cut, held** (3 runs): the runner self-fenced at 570.1–570.3 s. The server stopped the task at 600.8–601.0 s (`runner-lost`, epoch 2), and the runner acked the stop. 0 rows were stored after the stop, and 2,843–2,848 stale writes were refused: PASS. "Every event the agent produced is stored exactly once" is now checked against the runner's own last seq. In this run, 24 of the agent's 2,872 events were stored and the 2,848 it produced during the cut were refused, as ADR 0034 line 48 requires: SKIPPED, needs a decision (finding 1). Not the bar: a runner killed mid-steer reports `outcome-unknown` (3 runs). A runner that acks another runner's dispatch as `accepted` and its stop as `done` moves nothing: the victim's task stays `offered` (new, 1 run) | The 11 min decision; macOS and Linux |
| 3 | PASS (Windows only) | 2 replicas, 10 runners. With NOTIFY: 400 steers per run, p99 2–22 ms (3 runs), 0 lost. With notifications off: p99 1,966–2,001 ms (3 runs; 150 steers in the first two, 300 in this one), 0 lost. That leaves about 500 ms, or 20%, under the 2.5 s bar: the sweep is 2 s, so a loaded machine can eat it. A newer connection on the other replica evicted the old one with 4409 in 158–175 ms | macOS and Linux |
| 4 | SKIPPED | Scaled down. One replica held 1,000 connections for 50 s, none dropped (3 runs): RSS 152–156 MB, about 64–67 MB per 1,000 sockets, connect p99 5–259 ms. Three replicas and one Postgres carried 250 sessions at spike 1's rate (new, 1 run): 392 events/min per session at about 640 B each, from spike 1's `run-2026-11-18T16-58-09/report.json` (250,892 bytes/min on the model.env endpoint). 1,632 rows/s were stored for 1,633 offered. Ack p50 was 3 ms and p99 8 ms; ingest transaction p99 was 6–9 ms. After draining, 250 of 250 sessions were stored exactly once (115,964 events). At 1,000 sessions that rate is about 6,500 events/s, 4 times what this run stored, so the scaled run says nothing yet about the floor | Full scale (2,000 connections and 1,000 sessions) needs the Linux machine (`pnpm spike:full-load`) |
| 5 | PASS (Windows only) | Server minor 2 (3 runs). Runners at minors 1, 2 and 3 work over WebSocket, and minors 1 and 3 work over HTTP. The server stored `status` in exactly the negotiated minor's shape, which shows that encoding down works. Minors 0 and 4 were refused at error level with the supported range (1..3), the fix ("GET /runner/v1/info") and a 5 min retry. Caveat: the older and newer minors are simulated by starting the same build with `--minor`. That tests the negotiation, not a runner built one minor apart | macOS and Linux; a real build one minor apart |
| 6 | SKIPPED | Simulated (3 runs): the runner's event loop was frozen for 660 s with its self-fence off. The server stopped the task at 600.8–601.0 s. After waking, 11–19 writes were refused and 0 rows were stored after the stop. A steer sent during the sleep wasn't applied (`rejected expired`) | A real laptop sleep (below) |

The typecheck (`tsc` 6.0.3, with the strict flags AGENTS.md lists plus `erasableSyntaxOnly`) and the lint (`strict-type-checked` and `stylistic-type-checked`, with no `as` except `as const`) pass with no suppressions. Every `switch` over a union ends in `return x satisfies never`.

### Findings to carry into `research/` once the other platforms have run

1. **The bar contradicts itself after 11 minutes.** Per ADR 0034 line 48, a stale epoch's writes are refused. So the events the agent produced during the cut (2,848 at 5 events/s in this run) are never stored, even though the agent produced them while its lease was still valid. "Every event stored exactly once" holds after 11 min only for events the server received before the grace ran out. Either the bar should say so, or stale-epoch events should go into a quarantine table: they're inert history and trigger no reactions. That's for the maintainer to settle. The question still has to be added to `context/open-questions.md`; this spike writes only inside its own folder.
2. **Grace has to count from the last frame, not from when the server noticed.** At first, `disconnected_at` was set when the 45 s dead check fired. That pushed the grace stop to about 10m45s–11m05s into the cut, so it raced the 11 min reconnect. Setting it to the time of the last frame fixed it: the grace stop now lands at about 601 s, and the self-fence at 570 s comes first.
3. **"Two heartbeat periods with no frames → HTTP" misfires on a network cut, and is too slow for a proxy that holds frames.** As written, a 30 s cut would send the runner to HTTP for 10 minutes, and a proxy that answers 101 and then holds every frame would cost 40 s, past the 30 s bar. The spike applies the rule only between the 101 and the `welcome`, with the 10 s handshake timeout: the frame-holding proxy now costs 10.2 s. Once a connection has had a `welcome`, silence counts as a network failure, and the runner reconnects over WebSocket.
4. **`https-proxy-agent` isn't needed on Node.** `new https.Agent({ proxyEnv: process.env })` (Node 24.5+) carries `ws`'s upgrade and the HTTP fallback through a CONNECT proxy, with Basic credentials in the URL. `NODE_EXTRA_CA_CERTS` covers a TLS-inspecting proxy.
5. **A requested stop must not fence.** If the stopped state alone refused writes, the runner couldn't drain its spool after a requested stop. Only the epoch fences: a grace stop raises it, and a requested stop doesn't.
6. **Replays are skipped by the cursor.** After a kill -9, `hello` lists the open sessions and the server acks each one's cursor, so the survivors skipped 0 duplicates. When an ack is lost after the commit, the runner resends from its spool on the next `welcome`, and the server skips what's at or under the cursor (3 events per runner in this run). `ON CONFLICT DO NOTHING` stays as the backstop under the row lock.
7. **A command ack must be scoped to the runner that sends it.** The first version moved a task by command ID alone, so any runner that saw another's command ID in a log could start or stop that runner's task. The ack now updates only the caller's command row, and that row is the only source for the task update.

## What's left

- **macOS and Linux.** Run `pnpm spike` on both: the bar asks for all three platforms.
- **Real nginx.** Set `NGINX_BIN` to an nginx binary and run `pnpm spike --only=networks`. Then do a run behind squid, mitmproxy and a Cloudflare-proxied hostname (from the research's list), which this spike replaced with its own proxies.
- **Full load.** On the Linux machine, run `pnpm spike:full-load` (2,000 connections, then 1,000 sessions on three replicas at spike 1's 392 events/min). Also record Postgres CPU, which this harness doesn't measure.
- **A real laptop sleep.** Run a runner on a laptop (`node src/runner/runner.ts --runner=… --server=https://<server>:<port> --data=…`, with `OSTRA_RUNNER_TOKEN`) against replicas on another machine. Dispatch, sleep the laptop for 11 minutes, wake it, and check `stale_refusal`, `agent_event.received_at` against `task.stopped_at`, and whether `performance.now()` counted the sleep (macOS, Windows and Linux).
- **A runner built one minor apart**, instead of `--minor` on the same build.
- **Outside this folder**, for whoever may write there: add finding 1 to `context/open-questions.md` and rewrite bar bullet 2 once it's settled. Record the maintainer's approval of `embedded-postgres` (a beta, spike tooling only, shared by four spikes) in `docs/development.md`, or ask for it: no ADR or doc records it yet.
- **Not built here**, because the bar doesn't need them: Ed25519 identity and 10-minute tokens (the spike uses an HMAC bearer), `rpc`, unsequenced live frames, the 2-minute offer timeout, `goaway` waves and the maximum connection age, the 10-minute WebSocket retry under real conditions, fsync of the spool, and the spool quota under pressure.
- **Then:** write `context/research/runner-transport-spike.md` with the findings above, cited to the runs.

## Dependencies (exact pins)

| Package | Version | License | Why |
|---|---|---|---|
| `ws` | 8.23.0 | MIT | WebSocket server and client (ADR 0034, ADR 0007) |
| `pg` | 8.23.1 | MIT | Postgres, with the direct `LISTEN` connection (ADR 0034) |
| `zod` | 4.6.7 | MIT | The protocol schemas and every boundary |
| `embedded-postgres` | 18.6.0-beta.19 | MIT (bundles PostgreSQL, PostgreSQL License) | A real Postgres here, with no Docker. Spike tooling only; allowed by this spike's task brief, but its approval isn't recorded in a repo doc yet (see "What's left") |
| `typescript` | 6.0.3 | Apache-2.0 | Typecheck (dev) |
| `@types/node` | 24.19.2 | MIT | dev |
| `@types/pg` | 8.23.1 | MIT | dev |
| `@types/ws` | 8.18.2 | MIT | dev |
| `eslint` | 10.15.0 | MIT | Lint (dev, ADR 0007) |
| `typescript-eslint` | 8.73.0 | MIT | `strict-type-checked` and `stylistic-type-checked` (dev) |
| `@eslint/js` | 10.0.1 | MIT | dev |

Tools, not packages: the openssl CLI (Apache-2.0) and, optionally, nginx (BSD-2-Clause).
