# Research: Rivet Sandbox Agent, in depth, to confirm or adjust ADR 0024

**Status:** Research, 2026-11-18. Feeds ADR 0024 (Rivet Sandbox Agent), ADR 0018 (ACP first), ADR 0006 (reopen anywhere), ADR 0011 (reliability), ADR 0014 and Q26/Q27 (keys), ADR 0021 (no telemetry), Q11 (spike 1), Q24 (durable queue), Q45 (OpenCode default) and Q46 (bake-off).
**Method:**
- Every page of the Sandbox Agent docs, read from the docs source in the repo and spot-checked against the live site (`sandboxagent.dev/docs` now 301-redirects to `rivet.dev/sandbox-agent/docs`).
- The source code of `rivet-dev/agents` at commit `ce882b8` (`main`, 2026-11-17), cloned with full history.
- The GitHub REST API (issues, PRs, releases, contributors), the npm registry and download API, Docker Hub, the ACP registry, and the OpenCode, ACP and claude-agent-acp docs.
- Anything I couldn't confirm against a primary source is marked **unverified**. "Inferred from source" means I read the code but didn't run it.

**Source links.** `SRC` below means `https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent`. `DOCS` means `https://rivet.dev/sandbox-agent/docs`.

---

## Summary

**Verdict: adjust ADR 0024.** Keep everything the maintainer liked about it: one interface for many agents, ACP underneath, and ostra's own typed event model. Drop Sandbox Agent from the runtime path. The runner should drive agents over ACP itself, with the official `@agentclientprotocol/sdk` 2.x over stdio. That is ADR 0018 as first written. Spike 1 runs both drivers on the same test cases, so the maintainer decides on evidence.

The reasons, from the code and the project's history rather than the marketing pages:

1. **The "universal event schema" no longer exists.** Since v0.2.0 (2026-02-11, "acp spec", [PR #155](https://github.com/rivet-dev/agents/pull/155)), Sandbox Agent passes raw ACP JSON-RPC envelopes through. Its events are ACP `session/update` notifications ([DOCS/agent-sessions](https://rivet.dev/sandbox-agent/docs/agent-sessions)). ostra maps ACP either way, so Rivet adds no normalization.
2. **Development has nearly stopped.** Since 2026-03-26, the Sandbox Agent server and SDKs got one functional fix ([#377](https://github.com/rivet-dev/agents/pull/377)). Everything else was version bumps on a shared release line. Commits by month: 178 in January, 133 in February, 108 in March, 0 in April and May, 7 in June (website), 0 in July to September, then 65 in October and 21 in November. The October and November work went almost entirely to "Rivet Agents" (Pi Durable). On 2026-11-16, [PR #404](https://github.com/rivet-dev/agents/pull/404) added a flag to release the repo *without* Sandbox Agent.
3. **It's behind the protocol it's built on.**
   - It depends on `@agentclientprotocol/sdk` `^0.16.1`, while the current SDK is 2.7.0 (2026-11-14).
   - Its fallback adapters pin `@zed-industries/claude-agent-acp@0.20.0` and `@zed-industries/codex-acp@0.1.0`. npm marks both packages deprecated, renamed to `@agentclientprotocol/*`.
   - It speaks no ACP v2 and advertises no client capabilities. So it gets no elicitation (questions) and none of the steering that ACP and claude-agent-acp now offer.
4. **The transport breaks on long turns.**
   - A `session/prompt` POST stays open for the whole turn.
   - Node's fetch aborts it after undici's 5-minute headers timeout, and that kills the client's whole ACP connection ([#305](https://github.com/rivet-dev/agents/issues/305), [#307](https://github.com/rivet-dev/agents/issues/307)).
   - Community fixes ([#306](https://github.com/rivet-dev/agents/pull/306), [#308](https://github.com/rivet-dev/agents/pull/308), July 2026) are unmerged, and both issues were auto-closed as "not planned".
   - Coding turns routinely run longer than 5 minutes, and permission waits run for hours.
5. **`DELETE` never kills the agent.** `DELETE /v1/acp/{id}` hangs and orphans the agent process, because a mutex is held for the process's whole life. Leaked processes ran a sandbox out of memory ([#407](https://github.com/rivet-dev/agents/issues/407), filed 2026-11-18, unfixed through v0.5.6).
6. **Restore is a text replay.**
   - "Session restoration" replays the last 50 envelopes, capped at 12,000 characters, as JSON text inside the next prompt ([DOCS/session-restoration](https://rivet.dev/sandbox-agent/docs/session-restoration)).
   - It never calls ACP `session/load`. The code carries a "TODO: Replace this synthesized replay text with ACP-native restore" ([SRC client.ts L610](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L610)).
   - That doesn't give ADR 0006 step 2.
7. **Its defaults conflict with ostra's rules.**
   - Telemetry is on by default and sends E2B team and sandbox IDs to `tc.rivet.dev` (ADR 0021).
   - The SDK's local spawn passes the runner's whole `process.env` to the agent (Q17, Q26).
   - The token only goes on the command line.
   - Agents download at runtime from "latest", with no checksum.
   - The loopback API lets the agent itself read the event stream and answer its own permission requests, if it reads the token from `/proc`.

**OpenCode (Q45) works well over ACP, with one big caveat: no steering.**
- `opencode acp` (V2, 2.3.2) advertises `loadSession`, resume, fork, list and close, config options for model, effort and mode, permission requests with diffs, elicitation questions, and usage with cost ([OpenCode ACP docs](https://opencode.ai/docs/cli/acp)).
- But "a session runs one prompt at a time. OpenCode returns an error for a second `session/prompt` while the first is active." Mid-turn steering on OpenCode means cancel and re-prompt, or queue until the turn ends.
- **OpenCode 2.0 shipped on 2026-10-12** with a new config shape and server API ([The New Stack](https://thenewstack.io/opencode-2-shared-service)).
- Sandbox Agent predates it:
  - It installs the 1.x binary from GitHub "latest", but a 2.x launcher from the ACP registry.
  - Its fallback model list dates from February 2026.

**Rivet Actors, RivetKit and Rivet Agents: don't use any of them.** The self-hosted engine is a cluster of Rust control-plane instances plus an object-storage bucket ([control plane](https://rivet.dev/docs/deploy/self-host/control-plane)). That breaks ADR 0017 and adds operating weight, and they overlap the parts ostra owns on purpose (ADR 0012, Q24).

**Top risks:** whichever driver ostra uses, OpenCode can't steer mid-turn; Sandbox Agent's long-turn and process-leak bugs; and the speed of change in OpenCode 2 and ACP v2. Every risk, with its mitigation, is at the end.

---

## Facts (checked 2026-11-18)

| Thing | Version and date | License | Activity and signal | Source |
|---|---|---|---|---|
| `rivet-dev/agents` (repo) | `main` at `ce882b8`, 2026-11-17; created 2026-01-25 | Apache-2.0 (copyright line moving to "Rivet Gaming, Inc.", [#394](https://github.com/rivet-dev/agents/pull/394)) | 1,651 stars, 142 forks, 512 commits. 44 open issues (33 filed by maintainers), 56 open PRs (26 external) | GitHub API |
| Sandbox Agent server (Rust binary) | 0.5.6, 2026-11-05; rc 0.5.7-rc.2, 2026-11-16 | Apache-2.0; Rust deps allow MPL-2.0 and EPL-2.0 ([SRC deny.toml](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/deny.toml)) | Pre-1.0. 47 GitHub releases, 51 npm versions on one shared line | GitHub releases, npm |
| `sandbox-agent` (TS SDK) | 0.5.6 | Apache-2.0 | ~55.4k downloads/week. `@sandbox-agent/cli-linux-x64` is 52.3k of them and `cli-win32-x64` is 601, which suggests a few heavy CI users, not 55k teams (**inference**) | npm download API |
| `acp-http-client` | 0.5.6 | Apache-2.0 | depends on `@agentclientprotocol/sdk ^0.16.1` | npm |
| `@agentclientprotocol/sdk` | 2.7.0, 2026-11-14 | Apache-2.0 | ~9.8M downloads/week, 67 versions | npm |
| Binary size (unpacked npm) | linux-x64 24.8 MB, linux-arm64 25.7 MB, darwin-arm64 18.2 MB, win32-x64 32.4 MB | | No Windows arm64 package | npm |
| Docker `rivetdev/sandbox-agent` | `0.5.6`: 313 MB amd64 / 288 MB arm64 (compressed); `0.5.6-full`: 1.36 GB / 1.35 GB | | 20.7k pulls | Docker Hub API |
| Contributors | 16. NathanFlurry has 358 of 492 attributed commits (73%), then eersnington (Sree Narayanan) 56 and NicholasKissel 45 | | Since 2026-04-01, Sandbox Agent code was touched by 2 people | GitHub API, `git log` |
| OpenCode | npm `opencode-ai` 1.19.6 (2026-11-17, still the 1.x "latest"). GitHub releases v2.3.2 (2026-11-18). ACP registry `opencode` → 2.3.2 | MIT | 227.7k stars; 2.0 announced 2026-10-12 | npm, GitHub API, [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) |
| `@agentclientprotocol/claude-agent-acp` | 0.108.0, 2026-11-17 (394 versions) | Apache-2.0 | built on `@anthropic-ai/claude-agent-sdk` 0.3.326 and ACP SDK 2.7.0 | npm |
| `@agentclientprotocol/codex-acp` | 2.7.0, 2026-11-16 | Apache-2.0 | wraps `@openai/codex ^0.166.0` | npm |
| `rivetkit` | 3.1.1, 2026-11-11 (719 versions) | Apache-2.0 | ~228k/week | npm |
| Rivet engine `rivet-dev/rivet` | v3.1.1, 2026-11-11; v2.3.32, 2026-11-17 | Apache-2.0 | 6.9k stars, 408 open issues | GitHub API |
| `coder/agentapi` | v0.12.2, 2026-05-27; last push 2026-09-13 | MIT | 1.5k stars | GitHub API |

---

## 1. Architecture

**Components** ([DOCS/architecture](https://rivet.dev/sandbox-agent/docs/architecture)):
- `sandbox-agent server`, a Rust HTTP server (axum and tokio). It installs and spawns agent processes, proxies ACP, and serves filesystem, process, terminal and desktop APIs, an Inspector UI at `/ui`, and an OpenCode-compatible API at `/opencode`.
- A TypeScript SDK on top, and a CLI.

**Server mode versus "embedded".** There is no in-process mode.
- `SandboxAgent.start({ sandbox: local() })` **spawns the Rust binary as a child process.** It finds the binary in `SANDBOX_AGENT_BIN`, the `@sandbox-agent/cli-<platform>` optional dependency, or `PATH`.
- It runs `server --host 127.0.0.1 --port <free> --token <24 random bytes, hex>` and polls `/v1/health` for up to 15 s ([SRC spawn.ts L55, L89](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/spawn.ts#L89)).
- It needs a Node-compatible runtime (`process.versions.node`). Bun needs `bun pm trust` for the platform packages ([DOCS/sdk-overview](https://rivet.dev/sandbox-agent/docs/sdk-overview)).
- `SandboxAgent.connect({ baseUrl, token })` is the "server mode" client.
- `server/ARCHITECTURE.md` still describes the pre-ACP design, with per-turn `claude --print` subprocesses and a `UniversalEvent` schema. That file is stale ([SRC ARCHITECTURE.md](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/ARCHITECTURE.md)).

**How sessions map to processes.**
- The HTTP API is `POST/GET/DELETE /v1/acp/{serverId}`.
  - The first POST with `?agent=opencode` spawns **one agent process for that `serverId`** ([SRC acp_proxy_runtime.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/acp_proxy_runtime.rs)).
  - Inside it, ACP `session/new` creates any number of sessions.
  - POSTs carry JSON-RPC to the agent's stdin.
  - The GET is an SSE stream of everything the agent writes, with an `id` per message.
- The high-level SDK opens **one ACP server, so one agent process, per agent type per `SandboxAgent` instance**: `serverId = sdk-${agent}-${random}` ([SRC client.ts L2028](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L2028)). So by default, every OpenCode session of one client shares one `opencode acp` process.
- The docs' "each session maps to one agent process" ([DOCS/architecture](https://rivet.dev/sandbox-agent/docs/architecture)) contradicts this.

**Several concurrent sessions per server (fixed runners with N slots).**
- Yes. Many ACP servers per Sandbox Agent server, and many sessions per ACP server. There is no lock across instances.
- Two consequences for N slots:
  - **Env is per server process, not per session.** Agent processes inherit the Sandbox Agent server's environment. The launch spec adds no per-session env ([SRC acp_proxy_runtime.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/acp_proxy_runtime.rs), `AdapterRuntime::start`). A per-task phantom key or base URL means a server per task (or per agent process), or per-directory agent config.
  - **One crash takes down every session in that process** (see below).

**Process lifecycle, crashes and restarts** (inferred from source: [SRC process.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs)):
- **Spawn:** lazily on the first POST. It installs the agent first unless `SANDBOX_AGENT_REQUIRE_PREINSTALL=1` ([L60](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/acp_proxy_runtime.rs#L60)).
- **Agent crash:**
  - The exit watcher emits an `_adapter/agent_exited` notification on the stream.
  - The dead instance stays in the map, so later POSTs fail.
  - There is no automatic respawn. The client must open a new `serverId`.
- **Stop:** `DELETE` hangs and orphans the agent while it's alive. `spawn_exit_watcher` holds the `Child` mutex across `wait()`, and `shutdown` waits on the same mutex ([#407](https://github.com/rivet-dev/agents/issues/407); [L517](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs#L517)). Graceful shutdown (`shutdown_all`) has the same bug. `kill()` hits only the direct child, not its process tree ([#407](https://github.com/rivet-dev/agents/issues/407)).
- **Request timeout:**
  - Client→agent requests wait `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS`, 120 s by default ([L17](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/acp_proxy_runtime.rs#L17)).
  - On timeout, the code calls `try_process_exit_info`, which takes the same mutex, so the POST hangs instead of returning 504 (inferred from source). A late response is broadcast as an "orphan" on SSE ([L434](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs#L434)).
  - On the client, Node's undici aborts the POST at 5 minutes, and `acp-http-client` then fails the **whole** connection (`failReadable`, [SRC index.ts L417](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/acp-http-client/src/index.ts#L417); [#305](https://github.com/rivet-dev/agents/issues/305), [#307](https://github.com/rivet-dev/agents/issues/307)).
- **Buffers:**
  - Each agent process has a replay ring of **1,024 messages** ([L18](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs#L18)) and a broadcast channel of **512** ([L118](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs#L118)).
  - A lagging SSE subscriber's missed messages are **dropped silently** (`Err(_) => None`, [L299](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/acp-http-adapter/src/process.rs#L299)). The SSE ids have gaps, but the SDK doesn't check them.
- **Sandbox Agent restart:**
  - All in-memory state is gone: instances, rings, and SDK pending permissions.
  - Agents see stdin close. `opencode acp` "exits when the client closes stdin" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
- **Server recovery:** after 3 failed health checks, the SDK calls the provider's `ensureServer()` ([DOCS/architecture](https://rivet.dev/sandbox-agent/docs/architecture)). That restarts the server, not the sessions.
- **Persistence errors** in the SDK's event pipeline are caught and only `console.error`ed ([SRC client.ts L2038](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L2038)). That's incompatible with ADR 0011's "saved before acted on".

**Resource use:** not published. The binary is 18 to 32 MB (table above); InfoQ reported "15MB" in February ([InfoQ](https://www.infoq.com/news/2026/02/rivet-agent-sandbox-sdk)). The memory of the server and of OpenCode per session is **unverified**; spike T16 measures it.

## 2. How it runs each agent

The install and launch logic is in [SRC agents.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/agent-management/src/agents.rs).

**Where the launch spec comes from, in order:**
1. An existing launcher in `~/.local/share/sandbox-agent/bin/agent_processes/<agent>-acp`.
2. The ACP binary on `PATH`.
3. A native binary.

**Installing:**
- It fetches the **ACP registry** at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (overridable with `SANDBOX_AGENT_ACP_REGISTRY_URL`) and installs that entry's `npx` package or binary archive.
- If that fails, it falls back to `adapters.json`.
- **The registry gives SHA-256 hashes, but Sandbox Agent's `RegistryBinaryTarget` doesn't read them, so downloads aren't verified** ([L927](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/agent-management/src/agents.rs#L927); registry entries carry `sha256`).
- With no version given, everything is "latest".

**OpenCode:**
- **Command:** `opencode acp` (native ACP over stdio), not `opencode serve` ([L455, L481](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/agent-management/src/agents.rs#L455)). `opencode serve` is used only by the experimental `/opencode` compatibility proxy (`opencode-server-manager` crate).
- **Version skew:** the native install downloads `github.com/anomalyco/opencode/releases/latest`, which is **1.19.6**. The ACP launcher comes from the registry, which points at **2.3.2**. One box can end up with two OpenCode versions (inferred from the source plus the live registry and the GitHub API).
- **Provider, base URL, key and model:** Sandbox Agent has no provider settings of its own. It only inherits env.
  - **Credentials:** OpenCode "uses the provider credentials it already has": config and env. Its only ACP auth method is `opencode-login`, which collects nothing ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
  - **Config:** OpenCode V2 reads the session directory's configuration: "OpenCode uses that directory's configuration, including its models, agents, … MCP servers" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
  - **V2 custom provider:** `providers.<id>` with `package: "@opencode/ai/providers/openai-compatible"` (or `aisdk:@ai-sdk/openai-compatible`), `settings.baseURL`, `settings.apiKey: "{env:VAR}"`, `env: [...]` and `models: {...}`. A catalog provider can be sent through a proxy by overriding `settings.baseURL` ([providers](https://opencode.ai/docs/providers/), [config](https://opencode.ai/docs/config/)).
  - **V1 syntax:** `provider` / `npm` / `options.baseURL`. V2 still reads it ([upgrade notes](https://www.developersdigest.tech/blog/opencode-2-upgrade-migrate-v1-config-plugins-2026), secondary).
  - **Model:** ACP `session/set_config_option {configId: "model", value: "provider/model"}`, with an optional `/variant` suffix for effort ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
- **models.dev IDs:** yes. "OpenCode includes a provider and model catalog from models.dev" ([providers](https://opencode.ai/docs/providers)). IDs are `provider/model`, so ostra's registry IDs pass straight through.
  - The SDK checks a model against the session's `configOptions`. OpenCode V2 returns them on `session/new`, so any model enabled in config is accepted.
  - If they're missing, the SDK falls back to a **static list frozen in February 2026** (`opencode/gemini-3-pro` default, `claude-opus-4-6`, `gpt-5.3-codex`, …; [SRC opencode.json](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/scripts/agent-configs/resources/opencode.json)), and would reject newer IDs.
  - `OPENCODE_DISABLE_MODELS_FETCH` keeps OpenCode off models.dev at runtime ([opencode#4959](https://github.com/anomalyco/opencode/issues/4959)).
- **Env and config injection:**
  - Through the env of the Sandbox Agent server process. The SDK's `spawn.env` is **merged over the runner's whole `process.env`** ([SRC spawn.ts L93](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/spawn.ts#L93)).
  - Through files in the session's `cwd`.
  - MCP servers can also be passed per session on `session/new` (OpenCode supports stdio and HTTP).

**Claude Code:**
- **Adapter:** the **ACP adapter**: registry id `claude-acp`, now `@agentclientprotocol/claude-agent-acp`, built on the **Claude Agent SDK**.
- **Fallback pin:** the deprecated `@zed-industries/claude-agent-acp@0.20.0` ([SRC adapters.json](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/scripts/audit-acp-deps/adapters.json); npm deprecation notice).
- **Options:** models `default`, `sonnet`, `opus`, `haiku`; modes `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. Effort comes only from settings files ([DOCS/agents/claude](https://rivet.dev/sandbox-agent/docs/agents/claude)).
- **Base URL:** `ANTHROPIC_BASE_URL` plus a key in the env flows through the Agent SDK (**unverified end to end**; spike T3b).
- **Subscriptions:** the docs say "If the user is signed into Claude Code or Codex on the host machine, Sandbox Agent automatically picks up their OAuth tokens", and the CLI can `credentials extract-env` them for remote sandboxes ([DOCS/llm-credentials](https://rivet.dev/sandbox-agent/docs/llm-credentials)).
  - The server itself only reads credential files to report availability; it doesn't inject them (`set_credentials_as_env_vars` is unused).
  - ostra must never call `extract-env`, under Q47 and Anthropic's terms (ADR 0014).

**Codex:**
- **Adapter:** registry `codex-acp`, now `@agentclientprotocol/codex-acp` 2.7.0. The fallback pin is the deprecated `@zed-industries/codex-acp@0.1.0`.
- **Options:** models `gpt-5.3-codex` and others; modes `read-only`, `auto`, `full-access` ([DOCS/agents/codex](https://rivet.dev/sandbox-agent/docs/agents/codex)).
- **Auth:** the SDK only knows the `codex-api-key`, `openai-api-key` and `anthropic-api-key` methods ([SRC client.ts L2634](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L2634)). It **can't authenticate codex-acp 1.x+, which advertises `api-key`**, nor Claude's custom-gateway auth ([#313](https://github.com/rivet-dev/agents/issues/313); fix [#358](https://github.com/rivet-dev/agents/pull/358) unmerged).

**Any other agent** (oh-my-pi, Gemini, …) needs a fork. `AgentId` is a closed Rust enum ([#393](https://github.com/rivet-dev/agents/issues/393); the oh-my-pi PR [#392](https://github.com/rivet-dev/agents/pull/392) is unmerged).

## 3. The event schema

**What it is now.**
- Events are ACP envelopes: `SessionEvent {id, eventIndex, sessionId, connectionId, sender: client|agent, payload: AnyMessage, createdAt}` ([DOCS/session-persistence](https://rivet.dev/sandbox-agent/docs/session-persistence)).
- The `payload` is the raw JSON-RPC message, so the "universal schema" is ACP's `SessionUpdate`.
- Sandbox Agent adds `_adapter/agent_exited` and `_adapter/invalid_stdout`.
- The old `UniversalEvent` survives only inside the `/opencode` compatibility layer.

**`SessionUpdate` variants in ACP SDK 0.16.1** (from the published package's types):
- `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`
- `tool_call`, `tool_call_update`
- `plan`
- `available_commands_update`, `current_mode_update`, `config_option_update`
- `session_info_update`
- `usage_update`

**Other enums:**
- Tool-call content types are `content`, `diff` and `terminal`.
- Tool kinds are `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode` and `other`.
- Stop reasons are `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` and `cancelled`.

**Completeness against ostra's list:**

| Need | Status (via Sandbox Agent + OpenCode V2) |
|---|---|
| Messages, text deltas | ✓ `agent_message_chunk`, `user_message_chunk` |
| Reasoning | ✓ `agent_thought_chunk` |
| Tool calls with inputs and outputs | ✓ `tool_call` (`rawInput`, kind, title, locations) and `tool_call_update` (status, content, `rawOutput`). How full the fields are depends on the agent |
| File edits and diffs | ◐ `diff` content (`path`, `oldText`, `newText`) when the agent sends one; OpenCode includes a diff on permission requests "if it can build a preview" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)). There's no first-class edit event ([#146](https://github.com/rivet-dev/agents/issues/146), open). ostra should take diffs from git anyway |
| Permission requests | ✓ `session/request_permission` (an agent→client request, not an update) |
| Questions or elicitation | ✗ ACP SDK 0.16.1 has no elicitation types, and the SDK's `initialize` sends no `clientCapabilities` ([SRC client.ts ~L536](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L536)). OpenCode then "cancels the question and tells the model to continue without an answer" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)) |
| Plans, todos | ✓ `plan` entries; todos aren't a separate type (on the roadmap in the README) |
| Token usage and cost | ◐ `usage_update` (`used`, `size`, `cost`) and the end-turn `usage`, both **unstable** in 0.16.1 (`Usage`, `UsageUpdate` and `Cost` are marked UNSTABLE). OpenCode sends them ([OpenCode ACP](https://opencode.ai/docs/cli/acp)). ostra should meter at its model proxy |
| Errors | ◐ JSON-RPC errors with `agentStderr` added ([SRC acp_proxy_runtime.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/acp_proxy_runtime.rs)); OpenCode retry status sits in `_meta["opencode/retry"]` |
| Session status | ◐ A turn ends with the `session/prompt` response; there's `session_info_update` and `_adapter/agent_exited`. No explicit idle/running state in ACP v1 (that's in the v2 draft) |
| Subagents | ✓ for OpenCode: child-session updates carry `_meta["opencode/child-session"]` |

**Versioning and stability.**
- Sandbox Agent's HTTP API is `/v1`, but the project is pre-1.0 and broke its API at v0.2.0 (the ACP rewrite).
- The README's API overview (`createSession("demo", …)`, `postMessage`, `streamEvents`) and the whole "Manage Sessions" page document **methods that no longer exist** in the SDK ([DOCS/manage-sessions](https://rivet.dev/sandbox-agent/docs/manage-sessions); `grep` of `client.ts` finds no `streamEvents`).
- The hard-coded capability table lists OpenCode as `permissions: false, questions: false` ([SRC support.rs L346](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/router/support.rs#L346)). That's stale too.
- The real contract is ACP protocol version 1.
- **ACP v2** has been in draft since 2026-07-20. It brings structured file changes, updates outside turns, and a `session/prompt` that returns a message id instead of marking the end of the turn ([restfulapi.net summary](https://restfulapi.net/agent-client-protocol), secondary; [prompt-delivery RFD #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261)).

## 4. Control

**Steering mid-turn, per agent:**
- **OpenCode (ACP):** not possible. "A session runs one prompt at a time. OpenCode returns an error for a second `session/prompt` while the first is active" ([OpenCode ACP](https://opencode.ai/docs/cli/acp)). The options are cancel plus a new prompt (cancelled tool calls are reported `failed`) or queue until the turn ends. Whether OpenCode's *own* V2 server API can steer is **unverified**.
- **Claude Code (claude-agent-acp):** has a steering extension on ACP v1. "Steering and the AIR extensions are v1 only for now" ([claude-agent-acp README](https://github.com/agentclientprotocol/claude-agent-acp)). The exact method name and semantics are **unverified**; a PR names it `_session/steering` ([PR list](https://github.com/agentclientprotocol/claude-agent-acp/pulls)). Sandbox Agent's SDK exposes it only through `rawSend` (**unverified**).
- **Codex:** **unverified** through codex-acp.
- **ACP itself:** the prompt-delivery RFD adds `delivery: "steer" | "queue"` to `session/prompt` in v2 ([#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261)). Sandbox Agent's v1-only client can't use it.

**Interrupt and cancel.**
- ACP `session/cancel` is a notification. The SDK sends it from `destroySession()`, or `session.rawSend("session/cancel", {}, { notification: true })` sends it alone ([SRC client.ts](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts)).
- OpenCode ends the turn with `stopReason: "cancelled"` and rejects pending permissions ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
- Issue [#136](https://github.com/rivet-dev/agents/issues/136) ("add abort endpoint") is pre-ACP and stale.

**Permissions.**
- **The API:** `session.onPermissionRequest(cb)` and `respondPermission(id, "once" | "always" | "reject")`, or `rawRespondPermission` with a full ACP `RequestPermissionResponse` ([DOCS/agent-sessions](https://rivet.dev/sandbox-agent/docs/agent-sessions)).
- **With no listener**, the SDK answers `cancelled` at once ([SRC client.ts L2292](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L2292)).
- **OpenCode** offers `once` (`allow_once`), `always` (`allow_always`) and `reject` (`reject_once`) ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
- **Modes:** Rivet advises leaving the mode `default` and answering explicitly ([DOCS/agent-sessions](https://rivet.dev/sandbox-agent/docs/agent-sessions)).
  - OpenCode V2 permissions are rules (`action`, `resource`, `effect: allow|deny|ask`), and **"If no rule matches, OpenCode uses `ask`"** ([permissions](https://opencode.ai/docs/permissions/)).
  - "Always" approvals become **durable, project-scoped allow rules in OpenCode's own store**. On a fresh box they're gone, so ostra should keep "always" as its own policy and answer the agent `once`.

**Can a permission request wait for hours?**
- The protocol allows it: there's no timeout on `session/request_permission`.
- Through Sandbox Agent, no:
  1. The turn's `session/prompt` POST dies at 5 minutes, through undici ([#305](https://github.com/rivet-dev/agents/issues/305)).
  2. Pending permissions live only in the SDK's memory, so a runner restart loses them.
  3. Q37 releases the box during long waits anyway.
- ostra should **cancel the turn after a working-value wait** (say 10 minutes), keep the approval request in Postgres, and start a new turn carrying the decision once a member answers.

**Changing the model or mode mid-session.**
- `session.setModel()`, `setMode()`, `setThoughtLevel()` and `setConfigOption()` map to `session/set_config_option` and `session/set_mode` ([DOCS/agent-sessions](https://rivet.dev/sandbox-agent/docs/agent-sessions)).
- OpenCode V2 takes `model`, `effort` and `mode`, and sends `config_option_update` when they change ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).
- Changing them *during* a turn: **unverified** (spike T10).
- Claude can't change effort after start ([DOCS/agents/claude](https://rivet.dev/sandbox-agent/docs/agents/claude)).

## 5. Sessions and persistence

**What survives a Sandbox Agent restart:**
- Nothing held by Sandbox Agent: "Sandbox Agent stores sessions in memory only" ([DOCS/manage-sessions](https://rivet.dev/sandbox-agent/docs/manage-sessions)).
- The agents' own stores on disk survive: OpenCode's database, and Claude Code's JSONL under `~/.claude/projects`.
- OpenCode advertises `loadSession: true`, plus `session/resume` and `session/fork`. `session/load` replays the saved messages, but only with the same `cwd` ([OpenCode ACP](https://opencode.ai/docs/cli/acp)).

**Restore on the same runner (ADR 0006 step 1).**
- The SDK's `resumeSession()` **never calls `session/load`**. On a new connection, it creates a fresh session and queues a replay ([SRC client.ts L1175](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L1175)).
- A request to use ACP resume ([#275](https://github.com/rivet-dev/agents/issues/275)) was closed "not planned", and a header-based restore PR ([#289](https://github.com/rivet-dev/agents/pull/289)) has been open since March.
- ostra would have to send `session/load` itself (raw ACP).

**Restore on another machine from events ostra stored (ADR 0006 step 2).**
- Sandbox Agent's version: the "replay" injects up to `replayMaxEvents` = 50 envelopes and `replayMaxChars` = 12,000 characters as JSON text ("Previous session history is replayed below as JSON-RPC envelopes…") into the next prompt ([SRC client.ts L2698](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/client.ts#L2698); [DOCS/session-restoration](https://rivet.dev/sandbox-agent/docs/session-restoration)).
- With streamed chunks, 50 envelopes is a few sentences. That's weaker than ADR 0006 step 3 (ticket, summary, branch).
- **What actually works for step 2 is agent-native archives:**
  - **OpenCode V2:** `opencode session export [id]` writes JSON, and `opencode session import` loads it back ([opencode#9387](https://github.com/anomalyco/opencode/issues/9387)). Round trips have failed on v2.0.4 ([opencode#49314](https://github.com/anomalyco/opencode/issues/49314)), so the spike checks the pinned version.
  - So: after each turn, the runner exports the session and uploads it as the "session archive" bulk blob that `research/runner-transport.md` §1 already plans. On a new box, it imports and then calls `session/load`.
  - **Claude Code:** restore the session JSONL file and resume (**unverified** through claude-agent-acp; spike).

**"Managing sessions" guidance and the Postgres pattern.**
- The SDK takes a `SessionPersistDriver` (`getSession`, `listSessions`, `updateSession`, `listEvents`, `insertEvent`) storing `SessionRecord` and `SessionEvent` ([DOCS/session-persistence](https://rivet.dev/sandbox-agent/docs/session-persistence)). Example drivers exist for in-memory (default caps: 1,024 sessions, 500 events per session), SQLite, Postgres (`@sandbox-agent/persist-postgres`), IndexedDB and Rivet Actors.
- The older "Manage Sessions" page shows an `agent_events` table with `UNIQUE(session_id, sequence)`, built on the removed `streamEvents` API ([DOCS/manage-sessions](https://rivet.dev/sandbox-agent/docs/manage-sessions)).
- For ostra, none of this fits:
  - The runner never talks to Postgres directly. It spools and ships (`research/runner-transport.md` §3).
  - The SDK swallows persistence errors (§1).
- ostra's spool *is* the persistence. The `(session_id, seq)` idempotent insert idea matches the plan.

## 6. Security

- **Auth:**
  - A single global bearer token, set only with `--token`. There is **no env-var option** ([SRC cli.rs L50](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/cli.rs#L50)), so the token sits in the process's argv, readable from `/proc/<pid>/cmdline` unless `/proc` is mounted with `hidepid`.
  - It's compared with `==`, not in constant time ([SRC support.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/router/support.rs)).
  - `--no-token` turns auth off, and every built-in provider starts the server with `--no-token --host 0.0.0.0` ([SRC providers/shared.ts](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/src/providers/shared.ts)).
- **Bind address and CORS:** the default host is `127.0.0.1:2468` ([SRC cli.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/cli.rs)). CORS allows no origins by default ([DOCS/cors](https://rivet.dev/sandbox-agent/docs/cors)). The Inspector UI at `/ui` is static and served without auth.
- **Rivet's own advice** is to keep the SDK on a backend and do auth there ([DOCS/security](https://rivet.dev/sandbox-agent/docs/security)).
- **What the agent can reach:** with Sandbox Agent on loopback in the same box, the agent process can reach its HTTP API. With the token from `/proc`, it can:
  - read every session's SSE stream (other tasks' streams on a multi-slot runner)
  - **POST replies to its own permission requests**, which defeats ostra's approvals
  - use `/v1/fs/*` and `/v1/processes/*` as the server's user

  The agent already has a shell, so the real escalations are self-approval and cross-task reads.
- **A separate OS user for the agent (Q27):** agents are children of Sandbox Agent, so they run as Sandbox Agent's user. Separating the agent from the runner means running Sandbox Agent itself as the agent's user, beside the runner. That puts the API token where the agent can read it.
- **Does Sandbox Agent need the model keys?** No. It only passes its env through. It checks whether `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` exist for availability flags ([SRC support.rs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/router/support.rs)), and a phantom key satisfies that. **So the loopback key proxy (Q26) is compatible**, provided ostra spawns the server with an explicit, minimal env and not the SDK's `process.env` merge.
- **Telemetry:**
  - "Enabled by default in release builds". It sends on startup and every 5 minutes to `https://tc.rivet.dev` ([DOCS/telemetry](https://rivet.dev/sandbox-agent/docs/telemetry); [SRC telemetry.rs L16](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/telemetry.rs#L16)).
  - The "anonymous" payload includes provider metadata such as **E2B `sandboxId`, `teamId` and `templateId`** ([L269](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/telemetry.rs#L269)).
  - The only opt-out is the `--no-telemetry` flag, and the SDK's spawn doesn't pass it. That conflicts with ADR 0021 unless ostra spawns the binary itself.
- **Supply chain:** runtime installs from "latest" with no checksum (§2). `SANDBOX_AGENT_REQUIRE_PREINSTALL=1` turns them off.

## 7. Deployment

- **Built-in providers in the `sandbox-agent` SDK:** `local`, `docker`, `e2b`, `daytona`, `vercel`, `cloudflare`, `modal`, `computesdk`, `sprites` and `agentcomputer`, plus a BoxLite guide ([SRC package.json exports](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/sdks/typescript/package.json); [DOCS/sdk-overview](https://rivet.dev/sandbox-agent/docs/sdk-overview)). Each creates a sandbox, runs the server inside, and connects *in* to it. `research/elastic-sandboxes.md` already rejected that model (inbound URLs, keys in the sandbox env).
- **`@rivet-dev/sandbox-adapter` is a different package.** It gives Rivet *Actors* `create`, `connect` and `exec` on agentOS, E2B, Daytona, Freestyle and Docker, and doesn't use Sandbox Agent ([guide](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/docs/content/guides/sandbox-adapter.mdx)).
  - Rivet's own newer "Run OpenCode" and "Run Claude Code" guides use it to `exec` `opencode run --format json` and `claude -p`, **not Sandbox Agent** ([run-opencode](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/docs/content/guides/run-opencode.mdx)).
- **Images:** `rivetdev/sandbox-agent:0.5.6` is 313 MB and `-full` (all agents) is 1.36 GB, compressed for amd64 (Docker Hub). The Docker guide warns plain Docker "is not recommended for production isolation" ([DOCS/deploy/docker](https://rivet.dev/sandbox-agent/docs/deploy/docker)).
- **Install script:** `curl releases.rivet.dev/sandbox-agent/0.5.x/install.sh` floats on the minor version, and a stale script once installed a mismatched server ([#272](https://github.com/rivet-dev/agents/issues/272)). Pin exact binaries.
- **Windows:**
  - A win32-x64 binary exists.
  - The process API returns 501 on Windows ([SRC router.rs L3271](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/server/packages/sandbox-agent/src/router.rs#L3271)).
  - CI runs only on Ubuntu ([ci.yaml](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/.github/workflows/ci.yaml)), and there are no Windows docs.
  - The only evidence it works is one contributor's test run on a Windows server ([#358](https://github.com/rivet-dev/agents/pull/358)).
  - The win32 package sees about 600 downloads a week.

## 8. Gigacode, and OpenCode's TUI or web UI against Sandbox Agent

- **What it is:** Gigacode is OpenCode's TUI attached to Sandbox Agent's `/opencode` compatibility API: "Experimental & just for fun" ([SRC gigacode/README.md](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/gigacode/README.md)).
- **What works:** `/opencode` covers events, sessions, messages, permissions, questions and providers. Config, commands, `/tui/*` and agents are stubs or proxied ([DOCS/opencode-compatibility](https://rivet.dev/sandbox-agent/docs/opencode-compatibility)). It exposes Claude, Codex, Amp and mock as providers, and **not OpenCode itself** ([#100](https://github.com/rivet-dev/agents/issues/100)).
- **What's broken:** about 20 Gigacode bugs filed by the maintainer in February are still open: no file diffs, Ctrl+C, hangs, `/compact`, model changes ([#99–#145](https://github.com/rivet-dev/agents/issues?q=is%3Aissue+is%3Aopen+gigacode)).
- **It's tied to OpenCode 1.x.** It implements the **V1** server API, and OpenCode 2's "Server API is completely different" ([Anomaly](https://anoma.ly/notes/opencode-2-0)).
- **F-041 (attach): no.** For OpenCode, attach is better built natively:
  1. Restore the session locally with `opencode session import`.
  2. Open the real TUI.
  3. On exit, `opencode session export`, and ingest the result as a new session of the task.

  That needs no Sandbox Agent. For Claude Code, the same with `claude --resume` and the JSONL file (**unverified**; F-041's own spike).
- **A later option for OpenCode:** OpenCode 2's single background service, which the TUI, web and desktop share ([The New Stack](https://thenewstack.io/opencode-2-shared-service)), could be the live attach target. But `opencode acp` starts "a private OpenCode server for its own use" and doesn't join that service ([OpenCode ACP](https://opencode.ai/docs/cli/acp)). **Unverified** whether a TUI can share a session with a running ACP process.

## 9. Maturity

- **Versions:**
  - 47 GitHub releases from v0.1.0-rc.1 (2026-01-28) to v0.5.7-rc.2.
  - Breaking changes:
    - v0.2.0: rewrite to ACP; the old schema and endpoints removed
    - v0.4.0: ACP SDK moved to 0.16.1
    - v0.5.0: repo moved and versions unified
  - From v0.5.0 on, releases mostly carry `@rivet-dev/pi` changes ([releases](https://github.com/rivet-dev/agents/releases)).
  - Between v0.5.0-rc.3 (2026-03-30) and v0.5.0 (2026-10-07) there was **no release for six months**.
- **Activity:** in `git log`, the server and SDK paths have had 17 commits since 2026-04-01. One is a fix ([#377](https://github.com/rivet-dev/agents/pull/377)); the rest are release bumps, a repo move and CI. The team's focus is Rivet Agents and Pi Durable ([PR #404](https://github.com/rivet-dev/agents/pull/404)).
- **Bus factor: one to two.** Nathan Flurry wrote 73% of commits. Since April, Sandbox Agent code was touched by two people.
- **Issues and responsiveness:**
  - External issues get a Linear link-back bot comment and, as a rule, no human reply ([#313](https://github.com/rivet-dev/agents/issues/313), [#393](https://github.com/rivet-dev/agents/issues/393), [#378](https://github.com/rivet-dev/agents/issues/378)).
  - Of the 19 issues among the last 100 closed items, 14 were closed "not planned", most of them 30 to 37 days after filing, apparently synced from Linear (no stale workflow is in the repo). That includes real bugs with PR fixes waiting ([#305](https://github.com/rivet-dev/agents/issues/305), [#307](https://github.com/rivet-dev/agents/issues/307)).
  - One counterexample: [#319](https://github.com/rivet-dev/agents/issues/319) got a human fix the same day.
  - 26 external PRs are open, some since February. Among recently closed PRs, 5 of 11 external ones were merged.
- **Recurring bug themes:**
  - long turns and transport timeouts ([#305](https://github.com/rivet-dev/agents/issues/305), [#307](https://github.com/rivet-dev/agents/issues/307))
  - process leaks ([#407](https://github.com/rivet-dev/agents/issues/407), #201)
  - adapter auth drift ([#313](https://github.com/rivet-dev/agents/issues/313))
  - stalls with Claude background tasks ([#291](https://github.com/rivet-dev/agents/issues/291), [#139](https://github.com/rivet-dev/agents/issues/139))
  - version mismatch between server and SDK ([#272](https://github.com/rivet-dev/agents/issues/272))
  - type exports ([#397](https://github.com/rivet-dev/agents/issues/397))
  - the closed agent list ([#393](https://github.com/rivet-dev/agents/issues/393))
- **Tests and CI:** CI runs rustfmt, clippy and lefthook, Rust tests (`agent-management`, `v1_api`, `v1_agent_process_matrix`, lib) and SDK vitest, on Ubuntu only ([ci.yaml](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/.github/workflows/ci.yaml)). The agent matrix uses **stub agents**, and CI has no secrets, so no real agent runs in CI.
- **Docs quality:** the newer pages are good. But the README, "Manage Sessions" and `ARCHITECTURE.md` describe the removed API, the capability table is stale, and the claim that each session is its own process is wrong (§1).
- **Side note:** the repo also holds **Foundry**, Rivet's own team task system for coding agents (organizations, tasks, GitHub auth), licensed **MIT**, with no work since March ([SRC foundry/README.md](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/foundry/README.md)). It's an abandoned product close to ostra.

## 10. The company and licensing

- **Company:** Rivet Gaming, Inc. (Cargo authors still say "Rivet Gaming, LLC").
  - YC W23 ([YC](https://www.ycombinator.com/companies/rivet)) and a16z speedrun cohort 002 ([speedrun](https://speedrun.a16z.com/companies/rivet)).
  - Founders: Nicholas Kissel (CEO) and Nathan Flurry (CTO). Team size: 5 (speedrun) to 7 (YC).
  - Public trackers list about $0.5M of seed funding ([PitchBook](https://pitchbook.com/profiles/company/517062-88), [Tracxn](https://tracxn.com/d/companies/rivet/__1U2L-PNXA--sFh0NnIPBZoNAnrfWuBEfvn0yAhJ7m3M)). That's probably incomplete; **unverified**.
- **Business model:** Rivet Cloud, managed Actors with control-plane plans from $0, $10, $120 and $900 a month ([pricing](https://rivet.dev/pricing)). The open-source engine is free to self-host. Sandbox Agent is a free on-ramp: its docs steer persistence and orchestration toward Rivet Actors ([DOCS/orchestration-architecture](https://rivet.dev/sandbox-agent/docs/orchestration-architecture)).
- **Pivot risk: high, shown twice already.**
  - Company: from multiplayer game-server hosting (YC listing, 2023), to Rivet Actors, to "the orchestrator for agentic workloads" (agentOS, Secure Exec).
  - This repo: Sandbox Agent (January to March) → Foundry (March, abandoned) → Pi Durable (October to November).
- **Licenses of what ostra would ship:**

| Component | License | Note |
|---|---|---|
| `sandbox-agent` binary, SDK, `acp-http-client` | Apache-2.0 | The binary statically links Rust crates, some MPL-2.0 or EPL-2.0 (allowed by [deny.toml](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/sandbox-agent/deny.toml)), so file-level notices go in ostra's `NOTICE` |
| `@agentclientprotocol/sdk`, claude-agent-acp, codex-acp | Apache-2.0 | |
| OpenCode | MIT | |
| Claude Code (inside claude-agent-acp, through the Agent SDK) | Proprietary (Anthropic) | **Not Apache-2.0.** Check before baking it into ostra's public runner image (ADR 0023); **unverified** whether redistribution is allowed |
| Foundry (in the same repo, not shipped) | MIT | |
| Rivet engine, RivetKit | Apache-2.0 | |

## 11. Rivet Actors, RivetKit and "Rivet Agents"

**What they are:**
- **Rivet Actors** are long-lived, stateful processes, each with its own SQLite database. They're scheduled by the Rivet engine onto "nodes", which "connect out to the control plane" ([control plane](https://rivet.dev/docs/deploy/self-host/control-plane)).
- **RivetKit** (3.1.1) is the TypeScript library you write actors in. It has actions, events, schedules, queues and workflows (`@rivetkit/workflow-engine` is a dependency; npm).
- **Rivet Agents** is the repo's tagline, "A durable process per agent, with memory that survives restarts". In practice it's `@rivet-dev/pi`: Earendil's Pi Durable harness running *inside* an actor, still in beta.
  - The **agent loop runs in your backend**, and tools `exec` into a sandbox ([Pi Durable docs](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/docs/content/docs/index.mdx)).
  - For third-party CLIs (OpenCode, Claude Code), Rivet's guides just `exec` one prompt per run, with no durability mid-turn ([run-opencode](https://github.com/rivet-dev/agents/blob/ce882b8cdc6980e537dc88836ccb3b863f2631e3/docs/content/guides/run-opencode.mdx)).

**Self-hosting, current (v3):**
- 1 control-plane instance to try it, **3 or more in production**, each with a persistent disk.
- **An object-storage bucket** (S3, GCS or Azure) for every actor's data.
- "There is no database to run and no message bus" ([control plane](https://rivet.dev/docs/deploy/self-host/control-plane)).
- That replaces the Postgres and NATS story `research/runner-transport.md` recorded for 2.x.

**Overlap with ostra:**
- Durable runner sessions: ostra keeps them in Postgres plus the runner spool.
- The durable queue: DBOS is proposed, Q24.
- The runner transport: ostra's own WebSocket protocol, ADR 0012.

**Conflicts:**
- **ADR 0017:** a second store (a bucket, plus SQLite per actor) beside Postgres, and ostra's data split across both.
- **Self-hosting weight:** a Rust control-plane cluster on top of ostra's server.
- **ADR 0012:** the protocol would belong to a framework, not to ostra.
- **Churn:** 2.x → 3.x in 2026, 719 RivetKit versions, and the "no negotiation, reconnects forever" incident ([rivet#5484](https://github.com/rivet-dev/rivet/issues/5484)).
- **Architecture:** Pi Durable puts the agent loop outside the box, the opposite of ADR 0012 and Q45.
- **License:** fine (Apache-2.0).

**Verdict: don't use any of it.** No Actors for runner sessions, no RivetKit queue or workflows instead of DBOS or pg-boss, and no engine for the transport. Worth borrowing: per-agent request idempotency (Pi's `requestId`), and actor "sleep" as the model for Q42's warm-then-release.

## 12. Alternatives, briefly

- **`coder/agentapi`** (MIT, v0.12.2, last push 2026-09). It runs "an in-memory terminal emulator", turns API calls into keystrokes and diffs screen snapshots into messages, with four endpoints: `/messages`, `/message`, `/status` and `/events` ([README](https://github.com/coder/agentapi)).
  - Pro: drives any TUI agent.
  - Con: no structured tool calls, diffs or permission objects. Too lossy for ADR 0011 and the audit log. ✗
- **OpenCode's own server and SDK.** `opencode serve`, with `@opencode-ai/sdk` on V1 or `@opencode/client` on V2.
  - Pro: the richest OpenCode surface (permissions, questions, todos, possibly steering).
  - Cons: OpenCode only, so it breaks adapter parity (AGENTS.md), and the server API broke completely between V1 and V2 ([Anomaly](https://anoma.ly/notes/opencode-2-0)).
  - Verdict: keep it as an **optional capability** inside the OpenCode profile, for example for steering if V2's API has it, not as the base. ◐
- **Plain ACP** (`@agentclientprotocol/sdk` 2.7.0, Apache-2.0, ~9.8M downloads/week, the official library). The runner spawns `opencode acp`, `claude-agent-acp` or `codex-acp` with stdio pipes and its own env per task, and calls `initialize` (with `elicitation.form`), `session/new`, `load`, `prompt`, `cancel` and `set_config_option`.
  - What Sandbox Agent adds on top, an HTTP hop and an in-memory ring buffer, buys nothing when client and agent share a box. The runner already owns transport, spool and persistence.
  - Cost: ostra writes the install and launch table, a few per-agent quirks and a debug view. Rivet's Apache-2.0 code is a reference for each, with attribution (Q21). ✓ Recommended.

---

## Recommendation

**Adjust ADR 0024 by amending it, or by a new ADR that supersedes its driver choice:**

1. **The runner drives agents over ACP with the official `@agentclientprotocol/sdk` (2.x) over stdio, in its one `agent-driver` package.** Rivet Sandbox Agent stays out of the runtime path. This restores ADR 0018's "ostra's own generic ACP driver" and keeps everything else in ADR 0024:
   - ACP underneath, for extensibility
   - all agent-specific code in one package
   - ACP mapped into ostra's typed event model
   - pinned versions and per-agent contract tests
2. **Launching agents:**
   - **Command:** one process per task, `opencode acp` (OpenCode pinned to the version baked into the runner image, SHA-256 checked at image build), with an explicit env:
     - the phantom key and a base URL pointing at the runner's loopback proxy
     - `OPENCODE_DISABLE_MODELS_FETCH`
     - no runner secrets
   - **Config:** a per-workspace `opencode.json` that ostra writes. It declares the providers (models.dev IDs as they are, custom providers under an `ostra-…` prefix), the `ask` permission rules, and the model. It's excluded from git with `.git/info/exclude`.
   - **On remote runners**, the agent's process runs as a separate OS user (Q27).
3. **Reopen (ADR 0006):**
   - **Step 1:** `session/load` with the same `cwd`.
   - **Step 2:** after each turn, the runner uploads an agent-native archive (`opencode session export`, Claude's JSONL) as the session-archive blob. Another runner imports it, then calls `session/load`.
   - **Step 3** stays the fallback.
   - Don't copy Rivet's replay-as-text.
4. **Steering (F-0xx):** in v1, steering OpenCode means **cancel and re-prompt**, or queue-until-idle, chosen per message in the panel. It becomes an optional capability per agent profile: Claude Code's steering extension when it ships, and ACP v2 `delivery: "steer"` when that's final. Record this in `features.md` as an adapter capability, as the "Adapter parity" rule requires.
5. **Approvals:** ostra keeps "always" as its own policy and answers the agent `once` or `reject`. A wait longer than the working value of 10 minutes cancels the turn and resumes with the decision.
6. **Borrow from Rivet**, with attribution under Q21:
   - the agent launch and install table, using the ACP registry format *with* hash checks
   - per-agent quirks (Pi payload normalization, stderr tails in errors, auth hints)
   - the `SessionRecord` / `SessionEvent` shape
   - the Inspector as the model for a debug view
7. **If the maintainer wants to keep Sandbox Agent anyway**, it's only safe with all of these, which together amount to a fork:
   - Pin 0.5.6, and spawn the binary from the runner with `--no-telemetry`, a per-task random token, `127.0.0.1`, an explicit env, `SANDBOX_AGENT_REQUIRE_PREINSTALL=1` and `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=86400000`.
   - Use a custom `fetch` with no undici headers or body timeouts.
   - Carry patches for [#306](https://github.com/rivet-dev/agents/pull/306), [#308](https://github.com/rivet-dev/agents/pull/308), [#358](https://github.com/rivet-dev/agents/pull/358) and [#407](https://github.com/rivet-dev/agents/issues/407).
   - Run one server per task, never `DELETE` (kill the process group instead), and use ostra's own persist driver.
   - Call `session/load` raw, mount `/proc` with `hidepid=2`, and use a per-task phantom key.
8. **Rivet Actors, RivetKit and Pi Durable:** no (§11).
9. **Fix the stale facts in ADR 0024.** "One event schema covering … questions" isn't true, and the "51 releases, 55k downloads a week" figures overstate adoption (Facts).

## Spike 1 test cases

Spike folder: `spikes/how-should-the-runner-drive-opencode/`.

**Setup:**
- Two drivers behind one tiny interface:
  - **A:** Sandbox Agent 0.5.6, spawned by the runner with the item 7 settings
  - **B:** plain `@agentclientprotocol/sdk` 2.7.0 over stdio
- OpenCode pinned to **2.3.2**, with 1.19.6 as a control for T3 and T5 only.
- Model traffic goes through the runner's loopback proxy with a phantom key.
- Test workspaces only (AGENTS.md).

A case passes when B passes, and the record says whether A passes too.

| # | Case | Pass criteria (fail if any is missed) |
|---|---|---|
| T1 | Offline, pinned install | With egress allowed only to the model proxy, a session starts and runs a turn. Packet capture shows no request to the ACP registry CDN, GitHub, npm or models.dev. The reported OpenCode version is the pinned one |
| T2 | No telemetry | Zero connections to `tc.rivet.dev` (A with `--no-telemetry`). Also record that A *without* the flag does call it, which documents the risk |
| T3 | Any base URL and model | Three runs each complete a turn: (a) a custom OpenAI-compatible provider with a custom model ID; (b) a catalog provider through `settings.baseURL`; (c) a models.dev ID, for example `anthropic/<current sonnet>`. The proxy log shows the phantom key swapped and the requested model ID. `/proc/<pid>/environ` of OpenCode and its children shows no real key. The model is set through `session/set_config_option` and accepted. (T3b: the same for Claude Code through claude-agent-acp with `ANTHROPIC_BASE_URL`) |
| T4 | Long turn | A turn that runs ≥ 20 min (a tool step running `sleep 1200`) ends with `end_turn`. No transport error, no lost events (contiguous seq), and the connection is reused for the next turn |
| T5 | Event completeness | A scripted ticket on a test repo produces, at minimum: `tool_call` with `rawInput` and `tool_call_update` with output for read, edit, bash and a failing tool; `diff` content or a permission diff for an edit; `plan`; child-session `_meta` for a subagent; `usage_update` with cost; `/compact` compaction markers; `stopReason`. Record events per minute and bytes per minute (input for the runner-transport event-volume risk) |
| T6 | Concurrency and integrity | 10 concurrent tasks on one runner, both one process per task and one shared process. A 5 s event-loop stall injected into the runner loses no events (seq gaps = 0), memory stays bounded, and one task's crash doesn't affect the others |
| T7 | Permissions | With `ask` rules: the request carries title, kind, `rawInput` and a diff preview. `once` runs the tool, `reject` fails it and the agent continues. A request held for 2 h is still answerable, or ostra's cancel-after-10-min path works end to end. Restarting the runner during a request is detected, and the turn is cancelled and re-prompted. **Security:** from the agent's own shell, it can't answer its own request or read another task's stream (for A, record whether a token stolen from `/proc` allows it) |
| T8 | Questions | With the `elicitation.form` capability, OpenCode's question arrives as `elicitation/create` and the answer reaches the model. Record A's behavior (expected: the question is cancelled) |
| T9 | Steering and interrupt | A second `session/prompt` mid-turn gets a clear error (no hang). `session/cancel` gives `stopReason: cancelled` within 5 s. Cancel then a new prompt continues with prior context. No processes are left over afterward (`ps` tree) |
| T10 | Model and mode mid-session | `set_config_option model` between turns, and once during a turn, applies to the next model call (proxy log). `session/set_mode plan` and then `build` work |
| T11 | Resume, same runner (ADR 0006 step 1) | Kill OpenCode between turns, and separately kill the driver process. After a restart, `session/load` with the same `cwd` replays history, and the agent answers a question about turn 1 correctly |
| T12 | Restore, other runner (step 2) | After a turn, `opencode session export` goes to blob storage. On a fresh box (same repo path and branch), `session import` and `session/load` keep the context. If the round trip fails (opencode#49314), step 3 (ticket, summary, branch) still continues the task |
| T13 | Agent crash | `kill -9` on OpenCode mid-turn is detected within 2 s, the session is marked crashed (ADR 0011 #5), and the workspace and branch are intact. For A, check whether `DELETE` hangs or orphans ([#407](https://github.com/rivet-dev/agents/issues/407)) |
| T14 | Process-tree cleanup | After 10 turns with cancels, no stray PIDs: test servers and shells started by tools are gone, killed by process group |
| T15 | Platforms | T3, T5, T7, T9 and T11 pass on an E2B template, on Docker with gVisor (`runsc`), and on a **Windows 11 laptop natively** (no WSL). Record macOS too |
| T16 | Resource use | Measure RSS and CPU of the driver and of OpenCode, idle and active, plus time from spawn to first token. Working budget: driver overhead ≤ 50 MB, spawn to first token ≤ 3 s |
| T17 | OS-user separation (Q27) | With the agent as a separate user, it can't read the runner's memory, files or proxy credentials |

**Bake-off (Q46):**
- **Arms:** OpenCode (through the chosen driver), Claude Code (claude-agent-acp, keys only), and Omnara's loop.
- **Inputs:**
  - The same 10 tickets: 3 bug fixes, 3 small features, 2 refactors and 2 that add tests, copied as realistic tickets into the test Linear workspace on test-org repos.
  - The same model for every arm, through the proxy.
  - 3 runs per ticket per arm.
- **Measures, per run:**
  - Mergeable PR, rated blind: merge as is / minor edits / reject, with CI green.
  - Cost in tokens and $ from the **proxy log**, not the agents' own reports.
  - Wall time; number of turns, permission prompts and crashes; event volume.
- **Decision** *(working values)*:
  - OpenCode stays the default if its mergeable rate is within 10 points of Claude Code's and its cost is no more than 25% higher.
  - Omnara is revisited only if it beats both by ≥ 20 points ("clearly wins").

## Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Sandbox Agent is in maintenance mode, run by one or two people**, with bugs auto-closed and the company's focus elsewhere (§9, §10) | Keep it off the runtime path (plain ACP). If it's used at all, fork it and own the patches |
| R2 | **Long turns and long permission waits break A's transport** at undici's 5 min ([#305](https://github.com/rivet-dev/agents/issues/305), [#307](https://github.com/rivet-dev/agents/issues/307)) | B has no HTTP hop. For A: a custom fetch with no timeouts, a raised `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS`, and the #306/#308 patches. T4 and T7 prove it |
| R3 | **Agent processes leak or are orphaned** on `DELETE` or shutdown ([#407](https://github.com/rivet-dev/agents/issues/407)), leading to OOM on fixed runners | The runner spawns each agent in its own process group and kills the group. One process per task. T13 and T14 |
| R4 | **Protocol drift:** Sandbox Agent speaks ACP SDK 0.16 while the ecosystem is at 2.7 and heading to v2; adapters are deprecated; ACP v2 is still a draft | Use SDK 2.x directly, negotiate v1 now, adopt v2 behind a capability flag. Contract tests per agent version |
| R5 | **OpenCode 2 is new and moving fast:** new config and API, export/import round-trip bugs, and Sandbox Agent's V1/V2 install skew | Pin OpenCode in the image and upgrade deliberately (ADR 0022). Contract suite T3, T5 and T11–T12 on every bump |
| R6 | **No mid-turn steering on OpenCode** (one prompt at a time) | Cancel and re-prompt or queue in v1. Steering becomes an optional capability per profile (Claude steering extension, ACP v2 `delivery`). The feature ledger states it |
| R7 | **Telemetry on by default** sends E2B team and sandbox IDs (ADR 0021) | B has none. A: always `--no-telemetry`, plus an egress deny. T2 |
| R8 | **Unpinned, unverified runtime downloads** (registry "latest", no SHA-256) | Preinstall in the image with hash checks; `SANDBOX_AGENT_REQUIRE_PREINSTALL=1` for A. T1 |
| R9 | **Secrets reach the agent** through env inheritance (the SDK spawns with `...process.env`) | Spawn with an explicit allowlisted env and a phantom key only (Q26). T3 checks `/proc/*/environ` |
| R10 | **The agent self-approves or reads other tasks** through A's loopback API and a token in argv | B has no API. A: one server per task, `hidepid=2`, a separate user. Treat approvals as policy and UX, with the box and proxy as the security boundary (ADR 0020). T7 and T17 |
| R11 | **Reopen elsewhere loses context:** replay-as-text is weak, and agent archives may not round-trip | Upload agent-native archives per turn; step 3 summary as the fallback; T12 |
| R12 | **Silent event loss** in A (ring 1,024, broadcast 512, persist errors swallowed) | B uses stdio with backpressure into the runner spool (runner-transport §3). For A: check SSE ids for gaps and resubscribe with `Last-Event-ID`. T6 |
| R13 | **Questions are dropped** without elicitation (OpenCode cancels them) | Advertise `elicitation.form` (B) and map it to ostra's question UI. T8 |
| R14 | **Windows laptops** are barely tested (Linux-only CI, process API 501 in A) | Plain ACP stdio is cross-platform in Node and Bun. Run T15 on Windows early |
| R15 | **Adapter auth and the closed agent list** (#313, #393) block Codex 1.x, custom gateways and oh-my-pi | B: the runner launches any ACP command from an agent profile, and the auth method is chosen per profile |
| R16 | **Claude Code licensing and terms:** it's proprietary inside claude-agent-acp; subscription tokens must never pass through ostra | Keys only (Q47). Never call `credentials extract-env`. Check redistribution before baking it into the public image (ADR 0023) |
| R17 | **Rivet company risk:** a small seed team that has pivoted before | The Apache-2.0 code can be forked; with B, only borrowed code remains, with attribution |
| R18 | **Docs can't be trusted** (removed APIs documented, stale capability table) | Trust the code and contract tests, and cite commits, not pages |
| R19 | **ostra now owns more code:** the driver, installers, quirks and a debug view | It's small: the official SDK does the JSON-RPC, and Rivet's code serves as reference. Budget it in milestone 1 and keep it in one package |
