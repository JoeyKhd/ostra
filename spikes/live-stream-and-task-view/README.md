# Spike 7: `live-stream-and-task-view`

Throwaway code for milestone 0 (`context/build-order.md`, "Milestone 0: spikes", item 7). Its finding goes into `context/research/` once spike 1's recordings exist; until then the substantive findings are kept in "Findings worth carrying" below, each with the run or check that produced it.

## The question

Can a task page on the AI SDK's types and assistant-ui show a real session live to two viewers, from ostra's own stream?

**Tests the decisions:** Q23 (partial text is shown, never saved), Q50 (the AI SDK's types with assistant-ui's external store), Q18 (the scale floor). It exercises ADR 0035 (the event log and live streams) and ADR 0036 (the task page).

## The pass bar (copied from `build-order.md`)

- 5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms from runner to browser, with Postgres under 50% of 4 vCPU.
- Every kind of event in the recorded sessions renders, and nothing is dropped silently.
- A reload shows the partial text again within 1 s. A 10 s network drop leaves no gap and no duplicate.
- A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.
- 5,000 events render in under 1.5 s.
- Strict typecheck and lint pass with only documented suppressions. The page calls no third party.

**If it fails:** if assistant-ui fails, render with AI Elements. If live text fails, carry it in the notification. If fan-out fails, evaluate Centrifugo, as `research/live-sync.md` suggests.

## Architecture

```
 producer (stand-in for the runner)        server replica(s), one process each            browser
 synthetic scenarios | ACP replayer        ┌───────────────────────────────┐
   runner client: per-task runner seq,     │ POST /runner/ingest           │
   250 ms partial frames, batches   ─────▶ │  group commit: one transaction│
                                           │  per ~10 ms for all tasks:    │
                                           │  lock counter rows (task order│
                                           │  seq per task, idempotent by  │
                                           │  runner seq), INSERT events,  │
                                           │  UPSERT partial text          │
                                           │  (UNLOGGED), then one NOTIFY  │
                                           │  per batch (wake-up only)     │
                                           │ tailer, one per replica:      │
                                           │  wake-up or 250 ms poll, one  │
                                           │  query for seq > cursor       │
                                           │ GET /api/tasks/:id/stream (SSE)│ ───▶ EventSource
                                           │  `id: <seq>` on committed     │       (Last-Event-ID resume,
                                           │  events, none on live frames; │        20 s watchdog on pings)
                                           │  a named `ping` every 15 s    │       fold -> UIMessage[] ->
                                           │ send / interrupt / take-over /│       assistant-ui
                                           │  approval answer: the server  │       useExternalStoreRuntime
                                           │  enforces driver and winner   │
                                           └───────────────────────────────┘
```

- **No classes** (ADR 0025: classes are for adapters only; ESLint now forbids them here). Every part is a function that returns a typed record: `createAppender`, `createTailer`, `createSseConnection`, `createWakeSender`/`createWakeListener`, `createRunnerClient`, `createAcpMapper`, `createLoadScript`, `createTaskStream`, `createToggleProxy`, `createSseClient`. A failure is a plain `Error` carrying a code and details (`src/shared/failure.ts`).
- **One shared fold** (`src/shared/fold.ts`): `foldTaskEvents(events, liveText, {optimistic, previous}) -> TaskUIMessage[]`. Pure. It uses the AI SDK's `UIMessage` type (`import type` only, erased at build) with ostra's generics, all derived from the Zod schemas. Unchanged messages keep their object identity. An unknown event kind becomes a visible "unsupported" row, and an update that matches nothing becomes a visible "problem" row. An approval and a question are discriminated unions (`pending | answered | auto | closed`, `open | answered | closed`): a state carries exactly its own fields.
- **Types written once.** Events, frames, tools, IDs and the page-to-server API are Zod schemas shared by the producer, the server, the page and the harness (`src/shared/events.ts`, `tools.ts`, `ids.ts`, `api.ts`). Every ID is a branded type (`TaskId`, `TurnId`, `ApprovalId`, `OptionId`, ...). The server checks each reply body against the schema the page parses it with before it sends. Ostra-owned formats are `strictObject`; vendor-owned ones (ACP) tolerate unknown fields.
- **Storage** is a real Postgres (embedded-postgres, no Docker): `events (task_id, seq)` with the runner's own sequence making saving idempotent, a per-task counter row that writers lock, an `UNLOGGED` `task_live_text` table (one row per open segment, deleted in the transaction that commits the completed message), an `approvals` row with a compare-and-set, a durable `commands` queue, and `sessions` (only the SHA-256 of a session token is stored).
- **Two replicas** share one database, each its own process: the writing replica wakes its own subscribers and sends one `NOTIFY`; the other replica's `LISTEN` connection wakes its tailer.
- **The page** (Vite, React 19) loads history by turn, then tails with `EventSource` from the newest seq. It renders through assistant-ui's `useExternalStoreRuntime`, `ThreadPrimitive`, `MessagePrimitive.Parts` (children render function, no deprecated `components` prop) and `ComposerPrimitive`. Renderers are keyed by ACP `kind` and read the typed part from ostra's own store by ID, never `args` or `result` from assistant-ui; each row subscribes to its own part, so a flush re-renders only the rows that changed. Markdown has no raw HTML, links are `http(s)` only, remote images are never loaded.
- **Capabilities:** the server decides who is the driver (compare-and-set on a version, an event per change). A non-driver gets no composer and a "Sam is driving · Take over" bar; a read-only viewer gets no take-over and no approval buttons (the page passes no `onRespondToToolApproval`, and the approval card checks `thread.capabilities.answerToolCall`). The server rejects every one of those calls on its own.
- **A connection that goes quiet is noticed.** The server sends a named `ping` event every 15 s (an SSE comment never reaches an `EventSource`'s JavaScript). The page reconnects, from the last committed seq, after 20 s without any frame.
- **Recorded sessions:** `src/producer/replay.ts` replays recordings through a small ACP-to-ostra mapper (`acp-map.ts`). The mapper counts every line in exactly one of mapped, ignored by design, or unknown (an unknown also becomes an `agent.unknown` event and an "unsupported" row), and never throws on vendor data.

### The recording format (agreed with spike 1, to be mirrored in its README)

`pnpm spike` reads two kinds of input from spike 1. It is the contract between the two spikes:

- **Recordings:** `spikes/how-should-the-runner-drive-opencode/recordings/*.jsonl` (JSON Lines) or `*.json` (one JSON array), or `OSTRA_SPIKE_RECORDINGS_DIR`. Each line, or each array element, is one of:
  - an ostra event, `{"kind": "agent.message", ...}`;
  - a raw ACP v1 JSON-RPC message, bare or wrapped as `{"t": <ms>, "msg": {...}}`;
  - a spike 1 capture record: `{"kind": "session_update", "sessionId", "update", ...}` (a `session/update` notification) or `{"kind": "prompt_finished", "response": {"stopReason": ...}}` (the answer to `session/prompt`).
- **Captures:** spike 1's existing `.runs/<run>/events.json` (a JSON array of the capture records above), or `OSTRA_SPIKE_CAPTURES_DIR`. These are real OpenCode sessions already on disk, so the mapper is exercised against them now. The three that exist hold only message and thought chunks (no tool call, permission request or plan).

Every line must be accounted for: `lines = mapped + ignored by design + unknown + not JSON`, `unknown` = the number of `agent.unknown` events = the number of "unsupported" rows on the page, and no line may be unreadable.

## How to run it

```
pnpm install
pnpm check:inputs            # which inputs are present; never prints a value
pnpm spike                   # every criterion it can run here, as PASS / FAIL / SKIPPED (about 4.5 minutes)
pnpm spike --full-load       # the same, with the load bar's own shape (5,000/s) instead of the scaled one
pnpm load                    # just the load test, scaled down
pnpm load --full             # 5,000/s sustained, a burst of 10,000, 1,000 tasks, 3 server processes, 10 runner clients
pnpm check:api               # the checks that need no browser
pnpm check:browser           # the browser checks; --only latency,render,... runs some of them
pnpm demo                    # a running server and one task to open in your own browser, as three members
pnpm typecheck && pnpm lint && pnpm test
```

Windows, Linux and macOS are expected to work (no shell scripts; every process is a child of the harness and is killed as a tree on the way out, `taskkill /T /F` on Windows). **Only Windows has been run.** The children also end themselves when the harness dies: each is spawned with a stdin pipe and `OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE=1`, and the next run removes the scratch directories (`.pgdata/run-*`, `.pgdata/edge-*`) of a harness that is no longer alive. A `kill -9` of the harness on Linux or macOS has not been tried.

### Settings

A server is configured from the environment, validated once (`src/server/config.ts`). **There is no default secret.**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none (required) | the Postgres to use |
| `OSTRA_SPIKE_RUNNER_TOKEN` | none (required, at least 24 characters) | guards `/runner/*` and `/metrics`. The harness makes a random one per run |
| `OSTRA_SPIKE_DEV_LOGIN` | `0` | `1` turns on `/api/dev-login`, which mints a session for any member with no secret. Refused unless `HOST` is a loopback address |
| `HOST`, `PORT` | `127.0.0.1`, `0` | where to listen |
| `OSTRA_SPIKE_POLL_MS`, `_FLUSH_MS`, `_PG_POOL`, `_PG_IDLE_MS`, `_REPLICA_ID`, `_WEB_DIR`, `_QUIET` | `250`, `10`, `10`, `10000`, `replica`, `dist/web`, `0` | tuning (`_PG_IDLE_MS=0` keeps every database connection open; the harness sets it for measurements) |
| `OSTRA_SPIKE_EXIT_ON_STDIN_CLOSE` | `0` | `1`: the process ends when its stdin closes (the harness sets it) |

The harness's own settings (`src/harness/settings.ts`, all optional): `OSTRA_SPIKE_DATABASE_URL` (a Postgres of your own; the harness makes a schema in it and drops it; deliberately not `DATABASE_URL`), `OSTRA_SPIKE_POSTMASTER_PID`, `OSTRA_SPIKE_BROWSER`, `OSTRA_SPIKE_RECORDINGS_DIR`, `OSTRA_SPIKE_CAPTURES_DIR`. A child process gets only an allowlist of environment variables (PATH, the temp and home directories, the OS's own), never your model key or a GitHub or Linear token.

### Inputs, per criterion

| Criterion | Needs | Present here |
|---|---|---|
| Typecheck, lint, suppressions, unit tests | Node 24 and `pnpm install` | yes |
| API, stream, two-viewer, resume, partial-text checks | embedded-postgres (comes with `pnpm install`), or `OSTRA_SPIKE_DATABASE_URL` for another Postgres | yes (embedded) |
| UI, reload, network drops, render time, browser latency, network log, hostile content | Edge or Chrome (`OSTRA_SPIKE_BROWSER` to point at one) | yes (Edge, headless) |
| Load, scaled down | the same Postgres | yes |
| Load, the bar's own shape | a Linux host with 4 vCPU for Postgres, to match the reference (it runs anywhere; the verdict is only about that host) | no |
| Real OpenCode captures render | spike 1's `.runs/*/events.json` | yes (3 tiny sessions) |
| Recorded sessions render | `*.jsonl` or `*.json` recordings from spike 1 (format above) | no |
| A reference device for the render number | a mid-range laptop | no (a 4x CPU throttle stands in) |

The spike calls no model, so `OSTRA_DEV_MODEL_*` is not used. It reads no Linear or GitHub input. The bullets that need a real session therefore depend entirely on spike 1's recordings.
## Status, from the run on 2026-11-18

Windows 11 (32 logical cores), Node 24.14.0, pnpm 11.28.2, embedded-postgres 18.6.0-beta.19 (Postgres 18), headless Microsoft Edge. Other work was running on the same machine during all of these runs (other spikes' databases), so every timing is noisy. The last `pnpm spike` of the day: **36 PASS, 3 FAIL, 2 SKIPPED in 271 s**, with no process left running afterwards. The two runs before it, earlier the same day while the harness was being finished, gave 34 PASS / 2 FAIL / 2 SKIPPED and 37 PASS / 2 FAIL / 2 SKIPPED; the FAILs in every run are the render checks below (which of the three shapes misses 1.5 s changes from run to run).

**What is still unproven, whatever the PASS count says:**

- **Recorded-session coverage.** The recorded-session bullet is SKIPPED. The only real OpenCode captures on disk hold message and thought chunks, with no tool call, permission request, plan or question, so the mapper's tool, approval and plan paths have run only on a hand-written fixture.
- **The bar's own load shape on its own host.** The scaled run passes; the 5,000/s shape on a Linux host with 4 vCPU was not run (and see the one-off below: on this machine it misses the Postgres line once partial text is included).
- **The browser leg is measured for one page, at 200 events a second.** The load test's viewers are Node clients, so its p99 is runner to SSE client. The two numbers together are not the bar's "from runner to browser" at 5,000 events a second with browsers as the viewers.
- **A reference-device render time.** No mid-range laptop was run. A 4x CPU throttle on this machine stands in, and it is not met in this run.

| Pass-bar bullet | Criterion | Status | What was measured |
|---|---|---|---|
| Load | Scaled down (1,000/s for 20 s with partial text on 1 task in 4 and 4 to 20 KB command outputs, a burst of 2,000 in 1 s; 100 tasks, 200 SSE viewers, 2 server processes): nothing lost, p99 under 500 ms runner to SSE client in the sustained phase and the burst, Postgres under 2 cores in both | PASS | sustained p50 39 ms, p95 55 ms, p99 61 ms; burst p99 61 ms; 32,694 events sent, 32,694 stored, 65,388 of 65,388 deliveries, 0 gaps, 0 duplicates; 4,888 live frames delivered. Postgres: 0.42 cores (11% of 4 vCPU) over a 10 s events-only phase, 0.57 cores (14%) with partial text (+0.15 cores for 104 upserts/s, 228 KB/s of text), 0.51 cores (13%) over the burst and its drain. In the two runs before it the cost of the partial text was +0.25 and +0.19 cores |
| Load | The bar itself: 5,000/s, a burst of 10,000, p99 under 500 ms, Postgres under 50% of 4 vCPU | SKIPPED | needs a Linux host with 4 vCPU for Postgres. The one-off on this machine, below, is information |
| Load (browser) | One page watching a task at 200 events/s for 30 s: every row in the DOM within p99 500 ms of its emit time | PASS | 5,454 of 5,454 rows seen; p50 68 ms, p99 140 ms, max 165 ms; the first 500 rows p50 52 ms, the last 500 p50 97 ms; page head = database head 5,999, 0 gaps, 0 duplicates. Before each row subscribed to its own part, the same check gave p99 667 and 792 ms (every row re-rendered on every flush) |
| Recorded sessions | Every kind of event in ostra's union renders (synthetic session, including a kind this build has never heard of), no "problem" rows | PASS | 30 of 30 kinds found in the DOM; 0 problem rows |
| Recorded sessions | Real OpenCode captures from spike 1 (2 sessions on disk at the time of this run; 3 earlier): every line accounted for and rendered | PASS | 17 lines = 13 mapped + 4 ignored by design + 0 unknown + 0 not JSON; unknown (0) = `agent.unknown` events (0) = unsupported rows on the page (0); 0 problem rows. They hold message and thought chunks only |
| Recorded sessions | Every kind of event in the recorded sessions renders, and nothing is dropped silently | SKIPPED | needs recordings (`*.jsonl` or `*.json`, format above) from spike 1 |
| Reload, drop | A reload mid-message shows the partial text again within 1 s | PASS | 5 reloads: 110, 110, 117, 115, 114 ms to the first words on screen; the text is never shorter than before |
| Reload, drop | A 10 s network drop (sockets reset) mid-turn leaves no gap and no duplicate | PASS | 243 events on the page = database head 243; 0 gaps, 0 duplicates; the thread is identical to a page that never dropped |
| Reload, drop | A 10 s black-holed network (sockets stay open and silent) is noticed within 25 s and leaves no gap and no duplicate | PASS | the page showed "live" with no data, then its watchdog noticed after 20.1 s and reopened from seq 61; 442 events = database head 442; 0 gaps, 0 duplicates; thread identical to the control |
| Reload, drop | The stream keeps `Last-Event-ID` across untracked live frames | PASS | 56 live frames flowed; Edge sent `Last-Event-ID: 61` (the newest committed seq) on all 20 reconnect attempts |
| Reload, drop | A dropped stream resumes on another replica, no gap or duplicate (Node client) | PASS | cut at seq 140 of 400; the joined sequence is 1..400, contiguous |
| Watcher, approval | A watcher cannot send or interrupt by calling the API | PASS | non-driver member 403, read-only viewer 403, signed out 401; rejected calls wrote 0 events and 0 commands |
| Watcher, approval | A read-only viewer cannot take over or interrupt by calling the API | PASS | 403 and 403; 0 events, 0 `driver.changed`, 0 commands. A watcher answering a question is not covered (`question.answer` is not built) |
| Watcher, approval | In the UI, a watcher has no composer and no send control; a read-only viewer cannot take over or answer | PASS | |
| Watcher, approval | Take over (compare-and-set) swaps the roles on every open page | PASS | both pages switched within 49 ms; of two simultaneous takers one gets 409 |
| Watcher, approval | Two members answer one approval: one wins | PASS | API: 25 races of 3 simultaneous answers, sent to alternating replicas (separate processes), each with exactly one winner, one `approval.answered` event and one queued command, and the losers' 409 names the winner. UI: two clicks at once gave 200 and 409, and all three pages show the same receipt |
| Watcher, approval | A read-only viewer cannot answer; a runner cannot forge a member's message | PASS | 403 and 403 |
| Render | 5,000 events render in under 1.5 s, CPU throttled 4x, 100 turns x 50 events (100 messages, 4 to 20 KB command outputs) | FAIL | median 2,964 ms (2,115, 3,724, 2,964); unthrottled 418 ms. Earlier the same day: 1,809 and 1,805 ms median |
| Render | The same, 500 turns x 10 events (500 messages) | FAIL | median 3,446 ms; unthrottled 843 ms. Earlier: 1,825 and 1,592 ms |
| Render | The same, 1 turn x 5,000 events (one message with 2,499 tool rows) | FAIL | median 1,518 ms; unthrottled 360 ms. Earlier: 1,204 and 1,173 ms (PASS) |
| Policy | Strict typecheck, lint, only documented suppressions, unit tests | PASS | `tsc --noEmit`: 0 errors; ESLint `strict-type-checked` + `stylistic-type-checked`, exhaustive switches, `no-explicit-any`, `no-non-null-assertion`, `as` only as `as const`, `no-deprecated`, **no classes**, `noInlineConfig`: 0 errors, 0 warnings; 0 suppressions in 57 files (every `.ts`, `.tsx`, `.js` in the folder, config files included); 18 unit tests |
| Policy | The page calls no third party | PASS | 372 requests across 26 pages, including a session that gives the page a remote image, an `<img onerror>`, a `javascript:` link and a `<script>` aimed at `third-party.invalid`; every request to a host other than this machine is stopped and counted: 0 |
| Policy | Hostile agent content renders inert | PASS | the message is on the page; 0 requests to another host; 0 `<img>` whose src is not an inline `data:image`; 0 `a[href^=javascript]`; 0 `<script>` in the thread; 0 dialogs; the `javascript:` link is plain text; 1 remote image shown as "Image not shown" (so a page that never met one cannot pass) |
| Hardening | Safe by default | PASS | `/api/dev-login` is 404 on a default server, and `OSTRA_SPIKE_DEV_LOGIN=1` with `HOST=0.0.0.0` refuses to start; `/metrics` is 401 without the runner token; a 5-character runner token is refused; a session token is stored only as its SHA-256; a fractional or negative `after`, a path with a stray `%`, an interrupt with no JSON body or with an unknown field are all 4xx |
| Key parts | Two viewers, in two browsers on two replicas, render the same thread | PASS | 14 messages, 1,354 characters, identical; log head 51 on both |
| Key parts | Two viewers on two replicas get the same events in the same order as history | PASS | 45 and 45 of 45; replica B (a separate process, polling once a minute) got 5 NOTIFY wake-ups; its viewer saw every event within p99 50 ms of the runner's emit time |
| Key parts | Partial text is shown, never saved; late joiners get a snapshot | PASS | 12 partial frames; 0 completed messages stored while the segment was open; the live row was deleted by the commit; the late joiner's first frame was a 294-character snapshot |
| Key parts | Saving is idempotent by the runner's sequence number; a gap is refused | PASS | |
| Hygiene | No process left running | PASS | no process with the spike's folder in its command line, and every pid the run started (the browser's included) is gone |

### The load bar's own shape, run once on this machine (`pnpm load --full`; information, not a verdict on the reference host, and not part of `pnpm spike`)

On 2026-11-18, Windows, Node SSE viewers (not browsers), everything on one 32-core machine, with other work running: 1,000 tasks (250 streaming partial text every 250 ms up to 4 KB), 1,000 SSE viewers, 3 server processes, 10 runner clients, one embedded Postgres, command outputs of 4 to 20 KB on every 10th command.

- **Events only, 5,000/s for 15 s:** p50 39 ms, p95 55 ms, p99 64 ms; Postgres **1.04 cores** (26% of 4 vCPU).
- **With partial text, 5,000/s for 30 s:** p50 95 ms, p95 204 ms, p99 **230 ms**, max 291 ms; Postgres **2.32 cores (58% of 4 vCPU)**. The `UNLOGGED` table took 1,017 upserts a second carrying 2.2 MB/s of text and cost **+1.29 cores**, more than the events themselves.
- **Burst of 10,000 in 1 s** (9,975/s achieved): p50 177 ms, p99 **264 ms**; Postgres 2.77 cores (69%) over the burst and its drain.
- 238,983 events sent, stored and delivered, 0 gaps, 0 duplicates; the runner side never queued more than 550 events; a batch is one transaction (the largest observed was 250 events, 3 to 4 ms on average).
- **What it says:** the latency bar holds with room to spare. The Postgres line (2 cores) is **missed on this machine once partial text is included** in this design, where every open segment rewrites its whole accumulated text on every flush. Without partial text Postgres is at half that. This is the number ADR 0035's fallback ("if the `UNLOGGED` table costs too much, carry it in the notification") has to be decided on; whether Linux on 4 vCPU does better is what this machine cannot say. Cheaper variants were not tried: upserting less often than every 250 ms, sending deltas, or not writing the table at all when nobody is watching the task. Not reproduced by `pnpm spike`: the previous version of this README quoted p99 172 ms and 46% for an events-only run; those figures were not re-run and are replaced by the above.

### Findings worth carrying into `context/research/` (after spike 1's recordings)

Each line says where it came from (a check in `pnpm spike`, a run in this README, or code in this folder).

- **assistant-ui accepts a system message only with exactly one text part.** ostra's system rows (driver changed, runner lost, an unsupported event) are `data-*` parts, so the converter hands them to assistant-ui as completed assistant-role messages and the page styles them from ostra's own role. The runtime threw "System messages must have exactly one text message part." until it did (`src/web/convert.ts`).
- **A stock `ComposerPrimitive.Send` is disabled while a run is active and never calls `onNew`** (no `queue` adapter). So "Send queues" (ADR 0032, 0036) needs ostra's own Send button, or assistant-ui's queue adapter. The spike built the server side (`delivery: queued`) and its "Interrupt and send" button; the queued send is not wired to a button yet. This answers the ADR 0036 open item (check "assistant-ui: onNew while a run is active": Send disabled: true, no POST fired).
- **Leaving out `onRespondToToolApproval` does hide the approval controls**: `thread.capabilities.answerToolCall` goes false, and the card renders "Waiting for approval" (UI check, read-only viewer: 0 approval buttons).
- **The AI SDK's tool-part types cannot carry a request that closed without a decision** (`approved` is `true` or `false`, and the closed states only allow `true`). The fold carries the options and the receipt in `toolMetadata` too, and the converter hands assistant-ui `approval.resolution` (`src/shared/fold.ts`, `src/web/convert.ts`).
- **`aui.composer()` is deprecated** in 0.15.36; the property form (`aui.composer.setText`) is the supported one. With `no-deprecated` on, the spike has none of assistant-ui's deprecated APIs (lint).
- **assistant-ui's composer leaves a hidden measuring `<textarea aria-hidden>` in the DOM** (react-textarea-autosize). Tests must ignore it.
- **`EventSource` reconnects by itself after a reset, and not at all after a black hole.** After 10 s of resets Edge retried 19 to 20 times at the server's `retry: 500`, sent the last committed `id` as `Last-Event-ID`, and the server resumed from it; live frames carry no `id`, so they never move it. After a black hole (sockets open, nothing flowing) the page stayed "live" with no error until its own watchdog fired. An SSE comment keepalive never reaches the page's JavaScript, so the server sends a named `ping` event and the page reconnects after 20 s without any frame (checks "10 s network drop" and "10 s black-holed network").
- **Rendering 5,000 events is cheap unthrottled and not cheap throttled.** Unthrottled it is 0.34 to 0.84 s from navigation (of which about 0.1 s is loading and parsing the history). With the CPU throttled 4x it is 1.2 to 4.6 s depending on the shape and on what else the machine is doing, so 1.5 s is not met with confidence. Where the time goes (the Zod parse of the history, the fold, assistant-ui, React and layout) was not measured. The default view (the newest 20 turns) renders in 0.2 to 0.4 s unthrottled.
- **A long live task needs rows that subscribe to their own part.** When every row read the index through a React context that changed on every flush, each flush re-rendered every row: the browser leg went from 50 ms to 550 ms per row as the log grew, p99 667 to 792 ms at 200 events/s. With a small store and a per-row subscription (the fold keeps the identity of what did not change), p99 is 134 to 140 ms and flat. The fold itself is not the cost (1 to 2 ms for the whole log at the end of the run, because unchanged messages are reused).
- **Group commit is what makes the write rate easy**: one transaction per ~10 ms for all tasks (3 statements per table, not per event) kept Postgres at 0.19 to 0.42 cores for 1,000 events/s and 1.04 cores for 5,000. Locking the counter rows in task order means two writers never deadlock, and the approval, take-over and send mutations lock the same counter row first.
- **The `UNLOGGED` partial-text table is the expensive part of the stream at the full rate** (+1.29 cores at 1,000 upserts a second, see above); at 1,000 events a second it is +0.15 to +0.25 cores.
- **Reading Postgres's CPU by summing its processes is noisy**: a backend that exits takes its CPU time out of the total (one run read -0.05 cores for the events-only phase). The harness now keeps every connection open (`OSTRA_SPIKE_PG_IDLE_MS=0`) so the process set stays the same through a measurement. The numbers are still one machine's, with other work running.
- **Zod 4 and `exactOptionalPropertyTypes`**: parts are built with conditional spreads, as ADR 0036 predicted. The one generic `buildInvocation<I, O>` builds every tool part state and type-checks against `UIToolInvocation`.
- **Folding is cheap**: in Node a 5,000-event fold takes roughly 17 to 18 ms cold, and Zod-parsing the 5,000 events about 11 ms (a re-measurement by the reviewer; the previous README said 18 and 8 ms).

## What this spike does differently from the ADRs (so nothing is mistaken for a finding)

- **Plain SSE over `node:http`, not a tRPC v11 subscription.** The wire shape is the one ADR 0035 describes (`tracked(seq)` becomes `id: <seq>`; untracked frames have no id), but tRPC's `httpSubscriptionLink` and its `lastEventId` handling are **not** verified. The browser's native `EventSource` is what was tested.
- **Raw SQL through `pg`, not Prisma 7.** The `UNLOGGED` table works on Postgres 18; "Prisma 7 with an `UNLOGGED` table in a raw migration" is **not** verified.
- **Vite, not Next.js 16;** no shadcn kit and no brand work. The CSS is a placeholder, not `context/brand/app-design.md`'s graphite. No `@tanstack/react-virtual`, no AI Elements.
- **Identity is a dev stand-in** (`/api/dev-login`, off unless `OSTRA_SPIKE_DEV_LOGIN=1`, a session cookie per member, only its hash stored) for better-auth; the roles are `member` and `viewer`. Mutations accept JSON only (an empty strict object counts) and the cookie is `SameSite=Strict`.
- **`ai` 7.0.173 and `@assistant-ui/react` 0.15.36, not 7.0.176 and 0.15.37** (the versions `research/agent-ui-stream.md` checked). pnpm 11's default supply-chain policy refuses versions published less than a day ago, and the spike does not relax it. The newer pair can be pinned once they are a day old; nothing in the API differed in these checks.
- **TypeScript 6.0.3, not 7.** typescript-eslint 8.73 supports `>=4.8.4 <6.1.0`.
- **`allowBuilds` in `pnpm-workspace.yaml`** lists only embedded-postgres's per-platform binary packages (their postinstall restores symlinks; pnpm 11 stops the install until a script is allowed).
- **The ACP mapper has seen only three tiny real captures** (message and thought chunks) and a hand-written fixture. It covers `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `session/request_permission`, `compaction_update`, the stop reason; task-state updates are ignored by design and counted; everything else is counted as unknown and shown as an `agent.unknown` row.

## Dependencies (pinned exactly)

| Package | Version | License | Why |
|---|---|---|---|
| `ai` | 7.0.173 | Apache-2.0 | `UIMessage` types only (`import type`; not in the bundle) |
| `@assistant-ui/react` | 0.15.36 | MIT | the thread, composer and external store runtime |
| `@assistant-ui/react-markdown` | 0.14.26 | MIT | assistant text |
| `embedded-postgres` | 18.6.0-beta.19 | MIT | a real Postgres on this machine, no Docker |
| `pg` | 8.23.1 | MIT | the database, and each replica's `LISTEN` connection |
| `zod` | 4.6.7 | MIT | every boundary |
| `react`, `react-dom` | 19.3.1 | MIT | the page (ADR 0007) |
| `vite`, `@vitejs/plugin-react` | 8.3.8, 6.3.0 | MIT | the page's build (named in the task; Next.js is not needed here) |
| `playwright-core` | 1.65.1 | Apache-2.0 | drives the machine's own Edge or Chrome over CDP; no browser download (ADR 0007 lists Playwright) |
| `vitest` | 5.1.1 | MIT | unit tests |
| `typescript` | 6.0.3 | Apache-2.0 | |
| `eslint`, `@eslint/js`, `typescript-eslint` | 10.15.0, 10.0.1, 8.73.0 | MIT | lint (ADR 0007) |
| `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom` | 26.6.6, 8.23.1, 19.3.0, 19.3.0 | MIT | types |

Not used: `@ai-sdk/react`, `useChat`, `@assistant-ui/ai-sdk`, `resumable-stream`, Redis, Assistant Cloud, tRPC, Prisma, Next.js, `@tanstack/react-virtual`, `tsx`.

**Needs the maintainer's call (AGENTS.md: ask before adding a dependency):** `embedded-postgres` (also used by spike 9, where it is likewise only named in a research note), `vite` and `vitest` are in this spike without an ADR or a recorded sign-off. They are spike-only here. Please approve them for spikes, or say how to run Postgres without Docker, and the answer goes in `context/open-questions.md` (not written from this directory).

## What is left

1. **Recordings from spike 1** in the format above. `pnpm spike` then checks that every line is accounted for, tool rows match tool events, `agent.unknown` rows match unknown lines, and no "problem" row appears. The ACP mapper then needs fixing against what OpenCode really sends (message IDs, command output, permission options, elicitation). Spike 1's README should carry the format.
2. **The bar's own load shape on a Linux host with 4 vCPU for Postgres** (`pnpm load --full`), and with browsers (not Node viewers) as the receiving end for a sample of the viewers. The browser leg is measured separately here, for one page at 200 events a second.
3. **A render budget that holds under a 4x CPU throttle for 5,000 events in one view.** Two of three shapes miss 1.5 s there (see Status). Options, none tried: window the thread (virtualize the rows), cap the default view (the newest 20 turns renders in under 0.2 s now), or measure assistant-ui against AI Elements on the same fold to see which layer costs what.
4. **tRPC v11 and Prisma 7:** move the stream to a tRPC subscription and verify `httpSubscriptionLink` keeps `lastEventId` across untracked frames; create the `UNLOGGED` table in a Prisma raw migration.
5. **The queued send:** a Send button that calls `task.send` mid-turn and shows "queued" for everyone (or assistant-ui's queue adapter); `question.answer` (and, with it, the API test that a watcher cannot answer a question); "approve for this task" as an ostra rule that auto-answers later requests.
6. **A mid-range laptop for the 1.5 s render number**, and an axe and keyboard pass (F-081); neither was run.
7. **Longer and harsher runs:** a multi-hour soak, a slow viewer (the server closes a connection holding over 8 MB unsent, and the viewer resumes by seq: built, not exercised), a Postgres restart under load, a replica killed mid-stream, and a hard kill of the harness on Linux or macOS.
8. **The AI Elements fallback** was not built, because nothing showed assistant-ui to be the cause of the render misses. The fold is renderer-neutral, so the swap changes the renderer only.
9. **Fan-out beyond a few thousand viewers** (Centrifugo) stays a fallback; nothing here suggests it is needed at the scale floor.
10. **The research file** `context/research/live-stream-and-task-view.md`: not written from this directory (the task forbids files outside it and says research waits for real runs). The "Findings worth carrying" above are its draft.

## Layout

```
src/shared/     events, tools, ids (Zod, branded), api (every page <-> server body), failure, time, ui-types, fold (+ tests)
src/server/     appender (group commit), tailer, sse, wake (NOTIFY/LISTEN), app (HTTP), server, main, config, dev-db, schema, seed, db, log
src/producer/   runner-client, scenarios, acp-map, replay, main, fixtures/
src/web/        task-stream, api, convert, renderers, task-page, task-context, probe, main, styles
src/harness/    spike (the one command), checks-static / -api / -browser, load (+ viewers, load-main), infra, settings, context,
                browser, proxy, sse-client, report, stats, check-inputs, run-api, run-browser, demo
```

Logs carry IDs and numbers only, never content or tokens. Nothing untrusted reaches a shell: every child process takes its arguments as an array.
