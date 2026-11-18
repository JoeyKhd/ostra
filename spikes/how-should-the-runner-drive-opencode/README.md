# Spike 1: how should the runner drive OpenCode?

Milestone 0, spike 1 (`context/build-order.md`). Throwaway code: it answers one question, and its finding goes into `context/research/` once the remaining runs are in.

## The question

Can ostra's own driver, on the official ACP SDK, run OpenCode for real work through the key proxy, on any endpoint?

**Tests the decisions:** Q11, Q45, Q51, Q52, Q103 (ADR 0032, and the key proxy of ADR 0030, ADR 0033 and ADR 0042).

**Passes when** (copied from `context/build-order.md`):

- Cases T1, T3–T11, T13, T14 and T16 of the test list in `research/rivet.md` pass on Linux in a container, on Windows 11 without WSL, and on macOS.
- A 20-minute turn ends cleanly. A question reaches the driver, and its answer reaches the model. A cancel returns within 5 s and leaves no process behind.
- A turn completes against the endpoint in `model.env`, and against a local stub in each of the two API formats.
- The agent's environment holds only the fake key, and the proxy's token count is within 2% of what the endpoint reports.
- Recorded: events per minute, and whether OpenCode's own HTTP API can steer mid-turn.

**If it fails:** try OpenCode's HTTP API for the capability that failed. If that fails too, the choice of default agent is reopened.

## Architecture

```
harness (pnpm spike)
 ├─ stub model servers ── OpenAI-compatible /v1/chat/completions + /v1/models
 │                     └─ Anthropic /v1/messages + /v1/models      (scripted tool calls)
 ├─ per task: key proxy ── fake key in, real key out; counts tokens from the stream
 │            └─ upstream: a stub, or the endpoint in model.env
 ├─ per task: ACP driver ── spawns `opencode acp` (OpenCode 2.3.2, pinned binary)
 │            stdio, explicit env (fake key only), own HOME/XDG/TMP, own git workspace
 └─ fallback probes: `opencode serve` (loopback, random password) for steering, reject, plan
```

- **The driver** (`src/lib/acp-driver.ts`) is `@agentclientprotocol/sdk` 2.7.0 over stdio, through the SDK's `/unstable` entrypoint, because elicitation, config options and turn usage are unstable in ACP v1. It advertises `elicitation.form`, `session.compaction` and `plan`. It numbers every event, and it counts every message on the wire before the SDK parses it, so a drop between the pipe and the event log shows up.
- **Processes.** The driver snapshots the agent's process tree every 2 s. A turn that ends `cancelled` reaps every descendant born during it, before `prompt()` returns, and logs a `cancel_reaped` event with the PIDs and image names. Every recorded process is identified by PID, name and creation time, so a reused PID is never killed. If `initialize` fails, the driver kills the agent it spawned before rethrowing.
- **The key proxy** (`src/lib/key-proxy.ts`) passes bytes through unchanged, and asks the upstream for `accept-encoding: identity` so the meter can read them. It reads usage as the bytes go by, in OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, streamed or not. Each call record says whether the request offered tools (`hasTools`): a turn's own call, or a title or summary call. It logs IDs and counts only.
- **The stubs** (`src/lib/stub-models/`) play scripts chosen by a marker in the prompt (`[[stub:<name> <args>]]`). Each model call is one step of the script, so OpenCode reads, edits and runs shell commands for real in a temporary git workspace. Each stub bills a deterministic token count and keeps it as ground truth. Script arguments are checked against strict patterns before they reach a shell command, and are passed as separate arguments.
- **Cases** (`src/cases/`) are one file per T-case, plus the HTTP fallback (`http-fallback.ts`) and the steering probe. `src/harness/pass-bar.ts` folds them into the pass bar's bullets. `src/harness/status-table.ts` turns a run's `report.json` into the tables below.

## The reusable parts (for spikes 2, 3 and 10)

Copy `src/lib/` as a folder. It needs `@agentclientprotocol/sdk` and `zod`.

| Module | API |
|---|---|
| `acp-driver.ts` | `startAcpDriver({ taskId, launch, decidePermission, answerElicitation, onEvent?, onSpawn?, advertiseElicitation?, treeSnapshotMs?, reapOnCancel? })` returns an `AcpDriver`: `newSession` (returns a branded `SessionId`), `loadSession`, `prompt`, `cancel`, `setConfigOption`, `setMode`, `steer` (OpenCode's `_session/steering`), `stop(graceMs)` (closes stdin, then kills the tree), `crash()` (kill -9, for tests), `snapshotTree()`, `reap()`, `events` (numbered `DriverEvent`s), `wire()`, `exited`. A dead agent rejects calls with `AgentExitedError`; an ordinary error reply passes through at once. Also exports `textPrompt(text)` and `agentText(events, sessionId, sinceSeq?)`. |
| `deciders.ts` | `allowOnce`, `rejectOnce`, `declineQuestions`: answers for a driver with no member behind it. |
| `key-proxy.ts` | `startKeyProxy({ upstreamBaseUrl, realKey, upstreamAuth: "bearer" \| "x-api-key", taskId, fakeKeyTtlMs?, log? })` returns `{ agentBaseUrl, fakeKey, calls, revoke, close }`. Each `ProxyCallRecord` has `requestedModel`, `hasTools`, `status`, `keySwapped`, `usage`, `rateLimited`, `retryAfter` and `upstreamAuthFailed`. |
| `usage.ts` | `createUsageMeter(format, streamed)` → `{ push(chunk), end() }`; `formatForPath`, `totalTokens`, `addUsage`. |
| `stub-models/server.ts` | `startOpenAiStub` and `startAnthropicStub` (`{ realKey, models, brain, chunkChars? }`) return `{ baseUrl, calls, close }`. `calls[].billed` is the ground truth. A reply can wait `delayMs` before its first byte, with keepalives or silent (`keepalive: false`). |
| `stub-models/scenario.ts` | `createScenarioBrain(scenarios, { auxiliary?, intercept? })`, `stubMarker(name, args)`, `conversationText(messages)`. |
| `opencode.ts` | `resolveOpenCodeBinary("v2" \| "v1")` gives the path, version and SHA-256, from the platform package with no postinstall. Also `createTaskDirs(root)`; `buildOpenCodeConfig({ providers, model, permissions?, experimental? })` and `buildOpenCodeV1Config`; `writeOpenCodeConfig(dirs, config)` (into the task's own XDG config dir, never the repo); `buildAgentEnv({ dirs, fakeKeys, extra? })` (an allowlist, never inherited); `openCodeAcpLaunch`. |
| `process-tree.ts` | `listProcesses` (with creation times), `sameProcess`, `descendantsOf`, `killTree` (`taskkill /T /F` on Windows, process group on POSIX), `killByMarker`, `isAlive`, `sampleProcesses` (RSS and CPU; Linux and macOS `cputime` formats), `listeningPorts` (PowerShell on Windows, `/proc/net/tcp` on Linux, `lsof` on macOS). The measurement functions throw when their tool can't run. |
| `egress-recorder.ts` | `startEgressRecorder()` returns a deny-all forward proxy for `HTTP(S)_PROXY` that records the hosts the agent tries. |
| `packet-capture.ts` | `startCapture(file)` runs `tcpdump -i any` (Linux, CAP_NET_RAW); `stop()` returns the packet count and every packet outside loopback. |
| `ids.ts` | Branded `TaskId`, `SessionId`, `RpcId` and `ProxyCallId`, made with Zod. |

## How to run it

```sh
cd spikes/how-should-the-runner-drive-opencode
pnpm install          # its own workspace; no install script runs
pnpm typecheck        # strict tsc
pnpm lint             # the root's ESLint rules (eslint.config.js), run with the root workspace's ESLint
pnpm test             # unit tests: SSE parser, usage meter, key proxy, scenario arguments, process sampling
pnpm check:inputs     # which inputs are present; never prints a value
pnpm spike            # every criterion it can run here, about 4 minutes
pnpm spike --only=T7,B3          # a subset
SPIKE_LONG=1 pnpm spike          # adds the 20-minute turns and the 10-minute permission wait
pnpm spike --allow-skipped       # exit 0 when nothing failed, even if a bullet was skipped
pnpm status [run-folder]         # the status tables of the newest run (or the one named)
pnpm clean                       # deletes .runs/
```

`pnpm spike` exits 1 when a bullet fails, 2 when none fails but one is skipped, and 0 only when every bullet passes. Each run writes `.runs/run-<time>/` (gitignored): `report.json`, `status.md`, each task's workspace and the agent's stderr. It keeps the three newest runs and the runs this README cites, and deletes the rest. It kills only its own processes, ends with a sweep that reports any leftovers, and runs the same sweep on Ctrl+C or SIGTERM. The sweep kills a tracked PID only if the live process was created when this run spawned it.

**Linux in a container** (B1's Linux bullet, T1's packet capture, the `/proc/<pid>/environ` checks). The image runs the harness behind an egress firewall: loopback and replies only, plus the model endpoint's addresses when it's set. T1 runs tcpdump around its own turn.

```sh
docker build -t ostra-spike1 -f container/Dockerfile .
docker run --rm --cap-add NET_ADMIN --cap-add NET_RAW --env-file ~/.config/ostra-dev/model.env ostra-spike1
```

### Inputs

| Input | Needed by | If missing |
|---|---|---|
| `OSTRA_DEV_MODEL_BASE_URL`, `OSTRA_DEV_MODEL_API_KEY`, `OSTRA_DEV_MODEL_ID`, from the environment or `~/.config/ostra-dev/model.env` | B3 (endpoint turn), B4 (endpoint count), B5 (real event rate), T11 (real-model recall) | Those checks are SKIPPED |
| `OSTRA_DEV_MODEL_API_FORMAT` (`openai` or `anthropic`), optional | the endpoint checks | Detected from `GET /models` |
| `SPIKE_LONG=1` | T4 / B2 (20-minute turns), T7 (10-minute wait) | 30 s and 5 s short forms run and are recorded; the criteria stay SKIPPED |
| A models.dev catalog: fetched once by the harness into `.runs/catalog/`, or `SPIKE_MODELS_JSON` | T3 (b) and (c) | SKIPPED |
| Docker with `NET_ADMIN` and `NET_RAW` (`container/`) | B1 (Linux), T1 (packet capture), T3 and B4 (`/proc/<pid>/environ`) | SKIPPED |
| A macOS machine | B1 (macOS) | SKIPPED |

Nothing else is read. LINEAR_*, GITHUB_* and DATABASE_URL aren't used by this spike.

## Status on this machine (2026-11-18)

Windows 11 Pro (build 26200, checked by the harness), no WSL, Node 24.14.0, pnpm 11.28.2. `model.env` was present, and its endpoint was detected as Anthropic Messages format. The container files have not run yet: this machine has no Docker. macOS has not run.

The tables are generated by `pnpm status` from `run-2026-11-18T18-32-16-222e`, a plain `pnpm spike` run of every case on this revision (exit 1, because B1 fails; the final sweep killed 1 leftover, T13's detached helper, by its marker). A plain run never passes B2: its 20-minute parts need `SPIKE_LONG=1`.

**Pass bar**

| | Status | Bullet | Checks not passed |
|---|---|---|---|
| B1 | **FAIL** | Cases T1, T3–T11, T13, T14 and T16 of research/rivet.md pass on Linux in a container, on Windows 11 without WSL, and on macOS. | SKIPPED T1 on this machine: skipped: packet capture shows no request to the ACP registry CDN, GitHub, npm or models.dev (Linux with tcpdump: container/run.sh (the egress recorder above only sees proxy-aware clients))<br>SKIPPED T3 on this machine: skipped: /proc/<pid>/environ of OpenCode and its children holds no real key (a Linux machine (`container/run.sh`); B4 checks the agent's shell environment here)<br>SKIPPED T4 on this machine: skipped: a turn that runs >= 20 min (a 1,200 s tool step) ends with end_turn, no transport error, no lost events, connection reused (SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel)); a turn whose model call streams for >= 20 min (keepalives only, through the key proxy) ends with end_turn, no lost events, connection reused (SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel))<br>FAIL T5 on this machine: failed: plan<br>FAIL T7 on this machine: failed: reject fails it and the agent continues<br>FAIL T13 on this machine: failed: the crashed agent's tool processes are reaped by the runner<br>SKIPPED on Linux in a container: a Linux container: `container/run.sh` (Docker with NET_ADMIN and NET_RAW)<br>FAIL on Windows 11 without WSL (this machine): see the T-case lines (this machine: windows-11, release 10.0.26200; the harness runs natively, not under WSL)<br>SKIPPED on macOS: a macOS machine: `pnpm spike` there |
| B2 | **SKIPPED** | A 20-minute turn ends cleanly. A question reaches the driver, and its answer reaches the model. A cancel returns within 5 s and leaves no process behind. | SKIPPED a 20-minute turn ends cleanly (a 20-minute tool step): SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel)<br>SKIPPED a 20-minute turn ends cleanly (a 20-minute model call, through the key proxy): SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel) |
| B3 | PASS | A turn completes against the endpoint in model.env, and against a local stub in each of the two API formats. | 3 checks passed |
| B4 | **SKIPPED** | The agent's environment holds only the fake key, and the proxy's token count is within 2% of what the endpoint reports. | SKIPPED /proc/<pid>/environ of OpenCode and its children holds no real key: a Linux machine (no /proc here); the shell-dump checks above cover this machine |
| B5 | PASS | Recorded: events per minute, and whether OpenCode's own HTTP API can steer mid-turn. | 2 checks passed |

**Cases**

| | Status | Case | Checks not passed |
|---|---|---|---|
| T1 | **SKIPPED** | Offline, pinned install: a turn with egress only to the proxy; no other requests; pinned version reported. | SKIPPED packet capture shows no request to the ACP registry CDN, GitHub, npm or models.dev: Linux with tcpdump: container/run.sh (the egress recorder above only sees proxy-aware clients) |
| T3 | **SKIPPED** | Any base URL and model: custom provider, catalog provider via baseURL, models.dev ID; key swapped; set_config_option. | SKIPPED /proc/<pid>/environ of OpenCode and its children holds no real key: a Linux machine (`container/run.sh`); B4 checks the agent's shell environment here |
| T4 | **SKIPPED** | Long turn: >= 20 min ends with end_turn, contiguous seq, connection reused (a tool step and a model call). | SKIPPED a turn that runs >= 20 min (a 1,200 s tool step) ends with end_turn, no transport error, no lost events, connection reused: SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel)<br>SKIPPED a turn whose model call streams for >= 20 min (keepalives only, through the key proxy) ends with end_turn, no lost events, connection reused: SPIKE_LONG=1 (about 21 minutes; the three forms run in parallel) |
| T5 | **FAIL** | Event completeness: tool calls with input and output, diff, plan, child sessions, usage with cost, compaction, stopReason. | FAIL plan: no plan or plan_update from OpenCode 2.3.2, even with the plan capability advertised; the todo list arrives only as a todowrite tool call (experimental.todo), in rawInput.todos and rawOutput.metadata.todos |
| T6 | PASS | Concurrency and integrity: 10 tasks, per-process and shared; 5 s stall loses nothing; bounded memory; crash isolation. | 5 checks passed |
| T7 | **FAIL** | Permissions: request fields, once, reject, long waits, runner restart, no self-approval. | FAIL reject fails it and the agent continues: notes.txt unchanged; 2 requests; stopReason=cancelled; agent said ""<br>SKIPPED ostra's cancel-after-10-min path with the real 10-minute wait: SPIKE_LONG=1 |
| T8 | PASS | Questions: with elicitation.form, OpenCode's question arrives as elicitation/create and the answer reaches the model. | 2 checks passed |
| T9 | PASS | Steering and interrupt: second prompt errors, cancel within 5 s, context kept, no processes left. | 5 checks passed |
| T10 | PASS | Model and mode mid-session: set_config_option model between and during turns; set_mode plan then build. | 3 checks passed |
| T11 | PASS | Resume, same runner: kill OpenCode, and separately the driver; session/load replays history and context holds. | 6 checks passed |
| T13 | **FAIL** | Agent crash: kill -9 mid-turn detected within 2 s, session marked crashed, workspace and branch intact. | FAIL the crashed agent's tool processes are reaped by the runner: 1 left by the crash, 0 reaped from the tree snapshots, 1 alive after |
| T14 | PASS | Process-tree cleanup: after 10 turns with cancels, no stray PIDs. | 3 checks passed |
| T16 | PASS | Resource use: driver and OpenCode RSS and CPU, idle and active; spawn to first token. | 2 checks passed |
| STEER | PASS | Recorded: whether OpenCode's own HTTP API can steer mid-turn. | 1 checks passed |
| T7-HTTP | PASS | Fallback for T7: reject and continue, over OpenCode's HTTP API. | 1 checks passed |
| T5-HTTP | **FAIL** | Fallback for T5: a plan, over OpenCode's HTTP API. | FAIL over OpenCode's HTTP API, a plan arrives (a plan or todo route or event): the API has no plan or todo route or event (142 paths); the todo list is readable only as the todowrite tool call in session.message.list, as over ACP |

**Long run (`SPIKE_LONG=1 pnpm spike --only=T4`), `run-2026-11-18T18-11-08-a662`** (this revision, run beside the first full run; exit 2, because it ran only T4):

| B2 part | Status | What happened |
|---|---|---|
| A 20-minute turn: a 1,200 s tool step | PASS | `end_turn` after 1,200 s; seq contiguous; 7 updates on the wire, 7 logged; the next turn ran on the same connection |
| A 20-minute turn: one 1,200 s model call through the key proxy, keepalives only | PASS | `end_turn` after 1,200 s; seq contiguous; 3 = 3 updates; the proxy recorded one call of 1,200 s, status 200, not aborted; next turn `end_turn` |
| Recorded only: a 1,200 s model call with no keepalives | did not end cleanly | OpenCode failed the turn with `Timed out waiting for response headers after 1214 s`, and the next turn ran fine. The stub's silent form sent no response headers at all (Node holds them until the first write), so this tested a 20-minute wait for headers. The stub now flushes headers at once, so the next long run tests silence after the headers, as a stalled provider would behave |

So B2 has every part PASS on this revision, but across two runs: the question, the answer and the cancel in the full run, and the 20-minute turns in the long run. A plain `pnpm spike` reports B2 as SKIPPED, and only `SPIKE_LONG=1 pnpm spike` gives one run with all of it.

The older long runs (`run-2026-11-18T17-08-52-66aa`: the 1,200 s tool step passed; `run-2026-11-18T17-08-57-45fa`: T7's cancel-after-10-min path passed) ran on the code before this revision. They are kept as history, not as this revision's result.

### What the numbers say

- **B2, the cancel.** Measured the moment the cancel returns, not after the task stops. A foreground tool: OpenCode ends it itself (T9: 2 marked processes before, 0 when the cancel returned in 461 ms, reap included). A background tool (`background: true`) survives OpenCode's cancel. The driver's reap kills it before `prompt()` returns (T14: 4 marked processes running before each of 10 cancels, 0 after each, 40 reaped). Without the reap, the earlier code left 2 behind per cancel until the task stopped.
- **B4, the endpoint count.** It compares like with like, per turn: the proxy's sum over the turn's own model calls (the requests that offered tools) against OpenCode's turn usage. The one-word turn was 9,352 = 9,352 tokens, and the three-call edit turn 28,923 = 28,923, with no call answering 200 without usage. OpenCode's title calls (595 tokens here) appear in no turn usage, so they're excluded. The reference is OpenCode's own parse of the same response bytes: it checks the proxy's metering, not the provider's billing. Only the provider's dashboard is a fully independent figure. B4 stays SKIPPED only for the Linux `/proc` check.
- **T9, the second prompt.** It is rejected in 1–2 ms across runs (`Session already has an active ACP prompt`). The old 1,001 ms came from the driver waiting 1 s for an exit after every error reply. It now waits only when the connection itself is gone.
- **T13, a crash.** It is detected in 9 ms, and the session is marked crashed. **It FAILs on its reap check:** the turn starts a detached helper (`spawn(..., { detached: true })`), whose parent shell exits within milliseconds. No 2 s tree snapshot sees the parent link, so after the crash the driver can't tell the helper is its own, and it stays alive. The harness's final sweep killed it by its marker. Before this revision the check passed with nothing to reap. A runner needs an OS container for this: a job object on Windows, a cgroup on Linux (spike 3's box).
- **T4 short forms (30 s).** The tool step, a 30 s model call with keepalives through the key proxy, and a 30 s silent model call all ended `end_turn` on the same connection.
- **T8.** The answer is a free-text token typed into the question's custom field (`q0_custom`), and it's none of the options (`red`, `blue`). It reached the model's tool result.
- **T10.** In plan mode the same edit did not land: OpenCode refused the tool and sent no permission request. In build mode it landed. `session/set_mode` sends no `current_mode_update` or `config_option_update`.
- **T7, the shell probe.** It ran from the agent's own shell while a request was pending. Its 10 unauthenticated calls to its own OpenCode port and to a second task's port all got 401: list sessions, list requests, the event stream, answering the pending request. OpenCode's own request ID is not visible over ACP, so the reply call used a well-formed stand-in.
- **Events per minute** (B5): 469 on the `model.env` endpoint for one small edit turn (298 in the run before), against 318 for the scripted stub ticket. These vary a lot with what the model does, so spike 10's longer runs are the better source.
- **Steering** (B5): OpenCode 2.3.2 steers mid-turn over its HTTP API (`POST /api/session/{id}/prompt` with `delivery: "steer"`). It also steers over ACP: `initialize` advertises `_meta.steering.supported: true`, and `_session/steering` answers `{"outcome":"injected"}`.

### The fallback (HTTP API) for the two failures

| Capability | Plain ACP | OpenCode's HTTP API |
|---|---|---|
| Reject a tool, and the agent continues (T7) | **No**: `reject_once` ends the turn `cancelled`, also with `experimental.continue_loop_on_deny` | **Yes, with a message**: `POST /api/session/{id}/permission/{requestID}/reply` `{decision: "reject", message}` fails the edit, leaves `notes.txt` alone, and the model is called again (session outcome `succeeded`). A bare `{decision: "reject"}` stops the turn as over ACP |
| A plan (T5) | **No**: no `plan` or `plan_update`, even with the plan capability; the todo list arrives only as a `todowrite` tool call (`experimental.todo`) | **No**: the OpenAPI spec (`/openapi.json`, 142 paths) has no plan or todo route or event; the todo list is readable only inside the `todowrite` tool call in `session.message.list`, as over ACP |

So the fallback rescues T7's capability and not T5's. T5's plan is something ostra maps from `todowrite` itself, on either surface.

### Findings worth carrying into the research file

1. **Steering exists over plain ACP** (`_session/steering`, `{"outcome":"injected"}`) and over the HTTP API. ADR 0032 assumes OpenCode can't steer over ACP. That needs revisiting: OpenCode could declare `steerMidTurn`.
2. **A reject stops the turn over ACP.** Over the HTTP API, a reject *with a message* continues it. So ostra's "reject and continue" is either a re-prompt over ACP ("the member rejected X; continue without it"), or the HTTP reply with a message.
3. **No plan on either surface.** ostra maps `todowrite` (`rawInput.todos`, `rawOutput.metadata.todos`) to a plan itself.
4. **`opencode acp` listens on a loopback port** (`127.0.0.1:<random>`), which its docs say it doesn't. Its `/api/*` routes answer 401 without the password, also from the agent's own shell, and the agent's shell gets no password or address. The password lives in OpenCode's memory, so spike 3's container boundary is what really protects it.
5. **CLI subcommands such as `opencode models` and `debug agents` start a persistent background service** (`serve --service`) that outlives the command. The runner must never call them without `--standalone`, or must kill the service afterwards.
6. **OpenCode 1.19.6, the control, isn't offline-safe.** It reaches out to `registry.npmjs.org` and `github.com`, and without its own config format it silently falls back to OpenCode's hosted free models. 2.3.2 made no outbound attempts at all, through the recorder that a `webfetch` control proved it honours.
7. **The catalog can be supplied as a file.** `OPENCODE_MODELS_PATH` plus `OPENCODE_DISABLE_MODELS_FETCH=1` gives OpenCode the server's models.dev copy, which fits ADR 0033. That works in both formats: an `@ai-sdk/anthropic` provider and an `@ai-sdk/openai-compatible` one, each through `settings.baseURL`.
8. **OpenCode reports usage in streams by default** in both formats. The proxy's count matched the stubs exactly, and matched OpenCode's turn usage per turn on the endpoint. Title calls are outside every turn's usage, so ostra must meter them at the proxy, or it misses them: 595 of the endpoint session's 38,870 tokens (1.5%) here, more on a short session.
9. **Cancel ends foreground tools; background tools survive it.** ostra's driver must reap what a cancelled turn started (it does now). A tool that daemonizes escapes any parent-link reap (T13): the box must be the boundary.
10. **Plan mode refuses edits without asking**, though it still offers the `edit` tool to the model, and `set_mode` sends no mode update.
11. **The agent's shell holds variables the allowlist didn't pass:** `OPENCODE`, `OPENCODE_SESSION_ID`, `OPENCODE_CLIENT`, `OPENCODE_TERMINAL`, `AGENT`, `AI_AGENT`, `NO_PROXY` and `TERM`, and on Windows `PSMODULEPATH` and user-profile variables (`USERNAME`, `USERDOMAIN`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`), added by OpenCode or by PowerShell. None holds a key or the server's address.
12. **Shared vs per-process:** 10 sessions in one OpenCode process took 133 MB, against about 1,214 MB for 10 processes. A crash in shared mode ends every session in it.
13. **Binary:** `@opencode/cli-windows-x64@2.3.2`, SHA-256 `5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3`.

## What's left

- Run `container/run.sh` on a machine with Docker (B1 Linux, T1 packet capture, `/proc` in T3 and B4), and `pnpm spike` on **macOS**. Both are needed for B1. The POSIX code paths (`ps` with `lstart`, `/proc/net/tcp`, `lsof`, process groups, tcpdump) have run in no test yet.
- Run one full `SPIKE_LONG=1 pnpm spike` on this revision (about 25 minutes). It gives B2 in a single run, T7's 10-minute hold, and the silent-model form with headers flushed.
- **Decide** on T5 and T7, now that the fallback ran: map `todowrite` to a plan, and choose between the ACP re-prompt and the HTTP reply-with-message for a reject. Then decide whether the pass bar's "reopen the default agent" applies. On this evidence it doesn't: both gaps have an ostra-side answer.
- T13's detached-process escape: confirm that spike 3's box (a cgroup or job object) closes it.
- **Revisit ADR 0032's steering section** in light of finding 1.
- Write `context/research/<topic>.md` from these runs, with every claim cited.
- Not set up here: the Sandbox Agent arm, which Q11 dropped.

## Dependencies

All pinned exactly.

| Package | Version | License | Why |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 2.7.0 | Apache-2.0 | The driver (answers 4.6, ADR 0032). It's the version `research/rivet.md` pins: 2.8.0 came out the day the spike started |
| `@opencode/cli` | 2.3.2 | MIT | OpenCode V2, the version `research/rivet.md` pins. The `opencode-ai` package on npm is the V1 line (1.19.6), so V2 needs this package. **An addition beyond the allowed list, named here** |
| `opencode-ai` | 1.19.6 | MIT | The 1.x control for T1 and T3 |
| `zod` | 4.6.7 | MIT | Validation at every boundary |
| `typescript` | 7.0.2 | Apache-2.0 | `tsc --noEmit`; the code runs on Node 24's type stripping |
| `@types/node` | 24.19.2 | MIT | Node types |
| `vitest` | 5.1.1 | MIT | Unit tests |

`pnpm lint` adds no dependency. It runs the root workspace's ESLint 10.15.0 (MIT), typescript-eslint 8.73.0 (MIT) and eslint-plugin-unicorn 80.0.0 (MIT), which type-check against the root's TypeScript 6.0.3, so it needs the root's `pnpm install`. The container image is `node:24.14.0-bookworm-slim`, plus Debian's git, procps, lsof, tcpdump, iptables, ca-certificates and curl.

The wrappers' postinstall scripts are denied (`allowBuilds` in `pnpm-workspace.yaml`): the binary is resolved from the platform package. pnpm 11's minimum release age needed exclusions for the pinned OpenCode and vitest releases.
