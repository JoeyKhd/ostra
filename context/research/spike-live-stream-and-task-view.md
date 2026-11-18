# Research: Spike 7, `live-stream-and-task-view`: can a task page on the AI SDK's types and assistant-ui show a real session live to two viewers, from ostra's own stream?

**Status:** Research, 2026-11-18. Feeds ADR 0035 (the event log and live streams), ADR 0036 (the task page), ADR 0011 (guarantee 1, partial text), Q18 (scale target), Q23 (partial text), Q50 (the live agent UI), F-023, F-024, F-026, F-081 and F-117.
**Method:**
- I ran `pnpm spike` once in `spikes/live-stream-and-task-view/` on 2026-11-18 (about 19:41 to 19:46 local time), on Windows 11 with Node 24.14.0 and pnpm 11.28.2. The harness reported 262 s and exited 1, because two checks FAILed (the harness returns 1 on any FAIL, `SPIKE/src/harness/spike.ts:81`). Every result marked "RUN" comes from that one run.
- The harness prints its results and saves nothing. RUN is the stdout of that run, which I saved outside the repo, in the session's scratch folder. A check is cited by the label the harness printed. To reproduce, run `pnpm spike` again. An earlier draft of this file quoted figures from a previous run whose stdout was not kept, so they could not be checked. This re-run gave the same verdict counts as that draft (37 PASS, 2 FAIL, 2 SKIPPED, 262 s). Its timings and some counts differ slightly, and the file now carries only the re-run's figures.
- The machine is an Intel Core i9-13900K with 32 logical processors (PowerShell, today). The browser is headless Edge 157.0.4341.60 (RUN's `finding: browser` line names the executable; the version is from the file's properties). The README says other work was running on the machine during its runs (`SPIKE/README.md:119`). I didn't measure the machine's load, so treat every timing as contended.
- After the run, no process of the spike was left. The harness's own check printed PASS (RUN, `[Hygiene]`). I also searched every process for the spike's folder in its command line. The one match was an unrelated shell that belongs to another session, started at 17:47, and I left it alone. The spike's scratch folder `.pgdata/` was empty.
- I read the code as it stands in the working tree. `git status` for the folder shows no change from commit `7ddd3cb` ("add spike 7"), the last commit that touched it. The newest file in the folder, outside `node_modules`, `dist` and `.pgdata`, was last modified at 19:26:27 (`src/harness/browser.ts`), before the run started.
- I read the official docs of the WHATWG HTML standard (server-sent events), PostgreSQL (`CREATE TABLE`, `NOTIFY`), assistant-ui (external store runtime), the AI SDK (tool usage) and tRPC (subscriptions) on 2026-11-18, and checked each quotation below against them.
- The Chrome DevTools Protocol's own description of `Emulation.setCPUThrottlingRate` is in the protocol's published JSON ([`json/browser_protocol.json`](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)), which I read on 2026-11-18. The documentation page itself gave no usable text.
- Anything from the README that I didn't rerun is marked "README, not rerun". Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a primary source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/live-stream-and-task-view`. A cite like `SPIKE/src/server/appender.ts:51-232` is a file and its lines.
- `README` means `SPIKE/README.md`.
- `PASSBAR` means the spike's pass bar, `context/build-order.md:151-161`.
- `ADR35` means `context/decisions/0035-event-log-and-live-streams.md`. `ADR36` means `context/decisions/0036-task-page-ai-sdk-types-assistant-ui.md`.
- The harness prints checks, not criteria. Most checks carry a `bar` string that is a pass-bar bullet's text (`SPIKE/src/harness/report.ts:3-9`), and I grouped them by it. Two groups are my own placing. The checks whose `bar` is "Key parts: two viewers see the same thing..." (`checks-api.ts:16`, `checks-browser.ts:34`) name no bullet, so I put them under criterion 3, which they support. The hardening checks (safe by default, hashed session tokens, bad input is a 4xx) carry the policy bullet's text (`checks-api.ts:429`), so they sit under criterion 6 although they test neither typing nor third parties. I then used one rule for each bullet: SKIPPED if any of its checks is SKIPPED, FAIL if any FAILed, PASS only if all passed.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| Node | 24.14.0 | MIT | The spike requires `>=24` | RUN header; `SPIKE/package.json:7-9` |
| `ai` (AI SDK) | 7.0.173, exact pin | Apache-2.0 | `import type` only. npm `latest` is 7.0.176, published 2026-11-17. 7.0.173 was published 2026-11-13 | `SPIKE/package.json:29`; `npm view ai` |
| `@assistant-ui/react` | 0.15.36, exact pin | MIT | npm `latest` is 0.15.37, published 2026-11-18. 0.15.36 was published 2026-11-12 | `SPIKE/package.json:27`; `npm view @assistant-ui/react` |
| `@assistant-ui/react-markdown` | 0.14.26, exact pin | MIT | npm `latest` is the same | `SPIKE/package.json:28`; `npm view` |
| `embedded-postgres` | 18.6.0-beta.19, exact pin | MIT | A beta, and the newest on npm. Spike tooling only. No ADR names it (below) | `SPIKE/package.json:30`; `npm view`; a search of `context/` finds it in no ADR, only in the research notes `spike-auth-foundation.md` and `spike-runner-transport.md` (and this file) |
| `pg` | 8.23.1, exact pin | MIT | the database, and each replica's `LISTEN` connection | `SPIKE/package.json:31`; `SPIKE/src/server/wake.ts:75-77` |
| `zod` | 4.6.7, exact pin | MIT | every boundary | `SPIKE/package.json:34` |
| `react`, `react-dom` | 19.3.1 | MIT | | `SPIKE/package.json:32-33` |
| `vite`, `vitest` | 8.3.8, 5.1.1 | MIT | Vitest and Playwright are in ADR 0007's table. Vite isn't (it names Next.js) | installed `package.json` files; `context/decisions/0007-web-app-libraries.md:7,22` |
| `playwright-core` | 1.65.1 | Apache-2.0 | launches the machine's own Edge with `launchServer` and connects with `connect`. The CPU throttle uses a CDP session | `SPIKE/package.json:44`; `SPIKE/src/harness/browser.ts:55,64`; `SPIKE/src/harness/checks-browser.ts:113-115` |
| TypeScript, ESLint, typescript-eslint | 6.0.3, 10.15.0, 8.73.0 | Apache-2.0, MIT, MIT | TypeScript 6, not 7, because typescript-eslint 8.73's peer range for `typescript` is `>=4.8.4 <6.1.0` (read in its installed `package.json`; the README says the same) | installed `package.json` files; `SPIKE/README.md:196` |

---

## 1. The question, and the answer

**Question.** Can a task page on the AI SDK's types and assistant-ui show a real session live to two viewers, from ostra's own stream? It tests Q23, Q50 and Q18, through ADR 0035 and ADR 0036 (`PASSBAR`; `SPIKE/README.md:5-9`).

**Answer.** Mostly yes on one Windows machine, with two failures and two gaps in the bar. The only real OpenCode sessions the page rendered hold message and thought chunks, so no real session with a tool call has been shown on the page yet. The harness ran 41 checks: 37 PASS, 2 FAIL and 2 SKIPPED (RUN, `summary`).
- **What held.** Two viewers on two server processes got the same events in the same order and rendered the same thread. Partial text was shown and never saved. A reload brought it back in 110 to 124 ms. A 10 s reset and a 10 s black hole left no gap and no duplicate. A watcher couldn't send. Two members answering one approval gave one winner, in 25 races across two processes. assistant-ui rendered all 29 kinds in ostra's event union, and a thirtieth that the build has never heard of. The page made no request to a third party, and the lint and typecheck bars passed with no suppression.
- **The two FAILs** are the render budget. With the CPU throttled 4x, 5,000 events took a median of 2,038 ms and 1,918 ms in two of three shapes, against a 1.5 s bar. Nothing in the run points at assistant-ui as the cause, and the layers were not measured.
- **The two SKIPPED** are the load bar's own shape (5,000 events a second, a burst of 10,000), which needs a Linux host, and the recorded sessions. The harness finds no `recordings/` folder from spike 1, and the only captures it reads there (`events.json`) hold no tool call, permission request or plan. Spike 1 also has captures with tool calls under another file name, which the harness never reads (section 2.2).
- **The load bar is answered at a fifth of its rate.** At 1,000 events a second, p99 was 56 ms and Postgres used 13% of 4 vCPU. A one-off at the full rate (README, not rerun) held the latency line (p99 230 ms) and missed the Postgres line (58% of 4 vCPU) once partial text was counted. The partial-text table cost more than the events. That number is what ADR 0035's fallback has to be decided on.

Every figure in this paragraph is cited in section 2 or 3.

---

## 2. Results per pass-bar criterion

| # | Criterion (`PASSBAR`) | Result | What keeps it from a full PASS |
|---|---|---|---|
| 1 | 5,000 events a second, a burst of 10,000, p99 under 500 ms runner to browser, Postgres under 50% of 4 vCPU | **SKIPPED** | The bar's own shape needs a Linux host with 4 vCPU. The scaled run and one browser at 200 events a second pass |
| 2 | Every kind of event in the recorded sessions renders, nothing dropped silently | **SKIPPED** | The harness found no recorded sessions from spike 1 in the place and format it reads (section 2.2). The synthetic session and the two real captures (message and thought chunks only) pass |
| 3 | A reload shows the partial text within 1 s. A 10 s drop leaves no gap and no duplicate | **PASS** | Headless Edge only, on loopback |
| 4 | A watcher can't send, in the UI or by the API. Two members answer one approval, one wins | **PASS** | `question.answer` isn't built. One race in the send path, read in the code and not run (gotcha 9) |
| 5 | 5,000 events render in under 1.5 s | **FAIL** | Two of three shapes miss it at a 4x CPU throttle. The bar names no device |
| 6 | Strict typecheck and lint pass with only documented suppressions. The page calls no third party | **PASS** | |

Source for every result and label: RUN, the block of that criterion.

### 2.1 Load: SKIPPED

| Check (RUN) | Result |
|---|---|
| Scaled run: 1,000 events a second for 20 s with partial text on 25 of 100 tasks, a burst of 1,998 in 1 s, 200 SSE viewers, 2 server processes, 4 runner clients | PASS. Events only: p99 52 ms, Postgres 0.28 cores (7% of 4 vCPU). With partial text: p50 37, p95 52, p99 56, max 83 ms, Postgres 0.51 cores (13%). Burst: p99 59 ms, Postgres 0.48 cores (12%). 32,692 events sent and stored, 65,384 of 65,384 deliveries, 0 gaps, 0 duplicates |
| One browser page watching a task at 200 events a second for 30 s | PASS. 5,455 of 5,455 rows reached the DOM. Emit to DOM: p50 67 ms, p99 139 ms, max 166 ms. The first 500 rows p50 51 ms, the last 500 p50 98 ms. The page held 6,000 events, equal to the database head. 0 gaps, 0 duplicates |
| The bar itself: 5,000 a second, a burst of 10,000 | **SKIPPED**: needs a Linux host with 4 vCPU for Postgres |

- **What the scaled run is.** A fifth of the bar's rate, both sustained and in the burst (1,000 against 5,000; 1,998 against 10,000). It uses 100 tasks, where the bar's shape uses 1,000 (`SPIKE/src/harness/load.ts:33-59`).
- **How latency is measured.**
  - The runner client stamps each event with `Date.now()` when it emits it (`SPIKE/src/producer/runner-client.ts:149-153`).
  - A viewer subtracts that stamp when it reads the event (`SPIKE/src/harness/viewers.ts:67-80`).
  - The clock is one machine's, so the two processes agree.
  - The viewers are Node clients over `node:http`, not browsers (RUN prints that in its first detail line).
- **The runner side isn't ADR 0034's.** The producer is an HTTP batcher that flushes every 20 ms and keeps its buffer in memory, with no spool and no WebSocket (`runner-client.ts:6-7,135-145`; `load.ts:42`). The load events are synthetic and average 242 bytes of payload (RUN, partial-text line; `SPIKE/src/producer/scenarios.ts:329-403`). F-117 asks for "the event rates spike 1 recorded" (`context/features.md:226`), and this spike doesn't use them.
- **Two legs, measured apart.** Runner to a Node SSE client ran at 1,000 events a second. Runner to a DOM row ran at 200 events a second, for one page, unthrottled (RUN, the two rows above). No run has browsers as the viewers at the bar's rate. The README says so (`SPIKE/README.md:125`).
- **How Postgres CPU is read.** The harness sums the processor time of the postmaster and its children, with a PowerShell script on Windows (`SPIKE/src/harness/infra.ts:253-279`). It judges the result against 2 cores, which is 50% of 4 (`load.ts:409-410`). The machine has 32 logical processors, so "cores" here is CPU-seconds a second, not a share of the machine.
- **What the server did.** Group commit: a batch closes 10 ms after its first request and goes in one transaction for all the tasks in it. The transaction runs one statement per table touched, plus the counter-row lock, whatever the number of events (`SPIKE/src/server/appender.ts:51-232,271-323`). Per replica in the scaled run: 1,148 and 1,138 commits, an average of 2 ms, a maximum of 31 ms, and 37 and 50 events in the largest (RUN, the two `load-replica` lines).
- **The full shape, run once by the author, not by me** (README, not rerun: `SPIKE/README.md:160-168`). 1,000 tasks, 1,000 Node viewers, 3 server processes, one Postgres, all on one 32-core Windows machine.

| Phase | p99 | Postgres |
|---|---|---|
| Events only, 5,000 a second for 15 s | 64 ms | 1.04 cores (26% of 4 vCPU) |
| With partial text, 5,000 a second for 30 s | 230 ms | 2.32 cores (58%) |
| Burst of 10,000 in 1 s | 264 ms | 2.77 cores (69%), over the burst and its drain |

  The README reports 238,983 events sent, stored and delivered, with 0 gaps and 0 duplicates. The latency line has room to spare. The Postgres line (2 cores) is missed once partial text is counted.

### 2.2 Recorded sessions: SKIPPED

| Check (RUN) | Result |
|---|---|
| Synthetic session: every kind in ostra's union, plus a kind this build has never heard of | PASS. 30 of 30 kinds found in the DOM: the 29 in the union (`SPIKE/src/shared/events.ts:58-138`) and one unknown. 0 "problem" rows |
| Real OpenCode captures from spike 1: 2 sessions, message and thought chunks only | PASS. Two files of 13 and 4 lines, 17 in all = 13 mapped + 4 ignored by design + 0 unknown + 0 not JSON. Unknown (0) = `agent.unknown` events (0) = unsupported rows on the page (0) |
| Recorded sessions from spike 1 | **SKIPPED**: needs `*.jsonl` or `*.json` recordings from spike 1 |

- **The synthetic check is typed.** The DOM check table is a `Record` over the whole event union, so a new kind without a check is a compile error (`SPIKE/src/harness/checks-browser.ts:184-221`). It includes a stored kind this build doesn't know, written straight into the table (`checks-browser.ts:171-179`), and an `agent.unknown` event.
- **How "nothing is dropped silently" is made testable.**
  - The ACP mapper counts every line in exactly one of mapped, ignored by design or unknown. An unknown also becomes an `agent.unknown` event (`SPIKE/src/producer/acp-map.ts:11-15`).
  - The page shows an unknown, or a stored kind it doesn't know, as an "unsupported" row (`SPIKE/src/shared/fold.ts:544-551`; `SPIKE/src/shared/events.ts:144-152`).
  - An update that matches nothing becomes a visible "problem" row (`fold.ts:308-310,409-498`).
  - The replay check demands `lines = mapped + ignored + unknown + not JSON`, and unknown = `agent.unknown` events = unsupported rows (`checks-browser.ts:765-766`).
- **Why it stays SKIPPED.**
  - Spike 1 has no `recordings/` folder. I listed `spikes/how-should-the-runner-drive-opencode/`. The harness reads only `.runs/<run>/events.json` there (`SPIKE/src/producer/replay.ts:108-127`), and two exist: probe captures of 5,235 and 1,752 bytes (13 and 4 lines).
  - RUN says it: the captures "hold no tool call, permission request or plan, so they do not stand in for this".
  - Spike 1 also has captures with tool calls, under another file name that the harness never reads. `.runs/run-2026-11-18T18-39-28-7a23/t5-events.json` (46 records, 27,808 bytes) holds 8 `tool_call`, 19 `tool_call_update`, 2 `compaction_update` and 10 `compaction_summary_chunk` records, in the same `session_update` and `prompt_finished` record shape. They come from OpenCode driven by a scripted model (spike 1's stubs, `spikes/how-should-the-runner-drive-opencode/README.md:37`; its T5 case, `README.md:120`). I ran spike 7's own `parseRecording` on that file with a throwaway script outside the repo, without the page: 46 lines = 26 mapped + 9 ignored by design + 11 unknown + 0 not JSON. The 9 ignored are 7 `in_progress` updates of tools that aren't `execute`, one `available_commands_update` and one `usage_update`. The 11 unknown are the 10 `compaction_summary_chunk` records and one `compaction_update`. The `t5-events.json` of run `18-10-56-5aa0` gives the same counts. So the mapper's tool path has now met real OpenCode output, and the page has not. Whether those 39 events render is untested, and the mapper counts real compaction output as unknown.
  - `.runs/run-2026-11-18T18-39-28-7a23/t8-elicitation.json` holds an elicitation request and its answer in another record shape (`elicitation_requested`). The mapper has no path for it (no `elicitation` in `acp-map.ts`). The approval path (`session/request_permission`) has run only on a hand-written 17-line fixture (`SPIKE/src/producer/fixtures/acp-session.jsonl`; `SPIKE/src/shared/fold.test.ts:155-170`), as has the plan path.
  - So the real question is still open: do the kinds OpenCode really sends render?
- **"Ignored by design" is counted and not shown.** In the two captures the harness reads, the ignored lines are `available_commands_update` and `usage_update` (RUN). The mapper ignores three kinds of line, each counted under its own name:
  - A fixed set of `session_update` kinds: `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice` and `user_message_chunk` (`acp-map.ts:86-95,324-327`). The set follows the mapping table in `research/agent-ui-stream.md`, rows 15 to 19 (`acp-map.ts:86`), except that the table maps `current_mode_update` and `config_option_update` to `session.config_changed` (row 16), a kind the union has (`SPIKE/src/shared/events.ts:129`). The mapper drops them, so mode, config and usage changes never reach the page this way.
  - Any JSON-RPC message that isn't a `session/update`, a prompt or a permission request (`acp-map.ts:224-227`).
  - A `tool_call_update` that isn't completed, failed, or an `execute` tool in progress (`acp-map.ts:288-291`). Row 7 of the mapping table maps `in_progress` updates with content to `tool.progress`, and the mapper does it for `execute` only. This is 7 of the 19 `tool_call_update` records in `t5-events.json`.

### 2.3 Reload and drop: PASS

| Check (RUN) | Result |
|---|---|
| A reload mid-message shows the partial text again within 1 s | PASS. 5 reloads: 114, 110, 118, 124, 122 ms to the first words on screen. The text was never shorter than before |
| A 10 s drop (sockets reset) mid-turn | PASS. 243 events on the page, equal to database head 243. 0 gaps, 0 duplicates. 20 reconnect attempts. The thread text is identical to a page that never dropped |
| A 10 s black hole (sockets open and silent) | PASS. The page showed "live" with 0 EventSource errors. Its watchdog noticed after 20.1 s and opened a new stream with `Last-Event-ID` 61. 442 events, equal to head 442. 0 gaps, 0 duplicates |
| `Last-Event-ID` stays on the newest committed event across untracked live frames | PASS. 56 live frames flowed. All 20 reconnect attempts sent `Last-Event-ID: 61`, the newest committed seq at the cut |
| A dropped stream resumes on the other replica | PASS (Node client). Cut at seq 160 of 400. The joined sequence is 1 to 400, contiguous |
| Partial text is shown to every viewer and never saved | PASS. 12 partial frames reached the early viewer. 0 completed messages stored while the segment was open. The live row existed and was deleted by the commit |
| A late joiner on the other replica gets a snapshot | PASS. First frame: offset 0, 294 characters |
| Two viewers on two replicas get the same events in the same order as history | PASS. 45 and 45 of 45. Replica B, polling once a minute, received 6 NOTIFY wake-ups, and its viewer saw every event within p99 51 ms |
| Saving is idempotent by the runner's sequence number, and a gap is refused | PASS. A resend of 3 events accepted 0 and counted 3 duplicates. A batch that skipped to runner seq 6 was refused as a gap, expecting 4. 3 events stored |

Source: RUN, `[A reload shows the partial text...]` and `[Key parts...]`; `SPIKE/src/harness/checks-browser.ts:429-596`; `SPIKE/src/harness/checks-api.ts:275-419`.

- **What "reload" measures.** The time from `page.reload` to the text "the quick" visible in the streaming row, in headless Edge on loopback, unthrottled (`checks-browser.ts:441-444`).
- **The two drops.**
  - A toggle proxy in front of the server makes them. `cut` destroys every socket. `blackhole` keeps the sockets open and moves no bytes (`checks-browser.ts:470-473`).
  - These are simulated. A real Wi-Fi roam or NAT rebind hasn't run.
  - Only headless Edge ran (RUN, `finding: browser`). The reconnect behaviour of Chrome, Firefox and Safari is **unverified**.
- **Why the design works.**
  - The spec makes `Last-Event-ID` only what the user agent reports when it reestablishes a connection. An event without an `id` field leaves the stored value alone ([WHATWG HTML, server-sent events, 9.2.4 and 9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html): "the last event ID string of the event source remains set to this value").
  - ostra sends committed events with `id: <seq>` and live frames with no id (`SPIKE/src/server/tailer.ts:60-61`; `SPIKE/src/server/sse.ts:26-33,43-44`). That is why the page's resume point never moves onto a partial.
  - The `retry` field sets the reconnection time (same spec, 9.2.6). The server sends `retry: 500` (`sse.ts:159`).

### 2.4 Watcher and approval: PASS

| Check (RUN) | Result |
|---|---|
| A watcher can't send or interrupt by the API | PASS. Non-driver member 403, read-only viewer 403, signed out 401, non-driver interrupt 403. The rejected calls wrote 0 events and 0 commands |
| A read-only viewer can't take over or interrupt | PASS. 403 and 403. 0 events, 0 `driver.changed`, 0 commands |
| A runner can't write a member's message, and ingest needs the runner token | PASS. Forged `user.message` 403, no token 401 |
| Two members answer one approval | PASS. 25 races of 3 simultaneous answers, sent to alternating replicas (separate processes). Each had one winner, one `approval.answered` event and one queued command |
| A read-only viewer can't answer | PASS. 403 |
| Take over is a compare-and-set | PASS. Statuses 200 and 409. The new driver's send 200, the previous driver's 403. One `driver.changed` event |
| In the UI | PASS. The driver sees 1 composer. A watcher sees 0 composer or send controls and the bar "alex is driving · Take over". A read-only viewer sees 0 composers, 0 take-over buttons, 0 approval buttons and "Waiting for approval" |
| Take over in the UI | PASS. Both pages switched within 50 ms |
| Two clicks on one approval at once | PASS. Responses 200 and 409. All three pages show "Approved once by sam" |
| A retried send with the same client message ID | PASS. One `user.message` |

Source: RUN, `[A watcher can't send...]`; `SPIKE/src/harness/checks-api.ts:59-273`; `checks-browser.ts:297-358`.

- **Where the compare-and-set lives.** An approval answer locks the task's counter row, locks the approval row, and updates `status = 'pending' → 'answered'` with `WHERE status = 'pending'`. Zero rows updated means 409, with the winner's name (`SPIKE/src/server/app.ts:382-401,432-437`). The answer event and the runner command commit in the same transaction (`app.ts:403-425`), as ADR 0011 wants.
- **The UI only hides.** The page passes no `onRespondToToolApproval` to a member who may not answer (`SPIKE/src/web/task-page.tsx:207-214`). The server rejects each call on its own (`app.ts:282-284,315-317,331,380`).
- **What isn't covered.** `question.answer` isn't built, so a watcher answering a question isn't tested (RUN, the read-only viewer row). Identity is a stand-in with two roles, `member` and `viewer`, and no organization or project (`SPIKE/src/server/app.ts:131-166`; `README:194`).

### 2.5 Render: FAIL

| Shape (RUN) | Throttled 4x, three loads | Median | Unthrottled |
|---|---|---|---|
| 100 turns x 50 events: 100 messages, 2,000 tool rows, 4 to 20 KB command outputs on every 5th command | 1,937, 2,195, 2,038 ms | **2,038 ms** (FAIL) | 476 ms |
| 500 turns x 10 events: 500 messages, 1,500 tool rows | 1,918, 1,876, 1,977 ms | **1,918 ms** (FAIL) | 455 ms |
| 1 turn x 5,000 events: one message, 2,499 tool rows | 1,409, 1,384, 1,537 ms | **1,409 ms** (PASS) | 368 ms |

Source: RUN, `[5,000 events render in under 1.5 s.]`; `SPIKE/src/harness/checks-browser.ts:600-670`.

- **What is timed.** From navigation to the moment every message and every tool row is in the DOM (`SPIKE/src/web/task-page.tsx:245-261`). That mark is set inside a `requestAnimationFrame` callback, so it is a frame boundary and not a paint (inferred). It counts the history fetch. The history was fetched at 363 to 419 ms in all nine throttled loads (RUN), which is 17% to 28% of the time (my division, load by load).
- **The throttle is the spike's own stand-in.** The bar names no device. The harness sets the CPU throttle to 4 through the DevTools Protocol (`checks-browser.ts:37-39,113-116`) and takes the median of three loads (`checks-browser.ts:629-647`). The protocol describes the `rate` of `Emulation.setCPUThrottlingRate` as "Throttling rate as a slowdown factor (1 is no throttle, 2 is 2x slowdown, etc)" ([`browser_protocol.json`](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)). So 4 is a 4x slowdown of this machine's CPU, not a measured laptop.
- **It looks CPU-bound.** Each throttled median is 3.8 to 4.3 times the unthrottled one (RUN, my division). Unthrottled, all three shapes take under 0.5 s.
- **It isn't stable between runs.** The README gives medians for three earlier runs of the same code today. Shape 1: 2,964, 1,809 and 1,805 ms. Shape 2: 3,446, 1,825 and 1,592. Shape 3: 1,518, 1,204 and 1,173 (README, not rerun: `SPIKE/README.md:147-149`). Across those runs and mine, shapes 1 and 2 missed 1.5 s all four times. Shape 3 passed in 3 of 4.
- **The fold isn't the cost.** At the end of the latency run, one fold of a 6,000-event log took 2 ms in the page, and a flush to the next frame 22 ms (RUN, the latency row). The fold reuses the object identity of unchanged messages (`SPIKE/src/shared/fold.ts:18`; `SPIKE/src/shared/fold.test.ts:90-96`). A Node unit test bounds a 5,000-event fold at under 500 ms (`fold.test.ts:144-152`).
- **Where the time goes was not measured** (README, not rerun: `SPIKE/README.md:181`). The Zod parse of the history, the fold, assistant-ui, React and layout are not separated.
- **No virtualization.** RUN says "no virtualization". ADR 0036 says row virtualization comes only if spike 7 needs it, and needs a yes first (`ADR36:41`).
- **The default view is far cheaper.** The newest 20 turns (1,000 events, 20 messages) rendered in 213 ms, unthrottled (RUN, `finding: the default view of a long task`). The history query defaults to 20 turns (`SPIKE/src/server/app.ts:211`). A throttled run of the default view wasn't done.
- **What the bar's fallback says.** "If assistant-ui fails, render with AI Elements" (`PASSBAR`). Nothing here shows assistant-ui to be the layer that costs. The AI Elements fallback wasn't built (README, not rerun: `SPIKE/README.md:231`).

### 2.6 Strict typecheck, lint, no third party: PASS

| Check (RUN) | Result |
|---|---|
| Strict typecheck | PASS. `tsc --noEmit`: 0 errors, with every flag AGENTS.md lists, plus `erasableSyntaxOnly` |
| Lint | PASS. 0 errors, 0 warnings. `strict-type-checked`, `stylistic-type-checked`, exhaustive switches, no `any`, no `!`, `as` only as `as const`, `no-deprecated`, no classes |
| Only documented suppressions | PASS. 0 suppressions in 57 files |
| Unit tests | PASS. 18 passed |
| The page calls no third party | PASS. 366 requests across 26 pages. 0 requests to any host but this machine. 0 to `assistant-api.com` or `assistant-ui.com` |
| Hostile agent content renders inert | PASS. 0 foreign requests, 0 `<img>` that isn't an inline `data:image`, 0 `javascript:` links, 0 `<script>` in the thread, 0 inline handlers, 0 dialogs. 1 remote image shown as "Image not shown" |
| Safe by default | PASS. `/api/dev-login` is 404 on a default server. A server with the dev login on and `HOST=0.0.0.0` refuses to start. `/metrics` is 401 without the runner token. A 5-character runner token is refused |
| A session token is stored only as its SHA-256 | PASS. 0 rows hold the cookie value, 1 holds its hash |
| Bad input is a 4xx, never a 500 | PASS. A fractional or negative `after`, a path with a stray `%`, an interrupt with no body or an unknown field |

Source: RUN, the policy blocks; `SPIKE/tsconfig.json:3-23`; `SPIKE/eslint.config.js:6-43`; `SPIKE/src/harness/checks-static.ts:49-126`; `checks-browser.ts:846-862`.

- **Zero suppressions is a stricter result than the bar asks.** ESLint runs with `noInlineConfig`, so an inline disable can't exist (`eslint.config.js:10`). The harness then scans every `.ts`, `.tsx` and `.js` file for `ts-ignore`, `ts-nocheck` and an undescribed `expect-error` (`checks-static.ts:41-45,89-113`).
- **How the network check works.** The harness aborts any request to a host that isn't loopback and counts it (`checks-browser.ts:98-111`). The hostile session hands the page a remote image, an `<img onerror>`, a `javascript:` link and a `<script>` aimed at `third-party.invalid`, so a page that never met one can't pass (RUN, hostile-content row).
- **ADR 0036 asked for a network log to check that assistant-ui's cloud client stays idle** (`ADR36:39`). It did: 0 requests to the two assistant-ui hosts. The spike never configures that client (README: "Not used: Assistant Cloud", `SPIKE/README.md:218`).
- **The "strict" bar was met with a TypeScript one major behind** (6.0.3), as the Facts table says.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **The expensive part of the stream is the partial text, not the events.**
   - README, not rerun (`SPIKE/README.md:164-168`): at 5,000 events a second the events alone cost 1.04 cores. With partial text the total was 2.32 cores. The `UNLOGGED` table took 1,017 upserts a second carrying 2.2 MB/s of text, and cost 1.29 cores, more than the events.
   - Today's scaled run shows a smaller version: 103 upserts a second carrying 226.5 KB/s cost 0.22 cores, against 0.28 cores for the events alone (RUN, the `UNLOGGED` line and the events-only line). There the table is the smaller cost.
   - The cause is in the code. Each partial frame upserts its segment's whole accumulated text, not a delta (`SPIKE/src/server/appender.ts:213-222`). The README and two code comments (`appender.ts:214`, `load.ts:17`) say "on every flush", but the upsert runs only for a segment that has a frame in the batch, and the runner client sends each frame once (`runner-client.ts:77-78`). The runner sends the text at most every 250 ms (`ADR35:13`), and the load script sends one frame per streaming task every 250 ms (`SPIKE/src/harness/load.ts:212`), so 250 streaming tasks make about 1,000 upserts a second. A segment grows to 4,096 characters in the load script (`load.ts:61-62`).
   - The README lists cheaper variants and says none was tried: upsert less often, send deltas, or skip the table when nobody watches the task (`SPIKE/README.md:168`).
   - Postgres says an unlogged table isn't written to the write-ahead log, is truncated after a crash and isn't replicated ([PostgreSQL, CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)). That fits text nobody acts on (`ADR35:13`). It doesn't make the table free: the cost above is CPU for the rewrites. Why it costs that much is not measured.

2. **ADR 0035's fallback for this runs into a size limit.**
   - The fallback says the partial rides in the batched notification (`ADR35:68`). Postgres says: "In the default configuration it must be shorter than 8000 bytes" ([PostgreSQL, NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)).
   - The spike's wake-up carries only task IDs, sequence numbers and a live flag, and caps its payload at 7,000 bytes (`SPIKE/src/server/wake.ts:8-16`). A 4,096-character segment is about half of one payload.
   - At the full-rate text volume of 2.2 MB/s (README, not rerun), that is at least about 275 notifications a second, if each carried one full payload (inferred, my division). ADR 0035's rule is one `NOTIFY` per writer per batch window, never per event (`ADR35:19`).
   - So the fallback is a redesign, not a switch. The rule itself rests on a commit lock that the NOTIFY page doesn't mention. I read the page again today and found none. The spike 6 study made the same note (`context/research/spike-runner-transport.md`, gotcha 15). This spike sends one `NOTIFY` per batch, and more than one only when a batch's payload passes 7,000 bytes (`wake.ts:27-47`), so it doesn't test the rule.

3. **Rows have to subscribe to their own part, or a long task gets slow as it grows.**
   - README, not rerun (`SPIKE/README.md:132,182`): when every row read the part index through a React context that changed on every flush, each flush re-rendered every row. The per-row cost went from 50 ms to 550 ms as the log grew, and p99 reached 667 and 792 ms at 200 events a second.
   - With a small store and a per-row subscription, today's run gives p99 139 ms, and the last 500 rows p50 98 ms against 51 ms for the first (RUN, the latency row). The cost still doubles from the first rows to the last. It doesn't blow up.
   - The code: `SPIKE/src/web/task-context.ts:14-16,68-81`; the page refolds the whole log on every snapshot (`SPIKE/src/web/task-page.tsx:152-158`).

4. **A stock Send can't queue mid-turn.**
   - RUN: "Send button disabled while running: true; a POST /send fired after clicking Send: false". This answers the open item in ADR 0036 (`ADR36:72`).
   - assistant-ui's docs agree: "By default, sending while the thread is running is disabled", and a `queue` adapter buffers a message sent during a run ([assistant-ui, external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)).
   - The spike built the server side (`delivery: queued`, `SPIKE/src/server/app.ts:286`) and an "Interrupt and send" button (`task-page.tsx:116-127`). The queued send has no button (README, not rerun: `SPIKE/README.md:228`).

5. **The AI SDK's tool states can't carry a request that closed without a decision.**
   - The docs list seven tool states: `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-error` and `output-denied` ([AI SDK, tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)). None is "cancelled" or "expired".
   - The fold works around it. It carries the options and the receipt in `toolMetadata`, so a closed request still shows its receipt (`SPIKE/src/shared/fold.ts:98-103`; `SPIKE/src/web/convert.ts:46-62`).

6. **EventSource doesn't notice a black hole, and a comment keepalive can't help.**
   - RUN: the page showed "live" with 0 errors until its own watchdog fired at 20.1 s.
   - The spec ignores comment lines: "If the line starts with a U+003A COLON character (:)", the instruction is "Ignore the line" ([WHATWG](https://html.spec.whatwg.org/multipage/server-sent-events.html), 9.2.6). The spec's own advice is a comment every 15 seconds or so, to keep a proxy from dropping the connection (9.2.7). That keeps the TCP flow alive. It doesn't tell the page's JavaScript anything.
   - So the server sends a named `ping` event every 15 s (`SPIKE/src/server/sse.ts:21-24`; `SPIKE/src/server/app.ts:260-262`), and the page reconnects after 20 s without a frame (`SPIKE/src/web/task-stream.ts:33-36,217-226`).
   - tRPC's docs name two settings that point the same way: "keep `sse.ping.intervalMs` lower than `sse.client.reconnectAfterInactivityMs`" ([tRPC, subscriptions](https://trpc.io/docs/server/subscriptions), "Common mistakes"). The spike used plain SSE, not tRPC. Whether tRPC's own link survives the black hole is **unverified**.

7. **Assistant-ui takes a system message only with one text part.** ostra's system rows are `data-*` parts, so the converter hands them over as completed assistant-role messages, and the page styles them from ostra's own role (`SPIKE/src/web/convert.ts:120-125`; README, not rerun: `SPIKE/README.md:174`). The docs name the `system` role in the type and give no guidance for it ([assistant-ui, external store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)).

8. **Seconds of difference between runs of the same code.** Medians in the render check moved from 1.2 s to 3.4 s across today's runs (section 2.5). Together with the README's note about other work on the machine (`SPIKE/README.md:119`), a single run is not a reading of the bar.

**Gotchas**

9. **The driver check in send and interrupt happens before the transaction (inferred; not run).**
   - `handleSend` loads the task and checks the driver at `app.ts:280-284`. It opens the transaction at line 287. Inside, the appender locks the counter row (`appender.ts:53-58`) but never re-reads `tasks.driver_member_id`. `handleInterrupt` has the same order (`app.ts:314-318`).
   - Take-over locks the counter row and flips the driver in one transaction (`app.ts:332-350`). So a send that passed the check just before a take-over commits can land after the `driver.changed` event, as a message from the former driver.
   - The window is one request. The README says "the approval, take-over and send mutations lock the same counter row first" (`SPIKE/README.md:183`). That holds for take-over and approvals. For send and interrupt, the lock comes after the check.
   - The fix is to read the driver under the counter lock inside the transaction. A contract test would race a send against a take-over.

10. **A page-made `EventSource` can't send the header, so the cursor travels in the URL too.** The page's reconnect opens a new `EventSource` with `?lastEventId=` (`task-stream.ts:195`). The server reads the header first and the query second (`app.ts:192-197`). The spec describes the header only as what the user agent sends when it reestablishes a connection ([WHATWG](https://html.spec.whatwg.org/multipage/server-sent-events.html), 9.2.4). That a new object can't set it is inferred.

11. **Some failures are counted and not shown.**
    - The page counts a frame that fails even the loose schema, as `invalidFrames`, and drops it from the view (`task-stream.ts:144-148`). That counter is readable only from the diagnostics object.
    - A live delta that doesn't line up is ignored until the next snapshot (`task-stream.ts:180-185`). That is display only.
    - Neither is a gap in the log. The page counts a gap in committed `seq` separately (`task-stream.ts:156`).

12. **The wake-up is sent after the commit, on another connection.** `pg_notify` runs as a plain query once the batch has committed (`SPIKE/src/server/server.ts:35-39`; `wake.ts:43-52`). A failure is logged, and the 250 ms poll covers it (`wake.ts:48-51`; `tailer.ts:258-265`). No check drops the NOTIFY, so the latency of the poll-only path isn't measured. Replica B ran with a 60 s poll in the two-viewer check, which shows the NOTIFY path works across processes (`SPIKE/src/harness/context.ts:138`; RUN, two-viewer row).

13. **A slow viewer is cut at 8 MB unsent, and resumes by seq.** It is built and not exercised (`SPIKE/src/server/sse.ts:9,60-66`; README, not rerun: `SPIKE/README.md:230`). RUN shows 0 slow-viewer disconnects.

14. **The stream authorizes by "signed in" only.** `handleStream` loads the task and starts the stream (`app.ts:248-251`). Its 30 s timer checks that the member row still exists (`app.ts:253-259`). ADR 0035 says every message is filtered again by organization and project access (`ADR35:39-40`). The spike has no organization or project, so that part is untested.

15. **The history window is by turn.** The default is the newest 20 turns, and "Load earlier turns" pages back (`app.ts:206-246`; `task-page.tsx:297-301`). This matches ADR 0035's "paged by turn, reading backwards" (`ADR35:14`).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

1. **Decide what the render bar means, then fix the bar or the page.**
   - Add a question to `context/open-questions.md`. The highest number there is Q110, so the next free number is Q111. It asks: on which device, and for which view, must 5,000 events render in 1.5 s? As written, the bar has no device, and the answer to "pass" depends on a throttle the spike chose.
   - Options, none tried: window the thread (ADR 0036 needs a yes for `@tanstack/react-virtual`, `ADR36:41`), make the newest 20 turns the thing the bar measures (213 ms unthrottled), or profile the layers first (section 2.5).
   - Don't swap to AI Elements on this evidence. The bar's fallback is for assistant-ui failing, and no layer was shown to be the cost.
   - Reword `context/build-order.md:159` once decided, for example: "the default view of a 5,000-event task renders in under 1.5 s on the reference laptop".

2. **Amend ADR 0035 with the partial-text cost, and say what to try before the fallback.**
   - Record the README's one-off (2.32 cores at 5,000 a second with partial text, against 1.04 without) and today's scaled run (+0.22 cores for the table, over 0.28 cores for the events alone). Only the one-off shows the table costing more than the events, and it is the README's, not rerun.
   - List the cheaper variants as the first step: upsert less often, send deltas, skip the table when nobody watches (`SPIKE/README.md:168`).
   - Rewrite the fallback at `ADR35:68`. A notification must be under 8,000 bytes, so "the partial rides in the batched notification" needs a size rule and a rate estimate (finding 2).

3. **Run the bar's shape on the Linux host before the ADR is final.** `pnpm load --full`, with and without partial text, three server processes. F-117's load test (`context/features.md:226`) should also put browsers on the receiving end for a sample of the viewers, and use the event rates spike 1 recorded. Today's load events are synthetic (section 2.1).

4. **Reword the load bullet of `PASSBAR`** (`context/build-order.md:155`) so its two legs are explicit: runner to the stream's viewer at 5,000 events a second, and runner to a DOM row for a sample of browsers. Say whether the Postgres line counts partial text. The spike judged it with partial text on 1 task in 4 (`load.ts:412`).

5. **Amend ADR 0035's "To the browser" with the keepalive rule** (`ADR35:25-28`).
   - A named `ping` event every 15 s, and a client watchdog that reconnects from the last committed seq after 20 s without any frame (section 3, surprise 6).
   - Test the same black hole against tRPC's own link and its `sse.ping` and `sse.client.reconnectAfterInactivityMs` settings, as the follow-up to this spike that the README already lists (`SPIKE/README.md:227`).

6. **Amend ADR 0036 with what the spike settled.**
   - Close the open item at `ADR36:72`: a stock Send is disabled while a run is active and never calls `onNew`. ostra needs its own Send button, or assistant-ui's `queue` adapter. ostra queues on the server either way.
   - Add that system rows must be assistant-role messages with data parts, that closed approvals ride in `toolMetadata`, and that rows must subscribe to their own part (surprises 3, 5 and 7).
   - The README adds two smaller notes: `aui.composer()` is deprecated in 0.15.36 and the property form is the supported one, and the composer leaves a hidden measuring `<textarea aria-hidden>` that tests must ignore (README, not rerun: `SPIKE/README.md:178-179`).

7. **Close the driver race in the send and interrupt mutations** (gotcha 9). Read the driver under the counter lock, inside the transaction, as take-over and approvals already do. Add a race test to F-024's tests. F-024 reads "Any member of the project can take over... and everyone else watches" (`context/features.md:134`).

8. **Decide whether "ignored by design" may hide usage, mode and tool-progress updates** (section 2.2).
   - The mapping table in `research/agent-ui-stream.md` maps `current_mode_update` and `config_option_update` to `session.config_changed` (row 16), a kind the event union has (`SPIKE/src/shared/events.ts:129`). The mapper departs from the table there.
   - The table maps `usage_update` to task state `usage` (row 18), and the union has no kind for that. If the panel should show the agent's usage, the union needs one. If ostra meters at its model proxy (ADR 0042), say that the panel never shows the agent's own usage.
   - The mapper drops `in_progress` updates of tools that aren't `execute`, where row 7 maps `in_progress` updates with content to `tool.progress`.

9. **F-rows.**
   - F-023 (live activity), F-024 (steer), F-026 (approvals): no change to the text. The spike is throwaway code, so they stay `planned`.
   - F-081 (accessibility): no axe or keyboard pass ran (README, not rerun: `SPIKE/README.md:229`). It stays open.
   - F-117: the changes in item 3.

10. **Record the approval of dependencies the spike used.** AGENTS.md says to ask before adding a dependency. `embedded-postgres` is named in no ADR and `vite` isn't in ADR 0007's table. The README asks for a yes (`SPIKE/README.md:220`). Three other spikes use `embedded-postgres` too (a search of `spikes/*/package.json` finds `auth-foundation`, `durable-queue-choice` and `runner-transport`). Vitest and Playwright are in ADR 0007 (line 22).

11. **Pin the newer `ai` and `@assistant-ui/react` once they are a day old.** Both are newer on npm today (7.0.176 and 0.15.37). The spike pinned the older pair because pnpm 11's supply-chain policy refuses versions under a day old (README, not rerun: `SPIKE/README.md:195`). Nothing in these checks needed the newer pair.

12. **No change.**
    - **ADR 0017 holds.** Postgres alone carried the log, the live text and the wake-ups (`SPIKE/src/server/schema.ts:31-54`; `SPIKE/src/server/wake.ts:27-52`), with no Redis and no second service (README, not rerun: `SPIKE/README.md:218`).
    - **ADR 0035's fan-out holds at the scaled shape.** One tailer per replica and one `LISTEN` connection each (`SPIKE/src/server/server.ts:18-39`) delivered every event to 200 viewers with p99 56 ms (RUN, scaled run). The Centrifugo fallback isn't triggered. It isn't ruled out at 5,000 a second either, because nothing here ran viewers at that rate on a Linux host.
    - **Q23 holds.** Partial text was shown and never saved: 0 completed messages stored while a segment was open, and the live row was deleted by the commit (RUN).
    - **Q50 holds.** The AI SDK's types as the view model and assistant-ui's external store as the runtime carried every event kind. The fold is renderer-neutral, so the AI Elements swap stays cheap if it is ever needed (`ADR36:53`).
    - **The failure suite for the stream** (resume by seq, idempotent save, gap refusal, one approval winner across processes) held as ADR 0035 and ADR 0036 wrote it.

13. **Keep spike 7 open in `context/build-order.md`.** Two checks FAIL and two are SKIPPED. The bar is not met.

---

## 5. What's still open

**SKIPPED in today's run (2 checks, in 2 criteria).**
- **The load bar's own shape (criterion 1).** Run `pnpm load --full` on a Linux host with 4 vCPU for Postgres (`SPIKE/src/harness/load.ts:403-438`). Run it with and without partial text. Put browsers, not Node clients, on the receiving end for a sample of viewers.
- **Recorded sessions from spike 1 (criterion 2).**
  - It needs `*.jsonl` or `*.json` files in `spikes/how-should-the-runner-drive-opencode/recordings/` or in `OSTRA_SPIKE_RECORDINGS_DIR`. The format is in `SPIKE/README.md:59-69`. Spike 1's `t5-events.json` captures already have the record shape, but not the folder or the file name the harness reads. Copies in a folder named by `OSTRA_SPIKE_RECORDINGS_DIR` would be read (inferred from `replay.ts:99-106`; not run).
  - The sessions should hold a tool call, a permission request and a question. The two `events.json` captures lack all three, and `t5-events.json` has tool calls only. A plan can't come from OpenCode: spike 1 found that OpenCode 2.3.2 sends no `plan` update over ACP, and the todo list arrives as a `todowrite` tool call (`spikes/how-should-the-runner-drive-opencode/README.md:120,164`).
  - Then run `pnpm spike`. The mapper then needs fixing against what OpenCode really sends: message IDs, command output, permission options and elicitation (README, not rerun: `SPIKE/README.md:224`), and the compaction records that `t5-events.json` shows as unknown (section 2.2).

**FAIL today (criterion 5).** The render budget needs a decision first (section 4, item 1), then a profile of where the time goes. A mid-range laptop should replace the 4x throttle as the reference (README, not rerun: `SPIKE/README.md:229`).

**Not covered, though the bar or the ADRs ask for it or the README lists it.**
- Plain SSE was tested, not a tRPC v11 subscription with `tracked()`. tRPC's docs say the client "will automatically reconnect when it gets disconnected and send the last known ID" ([tRPC](https://trpc.io/docs/server/subscriptions)). That `httpSubscriptionLink` keeps the id across untracked frames is **unverified** (`ADR35:67`; `SPIKE/README.md:191,227`).
- Raw SQL through `pg` was tested, not Prisma 7. "Prisma 7 with an `UNLOGGED` table in a raw migration" is **unverified** (`ADR35:69`; `SPIKE/README.md:192`).
- Vite, not Next.js 16. No shadcn kit, no brand work, no `@tanstack/react-virtual`, no AI Elements (README, not rerun: `SPIKE/README.md:193`).
- A queued-send button, `question.answer` with its API test, and "approve for this task" as an ostra rule (README, not rerun: `SPIKE/README.md:228`).
- Project-level authorization on the stream (gotcha 14).
- The poll-only latency with notifications off, and a lost `NOTIFY` (gotcha 12).
- Browsers other than headless Edge, and macOS and Linux. Only Windows has run (README, not rerun: `SPIKE/README.md:86`).
- An axe and keyboard pass (F-081).
- Longer and harsher runs: a multi-hour soak, a slow viewer, a Postgres restart under load, a replica killed mid-stream, and a hard kill of the harness on Linux or macOS (README, not rerun: `SPIKE/README.md:230`).
- ADR 0034's WebSocket carrier into this server. The producer here uses HTTP batches (section 2.1).

**Decisions the spike can't make:** the render budget and its device (section 4, item 1), what to do about the partial-text cost (item 2), whether "ignored by design" may hide usage, mode and tool-progress updates (item 8), and the approval of `embedded-postgres` and `vite` for spikes (item 10).
