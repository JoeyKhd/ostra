# Research: the CLI coding agent roster for ostra

**Question:** Which CLI coding agents would a professional team consider top tier in November 2026? How can ostra's runner drive each one (headless/JSON, ACP, SDKs, steering, resume, approvals, auth, OS)? In what order should ostra support them?

**Checked:** 2026-11-17, for every claim unless a different date is given.
- **Primary sources:** official docs, READMEs, shipped source or npm tarballs, package registries, the ACP registry.
- **Secondary sources** (blogs, listicles, forum posts) are labelled as secondary.
- Anything not confirmed from a primary source is marked **unverified**.

**Companion:** [agent-harnesses.md](agent-harnesses.md) covers Claude Code, OpenCode, oh-my-pi and the ACP spec in depth. They appear here only as baseline rows.

---

## Summary

- **Four agents lead on adoption: Claude Code, GitHub Copilot, Codex and Cursor.**
  - Stack Overflow 2026 ("used in the past year", n=12,255): Claude Code 65.5%, Copilot 58.7%, Codex 29.5%, Cursor 25.5% ([SO 2026](https://survey.stackoverflow.co/2026/ai/data/ai-code-agent)).
  - JetBrains, work use May–Jul 2026: 39 / 21 / 16 / 12% ([JetBrains research](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026)).
  - Second band: Google Antigravity (16.0%), OpenCode (13.6%), JetBrains AI/Junie (12.8%), Cline (4.5%), pi (4.4%), Amazon Q/Kiro (3.9%), Kilo Code and Mistral Vibe (3.2% each).
  - Caveat: survey answers name products, not their CLIs, and Copilot and Cursor are mostly used in the IDE.
- **ACP is now the standard way in.** The ACP registry lists 46 agents in machine-readable form, with launch commands and per-platform binaries ([registry.json](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)).
  - Native ACP: Copilot CLI (public preview), Cursor, Gemini CLI, Antigravity, Kiro, Cline, Kilo, Goose, Qwen Code, Auggie, Factory Droid, Junie, Devin, Kimi Code, Grok Build, Mistral Vibe (separate `vibe-acp` binary) and about 25 smaller ones.
  - Adapter only: Claude Code, Codex, pi and Amp (Amp's is community-maintained).
  - No ACP: Crush, Aider, Warp, Letta Code.
- **For most agents the extra cost is a profile, not a driver.** Launch commands are a solved problem. What differs per agent is what ACP doesn't standardise: steering, approval policy, session storage and credentials.
- **Steering mid-turn is fragmented across ACP extensions.** This is the biggest technical gap.
  - Extension methods: `_session/steering` (claude-agent-acp, codex-acp), `_session/steer` (Kiro), `_goose/unstable/session/steer` (Goose).
  - Antigravity steers when a second `session/prompt` arrives mid-turn.
  - Gemini CLI aborts the running turn when a second prompt arrives.
  - OpenCode and Goose reject a second prompt.
  - Native-only steering: Copilot SDK `mode:"immediate"`, Cursor SDK `run.steer()`, Codex app-server `turn/steer`, Amp `"steer": true`.
- **Terms are the main constraint on shared team runners, more than the technology:**
  - Copilot: "A Copilot seat is a license for one user".
  - OpenAI: "may not share your account credentials", and its docs say CI should use API keys.
  - Antigravity: consumer plans may not wrap `agy` in third-party apps.
  - Auggie: its license bars embedding it in commercially distributed software without permission.
  - Qwen consumer terms: "private and non-commercial use only".
  - Factory individual terms: bar "service bureau" use.
  - Kilo: seats "may not be shared or pooled".
  - Bring-your-own-key agents avoid this: Goose, Crush, Cline/Kilo/Qwen/Vibe with API keys.
- **Headless approval defaults split two ways, so ostra must always pass a policy explicitly:**
  - **Deny or read-only by default:** Claude Code, Copilot, Cursor, Gemini, Codex `exec` (read-only sandbox), Droid (read-only), Auggie, Mistral Vibe.
  - **Allow by default:** Goose (`auto`), Cline, Amp (since "Neo"), Kimi Code `-p`, OpenCode, omp.
  - **Unclear:** Antigravity's docs and changelog disagree.
- **Recommended tiers:**
  - **v1:** Claude Code, Codex, OpenCode, omp, **plus GitHub Copilot CLI and Cursor CLI**.
  - **Soon after v1:** Antigravity CLI and Gemini CLI (as one Google profile family), Kiro CLI, Cline, Kilo Code, Goose.
  - **Community adapters welcome:** Qwen Code, Amp, Factory Droid, Auggie, Junie, Devin, Mistral Vibe, Kimi Code, Grok Build, Crush (needs a native HTTP driver), and the ACP-registry long tail.
  - **Dropped:** Aider, Warp, Continue, Roo Code, iFlow, Plandex, Trae Agent, Zed, Codebuff, Forge. See [Dropped](#dropped-and-why).

---

## Adoption evidence

Stars come from [ungh.cc](https://ungh.cc) and weekly downloads from the npm and PyPI download APIs, all on 2026-11-17.
- Download counts are skewed. CI and SDK bundling inflate them; for example `@anthropic-ai/claude-agent-sdk` gets 19.5M a week. Native installers deflate them: Cursor, Kiro, Antigravity, Goose, Devin, Junie and Warp mostly install without npm.
- "n/o" means the agent was not an answer option in that survey.

| Agent | SO 2026 used | JetBrains work use | Pragmatic Eng. 2026 | Mentions (of 12 sources) | GitHub ★ | Weekly downloads |
|---|---|---|---|---|---|---|
| Claude Code | 65.5% | 39% | 71% | 12 | 156.0k | npm 18.2M |
| GitHub Copilot | 58.7% (all surfaces) | 21% † | 46% | 8 | 11.4k (CLI repo) | npm `@github/copilot` 1.74M |
| Codex | 29.5% | 16% (3% in Jan) | listed | 11 | 135.6k | npm 26.4M |
| Cursor | 25.5% (all surfaces) | 12% † | 39% | 8 | closed | CLI via curl; `@cursor/sdk` 1.51M |
| Google Antigravity | 16.0% | 6% | ~10% | 6 | 2.9k (docs-only repo) | script install only |
| Gemini CLI | n/o (Gemini Code Assist 14.6% is another product) | – | ~10% | 6 | 108.9k | npm 477k |
| OpenCode | 13.6% | 7% | ~10% | 9 | 227.3k | npm 4.0M (`opencode-ai`) + 965k (`@opencode/cli`) |
| JetBrains Junie | 12.8% ("JetBrains AI") | ~9% (AI + Junie) | – | 2 | 0.6k | npm 946 (mostly installer) |
| Windsurf / Devin | 6.5% / 2.9% | – | mentioned | 5 | – | npm `devin` 5.5k |
| Warp | 5.2% | – | – | 2 | 66.0k | – |
| Cline | 4.5% | – | mentioned | 5 | 71.7k | npm 81.6k |
| pi / omp | 4.4% ("Pi") | – | – | 2 | omp 39.3k | pi 6.37M, omp 307k, pi-acp 497k |
| Kiro (Amazon Q) | 3.9% ("Amazon Q Developer") | – | – | 4 | 4.5k (issues repo) | script install only |
| Kilo Code | 3.2% | – | – | 4 | 28.0k | npm 61k; #3 OpenRouter app by tokens today (1.21T) |
| Mistral Vibe | 3.2% | – | – | 1 | 5.4k | PyPI 216k |
| Aider | 2.1% | – | – | 6 | 50.2k | PyPI 115k |
| Augment (Auggie) | 1.2% | – | mentioned | 2 | 0.3k | npm 50k |
| Goose | n/o | – | – | 2 | 56.7k | native binary |
| Qwen Code | n/o | – | – | 1 | 30.7k | npm 150k |
| Amp | n/o | – | mentioned | 3 | closed | npm 125k (`@ampcode/cli` 100k + `@sourcegraph/amp` 25k) |
| Crush | n/o | – | – | 1 | 29.1k | npm 12k; Homebrew ~6.9k installs in 90 days |
| Grok Build (xAI) | n/o | – | – | 3 | 27.8k | npm 105k |
| Kimi Code (Moonshot) | n/o | – | – | 0 | 8.2k | npm 110k |
| Factory Droid | n/o | – | mentioned | 2 | 0.1k | npm 12.8k (SDK 62k) |
| CodeBuddy Code (Tencent) | n/o | – | – | 0 | closed | npm 163k |

† JetBrains' Copilot and Cursor figures come via secondary coverage, because the blog returned 403 to the research leg ([adtmag](https://adtmag.com), [commandlinux](https://commandlinux.com), both secondary).

**Sources counted in "Mentions":**
- Primary surveys and leaderboards:
  - [Stack Overflow 2026](https://survey.stackoverflow.co/2026/ai/data/ai-code-agent) (2026-10-06)
  - [JetBrains](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026) (Aug 2026, n>15k)
  - [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026) (2026-03-03, n=906)
  - [Terminal-Bench 4.1](https://www.tbench.ai/leaderboard) (live; **#1 is Copilot at 71.2%**, ahead of Claude Code)
  - [OpenRouter app rankings](https://openrouter.ai/rankings) (today)
  - [LogRocket power rankings](https://blog.logrocket.com/ai-dev-tool-power-rankings) (2026-10-13)
  - [Artificial Analysis](https://artificialanalysis.ai/articles/cursor-composer-2-5-coding-agent-index) (2026-05-20)
- Secondary listicles: [morphllm](https://www.morphllm.com/best-ai-coding-agents-2026), [codemyspec](https://codemyspec.com/blog/best-ai-coding-tools-2026), [Zima](https://shop.zimaspace.com/blogs/tech-ai-hub/top-10-best-cli-ai-tools-and-coding-agents-in-2026), [simeononsecurity](https://simeononsecurity.com/articles/cli-coding-agents-comparison), [alongside.team](https://www.alongside.team/blog/best-ai-coding-agent-harness-2026).

---

## Roster table

### A. Identity, distribution, auth

"L/M/W" means Linux / macOS / Windows. "W" means native Windows unless the cell says WSL.

| Agent | Vendor | License | Install | OS | Auth | Shared-runner terms (short) |
|---|---|---|---|---|---|---|
| Claude Code ([companion](agent-harnesses.md#1-claude-code)) | Anthropic | Proprietary | Bun single binary (installer, npm wrapper) | L/M/W | API key, cloud credentials, claude.ai login | Subscription only in the unmodified binary, for the user's own use; team runners need API keys |
| Codex CLI | OpenAI | Apache-2.0 | Rust binary: script, npm, brew, GitHub release | L/M/W (Windows sandbox) | API key, ChatGPT login, Business/Enterprise access tokens | Don't share credentials; "authenticate automation … with an API key" |
| OpenCode ([companion](agent-harnesses.md#2-opencode)) | Anomaly (ex-SST) | MIT | Bun binary (npm wrapper, installer) | L/M/W | Bring your own key, Copilot, OpenCode subscription | No Claude subscriptions |
| oh-my-pi ([companion](agent-harnesses.md#3-oh-my-pi-and-pi)) | Can Bölük / Stencil Labs | MIT | Bun binary, npm (Bun) | L/M/W | Bring your own key plus OAuth logins | Treat Claude as API-key only |
| **GitHub Copilot CLI** | GitHub (Microsoft) | Proprietary (may redistribute unmodified) | Script, brew, winget, npm | L/M/W | GitHub OAuth, PAT, `COPILOT_GITHUB_TOKEN`, bring your own key | One seat per user; machine accounts allowed for automation |
| **Cursor CLI** (`agent`) | Anysphere | Proprietary | curl or PowerShell installer, auto-updates | L/M/W | Browser login, `CURSOR_API_KEY` | Enterprise service accounts (no seat) |
| **Antigravity CLI** (`agy`) | Google | Closed source (no LICENSE file) | Script installer only | L/M/W | Google OAuth, Gemini Enterprise, `GEMINI_API_KEY`, ADC | **Wrapping `agy` is not supported on consumer plans**; use Enterprise or an API key |
| **Gemini CLI** | Google | Apache-2.0 | npm (Node ≥20), brew | L/M/W (Windows 11 24H2+) | Enterprise/Code Assist, API key, Vertex | Consumer and free users moved to Antigravity; paid keys still work |
| **Kiro CLI** | AWS | Proprietary (AWS IP License) | Standalone binary (script, deb, AppImage) | L/M/W 11 | Builder ID, IAM Identity Center, GitHub/Google, `KIRO_API_KEY` (paid plans) | No explicit clause found; the API key draws on subscription credits |
| **Cline CLI** | Cline | Apache-2.0 | npm (platform binary, no Node needed) | L/M/W | Cline account, `CLINE_API_KEY`, ChatGPT, bring your own key | Don't share a subscription; bring-your-own-key is fine |
| **Kilo Code CLI** | Kilo Code (Anaconda) | MIT | npm, brew, script, binaries | L/M/W | Kilo Gateway, bring your own key | Seats "may not be shared or pooled" |
| **Goose** | AAIF / Linux Foundation (founded by Block) | Apache-2.0 | Rust binary (script, brew, PowerShell) | L/M/W | Bring your own key (15+ providers), ACP providers | No vendor account involved |
| Qwen Code | Alibaba / QwenLM | Apache-2.0 | npm (Node ≥22), brew, scripts | L/M/W | Qwen subscription login, API keys, Vertex | Consumer ToS: "private and non-commercial use only" |
| Amp | Amp (spun out of Sourcegraph) | Proprietary | Script, brew, npm | L/M, W via WSL officially | `amp login`, `AMP_API_KEY` | Workspace service accounts for CI |
| Factory Droid | Factory | Proprietary (`UNLICENSED`) | Script, brew, npm, PowerShell | L/M/W | `FACTORY_API_KEY`, bring your own key | Individual terms bar "service bureau" use; service accounts exist |
| Augment Auggie | Augment Code | Proprietary | npm (Node ≥20) | L/M, W via WSL | `AUGMENT_SESSION_AUTH`, service accounts | **No embedding in commercially sold or distributed software without permission** |
| Crush | Charmbracelet | FSL-1.1-MIT | Go binary (brew, npm, winget, scoop, apt…) | L/M/W | Bring your own key, Hyper, Copilot/ChatGPT login | Check the FSL "Competing Use" clause before bundling |
| Mistral Vibe | Mistral AI | Apache-2.0 | PyPI; `vibe-acp` binary | L/M/W (some features not on Windows) | Provider API key (Le Chat login **unverified**) | **unverified** |
| Kimi Code | Moonshot AI | MIT | npm | L/M/W **unverified** | Device-code OAuth, provider keys | **unverified** |
| Grok Build | xAI | Apache-2.0 per npm (registry says proprietary) | Script installer, npm | L/M/W | `XAI_API_KEY`, browser login | **unverified** |
| JetBrains Junie CLI | JetBrains | Proprietary | Installer, npm | L/M/W (registry binaries) | Junie API key, license key, bring-your-own-key flags | **unverified** |
| Devin CLI | Cognition | Proprietary | Script, brew, Windows installer | L/M/W | **unverified** | **unverified** |

### B. Control surfaces

| Agent | Headless + JSON | ACP | Other programmatic | Steering mid-turn | Resume / storage | Headless approval default |
|---|---|---|---|---|---|---|
| Claude Code | `-p --output-format stream-json`, stream-json input | Adapter: claude-agent-acp | Agent SDK (TS/Py) | Streaming input; adapter `_session/steering` | `--resume`; `~/.claude/projects/…/<id>.jsonl` (30-day cleanup) | Deny unless approved |
| Codex CLI | `codex exec --json` (JSONL) | Adapter: codex-acp (load/resume/list/fork, permissions, `_session/steering`) | `codex app-server` (JSON-RPC, experimental), TS and Python SDKs | app-server `turn/steer`; codex-acp extension | `codex exec resume`; `$CODEX_HOME/sessions/` | `exec` runs in a read-only sandbox |
| OpenCode | `opencode run --format json`; `serve` HTTP+SSE | Native | `@opencode/client`, HTTP API | HTTP `delivery: steer\|queue`; ACP rejects a second prompt | Server SQLite; export/import | Allow all |
| omp | `--mode json`; `--mode rpc` | Native | RPC (JSONL), SDK | RPC `steer` / `follow_up` | JSONL under `~/.omp/agent/sessions` | yolo |
| **Copilot CLI** | `-p --output-format json` (JSONL; schema not published) | Native `copilot --acp` (**public preview**): load, permissions, modes | Copilot SDK (TS, Python, Go, .NET, Java, Rust) | SDK `send({mode:"immediate"})`; over ACP **unverified** | `--resume`/`--continue`; `~/.copilot/session-state/<id>/events.jsonl` + SQLite | Deny anything needing approval |
| **Cursor CLI** | `-p --output-format stream-json` | Native `agent acp` (hidden command): new, load, permissions, modes | `@cursor/sdk` (TS/Py), Cloud Agents API, self-hosted workers | SDK `run.steer()` (local only) | `--resume`, `agent ls`; path undocumented | Edits run; anything needing approval is rejected |
| **Antigravity CLI** | `-p --output-format stream-json` | Native `agy acp` (since 1.5.0): load, resume, list, close | Python SDK, remote agent/daemon | **ACP prompt during a turn steers it** | `-c`, `--conversation`; path undocumented | Docs say `default`; changelog 1.5.7 says Auto (conflict) |
| **Gemini CLI** | `-p --output-format stream-json` | Native `--acp` (`--experimental-acp` deprecated): load only | – | **None**; a new ACP prompt aborts the running one | `--resume`; `~/.gemini/tmp/<hash>/chats/`, 30-day retention | ASK becomes DENY |
| **Kiro CLI** | `chat --no-interactive --output-format stream-json` | Native `kiro-cli acp --agent-engine=v3`: load, list, fork, permissions | Cloud sessions | ACP `_session/steer` | `--resume`; SQLite in `~/.kiro/`; cloud sessions | Policy in `permissions.yaml`; `--trust-all-tools` |
| **Cline CLI** | `cline --json` (NDJSON) | Native `cline --acp`: load and permissions; no resume or list | `cline hub` daemon (WebSocket), `@cline/sdk` | SDK `queue\|steer`; not over ACP | `--id`; `~/.cline/data/` (folders + SQLite) | **Auto-approve** (non-TTY denies if turned off) |
| **Kilo Code CLI** | `kilo run --format json` | Native `kilo acp`: load, resume, list, fork, close | `kilo serve` (OpenCode-style HTTP) | Likely as OpenCode's server (**unverified**) | SQLite `kilo.db`; export/import | Headless `ask` auto-rejected; `--auto` allows |
| **Goose** | `goose run --output-format stream-json` | Native `goose acp` (main interface): load, list, close, permissions | `goose serve` (ACP over HTTP/WS), Rust GDK | ACP `_goose/unstable/session/steer` | SQLite `sessions.db`; JSON export | **`auto` (allow all)** |
| Qwen Code | `-p -o stream-json`; stream-json input (WIP) | Native `qwen --acp` (stable): load, list, resume | `qwen serve` HTTP+SSE, TS SDK (Python and Java alpha) | TUI yes; over ACP/serve **unverified** | `--resume`; `~/.qwen/projects/…` (**unverified**) | **unverified** |
| Amp | `-x --stream-json` (Claude-compatible) | Community adapter `amp-acp` | TS and Python SDKs, cloud executors | `--stream-json-input` with `"steer": true` | Threads stored on ampcode.com | **Allow all** (Neo) |
| Factory Droid | `droid exec -o stream-json\|stream-jsonrpc` | Native `exec --output-format acp`/`acp-daemon` | JSON-RPC over stdio, WebSocket daemon, TS and Python SDKs | Queued messages (editable) | `-s <id>`; local + Factory web mirror by default | Read-only; `--auto low\|medium\|high` |
| Augment Auggie | `--print --mode json` | Native `auggie --acp`: load, resume, list, close | TS and Python SDKs (spawn ACP) | **unverified** | `--resume`; `~/.augment/sessions` | Deny without a UI |
| Crush | `crush run` (**text only**) | **None** (issue open) | `crush server` HTTP+SSE (OpenAPI, no auth) | Queue only | SQLite `.crush/crush.db` in the project | Auto-approve for the session |
| Mistral Vibe | `--prompt --output json\|streaming` | Separate `vibe-acp` binary | `vibe run-server` (experimental) | **unverified** | `--resume <id>`; `VIBE_HOME` | Deny without `--auto-approve` |
| Kimi Code | `-p --output-format stream-json` | Native `kimi acp` | `kimi web` (bearer token) | **unverified** | `-S <id>`, `-c`; `~/.kimi-code` | `auto` (never ask) in `-p` |
| Grok Build | `-p --output-format streaming-json` | Native `grok agent stdio` | – | **unverified** | **unverified** | **unverified** |
| Junie CLI | `--output-format json\|json-stream` | Native `--acp=true` | – | **unverified** | `--resume`, `--session-id`, `--fork-session` | **unverified** |
| Devin CLI | `-p` (JSON **unverified**) | Native `devin acp` | Cloud CLI | **unverified** | **unverified** | **unverified** |

---

## Agents

### Tier v1 additions

#### GitHub Copilot CLI

- **Vendor and license.** GitHub (Microsoft). Proprietary "GitHub Copilot CLI License": you may redistribute it unmodified inside a larger application, but not modify it ([LICENSE.md](https://raw.githubusercontent.com/github/copilot-cli/main/LICENSE.md)).
- **Version.** npm `@github/copilot` 1.0.113 (2026-11-17). GA since 0.0.418 on 2026-02-25 ([changelog](https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md)).
- **Install.** `curl -fsSL https://gh.io/copilot-install | bash`, `brew install copilot-cli`, `winget install GitHub.Copilot`, or `npm i -g @github/copilot`. Native Windows needs PowerShell 6+ ([README](https://raw.githubusercontent.com/github/copilot-cli/main/README.md)).
- **Headless.**
  - Flags: `-p/--prompt`, `-s`, `--output-format json` (JSONL), `--no-ask-user`, `--share=PATH`, `--secret-env-vars`. A final record carries the exit status ([programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)).
  - The full JSONL event schema is **not published**.
- **ACP: native.** `copilot --acp [--stdio | --port N]`. The docs say "ACP support in GitHub Copilot CLI is in public preview and subject to change" ([acp-server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)).
  - Supported: session load, `session/request_permission`, agent and plan modes, close, config options (model, agent, allow_all), client MCP servers.
  - Limits: tool filters and reasoning effort are **fixed at server start**, so per-session policy means one process per session. The `/resume` and `/login` pickers don't work over ACP.
- **SDK.** Now the "Microsoft Copilot SDK" ([github/copilot-sdk](https://raw.githubusercontent.com/github/copilot-sdk/main/README.md), MIT, GA).
  - Languages: TS, Python, Go, .NET, Java, Rust.
  - `@microsoft/copilot-sdk` 2.0.0 (released today) runs a native Rust runtime in-process through a C ABI.
  - The older `@github/copilot-sdk` (1.69M a week) talks to the CLI over stdio or TCP.
  - The CLI's `--server`/`--headless` mode is now labelled legacy.
- **Steering.** SDK `session.send({mode:"immediate"})` steers the running turn, and `"enqueue"` queues ([node README](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/README.md)). Whether ACP accepts steering is **unverified**.
- **Resume and storage.** `--resume[=id|name]`, `--continue`, `--session-id` ([config-dir reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)).
  - Files: `~/.copilot/session-state/<id>/events.jsonl` plus plans and checkpoints, and `session-store.db`.
  - `COPILOT_HOME` moves the directory. `--sync-session` can sync to the user's GitHub account.
- **Approvals.**
  - Flags: `--allow-tool`/`--deny-tool` with filters such as `shell(git:*)` and `write(path)`, `--allow-all-tools`, `--allow-all`/`--yolo`, `--assisted-approval` (model safety review).
  - Headless default: "Without any permission options, requests that need approval are denied."
- **Auth.**
  - Token precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`. A fine-grained PAT needs the "Copilot Requests" permission. `/login` OAuth also works.
  - Bring your own key via `COPILOT_PROVIDER_*` needs no GitHub login.
  - Billing is in "GitHub AI Credits" ($0.01 each). Business is $19/user with 1,900 pooled credits ([pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)).
- **Terms.**
  - "A Copilot seat is a license for one user" ([seats](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/seats-and-billing-cycles)).
  - GitHub ToS: "a single login may not be shared by multiple people". Machine accounts are allowed when "used exclusively for performing automated tasks" ([ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)).
  - Org-billed `GITHUB_TOKEN` use exists only inside Actions ([doc](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions)).
  - A licence-compliance question for third-party automation has been open since Dec 2025 ([discussion #727](https://github.com/github/copilot-cli/discussions/727)).
- **OS.** Linux, macOS, native Windows.
- **For ostra.**
  - Personal runners use the teammate's own token.
  - Team runners need a machine account with its own seat, or bring-your-own-key. Whether a machine account needs its own Copilot seat is **unverified**.
  - Use ACP, with one process per session so tool policy can differ per task.

#### Cursor CLI (`agent`, formerly `cursor-agent`)

- **Vendor and license.** Anysphere. Proprietary, no public repo. Latest changelog entry is v2026.10.22 ([changelog](https://cursor.com/docs/cli/changelog.md)); the ACP registry pins 2026.11.13.
- **Install.** `curl https://cursor.com/install -fsS | bash`. Native Windows: `irm 'https://cursor.com/install?win32=true' | iex`. **It auto-updates** ([install](https://cursor.com/docs/cli/installation.md)).
- **Headless.** `-p/--print --output-format text|json|stream-json [--stream-partial-output]` ([output-format](https://cursor.com/docs/cli/reference/output-format.md)).
  - NDJSON events: `system/init` (includes `permissionMode`), `user`, `assistant`, `tool_call` started/completed, `result`.
  - On failure there may be no terminal event.
  - No streaming stdin mode.
- **ACP: native.** `agent acp` is an "advanced, hidden command" ([acp](https://cursor.com/docs/cli/acp.md)).
  - Supported: `session/new`, `session/load`, `session/request_permission` (allow-once / allow-always / reject-once), `session/cancel`, modes agent/plan/ask.
  - Extensions: `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`.
  - Team MCP servers are not available over ACP.
- **Other interfaces** ([TS SDK](https://cursor.com/docs/sdk/typescript.md)).
  - `@cursor/sdk` 1.4.1 (proprietary, 1.5M a week) and Python `cursor-sdk`, with local or cloud runtimes.
  - "The default local agent runs tool calls … without asking for approval."
  - Also: a Cloud Agents REST API and `agent worker start` for self-hosted workers. Both overlap with ostra's runner.
- **Steering.** SDK `run.steer(text)`, local runs only. No steering over ACP is documented.
- **Resume and storage.** `--resume [chatId]`, `--continue`, `agent ls`, `agent resume`, `create-chat`.
  - The storage path is **undocumented**.
  - Secondary (staff forum post): `~/.cursor/chats/<workspace-hash>/<chat-uuid>/store.db`, with ACP sessions under `~/.cursor/acp-sessions/` ([forum](https://forum.cursor.com/t/local-ide-agent-chats-and-the-agent-cli-still-use-separate-session-stores/165486)).
- **Approvals** ([headless](https://cursor.com/docs/cli/headless.md)).
  - Config: `~/.cursor/cli-config.json` or `<proj>/.cursor/cli.json`, with `permissions.allow/deny` tokens such as `Shell(git)`, `Write()`, `Mcp()`. `approvalMode` is `allowlist|auto-review|unrestricted`.
  - Print-mode default: workspace edits run, and anything needing approval is rejected. `--force`/`--yolo` allows all.
  - **Admins can "Disable CLI headless mode."**
- **Auth.** `agent login` or `CURSOR_API_KEY`/`--api-key`. Enterprise service accounts "do not consume a seat license" ([service accounts](https://cursor.com/docs/account/enterprise/service-accounts.md)).
- **Terms.** ToS updated 2026-09-03: the user is responsible for "all activities that occur under your account"; renting, leasing or reselling is forbidden; there is no explicit seat-sharing clause ([ToS](https://cursor.com/terms-of-service)).
- **OS.** Linux, macOS, native Windows.
- **For ostra.**
  - Drive it through ACP.
  - Pin the version and stop auto-updates on runners (how is **unverified**).
  - Session archive/restore needs a spike, because the store path is undocumented.

### Confirmed v1: Codex CLI (filling gaps in the companion doc)

- **Vendor and license.** OpenAI, Apache-2.0 ([repo](https://github.com/openai/codex)). npm `@openai/codex` 0.169.0; GitHub release `rust-v0.169.0` on 2026-11-13.
  - Docs moved: developers.openai.com/codex/* now redirects (308) to learn.chatgpt.com/docs/*.
- **Install.** `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, `irm https://chatgpt.com/codex/install.ps1 | iex`, npm, `brew install --cask codex`, or GitHub release binaries (Rust).
- **Headless.** `codex exec --json` writes JSONL: `thread.started`, `turn.started|completed|failed`, `item.*`, `error`.
  - Also: `-o/--output-last-message`, `--output-schema`, `--ephemeral`.
  - `exec` is marked Stable ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- **ACP: adapter.** `npx @agentclientprotocol/codex-acp` (2.7.0, Apache-2.0) is **now TypeScript and wraps `codex app-server`** (`CodexAppServerClient.ts`) ([repo](https://github.com/agentclientprotocol/codex-acp)).
  - Advertises `loadSession` and session resume/list/close/fork/delete.
  - Sends permission requests.
  - Steering via `_session/steering`.
  - `INITIAL_AGENT_MODE` takes `read-only|workspace-write|agent|agent-full-access`.
- **app-server** is still labelled **Experimental** ([app-server](https://learn.chatgpt.com/docs/app-server)).
  - Transports: `--listen stdio://|ws://IP:PORT|unix://PATH`. Non-loopback WebSocket "allow[s] unauthenticated connections by default".
  - Methods: `thread/resume|fork|list`, `turn/steer`, `turn/interrupt`.
  - Approvals: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
- **SDKs.** TS `@openai/codex-sdk` (2.4M a week) and Python `openai-codex` ([codex-sdk](https://learn.chatgpt.com/docs/codex-sdk)).
- **Storage.**
  - Docs say only "local state under `CODEX_HOME` (defaults to `~/.codex`)" ([config-advanced](https://learn.chatgpt.com/docs/config-file/config-advanced)).
  - Source defines `sessions` and `archived_sessions` subdirectories ([rollout/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs)).
  - The `YYYY/MM/DD/rollout-*.jsonl` layout comes from GitHub issues (secondary).
- **Approvals (changed in 2026).**
  - "By default, `codex exec` runs in a read-only sandbox."
  - **`--full-auto` is no longer supported**; use `--sandbox workspace-write`, or the new `--approve-for-me` (automatic approval review).
  - `-a/--ask-for-approval` now takes only `on-request|never`.
  - `--dangerously-bypass-approvals-and-sandbox`/`--yolo` is for "an externally hardened environment".
  - In 0.169, `exec` skips project config and MCP in untrusted directories unless `--trust` is passed.
  - The app-server's default policy is **unverified**.
- **Auth and terms.**
  - Methods: ChatGPT sign-in (subscription), API key (usage-based), `CODEX_API_KEY` for `exec`, and `codex login --device-auth` (beta). Credentials live in `~/.codex/auth.json` or the OS keyring ([auth](https://learn.chatgpt.com/docs/auth)).
  - **New: Codex access tokens** (`CODEX_ACCESS_TOKEN`), for ChatGPT Business and Enterprise only. "Each token belongs to its creator"; "shared machines can expose tokens" ([access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)).
  - CI guidance ([ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)):
    - "The right way to authenticate automation is with an API key."
    - "Do not share the same file across concurrent jobs or multiple machines."
  - OpenAI ToU: "You may not share your account credentials or make your account available to anyone else" ([ToU](https://openai.com/policies/row-terms-of-use/)).
  - **Net for ostra:** a ChatGPT login is OK on a personal runner. Team runners use an API key, or a per-user access token on Business/Enterprise.
- **OS.** Linux, macOS, and native Windows: it "can run natively in PowerShell with a Windows sandbox" ([windows-sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)).
- **Corrections to agent-harnesses.md:**
  - codex-acp now supports steering and full session capabilities.
  - `--full-auto` was removed.
  - Gemini's ACP flag is now `--acp`.

### Soon after v1

#### Google Antigravity CLI (`agy`)

- **Vendor and license.** Google. **Closed source.** The repo [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli) holds only a README, changelog, examples and issue templates, with no LICENSE file.
- **Version.** CHANGELOG top entry 1.5.10 (undated); latest GitHub release 1.5.2 (2026-11-06); the registry pins 1.5.0.
- **Install.** Script only: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or PowerShell/CMD scripts. Installs to `~/.local/bin/agy`. No npm or brew ([getting started](https://antigravity.google/docs/getting-started?tab=cli)).
- **Headless** ([headless](https://antigravity.google/docs/cli/headless/)).
  - Flags: `-p`, `--output-format text|json|stream-json` (events `init`, `step_update`, `result`), `--json-schema`, `--print-timeout`, `--conversation <id>`, `-c`.
  - "Any tool action that requires approval it can't obtain in headless mode is soft-denied", and the run still exits 0.
- **ACP: native.** `agy acp` since 1.5.0, with no stability label ([ACP docs](https://antigravity.google/docs/ide/extensions/acp/)).
  - "The server supports loading, resuming, listing, and closing sessions." Resume skips history replay.
  - Permissions: Allow/Deny.
  - Flags: `--sandbox`, `--process-per-session`, `--dangerously-skip-permissions`.
  - **"Sending a prompt while a turn runs steers that turn."**
  - The registry launches a separate `agy_acp_server.par` binary.
- **Other interfaces.** `--remote-agent`, a Remote Control daemon, and a Python Antigravity SDK ([reference](https://antigravity.google/docs/cli/reference/)).
- **Sessions.** Scoped to the cwd.
  - Settings: `~/.gemini/antigravity-cli/settings.json`.
  - The conversation store path is **unverified** (only secondary sources and issue #602).
- **Approvals.**
  - Modes: `default|auto|accept-edits|plan`. The docs say the startup mode is `default`, but CHANGELOG 1.5.7 says "default Agent Mode is Auto, including for headless `-p`" (**conflict**).
  - Auto needs the OS sandbox; on Windows that means 11 24H2+ ([modes](https://antigravity.google/docs/cli/modes/)).
- **Auth.** Google OAuth (keyring), Gemini Enterprise/GCP, `GEMINI_API_KEY` ("intended for headless and CI runs"), ADC via `AGY_ADC_AUTH=true` ([install](https://antigravity.google/docs/install/)).
- **Terms (critical).** I confirmed the FAQ wording myself.
  - [Terms §6](https://antigravity.google/terms): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."
  - [FAQ](https://antigravity.google/docs/faq): "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans". It recommends "a Gemini Enterprise or Google AI Studio API key".
- **OS.** Linux, macOS, native Windows.
- **Why soon after, not v1.**
  - Technically it is the cheapest of all (native ACP with steering and resume).
  - But ostra can only offer it with Enterprise or API-key auth, which excludes the consumer users behind most of its 16%.
  - It is closed source, and its ACP mode is weeks old.

#### Google Gemini CLI

- **Status.** Still maintained: v0.68.0 (2026-11-10), Apache-2.0, 108.9k★.
  - README: "Free individual access and Google AI Pro / Ultra (Google One) moved to Antigravity CLI on June 18, 2026"; "Enterprise Code Assist only".
  - Paid Gemini API keys and Agent Platform keys keep working ([Google blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli)).
  - It "has not been optimized for Gemini 4 Argon" ([cli-reference](https://geminicli.com/docs/cli/cli-reference/)).
- **Install.** npm `@google/gemini-cli` (Node ≥20), npx, brew, MacPorts, conda.
- **Headless.** `-p --output-format text|json|stream-json`. Events: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`. Exit codes 0/1/42/53 ([headless](https://geminicli.com/docs/cli/headless/)).
- **ACP: native.** `gemini --acp`; `--experimental-acp` is "deprecated, use --acp instead" (`packages/cli/src/config/config.ts`). The cli-reference page is stale.
  - `initialize` advertises `loadSession: true` and **no `sessionCapabilities`**, so there is no list or resume.
  - Also: `setSessionMode`, `unstable_setSessionModel`, `requestPermission`.
  - **A new prompt aborts the running one** (`pendingPrompt?.abort()` in `acpSession.ts`).
- **Steering.** None; ostra must queue.
- **Sessions.** `~/.gemini/tmp/<project_hash>/chats/`; `--resume [latest|index|UUID]`, `--list-sessions`. **Retention defaults to 30 days** ([session-management](https://geminicli.com/docs/cli/session-management/)).
- **Approvals.** `--approval-mode default|auto_edit|yolo|plan`. Headless turns ASK_USER into DENY. Untrusted folders are forced to `default`.
- **Auth and terms.**
  - Auth: Google OAuth, `GEMINI_API_KEY`, Vertex (ADC or service account).
  - Terms: "Directly accessing the services powering Gemini CLI … using third-party software … is a violation" ([tos-privacy](https://geminicli.com/docs/resources/tos-privacy/)). That covers calling the backend directly, not launching the CLI.
- **OS.** macOS 15+, Windows 11 24H2+, Ubuntu 20.04+ ([installation](https://geminicli.com/docs/get-started/installation/)).
- **Why soon after.**
  - Near-zero cost through ACP, and it is the reference ACP implementation.
  - But its user base is shrinking to enterprise and API-key users.
  - Ship it in the same Google profile family as Antigravity.

#### Kiro CLI (AWS)

- **History and license.** It replaces Amazon Q Developer CLI: "now available as Kiro CLI, a closed-source product". The old Apache-2.0 repo gets "only… critical security fixes" ([Q CLI repo](https://github.com/aws/amazon-q-developer-cli)). Kiro is proprietary, "AWS Content" under the AWS IP License ([license](https://kiro.dev/license/)).
- **Version.** 3.4.0 (2026-11-16, [changelog](https://kiro.dev/changelog/)). The registry still pins 3.0.0.
  - 3.0 made it a standalone binary with the V3 engine and a new session store.
  - **V2 cannot open V3 sessions.**
- **Install.** `curl -fsSL https://cli.kiro.dev/install | bash`, or .deb, AppImage, musl builds; on Windows 11, `irm 'https://cli.kiro.dev/install.ps1' | iex` ([install](https://kiro.dev/docs/cli/installation)). **The ACP registry has no Windows binary.**
- **Headless.** `kiro-cli chat --no-interactive [--trust-all-tools | --trust-tools=<ids>] --output-format stream-json --v3` ([headless](https://kiro.dev/docs/cli/headless/)).
  - Also: `--sandbox`, `--require-mcp-startup`.
  - Event types are **undocumented**.
  - Headless defaults to V3 only with `--trust-all-tools`.
- **ACP: native.** `kiro-cli acp [--agent X] --agent-engine=v3` ([ACP migration](https://kiro.dev/docs/cli/v3/acp-migration/)).
  - Methods: new, list, load, fork, prompt, cancel, set_mode, set_config_option, `request_permission`. Advertises `loadSession`; `session/resume` is **unverified**.
  - **Steering:** "`session/prompt` for an idle session; `_session/steer` during an active turn", with `steering_queued|injected|cleared` updates.
  - `--auth-method=client` delegates the token to the ACP client.
- **Sessions.** "SQLite database in `~/.kiro/`", per directory ([session management](https://kiro.dev/docs/cli/chat/session-management/)).
  - Commands: `--resume`, `--resume-id`, `--list-sessions`; `/chat save` writes a zip.
  - **`--cloud` sessions can be resumed "from any machine".**
  - ACP clients are told: "Do not write Kiro session files directly or depend on the CLI V3 directory layout."
- **Approvals.** V3 uses capability-based `permissions.yaml`. "Headless runs deny the call" for disallowed sub-agent tools ([v3](https://kiro.dev/docs/cli/v3/)). The main agent's default with no trust flag is **unverified**.
- **Auth and terms** ([auth](https://kiro.dev/docs/getting-started/authentication/)).
  - Logins: GitHub, Google, Builder ID, IAM Identity Center, external IdP, with a device flow over SSH.
  - `KIRO_API_KEY` (`ksk_…`) is "only available for Kiro Pro, Pro+, Pro Max, and Power subscribers", and its credits come out of that subscription.
  - No explicit shared-server clause was found. An AWS blog runs a team Slack bot on one key ([AWS blog](https://aws.amazon.com/blogs/devops/building-a-slack-powered-ai-development-agent-with-kiro-cli-and-headless-authentication)).
- **OS.** macOS, Linux (glibc 2.34+ or musl), native Windows 11.
- **Why soon after.**
  - The AWS/enterprise audience, and Amazon Q has 3.9% on SO.
  - Native ACP with documented steering, load and fork.
  - Cloud sessions might give cross-machine resume for free.

#### Cline CLI

- **License and version.** Apache-2.0 ([repo](https://github.com/cline/cline), 71.7k★). npm `cline` 3.0.74 (2026-10-26) ships a platform binary, so no Node is needed. `@cline/sdk` 0.2.0.
- **Headless.**
  - One-shot `cline "…"`.
  - `--json` emits NDJSON:
    - `agent_event` with subtypes `content_start|update|end`, `iteration_*`, `usage`, `notice`, `done`, `error`
    - `hook_event`, `team_event`, `run_result`, `run_aborted`
  - Sources: [CLI README](https://github.com/cline/cline/blob/main/apps/cli/README.md), [cli-reference](https://docs.cline.bot/cli/cli-reference.md).
- **ACP: native.** `cline --acp` ([acpAgent.ts](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts)).
  - Advertises `loadSession` and images, plus cancel, set mode, set config option, `unstable_setSessionModel`.
  - Permission options: `allow_once|allow_always|reject_once`.
  - **No resume or list.**
- **Other interfaces.**
  - `cline hub`: a local WebSocket daemon on port 8787, with `ROOM_SECRET` for LAN use.
  - The `ClineCore` SDK has `start/send/abort/restore/list` ([cline-core](https://docs.cline.bot/sdk/reference/cline-core.md)).
  - The old instances/gRPC model is gone.
- **Steering.** The core has `PendingPromptDelivery = "queue" | "steer"` ([source](https://github.com/cline/cline/blob/main/sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts)). It is **not exposed over ACP**.
- **Sessions.** `--id <session-id>`; `cline history` can export. Storage: `~/.cline/data/sessions/` plus `data/db/sessions.db`.
- **Approvals.** "Tool calls are auto-approved by default." `--auto-approve false` turns prompts on, and when there is no TTY, "required-approval calls are denied".
- **Auth and terms.** Cline account (OAuth or `CLINE_API_KEY`), ChatGPT subscription, or bring your own key for 30+ providers. ToS: "will not allow or enable anyone else to use your Subscription" ([tos](https://cline.bot/tos)).
- **OS.** Native macOS, Linux and Windows (x64 and arm64).
- **Why soon after.** 4.5% on SO and 71.7k★, Apache-2.0, native ACP, works with bring-your-own-key. ostra has to override its auto-approve default.

#### Kilo Code CLI

- **What it is.** "Kilo CLI is a fork of OpenCode" (`.opencode-version` reads v1.18.26), moving to the OpenCode V2 rewrite ([repo](https://github.com/Kilo-Org/kilocode), MIT, 28k★).
- **Ownership.** Anaconda acquired Kilo Code (announced 2026-07-15), and claims "more than 3 million developers" ([press](https://www.anaconda.com/press/anaconda-acquires-kilo-code)).
- **Version.** `@kilocode/cli` 7.8.27 (2026-11-05).
- **Install.** npm/pnpm/bun, `curl -fsSL https://kilo.ai/cli/install | bash`, `brew install Kilo-Org/tap/kilo`, or release binaries.
- **Headless.** `kilo run --format json [--auto] [-s <id> | -c] [--fork] [--attach http://localhost:4096]`. Events: `step_start`, `text`, `reasoning`, `tool_use`, `step_finish`, `error` ([cli-reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference)).
- **ACP: native.** `kilo acp`. Advertises `loadSession`, close/fork/list/resume, images, embedded context, and HTTP/SSE MCP.
- **Server.** `kilo serve` exposes the OpenCode-style HTTP API, with basic auth via `KILO_SERVER_PASSWORD`. Steering over this API is presumably the same as OpenCode's (**unverified**).
- **Sessions.** SQLite at `$XDG_DATA_HOME/kilo/kilo.db`. `kilo export`/`kilo import` use JSON, and import can also read Claude and Codex sessions.
- **Approvals.** `permission` rules with allow/ask/deny. `--auto` "auto-approves permissions that are not explicitly denied". Without it, headless `ask` prompts are auto-rejected.
- **Auth and terms.** Kilo Gateway account or bring your own key; `KILO_ORG_ID` selects an organization. ToS: "each seat is assigned to a single named Authorized User and may not be shared or pooled" ([terms](https://kilo.ai/terms), 2026-11-02).
- **OS.** Native Windows (x64, arm64), macOS, Linux (glibc, musl).
- **Why soon after.**
  - 3.2% on SO, and #3 OpenRouter app by tokens.
  - It is nearly free: the OpenCode ACP profile, and later the OpenCode HTTP driver, mostly carry over.

#### Goose

- **Governance and license.** The repo moved to **[aaif-goose/goose](https://github.com/aaif-goose/goose)**. It was "founded by Block and now stewarded by AAIF", "a Series of LF Projects, LLC" ([GOVERNANCE.md](https://raw.githubusercontent.com/aaif-goose/goose/main/GOVERNANCE.md)). Apache-2.0, 56.7k★.
- **Version.** v1.59.2 (2026-11-16), with roughly weekly releases.
- **Install.** Native Rust binary via the `download_cli.sh` script, `brew install block-goose-cli`, or `download_cli.ps1` ([install](https://goose-docs.ai/docs/getting-started/installation)).
- **Headless.**
  - `goose run -t "<text>"` or `-i <file|->`, with `--output-format text|json|stream-json`.
  - Stream events: `message`, `notification`, `error`, `complete` (with tokens and `cost_usd`).
  - Also: `--max-turns`, `--recipe`, `-r --session-id` ([session/mod.rs](https://raw.githubusercontent.com/aaif-goose/goose/main/crates/goose-cli/src/session/mod.rs)).
- **ACP: native, and since the "goose 2.0" plan its main interface** ([blog](https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui)).
  - `goose acp` advertises `loadSession` and session list/delete/close. Resume and fork are not advertised.
  - Permission requests go through `request_permission`, and modes are set with `set_mode` ([server.rs](https://raw.githubusercontent.com/aaif-goose/goose/main/crates/goose/src/acp/server.rs)).
  - About 100 `_goose/unstable/*` extension methods.
- **Other interfaces.**
  - **`goose serve` serves ACP over HTTP/WebSocket** at `127.0.0.1:3284/acp`, secured with `GOOSE_SERVER__SECRET_KEY` ([gdk/acp](https://goose-docs.ai/docs/gdk/acp/)).
  - The old `goosed` REST server has been removed.
  - Rust GDK crates, with Python and Kotlin bindings.
- **Steering.** `_goose/unstable/session/steer` "Add[s] user input to the currently active prompt". A second `session/prompt` is rejected.
- **Sessions.** SQLite `~/.local/share/goose/sessions/sessions.db`; `GOOSE_PATH_ROOT` overrides it. `goose session --resume [--fork]`, `session export --format json` ([commands](https://goose-docs.ai/docs/guides/goose-cli-commands)).
- **Approvals.** `GOOSE_MODE=auto|approve|smart_approve|chat`, **default `auto`** ([env vars](https://goose-docs.ai/docs/guides/environment-variables)). A non-interactive `goose run` in `approve` mode cancels with an error, so remote approvals need ACP.
- **Auth.** Bring your own key (15+ providers). It can itself drive Claude, Codex, Amp and pi through ACP providers ([acp-providers](https://goose-docs.ai/docs/guides/acp-providers)). Set `GOOSE_DISABLE_KEYRING=1` for headless use.
- **OS.** Linux, macOS, and native Windows ("We recommend running the goose CLI natively on Windows").
- **Why soon after.**
  - Zero driver cost.
  - Neutral Linux Foundation governance, and no vendor account terms, which suits team runners.
  - Survey adoption is lower than the others in this tier (it wasn't an SO option).

### Community adapters welcome

#### Qwen Code

- **Vendor, license, version.** Alibaba/QwenLM, Apache-2.0 ([repo](https://github.com/QwenLM/qwen-code), 30.7k★). `@qwen-code/qwen-code` 0.28.0 (2026-11-17, Node ≥22). It is a Gemini CLI fork.
- **Install.** Curl or PowerShell script, npm, `brew install qwen-code`.
- **Headless** ([headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless)).
  - Flags: `-p -o text|json|stream-json`, `--include-partial-messages`, `--continue`, `--resume [id]`.
  - `--input-format stream-json` is "under construction".
- **ACP: native.** `qwen --acp`, "Stable". Advertises `loadSession` and session list/resume.
- **Other interfaces.**
  - **`qwen serve`** (experimental): an HTTP+SSE daemon on `127.0.0.1:4170` with a bearer token.
  - Routes: `/session/:id/prompt|load|resume|cancel`, `/events`, and permission replies with first-responder, designated or consensus policies ([serve protocol](https://qwenlm.github.io/qwen-code-docs/en/developers/qwen-serve-protocol)).
  - SDKs: TS `@qwen-code/sdk` (`canUseTool`, `interrupt()`); Python and Java are alpha.
- **Steering.** Yes in the TUI. Over ACP or serve it is **unverified**.
- **Sessions.** Worktree-aware (`--worktree`). The path `~/.qwen/projects/<proj>/chats/<id>.jsonl` comes from secondary sources.
- **Approvals.** `--approval-mode plan|default|auto-edit|auto|yolo`. The headless default is **unverified**.
- **Auth and terms.**
  - **The free Qwen OAuth tier closed on 2026-04-15.** Login now means a paid Qwen subscription; API keys, ModelStudio and Vertex also work.
  - Consumer terms ([qwen.ai/termsservice](https://qwen.ai/termsservice)): "You shall not share your account credentials"; "The Services are for private and non-commercial use only".
- **OS.** Linux, macOS, native Windows.
- **Why community.** Moderate adoption: 150k npm a week, but only one comparison mention. ACP support is cheap. A team would use API keys rather than consumer logins.

#### Amp

- **Vendor and license.** Amp, spun out of Sourcegraph in Dec 2025 ([Tessl](https://tessl.io/blog/sourcegraph-spins-out-ai-coding-agent-amp-as-a-standalone-company/), secondary). Proprietary.
- **Packages.** npm `@ampcode/cli` (also still published as `@sourcegraph/amp`), with continuous releases.
- **Install.** `curl -fsSL https://ampcode.com/install.sh | bash`, PowerShell `install.ps1`, or brew ([CLI](https://ampcode.com/docs/markdown/cli)).
- **Headless.** `amp -x "…" --stream-json [--stream-json-thinking]`. The output is **Claude-Code-compatible**: `system/init`, `user`, `assistant` (with `tool_use`), `result` ([streaming-json](https://ampcode.com/docs/markdown/cli/streaming-json)).
- **Steering.** `--stream-json-input` takes several user messages. Messages sent while busy are queued, and `"steer": true` delivers one "at the next interruption point".
- **ACP.** None native. Community adapter [amp-acp](https://github.com/tao12345666333/amp-acp) (Apache-2.0, 0.13.0, 106★, in the registry) supports sessions, a queue, cancel-then-prompt steering, and load/resume.
- **SDK.** TS `@ampcode/sdk` and Python `amp-sdk`. They wrap the CLI, support `continue: 'T-…'`, and offer cloud "orb" or runner executors ([SDK](https://ampcode.com/docs/markdown/sdk)).
- **Sessions.** Threads live on ampcode.com (`T-…`). `amp threads continue`, `amp threads export` ([threads](https://ampcode.com/docs/markdown/threads)).
- **Approvals.** Since "Neo" (May 2026), "What was once the `--dangerously-allow-all` flag is now the default". Approval is now a plugin `tool.call` hook ([neo](https://ampcode.com/news/neo), [plugins](https://ampcode.com/docs/markdown/customize/plugins)).
- **Auth and terms.** `amp login` or `AMP_API_KEY`. Workspace service accounts need Enterprise, or Team with a payment method ([workspaces](https://ampcode.com/docs/markdown/collaborate/workspaces)). License is "to access and use Amp … as a User" ([terms](https://ampcode.com/terms)).
- **OS.** "macOS, Linux, and Windows through WSL", although a `win32-x64` binary exists.
- **Why community.**
  - Proprietary, with a cloud-held thread store, and approvals only through plugins.
  - Amp's own "runners" compete with ostra's.
  - Cheapest route: a native driver reusing ostra's Claude stream-json parser, or amp-acp.

#### Factory Droid

- **License and versions.** Proprietary (`UNLICENSED`). npm `droid` 1.13.0 (2026-11-17). Apache-2.0 SDKs `@factory/droid-sdk` (TS) and `droid-sdk` (Python).
- **Install.** `curl -fsSL https://app.factory.ai/cli | sh`, `brew install --cask droid`, npm, or PowerShell ([quickstart](https://docs.factory.com/droid-cli/quickstart.md)). Requires glibc.
- **Headless** ([droid exec](https://docs.factory.com/droid-exec/overview.md)).
  - `droid exec -o text|json|stream-json|stream-jsonrpc|acp`.
  - Multi-turn uses `--input-format stream-jsonrpc`, with methods `droid.add_user_message`, `droid.interrupt_session`, `droid.fork_session`, `droid.request_permission`, and others.
- **ACP: native.** The docs give `--output-format acp`; the registry uses `acp-daemon`. The docs say "Zed does not restore past Factory Droid sessions", so `loadSession` is doubtful.
- **Other interfaces.** A `droid daemon` WebSocket JSON-RPC server (several sessions per connection, and sessions survive the client detaching), plus a REST Sessions API ([SDK ref](https://github.com/Factory-AI/droid-sdk-typescript/blob/main/docs/typescript-sdk-reference.md)).
- **Steering.** Messages sent mid-turn are queued and editable; "A session can run one turn at a time".
- **Sessions.** `-s/--session-id`, `--fork`.
  - **`cloudSessionSync` defaults to true** ("Mirror CLI sessions to Factory web") ([settings](https://docs.factory.com/droid-cli/settings)).
  - The local path `~/.factory/sessions/…` comes from secondary sources.
- **Approvals.** Read-only by default; `--auto low|medium|high`; `--skip-permissions-unsafe`.
- **Auth and terms.**
  - `FACTORY_API_KEY`, or bring your own key on the free plan.
  - Service accounts exist ([service accounts](https://docs.factory.com/enterprise/service-accounts)).
  - Individual terms bar use "for timesharing or service bureau purposes" ([terms](https://factory.com/legal/terms-individual)).
- **OS.** macOS, Linux, native Windows.
- **Why community.** Weak adoption signals: 12.8k npm a week, 95★, absent from SO. Its rich protocol makes a later native driver easy if demand appears.

#### Augment Auggie

- **License.** Proprietary ([LICENSE.md](https://github.com/augmentcode/auggie/blob/main/LICENSE.md)):
  - "Subject to maintaining an active subscription"
  - "Internal scripting and automation are permitted"
  - "may not be embed or integrate… into commercially sold or distributed software or services without explicit permission"
- **Version.** `@augmentcode/auggie` 1.2.1 (2026-11-13; the docs still call 1.x a prerelease). Node ≥20.
- **Headless.** `auggie --print --mode text|stream|json`; 1.x replaced `--quiet`/`--output-format` ([reference](https://docs.augmentcode.com/cli/reference.md)). Non-interactive mode "may be disabled if it is not included in your agreement (enterprise)".
- **ACP: native.** `auggie --acp`. 1.2.1 advertises `loadSession` and session resume/close/list/additionalDirectories. "Not all features … are supported in ACP mode."
- **SDK.** `@augmentcode/auggie-sdk` (TS) launches Auggie in ACP mode; there is also a Python SDK ([sdk](https://docs.augmentcode.com/cli/sdk-typescript.md)).
- **Steering.** **Unverified** over ACP.
- **Sessions.** `-c`, `-r`, `--session-dir`; `/export` and `/import` JSONL; `~/.augment/sessions`.
- **Approvals.** Rules `allow|deny|ask-user|webhook-policy|script-policy`. "Without an interactive UI, the call is denied" ([permissions](https://docs.augmentcode.com/cli/permissions.md)).
- **Auth and terms.**
  - `AUGMENT_SESSION_AUTH`. Service accounts on Team and Enterprise plans ([service accounts](https://docs.augmentcode.com/cli/automation/service-accounts.md)).
  - ToS: credentials "cannot be shared or used by more than one individual" ([terms](https://www.augmentcode.com/legal/professional-terms-of-service)).
- **OS.** "MacOS, Windows WSL, Linux".
- **Why community.** 1.2% on SO, and the licence makes ostra bundling or auto-installing it questionable. Users can still point ostra at their own install.

#### Crush

- **License and version.** Charmbracelet, **FSL-1.1-MIT**: anything except "Competing Use", and each version becomes MIT after two years ([LICENSE](https://raw.githubusercontent.com/charmbracelet/crush/main/LICENSE.md)). v0.101.0 (2026-11-12), weekly releases, 29.1k★.
- **Install.** Go binary via brew, npm `@charmland/crush`, winget, scoop, apt/yum, nix.
- **Headless.**
  - `crush run [prompt]` with `-q`, `-m`, `-s <id>`, `-C`.
  - **Plain text only**, no JSON.
  - Non-interactive runs auto-approve for the session ([run.go](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/run.go)).
- **ACP.** **None.** [Issue #990](https://github.com/charmbracelet/crush/issues/990) is open, and a draft PR exists.
- **Server.** `crush server` serves an OpenAPI 3.1 HTTP API over a unix socket or Windows named pipe (TCP optional) ([endpoints.go](https://raw.githubusercontent.com/charmbracelet/crush/main/internal/server/endpoints.go)).
  - Endpoints: agent run (202, detached), `/events` SSE, cancel, prompt queue, permission grant/mode, questions.
  - **No authentication was visible in the code.**
- **Sessions.** Per-project SQLite `.crush/crush.db`; `crush session list --json`.
- **Approvals.** Asks by default. `-y`/`-yy`, and crushrc `permissions allow|deny|…`.
- **Auth.** Bring your own key, Charm Hyper, or `crush login copilot|openai|grok` (not Anthropic). Telemetry is on by default (`CRUSH_DISABLE_METRICS=1`).
- **OS.** macOS, Linux, native Windows, BSD.
- **Why community.** No ACP, and the HTTP API is unauthenticated, so it needs a native driver; that is the highest cost here. Revisit when ACP lands.

#### Mistral Vibe

- **Vendor, license, version.** Mistral AI, Apache-2.0 ([repo](https://github.com/mistralai/mistral-vibe), 5.4k★). PyPI `mistral-vibe` 3.1.2 (2026-11-10); 216k downloads a week.
- **Headless** ([programmatic-mode](https://github.com/mistralai/mistral-vibe/blob/main/docs/programmatic-mode.md)).
  - Flags: `--prompt` (or `-p` from stdin), `--output text|json|streaming` (NDJSON), `--max-turns`, `--max-price`, `--enabled-tools`/`--disabled-tools`, `--system-prompt-file`.
  - `--output-dir` writes `export.json` (usage, cost, stop reason, session_id) plus the session journal.
- **ACP.** A separate first-party `vibe-acp` binary, per the registry.
- **Approvals.** "A tool call that would need approval is denied" unless `--auto-approve`/`--yolo` is passed. The default agent is `accept-edits`.
- **Sessions.** `--resume SESSION_ID`, `--continue`, under `VIBE_HOME`.
- **Other interfaces.** `vibe run-server` and `--agent-socket` (experimental, not on Windows).
- **Auth and terms.** **Unverified.** Provider keys via `api_key_env_var`.
- **Why community.** 3.2% on SO, but a small footprint otherwise. The ACP path is cheap.

#### Kimi Code (Moonshot AI)

- **Vendor, license, version.** Moonshot AI, MIT ([repo](https://github.com/MoonshotAI/kimi-code), 8.2k★). `@moonshot-ai/kimi-code` 2.6.3 (2026-11-17); 110k npm a week. It replaces the archived Python `kimi-cli`.
- **Headless.** `-p --output-format stream-json` ([kimi command](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html)).
  - **Non-interactive mode defaults to `auto` (never ask).**
  - `--prompt` cannot be combined with `--yolo`, `--auto` or `--plan`.
- **ACP.** Native `kimi acp`.
- **Sessions.** `-S <id>`, `-c`, `kimi export`. Home is `~/.kimi-code`.
- **Server.** `kimi web` uses a bearer token; `--dangerous-bypass-auth` exists.
- **Auth.** `kimi login` (device-code OAuth), provider keys. Terms **unverified**.
- **Why community.** Mainly Chinese-market traction, with no comparison mentions found.

#### Grok Build (xAI)

- **License and version.** npm `@xai-official/grok` 1.0.88 (2026-11-16), Apache-2.0 on npm; the ACP registry says proprietary. Repo [xai-org/grok-build](https://github.com/xai-org/grok-build) has 27.8k★, but its last push was 2026-09-29, so it may be a snapshot (**unverified**).
- **Install.** `curl -fsSL https://x.ai/cli/install.sh | bash` or `irm https://x.ai/cli/install.ps1 | iex` ([overview](https://docs.x.ai/build/overview)).
- **Headless.** `grok -p "…" --output-format streaming-json`; the schema is undocumented.
- **ACP.** Native, launched as `grok agent stdio` (per the registry).
- **Auth.** `XAI_API_KEY` or browser login.
- **Unverified:** sessions, approvals, terms.
- **Why community.** Three comparison mentions, and rank 19 on Terminal-Bench 4.1 (per the research leg). The ACP path is cheap.

#### JetBrains Junie CLI

- **Version and license.** Proprietary. npm `@jetbrains/junie` 3110.7.0 (2026-09-09); the registry pins 4020.10.0 as native binaries.
- **Headless** ([parameters](https://junie.jetbrains.com/docs/parameters.html)).
  - Flags: `--output-format text|json|json-stream`, `--input-format text|json`, `--json-output-file`.
  - `--act-as-interactive` runs unattended. `--max-steps`.
- **ACP.** Native `--acp=true`.
- **Sessions.** `--resume`, `--session-id`, `--fork-session`.
- **Auth.** `--auth` (a Junie API key from junie.jetbrains.com/cli), `--auth-license`, and bring-your-own-key flags for Anthropic, OpenAI, Google, Grok, OpenRouter and LiteLLM.
- **Unverified:** approval flags and terms.
- **Why community.** "JetBrains AI" has 12.8% on SO, but that is mostly IDE use. The CLI is young (npm package created 2026-03) with weak signals. Promote it if users ask.

#### Devin CLI (Cognition)

- **Version and license.** npm `devin` 3000.13.4 (2026-11-17), proprietary (Cognition ToS).
- **Install.** `curl -fsSL https://cli.devin.ai/install.sh | bash`, `brew install --cask devin-cli`, or Windows installers ([docs](https://docs.devin.ai/cli)).
- **ACP.** Native `devin acp` (per the registry).
- **Headless.** `devin -p` exists according to the research leg; JSON output is **unverified**.
- **Limitation.** "Devin CLI does not yet support Knowledge, Playbooks, or Secrets from your Devin account."
- **Why community.** Windsurf (6.5%) and Devin (2.9%) have survey share, but the CLI itself shows weak signals.

#### ACP registry long tail (generic ACP driver only)

These need no ostra code beyond a profile; launch commands are from the [registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).

| Agent | Vendor | License | ACP launch | Signal |
|---|---|---|---|---|
| CodeBuddy Code | Tencent | Proprietary | `codebuddy-code --acp` | npm 163k a week; stream-json in and out |
| Qoder CLI | Alibaba | Proprietary | `qodercli --acp` | npm 21.7k; iFlow's successor |
| Muse Code | Meta | Proprietary | `muse acp` | Terminal-Bench 4.1 #15 (per research leg) |
| IBM Bob | IBM | Proprietary | `bob acp` | npm 6.4k |
| Cortex Code | Snowflake | Proprietary | `cortex acp serve` | – |
| Poolside | Poolside | Proprietary | `pool acp` | In Zed's built-in list |
| MiniMax Code | MiniMax | MIT | `acp` | npm 16k |
| OpenHands CLI | OpenHands | MIT | `openhands acp` (not in the registry) | CLI repo 274★, PyPI 6k |
| Others | various | various | `acp` / `--acp` | Autohand, Corust, crow-cli, DimCode, Dirac, Harn, Kimchi, Minion Code, Nova, siGit, Stakpak, VT Code, DeepAgents, fast-agent, GLM Agent |

### Dropped, and why

| Agent | Why dropped |
|---|---|
| **Aider** | Close to dormant: last commit 2026-05-22, last GitHub release 2025-08-09 ([commits](https://github.com/Aider-AI/aider/commits/main)). No JSON output ([options](https://aider.chat/docs/config/options.html)), no tool-approval loop, no session IDs, and its Python API is "not officially supported" ([scripting](https://aider.chat/docs/scripting.html)). Its only ACP bridge is an 8★ community repo. 50k★ and 2.1% on SO are legacy reach. |
| **Warp** | 5.2% on SO, but no drivable headless agent. The new Warp Agent CLI is interactive only, with no JSON or ACP. The Oz CLI (`oz agent run`) is "a supported legacy interface" and prints only text. Programmatic control goes through Warp's cloud Platform API ([docs](https://docs.warp.dev/_llms-txt/warp-agent-cli.txt)). Revisit if Warp ships ACP. |
| Continue (`cn`) | README: "no longer actively maintained and is read-only"; last npm publish 2026-06-18. |
| Roo Code | Shut down 2026-05-15 ([notice](https://roocodeinc.github.io/Roo-Code)). |
| iFlow CLI | Shut down 2026-04-17; users told to "migrate to Qoder" ([notice](https://platform.iflow.cn/en/cli/quickstart)). |
| Plandex | Last push 2025-10-03. |
| Trae Agent | A research harness; last push 2026-02-05; not on PyPI. |
| Zed Agent | No standalone CLI; there is only an open request ([discussion](https://github.com/zed-industries/zed/discussions/59146)). |
| Codebuff, Forge | Under 1k npm downloads a week. |

**Watch list (not coding CLIs, or too early):**
- **Hermes Agent** (Nous Research, 264k★, `hermes acp`, #1 OpenRouter app by tokens): a general-purpose agent.
- **OpenClaw** (395k★): a personal-agent orchestrator, closer to a peer of ostra than a target.
- **DeepSeek Harness** (283k★, 680k npm a week): its README describes only a Web UI, in "developer preview" with breaking changes ([README](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md)). ACP via `--profile acp` is **unverified**.
- **Letta Code** (3.9k★, 75k npm, no ACP).

---

## Recommended tiers

**What the tiers mean:**
- **v1** and **soon after**: an ostra-maintained profile (launch, credentials, approval policy, steering strategy, session archive/restore), a pinned version, and CI smoke tests: start, stream, approve, cancel, resume on the same runner, and restore on another.
- **Community**: the generic ACP driver plus a contributed profile, labelled community, with no CI guarantee. A profile can be seeded from the agent's ACP registry entry (launch command and per-platform binary).

**ACP cost key:**
- **Low:** native ACP with load and permission requests, cross-platform.
- **Medium:** native ACP with gaps (preview, no resume, terms-limited auth) or adapter-only.
- **High:** needs a native driver.

| Agent | Popularity evidence | ACP cost | Tier |
|---|---|---|---|
| Claude Code | #1 everywhere | Low (claude-agent-acp, steering ext) | **v1** (given) |
| Codex CLI | #3 SO, #2 in mentions, 26M npm/week | Low (codex-acp now has steering and full sessions) | **v1** (given) |
| OpenCode | 13.6% SO, 227k★ | Low (native) | **v1** (given) |
| oh-my-pi | Pi 4.4% SO; omp 39k★ | Low (native) | **v1** (given) |
| **GitHub Copilot CLI** | #2 SO (58.7%), 21% JetBrains, Terminal-Bench #1, 1.7M npm/week | Low–Medium: native but public preview; tool policy fixed per process | **v1** |
| **Cursor CLI** | #4 SO (25.5%), 12% JetBrains, 39% Pragmatic Engineer | Low: native `agent acp` with load and permissions; storage undocumented | **v1** |
| Antigravity CLI | 16% SO, 6% JetBrains | Low technically; terms limit it to Enterprise or API key | Soon after |
| Gemini CLI | 108.9k★, 477k npm; users moving to Antigravity | Low; no steering (queue in ostra), no list/resume | Soon after (Google family) |
| Kiro CLI | Amazon Q 3.9% SO; AWS | Low; `_session/steer`; registry lacks Windows | Soon after |
| Cline CLI | 4.5% SO, 71.7k★ | Low; no ACP resume/list; override auto-approve | Soon after |
| Kilo Code CLI | 3.2% SO, OpenRouter #3, 28k★ | Low; reuses the OpenCode profile | Soon after |
| Goose | 56.7k★, LF governance | Lowest: ACP is primary, plus steer ext and ACP over WebSocket | Soon after |
| Qwen Code | 30.7k★, 150k npm | Low | Community (first in line) |
| Mistral Vibe | 3.2% SO, 216k PyPI | Low (`vibe-acp`) | Community |
| Junie CLI | JetBrains AI 12.8% (IDE-driven) | Low | Community (promote on demand) |
| Devin CLI | Windsurf/Devin 6.5% / 2.9% | Low (capabilities **unverified**) | Community |
| Grok Build, Kimi Code | ~105–110k npm each | Low | Community |
| Factory Droid | Weak (12.8k npm, 95★) | Low–Medium (acp vs acp-daemon; load doubtful) | Community |
| Auggie | 1.2% SO | Low technically; the licence blocks bundling | Community (user-installed only) |
| Amp | 3 mentions, 125k npm | Medium (community amp-acp, or native stream-json) | Community |
| Crush | 29k★, 1 mention | High (no ACP; native HTTP driver) | Community (native driver) |
| Registry long tail | Varies | Low | Community |

**Why Copilot and Cursor join v1.**
- They are #2 and #4 by usage in every 2026 survey, ahead of OpenCode and omp, which are already in v1.
- Both ship native ACP with session load and permission requests, and both run on native Windows, so each costs a profile, not a driver.
- Risks:
  - Copilot's ACP is "public preview" and Cursor's `agent acp` is a "hidden command". Pin versions and run contract tests.
  - Both are per-seat proprietary products. Personal-mode runners are simple. Team runners need a GitHub machine account or bring-your-own-key, and Cursor Enterprise service accounts.

**Why Google waits.**
- Antigravity is the bigger product, but its consumer users can't legally be wrapped.
- Gemini CLI is cheap to support but losing users.
- Ship both together as one profile family once Enterprise and API-key auth is tested.

---

## Unknowns / things to spike

1. **A steering strategy per profile.** Map each agent's mid-turn input onto ostra's `Delivery` (Steer / FollowUp / InterruptThenSend):
   - Extensions: `_session/steering` (Claude, Codex adapters), `_session/steer` (Kiro), `_goose/unstable/session/steer`.
   - Antigravity: a second prompt steers.
   - Gemini: a second prompt aborts, so ostra must queue.
   - OpenCode and Goose: a second prompt is rejected.
   - Copilot, Cline, Qwen, Auggie, Junie: unknown.

   Detect support through capabilities or `_meta` where advertised. Consider proposing a common steering RFD to ACP.
2. **Approvals under ACP when the agent defaults to allow-all.** Do Goose (`auto`), Cline (auto-approve), Kimi (`auto` in `-p`), Amp (Neo) and Antigravity (Auto?) still send `session/request_permission` in ACP mode? Which `session/set_mode` or launch flag forces it? Test each profile with a "write file" and a "run shell" prompt.
3. **Copilot ACP preview.**
   - Steering over ACP.
   - Usage and cost reporting.
   - One process per session, given tool filters fixed at start.
   - PAT or env auth under ACP.
   - **Does a GitHub machine account need its own Copilot seat?** Ask GitHub; [discussion #727](https://github.com/github/copilot-cli/discussions/727) is unanswered.
4. **Cursor `agent acp`.**
   - How stable is the hidden command?
   - Does `session/load` work after a process restart?
   - Where are sessions stored, for archive/restore?
   - How do you stop auto-updates on runners?
   - What happens when an admin disables headless mode?
5. **Session portability for new agents.**

   | Agent | Export / import |
   |---|---|
   | Kilo | `export`/`import` |
   | Goose | JSON export; import **unverified** |
   | Kiro | `/chat save` zip, cloud sessions; must not touch files |
   | Copilot | `events.jsonl` + SQLite, `--sync-session` |
   | Cline | `history` export |
   | Auggie | `/export`/`/import` |
   | Vibe | `--output-dir` journal |
   | Amp | Cloud threads |
   | Cursor, Antigravity | Store undocumented |

   Also watch Gemini's 30-day retention. Spike: restore a session on a second runner with a different home directory.
6. **Use the ACP registry as an install source.**
   - Trust model: are there checksums or signatures?
   - Lag: Kiro 3.0.0 vs 3.4.0; Auggie 0.37.0 vs 1.2.1.
   - Platform gaps: no Kiro Windows binary.
   - Licence limits on ostra installing agents itself:
     - Auggie's embedding clause.
     - Copilot allows unmodified redistribution.
     - Claude: does auto-installing count as "preinstalling"? (see companion doc)
7. **Legal confirmations before advertising team runners:**
   - GitHub: a machine account plus seat.
   - OpenAI: Business access tokens on a shared runner.
   - Google: Antigravity Enterprise wrapping.
   - Augment: does the embedding clause apply to an open-source, self-hosted orchestrator?
   - Factory: "service bureau".
   - Kilo: seats.
   - Qwen: "non-commercial" consumer terms.
   - Crush: FSL "Competing Use".
8. **Prior art and vendor overlap.**
   - Evaluate [openclaw/acpx](https://github.com/openclaw/acpx) (3.4k★, 779k npm a week, a "headless CLI client for stateful ACP sessions") for design and licence.
   - Vendors now ship their own runner and orchestration layers: Amp runners, Cursor self-hosted workers, the Factory daemon, Copilot remote, Kiro cloud sessions. Track whether any of them restrict third-party orchestration, as Antigravity's consumer terms already do.
9. **Windows runners.**
   - Auggie and Amp are WSL-only officially.
   - The Kiro registry entry has no Windows binary.
   - Gemini and Antigravity sandboxes need Windows 11 24H2+.
   - The Mistral Vibe server mode doesn't run on Windows.
10. **Version churn.**
    - Copilot and Amp release daily.
    - Kiro switched engines (V2 to V3), and V3 sessions don't open in V2.
    - Auggie changed flags from 0.x to 1.x.
    - Kilo is moving to OpenCode V2.
    - Codex removed `--full-auto`.

    Each profile needs a pinned version range and a contract test that runs on upgrade.
11. **Usage and cost parity.** Cost data comes in different forms:
    - Goose: `cost_usd`.
    - Vibe: `export.json` cost.
    - ACP: `usage_update`.
    - Copilot: AI Credits.
    - Kiro: subscription credits.

    Decide what ostra budgets can rely on.
12. **Open single-agent items (unverified):**
    - Copilot `-p` JSONL schema.
    - Kiro `stream-json` events and headless default.
    - Antigravity default mode and store path.
    - Qwen session path, headless default, and steering.
    - Codex app-server default policy.
    - Droid `acp` vs `acp-daemon` and `loadSession`.
    - Kilo server steering.
    - Grok, Junie and Devin sessions, approvals and terms.
    - Whether the Grok Build repo tracks releases.
