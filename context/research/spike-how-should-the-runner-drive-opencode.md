# Research: Spike 1, `how-should-the-runner-drive-opencode`: can ostra's own ACP driver run OpenCode for real work, through the key proxy, on any endpoint?

**Status:** Research, 2026-11-18. Feeds ADR 0032 (OpenCode first, own ACP driver), ADR 0018 (the agent interface), ADR 0030 (the key proxy and the box), ADR 0033 (model providers), ADR 0036 and F-026 (approvals), ADR 0042 (metering), ADR 0029 (executors), ADR 0039 (idle timer) and F-019, F-024. Tests the decisions behind Q11, Q45, Q51, Q52 and Q103 (`context/build-order.md:87`). It rests on the test list in `research/rivet.md`.
**Method:**
- I ran `pnpm spike` once in `spikes/how-should-the-runner-drive-opencode/`, on 2026-11-18, on Windows 11 Pro (build 26200) with Node 24.14.0 and pnpm 11.28.2. The run folder is named `run-2026-11-18T18-39-28-7a23` (start 18:39:28Z) and its report was written at 18:44:08Z, so the run took 4 min 40 s. The exit code isn't stored. The report holds a FAIL bullet (B1) and no uncaught error, and the harness exits 1 in that case (`SPIKE/src/harness/spike.ts:148-150`), so it exited 1 (inferred). Every result marked "RUN" comes from that one run.
- I did not run `SPIKE_LONG=1`, so the 20-minute turns didn't run. This machine has no Docker (`docker` isn't on its `PATH`), and I have no Mac, so the Linux-container and macOS runs didn't happen either. I did not re-run `pnpm typecheck`, `pnpm lint` or `pnpm test`: `pnpm spike` doesn't run `tsc` first (`SPIKE/package.json:12`), and this is a finding, not a code change.
- Processes: the harness's own final sweep found 1 leftover process (RUN, `report.json` `leftovers: 1`; the console line is `spike.ts:142`). A search of every process for the spike's folder, the run's marker (`18-39-28-7a23`) and any image named `opencode*`, made after the run and repeated at review, found none. The research itself killed nothing.
- The code that ran is the committed code. The spike is commit `bb42e40` ("add spike 1: OpenCode over ostra's ACP driver"), committed 2026-11-18T18:39:07Z, 21 s before the run began, and `git status` and `git diff HEAD` show no change to any tracked file under the spike. The newest file under `SPIKE/src` was written at 18:32:05Z (`SPIKE/src/lib/stub-models/server.ts`) and `SPIKE/README.md` at 18:37:41Z, both before the run began (file times).
- I read the docs I cite on 2026-11-18: OpenCode's ACP, permissions, server, providers, config and CLI pages; OpenCode's published OpenAPI document (downloaded and read locally); the ACP protocol pages and the elicitation RFD; the ACP SDK's own migration note in the installed 2.7.0 package; Microsoft's pages on job objects and `taskkill`; and the Linux kernel's cgroup v2 page. Versions and licenses are from the npm registry.
- Anything from the README that I didn't re-run is marked "README, not rerun". Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a primary source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/how-should-the-runner-drive-opencode`. A cite like `SPIKE/src/cases/t7-permissions.ts:209-215` is a file and its lines.
- `RUN` means the output of today's `pnpm spike`, cited by case and check name. Its structured copy is `SPIKE/.runs/run-2026-11-18T18-39-28-7a23/report.json`, with `status.md` beside it. `.runs/` is gitignored (`SPIKE/.gitignore:3`), so it stays on this machine.
- `PASSBAR` means the spike's pass bar, `context/build-order.md:85-94`. `README` means `SPIKE/README.md`. `RIVET` means `context/research/rivet.md`, whose test list is at lines 480-498. `ADR32` means `context/decisions/0032-opencode-first-own-acp-driver.md`, and `ADRnn` the ADR with that number.

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| OpenCode V2 | 2.3.2, exact pin | MIT | The `@opencode/cli` package. The binary came from `@opencode/cli-windows-x64@2.3.2`, SHA-256 `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3`. `initialize` reported 2.3.2 | `SPIKE/package.json:22`; RUN, T1; npm registry, `@opencode/cli/2.3.2` |
| OpenCode 1.x, control only | 1.19.6 | MIT | The npm `opencode-ai` package. Its `latest` tag is 1.19.6, so the V2 line is a different package | `SPIKE/package.json:27`; npm registry, `opencode-ai` |
| ACP SDK | `@agentclientprotocol/sdk` 2.7.0, exact pin | Apache-2.0 | The driver imports its `/unstable` entrypoint | `SPIKE/package.json:21`; `SPIKE/src/lib/acp-driver.ts:17`; npm registry, `@agentclientprotocol/sdk/2.7.0` |
| Model endpoint | the one in `model.env` | n/a | Detected as Anthropic Messages format. I print no value from `model.env` | RUN, B3, "endpoint format = anthropic" |
| Machine | Windows 11, release 10.0.26200, no WSL; Node 24.14.0 | n/a | The harness reports the platform itself | RUN, B1, platform line; `SPIKE/src/harness/pass-bar.ts:35-41` |

---

## 1. The question, and the answer

**Question.** Can ostra's own driver, on the official ACP SDK, run OpenCode for real work through the key proxy, on any endpoint? It tests Q11, Q45, Q51, Q52 and Q103 (`PASSBAR`; `README:5-9`).

**Answer.** Yes on Windows 11, with two capability gaps and one containment gap. The bar as written isn't met, and it can't be fully answered on this machine. The run came out B1 FAIL, B2 SKIPPED, B3 PASS, B4 SKIPPED, B5 PASS (RUN, "pass bar"). The driver, on `@agentclientprotocol/sdk` 2.7.0 over stdio, ran OpenCode 2.3.2 through a per-task key proxy against a custom OpenAI-compatible provider, a catalog provider in each API format and the `model.env` endpoint. That endpoint speaks Anthropic's format, so the OpenAI format ran only against the scripted stub (RUN, B3, T3). In the two stub runs, the agent's shell held only the fake key. The proxy's token count matched OpenCode's own count to the token (0.0% off) on the endpoint and matched the stubs exactly. A question reached the driver and its answer reached the model, a cancel returned in 543 ms, and no process survived 10 cancels. Ten tasks ran on one runner with a 5 s stall and lost no event, and a killed agent resumed with `session/load`. Three things fail on this machine. OpenCode sends no ACP plan, and its HTTP API has none either. A reject over ACP ends the turn as `cancelled`, where over the HTTP API a reject with a message lets the agent continue. And a crash leaves a detached helper process alive. A box, a job object or a cgroup should contain it, but none of them ran here. The bar says that if a capability fails over ACP, try the HTTP API, and if that fails too, the choice of default agent is reopened. The HTTP API rescues the reject and not the plan. Read strictly, the plan triggers the reopening. I recommend against it, because ostra can build the plan from OpenCode's `todowrite` tool calls itself, but that is the maintainer's decision (section 4). One finding changes ADR 0032: OpenCode 2.3.2 can steer mid-turn, over ACP and over its HTTP API (on a scripted stub, not a real model).

---

## 2. Results per pass-bar criterion

`PASSBAR` has five bullets. The harness runs them as B1 to B5. A bullet is FAIL if any check failed, SKIPPED if none failed and any was skipped, and PASS only if all passed (`SPIKE/src/harness/report.ts:27-32`). It exits 1 on a FAIL, 2 on a SKIP with no FAIL, and 0 on all PASS (`spike.ts:148-150`).

| # | Bullet | Result | What keeps it from a full PASS |
|---|---|---|---|
| B1 | T1, T3 to T11, T13, T14 and T16 pass on Linux in a container, on Windows 11 without WSL, and on macOS | **FAIL** | On Windows, T5 (plan), T7 (reject) and T13 (reap) fail, and T1, T3, T4 and T7 each have a skipped check. Linux and macOS didn't run |
| B2 | A 20-minute turn ends cleanly; a question reaches the driver and its answer the model; a cancel returns within 5 s and leaves no process | **SKIPPED** | The two 20-minute checks need `SPIKE_LONG=1`. The five other checks PASS |
| B3 | A turn completes against the `model.env` endpoint and against a local stub in each API format | **PASS** | Windows only, and one run |
| B4 | The agent's environment holds only the fake key; the proxy's count is within 2% of the endpoint's | **SKIPPED** | The `/proc` check needs Linux. The six other checks PASS |
| B5 | Recorded: events per minute, and whether OpenCode's HTTP API can steer mid-turn | **PASS** | Recorded: 448 events/min on one small turn; yes, it can steer |

Source for every result: RUN, the "pass bar" block (`spike.ts:134-136`; `pass-bar.ts:105-111`).

### 2.1 B1: the cases, on three platforms: FAIL

`pass-bar.ts:9` lists the 13 cases. Of their 59 checks (my count of the RUN rows), 51 passed, 3 failed and 5 were skipped.

| Case | Result (RUN) | Evidence |
|---|---|---|
| T1 Offline, pinned install | **SKIPPED** | PASS: `package.json` pins 2.3.2, the binary's package is 2.3.2, `initialize` reports 2.3.2. PASS: a turn ended `end_turn` with 0 outbound attempts outside the proxy, and the recorder's positive control (a `webfetch` of an `.invalid` host) was seen. SKIPPED: the packet capture, which needs Linux and `tcpdump` (`t1-offline.ts:21,45-65,88-93`) |
| T3 Any base URL and model | **SKIPPED** | PASS (a): a custom OpenAI-compatible provider with a custom model ID ended `end_turn`, the key was swapped, and `session/set_config_option` took effect on the next call. PASS (b) and (c), once per format: a catalog provider through `settings.baseURL`, then a models.dev ID set through `set_config_option` and passed through as it is (Anthropic format: `anthropic/claude-haiku-5-5` requested as `claude-haiku-5-5`; OpenAI format: `entrim/zai-org/GLM-5.3-Flash` requested as `zai-org/GLM-5.3-Flash`). SKIPPED: `/proc/<pid>/environ`, which needs Linux (`t3-any-endpoint.ts:89-122`) |
| T4 Long turn | **SKIPPED** | The 30 s short forms ran and are recorded, not counted: a tool step, a model call with keepalives and a silent model call all ended `end_turn` with contiguous `seq` and the next turn on the same connection. The 20-minute forms need `SPIKE_LONG=1` (`t4-long-turn.ts:76,93`) |
| T5 Event completeness | **FAIL** | 10 PASS: tool calls with `rawInput` and output for read, edit, shell and a failing tool; `diff` content; child-session `_meta`; `usage_update` with cost (used 10,687 of 128,000; cost 0.133242 USD); 12 compaction updates; `stopReason` `end_turn`; 44 session updates on the wire and 44 in the log. FAIL: "plan: no plan or plan_update from OpenCode 2.3.2, even with the plan capability advertised" (`t5-events.ts:87-97`) |
| T6 Concurrency and integrity | **PASS** | Ten tasks, once as ten processes and once as one shared process. A 5 s event-loop stall at 2.5 s lost no event (0 of 10 drivers, and 0 of 1, with a gap). Runner memory grew 32 MB and 11 MB (bound 150 MB). Per process, the crashed task ended `AgentExitedError` and the other nine ended `end_turn` (`t6-concurrency.ts:63-78`) |
| T7 Permissions | **FAIL** | PASS: the request carries a title, a kind, `rawInput` and a diff (options `allow_once`, `allow_always`, `reject_once`); `once` ran the tool; from the agent's own shell, 10 unauthenticated calls were all refused (section 3); the cancel-after-wait path works with the wait shortened to 5 s; a runner restart during a request is detected and the turn re-prompted. FAIL: "reject fails it and the agent continues: notes.txt unchanged; 2 requests; stopReason=cancelled". SKIPPED: the real 10-minute wait (`t7-permissions.ts:189-283`) |
| T8 Questions | **PASS** | With `elicitation.form` advertised, the question arrived as `elicitation/create` in form mode with a custom-answer field, and a free-text token that is none of the options reached the model's tool result (`t8-questions.ts:35-61`) |
| T9 Steering and interrupt | **PASS** | A second `session/prompt` mid-turn was rejected after 1 ms: `Session already has an active ACP prompt`. `session/cancel` gave `cancelled` after 543 ms. Two marked tool processes before the cancel, 0 when it returned. A new prompt recalled the earlier context (`t9-interrupt.ts:19-82`) |
| T10 Model and mode | **PASS** | `set_config_option` for the model applied to the next call, between turns and during one. `set_mode` plan, then build: in plan mode the edit did not land (0 permission requests), in build mode it landed (`t10-model-mode.ts:21-119`) |
| T11 Resume, same runner | **PASS** | After killing OpenCode, and separately the driver process, `session/load` with the same `cwd` replayed 2 updates and the agent named the earlier secret word. OpenCode exited by itself within 10 s of its driver dying. With the `model.env` endpoint the same recall worked, though that check doesn't look at the replay (`t11-resume.ts:13-25,32-70,77-100`) |
| T13 Agent crash | **FAIL** | PASS: `kill -9` was detected after 11 ms and the session was marked crashed; the workspace and branch were intact. FAIL: "the crashed agent's tool processes are reaped by the runner: 1 left by the crash, 0 reaped from the tree snapshots, 1 alive after" (`t13-crash.ts:26-75`) |
| T14 Process-tree cleanup | **PASS** | Ten turns, each cancelled with a background server and a foreground sleep running: 4 marked processes before every cancel, 0 when each returned, 40 reaped by the driver in all (every PID it killed, marked or not), 0 after the task stopped (`t14-cleanup.ts:17-62`) |
| T16 Resource use | **PASS** | Driver working set 88 MB idle and 83 MB active, against 58 MB for a bare Node process, so 30 MB of overhead (budget 50 MB). OpenCode 124 MB idle and 125 MB active. Spawn to `initialize` 270 ms, spawn to first token 986 ms against a stub (budget 3 s) (`t16-resources.ts:41-69`) |

Source: RUN, each case's block. Each case's checks are in `SPIKE/src/cases/`, in the files named after it.

**The three platforms** (`pass-bar.ts:63-71`):
- **Linux in a container: SKIPPED.** It needs Docker with `NET_ADMIN` and `NET_RAW`, then `container/run.sh` (`README:77-82`; `SPIKE/container/run.sh:27-39`). This machine has none.
- **Windows 11 without WSL: FAIL.** The harness folds the 13 cases into one status for the machine it runs on (`pass-bar.ts:61,67-69`). T5, T7 and T13 are the failures.
- **macOS: SKIPPED.** It needs a Mac.

### 2.2 B2: a 20-minute turn, a question, a cancel: SKIPPED

| Part (RUN) | Result |
|---|---|
| A 20-minute turn, a tool step | **SKIPPED**: needs `SPIKE_LONG=1`. The 30 s form ended `end_turn` |
| A 20-minute turn, one model call through the key proxy | **SKIPPED**: the same. The 30 s form: one call of 30 s, status 200, not aborted |
| A question reaches the driver | PASS: `mode=form`, with a custom-answer field |
| Its answer reaches the model | PASS: the token was found in the tool result the model received; `end_turn` |
| A cancel returns within 5 s | PASS: `cancelled` after 543 ms, the driver's reap included |
| No process left, a foreground tool | PASS: 2 marked processes before the cancel, 0 when it returned. OpenCode ended them itself |
| No process left, a background tool, 10 cancels | PASS: 4 before each, 0 after each, 40 reaped by the driver |

- **The 20-minute parts have run before, not today.** The README cites a `SPIKE_LONG=1 --only=T4` run, `run-2026-11-18T18-11-08-a662` (`README:134-142`), and I read its stored `report.json` (written at 18:31:25Z). In it, a 1,200 s tool step ended `end_turn` with contiguous `seq`, 7 updates on the wire and 7 logged, and the next turn on the same connection. A 1,200 s model call with keepalives ended `end_turn`, and the proxy recorded one call of 1,200 s, status 200, not aborted. The silent form, recorded only, failed with `Timed out waiting for response headers after 1214 s`.
- **How far to trust it.** The only file under `SPIKE/src` written after that run began (18:11:08Z) is `stub-models/server.ts` (file times; I did not diff). The README says that change flushes the stub's headers at once, which affects the silent form (`README:140`). So the two passing forms are good evidence about the code as it stands, but they aren't from today's run. B2 stays SKIPPED until one run holds all of it.
- **The cancel is fast, and it is OpenCode that ends foreground tools.** In T9, OpenCode ended the 2 marked processes itself, and the driver reaped one `opencode-pty.exe` (RUN, T9 recorded). In T14, 4 marked processes were running before each cancel, and the driver reaped 40 over the 10 cancels (RUN, T14 recorded). The 40 counts every PID the driver killed, marked or not (`t14-cleanup.ts:45`), and the run doesn't save which they were. So RUN alone doesn't show that OpenCode left a background tool's processes for the driver. `README:148` says the earlier code, without the reap, left 2 behind per cancel (README, not rerun), and T9's foreground tool was ended by OpenCode itself, which together suggest the background tool's processes are what the reap kills (inferred).
- **What defines B2's parts.** B2's seven parts are picked from T4, T8, T9 and T14 by check name (`SPIKE/src/harness/pass-bar.ts:82-90`).

### 2.3 B3: a turn on each format and on the endpoint: PASS

| Check (RUN) | Result |
|---|---|
| A turn against the local OpenAI stub | PASS: `end_turn`, text received, 2 model calls through the proxy |
| A turn against the local Anthropic stub | PASS: the same |
| A turn against the endpoint in `model.env` | PASS: `end_turn`, 5 characters of text, 2 calls |

Every call went through the per-task key proxy: the task's provider config points at the proxy's `agentBaseUrl` and the env holds the fake key (`SPIKE/src/harness/fixture.ts:166,184-189,217,231`). The stubs run scripts that make OpenCode read, edit and run shell commands for real in a temporary git workspace on a task branch (`fixture.ts:147-159,178-179`; `README:37`). This is Windows only, one run, and one endpoint.

### 2.4 B4: only the fake key, and the count within 2%: SKIPPED

| Check (RUN) | Result |
|---|---|
| The agent's shell holds only the fake key, OpenAI and Anthropic runs | PASS, twice: the stub's `env-dump` script ran in the agent's own shell, and the fake key was present and the stub's real key absent (`turns-and-keys.ts:62-73`). The `model.env` task's own shell and spawn environment weren't inspected: the spawn check ran on a stub task (`turns-and-keys.ts:115`), and only looked for the endpoint's key among its values |
| The spawn environment is an allowlist holding only the fake key | PASS: 27 variables. The fake key is in place, no real key is among the values, and none of the runner's `OSTRA_DEV_*`, `GITHUB_*` or `LINEAR_*` names is present (`turns-and-keys.ts:115-126`). That the rest come from an allowlist is by construction in `buildAgentEnv` (`SPIKE/src/lib/opencode.ts:213-252`), not something the check proves: the "all named by the allowlist" in the harness's note is fixed text |
| The proxy's count against each stub | PASS: 31,422 = 31,422 tokens over 4 calls (OpenAI) and 31,235 = 31,235 (Anthropic), 0 calls without usage |
| The proxy's count against the `model.env` endpoint | PASS: the one-word turn 9,331 = 9,331 (0.0% off); the edit turn 28,856 = 28,856 (0.0% off); 0 calls answered 200 without usage |
| `/proc/<pid>/environ` of OpenCode and its children | **SKIPPED**: needs Linux |

- **The reference isn't the provider's billing.** The "endpoint" figure is OpenCode's own turn usage, which it parses from the same response bytes. The check validates the proxy's meter, not the provider's bill (`turns-and-keys.ts:5-10`). The bar's words are "what the endpoint reports", and the endpoint reports usage in the response, so I read this as met, with the comparison made against OpenCode's parse of the same bytes. Only the provider's dashboard is a fully independent figure, and I didn't check it. **Unverified against billing.**
- **Title calls sit outside every turn's usage.** The session's calls came to 38,741 tokens, of which 554 (1.4%) were in calls that offered no tools, such as titles (RUN, B4). The harness splits them by whether the request offered tools (`key-proxy.ts:46`; `turns-and-keys.ts:36-41`).

### 2.5 B5: events per minute, and steering: PASS

- **Events per minute.** 448 on the `model.env` endpoint, for one small edit turn (RUN, B3 recorded). An "event" is a driver event, which includes `prompt_finished`: T5 logged 46 events, 44 of them session updates (`t5-events.json`). The recorded 345,124 bytes/min is not a rate of that turn: it divides the whole session's inbound bytes (the one-word turn and the edit turn) by the edit turn's duration alone (`turns-and-keys.ts:160-165`), so it overstates the edit turn's byte rate. The scripted stub ticket ran at 317 events/min and 142,915 bytes/min, there over one span of events and the bytes of the same session (RUN, T5 recorded; `t5-events.ts:112`). These depend on what the model does. README, not rerun: an earlier full run gave 469 and the one before it 298, against 318 for the stub ticket (`README:156`). Spike 10's longer runs are the better source.
- **OpenCode's own HTTP API can steer mid-turn: yes.** The probe started a turn whose first step was a 15 s tool call, posted a second prompt with `delivery: "steer"` about 3 s after the turn's first model call (status 200), and the steer text was in the same turn's next model call (RUN, STEER; `SPIKE/src/cases/steer-probe.ts:49-74`). The official spec agrees: `session.prompt` takes a `delivery` field of type `Session.Inbox.Delivery`, whose values are `steer` and `queue` ([OpenCode OpenAPI document](https://opencode.ai/docs/openapi.json)). The server docs say this only of the compaction route: "Steers by default: it runs at the next step boundary instead of waiting behind queued prompts" ([OpenCode server docs](https://opencode.ai/docs/server/)). They say nothing about the boundary for a prompt steer, though a diff route's text does say "prompts steered in while it was busy belong to the same turn". That a prompt steer takes effect at the next model call is the probe's result, and why (no model call happens during a tool step) is inferred.
- **It also steers over plain ACP.** `initialize` returned `_meta` `{"steering":{"supported":true}}`, and the extension method `_session/steering` answered `{"outcome":"injected"}`. The steer text reached the model and the turn ended `end_turn` (RUN, STEER recorded; `acp-driver.ts:486-491`; `steer-probe.ts:24-47`). OpenCode's ACP page doesn't mention steering ([OpenCode ACP docs](https://opencode.ai/docs/cli/acp)), so this extension is undocumented there.

### 2.6 The fallback the bar names

`PASSBAR` says: "try OpenCode's HTTP API for the capability that failed. If that fails too, the choice of default agent is reopened." The harness tried both failures on `opencode serve`, with the same scripts, config and fake key (`SPIKE/src/cases/http-fallback.ts:1-8`).

| Capability | Plain ACP (RUN) | OpenCode's HTTP API (RUN) |
|---|---|---|
| Reject, and the agent continues (T7) | **No.** `reject_once` ended the turn `cancelled`; `notes.txt` was left alone, and the model wasn't called again. The same with `experimental.continue_loop_on_deny` | **Yes, with a message.** `POST /api/session/{id}/permission/{requestID}/reply` with `{decision: "reject", message}` answered 204, left `notes.txt` unchanged, and the model was called again (session outcome `succeeded`). A bare reject answered 204 and didn't continue (outcome `none`) |
| A plan (T5) | **No.** No `plan` or `plan_update`, though `plan` was advertised. The todo list arrives only as a `todowrite` tool call | **No.** The spike's own OpenCode served 142 paths, with no plan or todo route or event. The todo list is readable only inside the `todowrite` tool call in the message list |

- The reply route and its fields are in the official spec: `decision` is one of `once`, `always`, `reject`, and `message` is an optional string or null ([OpenCode OpenAPI document](https://opencode.ai/docs/openapi.json), `session.permission.reply`). I searched the published spec for any path or schema with "plan" or "todo" in its name and found none. The only "todo" in it is a boolean experimental flag.
- The permissions docs define `reject` as "Reject it and every other pending permission request in that session." ([OpenCode permissions](https://opencode.ai/docs/permissions/)). That fits a reject ending the turn.
- The todo list is a tool OpenCode offers only when asked: "Set `todo` to `true` to give agents a `todowrite` tool for tracking multi-step work." ([OpenCode config](https://opencode.ai/docs/config/)). The spike sets it (`t5-events.ts:36`).

So the fallback rescues T7's capability, and not T5's.

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **OpenCode can steer mid-turn, and ADR 0032 says it can't.**
   - `ADR32:23,28` and `ADR18:16` say OpenCode over ACP can't steer, and that it won't declare `steerMidTurn` "until spike 1 says otherwise". RUN says otherwise, over ACP and over the HTTP API (section 2.5). What `ADR32:23` says about a second `session/prompt` still holds: T9 saw it rejected after 1 ms. Steering is a separate extension call, `_session/steering`.
   - A steer lands at the next model call, after the running step, not at once. The probe sent it about 3 s after the turn's first model call, during a 15 s tool step, and the call after the step carried it (`steer-probe.ts:55-64`).
   - The probe used a scripted stub. What a real model does with a steer isn't tested.

2. **A reject ends the turn.**
   - The ADR 0036 card offers "Approve once", "Approve for this task" and "Deny" (`ADR36:34`). Over ACP, "Deny" is `reject_once`, and OpenCode then ends the turn `cancelled` (RUN, T7). Per its docs it also rejects every other pending request in that session.
   - So "Deny" costs a turn boundary. The agent can't be told "carry on without that edit" in the same turn, except through OpenCode's HTTP reply with a message.

3. **There is no plan, only a todo list.**
   - OpenCode sent no `plan` update in T5, even with `plan` advertised (`acp-driver.ts:404`). The list arrives as a `todowrite` tool call, in `rawInput.todos` and `rawOutput.metadata.todos` (RUN, T5).
   - `research/agent-ui-stream.md:425` maps ACP `plan` to `plan.updated` and marks the row complete. For OpenCode, that mapping has to start from `todowrite`.

4. **`opencode acp` runs a server on a loopback port.**
   - The ACP docs say `opencode acp` "starts a private OpenCode server for its own use" and "doesn't open a network port for ACP" ([OpenCode ACP docs](https://opencode.ai/docs/cli/acp)). They don't say that private server listens. RUN found each task's OpenCode listening on `127.0.0.1` (ports 58944 and 58929 for the two tasks, T7 recorded).
   - From the agent's own shell, 10 calls with no credentials to those ports (list sessions, list requests, read the event stream, answer the pending request) all got 401, while a request was pending. The shell held no credential or address for the server (RUN, T7). The reply call used a stand-in request ID, because OpenCode's own ID isn't visible over ACP (RUN, T7 recorded). A 401 comes before any ID is checked (inferred).
   - The password isn't in the agent's environment. It lives in OpenCode's memory (README, not rerun: `README:173`). `opencode serve` takes it from `OPENCODE_SERVER_PASSWORD` (`SPIKE/src/harness/opencode-serve.ts:49-51`), and I did not find how `acp` mode gets its own.
   - On Linux, a same-user process may be able to read it (inferred; the `/proc` checks are SKIPPED). That is spike 3's question.

5. **A detached helper survives a crash.**
   - T13's turn starts a helper that leaves its shell, then crashes OpenCode with `kill -9`. The helper stayed alive: 1 left by the crash, 0 reaped, 1 alive after (RUN, T13). The harness's final sweep killed it by its marker (inferred from the T13 line and the sweep's count of 1).
   - The driver finds a crashed agent's descendants from a process-tree snapshot taken every 2 s (`acp-driver.ts:239-261,276-288`). A helper whose parent shell exits within milliseconds is never seen under the agent, so the driver can't tell it is its own (README, not rerun: `README:151`).
   - Microsoft's `taskkill /t` "ends the specified process and any child processes started by it" ([taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)), and the driver uses it (`SPIKE/src/lib/process-tree.ts:143`). That it follows parent links, and that the link is gone, is inferred: the page doesn't say how it finds children.
   - A job object should do this properly, from its docs, not from a run here: "Operations performed on a job object affect all processes associated with the job object", and by default a process's children join its job ([Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)). On Linux, writing `1` to `cgroup.kill` kills the cgroup and all descendant cgroups, "protected against migrations" ([cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)).

6. **A cancel may leave a background tool running.**
   - In T14, every cancel ended `cancelled` and no marked process was alive when it returned, with the driver's reap in place. That OpenCode itself left the background server's processes for the reap to kill is inferred, from T9's foreground tool and the README's earlier run (section 2.2). If it is right, a runner that only sends `session/cancel` would leak them.

**Gotchas**

7. **The agent's shell holds variables the allowlist didn't pass.** The shell's environment held 14 names beyond the spawn allowlist: `AGENT`, `AI_AGENT`, `NO_PROXY`, `OPENCODE`, `OPENCODE_CLIENT`, `OPENCODE_SESSION_ID`, `OPENCODE_TERMINAL` and `TERM`, and on Windows `PSMODULEPATH`, `USERNAME`, `USERDOMAIN`, `HOMEDRIVE`, `HOMEPATH` and `LOGONSERVER` (RUN, T7 recorded). The README says OpenCode or PowerShell adds them (README, not rerun: `README:180`). The probe found no key or server address among them (`t7-permissions.ts:153-157`). So ADR 0030's "environment built from an allowlist" holds at spawn, and the shell's environment is wider.

8. **The offline posture rests on switches the docs don't list.**
   - The spike sets `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_FREE_MODELS` (`opencode.ts:244-247`), and `OPENCODE_MODELS_PATH` for a catalog file (`t3-any-endpoint.ts:44`).
   - `OPENCODE_MODELS_PATH` and `OPENCODE_DISABLE_MODELS_FETCH` are on neither the config nor the providers page, and none of the four, nor `OPENCODE_SERVER_PASSWORD`, is on the CLI page ([config](https://opencode.ai/docs/config/), [providers](https://opencode.ai/docs/providers/), [CLI](https://opencode.ai/docs/cli/)). None of the six names is on the server, ACP or permissions pages either, and I read no other page for them. `RIVET:155` cites an issue for the fetch switch. The config page lists `update` and says nothing of `share`, which the spike's config also sets (`opencode.ts:161-162`). Whether V2 reads `share` is **unverified**.
   - With them set, 2.3.2 made no outbound attempt in a turn that a proxy-based recorder could see, and the recorder had seen a `webfetch` control (RUN, T1). The recorder is a forward proxy in `HTTP(S)_PROXY`, so a client that ignores that variable would escape it, and the packet capture that would catch one is SKIPPED here (`t1-offline.ts:88-93`). The `webfetch` control shows only that OpenCode's tool honours the proxy, and 1.19.6's registry and GitHub attempts (item 9) show the recorder does see some background traffic. They still need a contract test on every OpenCode bump, as `ADR32:51` already requires for T3.
   - The catalog file works in both formats: an `@ai-sdk/anthropic` catalog provider and an `@ai-sdk/openai-compatible` one, each through `settings.baseURL` (RUN, T3; `catalog.ts:3`).

9. **The 1.x line isn't offline-safe, and it is the npm default.** With the same recorder, OpenCode 1.19.6 tried `registry.npmjs.org:443` and `github.com:443` (RUN, T1 recorded). The npm `opencode-ai` package's `latest` is 1.19.6, so an image that installs it gets the 1.x line. V2 is `@opencode/cli`. README, not rerun: without its own config format, 1.x falls back to OpenCode's hosted free models (`README:175`; the spike's V1 config sets `disabled_providers: ["opencode"]`, `opencode.ts:170-174,198`).

10. **Questions need the capability, and the answer is free text.**
    - With `elicitation.form` advertised, the question arrived as `elicitation/create` in form mode. Without it, there were 0 requests, and the tool result read "The question couldn't be shown to the user in this client. Continue without an answer: make reasonable assumptions" with the turn ending `end_turn` (RUN, T8 recorded). OpenCode's docs say the same: "If OpenCode can't show a question, it cancels the question and tells the model to continue without an answer" ([OpenCode ACP docs](https://opencode.ai/docs/cli/acp)).
    - The form offered the options and a `<key>_custom` free-text field. The answer that reached the model was typed into the custom field (`t8-questions.ts:20-29`). ostra's question card must render that field.

11. **`session/load` replays history as ordinary updates.** The ACP spec says the agent "MUST replay the entire conversation to the Client in the form of `session/update` notifications" ([session setup](https://agentclientprotocol.com/protocol/session-setup)). RUN saw 2 replayed updates after each kill (T11), and the harness counts them from the events after the load (`t11-resume.ts:14-16`). The runner has to mark replayed updates, or it will store them again as new task events (inferred; the event log is ADR 0035).

12. **A mode change sends no update.** `session/set_mode` produced no `current_mode_update` or `config_option_update` (RUN, T10 recorded: "no mode update / no mode update"). `set_config_option` returns the new `configOptions` in its response (`t3-any-endpoint.ts:92-93`). So ostra has to emit `session.config_changed` (`research/agent-ui-stream.md:427`) from its own calls. Plan mode also refuses an edit without asking: 0 permission requests, the edit didn't land, and the model's instructions differ (RUN, T10 recorded).

13. **Memory per process.**
    - Ten tasks took 1,215 MB of OpenCode as ten processes, and 132 MB as one shared process (RUN, T6 recorded). A crash in the shared process ends every session in it, which the harness records "by design" (`t6-concurrency.ts:80`). One OpenCode at rest is 124 MB (T16).
    - That is the cost of ADR 0032's one process per task. A `host` pool with N slots pays about 124 MB a slot (inferred).
    - The driver alone is 83 to 88 MB of working set on Windows, 30 MB over bare Node (T16). Spike 3's bar says the sidecar stays under 100 MB (`context/build-order.md:113`), and `ADR18:13` puts the driver in the sidecar. On Windows that leaves little room for the proxies. Linux RSS **isn't measured**.

14. **The SDK split moved, partly.** The README says the driver imports `/unstable` for elicitation, config options and turn usage (`README:34`). The SDK's own note lists turn `usage` and `configOptions` as needing `/unstable`, and doesn't list elicitation (`SPIKE/node_modules/@agentclientprotocol/sdk/MIGRATION_STABLE_UNSTABLE.md:111-119`). The elicitation RFD says it was "stabilized" on 2026-07-22 ([RFD](https://agentclientprotocol.com/rfds/elicitation)). The driver needs `/unstable` for the other two anyway. Compaction arrives as `compaction_update` and `compaction_summary_chunk` (2 and 10 of T5's 44 updates, from `SPIKE/.runs/run-2026-11-18T18-39-28-7a23/t5-events.json`). The driver advertises `session.compaction` (`acp-driver.ts:403`), and OpenCode's ACP page says that when the client advertises it, OpenCode reports compaction with those two updates ([OpenCode ACP docs](https://opencode.ai/docs/cli/acp)). I didn't run without the advert, so RUN doesn't confirm that. ostra's event schema must tolerate these types (`AGENTS.md`).

15. **A fresh OpenCode release can be held back by pnpm.** pnpm 11's minimum release age held back OpenCode 2.3.2 and vitest, so the workspace excludes them by name (`SPIKE/pnpm-workspace.yaml:4-23`). An image build that pins a just-released OpenCode needs the same. The wrappers' postinstall is denied, and the driver resolves the binary from the platform package and hashes it itself (`pnpm-workspace.yaml:25-30`; `opencode.ts:43-54`).

16. **The bar's wait and the ADR's timer differ.** The spike's long wait is 10 minutes, from `RIVET:488` (`t7-permissions.ts:251`). ADR 0039 now says a turn that waits on a person is cancelled after 15 minutes (`ADR39:13`). The short form ran with 5 s: the held request stayed pending, the cancel gave `cancelled`, the re-prompt ended `end_turn` and the edit applied (RUN, T7).

---

## 4. What this changes in the plan

These are recommendations. I changed no ADR and no ledger row.

1. **ADR 0032 and ADR 0018: OpenCode declares `steerMidTurn`.**
   - Replace "Until spike 1 says otherwise, OpenCode doesn't declare `steerMidTurn`" (`ADR32:28`; `ADR18:16`) with the finding. OpenCode 2.3.2 steers over ACP through `_session/steering`, advertised by `initialize` as `_meta.steering.supported`. The adapter should declare the capability only when that flag is true.
   - F-024 already says an agent that declares steering gets the message mid-turn (`context/features.md:134`). So for OpenCode, Send would steer and "queued" would apply to agents without it. The facts for the maintainer: a steer lands at the next model call, not at once (section 3, item 1), and the extension is undocumented on OpenCode's ACP page. If that isn't wanted, keep queue as the default and make steering the explicit choice.
   - Because the extension is undocumented, run the steer probe in the contract suite on every OpenCode bump.
   - The scripted fake ACP agent (`ADR32:30`) should still cover agents with and without steering. What OpenCode now lacks, and the fake agent can declare, is native plan updates and reject-and-continue.
   - F-019's example of an optional capability OpenCode lacks, "such as steering mid-turn" (`context/features.md:121`), should change to one of those.

2. **ADR 0036 and F-026: say what "Deny" does.**
   - Recommend that the runner answers a deny with `reject_once` and then re-prompts with the member's reason. It needs no OpenCode-only call, and RUN's cancel-then-re-prompt path (T7, T9) exercised the re-prompt for waits. It has been tried only with OpenCode: an agent that carries on after a reject by itself would need no re-prompt, and one sent while its turn was still running would hit the second-prompt error (inferred). The HTTP reply with a message is an OpenCode-only option, and a second adapter capability.
   - A deny also rejects every other pending request in the session (OpenCode permissions docs). ostra's other open approvals then close as cancelled (`approval.closed`, `research/agent-ui-stream.md:422`).
   - The deny re-prompt itself wasn't run. T7 ran the wait path.

3. **The plan comes from `todowrite`.**
   - The OpenCode adapter turns `todowrite` into `plan.updated`, from `rawInput.todos` and `rawOutput.metadata.todos`, and the per-task config sets `experimental.todo` ([config](https://opencode.ai/docs/config/)). Mark row 14 of `research/agent-ui-stream.md:425` as "from `todowrite` for OpenCode".

4. **The pass bar and the "reopen" rule: the maintainer decides.**
   - Read strictly, T5's plan fails on both surfaces, and `PASSBAR` and `ADR32:54` then reopen the default agent. I recommend not reopening. Every other T5 check passed, the HTTP API rescued the reject, and the plan has an ostra-side answer (item 3).
   - If the maintainer agrees, reword `PASSBAR` and `RIVET:486,488,494`: T5 "a plan, or a todo list ostra maps"; T7 "a reject ends the turn, and the agent can be re-prompted to continue"; T13 "the runner's reap works from the agent's tree, and a box or job object closes the rest". Even then, B1 can't pass from a Windows run alone: T1's packet capture and T3's `/proc` check are Linux-only and stay SKIPPED on Windows, and the harness doesn't combine the three platforms' runs (`SPIKE/src/harness/pass-bar.ts:47-71`; `t1-offline.ts:88-93`; `t3-any-endpoint.ts:110-115`). B1 would be read from the Windows, Linux and macOS runs together, with the long run in.

5. **ADR 0030 and spike 3: add OpenCode's loopback port.**
   - Add to spike 3's list: from a shell in the agent's container, call the OpenCode loopback port with no password, and try to read the password from the process list, `/proc/<pid>/environ` and `/proc/<pid>/cmdline`. The agent's shell is in the same container as OpenCode in the box design, so the password's secrecy is the only barrier to self-approval there (inferred).
   - The driver's approvals travel on the stdio pipe, not on that port (`acp-driver.ts:348-354`). In RUN, T7, no request was answerable from the shell.

6. **ADR 0029: process containment on the `host` executor.**
   - A task's leftover processes after a crash are a runner-parity difference, and `AGENTS.md` says an unrecorded difference is a bug. A box ends every process with its container (inferred: no box ran in this spike). On `host`, close the gap with a job object per task on Windows and a cgroup on Linux, or record it as a third allowed difference (`ADR29:35`).
   - **macOS has neither.** What to use there is **unverified**.
   - How a Node runner creates a Windows job object is not shown by this spike.

7. **ADR 0042 and ADR 0030: the count.**
   - Add that title and other calls without tools sit outside every turn's usage (554 of 38,741 tokens here, 1.4%), so the proxy must meter every call, whatever it offers.
   - State that spike 1's 2% criterion compares the proxy with the agent's turn usage of the same response bytes, and that the independent check is the provider's own figure.

8. **ADR 0033, ADR 0046 and F-019: pin the mechanism.**
   - The base image installs `@opencode/cli` at an exact version and checks the SHA-256 of the platform binary, with scripts off. The catalog goes in as a file (`OPENCODE_MODELS_PATH` with `OPENCODE_DISABLE_MODELS_FETCH=1`), which fits "The agent never fetches the catalog" (`ADR33:23`). Put the switches I couldn't find in the docs (section 3, item 8) under the adapter's contract suite.

9. **ADR 0035 and ADR 0006: replay and config events.** The runner marks updates that `session/load` replays so they aren't stored as new events (section 3, item 11), and it emits `session.config_changed` itself (item 12).

10. **ADR 0039, `context/build-order.md` spike 3, and the numbers.**
    - Align the held-request wait: 10 minutes in `RIVET:488`, 15 in `ADR39:13`.
    - Measure the sidecar's memory on Linux before spike 3's 100 MB bar, since the driver alone is 83 to 88 MB on Windows (section 3, item 13).

11. **The feature ledger.** No row becomes `done`, since this is a spike (`AGENTS.md`). F-019 and F-024 stay `planned`; their text changes as in item 1.

---

## 5. What's still open

| Criterion (RUN) | Status | What it needs |
|---|---|---|
| B1, Linux in a container | SKIPPED | A machine with Docker and `NET_ADMIN` and `NET_RAW`: `docker build -t ostra-spike1 -f container/Dockerfile .`, then `docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW --env-file ~/.config/ostra-dev/model.env ostra-spike1` (`README:77-82`). It also gives the POSIX code paths (`ps` with `lstart`, `/proc/net/tcp`, `lsof`, process groups, `tcpdump`), which have run in no test yet (`README:186`) |
| B1, macOS | SKIPPED | A Mac, and `pnpm spike` there |
| B1, T1 | SKIPPED | The Linux run above: the packet capture around a turn behind the egress firewall (`SPIKE/container/run.sh:27-39`). The Windows recorder only sees proxy-aware clients |
| B1, T3 | SKIPPED | The Linux run: `/proc/<pid>/environ` of OpenCode and its children |
| B1 and B2, T4 | SKIPPED | One `SPIKE_LONG=1 pnpm spike`: the three forms of T4 run in parallel and take about 21 minutes (`t4-long-turn.ts:4-11,93`), and the full run about 25 minutes (`README:187`; the command is at `README:69`). It gives B2's two 20-minute checks in a single run on this revision, and the silent form with headers flushed |
| B1, T7's wait | SKIPPED | The same `SPIKE_LONG=1` run (10 minutes, or 15 to match `ADR39`). The 2-hour hold isn't run: the case accepts the cancel path instead (`t7-permissions.ts:325`) |
| B4 | SKIPPED | The Linux run for `/proc`. For an independent count, the provider's own usage figure for the session |
| T5 plan, T7 reject, T13 reap | FAIL | Not skips. The first two need the maintainer's decision (section 4, items 3 and 4). T13 needs spike 3's box, or a job object or cgroup, to show a detached helper is contained |

**Open, though no check is skipped.**
- **Steering on a real model.** The probe used a scripted stub. A real model's use of a steer, and the extension's stability across OpenCode versions, are untested.
- **A long `session/load`.** T11 replayed a 2-update history. Spike 2 tests a 200-turn session and the move to a fresh box.
- **The event rate.** 448 events/min is one small turn on one model. Spike 6 sizes its load from the rate spike 1 records (`context/research/spike-runner-transport.md`, section 2.4), and it read 392 events/min from an earlier run of spike 1 that is no longer on this machine (`spike-runner-transport.md:129`), not this run's 448. Spike 10's longer runs should replace both.
- **The deny re-prompt.** Its end-to-end run, and the HTTP reply's behaviour with several pending requests, weren't run.
- **`share` in the V2 config.** Whether OpenCode 2.3.2 reads it is **unverified**.
- **Not in this spike's bar.** T2 and the Sandbox Agent arm (Q11 dropped it, `README:192`), T12 (the restore through export and import, which spike 2 tests, `context/build-order.md:100`), T17 (OS-user separation for Q27, a decision spike 3 tests, `context/build-order.md:109`), the gVisor part of T15 (`context/build-order.md:115`; the E2B part of T15 is in no spike's bar that I found), and T3b, Claude Code through its adapter (milestone 7).
