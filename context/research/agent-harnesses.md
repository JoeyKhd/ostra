# Research: driving coding agents programmatically

**Question:** How can ostra's runner start, stream, steer, pause, resume and approve work in Claude Code, OpenCode and oh-my-pi (plus ACP, Codex CLI and Gemini CLI)? What changes if ostra is written in TypeScript instead of Rust?
**Checked:** 2026-11-17. Versions are in [Versions checked](#versions-checked). Claims I could not confirm from a primary source (official docs, README, source, package registry) are marked **unverified**. Secondary sources (blogs, HN) are labelled as such.

---

## Summary

- **"ohmypi" is oh-my-pi (`omp`)**: [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), by Can Bölük / Stencil Labs, MIT. Its README says "omp is a fork of pi-mono by Mario Zechner". Upstream `badlogic/pi-mono` now redirects to [earendil-works/pi](https://github.com/earendil-works/pi). Other name candidates exist but are minor (see [3.1](#31-what-ohmypi-is)).
- **All three day-one agents can run headless, and all three speak ACP.** OpenCode and omp support ACP natively. Claude Code gets it through `@agentclientprotocol/claude-agent-acp`, an Apache-2.0 adapter built on Anthropic's Agent SDK and maintained by the ACP org.
- **Each agent's native interface goes further than ACP v1:**
  - **Claude Code.** `claude -p` takes stream-json in and out. Full two-way control (approval callback, interrupt, model switch) is officially exposed only through the TS/Python Agent SDK. The wire control protocol under it is not in the official docs.
  - **OpenCode V2** (2.0 shipped 2026-09-11 with a breaking server API). `opencode serve` offers an HTTP + SSE API with steer/queue delivery, permission replies, a per-session event log that survives disconnects, and JSON session export/import.
  - **omp.** `omp --mode rpc` is a JSONL protocol with prompt, steer, follow_up and abort, approval dialogs over the wire, and binding to a host-chosen session directory. The repo includes a generated Rust client.
- **ACP** (v1 stable, v2 draft) gives one event and permission model and wide reach (Codex, Gemini, Copilot, Cursor, Goose, …). It has an official Rust crate (`agent-client-protocol` 5.3.0, used by Zed) and an official TS SDK. Gaps for ostra:
  - No mid-turn input in v1 core (only agent-specific extensions).
  - No way to move session state to another machine.
  - No standard way to set approval policy or tool allow/deny lists.
  - End-turn token usage is still a draft.
  - Heavy churn: the Rust crate went from 1.0 to 5.3 in five months.
- **Resuming on another machine works for all three, but each needs its own mechanism:**
  - Claude Code: JSONL transcripts, or the SDK's `SessionStore`.
  - omp: JSONL plus blobs and artifacts.
  - OpenCode V2: a SQLite store with JSON export/import.

  All three key sessions by working directory. Claude Code also deletes transcripts after 30 days by default.
- **Terms:** Anthropic forbids third-party apps from offering Claude.ai login or routing Free/Pro/Max/Ultra credentials on behalf of users. A user may sign in to the **unmodified Claude Code binary** with their own subscription. So shared runners need API keys or cloud-provider credentials, and a Claude subscription must not be used inside OpenCode or omp ([legal page](https://code.claude.com/docs/en/legal-and-compliance)).
- **Distribution:**
  - Claude Code ships as a Bun-compiled single binary. I confirmed Bun's marker in the 2.1.326 linux-x64 binary.
  - OpenCode V2 is also a Bun-compiled single binary (`Bun.build({ compile })` in its build script).
  - omp's default install is a Bun-compiled binary.
  - pi is a Node package.
- **TypeScript vs Rust:** the first-party SDKs are TypeScript (Claude Agent SDK, `@opencode/client`, omp/pi SDKs, ACP TS SDK). A TS ostra could drive Claude Code and OpenCode through official libraries. A Rust ostra drives them through the CLI/HTTP, or through ACP with the TS-built adapter. Either way, run agents as **subprocesses**, not in-process. See [TypeScript vs Rust](#typescript-vs-rust-for-driving-agents).
- **Recommendation: hybrid.**
  - ostra defines its own driver interface and event model, shaped like ACP so mapping to it is thin.
  - Ship one generic ACP driver first and use it for all three agents.
  - Each agent gets a native "profile" for what ACP can't do: launch flags and environment, credentials, approval defaults, and session archive/restore.
  - Add native drivers only where a spike shows ACP v1 hurts. omp RPC and OpenCode HTTP are the likely ones, for steering and replay.
- **Biggest risks:** provider terms on shared runners; interface churn in all four (Claude, OpenCode V1→V2, omp releasing several times a week, ACP v2); session portability; and headless permission defaults that differ widely (OpenCode V2 and omp allow everything by default).

---

## Versions checked

| Component | Version (date) | License | Source |
|---|---|---|---|
| Claude Code CLI | 2.1.326 (2026-11-16) | Proprietary ("SEE LICENSE IN README.md") | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-code) |
| Claude Agent SDK (TS) | 0.3.326 (2026-11-16), bundles Claude Code 2.1.326 | Anthropic Commercial Terms | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), [overview](https://code.claude.com/docs/en/agent-sdk/overview) |
| claude-agent-acp | 0.108.0 (2026-11-17) | Apache-2.0 | [repo](https://github.com/agentclientprotocol/claude-agent-acp) |
| OpenCode V2 (`@opencode/cli`, `@opencode/client`, `@opencode/sdk`) | 2.3.0 (2026-11-13). 2.0.0 was 2026-09-11 | MIT | [npm](https://www.npmjs.com/package/@opencode/cli), [docs](https://opencode.ai/docs/) |
| OpenCode V1 (`opencode-ai`, `@opencode-ai/sdk`) | 1.19.6 (2026-11-17), still released | MIT | [repo](https://github.com/anomalyco/opencode) (moved from `sst/opencode`) |
| oh-my-pi (`omp`, `@oh-my-pi/pi-coding-agent`) | v18.22.0 (2026-11-16) | MIT | [repo](https://github.com/can1357/oh-my-pi) |
| pi (`@earendil-works/pi-coding-agent`) | v1.5.2 (2026-11-10) | MIT | [repo](https://github.com/earendil-works/pi), [pi.dev](https://pi.dev) |
| ACP schema | schema-v1.32.0 (2026-11-14) | Apache-2.0 | [repo](https://github.com/agentclientprotocol/agent-client-protocol) |
| ACP Rust crate `agent-client-protocol` | 5.3.0 (2026-11-14) | Apache-2.0 | [crates.io](https://crates.io/crates/agent-client-protocol) |
| ACP TS SDK `@agentclientprotocol/sdk` | 2.7.0 (2026-11-14) | Apache-2.0 | [npm](https://www.npmjs.com/package/@agentclientprotocol/sdk) |
| Codex CLI `@openai/codex` / codex-acp | 0.169.0 (2026-11-13) / 2.7.0 (2026-11-16) | Apache-2.0 | [npm](https://www.npmjs.com/package/@openai/codex) |
| Gemini CLI `@google/gemini-cli` | 0.68.0 (2026-11-10) | Apache-2.0 | [npm](https://www.npmjs.com/package/@google/gemini-cli) |

---

## Comparison

Day-one agents, plus ACP v1 as a common layer. Codex and Gemini are in [section 5](#5-future-candidates).

| | **Claude Code** | **OpenCode (V2)** | **oh-my-pi (omp)** | **ACP v1 (common layer)** |
|---|---|---|---|---|
| Main headless interface | `claude -p` with `--input-format stream-json --output-format stream-json`; Agent SDK (TS/Python) | `opencode serve` HTTP API + SSE; `opencode run --format json` | `omp --mode rpc` / `rpc-ui` (JSONL over stdio); `--mode json`; `-p` | JSON-RPC 2.0 over stdio |
| Official TS library | `@anthropic-ai/claude-agent-sdk` (spawns the bundled binary) | `@opencode/client` (network), `@opencode/sdk` (in-process) | `@oh-my-pi/pi-coding-agent` SDK (Bun, in-process) + TS `RpcClient` | `@agentclientprotocol/sdk` |
| Official Rust library | None (crates.io `claude-agent-sdk` is **not** Anthropic's) | None (generate from OpenAPI) | `sdk/rust/omp-rpc` in repo (generated types, blocking I/O, `publish = false`) | `agent-client-protocol` (used by Zed) |
| ACP | Adapter (`claude-agent-acp`) | Native `opencode acp` | Native `omp acp` | n/a |
| Distribution | Bun-compiled native binary per platform (npm wrapper + installer) | Bun-compiled binary per platform (npm wrapper, installer, desktop app) | Bun-compiled binary by default; npm package needs Bun ≥ 1.4.4 | n/a |
| Start in a directory with a prompt | Spawn in worktree; prompt as argument or stdin message; `--session-id <uuid>` | `POST /api/session {location.directory}` then `POST …/prompt` | Spawn with `--cwd`/`--session-dir`, send `prompt` | `session/new {cwd}` then `session/prompt` |
| Streaming detail | Token deltas (`stream_event`), full assistant/user messages, tool_use/tool_result blocks, `result` | Text/reasoning/tool-input deltas, tool lifecycle, step/execution events | `message_update` deltas, `tool_execution_*`, `prompt_result`, `session_settled` | `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)` with diffs, `plan` |
| Input while running | Yes: streaming input; a message sent during tool calls is delivered after they finish; `priority` field | Yes: `delivery: "steer" \| "queue"` | Yes: `steer`, `follow_up`, `prompt.streamingBehavior` | **No** in v1 core (OpenCode rejects a 2nd prompt). Claude adapter has a `_session/steering` extension |
| Interrupt | SDK `interrupt()`; SIGINT ends the turn | `POST …/interrupt` | `abort`, `abort_and_prompt` | `session/cancel` |
| Resume later | `--resume <id \| name \| path.jsonl>`, `--fork-session` | Sessions persist in the server DB; prompt again | `--resume`, `--continue`, `open_session {sessionDir}` | `session/load` (replays history) / `session/resume` (doesn't) |
| Where state lives | `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; 30-day cleanup by default | SQLite (`opencode debug paths db`, `OPENCODE_DB`) | `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` + `blobs/` + artifacts | Agent-local; ACP has no state transfer |
| Move to another machine | SDK `SessionStore` (S3/Redis/Postgres); or copy JSONL and `--resume <path>`; same cwd expected | `opencode session export` / `import --directory` | Copy JSONL + blobs + artifacts; missing cwd can be re-rooted | Not covered |
| Approvals to an external UI | SDK `canUseTool`; `--permission-prompt-tool` (MCP); `PermissionRequest` hooks | `permission.asked` event → `POST …/permission/{id}/reply` (`once`/`always`/`reject`) | `extension_ui_request` select (needs `rpc-ui`); ACP `session/request_permission` | `session/request_permission` (allow/reject once/always) |
| Headless default | Manual: approval-needing calls are **denied** unless approved (v2.1.302+) | **Allow everything** except `.env` reads; outside-dir access allowed | **`yolo`** (approve all) | Agent-defined |
| Skip permissions | `--dangerously-skip-permissions` (refused as root outside a sandbox) | `opencode run --auto`, or allow rules | `--yolo` / `--approval-mode yolo` | n/a |
| System prompt injection | `--append-system-prompt[-file]`, `--system-prompt[-file]` | Agent `system` in config; per-session instruction entries (experimental) | `--append-system-prompt`, `--system-prompt`, template | `session/new.systemPrompt` (stable) |
| MCP injection | `--mcp-config` + `--strict-mcp-config` | Config `mcp`; ACP per-session `mcpServers` | `.mcp.json`/config; RPC host tools | `mcpServers` on new/load/resume |
| Model | `--model`, `--fallback-model`, SDK `setModel` | Per session (`model`, `switchModel`) | `--model`, `set_model` | Config option, category `model` |
| Tool allow/deny | `--tools`, `--allowedTools`, `--disallowedTools`, rules | Ordered `permissions` rules; per-session ruleset | `--tools`, `tools.approval.<tool>`, `bash.patterns` | Not standardised |
| Usage/cost | `result.total_cost_usd`, usage, per-model cost (client-side estimate) | `session.usage.updated` | Message `usage`; `--max-cost` | `usage_update` (context + cumulative cost); end-turn tokens draft |
| Server for remote clients | No (Remote Control only works with claude.ai) | Yes (`--hostname`, basic auth, pairing) | No (stdio only) | stdio only; HTTP/WebSocket RFD is a draft |
| Release pace | Near-daily patch releases | Daily; V2 is 2 months old | Several per week; v18 in under 11 months | Crate releases monthly with breaking majors |

---

## 1. Claude Code

### 1.1 Programmatic interfaces

**Print mode, `claude -p`.** The docs call this "the Agent SDK via the CLI" ([headless](https://code.claude.com/docs/en/headless)).

Flags ([cli-reference](https://code.claude.com/docs/en/cli-reference)):
- `--output-format text|json|stream-json`
- `--input-format text|stream-json`
- `--include-partial-messages` for token deltas. It needs stream-json and `--verbose`.
- `--replay-user-messages`
- `--forward-subagent-text`
- `--include-hook-events`
- `--json-schema`
- `--max-turns`, `--max-budget-usd`
- `--no-session-persistence`

**`--bare` mode.** The docs call it "the recommended mode for scripted and SDK calls" and say it "will become the default for `-p` in a future release". It skips hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md. It also never reads OAuth credentials or the keychain, so it needs `ANTHROPIC_API_KEY`, `apiKeyHelper` or cloud credentials.

**stream-json output.** One JSON object per line ([headless](https://code.claude.com/docs/en/headless)):
- `system/init` comes first. It reports model, tools, `mcp_servers`, plugins and a `capabilities` array (e.g. `interrupt_receipt_v1`) for feature detection.
- `assistant` and `user` messages carry Anthropic content blocks: text, thinking, `tool_use`, `tool_result`. `parent_tool_use_id` links subagent messages.
- `stream_event` carries raw API deltas when partial messages are on.
- `system/api_retry` and `permission_denied` system messages.
- A final `result` carries the result text, `session_id`, `total_cost_usd`, a per-model cost breakdown, usage, `num_turns` and `permission_denials`.

There is no separate file-edit or diff event. Edits show up as `Edit`/`Write` tool calls, so ostra should compute diffs from git.

**Agent SDK** ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). TypeScript `@anthropic-ai/claude-agent-sdk` and Python `claude-agent-sdk`. It is "a library that runs the Claude Code binary".

The TS SDK bundles a native Claude Code binary per platform as an optional dependency. "SDK v0.3.191 bundles Claude Code v2.1.191." `pathToClaudeCodeExecutable` overrides it ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)).

`query()` takes a prompt string or an async iterable of `SDKUserMessage`. It returns a `Query` with these methods:
- `interrupt()`, `setPermissionMode()`, `setModel()`
- `streamInput()`, `close()`
- `mcpServerStatus()`, `setMcpServers()`
- `supportedModels()`, `getContextUsage()`, `rewindFiles()`, `backgroundTasks()`

Options include:
- `cwd`, `resume`, `resumeSessionAt`, `continue`, `forkSession`, `sessionId`
- `systemPrompt` (`{type:'preset', preset:'claude_code', append}`), `mcpServers`
- `allowedTools`, `disallowedTools`, `tools`
- `permissionMode`, `canUseTool`, `hooks`
- `env` (replaces the subprocess environment), `settingSources`
- `includePartialMessages`, `maxBudgetUsd`, `sessionStore`

For other languages the docs say to "run the CLI as a subprocess with the `-p` flag".

**Wire control protocol.** The SDKs drive the CLI over stream-json with `control_request`/`control_response` frames: initialize, `can_use_tool`, interrupt, set model or permission mode, hook callbacks, SDK MCP messages, via `--permission-prompt-tool stdio`. This protocol is **not in the official docs**. A third-party Go SDK documents it and notes "Most of this is undocumented in official sources" ([Roasbeef/claude-agent-sdk-go cli-protocol.md](https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md)). Treat it as unstable.

**Rust.** There is no official SDK. Community crates include `claude-agent-sdk-rs` 0.6.4 (tyrchen) and `cc-sdk` 0.8.1. The crates.io name `claude-agent-sdk` belongs to an individual, and its linked `anthropics/claude-agent-sdk-rust` repo returns 404 (checked via the crates.io and GitHub APIs).

**ACP.** Claude Code has no native ACP. Use [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) (formerly `@zed-industries/claude-code-acp`), which is built on the official Agent SDK.
- It ships standalone executables that bundle the `claude` CLI and need no Node.
- It serves ACP v1 and draft v2.
- It supports permission requests, elicitation, session list/resume/fork, client MCP servers and nested subagent transcripts.
- It supports steering through the extension method `_session/steering`, advertised via `_meta.steering.supported` (source `src/v1/steering.ts`).
- Its `--hide-claude-auth` flag refuses any session that a Free/Pro/Max/Team subscription would pay for (source `src/hide-claude-auth.ts`).

**Overlapping Anthropic products**, not APIs for ostra:
- `claude remote-control` (control from claude.ai or the Claude app)
- "self-hosted environments", which run Anthropic cloud sessions on your own runners ([docs index](https://code.claude.com/docs/llms.txt))

### 1.2 Session lifecycle

- **Start.** Spawn in the worktree. Pass `--session-id <uuid>` so ostra picks the ID, and give the prompt as an argument or a stream-json user message.
- **Follow-ups while running.** With streaming input, "A message you send during tool calls reaches Claude after those tool calls finish. Claude then answers it and your earlier message in one response." `SDKUserMessage.priority` chooses when it is read ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)). Without streaming input, use one process per turn plus `--resume`.
- **Interrupt.** In the SDK, `interrupt()` ends the response with `error_during_execution` and keeps the session open; unread queued messages are still delivered. On the CLI, SIGINT ends the turn, while SIGTERM exits 143 and leaves the turn unfinished ([headless](https://code.claude.com/docs/en/headless)). Whether a long-lived stream-json process survives SIGINT and keeps reading stdin is **unverified**.
- **Resume** ([sessions](https://code.claude.com/docs/en/sessions)):
  - `--resume <session-id | name | absolute .jsonl path>`, `--continue`, `--fork-session`.
  - `-p` and SDK sessions are hidden from the picker but can be resumed by ID.
  - Flags you must pass again on resume: `--mcp-config`, `--plugin-dir`, `--add-dir`, `--settings`, `--fallback-model`.
  - The system prompt is recorded on the first request and reused, unless `--system-prompt-snapshot off`.
  - `-p` resumes start in the normal `-p` permission mode, not the saved one.
  - `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues an interrupted turn.
- **Storage.** `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the cwd with non-alphanumerics replaced by `-`. The format "is internal to Claude Code and changes between versions".
  - Retention: 30 days by default (`cleanupPeriodDays`).
  - `CLAUDE_CONFIG_DIR` moves storage. With it, `CLAUDE_CODE_PROJECT_DIR_NAME` fixes the project folder name (v2.1.234+).
  - Changing `CLAUDE_CONFIG_DIR` loses a claude.ai login unless credentials are copied ([session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage)).
- **Moving to another machine** ([session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage)):
  - The official route is the SDK `SessionStore`, with `append`/`load` plus optional `listSessions`/`listSubkeys`, mirroring transcripts to S3/Redis/Postgres. A session "can be resumed on another host running from a matching working directory".
  - It is TS/Python only and dual-writes: local disk first, then the store.
  - By hand: copy the `.jsonl` and run `--resume <path>`. Resume-by-ID refuses when it finds duplicate copies.
  - Behaviour when the target cwd differs is **unverified**.
- **Concurrency.** Two processes resuming one session write to one transcript "and messages from one of them can be missing". ostra needs a single writer per session.

### 1.3 Permissions and approvals

- **Modes:** `default`/Manual, `acceptEdits`, `plan`, `auto` (classifier), `dontAsk`, `bypassPermissions` ([permission-modes](https://code.claude.com/docs/en/permission-modes)).
  - "In Claude Code v2.1.302 or later, `claude -p` and Agent SDK runs with no permission mode set start in Manual mode … Calls needing approval are denied unless you approve them."
  - `--dangerously-skip-permissions` is refused under root/sudo except "inside a recognized sandbox".
  - Some actions are never auto-approved, such as critical-path `rm` and explicit ask rules.
- **Routing approvals to the ostra UI:**
  1. **SDK `canUseTool`.** It returns allow (with `updatedInput`/`updatedPermissions`) or deny (with `message`). `AskUserQuestion` also arrives here. "The callback can stay pending indefinitely." To let the process exit while waiting, a `PreToolUse` hook can return `defer` and the run resumes later ([user-input](https://code.claude.com/docs/en/agent-sdk/user-input)).
  2. **`--permission-prompt-tool mcp__<server>__<tool>`.** This is the documented CLI-only route: the runner hosts an MCP server whose tool blocks until the UI answers.
  3. **`PermissionRequest` hooks.**
  4. **`--permission-prompts none`** or `permissions.denyInsteadOfPrompting` for unattended runs.
- **Rules:** `--allowedTools`, `--disallowedTools`, `--tools`, and settings permission rules.
- **Security note.** Without `--bare`, a `-p` session runs the repo's `.claude/settings.json` hooks and connects `.mcp.json` servers "even in a folder you've never trusted" ([headless](https://code.claude.com/docs/en/headless)). This matters for Q-14 because tickets point at arbitrary repos.

### 1.4 Auth and terms

- **Credentials:**
  - claude.ai OAuth login (keychain or credentials file)
  - `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (long-lived, subscription-backed)
  - `ANTHROPIC_API_KEY`, `apiKeyHelper`
  - Bedrock, Google Cloud Agent Platform, Microsoft Foundry
  - Sources: [session-storage](https://code.claude.com/docs/en/agent-sdk/session-storage), [headless](https://code.claude.com/docs/en/headless)
- **Terms** ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-11-17):
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
  - Team-provisioned API keys are fine "for use by the customer's own authorized users", provided usage is billed to the key owner and not resold.
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Running Claude Code inside a product requires the Commercial Terms, an unmodified binary, and no paying for or intermediating usage on end users' behalf.
- **What this means for ostra** (my reading, not legal advice):
  - A teammate's laptop runner using that teammate's own login is permitted for the unmodified binary. It should only run that teammate's tasks, and heavy automated dispatch may stretch "ordinary, individual usage" (**unclear**).
  - A shared remote runner must use the team's API key or cloud credentials.
  - ostra should never collect or store claude.ai tokens. Storing `CLAUDE_CODE_OAUTH_TOKEN` for users probably counts as "store … session tokens".
- **Enforcement history** (secondary sources):
  - Server-side checks from 2026-01-09.
  - The terms section was added in February 2026.
  - OpenCode removed Claude OAuth in PR #18186 ("anthropic legal requests", 2026-03-19).
  - Subscriptions were blocked for third-party harnesses from 2026-04-04.
  - Sources: [ridakaddir.com](https://ridakaddir.com/blog/post/did-anthropic-kill-opencode-claude-subscription-ban), [jcubic/opencode-claude-plan](https://github.com/jcubic/opencode-claude-plan), [dev.to](https://dev.to/mcrolly/anthropic-kills-claude-subscription-access-for-third-party-tools-like-openclaw-what-it-means-for-3ipc), [HN](https://news.ycombinator.com/item?id=47444748).

### 1.5 Remote operation

There is no server that arbitrary clients can attach to. ostra must wrap it: the runner spawns the agent locally and relays events to the ostra server.

### 1.6 Configuration ostra would inject

- System prompt: `--append-system-prompt[-file]`, `--system-prompt[-file]`, `--exclude-dynamic-system-prompt-sections` (better prompt-cache reuse across users).
- MCP: `--mcp-config` + `--strict-mcp-config`.
- Model: `--model`, `--fallback-model`.
- Tools: `--tools`, `--allowedTools`, `--disallowedTools`.
- Settings: `--settings`, `--setting-sources`.
- Other: `--agents`, `--plugin-dir`, `--add-dir`, `--max-turns`, `--max-budget-usd`.
- The SDK equivalents are options, and model/permission mode can change mid-session.

### 1.7 Stability

- The flags are documented with "requires vX" notes, and `system/init.capabilities` supports feature detection.
- The transcript format is explicitly internal.
- The control protocol is undocumented.
- Releases are near-daily (patch number 326 on the 2.1 line).
- Proprietary.

---

## 2. OpenCode

### 2.0 Which OpenCode

- The repo moved from `sst/opencode` to [anomalyco/opencode](https://github.com/anomalyco/opencode) (MIT, about 227k stars).
- Two release lines exist:
  - **V1:** `opencode-ai` 1.19.6, still released.
  - **V2:** `@opencode/cli`, `@opencode/client`, `@opencode/sdk` at 2.3.0. 2.0.0 shipped 2026-09-11.
- The docs at opencode.ai/docs describe V2. V2's intentional breaking changes are the plugin API, "the server API and clients", and TUI config ([migrate-v1](https://opencode.ai/docs/migrate-v1/)). ostra should target V2 only.

### 2.1 Programmatic interfaces

- **Client/server design.** The TUI, desktop app and web UI are all clients of one server. Relevant commands ([commands](https://opencode.ai/docs/cli/commands/)):
  - `opencode serve [--hostname --port --cors]`
  - a background service (`opencode service start|stop|set …`)
  - `--standalone` (a private server for one command), `--server <url>`
  - `opencode api <operationId>`
- **HTTP API** ([API reference](https://opencode.ai/docs/api/), [openapi.json](https://opencode.ai/docs/openapi.json), OpenAPI 3.1, 173 operations, routes under `/api`):
  - Sessions: `session.create` (`location.directory`, `model`, `agent`, `permissions` ruleset, `parentID`, `metadata`), `session.prompt`, `session.interrupt`, `session.fork`, `session.switchModel`, `session.switchAgent`, `session.compact`, `session.diff`, `session.revert.*`.
  - Messages and queue: `session.message.list`, `session.inbox.*` (queued input).
  - Approvals and questions: `session.permission.*`, `session.form.*` (questions).
  - Transfer: `experimental.session.export` / `experimental.session.import`.
  - Instructions: `experimental.session.instructions.entry.put` (per-session instructions).
  - Events: `GET /api/event` is SSE and "Volatile by contract: a slow consumer overflows and fails the stream, and events during disconnection are missed". `GET /api/experimental/session/{id}/log?after=<seq>&follow=true` is a durable per-session event log that can be read after a disconnect.
  - Caveat: the spec's own `info` block says `version: "0.0.1"` and "Experimental HttpApi surface for selected instance routes", while the docs call it "the released V2 API".
- **TS libraries:** see [2.8](#28-typescript-libraries).
- **One-shot runs.** `opencode run --format json` prints NDJSON. Related flags: `--continue`, `--session`, `--model`, `--agent`, `--auto` ("Auto-approve permissions that are not explicitly denied"), `--archived`, `--standalone`.
- **ACP.** Native `opencode acp` over stdio ([ACP page](https://opencode.ai/docs/cli/acp/)):
  - Capabilities: `loadSession`, resume, list, close, delete, fork, config options, elicitation forms, `usage_update`, and end-turn `usage` (draft RFD).
  - `session/load` replays history; resume and fork don't.
  - "the client must pass that session's directory as `cwd`".
  - "A session runs one prompt at a time. OpenCode returns an error for a second `session/prompt` while the first is active."

### 2.2 Session lifecycle

- **Start.** `POST /api/session` with `{location:{directory:"/abs/worktree"}, model, agent, permissions}`, then `POST /api/session/{id}/prompt {text, files, delivery, resume}`. The prompt is "durably admitted" and the call returns right away.
- **Stream.** SSE events:
  - Text and reasoning: `session.text.delta`, `session.reasoning.delta`.
  - Tools: `session.tool.input.delta`, `session.tool.called|progress|success|failed`.
  - Steps and executions: `session.step.*`, `session.execution.started|succeeded|failed|interrupted`.
  - Status and usage: `session.usage.updated`, `session.retry.scheduled`, `session.compaction.*`, `session.status`, `session.idle`.
  - Approvals and questions: `permission.asked|replied`, `form.created|replied`.
  - (Event enum from the OpenAPI spec.)
- **Follow-ups.** `delivery: "steer" | "queue"`. Queued items can be listed, edited and cancelled through `session.inbox.*`.
- **Interrupt.** `POST …/interrupt`. With `?resume=true`, execution continues with pending steering input and queued prompts stay parked.
- **Resume.** Sessions live in the server's store across restarts; prompt again days later. Rebuild the UI from `session.message.list` or the durable log.
- **Storage.** SQLite. Find it with `opencode debug paths db`; `OPENCODE_DB` overrides it ([cli](https://opencode.ai/docs/cli/)). Snapshots for revert live "in a separate internal Git object database under its data directory" ([snapshots](https://opencode.ai/docs/snapshots/)).
- **Moving to another machine.** `opencode session export <id> [--sanitize]` and `opencode session import file.json --directory <dir>`. Import "Accepts transcripts exported by earlier releases" and must import parents before children. Whether snapshots or revert state travel with an export is **unverified**.

### 2.3 Permissions

- **Rules.** V2 uses ordered `{action, resource, effect: allow|ask|deny}` rules. Actions include `shell`, `edit`, `read`, `external_directory`, `subagent`, … ([permissions](https://opencode.ai/docs/permissions/)).
- **Defaults.** The base policy is `{"action":"*","resource":"*","effect":"allow"}`, plus `ask` for `.env` reads. "V1 asks before accessing paths outside the project. V2 does not."
- **Admin policies** can hard-deny on top of the rules.
- **Approvals to the UI:**
  - The `permission.asked` event leads to `POST …/permission/{requestID}/reply {decision: "once"|"always"|"reject", message}`.
  - `reject` "Reject[s] it and every other pending permission request in that session".
  - `always` saves project-scoped allow patterns.
  - Questions go through forms.
  - "Non-interactive clients must decide how to handle approval requests."
- **Per-session ruleset.** `session.create.permissions` sets the rules for one session.

### 2.4 Auth

- **Providers:**
  - `opencode auth login <provider> [--method key]`, `auth list|switch|logout`.
  - `opencode auth export|import`, which moves credentials between machines; the file contains secrets.
  - Provider env vars such as `ANTHROPIC_API_KEY`.
  - GitHub Copilot device OAuth.
  - OpenCode's own Console / Go subscription ([providers](https://opencode.ai/docs/providers/)).
- **Server auth.** HTTP Basic. The user is always `opencode` and `OPENCODE_PASSWORD` sets the password. `opencode pair` makes one-time links ([migrate-v1](https://opencode.ai/docs/migrate-v1/)).
- **Claude subscriptions.** Pro/Max OAuth was removed in March 2026 (secondary sources in [1.4](#14-auth-and-terms)). Use an Anthropic API key or a gateway. Third-party plugins that restore it conflict with Anthropic's terms.

### 2.5 Remote operation

OpenCode is the only one of the three with a real server mode: bind address, basic auth, CORS, pairing, and an optional OpenTunnel remote ([commands](https://opencode.ai/docs/cli/commands/)). For ostra: keep `opencode serve` bound to loopback on the runner and let the runner relay outbound. Never expose it directly.

### 2.6 Configuration ostra would inject

- Per session: model, agent, permission ruleset, and instruction entries (experimental).
- In config: agents (`system`), `instructions`, `mcp`, providers and policies.
- `OPENCODE_DISABLE_PROJECT_CONFIG` ignores repo config, which matters for Q-14.
- ACP clients can pass per-session `mcpServers` and `systemPrompt`.
- **Unverified:** whether V2 honours an env var for an injected config file (V1 had `OPENCODE_CONFIG`), and whether the HTTP API takes per-session MCP servers.

### 2.7 Stability

MIT, very active (daily releases). Risks:
- V2 is two months old and broke the server API.
- The spec labels itself experimental.
- Events are live-only, apart from the experimental log.

### 2.8 TypeScript libraries

- **`@opencode/client` 2.3.0.** The network client, "generated from the same contract as the API reference" ([client](https://opencode.ai/docs/build/client/)).
  - Calls are grouped by resource, e.g. `client.session.create/prompt/interrupt`.
  - `client.event.subscribe({types})` returns an async iterable. It has no replay or auto-reconnect, so resync after `server.connected`.
  - `@opencode/client/service` provides `Service.ensure()` to discover or start the local background server.
  - Browser-compatible.
- **`@opencode/sdk` 2.3.0.** An in-process host that runs the server's HTTP router in memory with no listener ([SDK](https://opencode.ai/docs/build/sdk/)). It has the same API surface and also accepts plugins. Install instructions use `bun add`, and it depends on `effect` and `@opencode/server`. Whether it runs on Node is **unverified**.
- **V1 `@opencode-ai/sdk`** (1.19.6) targets the V1 API. Don't use it for new work.
- **Compared with Rust:** a Rust runner calls the same HTTP API. It needs codegen from `openapi.json` (517 schemas) or hand-written types for the subset it uses, plus its own SSE client. The surface is the same; TS just gets types maintained upstream.

---

## 3. oh-my-pi (and pi)

### 3.1 What "ohmypi" is

| Candidate | What it is | Verdict |
|---|---|---|
| **oh-my-pi / `omp`** ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), npm `@oh-my-pi/pi-coding-agent`) | "Coding agent with the IDE wired in. Built by Stencil Labs." A fork of pi-mono with many features built in: LSP, DAP, subagents, 60+ providers, a Rust core over NAPI. Repo created 2025-12-31, about 39k stars, v18.22.0 | **Almost certainly what the user meant.** README: "omp is a fork of pi-mono by Mario Zechner" |
| **pi** ([earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`, npm `@earendil-works/pi-coding-agent`) | Mario Zechner's minimal upstream agent, now under Earendil Inc. | The base omp builds on. Relevant as a fallback |
| npm `oh-my-pi` 0.2.0 ([acidsugarx/oh-my-pi](https://github.com/acidsugarx/oh-my-pi)) | "Enhancement framework for Pi CLI coding agent", an extension pack for pi | Unlikely. Small |
| `oh-my-opencode` / oh-my-openagent (code-yeongyu) | An OpenCode plugin with a similar name | Different product |
| GitHub `ajjucoder/ohmypi` and similar | 0-star personal repos | Irrelevant |

### 3.2 pi's programmatic modes (upstream baseline)

pi has four modes: interactive, print/JSON (`pi -p`, `--mode json`), RPC (`--mode rpc`) and SDK ([pi.dev](https://pi.dev)).

**RPC** is strict JSONL over stdio and "not JSON-RPC" ([rpc.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [rpc-commands.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)):
- Commands: `prompt` (with `streamingBehavior: "steer"|"followUp"`), `steer`, `follow_up`, `abort`, `new_session`, `switch_session`, `fork`, `clone`, `get_state`, `get_messages`, `set_model`, `compact`, `bash`, …
- Events: `message_update` (`text_delta`), `agent_end`, `agent_settled`, …
- Extension dialogs: `extension_ui_request`/`response`.

**Other details:**
- **Sessions:** `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`, stored as a tree of entries ([session-format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)).
- **No built-in approvals.** Pi "does not ask for approval before every tool call". Project trust controls whether `.pi/` resources load, and headless modes skip untrusted ones ([security.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)).
- **ACP:** through the third-party [pi-acp](https://github.com/svkozak/pi-acp) adapter (0.0.34).

### 3.3 omp interfaces

- **Modes:** `--mode text|json|rpc|rpc-ui|acp`, `-p`, `omp acp`, and the Bun SDK ([cli-reference](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md)).
- **RPC protocol.** omp's protocol is a superset of pi's ([docs/rpc.md](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)):
  - **Framing.** A `ready` frame advertises protocol versions 1 and 2. v2 adds `rpc_chunk` framing for frames over 1 MiB (up to 64 MiB). Responses correlate by `id`.
  - **Commands:**
    - Prompting: `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `remove_queued_message`.
    - Sessions: `new_session`, `open_session {sessionDir}`, `switch_session`, `fork`, `navigate_tree`, `handoff`.
    - Model: `set_model`, `set_thinking_level`.
    - State and history: `get_state`, `get_messages_page`.
    - Other: `compact`, `bash`, and `login`/`logout` (credentials over RPC; secret prompts are refused).
  - **Completion.** Each prompt finishes with exactly one `prompt_result {status: completed|aborted|error, error.retryable}`. `session_settled` means no background work can wake the agent again.
  - **Events:**
    - Agent and turn: `agent_start|end`, `turn_start|end`.
    - Messages: `message_start|update|end`, with a stable `messageId`.
    - Tools: `tool_execution_start|update|end`.
    - Housekeeping: `auto_compaction_*`, `auto_retry_*`, `queue_update`, `notice`, …
  - **Event filtering.** `set_event_filter` can restrict event types and send delta-only message updates.
  - **Host tools.** `set_host_tools` registers ostra's own tools, which arrive as `host_tool_call`. This is a way to give the agent ostra tools without MCP. There are also host URI schemes and subagent event subscriptions.
  - **Backpressure.** Under backpressure the server spills output to a temp file instead of dropping it.
- **Clients.** A wire JSON Schema generates the TypeScript, Python (`omp-rpc`), Go and **Rust** clients. The Rust client is [`sdk/rust/omp-rpc`](https://github.com/can1357/oh-my-pi/tree/main/sdk/rust/omp-rpc):
  - serde types for every frame, plus a blocking reader/writer transport.
  - `prompt_and_wait`, host tools, process-group teardown.
  - `publish = false`, so it is not on crates.io.
  - A CI test fails when a generated client is out of date.
- **ACP.** Native. Source shows `loadSession: true` and `sessionCapabilities.fork/resume/close` ([acp-agent.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/acp/acp-agent.ts)). Writes are gated by `session/request_permission`, and forms map to elicitation. omp is not listed on the ACP agents page.

### 3.4 Session lifecycle

- **Start.** `omp --mode rpc-ui --cwd <worktree> --session-dir <task-dir> [flags]`, wait for `ready`, then send `prompt`.
- **Follow-ups.**
  - `steer` is delivered at the tool-batch boundary, or live where the provider allows.
  - `follow_up` is delivered when the agent would otherwise stop.
  - Queue modes are `all` or `one-at-a-time`, and `set_interrupt_mode` chooses `immediate` or `wait`.
- **Interrupt.** `abort`, or `abort_and_prompt` to stop and send a new prompt in one step.
- **Resume.** `--continue`, `--resume <id|path>`, or `open_session {sessionDir}`. The last is "the runtime equivalent of `--session-dir <dir> --continue`": it binds a pre-spawned process to a host-chosen directory. If the saved model can't be restored, it fails rather than silently switching models.
- **Storage** ([session.md](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)):
  - Transcripts: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. JSONL with a versioned header (`version: 3`, `cwd`, `previousSessionFiles`, `parentSession`) and tree entries.
  - Blobs: content-addressed under `~/.omp/agent/blobs/<sha256>`.
  - Per-session artifacts directory, `history.db`, and credentials in SQLite `agent.db`.
  - `--profile` isolates auth, sessions and settings.
- **Moving to another machine.** Copy the JSONL plus referenced blobs and artifacts. "`--resume` … a missing recorded cwd may be re-rooted into the current directory" ([session ops](https://github.com/can1357/oh-my-pi/blob/main/docs/session-operations-export-share-fork-resume.md)). Interactive mode asks first; RPC behaviour is **unverified**. An OS-level lease per session id stops two processes writing the same session (the second writer forks to a sibling file), so keep one writer.

### 3.5 Permissions

- **Approval mode** (`tools.approvalMode`): `always-ask`, `always-ask-cached`, `write`, or `yolo`. **The default is `yolo`** ([approval-mode.md](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)).
- **Flags and settings:**
  - `--approval-mode`, `--yolo`/`--auto-approve`
  - per-tool `tools.approval.<tool>: allow|deny|prompt`
  - `bash.patterns`
  - `tools.restrictedFolders`, which always prompts, even under yolo
- **Routing approvals to a host:**
  - In RPC, approval prompts reach the host as `extension_ui_request` selects. This needs `--mode rpc-ui`; under `--no-ui`, "tools requiring approval fail closed".
  - In ACP, approvals use `session/request_permission`. ACP has no per-session approval field, so per-session policy needs a separate process with flags or a `--config` overlay.
- **Subagents** run headless in yolo. The parent `task` approval is the authorisation boundary.

### 3.6 Auth

- **Providers.** 60+. API keys come from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or `--api-key`. `/login` offers OAuth for Anthropic, OpenAI Codex, GitHub Copilot, Google Antigravity, SuperGrok, Cursor, Devin and Qwen ([README](https://github.com/can1357/oh-my-pi), [environment-variables.md](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md)). Multiple keys per provider rotate round-robin.
- **Auth broker and gateway.** `omp auth-broker serve` and `omp auth-gateway serve` keep credentials off sandboxed agents: clients "never see the access token" ([auth-broker-gateway.md](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md)). This is a useful pattern for shared runners.
- **Terms.** omp advertises Anthropic `oauth` login, which conflicts with Anthropic's rules for third-party apps ([1.4](#14-auth-and-terms)). ostra should treat omp with Claude models as API-key only. Provider terms for omp's other OAuth logins (Codex/ChatGPT, Copilot, Antigravity) are **unverified**.

### 3.7 Remote operation

There is no agent server mode, only stdio RPC and ACP. `metaharness` has a REST/SSE API but is a benchmark tool. ostra wraps omp: the runner spawns it.

### 3.8 Configuration ostra would inject

- System prompt: `--system-prompt`, `--system-prompt-template`, `--append-system-prompt`.
- Model: `--model` and role models, `--thinking`.
- Tools: `--tools`, `--no-tools`.
- Config overlays and profiles: `--config <overlay.yml>` (repeatable), `--profile`.
- Extensions and context: `--no-extensions`, `--trusted-extension`, `--no-skills`, `--no-rules`, `--no-context-files`.
- Limits: `--max-cost`, `--max-time`.
- MCP comes from `.mcp.json` or config; set `mcp.enableProjectConfig: false` to ignore the repo's file. RPC host tools are another route.

### 3.9 Stability

- **License and pace.** MIT. Very fast: major version 18 in under 11 months.
- **Protocol versioning.** The RPC protocol is versioned (v1/v2 negotiation) and checked against its schema in CI. That makes omp's protocol the most rigorously specified of the three native interfaces.
- **Fork risk.** As a fork it must keep up with upstream pi.

### 3.10 TypeScript libraries and distribution

- **omp SDK.** `@oh-my-pi/pi-coding-agent` embeds the agent in a **Bun** process ("Requires Bun 1.4.4 or newer") ([sdk.md](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md)).
  - Main entry points: `createAgentSession()` → `session.subscribe()`, `session.prompt(text, {streamingBehavior})`, `steer()`, `followUp()`, `abort()`.
  - Also exported: `SessionManager` (file-backed or in-memory, resume/open/list), `ModelRegistry`, `AuthStorage`, and system-prompt options.
  - It runs in-process, with the agent's native addon (`@oh-my-pi/pi-natives`) loaded into the host.
- **omp TS `RpcClient`.** `modes/rpc/rpc-client.ts` spawns `omp --mode rpc` and wraps the protocol.
- **pi SDK.** `@earendil-works/pi-coding-agent` "embeds Pi in a Node.js or Bun process" ([pi sdk.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)). It offers `createAgentSession`, `SessionManager.inMemory()`, and `AgentSessionRuntime` (newSession, switchSession, fork).
- **Distribution:**
  - omp's installer defaults to "the prebuilt binary" ([omp.sh/install](https://omp.sh/install)), produced with `Bun.Build.CompileTarget` targets such as `bun-linux-x64-baseline` ([build-binary.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/scripts/build-binary.ts)).
  - The npm package needs Bun (`engines.bun >= 1.4.4`, `bin: dist/cli.js`).
  - pi ships as a Node package (`engines.node >= 22.19`). Its installer installs Node and the npm package ([pi.dev/install.sh](https://pi.dev/install.sh)).
- **Compared with Rust:** omp is the one case where Rust gets a generated client. It uses blocking threads, so ostra would vendor it or port the transport to tokio using the JSON Schema. The in-process TS SDK is tighter, but it ties ostra's process and runtime (Bun) to omp's dependency tree and release pace.

---

## 4. ACP (Agent Client Protocol)

### 4.1 What it is and its status

- **What.** JSON-RPC 2.0 between a client (editor/host) and an agent that usually runs as the client's subprocess ([overview](https://agentclientprotocol.com/protocol/v1/overview)). It started at Zed and now has its own org ([agentclientprotocol.com](https://agentclientprotocol.com)).
- **Transport.** stdio is the only defined transport. Newline-delimited messages; "The agent MUST NOT write anything to its stdout that is not a valid ACP message". "A remote transport based on Streamable HTTP is being specified" ([transports](https://agentclientprotocol.com/protocol/v1/transports), RFD in Draft).
- **v1 is stable.** Changes go through RFDs: Draft → Preview → Completed ([RFD updates](https://agentclientprotocol.com/rfds/updates)).
- **v2 is a draft.** "v2 as a whole is still labeled draft" ([migration](https://agentclientprotocol.com/protocol/v2/migration)). Five headline changes:
  - The `session/prompt` response only acknowledges acceptance; progress and the stop reason arrive as `state_update`.
  - Updates become upserts by ID.
  - The client filesystem, terminal and session-mode APIs are removed.
  - Capabilities are reorganised.
  - Enums become extensible.
  - Implementers are told to support v1 and v2 side by side.

### 4.2 v1 surface (stable)

- **Agent methods** ([session-setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)):
  - `initialize`, `authenticate`, `logout`
  - `session/new {cwd, mcpServers, additionalDirectories, systemPrompt}`
  - `session/load` (capability `loadSession`; replays history as `session/update`s)
  - `session/resume` (no replay), `session/list`, `session/close`, `session/delete`
  - `session/prompt`, `session/cancel` (notification)
  - `session/set_mode`, `session/set_config_option`
  - `$/cancel_request`
- **Client methods:**
  - `session/request_permission`, with options `allow_once`/`allow_always`/`reject_once`/`reject_always` ([tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls))
  - `fs/read_text_file`, `fs/write_text_file`
  - `terminal/*`
  - `elicitation/create`
- **`session/update` variants:**
  - Messages: user/agent message chunks (with message IDs), agent thought chunks.
  - Tools: `tool_call`, `tool_call_update` (kind, status, content including diffs, locations).
  - Session state: `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`.
  - Usage and notices: `usage_update` (context used/size and cumulative cost), `notice`, `compaction_update`.
- **Stop reasons:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **Recently completed RFDs:**
  - Sessions: session list, resume, close, delete, additional directories.
  - Messages and usage: message IDs, session usage.
  - Client control: client-provided system prompt, elicitation, request cancellation.
  - Configuration and tools: `model_config` category, boolean config options, tool call name.
  - Session notices, session compaction.
- **Still Draft or Preview:**
  - `session/fork` (draft only)
  - end-turn token usage (draft)
  - subagent sessions (preview), plan operations (preview)
  - session status, set_title, archive
  - custom LLM providers, HTTP/WebSocket transport, auth status
  - prompt suggestions, agent skills

### 4.3 Who supports ACP

| Agent | ACP | How |
|---|---|---|
| Claude Code | Adapter | `@agentclientprotocol/claude-agent-acp` 0.108.0, on the Agent SDK; v1 + draft v2; `_session/steering` extension |
| OpenCode | Native | `opencode acp` (V2: load/resume/list/close/delete/fork, elicitation, usage) |
| oh-my-pi | Native | `omp acp` / `--mode acp` (load, resume, fork, close, elicitation) |
| pi | Adapter | [pi-acp](https://github.com/svkozak/pi-acp) 0.0.34 |
| Codex CLI | Adapter | [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) 2.7.0 |
| Gemini CLI | Native | `--experimental-acp` ([cli-reference](https://geminicli.com/docs/cli/cli-reference/)) |
| Others (native) | | GitHub Copilot CLI (preview), Cursor, Goose, Kiro, Qwen Code, Mistral Vibe, OpenHands, Junie, Kimi CLI, Factory Droid, Augment, Cline, … ([agents](https://agentclientprotocol.com/get-started/agents)) |

### 4.4 Libraries and maturity

- **Rust: [`agent-client-protocol`](https://crates.io/crates/agent-client-protocol)** 5.3.0 ([rust-sdk](https://github.com/agentclientprotocol/rust-sdk)).
  - About 6.4M downloads. "Powers the integration with external agents in the Zed editor" ([Rust library](https://agentclientprotocol.com/libraries/rust)).
  - Rebuilt on SACP for 1.0 (2026-06-24). Majors since then: 2.0 (07-23), 3.0 (10-06), 5.0 (11-02), so roughly one breaking release a month.
  - Provides roles (Client/Agent/Proxy/Conductor) and builders. Stable v1 lives in `agent_client_protocol::v1`; draft v2 needs the `unstable_protocol_v2` feature. Many other features are gated `unstable_*` (`session_fork`, `subagents`, `end_turn_token_usage`, `mcp_over_acp`, …).
  - Companion crates: `agent-client-protocol-http` (HTTP/SSE and WebSocket transports), `-conductor` (proxy chains), `-polyfill`, `-rmcp`.
  - Verdict: mature enough for production (Zed uses it), but the API moves fast. Pin an exact version and wrap it.
- **TypeScript: [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)** 2.7.0, with fluent `agent()` / `client()` APIs. The older `ClientSideConnection` / `AgentSideConnection` classes are deprecated, and v2 sits under `/experimental/v2` ([TS library](https://agentclientprotocol.com/libraries/typescript)). claude-agent-acp is built on it. The TS and Rust SDKs reached 1.0 together.

### 4.5 What ACP covers and what it lacks, for ostra

| ostra needs | ACP v1 |
|---|---|
| Live streaming to a web UI | **Yes.** Uniform chunks, tool calls with diffs, plans, usage |
| Permission prompts in the UI | **Yes.** `session/request_permission` + elicitation, the same across agents |
| Start in a worktree with injected system prompt and MCP | **Yes.** `cwd`, `systemPrompt`, `mcpServers` |
| Model choice | Partly. A config option with category `model`; values are agent-specific |
| Follow-ups while running | **No** in the core spec. One prompt in flight; steering only via agent extensions. v2's prompt lifecycle prepares for queued work |
| Interrupt | Yes (`session/cancel`) |
| Resume later on the same machine | Yes (`session/load` / `session/resume`, where supported) |
| Resume on a different machine | **No.** Agent-local storage only; no export/import |
| Tool allow/deny, approval mode, sandbox | **No.** Set per agent at launch (omp's docs say so explicitly) |
| Credentials | Agent-defined `authMethods`; env at spawn |
| Token usage per turn | Draft only (`usage_update` is stable but gives context size and cost) |
| Durable replay from an offset | No. `session/load` replays everything; ostra should keep its own log |
| Remote transport | stdio only. Fine, because the runner spawns the agent locally |

---

## 5. Future candidates

### Codex CLI (OpenAI)

- **Headless runs.** `codex exec` with `--json` prints JSONL events. `codex exec resume [SESSION_ID]` takes `--last` or `--all` ([developer commands](https://learn.chatgpt.com/docs/developer-commands)).
- **App server** ([app-server](https://learn.chatgpt.com/docs/app-server)):
  - JSON-RPC over stdio. A WebSocket transport exists but is "experimental and unsupported".
  - Primitives: threads, turns, items.
  - Methods: `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer` (adds input to a running turn), `turn/interrupt`.
  - Notifications: `item/started|completed`, `item/agentMessage/delta`, `turn/completed`, `thread/tokenUsage/updated`.
  - Approvals: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, with decisions accept, acceptForSession, decline and cancel.
  - Auth: `account/login/start` with `apiKey`, `chatgpt` or `chatgptDeviceCode`.
  - Schemas: `codex app-server generate-json-schema` / `generate-ts` produce version-specific schemas, which suits a Rust codegen pipeline.
- **Storage.** `~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl` under `CODEX_HOME`. This comes from source references in GitHub issues, e.g. [openai/codex#21079](https://github.com/openai/codex/issues/21079); it is not on an official docs page.
- **Other routes.** TS SDK `@openai/codex-sdk` (wraps the CLI). ACP via codex-acp.
- **Implementation.** Native binary per platform behind an npm wrapper. The repo is Rust (`codex-rs`, per the same issue).
- **Terms.** OpenAI's terms for using a ChatGPT-plan login on a shared server are **unverified**.

### Gemini CLI (Google)

- **Headless runs.** `-p`, `--output-format text|json|stream-json`. Events: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` with per-model tokens ([headless](https://geminicli.com/docs/cli/headless/)).
- **Flags:** `--resume latest|<n>`, `--list-sessions`, `--approval-mode default|auto_edit|yolo|plan`, and `--experimental-acp` for native ACP. The ACP integration is the TS SDK's reference "production-ready" agent.
- **Lower priority.** "Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on June 18th, 2026", and it "has not been optimized for Gemini 4 Argon" ([cli-reference](https://geminicli.com/docs/cli/cli-reference/)).
- **Unverified:** Antigravity CLI's programmatic and ACP support, and where Gemini stores sessions.

---

## TypeScript vs Rust for driving agents

### What each language gets officially

| Harness | TypeScript | Rust |
|---|---|---|
| Claude Code | **Agent SDK** `@anthropic-ai/claude-agent-sdk`: `query()`, streaming input, `interrupt()`, `canUseTool`, hooks, `setModel`, `setPermissionMode`, resume/fork, `SessionStore`, typed messages. Bundles a pinned native `claude` binary per platform | No official SDK. Two routes: (a) the CLI with stream-json, plus the documented `--permission-prompt-tool` MCP route for approvals; interrupt and other two-way control rely on the undocumented control protocol; (b) the ACP crate driving `claude-agent-acp`, which is the TS SDK compiled into a standalone binary |
| OpenCode V2 | `@opencode/client` (generated, typed, event iterables, service discovery), `@opencode/sdk` (in-process) | HTTP + SSE with codegen from `openapi.json` |
| omp / pi | In-process SDKs (omp needs Bun; pi runs on Node or Bun) + omp TS `RpcClient` | omp's generated Rust RPC client (unpublished, blocking); pi has no Rust client |
| ACP | `@agentclientprotocol/sdk` 2.7.0 | `agent-client-protocol` 5.3.0 (Zed-grade) |

### How the agents are distributed

The agents themselves don't care what language the runner is written in.

- **Claude Code.** Ships as a Bun single-file executable. The npm package `@anthropic-ai/claude-code` is a wrapper (`bin/claude.exe`, `postinstall`) whose optional dependencies `@anthropic-ai/claude-code-<platform>` each hold an ~371 MB native binary.
  - I downloaded the linux-x64 2.1.326 package and found Bun's standalone-executable marker (`---- Bun! ----`) and `Bun v1.4.4` in the binary.
  - Bun's own announcement says "Claude Code ships as a Bun executable to millions of users" ([bun.com blog](https://bun.com/blog/bun-joins-anthropic)).
  - The Agent SDK bundles the same binary (`@anthropic-ai/claude-agent-sdk-<platform>`, "Native CLI binary for @anthropic-ai/claude-agent-sdk").
- **OpenCode.** Ships as a Bun single-file executable. V2's `packages/cli/script/build.ts` calls `Bun.build({ compile: { target: "bun-…", outfile } })` ([source](https://github.com/anomalyco/opencode/blob/dev/packages/cli/script/build.ts)). `@opencode/cli` and `opencode-ai` are npm wrappers over per-platform packages of about 216–250 MB. The Bun blog also lists OpenCode as built with Bun.
- **omp.** The default install is a Bun-compiled binary; the npm package needs Bun. **pi** needs Node ≥ 22.19 (see [3.10](#310-typescript-libraries-and-distribution)).
- **ACP adapters and others.** claude-agent-acp ships standalone executables or runs under Node ≥ 22. Codex ships a native binary behind an npm wrapper. Gemini CLI is a Node bundle.

### What this means

- **Use subprocesses in either language.** In-process SDKs (omp, pi, `@opencode/sdk`) would tie the runner's runtime, dependency tree and crash domain to agent versions that release daily, and make it hard to run two versions side by side. Spawning the agent's own binary keeps upgrades independent and allows a container per task.
- **What TS really buys** is first-party Claude Code control (approval callback, interrupt, `SessionStore`, model switch) and upstream-maintained types for OpenCode. For Claude, Rust can get most of the same through claude-agent-acp, which is in effect the official SDK packaged as an ACP binary.
- **What Rust buys** is a small single-binary runner daemon with no JS runtime, an official ACP crate, and a generated omp client. The agents are already standalone binaries, so a Rust runner adds no runtime of its own. A TS runner could also be compiled with `bun build --compile`; the Claude SDK documents `extractFromBunfs()` for that case ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)).
- **The recommendation below holds for both languages.** Only the implementation of each native driver changes:
  - Claude: Agent SDK in TS, or the claude-agent-acp ACP adapter / CLI in Rust.
  - OpenCode: `@opencode/client` in TS, or OpenAPI codegen in Rust.
  - omp: `RpcClient` in TS, or `omp-rpc` in Rust.
  - ACP: either SDK.

---

## Implications for ostra

### What ostra needs, and where each approach stands

| ostra capability | Native per-agent | ACP v1 as the only layer |
|---|---|---|
| Live streaming to the web UI | All three are rich, but each has its own schema | Uniform. Good |
| Follow-up prompts at any time, including mid-run | All three can steer or queue | Gap: queue in ostra until the turn ends, or cancel and re-prompt; Claude adapter extension |
| Reopen days later on the same runner | All three | Yes (load/resume) |
| Reopen on a **different** runner | Per agent: Claude transcripts / `SessionStore`, omp files, OpenCode export/import | Not covered. Needs native code either way |
| Permission requests in the UI | All three, three different mechanisms | Uniform. Good |
| Several agents, more later | One adapter each | One driver, many agents |
| Policy, tools, credentials, limits | CLI flags, config, env | Not covered. Launch-time per agent either way |

### Recommendation: hybrid, ACP first and native where it pays

1. **ostra owns the abstraction.** Define an ostra `AgentDriver` and event model; don't expose ACP types directly. ACP versions churn (v2 is coming), and ostra needs things ACP lacks: session archives, steering, exact cost, git-level diffs. Model the vocabulary on ACP (tool kinds, permission options, stop reasons) so the ACP driver is close to a 1:1 mapping.
2. **Driver 1: a generic ACP driver** using the official SDK for the chosen language, pinned to an exact version and ACP v1. Use it for all three day-one agents (`claude-agent-acp`, `opencode acp`, `omp acp`). Codex, Gemini, Copilot and others then work through the same driver plus a profile.
3. **Per-agent `AgentProfile`, always native.** It covers launch command, flags, env, credential mode, approval defaults, tool allow/deny lists, where the agent keeps session state (pointed at a per-task directory), and **session archive/restore**. ACP can't do these, so they are needed whatever the driver.
4. **Native drivers as upgrades, decided by spikes.**
   - **omp RPC** is the best candidate: steer/follow_up, `open_session` with a host-chosen directory, host tools, and a versioned, schema-checked protocol.
   - **OpenCode HTTP** is next: steer/queue delivery and a durable log that survives disconnects.
   - **Claude Code** should stay on claude-agent-acp, or the Agent SDK directly if ostra is TS. A hand-rolled Rust stream-json driver would depend on the undocumented control protocol. Keep the documented `--permission-prompt-tool` MCP route as a fallback.
5. **The server keeps the source-of-truth event log.** ostra's server stores the normalised event stream with its own sequence numbers and renders the UI from that. Never depend on an agent replaying its history.

### Sketch: `AgentDriver` and the normalised event model

This is a shape for planning, not an implementation. Rust syntax is shown; a TS interface would have the same shape.

```rust
trait AgentDriver {
    fn capabilities(&self) -> Capabilities;            // drives UI affordances
    async fn start(&self, spec: SessionSpec) -> Result<Box<dyn AgentSession>>;
    async fn resume(&self, spec: SessionSpec, native: NativeSessionRef) -> Result<Box<dyn AgentSession>>;
    async fn export_state(&self, native: &NativeSessionRef) -> Result<SessionArchive>;   // Q-07 (b)
    async fn import_state(&self, archive: SessionArchive, worktree: &Path) -> Result<NativeSessionRef>;
}

trait AgentSession {
    fn events(&self) -> EventStream<AgentEvent>;        // ordered; runner adds seq numbers
    async fn send(&self, input: UserInput, how: Delivery) -> Result<InputId>; // Steer | FollowUp | InterruptThenSend
    async fn interrupt(&self) -> Result<()>;
    async fn answer_permission(&self, id: PermissionId, d: PermissionDecision) -> Result<()>;
    async fn answer_question(&self, id: QuestionId, a: Answers) -> Result<()>;
    async fn set_model(&self, m: ModelRef) -> Result<()>;          // if capability
    async fn shutdown(&self, wait_for_settle: bool) -> Result<NativeSessionRef>;
}
```

- **`SessionSpec`** holds: task id; absolute worktree path plus extra dirs; initial input (ticket context); model; system-prompt addition; MCP servers (including an ostra MCP server); tool allow/deny; approval policy (`ask` | `auto-edit` | `autonomous-in-sandbox`); credential references (env/secret refs, never claude.ai tokens); native state directory; limits (max cost, turns, wall time).
- **`Capabilities`** (a Delivery that isn't supported is emulated by the runner):
  - Input: `steer`, `queue_follow_up`, `interrupt_keeps_session`.
  - Resume: `resume_local`, `load_with_replay`, `export_import`.
  - Interaction: `permission_requests`, `questions`, `plans`, `subagent_events`.
  - Usage: `usage_tokens`, `usage_cost`.
  - Config: `model_switch`, `system_prompt_append`, `per_session_mcp`.
- **`AgentEvent`** (normalised):

| Event | Claude Code (stream-json / SDK) | OpenCode V2 | omp RPC | ACP v1 |
|---|---|---|---|---|
| `SessionReady {native_id, model, tools, agent_version}` | `system/init` | `session.created` | `ready` + `get_state` | `session/new` response |
| `TurnStarted {input_ids}` | first message after a user input | `session.execution.started` | `agent_start` | after `session/prompt` |
| `MessageDelta {msg_id, role: assistant\|thought, text}` | `stream_event` text/thinking deltas | `session.text.delta` / `session.reasoning.delta` | `message_update` text/thinking delta | `agent_message_chunk` / `agent_thought_chunk` |
| `MessageDone {msg_id, content}` | `assistant` message | `session.text.ended` | `message_end` | (final chunk) |
| `ToolCall {id, name, kind, title, input, status, output, diff?, parent?}` | `tool_use` / `tool_result` blocks (`parent_tool_use_id`) | `session.tool.called` / `progress` / `success` / `failed` | `tool_execution_start` / `update` / `end` | `tool_call` / `tool_call_update` |
| `PlanUpdated {entries}` | TodoWrite tool (heuristic) | todos are off by default in V2 (`experimental.todo`); event name **unverified** | `set_todos` / `todo_*` events | `plan` |
| `PermissionRequested {id, tool_call_id, title, details, options}` | `canUseTool` / prompt-tool call | `permission.asked` | `extension_ui_request` (select) | `session/request_permission` |
| `QuestionAsked {id, schema}` | `AskUserQuestion` via `canUseTool` | `form.created` | `extension_ui_request` (ask/input) | `elicitation/create` |
| `QueueChanged {pending}` | (SDK receipts) | `session.inbox.*` | `queue_update` | n/a |
| `Usage {in, out, cache_r, cache_w, cost_usd?, ctx_used?, ctx_size?}` | `result.usage`, `total_cost_usd` | `session.usage.updated` | message `usage`, session stats | `usage_update` |
| `Notice` / `Retry` / `Compaction` | `system/api_retry` | `session.retry.scheduled`, `session.compaction.*` | `auto_retry_*`, `auto_compaction_*`, `notice` | `notice`, `compaction_update` |
| `TurnEnded {stop: EndTurn\|Cancelled\|MaxTokens\|MaxTurns\|Budget\|Refusal\|Error{retryable}}` | `result` subtype | `session.execution.succeeded\|failed\|interrupted` | `prompt_result.status` | prompt response `stopReason` |
| `Settled` (no background work left) | process idle / exit | `session.idle` | `session_settled` | (v2 `state_update` idle) |
| `AgentExited {code, stderr_tail}` | process exit | server event / exit | process exit | process exit |
| `Raw {json}` | stored for debugging, never rendered | | | |

File changes are taken from `git diff` on the worktree. Tool-call diffs are only used to preview a pending edit.

### Session portability (informs Q-07)

- **Pin native state to a per-task location ostra controls:**
  - Claude Code: `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_PROJECT_DIR_NAME` on API-key runners. On subscription laptops, leave the config directory alone (moving it logs the user out) and find the transcript by session id.
  - omp: `--session-dir` per task.
  - OpenCode: one server per runner with `OPENCODE_DB`; whether one DB per task is practical is **unverified**.
- **On idle or close,** the runner uploads a `SessionArchive` (native files or export JSON, plus agent version) to the server.
- **On reopen elsewhere,** the new runner imports the archive into the same worktree path when possible. The stores are keyed by cwd, so keep runner worktree paths deterministic, e.g. `<runner-root>/tasks/<task-id>`.
- **If import fails** (agent version mismatch, or the user is switching agents, Q-08), fall back to Q-07 option (c): a fresh session seeded with the ticket, a summary from ostra's own log, and the branch diff.
- **Override Claude's 30-day transcript cleanup** (`cleanupPeriodDays`) on runners, or rely on the archive.

### Credentials (informs Q-06)

- **Per-runner credential mode:**
  - **Personal** (laptop; the agent uses its owner's own login): only that owner's tasks may run there.
  - **Team** (API keys or cloud credentials injected per task): may run anyone's tasks.
- **Claude subscription logins** are allowed only for the Claude Code binary itself, and only in personal mode. Never in OpenCode or omp.
- **Shared runners:** claude-agent-acp's `--hide-claude-auth`, or an omp auth-gateway, can stop subscriptions from being billed by accident and keep keys out of sandboxes.

### Approvals and safety defaults (informs Q-13 and Q-14)

- **All three can route approvals to the UI.** A pending approval keeps the agent process alive. Claude's `PreToolUse` `defer` is the only documented "exit and come back later" option.
- **Defaults differ, so ostra must always pass an explicit policy:**
  - Claude `-p` denies anything that needs approval.
  - OpenCode V2 and omp allow everything.
  - pi has no approvals at all.
- **For "autonomous" runs, use a container per task.** Claude's `bypassPermissions` itself expects isolation and refuses root outside a sandbox.
- **Repo-controlled config can execute at startup:**
  - Claude: hooks in `.claude/settings.json`, and `.mcp.json`, under `-p` without `--bare`.
  - OpenCode: project config and plugins.
  - omp: project extensions, hooks and MCP.
- **Turn that off per agent:**
  - Claude: `--bare` or `--setting-sources` + `--strict-mcp-config`.
  - OpenCode: `OPENCODE_DISABLE_PROJECT_CONFIG`.
  - omp: `--no-extensions` / `--trusted-extension` and `mcp.enableProjectConfig: false`.
- **Treat ticket text as untrusted input.**

---

## Unknowns / things to spike

1. **Claude via claude-agent-acp, end to end** from an ACP client in the chosen language. Check streaming detail, permission round-trips, `_session/steering`, `session/load` after a process restart, the usage/cost fields, and startup latency.
2. **Claude via the CLI directly** (fallback): a long-lived stream-json process; whether SIGINT keeps it alive; `--permission-prompt-tool` against a runner-hosted MCP server with approvals that take hours (timeouts?); `PreToolUse` `defer` from the CLI.
3. **Cross-machine resume for each agent** when the worktree's absolute path differs (Linux → macOS, a different home). What breaks: Claude's project key or cwd checks, omp re-rooting under RPC, OpenCode import with `--directory`?
4. **Claude subscription auth under `--bare`** (planned to become the `-p` default) and under a changed `CLAUDE_CONFIG_DIR` on laptops. Does `CLAUDE_CODE_OAUTH_TOKEN` work in bare mode?
5. **OpenCode V2 runner layout:** one `opencode serve` per runner or per task; `OPENCODE_DB` per task; `after` semantics of the durable log; whether export includes snapshots; per-session MCP and system prompt without writing files into the repo; an `OPENCODE_CONFIG`-style env var in V2.
6. **omp: RPC vs ACP.** Approval routing under `rpc-ui`. `open_session` portability with blobs and artifacts. Vendor `omp-rpc` or port it to async?
7. **ACP pinning strategy:** how often 5.x breaks; when to adopt v2; whether non-Claude agents converge on a steering extension.
8. **Legal checks** (Anthropic sales/legal, before shipping):
   - Is dispatching from a team tool onto a member's own subscription "ordinary, individual usage"?
   - Does ostra auto-installing Claude Code count as "preinstalling or running Claude Code in your products"?
   - Same questions for OpenAI (ChatGPT login in Codex), GitHub Copilot and Google OAuth used through omp.
9. **Single writer per session.** The runner holds a lock per task. Verify omp leases and Claude's transcript race under crash and restart.
10. **Backpressure and volume.** OpenCode's SSE fails slow consumers; omp spills to disk; Claude waits up to 30 s to drain. Size the runner's buffering and relay.
11. **Cost accounting consistency.** Claude's `total_cost_usd` is a client-side estimate; compare it with OpenCode and omp usage and ACP `usage_update` for budgets.
12. **Antigravity CLI** (Gemini's successor for unpaid users): headless and ACP status.
