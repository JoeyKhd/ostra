# Research: claude-mem

**Status:** Research v1 · **Checked:** 2026-11-21 (every source below was read on this date) · **Informs:** ADR 0044, F-109, F-110, F-111, F-129, F-145, ADR 0069

**Question (the maintainer, 2026-11-21):** "For memory can you check claude-mem, i think it works with most coding agents such as opencode that we have now." What claude-mem is and how it works, which agents it supports (OpenCode above all), its server and multi-user modes, its license, how it handles secrets and poisoning, and what that means for ostra, which already has memory (ADR 0044, F-109 to F-111).

Facts come from claude-mem's repository at `main` (`f1bb834`, 2026-11-20; release v16.0.2), its docs, its code, its issues and commits, the npm registry, the two MCP registries and cmem.ai. Paths without a host are files in that repository: `README.md` is [github.com/thedotmack/claude-mem/blob/main/README.md](https://github.com/thedotmack/claude-mem/blob/main/README.md). Its docs site, docs.claude-mem.ai, renders the same `docs/public/*.mdx` files (checked on `/hosted-server`). **Unverified** marks what no primary source confirmed. Recommendations are marked as such and are not decisions. The earlier survey (`research/project-memory.md`, §9) gave claude-mem one row; this file replaces that row's detail and agrees with it.

---

## Summary

- **What it is:** a memory add-on for coding agents on a developer's own machine. Hooks hand every tool call to a local worker, and "a second agent turns that activity into short observations, and writes a summary when the session ends". The next session "gets a compact index of the observations that matter for this project, and fetches full details only when it needs them" (`README.md`, "How It Works"). Its author and copyright holder is Alex Newman (`NOTICE`, `README.md`). It has 118,753 stars, 376 contributors and 413 releases, 41 of them in the last 30 days (GitHub API, 2026-11-21).
- **OpenCode: yes, on a developer's machine.** `npx claude-mem install --ide opencode` supports "OpenCode (1.3.4 or later, including OpenCode 2)" (`README.md`). It copies a plugin into the user's global OpenCode config and registers a local stdio MCP server there (`src/services/integrations/OpenCodeInstaller.ts`). The plugin has existed since 2026-02-27, and three bugs where it recorded nothing or didn't load were fixed through August (§2.1). **Inside an ostra box it does nothing:** ostra launches OpenCode with its own `HOME` and `XDG_CONFIG_HOME` and without project config, so the plugin never loads, and it needs a claude-mem worker on the same machine (§2.3).
- **It works with many agents.** Claude Code, Codex, Cursor, OpenCode "and 11 more agents" record sessions; Copilot CLI, Goose, Roo Code, Warp and Zed only search (`README.md`). The maintainer's premise holds for a developer's laptop.
- **The license is Apache-2.0,** since 13.0.0 on 2026-05-08. It was AGPL-3.0 from 2025-09-11 until then (§4). Apache-2.0 is on ostra's permissive list, so the license allows any of the options below. It isn't what decides them.
- **Shared memory exists, in beta.** A self-hosted "Claude-Mem Server (Beta)" keeps observations "per team and per project in Postgres" behind API keys, and serves a read-only, streamable-HTTP MCP server at `/v1/mcp` (`docs/public/hosted-server.mdx`). CMEM Pro's cloud sync is one person's devices (`docs/public/cloud-sync.mdx`), and the team product, TeamBrain, is a paid pilot whose price "is not announced" ([cmem.ai/pricing](https://cmem.ai/pricing)).
- **No person approves anything.** Every observation is written by a model from raw tool output. Secret redaction is **off by default** (`src/shared/SettingsDefaultsManager.ts`: `CLAUDE_MEM_REDACT_ENABLED: 'false'`). Tool output goes to the observer's model provider, and anonymous telemetry is on by default (§5).
- **Recommendation:** (a) plus (d). Keep ostra's memory as it is, and take four ideas from claude-mem (§"What this means for ostra"). (b) would work today only as a profile's own HTTP MCP server, not through the library, and it would hand agents memory that no member approved. (c) has no seam to plug into and contradicts ADR 0044, ADR 0017 and the rule that ostra makes no model call of its own.

---

## 1. What it is and how it works

### 1.1 Capture: hooks into the agent's lifecycle

- **Every agent event runs one command.** For Claude Code that's `claude-mem hook claude-code <event>` on "Setup (`claude --init` / `--maintenance`), SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStop and SessionEnd" (`README.md`, "How it fits together").
  - SessionStart starts the worker and injects context. UserPromptSubmit creates the session and saves the raw prompt. PostToolUse (matcher `*`) sends the tool call. Stop asks for the summary (`docs/public/architecture/overview.mdx`, "Plugin Hooks").
- **Each agent has its own adapter** in `src/cli/adapters/` (`README.md`). Gemini CLI, for example, maps SessionStart, BeforeAgent, AfterTool, AfterAgent and SessionEnd (`docs/public/gemini-cli/setup.mdx`).
- **What is captured:** the tool's name, its input and its output. The OpenCode plugin cuts each tool output to 1,000 characters after stripping `<private>` regions (`MAX_TOOL_RESPONSE_LENGTH = 1000` in `src/integrations/opencode-plugin/core.ts`). The worker also keeps the raw input and output in a `tool_uses` table, "truncated at 64 KB" (`docs/public/architecture/database.mdx`, "tool_uses").

### 1.2 Compression: the observer, a second model

- **The observer** "turns tool activity into observations and summaries", with one provider class per model source (`README.md`). An observation has a title, subtitle, narrative, facts, concepts, a type (`decision`, `bugfix`, `feature`, `refactor`, `discovery`, `change`) and the files it read and changed (`docs/public/architecture/database.mdx`).
- **Which model:** the default is `CLAUDE_MEM_PROVIDER=claude` with `CLAUDE_MEM_MODEL=haiku`, which "follows the newest Haiku", through the Claude Agent SDK. The other providers are `codex`, `gemini`, `openrouter` and `openai-compatible` (`docs/public/configuration.mdx`, "Core Settings"; defaults in `src/shared/SettingsDefaultsManager.ts`).
- **Whose key:** with the Claude provider, "the observer normally reads your Claude Code login from the credential store at every spawn" (`docs/public/configuration.mdx`, "Long-Lived Claude Token"), so it spends the user's own plan. The installer offers "the claude-mem observer, your own OpenRouter or Gemini key, or your Anthropic plan". CMEM Pro's 30-day trial falls back to "your Anthropic plan unless you subscribe" (`README.md`, "Quick Start"). CMEM Pro's observer is the OpenRouter client pointed at `https://cmem.ai/api/inference/v1` with the model `cmem-observer` (`docs/public/cmem-pro-headless.mdx`).
- **Cost:**
  - A model call per recorded tool call and per summary: "cmem.ai turns each recorded tool call and each turn summary into memory with one model call" (`docs/public/eve-integration.mdx`). The Claude provider batches one event per prompt by default (`CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE`, default `1`).
  - Each observer conversation holds up to 100,000 characters by default: "an observer turn measured about 100K tokens at the old default and about 26K at `100000`" (`docs/public/configuration.mdx`, "Observer Budget Settings").
  - CMEM Pro is $30 a month, Heavy $70 and CMEM Max $100, each with an included allowance ([cmem.ai/pricing](https://cmem.ai/pricing)).

### 1.3 Where data lives

- **A local worker:** an Express HTTP service run by Bun, "on a per-user port (default `37700 + (uid % 100)`, override via `CLAUDE_MEM_WORKER_PORT`)", bound to `127.0.0.1` (`docs/public/architecture/overview.mdx`; `docs/public/configuration.mdx`). It also serves the viewer and "My Work" (`README.md`).
- **SQLite** at `~/.claude-mem/claude-mem.db`, with FTS5 tables for keyword search (`docs/public/architecture/database.mdx`).
- **Chroma** adds semantic search on top (`README.md`, "How it fits together"). It runs as `chroma-mcp` under Python through `uv`, which the installer adds if missing (`README.md`, "System Requirements"; `docs/public/hosted-server.mdx`, the `CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS` row).
- **The server runtime** swaps all of this for Postgres, Valkey and a BullMQ generation worker (§3.3).

### 1.4 Retrieval: an index at start, then search

- **At session start** the agent gets an index of up to 50 observations (`CLAUDE_MEM_CONTEXT_OBSERVATIONS`, default `50`), filed under the project's name. Injection "starts on your second session in a project" (`README.md`; `docs/public/configuration.mdx`).
- **Through MCP:** three tools in "a token-efficient three-step workflow": `search` for "a compact index with IDs (~50-100 tokens/result)", `timeline` for "chronological context around interesting results", and `get_observations` for "full details ONLY for filtered IDs (~500-1,000 tokens/result)", "always batch multiple IDs" (`README.md`, "MCP Search Tools").
  - A fourth layer, `get_tool_uses`, returns the raw bodies, "by far the most expensive layer" (`docs/public/progressive-disclosure.mdx`, "Layer 4").
  - The local server defines 26 tools, among them code navigation (`smart_search`, `smart_outline`, `smart_unfold`), `save_memory`, work-state tools and the server runtime's `observation_*` tools (`src/servers/mcp-server.ts`).
- **The design idea** is "progressive disclosure": show lightweight metadata first, fetch details only when needed, and "make costs visible" by showing each entry's token count (`docs/public/progressive-disclosure.mdx`).

---

## 2. Which agents it supports, and OpenCode

### 2.1 OpenCode

- **How:** two pieces, both in the user's global OpenCode config, `~/.config/opencode/` or `OPENCODE_CONFIG_DIR` (`getOpenCodeConfigDirectory` in `src/services/integrations/OpenCodeInstaller.ts`).
  1. **A plugin**, copied to `plugins/claude-mem.js`. It is listed in `opencode.json` only for OpenCode 1, since "OpenCode 2 loads it from its `plugins` directory" (`docs/public/platform-integration.mdx`).
  2. **A local stdio MCP server** in `opencode.json`'s `mcp` block, `{ type: 'local', command: [node, mcp-server.cjs] }` (`addOpenCodeMcpReferenceWithStatus` in `OpenCodeInstaller.ts`).
- **The plugin's hooks.** One default export serves both of OpenCode's plugin contracts, V1 (1.3.4 and later) and V2 (2.x) (`src/integrations/opencode-plugin/index.ts`). It registers (`src/integrations/opencode-plugin/contract.ts`):
  - tool capture: `tool.execute.after` (V1) or `ctx.tool.hook("execute.after")` (V2);
  - the user's prompt: `chat.message` or `ctx.session.hook("prompt")`;
  - memory injection into the system prompt: `experimental.chat.system.transform` or `ctx.session.hook("context")`;
  - compaction, the end of a turn (`session.idle`, or `session.execution.succeeded` in V2) and a deleted session;
  - three custom tools: `claude_mem_search`, `claude_mem_timeline` and `claude_mem_get_observations` (`v1.ts`, `v2.ts`).
- **Every hook calls the local worker** at `CLAUDE_MEM_WORKER_HOST:CLAUDE_MEM_WORKER_PORT` over plain HTTP (`resolveWorkerBaseUrl` in `core.ts`). The plugin never starts the worker: the docs say to leave idle exit off "for OpenCode plugin capture and OpenClaw, which never start the worker" (`docs/public/configuration.mdx`, `CLAUDE_MEM_IDLE_EXIT_SEC`). It doesn't follow a remote worker: "The Hermes, OpenClaw and OpenCode integrations keep their own host and port settings and do not read [`CLAUDE_MEM_WORKER_URL`]" (`docs/remote-worker-capture.md`).
- **Which versions:** OpenCode 1.3.4 is "the supported floor (the installer warns below it)" (`index.ts`). The V2 event names were "verified against the 2.0 GA schema and the real compaction flow (anomalyco/opencode v2.0.32)" (`contract.ts`). ostra runs OpenCode 2.3.2 (`packages/adapters/adapter-opencode/src/config.ts`), a version the file doesn't name. **Unverified** whether the plugin works on 2.3.2.
- **How mature:** young, and fixed often.
  - Added on 2026-02-27, "feat: add Gemini CLI, OpenCode, and Windsurf IDE integrations", with 43 commits to the plugin since ([commit history of `src/integrations/opencode-plugin`](https://github.com/thedotmack/claude-mem/commits/main/src/integrations/opencode-plugin)).
  - Three times it loaded and recorded nothing or failed to load: [#2435](https://github.com/thedotmack/claude-mem/issues/2435) (2026-05-12, "event names don't match OpenCode's actual hook API"), [#3330](https://github.com/thedotmack/claude-mem/issues/3330) (2026-07-19, "fails to load in v13.11.0") and [#3678](https://github.com/thedotmack/claude-mem/issues/3678) (2026-08-21, "no observations are ever generated (13.15.3)"). `contract.ts` names #2435's cause: "the old code subscribed to non-existent bus types … and therefore captured nothing".
  - OpenCode 2 support came in October and November: [#4519](https://github.com/thedotmack/claude-mem/issues/4519) ("honor the 2.0.23 host contract", closed 2026-11-07) and the commit "pin the verified OpenCode 2.0 GA event names (#6102)" on 2026-11-15.
  - 97 issues mention OpenCode, and 5 are open, all of them plan issues (GitHub search, 2026-11-21).

### 2.2 The other agents

- **Sessions recorded:** Claude Code (native plugin hooks), Codex CLI (`~/.codex/config.toml`), Cursor (`~/.cursor/hooks.json`, `~/.cursor/mcp.json`), Windsurf, OpenCode, OpenClaw, Antigravity CLI, Kimi Code, Devin CLI and Desktop, and Hermes (`docs/public/platform-integration.mdx`, "Supported Harnesses"). Gemini CLI uses hooks in `~/.gemini/settings.json` (`docs/public/gemini-cli/setup.mdx`). Pi, DeepSeek Harness, T3 Code, OMP and Grok Bot have installers too (`README.md`, "Other agents").
- **Search only:** "Copilot CLI, Goose, Roo Code, Warp and Zed get memory search only, so their sessions don't add to it" (`README.md`).
- **The common shape:** every integration edits that agent's config in the user's home folder, and every one talks to the same local worker.

### 2.3 OpenCode inside an ostra box

- **The plugin doesn't load.** ostra gives OpenCode an environment from an allowlist, with `HOME`, `XDG_CONFIG_HOME` and the rest pointed at the task's own folders, and `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so "a repo's own `opencode.json` and `.opencode/` are never read: its permissions, MCP servers, agents and plugins can't widen the profile's" (`buildCliEnv` in `packages/adapters/adapter-opencode/src/config.ts`). `OPENCODE_CONFIG_DIR` is not on the allowlist. A claude-mem install on a `host` runner's machine is therefore not loaded either, which is what F-110's rule asks for: nothing an agent keeps for itself outlives the task (ADR 0044, Q91 change 4).
- **To make it work, ostra would have to** write the plugin into the task's config itself, run a claude-mem worker that the plugin reaches at a host and port (in the box, or reachable from it over plain HTTP), and give that worker an observer model and key. That is third-party code in the agent's process, with every tool's input and output passing through it.

---

## 3. Server and multi-user modes

### 3.1 A shared worker

Several machines can share one worker: "A worker shared by several machines owns the database, vector index, observer and processing spool. … Set `CLAUDE_MEM_WORKER_URL` on each client." A shared ingest token protects only `POST /api/spool/ingest`: "It does not protect the rest of the worker API. … do not expose the worker directly to the public internet." The OpenCode plugin doesn't use this path (§2.1) (`docs/remote-worker-capture.md`).

### 3.2 CMEM Pro cloud sync

- **One person's devices.** Sync "replicates eligible memory records across your devices through a **per-user sync hub**". The user id "names your hub log", and a hub takes "at most 64 distinct device ids per account" (`docs/public/cloud-sync.mdx`).
- **What it uploads:** "your observation narratives and your full prompt text to the sync hub under your cmem.ai account, and, if media capture is on, your converted screenshots" (same page, "Privacy").
- **It's opt-in:** sync runs only when the token, the user id and the hub URL are all set (same page). The hub URL defaults to empty (`CLAUDE_MEM_CLOUD_SYNC_HUB_URL: ''` in `SettingsDefaultsManager.ts`).
- **The hosted MCP link** is `https://cmem.ai/api/mcp`. In the Claude app it is added as a connector, and the user signs in "with the cmem.ai account that holds your memory". Its tools (`memory_search`, `timeline`, `get_observations`, `get_summaries`, `list_projects`) "only read" (`cowork/README.md`). **Unverified** whether it also takes a static bearer key from a client other than Claude's.

### 3.3 Claude-Mem Server (beta, self-hosted)

- **What it is:** "a Postgres-backed, BullMQ-driven, API-key-authenticated runtime". The Compose stack runs four services: Postgres, Valkey, the HTTP server and a generation worker that "call[s] provider" (`docs/server.md`). The page warns: "This is early and moving fast. … Pin a version if you're integrating" (`docs/public/hosted-server.mdx`).
- **Scope:** "Every row is scoped by `(team_id, project_id)`. An API key carries a **team** (always) and an optional **project** scope; that scoping bounds every read, write, and delete" (`docs/public/hosted-server.mdx`).
- **Auth:** API keys with `memories:read` and `memories:write` scopes. "The raw key is shown **once**; only a SHA-256 hash is stored", and a revoked key is refused on the next request (`docs/server.md`). There is no per-member identity inside a team: "Team/org memory sync", "SSO/SAML/SCIM", "Enterprise RBAC" and "Enterprise audit log UI" are "reserved commercial/private areas" (`docs/ip-boundary.md`). A team's first key "still needs a session-gated path (a web dashboard)", which "is the rough edge" (`docs/public/hosted-server.mdx`). The CLI can also mint one: `claude-mem server api-key create` (`docs/server.md`).
- **`/v1/mcp`:** "a streamable-HTTP MCP server … **read-only** and authenticated by the same API key as the REST routes (`memories:read`)". Its tools are `search`, `timeline`, `get_observations`, `context` and `recent`, each taking a `projectId`. "Mutating tools are intentionally absent", and "Every read is written to `audit_log`" (`docs/public/hosted-server.mdx`). The code requires `projectId` on every call (`requireString(args, 'projectId')` in `src/server/mcp/recall-mcp-server.ts`).
- **Writes:** `POST /v1/events` takes raw events and queues a generation job. `POST /v1/memories` stores a note directly, without generation (`docs/public/hosted-server.mdx`, endpoint reference; `observation_add` in `src/servers/mcp-server.ts`). The local hooks and stdio MCP server use them when `CLAUDE_MEM_RUNTIME=server`, with `CLAUDE_MEM_SERVER_URL`, `_API_KEY` and `_PROJECT_ID` (`src/services/hooks/runtime-selector.ts`). The OpenCode plugin always calls the worker's `/api/sessions/init`, which a server-beta port answers with 404 "by design" (`docs/server-parity-map.md`; `core.ts`). So OpenCode sessions can't feed the server directly.
- **One model key per deployment:** the generation worker's providers "each … read a single set of credentials from its environment. If your deployment needs something else, such as a different key per project, set `CLAUDE_MEM_SERVER_PROVIDER=custom`" and supply a module (`docs/public/hosted-server.mdx`).

### 3.4 TeamBrain

A shared view of the work lists that teammates choose to share, beside "My Work" in the local viewer. Members join with `npx claude-mem teambrain join '<invite-link>'` and choose projects (`docs/public/usage/teambrain.mdx`). It is a pilot: "Pilot seats, onboarding, scope, and price are agreed on a fit call. Public TeamBrain pricing is not announced" ([cmem.ai/pricing](https://cmem.ai/pricing)).

### 3.5 How a project is scoped

- **On the local worker, by folder name.** "Inside a git repository the name is the repository root's folder name"; with `CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote` it's the `org/repo` slug. Worktrees and submodules also read their parent's memory (`docs/public/configuration.mdx`, "Project Names").
- **That is not access control:** "This setting selects default context, not access permissions. Explicit queries for other projects and `CLAUDE_MEM_CONTEXT_PROJECTS=all` can still read a broader scope" (same section).
- **On CMEM Pro, one key reads across projects:** "`get_observations` fetches by ID across the key's whole memory, because the hosted tool has no project filter. … If separate callers must never see each other's memory, give them separate keys" (`docs/public/eve-integration.mdx`, "Security").

---

## 4. License

- **Apache-2.0 today,** for the whole repository: the root `LICENSE`, and the `LICENSE` files in `dsh/` and `integrations/eve/template/`, are the Apache License 2.0 text. The npm package says `"license": "Apache-2.0"` at 16.0.2, and its three runtime dependencies are `sharp`, `better-auth` and `@better-auth/api-key` ([registry.npmjs.org/claude-mem](https://registry.npmjs.org/claude-mem)). `docs/license.md` gives the reason: "Claude-Mem is intended to be embedded broadly inside developer tools, local agents, MCP clients, enterprise systems … and production agent harnesses."
- **It was AGPL-3.0 before,** which may be what the maintainer remembered.
  - The `LICENSE` file was a custom "Binary Distribution License" at the first release (2025-09-06), then "CLAUDE-MEM SOFTWARE LICENSE" (2025-09-09), then the GNU AGPL-3.0 from v3.6.3 (2025-09-11) ([`LICENSE` at v3.9.9](https://github.com/thedotmack/claude-mem/blob/85ed7c3d2f/LICENSE)).
  - It became Apache-2.0 in [commit `36b0929fae`](https://github.com/thedotmack/claude-mem/commit/36b0929fae) on 2026-05-08 (PR #2351, "Server-beta: Postgres storage …").
  - The npm `license` field followed: "SEE LICENSE IN LICENSE" up to 9.0.6, `AGPL-3.0` from 9.0.7 (2026-01-25) to 12.x, and `Apache-2.0` from 13.0.0 (2026-05-08) (npm registry, per-version `license` and `time`).
- **What stays closed:** the hosted cloud, team sync, the admin dashboard, SSO, RBAC, the audit log UI and DLP are "reserved outside the Apache-2.0 public implementation" (`docs/ip-boundary.md`). cmem.ai's services are not open source.
- **For ostra:** Apache-2.0 is on ostra's permissive list (`permissiveLicenses` in `scripts/known-licenses.ts`), so `pnpm check:licenses` would accept it in either license line, Apache-2.0 packages included (ADR 0048). ostra could legally embed it, vendor it, run it beside core or call it as an MCP server, keeping its `NOTICE`. A version from before 13.0.0 is AGPL-3.0, so pin 13.0.0 or later. The license doesn't rule out any option. The design does (below).

---

## 5. Security

### 5.1 Secrets in captured tool output

- **`<private>` tags are always on:** content wrapped in `<private>…</private>` "never gets stored" (`README.md`), and "Always on (no setting)" (`docs/public/usage/auto-redaction.mdx`, comparison table). Only content someone wrapped is covered.
- **Auto-redaction is off by default.** It is "an opt-in regex-based detection that replaces common secret patterns", with 42 vendor patterns and 4 generic ones behind a second switch (`CLAUDE_MEM_REDACT_GENERIC_ENABLED`). It runs before storage and before the observer prompt ("When a payload contains a marker, the observer prompt tells the model to treat it as a placeholder") (`docs/public/usage/auto-redaction.mdx`). The default is `CLAUDE_MEM_REDACT_ENABLED: 'false'` (`src/shared/SettingsDefaultsManager.ts`).
- **The result, by default:** a token that a command prints is sent to the observer's model provider, can land in an observation, and stays in `tool_uses` (raw, up to 64 KB per row).
- **The server's redaction isn't per tenant:** "in multi-tenant `server-beta` deployments, the redaction config is currently read from the worker's local `~/.claude-mem/settings.json` rather than from tenant-scoped settings" (same page, "Limits").

### 5.2 Prompt-injection poisoning

- **Every observation is model output written from untrusted input** (tool output, web pages, repo files), and no person reviews it before the next session reads it.
- **The project has met the problem.** [#4141](https://github.com/thedotmack/claude-mem/issues/4141) (2026-09-20): "Adversarial content summarized into an observation title flows into the instruction context of every subsequent session, persistently and without user awareness — a stored prompt-injection primitive." The fix, [#4179](https://github.com/thedotmack/claude-mem/issues/4179), sanitizes and quotes recalled text, but only on the Grok Bot path ("Harden Grok Bot memory inject").
- **The default session-start block** renders each observation's title as it is, `${refId} ${time} ${icon} ${title}` (`renderAgentTableRow` in `src/services/context/formatters/AgentFormatter.ts`).
- **The Eve provider** wraps recall in `<claude_mem_context>` and `<claude_mem_recall>` "with markup escaped and a note that it is data, not instructions" (`docs/public/eve-integration.mdx`).
- **The agent's own tools have been a path out.** [#3861](https://github.com/thedotmack/claude-mem/issues/3861) (2026-09-03, closed): `smart_unfold` and `smart_outline` read any file the user could, and `GET /api/settings` returned "every configured provider credential in cleartext" with no authentication. The report: "Any content the agent processes during a normal session … is a place a prompt injection payload could sit." The `smart_*` tools now resolve their paths inside the workspace (`resolveWithinWorkspace`, imported by `src/servers/mcp-server.ts`), and since v16.0.0 `CLAUDE_MEM_LOCAL_API_TOKEN` is what "protects network access now" ([v16.0.0 release notes](https://github.com/thedotmack/claude-mem/releases/tag/v16.0.0)).

### 5.3 Data leaving the machine

- **To the observer's provider:** prompts and tool input and output, on every recorded call (§1.2). That is Anthropic on the default Claude provider, or OpenRouter, Gemini, Codex, cmem.ai or any OpenAI-compatible endpoint (`docs/public/configuration.mdx`).
- **To cmem.ai:** cloud sync, when on (§3.2). The installer's sign-in, when used, sends "your email and optional note … and a numbers-only usage summary" (`docs/public/cmem-pro-headless.mdx`).
- **To PostHog:** "anonymous usage analytics … It is on by default (opt-out)", with a whitelist of properties, and `DO_NOT_TRACK` is honored (`docs/public/telemetry.mdx`; `README.md`).
- **Screenshots:** converted copies stay on the machine by default, are uploaded "only when Cloud Sync is on", and reach the observer "only when image inference is separately enabled" (`README.md`, "What You Get").

### 5.4 The local API

Any process that can reach loopback can call the worker. `CLAUDE_MEM_LOCAL_API_TOKEN` is "an opt-in switch: set it, and a request must carry the token or it is refused with `401`. Unset, nothing changes" (`docs/public/configuration.mdx`, "Local API Token"). It's empty by default (same table).

---

## Compared with ostra's memory

| | claude-mem (default install) | claude-mem Server (beta) | ostra (ADR 0044, F-109 to F-111) |
|---|---|---|---|
| Who writes | A second model, from every tool call | The same, through `/v1/events`; `/v1/memories` stores a note directly | Members write; agents and the AI review only propose |
| Approval | None | None | A member approves, rejects or merges every proposal |
| Model calls | One per recorded call and per summary, on the user's plan or key | The generation worker's, one key per deployment | None of its own (`project.md`, non-goals) |
| Scope | One user on one machine; project by folder name, "not access permissions" | Team, plus an optional project per key | Organization and project, with project access (ADR 0026) |
| Storage | SQLite, FTS5, Chroma (Python) | Postgres, Valkey, BullMQ, optional pgvector | Postgres only (ADR 0017) |
| Retrieval | An index of 50 at start; `search`, `timeline`, `get_observations` | Read-only `/v1/mcp`, `projectId` on every call | An index and "always" notes at start; `memory_search`, `memory_read`, `memory_propose` |
| Secrets | `<private>` tags; redaction off by default | Redaction from the worker's local settings | Every note and proposal scanned and refused on a hit (Q201) |
| Poisoning | Hardened on the Grok Bot path only | Same | Approval, a model-control-token filter, sources on every note (Q91) |
| Where the agent runs | The user's own machine | Clients on many machines | A fresh box per task, credentials in the sidecar (ADR 0030) |

---

## What this means for ostra

### The recommendation *(a recommendation, not a decision)*

**Keep ostra's memory as it is (a), and borrow four ideas from claude-mem (d).** Don't integrate claude-mem (c). Don't offer it as a memory option (b), though an admin can attach its MCP server like any other at their own judgment.

claude-mem answers a different question. It is one developer's automatic diary, written by a model and read back without review. ostra's memory is an organization's reviewed knowledge, and "nothing an agent writes reaches … the organization's memory until a member approves it" (`project.md`, principle 6). claude-mem's own history shows why that rule exists: its stored-injection report (#4141) is exactly what ADR 0044's approval step is there to stop.

### (a) Keep ostra's memory as is

- **Holds up.** claude-mem's index-then-fetch design is the same one ostra already ships (an index at session start, then `memory_search` and `memory_read`), and the same one `research/project-memory.md` found everywhere.
- **What claude-mem has that ostra lacks** is automatic capture. ostra's two routes to it stay: the standing instruction to call `memory_propose`, and the closing turn, a profile option that is off by default (F-111). Both go through a member.

### (b) claude-mem's MCP server as an optional extra (F-145)

- **Not through the library.** F-145 installs an MCP server only by its name in a registry on the organization's list (ADR 0069). claude-mem is in neither GitHub's curated registry (`https://api.mcp.github.com/v0.1/servers?search=claude-mem`: no results) nor the official one (searches for `claude-mem`, `cmem` and `thedotmack` find only other projects), checked 2026-11-21. It publishes no registry an admin could add.
- **As a profile's own HTTP server, it should work, but is untested.** ADR 0049 lets an admin add an HTTP MCP server to a profile, reached through the sidecar's MCP proxy with its headers from the secret store (`taskSpecMcpServerSchema` in `packages/protocol/src/task/spec.ts`). A self-hosted server's `/v1/mcp` fits that shape:
  - it's streamable HTTP;
  - it uses a bearer API key and no OAuth, so it isn't refused for sign-in;
  - its tools only read, so an admin could mark it read-only.
  - The profile's instructions would have to name the `projectId`, since every tool requires it.
  - cmem.ai's own link signs in through the Claude app, so it may need OAuth, which ostra refuses (Q321); **unverified**.
- **What it would give:** agents could read observations that claude-mem installs elsewhere wrote, such as the team's laptops in server mode. Nothing in an ostra task would add to it (§2.3, §3.3).
- **Why not to offer it as memory:** those observations reach agents without approval, outside the secret scan, the model-control-token filter, the source links, the "notes a session used" list and the audit log. ADR 0044 rejected exactly that ("Notes saved by agents with no approval"). An admin who attaches it anyway is choosing a generic MCP server, and ostra treats it like one: not read-only until an admin says so, behind the proxy, with its key in the secret store.

### (c) claude-mem as a memory backend

**Rejected,** for six reasons:

- **There is no seam.** ostra's adapter kinds are tracker, code host, agent, executor, model provider, notification, secret store and blob store (`AGENTS.md`, ADR 0025). Memory isn't one, so (c) means a new adapter kind and a new ADR.
- **It adds stores.** The server needs Postgres, Valkey and a BullMQ worker (§3.3), and "Postgres is the only store an install needs" (ADR 0017).
- **It makes model calls ostra doesn't.** Each recorded tool call costs a model call, on one key per deployment (§1.2, §3.3), outside ostra's key proxy and budgets. That breaks "never makes a model call of its own" (`project.md`, non-goals).
- **Capture needs code in the agent's process.** The OpenCode plugin talks plain HTTP to a worker at a host and port and can't reach the server (§2.1, §3.3). It would put third-party code beside the agent, with every tool's output passing through it, on every executor (runner parity).
- **Its model is the opposite of F-111's:** automatic capture, no approval.
- **Its scoping is a key per team** with no member identity, and the access control that would match ADR 0026 is in its reserved commercial areas (§3.3).

### (d) Ideas to borrow *(recommendations, not decisions)*

1. **Read several notes in one call.** claude-mem tells the agent to "always batch multiple IDs", up to 100 per `get_observations` call (`README.md`; `recall-mcp-server.ts`). ostra's `memory_read { noteId }` reads one (ADR 0044, Q203). An optional `noteIds` list (at most 20, the search limit) would save a round trip per note. It's an additive change to the memory tool and to `memory.used`, which already records each read.
2. **Make a question-shaped search rank its rare words first.** ostra's `memory_search` ORs every query word as a prefix, under the `simple` config with no stop words, and ranks by `ts_rank` (`searchNotes` and `queryWords` in `packages/domain/src/memory/store.ts`). So in "how do we run the api tests", the words "how", "do", "we" and "the" match as prefixes, and `ts_rank` gives no extra weight to rare words. claude-mem's server meets the same problem: with bm25, "rare terms count for more than common ones and a question such as `when did we change the retry limit` finds the memory about the retry limit first" (`docs/public/hosted-server.mdx`, "Keyword search"). Its bm25 comes from the `pg_textsearch` extension, which ostra can't assume, so the step for ostra is a test with question-shaped queries. If they rank badly, drop short and common words from the query, or weight words by how rare they are in the scope's notes, in stock Postgres.
3. **Quote recalled text at the boundary.** Escape markup in a note's title and body where the memory block is built (`packages/domain/src/memory/block.ts`), so a note can't close or open a tag around itself. That is claude-mem's Grok Bot fix (#4179) and its Eve provider's rule. ostra's notes are approved, and the block rightly names them as approved instructions (Q91 change 5), so the "data, not instructions" framing doesn't fit. Escaping still costs nothing, and it backs up the model-control-token filter on what a member skimming a long proposal might miss.
4. **Candidate notes from the task's own record, without a model.** claude-mem's value is capture nobody has to remember. ostra could offer candidates from what a task already records, for example a command that failed and then passed after a change, as a suggestion on the task page that a member turns into a proposal. That's for F-129, and it needs its own design.

**Not worth borrowing:**

- **Automatic capture by a model:** it needs a model call (`project.md`).
- **A `timeline` tool:** claude-mem's memory is a chronological log of sessions. ostra's notes are facts, each with a source task, so the task page already is the timeline.
- **`<private>` tags:** they keep text out of an automatic capture, and ostra has none. A note exists only once a member approves its text.
- **Showing each note's token count in the index:** ostra's notes are short by design ("One fact per note").

### For the Claude Code adapter (F-018, after v1)

claude-mem installs into Claude Code as a plugin with its own hooks (`/plugin install claude-mem`, `README.md`). `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, which ADR 0044 names for that adapter, turns off Claude Code's auto memory. No source says it also stops a plugin's hooks (**unverified**). The adapter has to keep the machine's `~/.claude` out of a task on `host`, as the OpenCode adapter keeps `~/.config/opencode` out today (§2.3), or a developer's claude-mem would record ostra's tasks and feed them into the next one, unreviewed.

---

## Sources checked

| Source | What | Read |
|---|---|---|
| [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) (`main` at `f1bb834`; GitHub API for stars, releases, contributors) | The repository | 2026-11-21 |
| `README.md` | What it is, agents, quick start, MCP tools, requirements, license | 2026-11-21 |
| `LICENSE`, `NOTICE`, `docs/license.md`, `docs/ip-boundary.md`, `dsh/LICENSE`, `integrations/eve/template/LICENSE` | License and open-core boundary | 2026-11-21 |
| [`LICENSE` history](https://github.com/thedotmack/claude-mem/commits/main/LICENSE): `598369e894`, `aae7de8e05`, `97807494fd`, `85ed7c3d2f`, `36b0929fae` | Custom license, then AGPL-3.0, then Apache-2.0 | 2026-11-21 |
| [registry.npmjs.org/claude-mem](https://registry.npmjs.org/claude-mem) | Versions, per-version license, dependencies of 16.0.2 | 2026-11-21 |
| `docs/public/architecture/overview.mdx`, `architecture/database.mdx`, `progressive-disclosure.mdx` | Hooks, worker, SQLite, FTS5, `tool_uses`, the layers | 2026-11-21 |
| `docs/public/configuration.mdx` | Providers, models, ports, budgets, project names, local API token | 2026-11-21 |
| `docs/public/platform-integration.mdx`, `docs/public/gemini-cli/setup.mdx` | Supported agents and their config files | 2026-11-21 |
| `src/integrations/opencode-plugin/index.ts`, `contract.ts`, `core.ts`, `v1.ts`, `v2.ts`; `src/services/integrations/OpenCodeInstaller.ts` | The OpenCode integration | 2026-11-21 |
| `src/servers/mcp-server.ts`, `src/servers/mcp-http.ts`, `src/server/mcp/recall-mcp-server.ts`, `src/services/hooks/runtime-selector.ts` | MCP tools and the server runtime | 2026-11-21 |
| `src/shared/SettingsDefaultsManager.ts`, `src/services/context/formatters/AgentFormatter.ts` | Defaults; how the session-start block renders | 2026-11-21 |
| `docs/server.md`, `docs/public/hosted-server.mdx` (also on [docs.claude-mem.ai/hosted-server](https://docs.claude-mem.ai/hosted-server)), `docs/server-parity-map.md`, `docs/remote-worker-capture.md` | Server beta, `/v1/mcp`, keys, scope, shared worker | 2026-11-21 |
| `docs/public/cloud-sync.mdx`, `docs/public/cmem-pro-headless.mdx`, `docs/public/usage/teambrain.mdx`, `cowork/README.md`, `cowork/.mcp.json`, `docs/public/eve-integration.mdx` | CMEM Pro, TeamBrain, the hosted MCP link | 2026-11-21 |
| `docs/public/usage/auto-redaction.mdx`, `docs/public/telemetry.mdx` | Redaction, private tags, telemetry | 2026-11-21 |
| Issues [#2435](https://github.com/thedotmack/claude-mem/issues/2435), [#3330](https://github.com/thedotmack/claude-mem/issues/3330), [#3678](https://github.com/thedotmack/claude-mem/issues/3678), [#4519](https://github.com/thedotmack/claude-mem/issues/4519), [#3861](https://github.com/thedotmack/claude-mem/issues/3861), [#4141](https://github.com/thedotmack/claude-mem/issues/4141), [#4179](https://github.com/thedotmack/claude-mem/issues/4179); [commits of the OpenCode plugin](https://github.com/thedotmack/claude-mem/commits/main/src/integrations/opencode-plugin); [release v16.0.0](https://github.com/thedotmack/claude-mem/releases/tag/v16.0.0) | OpenCode maturity, security history | 2026-11-21 |
| [cmem.ai](https://cmem.ai), [cmem.ai/pricing](https://cmem.ai/pricing), [claude-mem.ai](https://claude-mem.ai) | CMEM Pro and TeamBrain offer and prices | 2026-11-21 |
| [registry.modelcontextprotocol.io/v0.1/servers](https://registry.modelcontextprotocol.io/v0.1/servers?search=claude-mem), [api.mcp.github.com/v0.1/servers](https://api.mcp.github.com/v0.1/servers?search=claude-mem) | No claude-mem entry | 2026-11-21 |
| ostra: ADR 0017, 0025, 0026, 0030, 0044, 0048, 0049, 0069; `project.md`; `features.md` (F-109 to F-111, F-129, F-145); `scripts/known-licenses.ts`; `packages/adapters/adapter-opencode/src/config.ts`; `packages/domain/src/memory/store.ts`; `packages/protocol/src/task/spec.ts` | What ostra already does | 2026-11-21 |
