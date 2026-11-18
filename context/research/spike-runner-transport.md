# Research: Spike 6, `runner-transport`: does the runner protocol lose nothing, through real networks, at the scale floor?

**Status:** Research, 2026-11-18. Feeds ADR 0034 (the runner protocol), ADR 0022 (versions), ADR 0046 (Node only), Q18 (scale target), F-013, F-045, F-061 and F-117, and the study the spike tests, `research/runner-transport.md`.
**Method:**
- I ran `pnpm spike` once in `spikes/runner-transport/` on 2026-11-18, on Windows 11 with Node 24.14.0 and pnpm 11.28.2. From the harness's start to its results file took 11 min 21 s (17:51:07Z to 18:02:28Z), and it exited 0 (the harness returns 1 only if a criterion FAILs, `SPIKE/src/harness/spike.ts:152`, and none did). Every result marked "run" comes from that one run.
- Other spikes' Node and Postgres processes were on the same machine before and after the run (I listed the processes both times). Treat the timings as contended.
- After the run, no process of the spike was left. The harness kills its children at the end (`SPIKE/src/harness/spike.ts:153-157`), and I searched every process for the spike's path and found none. I killed nothing else. The Node and Postgres processes still running belong to other spikes and to tools.
- I read the spike's code as it stands in the working tree. `git diff HEAD -- spikes/runner-transport` shows no change (checked after the run; HEAD was `7a2d2b2`, and the spike was committed in `5e7a371`, "add spike 6: runner transport"). No file under `SPIKE/src` was modified after 18:33 local time (17:33Z) and the run began at 17:51Z, so the code that ran is the committed code. `tsc --noEmit -p tsconfig.json` also passes when re-run on it.
- I read the official docs of Node, `ws`, nginx, PostgreSQL, RFC 6455 and Microsoft's `taskkill` on 2026-11-18. I read the `ws` docs at the 8.18.2 tag and at 8.23.0, the spike's pin. The sentence cited below is the same in both.
- Anything from the README that I didn't rerun is marked "README, not rerun". Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a primary source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/runner-transport`. A cite like `SPIKE/src/server/replica.ts:290-360` is a file and its lines.
- `RUN` means the output of today's `pnpm spike`, cited by check name. Its structured copy is `SPIKE/.data/run-2026-11-18T17-51-07-425Z/results.json`, and the logs of every replica, runner and load generator are in `.../logs/` beside it. `.gitignore` excludes `.data/` (`SPIKE/.gitignore:2`), so they stay on this machine.
- `PASSBAR` means the spike's pass bar, `context/build-order.md:139-149`. `ADR34` means `context/decisions/0034-runner-protocol-websocket-http-fallback.md`. `STUDY` means `context/research/runner-transport.md`. `README` means `SPIKE/README.md`.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| Node | 24.14.0 | MIT | The spike requires `>=24.14.0`. The repo root requires only `>=24.2` | `SPIKE/package.json:7-9`; `package.json:8-10`; RUN header |
| `ws` | 8.23.0, exact pin | MIT | npm `latest` is 8.23.0 | `SPIKE/package.json:21`; `npm view ws dist-tags` |
| `pg` | 8.23.1, exact pin | MIT | the direct `LISTEN` connection | `SPIKE/package.json:20`; `npm view pg@8.23.1 license` |
| `zod` | 4.6.7, exact pin | MIT | the protocol schemas | `SPIKE/package.json:22` |
| `embedded-postgres` | 18.6.0-beta.19, exact pin | MIT | A beta. Spike tooling only. No doc records its approval (see section 4) | `SPIKE/package.json:19`; `npm view embedded-postgres@18.6.0-beta.19 license`; a search of `docs/development.md` finds no mention |
| TypeScript | 6.0.3 | Apache-2.0 | `pnpm spike` runs `tsc --noEmit` first and goes on only if it passes. The run went on, and `tsc --noEmit` also passes when re-run after it | `SPIKE/package.json:14,30`; the run's `results.json` exists |

---

## 1. The question, and the answer

**Question.** Does the protocol lose nothing, through real networks, at the scale floor? It tests ADR 0034, `research/runner-transport.md` and Q18, and F-045 and F-061 rest on it (`PASSBAR`; `SPIKE/README.md:5-9`).

**Answer.** On one Windows machine every event the agent produced was stored exactly once in every case that ran, except the 11 min cut, where 2,848 of 2,872 events were refused by design (below). The bar isn't fully answered. The harness's 35 checks came out 30 PASS, 5 SKIPPED and 0 FAIL (RUN, my count of its rows). Events were stored exactly once after `kill -9` of the runner and of the replica holding it, after a committed batch whose ack was lost, after a flow reset, and after held cuts of 30 s and 5 min. The task stopped cleanly after an 11 min cut, and its stale writes were refused. A steer reached its runner at p99 3.6 ms with notifications and 1,966 ms with the 2 s sweep alone. Runners one minor older or newer worked, and runners two away were refused with the fix. Four of the six criteria are SKIPPED, because a check needs something this machine doesn't have (real nginx, the Linux machine, a laptop that really sleeps) or a maintainer's decision. Two are PASS on Windows only. One decision is open: after the 11 min cut, only 24 of the 2,872 events the agent produced are stored. The refusal that ADR 0034 requires discarded the rest, so the bar's "every event stored exactly once" contradicts the ADR. Reading the code also turned up one hole in the fence: ingest takes no lock on the task row (section 3, gotcha 9). The scale floor wasn't reached: 250 sessions ran, and the bar's 1,000 would be about four times the event rate.

---

## 2. Results per pass-bar criterion

`PASSBAR` has six bullets. The harness runs them as criteria, and a criterion is SKIPPED if any of its checks is SKIPPED, FAIL if any failed, and PASS only if all passed (`SPIKE/src/harness/report.ts:32-43`). A PASS on fewer than three platforms says so in its label (`report.ts:39-42`). "PASS (Windows only)" below means every check that ran here passed. It isn't a pass of the bar, which asks for Windows, macOS and Linux.

| # | Criterion | Result | What keeps it from a full PASS |
|---|---|---|---|
| 1 | Through a CONNECT proxy, a TLS-inspecting proxy and nginx's defaults, connect or fall back within 30 s | **SKIPPED** | Real nginx wasn't run; the harness's emulation isn't the bar. Windows only |
| 2 | Exactly once after `kill -9` and cuts of 30 s, 5 min and 11 min; the task stops and stale writes are refused after 11 min | **SKIPPED** | One check needs a maintainer's decision (surprise 1). Windows only |
| 3 | A steer in under 500 ms at p99 with two replicas, under 2.5 s with notifications off | **PASS** (Windows only) | macOS and Linux not run |
| 4 | 2,000 connections on one replica; 1,000 sessions on three replicas and one Postgres | **SKIPPED** | Ran at 1,000 connections and 250 sessions; full scale needs the Linux machine |
| 5 | A runner one minor older or newer works, or is refused clearly | **PASS** (Windows only) | The minors are simulated; macOS and Linux not run |
| 6 | A laptop that sleeps through the grace period can't write afterwards | **SKIPPED** | The simulation passed; a real sleep needs a laptop and a second machine |

Source for every result and label: RUN, the block of that criterion (`SPIKE/src/harness/spike.ts:124-143`).

### 2.1 Networks: SKIPPED

The harness starts one runner per network and checks that it connects (or falls back) within 30 s, stores all its events exactly once, and receives a steer (`SPIKE/src/harness/scenarios/networks.ts:150-155`).

| Case | Result (RUN) |
|---|---|
| Direct, no proxy [not the bar] | PASS: WebSocket in 0.2 s; 34/34 stored; steer received |
| CONNECT proxy | PASS: WebSocket in 0.2 s; the proxy saw 1 tunnel; 34/34 stored |
| CONNECT proxy, Basic auth in `HTTPS_PROXY` | PASS: WebSocket in 0.2 s; 1 tunnel; 34/34 stored |
| TLS-inspecting proxy that passes WebSockets, own CA through `NODE_EXTRA_CA_CERTS` | PASS: WebSocket in 0.2 s; the proxy read 1 request in clear; 34/34 stored |
| TLS-inspecting proxy that blocks WebSockets with an HTML page | PASS: HTTP in 0.2 s after falling back by itself (`ws-upgrade-refused`, 403, a proxy answered); 34/34 stored |
| TLS-inspecting proxy that accepts the upgrade and holds every frame | PASS: HTTP in 10.2 s after falling back by itself (`ws-silent-after-upgrade`); the proxy swallowed 233 bytes after the 101; 34/34 stored |
| nginx's defaults, emulated [not the bar] | PASS: HTTP in 0.2 s (`ws-upgrade-refused`, 426, the ostra server answered); 34/34 stored |
| Real nginx with its defaults | **SKIPPED**: needs `NGINX_BIN` |

- Every case that ran stored all 34 events exactly once and received its steer (RUN, each row). The slowest was 10.2 s, inside the 30 s bar. The logs show the order for that case: `ws-silent-after-upgrade` at 10.0 s, then `fallback-http` with reason `silent`, then a `welcome` over HTTP 8 ms later (`.../logs/runner-net-n-6.log`).
- The runner carries both carriers through one `https.Agent({ proxyEnv })` each (`SPIKE/src/runner/peer.ts:133-135`). No `https-proxy-agent` was needed on Node.
- The CONNECT proxy (with and without Basic auth), the TLS-inspecting proxy (in three modes) and the nginx emulation are the harness's own code (`SPIKE/src/harness/net-proxies.ts:207-260,267-392,406-483`). `STUDY` asked for squid, squid with auth, mitmproxy, nginx and a Cloudflare-proxied hostname (`STUDY:713-720`). None of those ran.
- Real nginx is wired in but needs a binary (`networks.ts:42,101-105`; `net-proxies.ts:500-547`).
- A non-101 answer is a failed handshake in the protocol itself ([RFC 6455 section 4.1](https://www.rfc-editor.org/rfc/rfc6455): "If the status code received from the server is not 101, the client handles the response per HTTP [RFC2616] procedures."). The `ws` client reports it as the `unexpected-response` event ([ws docs](https://github.com/websockets/ws/blob/8.18.2/doc/ws.md): "Emitted when the server response is not the expected one, for example a 401 response."), which the runner turns into the fallback (`peer.ts:452-468,759-767`).

### 2.2 Loss: SKIPPED

Nine checks passed, and one check is SKIPPED for a decision. Each event is a pure function of its session and number, so the harness checks every stored row against what the agent produced (`SPIKE/src/shared/fake-event.ts:4-8`; `SPIKE/src/harness/cluster.ts:329-345`). "Stored" below means: all events present, none doubled, none missing, bodies intact.

| Case | Result (RUN) |
|---|---|
| `kill -9` of the runner twice (restarted from its spool), then of the replica holding it | PASS: 570/570 stored; 0 replays skipped as duplicates |
| A batch committed, its ack lost 3 times, over WebSocket | PASS: 3 acks lost after commit; the runner reconnected 3 times; the server skipped 3 replayed events; 2,397/2,397 stored |
| The same over HTTP | PASS: 3 lost; 3 skipped; 2,396/2,396 stored |
| Cut of 30 s, flow reset (simulated: the harness's proxy resets the runner's side of every flow, as a NAT rebind or a Wi-Fi roam would) | PASS: `ws-closed` once; reconnected 14.9 s after the cut ended; 275/275 stored; the steer sent mid-cut arrived; epoch still 1 |
| Cut of 30 s, packets held | PASS: the WebSocket survived (TCP held it); 203/203 stored; the steer arrived |
| Cut of 5 min, packets held | PASS: the runner closed the dead socket at 45 s, reconnected 5 ms after the cut ended; 1,551/1,551 stored; the steer arrived; epoch still 1 |
| Cut of 11 min, packets held: the task stops, stale writes are refused | PASS: self-fenced at 570.1 s; the server stopped the task at 600.9 s (`runner-lost`, epoch 2); the runner acked the stop; 0 rows stored after the stop; 2,848 stale writes refused; 24/24 stored before the stop |
| The same cut: every event the agent produced is stored exactly once | **SKIPPED**: 24 of 2,872 stored; the 2,848 produced during the cut were refused under the stale epoch |
| A runner that acks another runner's commands [not the bar] | PASS: the victim's task stays `offered`; the replica logged 2 acks it couldn't match to the caller |
| A runner killed mid-steer reports `outcome-unknown` [not the bar] | PASS: the steer's result is `outcome-unknown`; 25/25 stored |

Source for the rows: RUN, the check named in each row; `SPIKE/src/harness/scenarios/kill9.ts:27-102`, `acks.ts:14-57`, `cuts.ts:54-180`, `authz.ts:57-93`.

- **The cuts are simulated.** The harness's own TCP proxy makes them, on loopback, in two modes: `hold` (bytes and closes wait, new connections hang) and `reset` (the runner's side of every flow is reset, the server's side goes silent) (`SPIKE/src/harness/net-proxies.ts:39-47`). A real network failure, NAT rebind or Wi-Fi roam hasn't run.
- **Exactly once holds through process death and lost acks.** The runner writes each event to its spool before sending, and the server saves a batch in one transaction and acks after the commit (`SPIKE/src/runner/peer.ts:156-159`; `SPIKE/src/server/replica.ts:290-360`). A restarted runner carries on from its spool (`peer.ts:199-203`). In the kill row, the replicas' counters at the end showed 0 replayed events skipped as duplicates (RUN, kill row). That count is weak evidence: the killed replica's counters died with it, and the check doesn't aim a kill at a batch that is committed but not yet acked. The lost-ack rows do aim at that case: the runner resends from its spool, and the server skips what is at or under the cursor (`replica.ts:334`; RUN, the two lost-ack rows). `hello` also returns each open session's cursor as an ack (`replica.ts:259-269`), but the runner's `welcome` handler calls `flush()` before it handles that ack (`peer.ts:372-377`), so the ack doesn't stop a replay (inferred from the code; not run on its own). The server's skip is what keeps it exactly once.
- **Cuts under the grace lose nothing.** The 30 s held cut is shorter than the 45 s dead check, so the socket survived. In the 5 min cut, the runner gave up the socket after 45 s of silence (`ws-dead`, 45,131 ms; `.../logs/runner-cut-2.log`; `peer.ts:445-450`). The replica did so 9.6 s later, at its next 20 s ping tick (`peer-dead` in `.../logs/replica-c.log`; `replica.ts:589-601`). The runner never fell back to HTTP in any cut: no cut log contains `fallback-http` (a search of `.../logs/runner-cut-*.log`).
- **After the grace, the fence held.** The runner self-fenced at 570.1 s and the server stopped the task at 600.9 s, so the courtesy came first (`cuts.ts:139-140`; `SPIKE/src/protocol/timers.ts:14,16`). The runner then connected 8.9 s after the cut ended and got `stale-lease-refused` with 2,848 unacked events (`.../logs/runner-cut-3.log`; RUN, 11 min row). No row was stored after the stop.
- **The SKIPPED check is a decision, not a bug.** The harness keeps it SKIPPED on purpose and says so (`cuts.ts:149-158`). Surprise 1 in section 3 explains it.
- **Kill on Windows.** The harness's `kill -9` is `taskkill /PID /T /F` (`SPIKE/src/harness/procs.ts:30-47`). Microsoft documents `/f` as "forcefully ended" and `/t` as ending "the specified process and any child processes started by it" ([taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)). Node maps `SIGKILL` on Windows to "unconditional termination" ([process docs](https://nodejs.org/api/process.html)). Both are abrupt: the runner can't run its exit handlers (inferred). A kill on Linux and macOS has not run.

### 2.3 Steer latency: PASS (Windows only)

| Check (RUN) | Result |
|---|---|
| p99 under 500 ms with NOTIFY (two replicas, 10 runners) | PASS: 400 steers; p50 2.5 ms, p95 3.0 ms, p99 3.6 ms, max 5.4 ms; 0 lost; 800 notifications received across the replicas |
| p99 under 2.5 s with notifications off | PASS: 300 steers; p50 913.9 ms, p95 1,889.9 ms, p99 1,966.2 ms, max 1,993.9 ms; 0 lost |
| A newer connection on the other replica evicts the old one with 4409 [not the bar] | PASS: closed 161 ms after the new one started |

Source: RUN rows and `results.json`; `SPIKE/src/harness/scenarios/steer.ts:16-102`.

- **How it's measured.** The harness plays the panel. It calls `enqueue_command()` from its own Postgres connection and times the call until the runner logs the steer (`steer.ts:11-15`; `SPIKE/src/harness/cluster.ts:279-293`). The clock is `performance.timeOrigin + performance.now()`, comparable across processes on one machine (`SPIKE/src/shared/stats.ts:21-22`).
- **"Notifications off" means the sender doesn't call `pg_notify`.** The function takes a flag (`SPIKE/src/server/schema.ts:94-96`). The replicas still hold their `LISTEN` connections, so this tests the 2 s sweep path (`replica.ts:537-554`; `timers.ts:18`).
- **The margin is thin without notifications.** The p99 is 534 ms, or 21%, under the bar, because the sweep itself is 2 s. A loaded machine can eat that. The README's three earlier runs gave 1,966 to 2,001 ms (README, not rerun: `SPIKE/README.md:75`).
- **Everything ran on loopback, on one machine.** There is no network round trip in these numbers. The 500 ms bar is about 140 times the 3.6 ms measured, so a real network's round trips have room, but they are not in these numbers.
- Postgres says a `NOTIFY` inside a transaction is delivered only when the transaction commits ([NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html): "the notify events are not delivered until and unless the transaction is committed"). That is what makes the command row and its wake-up arrive together.

### 2.4 Scale: SKIPPED

The harness ran a scaled-down version and labels both PASS rows "[scaled down, not the bar]" (`SPIKE/src/harness/scenarios/load.ts:67-68,76,94,156`).

| Check (RUN) | Result |
|---|---|
| One replica holds 1,000 connections for 50 s [scaled down] | PASS: 1,000/1,000 connected, 0 dropped; the replica saw 1,000 sockets; RSS 153.2 MiB, about 64.7 MiB per 1,000 sockets (the harness prints "MB"); connect p99 6 ms |
| Three replicas and one Postgres carry 250 sessions at 392 events/min and about 640 B each [scaled down] | PASS: 1,632 rows/s stored for 1,633 offered; ack p50 3 ms, p99 19 ms; 0.1 notifications/s; ingest transaction p99 25, 24 and 23 ms per replica; after the drain, 250/250 sessions exactly once (115,962 of 115,962 events) |
| One replica holds 2,000 connections | **SKIPPED**: needs the Linux machine (`pnpm spike:full-load`) |
| Three replicas and one Postgres carry 1,000 sessions at spike 1's rates | **SKIPPED**: needs the Linux machine |

- **Where the rate comes from.** The harness reads the highest rate in spike 1's `.runs/run-*/report.json` (`SPIKE/src/harness/spike1-rate.ts:36-69`). Its note in RUN and in `results.json` names `run-2026-11-18T16-58-09/report.json` and gives 392 events/min and about 640 B each (250,892 bytes/min). **Unverified: that file is no longer on this machine.** Spike 1's `.runs/` now holds only later runs, and the only `recorded` rate in it is 35 events/min and 22,167 bytes/min (`run-2026-11-18T17-03-58-5f02/report.json`, keys "events per minute (model.env endpoint)" and "bytes per minute (model.env endpoint, whole session)"). So the 392 figure is the harness's own printed value, and it can't be re-derived from spike 1's files today. Spike 1 isn't finished (its folder is untracked in git status), so the figure may move again.
- **What the floor needs.** 1,000 sessions at 392 events/min is 1,000 x 392 / 60, about 6,500 events/s, four times what this run offered (1,633/s). The scaled run says nothing yet about the floor.
- **The 1 s ack bar is the spike's own.** `PASSBAR` gives no ack latency. The check uses p99 under 1 s and calls it "my working value" (`load.ts:153,158`). The check also requires 95% of the offered rate to be stored (`load.ts:153`).
- **Memory.** The replica's RSS grew from 92,827,648 to 160,661,504 bytes with 1,000 sockets (`results.json`, `rssBefore` and `rssAfter`). The harness divides by 1,048,576 and prints "MB", so its 153.2 MB and 64.7 MB per 1,000 sockets are MiB (`load.ts:63,90`). At that rate 2,000 sockets would take about 130 MiB over the idle baseline (inferred, a straight line).
- **Postgres CPU isn't measured.** The harness has no probe for it (README, not rerun: `SPIKE/README.md:96`), and `PASSBAR` is silent on it, though the spike 7 bar names "Postgres under 50% of 4 vCPU" (`context/build-order.md:155`).

### 2.5 Versions: PASS (Windows only)

The server runs at minor 2. Eight runners were started with `--minor` set (`SPIKE/src/harness/scenarios/versions.ts:18-27`).

| Runner minor | Carrier | Result (RUN) |
|---|---|---|
| 1 | WebSocket | PASS: negotiated minor 1; 20/20 stored; steer received; status stored as `[capacity, running, type]` |
| 2 | WebSocket | PASS: negotiated 2; 19/19 stored; status stored with `labels` |
| 3 | WebSocket | PASS: negotiated 2; 20/20 stored; status stored with `labels`, never with `spoolBytes` |
| 1 | HTTP | PASS: negotiated 1; 20/20 stored |
| 3 | HTTP | PASS: negotiated 2; 20/20 stored |
| 0 | WebSocket | PASS: refused at error level, server 2 accepts 1..3, with the fix, retry in 300,000 ms |
| 4 | WebSocket | PASS: the same refusal |
| 4 | HTTP | PASS: the same refusal |

- **Encoding down works.** The server stored `status` in exactly the negotiated minor's shape, so the codecs that ADR 0034 asks for do their job (`SPIKE/src/protocol/messages.ts:144-162,244-258`; `ADR34:59`; RUN, minor rows).
- **The refusal names the fix.** The message says the supported range and "install the runner version this server pins (GET /runner/v1/info), then restart the runner" (`replica.ts:223-239`; `peer.ts:741-753`). That covers the error-level log, the fix and the 5 minute retry of `ADR34:60`. `ostra runner status` and the panel's "outdated" mark aren't built in the spike.
- **The harness's own caveat holds.** Older and newer minors are simulated by starting the same build with `--minor` (`spike.ts:140`). The three minors are made up for the spike: minor 2 adds `maxConnectionAgeMs` (down) and `labels` (up) to minor 1, and minor 3 adds `serverFeatures` (down) and `spoolBytes` (up) (`messages.ts:8-11`). This tests the negotiation, not a runner built one minor apart.
- Minors 0 and 4 can only ever send `hello` (`messages.ts:24-25`).

### 2.6 Laptop sleep: SKIPPED

| Check (RUN) | Result |
|---|---|
| A runner asleep for the grace plus 1 min (660 s), self-fence off, simulated by freezing its event loop | PASS: the server stopped the task 600.9 s into the sleep (epoch 2); after waking, 18 event writes were refused and 0 rows stored after the stop; the steer sent during the sleep was not applied (`rejected`, `expired`) |
| A real laptop sleep | **SKIPPED**: needs a laptop runner put to sleep by hand against a server on another machine |

- **The simulation.** The harness blocks the runner's event loop with `Atomics.wait` for 660 s, with its self-fence off, so the server's refusal has to hold alone (`SPIKE/src/runner/runner-test.ts:39-43`; `SPIKE/src/harness/scenarios/sleep.ts:17-34`).
- **What the log shows.** The runner thawed, found its socket dead (`ws-dead`, 660,016 ms of silence), and had a `welcome` 0.9 s later. It then expired the steer by server time (`command-expired`), applied the stop (`runner-lost`) and got `stale-lease-refused` for 18 unacked events (`.../logs/runner-sleeper.log`). The grace sweep that stopped the task is in `replica-c.log` (`task-stopped-grace`, 2 entries: this and the 11 min cut).
- **Why it stays SKIPPED.** In the freeze, `performance.now()` counted all 660 s, so the runner noticed the dead socket on its first tick. Whether the clock counts a real suspend differs by OS, and `STUDY` marked it unverified (`STUDY:584`). Only a real sleep answers it (README, not rerun: `SPIKE/README.md:97`).

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **The bar contradicts ADR 0034 after 11 minutes.**
   - `PASSBAR` says every event is stored exactly once, and also that stale writes are refused (`context/build-order.md:144`). ADR 0034 says that after the grace "the epoch it holds is stale: the server refuses its writes" (`ADR34:48`). F-045 says the same: "writes from their old lease are refused" (`context/features.md:221`).
   - Both can't hold for events the agent produced during the cut. RUN: 2,872 produced, 24 stored, 2,848 refused.
   - All 2,848 were produced under a lease the server still held. The runner's generator stops at the self-fence (`peer.ts:724-729`), at 570.1 s, and the server's grace stop came at 600.9 s (RUN, 11 min row). So every refused event predates the stop. The runner log says `unacked: 2848` at the refusal (`.../logs/runner-cut-3.log`).
   - The cost is the transcript of up to 9.5 minutes of agent work (`timers.ts:16`). The runner keeps the workspace and branch (`ADR34:46`), so the work itself survives.
   - Two ways out. Keep the refusal and reword the bar. Or keep stale-epoch events in an inert quarantine table that triggers no reaction (`cuts.ts:156-157`; README, not rerun: `SPIKE/README.md:84`). That is for the maintainer.

2. **Grace has to count from the last frame, not from when the server noticed.**
   - The replica sets `disconnected_at` to the time of the peer's last frame (`replica.ts:749-756`), and the grace sweep reads `coalesce(disconnected_at, last_seen_at, created_at)` (`replica.ts:606-614`).
   - README, not rerun: the first version used the time of the 45 s dead check, which pushed the stop to about 10m45s to 11m05s and raced the 11 min reconnect (`SPIKE/README.md:85`).
   - RUN shows the fixed result: stop at 600.9 s, 0.9 s after the 600 s grace.

3. **The ADR's "two heartbeat periods with no frames, then HTTP" rule misfires on a cut.**
   - `ADR34:65` and `STUDY:682` list it as a fallback trigger. In the 5 min and 11 min cuts the runner saw 45 s of silence and reconnected over WebSocket, 7 and 16 failed attempts in all, with no fallback (`.../logs/runner-cut-2.log`, `runner-cut-3.log`).
   - The spike applies the rule only between the 101 and the `welcome`, with the 10 s handshake timeout (`peer.ts:482-489,782-788`; `timers.ts:32`). That is what caught the proxy that answers 101 and holds every frame, in 10.2 s (RUN, networks).
   - As written, the rule would send a runner to HTTP for 10 minutes after a 30 s cut, and a frame-holding proxy would cost 40 s, past the 30 s of F-013 (README, not rerun: `SPIKE/README.md:86`).

4. **Node's built-in proxy support replaced `https-proxy-agent`, but it is young.**
   - `new https.Agent({ proxyEnv })` carried the WebSocket upgrade and the HTTP fallback through a CONNECT proxy, with Basic credentials in the URL (`peer.ts:133-135`; RUN, networks).
   - The Node docs list `proxyEnv` as added in v24.5.0 and v22.21.0, and the built-in proxy support as "Stability: 1.1 - Active development" ([Node http](https://nodejs.org/api/http.html)). They document credentials in proxy URLs, such as `http://username:password@proxy.example.com:8080`, and `NO_PROXY` patterns.
   - The repo root allows Node `>=24.2` (`package.json:9`), and ADR 0046 says the runner "runs on Node LTS" (`context/decisions/0046-one-cli-and-three-images.md:9`). Node 24.2 to 24.4 and Node 22 before 22.21 lack `proxyEnv` (from the Node docs above).

5. **A TLS-inspecting proxy's CA must be set before the runner starts.**
   - The runner passed through the inspecting proxy with `NODE_EXTRA_CA_CERTS` in its environment (`SPIKE/src/harness/cluster.ts:172-177`; RUN, TLS-inspecting row).
   - Node reads the variable only at launch: "Changing the value at runtime using `process.env.NODE_EXTRA_CA_CERTS` has no effect on the current process" ([Node cli](https://nodejs.org/api/cli.html)). So a `--ca-file` flag on `ostra runner` would have to re-launch the process, or the docs must say to set the variable in the service's environment.

6. **A requested stop must not fence.**
   - Only the lease epoch refuses writes. A stop that members request keeps its epoch, so the runner can still drain its spool afterwards (`replica.ts:304-305`). A grace stop raises the epoch (`replica.ts:620-624`).
   - README, not rerun: if the stopped state alone refused writes, the runner couldn't drain after a stop (`SPIKE/README.md:88`).

7. **A command ack must be scoped to the runner that sends it.**
   - The ack updates only the caller's command row, and that row is the only source for the task update (`replica.ts:371-377`).
   - RUN, authz row: a runner that acked another runner's dispatch as `accepted` and its stop as `done` moved nothing; the victim's task stayed `offered`.
   - README, not rerun: the first version moved a task by command ID alone (`SPIKE/README.md:90`).

8. **Reconnect after a long cut isn't prompt.**
   - After the cut ended, the runner reconnected 5 ms later (5 min), 8.9 s later (11 min) and 14.9 s later (30 s, flow reset) (`results.json`, `reconnectMs`). The README's three earlier runs gave 4.7 to 34.0 s for the 5 min cut (README, not rerun: `SPIKE/README.md:74`).
   - The cause is where the runner is in its backoff. It uses full jitter up to 60 s (`timers.ts:26,69-72`), and each failed attempt can wait out a 10 s handshake (`timers.ts:32`). So a runner can take about a minute to return after the network does (inferred).
   - That matters near the grace. A cut shorter than the 10 minute grace can still stop the task, if the runner is in a long backoff when the network returns (inferred).

**Gotchas**

9. **The fence has no lock on the task row (inferred; not run).**
   - Ingest reads the task's epoch in a statement that locks only the session row: `FOR UPDATE OF s` (`replica.ts:294-297`). The grace sweep locks the task row and raises the epoch: `FOR UPDATE OF t SKIP LOCKED` (`replica.ts:606-614,620-624`). Neither blocks the other.
   - Postgres says that with a named table, "only rows coming from those tables are locked; any other tables used in the SELECT are simply read as usual" ([SELECT](https://www.postgresql.org/docs/current/sql-select.html)). Under Read Committed, a `SELECT` "sees only data committed before the query began" and "never sees ... changes committed by concurrent transactions during the query's execution" ([isolation levels](https://www.postgresql.org/docs/current/transaction-iso.html)). "Read Committed is the default isolation level in PostgreSQL" (same page), and `withTx` sets no other (`replica.ts:192-205`).
   - So a batch can read epoch 1 just before the sweep commits epoch 2, then insert and commit after it. The row would carry epoch 1 and a `received_at` after `stopped_at`.
   - The window is one ingest transaction: p99 23 to 25 ms in the load run (RUN, 250 sessions row), 6 to 9 ms in the README's runs (README, not rerun: `SPIKE/README.md:76`). It needs a runner to write at the very edge of the grace.
   - Today's runs never hit it: 0 rows after the stop in the 11 min cut and in the sleep test (RUN). They didn't aim at it.
   - The row lock to try is a share lock on the task row in the same statement. The sweep's `SKIP LOCKED` would then skip that task for one 2 s tick. I haven't tried it.

10. **"nginx's defaults" is a moving target, and the emulation is one version of it.**
    - nginx doesn't pass `Upgrade` to the proxied server: "since the 'Upgrade' is a hop-by-hop header, it is not passed from a client to proxied server" ([nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html)). A proxied WebSocket closes after 60 s without data, unless `proxy_read_timeout` is raised (same page). The 20 s ping covers that (`timers.ts:6`).
    - The emulation proxies with HTTP/1.0 (`net-proxies.ts:401-405`). nginx's docs say the default changed: "Since 1.29.7, version 1.1 is used by default. Before 1.29.7, version 1.0 was used by default" ([proxy_http_version](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)).
    - The version shouldn't matter to the result, because the missing `Upgrade` is what makes the ostra server answer 426 (`replica.ts:856-860`), and the runner falls back on any non-101. That is inferred, and only real nginx can confirm it.

11. **`kill -9` doesn't test power loss.** The spool relies on the OS keeping bytes it accepted: "kill -9 doesn't lose what `write` already handed to the OS; a machine crash could, and fsync per batch would close that (not measured here)" (`SPIKE/src/runner/spool.ts:10-11`).

12. **The load generator isn't a fleet of runners.**
    - It runs every peer in one Node process, each with an in-memory spool, and a fixed event interval (`SPIKE/src/loadgen/loadgen.ts:1-2,69`; `peer.ts:151-152,161-174`). So it leaves out disk spool I/O, many OS processes and bursts.
    - Other spikes were on the machine too, and ingest p99 was 23 to 25 ms against the README's 6 to 9 ms (README, not rerun: `SPIKE/README.md:76`).
    - At 1,000 sessions, one loadgen process would encode and decode about 6,500 events/s (inferred), and may be the limit before the server is.

13. **Two plan values aren't enforced by the runner.**
    - The server grants a window of 256 frames and 4 MiB in `welcome` (`replica.ts:83-84,280-281`). The runner reads only the frame count (`peer.ts:367`) and caps each frame at 512 KiB (`peer.ts:36`). So up to 128 MiB can be in flight, not 4 MiB (inferred). `ADR34:84` says "256 frames or 4 MiB".
    - The spool quota logic is written (`peer.ts:164-172`) but no scenario fills a spool. README, not rerun: "the spool quota under pressure" is listed as not built (`SPIKE/README.md:100`).

14. **The HTTP carrier needed more than `ADR34` lists.**
    - `ADR34:11` names `POST /runner/v1/up` and `GET /runner/v1/down?after=<seq>`. The spike also needed `POST /runner/v1/hello` (`replica.ts:867-886`), a connection epoch on every request, a 409 answer when a newer connection holds the runner (`replica.ts:817-821,904-907,928-931`), and an `x-ostra-minor` header (`replica.ts:888-894`; `peer.ts:536-541`).
    - The `/down` hold is 25 s (`timers.ts:22`). It worked behind the emulation that buffers whole responses (`net-proxies.ts:401-405`; RUN, nginx emulation row), as `ADR34:74` expects.

15. **`NOTIFY` stayed rare, and Postgres's own docs don't state the lock.**
    - In the 250-session run the steady rate was 0.1 notifications/s, and one replica counted 502 in all (RUN, 250 sessions row; `results.json`, replica counters). That is about what 250 connects and 250 dispatches would send (inferred). Agent events never use it (`replica.ts:290-360`).
    - `ADR34:33` rests on a commit lock that limited a `NOTIFY`-per-write design to about 2.9K writes/s. Its sources are two vendor posts (`STUDY:274-275`). The Postgres `NOTIFY` page, as I read it today, doesn't mention such a lock. It does say "If this queue becomes full, transactions calling `NOTIFY` will fail at commit", and that a payload must be shorter than 8000 bytes ([NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)).
    - Every `hello` sends an `evict` notification (`replica.ts:254`). A reconnect storm would send one per runner. No scenario makes one.
    - After a welcomed connection dies, the next attempt waits 0.5 to 1 s (`peer.ts:780,799`; `timers.ts:69-72`). So a replica's whole fleet comes back inside about a second (inferred). `STUDY:557-559` expects replicas to admit new sessions "at a capped rate". The spike has no admission cap (I found none in `SPIKE/src/server/replica.ts`), and the README doesn't list it among what isn't built (`SPIKE/README.md:100`).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **Settle the 11 minute rule, and reword the bar.**
   - Add a question to `context/open-questions.md`. The highest number in that file is Q110 (Q107 to Q110 are open), so the next free number is Q111. It asks: are events produced under a still-valid lease, but delivered after the grace, refused, or kept in an inert quarantine table?
   - I'd reword `context/build-order.md:144` either way, to: "every event the server received before the grace ran out is stored exactly once; after it, the task stops cleanly and stale writes are refused". A bar that its own ADR contradicts can never PASS.
   - If the maintainer wants the transcript kept, F-045 (`context/features.md:221`) gains a line on the quarantine, and ADR 0034 line 48 says what it holds and that nothing reads it.

2. **Amend ADR 0034's fallback triggers** (`ADR34:65`).
   - Replace "when two heartbeat periods pass with no frames" with: the upgrade succeeds but no `welcome` comes within the 10 s handshake timeout. Say that once a connection has had a `welcome`, silence is a network failure, and the runner reconnects over WebSocket.
   - Make the same edit in `STUDY:682` if it is still read.

3. **Amend ADR 0034's consequences about `https-proxy-agent`** (`ADR34:81`).
   - It says the package is "added only if spike 6 needs it". Spike 6 didn't: `https.Agent({ proxyEnv })` was enough on Node. Say so.
   - Set the runner's minimum Node to 24.5 or later (22.21 on the 22 line), or add `https-proxy-agent`. Put it in ADR 0046 and in the `ostra` CLI's `engines`, because the repo root's `>=24.2` is lower (`package.json:9`). The docs call the feature "Active development", so the contract suite should include a proxy case that runs on each Node the CLI supports.
   - Say in the self-hosting docs that `NODE_EXTRA_CA_CERTS` is read at launch only.

4. **Amend ADR 0034's fencing paragraph** (`ADR34:48`).
   - Add that the ingest transaction must hold a share lock on the task row, so the sweep and a batch can't interleave (gotcha 9).
   - F-045's contract test should include a concurrent grace sweep and ingest, with a check that no row has an epoch behind its task's.

5. **Amend ADR 0034's HTTP carrier** (`ADR34:11`).
   - Add `POST /runner/v1/hello`, the connection epoch on every request, the 409 answer and the minor header (gotcha 14).

6. **Say which of the plan's values the runner enforces** (`ADR34:84`). The 4 MiB window needs a byte count on the runner, or the ADR should say "256 frames of at most 512 KiB" (gotcha 13).

7. **F-rows.**
   - F-013: no change to the text. The 30 s fallback held in every case that ran, and the longest took 10.2 s. It stays `planned`: the spike is throwaway code.
   - F-045: add the line from item 1 once it is settled.
   - F-061: no change. The window of one minor either way, the codecs and the refusal text all worked. It was simulated, so it stays `planned`.
   - F-117 (`context/features.md:226`): the spike didn't clear the floor, so this stays a launch gate. Its load test should also record Postgres CPU, run the generator as several processes, and include a reconnect storm (gotchas 12 and 15).

8. **Keep spike 6 open in `context/build-order.md`.** ADR 0034 says spike 6 "gates this" on Windows, macOS and Linux (`ADR34:82`). Today closed the Windows half of criteria 3 and 5, and most of 2.

9. **Record the maintainer's approval of `embedded-postgres`, or ask.**
   - It is a beta (18.6.0-beta.19), spike tooling only, and shared by four spikes. `AGENTS.md` says to ask before adding a dependency. No doc names it: a search of `docs/development.md` finds nothing (README, not rerun: `SPIKE/README.md:99`).
   - `research/spike-auth-foundation.md` raised the same point.

10. **No change.**
    - ADR 0017 holds: there is no broker and no Redis in this spike, and Postgres carried the routing, the outbox and the events.
    - The fallback in `PASSBAR` ("batch harder first, then weigh another WebSocket server", `context/build-order.md:149`) isn't triggered, because no check failed. It isn't ruled out either: criterion 4 hasn't run at the floor. So far `ws` held 1,000 connections at 64.7 MiB per thousand (RUN, 1,000 connections row), and 250 sessions at the recorded rate lost nothing.

---

## 5. What's still open

**SKIPPED in today's run (5 checks, in 4 criteria).**
- **Real nginx (criterion 1).** Set `NGINX_BIN` to an nginx binary and run `pnpm spike --only=networks` (`SPIKE/src/harness/scenarios/networks.ts:42,101-105`). Then run behind squid, mitmproxy and a Cloudflare-proxied hostname, which `STUDY` listed and this spike replaced with its own proxies (`STUDY:713-720`; README, not rerun: `SPIKE/README.md:95`).
- **"Every event the agent produced" after the 11 min cut (criterion 2).** It needs the maintainer's decision (section 4, item 1). The check then passes or is deleted with the reworded bar.
- **2,000 connections on one replica, and 1,000 sessions on three replicas (criterion 4).** Both need the Linux machine: `pnpm spike:full-load` (`SPIKE/README.md:50`). That run should also record Postgres CPU, which the harness doesn't measure (README, not rerun: `SPIKE/README.md:96`). The rate must come from spike 1's final report, because the 392 events/min figure is from a spike that isn't finished, and the report file it names is gone (section 2.4).
- **A real laptop sleep (criterion 6).** Run a runner on a laptop with `OSTRA_RUNNER_TOKEN`, against replicas on another machine. Dispatch, sleep the laptop for 11 minutes, wake it, and check `stale_refusal`, `agent_event.received_at` against `task.stopped_at`, and whether `performance.now()` counted the sleep, on macOS, Windows and Linux (README, not rerun: `SPIKE/README.md:97`).

**macOS and Linux (every criterion).** The bar asks for all three platforms (`PASSBAR`). Criteria 3 and 5 are PASS on Windows only, and the checks that passed in criteria 1, 2 and 6 passed on Windows only too. Run `pnpm spike` on both. A real `kill -9` on Linux and macOS hasn't run (section 2.2).

**A runner built one minor apart (criterion 5).** The spike starts one build with `--minor`. ADR 0034 asks for a compatibility matrix in CI over recorded fixtures (`ADR34:83`). That needs two builds.

**Not covered, though no bar line names it.**
- The gap in gotcha 9: a test that runs the grace sweep and an ingest at the same moment.
- A reconnect storm, and the capped admission that `STUDY:559` expects.
- fsync of the spool and the spool quota under pressure.
- Ed25519 identity and 10 minute tokens: the spike uses an HMAC bearer (`SPIKE/src/shared/auth.ts:4-6`).
- Not built, because the bar doesn't need them (README, not rerun: `SPIKE/README.md:100`): `rpc`, unsequenced live frames, the 2 minute offer timeout, `goaway` waves and the maximum connection age, and the 10 minute WebSocket retry under real conditions.
- Bun. ADR 0046 says "Spikes 3 and 6 run on Node only" (`context/decisions/0046-one-cli-and-three-images.md:57`).

**Decisions the spike can't make:** the stale-epoch events (item 1), the runner's minimum Node (item 3), and the approval of `embedded-postgres` (item 9).
