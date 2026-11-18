# Landscape: tools that orchestrate coding agents against tasks and tickets

**Status:** Research, v1. **Checked:** 2026-11-17.

**Method.** Web pages, docs, changelogs and GitHub issues were read on 2026-11-17. Star counts, licenses, latest release and last commit come from the GitHub API and repo pages, also on 2026-11-17. For Vibe Kanban I read a shallow clone of `BloopAI/vibe-kanban` at commit `3f095f0` (2026-11-15).

**Markers.** **unverified** means I found no primary source. ✓ = yes, ~ = partly, ✗ = no, ? = unknown.

---

## Summary

### 2026 split the category into three groups

1. **Local workbenches for running agents in parallel.** These are mostly single-user and mostly open source. Each gives an agent a worktree, a diff view and a PR button.
   - Examples: Vibe Kanban, Claude Squad, Conductor, Crystal (now Nimbalyst), Sculptor.
   - 2026 brought very large newcomers: Orca (128k★), T3 Code (64k★), Paseo (24k★), Paradev (16k★), Agent Orchestrator (15k★) and Emdash.
2. **Hosted background agents from vendors,** with tracker integrations.
   - Examples: GitHub Copilot, Cursor, Devin, Factory, Codex cloud, Claude Code on the web, Jules, and Linear's own coding sessions.
   - All are closed source and drive a single agent.
   - Several now let you bring your own compute. Their runners connect out to the vendor (Cursor Self-Hosted Machines, Claude Code self-hosted environments, Devin Outposts, Factory Remote Control). The control plane still belongs to the vendor.
3. **Self-hostable team platforms.** This is ostra's category.
   - Examples: Multica, Kandev, Cyrus, OpenHands Agent Canvas, Nuphos, Open Session, Miko.
   - Each one covers part of ostra. None covers all of it.

### Closest relatives to ostra

| Tool | Close because | Missing for ostra |
|------|---------------|-------------------|
| **Multica** | Almost the same architecture: a Go and Postgres team server, daemons on any machine, 31 agent CLIs, roles. 56k★. | It is source-available, not open source. It has its own issue board and no Linear integration; Jira sync is still being built. |
| **Kandev** | AGPL. Pulls in Linear, Jira, GitHub and GitLab issues. Executors run locally, in Docker or Kubernetes, or over SSH. Supports Pi. | Team and user accounts are not documented, so it looks single-tenant or "shared instance". Small: 1.1k★. |
| **Cyrus** | Apache-2.0 and a native Linear agent. Runs Claude Code, Codex, Cursor, Gemini or OpenCode in worktrees. Sessions can be continued. | One runtime per team. The team dashboard is a paid SaaS. No Jira. |
| **OpenHands Agent Canvas** | MIT. Drives agents over ACP across several backends. | Multi-user, RBAC and Jira are only in the paid Enterprise edition. |
| **Vibe Kanban** | Rust. Apache-2.0. The best executor layer to learn from. | Its company shut down in April 2026. Its team boards stopped working in v0.1.44. No trackers. It is a local app, not a control plane. |

### The gap is real but narrow

I found no tool that combines all of these:
- an OSI license
- self-hosting
- multi-user accounts
- several CLI agents
- **Linear and Jira as the source of truth**
- **a mixed fleet of laptop and server runners**
- **long-lived tasks that can be reopened on any runner**

Each piece exists somewhere.

### Market signals

- **Hosted tools keep disappearing.** This is ostra's strongest argument.
  - Terragon shut down in February 2026.
  - bloop (Vibe Kanban) shut down in April 2026.
  - OpenAI announced it is acquiring Ona in June 2026.
  - Meta bought Conductor in November 2026.
  - Sweep pivoted, and Coder archived AgentAPI.
- **Trackers are becoming agent hosts.**
  - Linear Agent has run Claude Code and Codex in Linear's cloud since June 2026.
  - Jira added "Agents in Jira" in 2026.
  - ostra has to integrate *natively* as a Linear agent. It has to win on self-hosting, your own compute, several agents and durable continuation.

### Rust

Few tools in this space use Rust. Vibe Kanban's backend is Rust, and so are Herdr (an agent-aware terminal multiplexer, 52k★), tsk, Nuphos's local `openab` binary and the core of oh-my-pi. Almost everything else is TypeScript or Go.

---

## Comparison

### Table 1: fit against ostra's requirements

Columns:
- **OSS:** OSI license
- **Self-host:** you can run all of it
- **Team:** multi-user accounts
- **Multi-agent:** drives several CLI agents
- **Intake:** pulls tickets from Linear or Jira
- **Runners:** can mix local and remote runners
- **Reopen:** a finished task can be continued
- **PR↔ticket:** opens a PR and links it to the ticket

| Tool | OSS | Self-host | Team | Multi-agent | Intake | Runners | Reopen | PR↔ticket |
|---|---|---|---|---|---|---|---|---|
| **ostra (target)** | ✓ | ✓ | ✓ | ✓ | ✓ Linear, then Jira | ✓ | ✓ | ✓ |
| Multica | ✗ source-available | ✓ | ✓ roles | ✓ 31 CLIs | ✗ own board; Jira in progress | ✓ daemons | ~ | ~ agent pushes |
| Kandev | ✓ AGPL | ✓ | ? | ✓ about 23 | ✓ Linear, Jira, GH, GL | ✓ local, Docker, K8s, SSH | ✓ | ✓ |
| Cyrus | ✓ Apache | ✓ community edition | ~ allowlist | ✓ 5 | Linear ✓✓, Jira ✗ | ✗ one runtime | ✓ | ✓ |
| OpenHands Agent Canvas | ✓ MIT (Enterprise ✗) | ✓ | Enterprise only | ✓ ACP | Cloud and Enterprise only | ~ backends | ✓ | ✓ |
| Nuphos | ✓ Apache | ✓ one team per deploy | ✓ shared rooms | ✓ | ~ Linear link, no Jira | ✓ laptop, remote, cloud | ✓ | ? |
| Open Session | ✓ MIT | ✓ | ~ weak auth | ~ Pi engine | ~ Linear, no Jira | ~ own box or sandbox | ? | ✓ |
| Miko | ✓ Apache | ✓ | ✓ orgs | ✓ | ~ Linear, no Jira | ✓ hub and daemons | ? | ? |
| Vibe Kanban | ✓ Apache | ~ local app | ✗ since v0.1.44 | ✓ 10 + ACP registry | ✗ | ~ host plus relay | ✓ | ~ PR, no ticket |
| Emdash | ✓ Apache | n/a (desktop) | ✗ | ✓ | ✓✓ Linear, Jira, 10+ | ~ local and SSH | ✓ | ✓ |
| Orca | ✓ MIT | ~ `orca serve` | ✗ **unverified** | ✓ about 40 | ~ Linear, GH issues | ✓ local, SSH, server, VM | ✓ | ✓ |
| Paradev (ex-Superset) | ~ MIT core, paid cloud | ~ | ~ paid | ✓ | ~ Linear, Slack | ✓ | ✓ | ✓ |
| Groundcrew | ✓ MIT | local | ✗ | ✓ | ✓ Linear, Jira | ✗ | ✓ | ~ |
| T3 Code | ✓ MIT | ~ own server | ✗ | ✓ | ✗ | ~ | ✓ | ✓ no ticket |
| Paseo | ? license unclear | ✓ daemon | ✗ | ✓ | ✗ | ✓ | ~ | ✗ |
| Agent Orchestrator | ✓ Apache | local | ✗ | ✓ 35+ | ✗ | ✗ | ✓ | ✓ no ticket |
| Claude Squad | ✓ AGPL | local | ✗ | ✓ | ✗ | ✗ | ~ | ✗ push only |
| Conductor | ✗ | ✗ | ~ paid | ✓ 4 | ✗ | ✗ cloud closing | ✓ | ~ |
| Sculptor | ✓ MIT | local | ✗ | ~ 3 | ✗ | ~ experimental | ✓ | ~ |
| Nimbalyst (ex-Crystal) | ✓ MIT | local | ~ shared docs | ✓ | ✗ own tracker | ✗ | ✓ | ? |
| Terragon (OSS snapshot) | ✓ Apache | ~ unmaintained | ✓ | ✓ | ✗ | ✗ cloud sandbox | ✓ | ~ |
| Open SWE / Robin | ✓ MIT | ~ | ~ | ✗ own agent | ~ Linear | ✗ sandboxes | ✓ | ✓ |
| Coder Agents | ✓ AGPL* | ✓ | ✓ | ✗ own loop | ✗ | ✓ workspaces | ✓ | ~ |
| Tembo | ✗ | ~ VPC | ✓ | ✓ | ✓✓ | ~ | ? | ✓ |
| Linear Agent (Coding Sessions) | ✗ | ✗ | ✓ | ~ Claude Code, Codex | ✓✓ native | ✗ cloud only | ✓ same thread | ✓ |
| GitHub Copilot cloud agent | ✗ | ~ self-hosted Actions runners | ✓ | ~ via Agent HQ | ✓ GH, Linear, Jira | ~ | ✓ `@copilot` | ✓ |
| Cursor cloud agents | ✗ | ~ self-hosted workers | ✓ | ✗ | ✓ Linear | ~ | ✓ | ✓ |
| Devin | ✗ | ~ Outposts | ✓ | ✗ | ✓ Linear, Jira | ~ | ~ 14-day window | ✓ |
| Factory | ✗ | ~ daemon; airgapped Enterprise | ✓ | ✗ | ✓ Linear, Jira | ✓ | ✓ | ✓ |
| OpenAI Codex cloud | ✗ (CLI ✓) | ✗ | ✓ | ✗ | ✓ Linear | ✗ | ✓ | ~ manual PR |
| Claude Code cloud | ✗ | ~ self-hosted environments (beta) | ✓ | ✗ | ✗ Linear (Jira agent exists) | ✓ | ✓ | ✓ |
| Google Jules | ✗ | ✗ | ~ | ✗ | ✗ GH label only | ✗ | ✓ | ✓ |

\* Coder's license is AGPL-3.0 from memory; I did not re-check it.

### Table 2: details and traction

Stars and releases as of 2026-11-17. "Stack" flags Rust in **bold**.

| Tool | License | Agents driven | Trackers | Agents run | Stack | ★ | Latest release | Maintained? |
|---|---|---|---|---|---|---|---|---|
| Vibe Kanban | Apache-2.0 | Claude Code, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, Qwen, CCR, any ACP-registry agent | none | local host (remote access via relay/SSH) | **Rust** (axum, sqlx/SQLite) + React | 28,720 | v0.1.46, 2026-11-15 | community; 23 commits since mid-May |
| Multica | "Multica License" (Apache-2.0 + restrictions) | 31 CLIs incl. Claude Code, Codex, OpenCode, Pi | own board; GitHub, GitLab, Gitea, Forgejo | daemons on any machine | Go, Postgres 17, Next.js | 56,470 | v0.10.0, 2026-11-16 | very active |
| Kandev | AGPL-3.0 | about 23 incl. Claude Code, Codex, OpenCode, Pi (`pi-acp`) | Linear, Jira, GitHub, GitLab, Sentry | local, Docker, K8s, SSH, Sprites | Go, SQLite, React, Tauri | 1,139 | v0.101.0, 2026-11-11 | active |
| Cyrus | Apache-2.0 | Claude Code, Codex, Cursor, Gemini, OpenCode | Linear (native agent), GitHub, GitLab, Slack | one machine (yours or theirs) | TypeScript | 905 | v0.2.79, 2026-11-17 | very active |
| OpenHands | MIT (Enterprise separate) | OpenHands agent; ACP: Claude Code, Codex, Gemini, OpenCode, Pi | Cloud/Enterprise: Linear, Jira, Slack; resolver on GH | local, Docker, VM, cloud backends | Python, React | 93,658 | v1.41.0, 2026-11-16 | very active |
| Nuphos | Apache-2.0 | Claude Code, Codex (ACP), OpenCode, Grok Build, Antigravity | Linear, GitHub, GitLab | laptop, own server, managed cloud | Bun/Hono, MongoDB, **Rust** local binary | 683 | Desktop v0.125.0, 2026-11-17 | active |
| Open Session | MIT | Pi engine (Claude/Codex subscriptions) | Linear, Slack, Plain, GitHub | own box worktrees, Daytona/Boat | Bun/TypeScript | 425 | v0.4.82, 2026-11-09 | active |
| Miko | Apache-2.0 | several CLIs | GitHub, Linear, Slack, Discord | Hub plus daemons | Node, Postgres | 5 | Hub v0.12.2, 2026-11-13 | early ("expect data loss") |
| Orca | MIT | about 40 CLIs | Linear, GitHub issues | local, SSH, `orca serve`, cloud VMs | TypeScript/Electron | 127,664 | v1.4.261, 2026-11-16 | hyperactive; 8.5k open issues |
| T3 Code | MIT | Claude Code, Codex, Cursor, OpenCode, Pi, ACP… | none | your hardware | TypeScript | 63,900 | nightly 2026-11-17 | very active |
| Paseo | GitHub reports NOASSERTION (Apache vs AGPL unclear) | Claude Code, Codex, Copilot, OpenCode, Pi | none | daemon per machine | TS daemon, Elixir relay | 24,255 | v0.16.1, 2026-11-17 | active |
| Paradev (ex-Superset) | MIT | any CLI | Linear, Slack | local, remote hosts, paid cloud | Electron, Bun, tRPC, Drizzle | 16,363 | canary 2026-11-17 | active |
| Agent Orchestrator | Apache-2.0 | 35+ | none | local | Go + TS | 14,850 | nightly 2026-11-17 | active |
| Emdash | Apache-2.0 | about 9 incl. Claude Code, Codex, OpenCode, Droid | Linear, Jira, GitHub, GitLab, Asana, Trello… | local, SSH | TypeScript | 6,272 | v1.2.11, 2026-11-06 | active |
| Claude Squad | AGPL-3.0 | any CLI via tmux | none | local | Go | 8,825 | v1.0.20, 2026-08-20 | slowing |
| Crystal → Nimbalyst | MIT | Claude Code, Codex, OpenCode (+alpha) | built-in only | local | TS/Electron | 3,128 → 2,084 | Crystal 0.3.5 (2026-02, deprecated); Nimbalyst v0.84.1, 2026-11-15 | Nimbalyst active |
| Sculptor | MIT | Claude Code, Codex, Pi | none | local; Docker/remote experimental | Python | 254 | v0.50.0, 2026-11-17 | active, "research preview" |
| Groundcrew | MIT | Claude Code, Codex, Cursor, Pi | Linear, Jira | local tmux/zellij | TypeScript | 68 | 4.53.5, 2026-11-12 | active |
| Terragon OSS | Apache-2.0 | Claude Code, Codex, Amp, Gemini | GitHub/Slack mentions | cloud sandboxes | TS, Postgres, Redis | 261 | none; last commit 2026-02-10 | dead (shut down) |
| Open SWE / Robin | MIT | own (LangGraph Deep Agents) | Slack, Linear, GitHub | cloud sandboxes | Python/TS | 11,232 | Robin Desktop v0.3.19, 2026-11-17 | active; no contributions |
| Coder | AGPL-3.0* | own loop (Coder Agents) | none | Terraform workspaces anywhere | Go | 17,411 | v2.39.4, 2026-11-16 | active |
| coder/agentapi | MIT | Claude Code, Goose, Aider (screen-scraped) | none | — | Go | 1,494 | archived (v0.12.2, 2026-05) | archived |
| Herdr | Apache-2.0 | any terminal agent | none | local | **Rust** | 51,569 | v0.9.5, 2026-10-14 | active |
| tsk | MIT | Claude Code, Codex | none | Docker/Podman | **Rust** | 172 | v0.10.9, 2026-07-29 | quiet |
| container-use | Apache-2.0 | any MCP client | none | containers | Go (Dagger) | 4,095 | v0.4.2, 2025-08 | quiet |
| qm (YC) | MIT | Pi-based harness | — | durable sandboxes | TS | 15,727 | v0.1.19, 2026-11-12 | active |
| Sweep | — | — | — | — | Python | 7,709 | last commit 2025-09 | pivoted |
| Kilo Code | Apache-2.0 (extension) | own (OpenCode-based) | "Kilo for Linear" (hosted) | hosted cloud agents | TS | 28,036 | 2026-11-17 | active |
| claude-code-action | (repo) | Claude Code | GitHub issues/PRs | GitHub Actions | TS | 9,995 | v1.0.278, 2026-11-16 | active |

Closed products have no stars: Conductor, Copilot, Cursor, Devin, Factory, Codex cloud, Claude Code cloud, Jules, Linear Agent, Tembo, Merlin.

---

## Tools

### A. Closest relatives: self-hostable, team- or tracker-aware

#### Vibe Kanban (BloopAI), in depth

**What it is.** A local web or desktop app. You plan work on a kanban board, then each task gets a **workspace**: a branch and worktree, a terminal, a dev server and a built-in browser preview. Coding agents run inside it. You review diffs with inline comments that go back to the agent, then open a PR and merge. https://github.com/BloopAI/vibe-kanban

**Status, and the key caveat**
- The company behind it, bloop, **shut down on 2026-04-10**. Remote services (kanban issues, comments, projects, organisations) ended after 30 days. The project "will continue as open source and community maintained" (https://www.vibekanban.com/blog/shutdown). The README now leads with "Vibe Kanban is sunsetting."
- **v0.1.44 disabled Projects (the kanban board) even on self-hosted servers.** Users say "work is completely blocked" and pin v0.1.43. As of 2026-11-17 no maintainer has replied (issues [#3396](https://github.com/BloopAI/vibe-kanban/issues/3396) and [#3354](https://github.com/BloopAI/vibe-kanban/issues/3354)).
- So today VK is effectively **workspaces only, single-user.**
- Activity since 2026-05-15: 23 commits, 16 of them from one contributor. Recent work went into ACP-registry agents, Copilot sign-in and turning off analytics (2026-11-12).
- Contributing: the README asks contributors to discuss in Discussions or Discord before opening PRs.

**Facts**
- License: Apache-2.0 (LICENSE file checked).
- Self-hosting: the local app is self-contained. The "Cloud" server is self-hostable (see below) but is broken for Projects since v0.1.44.
- Team: formerly yes, through Cloud (orgs, invites, shared issues). Agents always ran on each member's own host. Now effectively no.
- Agents: Claude Code, Codex, Gemini CLI, Copilot CLI, Amp, Cursor Agent, OpenCode, Factory Droid, Qwen Code, CCR, plus **any agent in the ACP registry** (added 2026-11-10).
- Trackers: **none.** I grepped the source for "linear" and "jira" and found nothing. Git hosts: GitHub (through the `gh` CLI) and Azure Repos.
- PRs: opened with the `gh` CLI, with an AI-generated description. `pr_monitor` polls PR status, and the PR is tracked in the DB.

**Repository structure** (Cargo workspace, Rust `nightly-2026-08-01`, ~30 crates)

| Crate(s) | Role |
|---|---|
| `server` | axum HTTP/WS API; serves the web app |
| `db` | sqlx + **SQLite**, 76 migrations, models |
| `executors` | agent adapters (below) |
| `services` | `ContainerService` (workspace lifecycle), approvals, `queued_message`, `pr_monitor`, diff streaming, events, file watcher, remote sync |
| `worktree-manager`, `workspace-manager`, `git`, `git-host` | git worktrees (git CLI + git2), multi-repo workspaces, GitHub (`gh`) and Azure |
| `deployment`, `local-deployment` | a `Deployment` trait with a local implementation (portable-pty, russh) |
| `mcp` | rmcp MCP server, so agents can create and manage VK tasks themselves |
| `review` | PR review agent |
| `relay-*`, `ws-bridge`, `relay-webrtc`, `relay-tunnel`, `embedded-ssh`, `trusted-key-auth` | remote access to a host: pairing code, WS/WebRTC tunnel, embedded SSH server for IDEs |
| `remote` (excluded from the workspace) | the "Cloud" server: axum + **Postgres** + **ElectricSQL** sync, GitHub App, JWT, orgs, mail; Docker Compose |
| `tauri-app`, `desktop-bridge`, `preview-proxy` | desktop shell and the built-in browser preview |

Frontend: `packages/local-web`, `remote-web`, `web-core`, `ui` (React 18, Vite 7, TanStack Router and Query, Zustand, Tailwind). **`ts-rs` generates the TypeScript types from Rust structs.**

**Executor abstraction** (`crates/executors/src/executors/mod.rs`)
- `CodingAgent` is an enum with one variant per agent, dispatched to the `StandardCodingAgentExecutor` trait through `enum_dispatch`. The trait's methods:
  - `spawn(dir, prompt, env)` and `spawn_follow_up(dir, prompt, session_id, reset_to_message_id, env)`
  - `spawn_review`
  - `normalize_logs(msg_store, worktree)`: turns agent-specific output into a common conversation-entry stream of JSON patches
  - `discover_options` (models, agents, slash commands, streamed), `get_availability_info` (installed or logged in), `get_setup_helper_action` (install or login), `default_mcp_config_path`, `apply_overrides`, `use_approvals`
- Capability flags: `SessionFork`, `SetupHelper`, `ContextUsage`.
- `SpawnedChild` carries the process group, an `exit_signal` (the executor tells the container it is done) and a `CancellationToken` (graceful interrupt, then kill).
- **Profiles and variants** (`default_profiles.json`): named presets per agent, such as model, plan mode or approvals. A task picks an agent plus a variant.

**How it drives each agent.** It always uses the agent's *structured* mode, never screen scraping.

| Agent | Mechanism |
|---|---|
| Claude Code | `claude --verbose --output-format=stream-json --input-format=stream-json --include-partial-messages --replay-user-messages`. A two-way **control protocol** over stdio: `--permission-prompt-tool=stdio`, with `can_use_tool` routed to VK's approval service, plus `interrupt` and `set_permission_mode`. Follow-up: `--resume <session_id>`; rewind with `--resume-session-at <message_uuid>`. |
| Codex | `codex app-server` (JSON-RPC). Protocol crates are pinned to an `openai/codex` git tag (`rust-v0.132.0`). Resumes by thread id; has a review mode. |
| OpenCode | `opencode serve --hostname 127.0.0.1 --port 0` with a generated `OPENCODE_SERVER_PASSWORD`. Waits for the URL on stdout, then drives it with an HTTP/SSE SDK. Resumes by session id. |
| Gemini, Qwen, Copilot | **ACP** harness (`agent-client-protocol` crate). Sessions are kept per agent. |
| Amp, Cursor, Droid | Each CLI's JSON stream mode: `amp --execute --stream-json` / `threads continue`; `cursor-agent -p --output-format=stream-json --resume`; `droid --output-format stream-json --session-id`. |
| Any ACP-registry agent | Fetches `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, caches it, and installs and runs agents with npx. |

**Follow-ups and resume**
- **Session** is a conversation thread inside a workspace. A workspace can have several sessions, which share files but not context.
- A follow-up starts a new `ExecutionProcess` that resumes the agent's native session id.
- **Reset to a message** truncates history, and later processes are marked `dropped`.
- **Queued messages** sent while the agent is running are delivered when the run finishes.
- If the worktree was deleted (`worktree_deleted`), `ensure_worktree_exists` recreates it from the branch. This is what makes reopening possible.
- Resume works only on the same machine, because it depends on the agent's local session files.

**Data model** (SQLite)
- `Project → Task → Workspace(branch, container_ref, archived, pinned, worktree_deleted) → Session(executor, agent_working_dir) → ExecutionProcess(run_reason ∈ {SetupScript, CleanupScript, ArchiveScript, CodingAgent, DevServer}, executor_action JSON, status, exit_code, dropped) → CodingAgentTurn(agent_session_id, agent_message_id, prompt, summary, seen)`
- Other tables: `PullRequest(pr_url, number, status, target_branch, merged_at, synced_at)`, `execution_process_logs`, `execution_process_repo_state`, `workspace_repo`, `merge`, `scratch`, `tag`.

**Worktrees**
- They live in an app-owned base directory (a temp dir, or `<override>/.vibe-kanban-workspaces`), so orphan cleanup can never touch user folders.
- Creation takes a lock per path. Orphaned worktrees and executions are cleaned up on startup, and `git worktree prune` runs.
- Each repo has setup, cleanup and archive scripts, and a "copy files" list for gitignored files.
- Workspaces can span several repos.

**Verdict for ostra**
- Do **not fork the product.** It is a local, single-machine app built around SQLite with a Tauri shell. Team features lived in a separate server that is now broken. There is no tracker, no server dispatch and no runner fleet. Maintenance is thin.
- **Do study or borrow `executors`, `worktree-manager` and `git`:**
  - Apache-2.0 allows copying with the NOTICE kept.
  - `executors` depends only on internal `utils` and `git`, so extracting it is feasible.
  - The catch: it pins Codex protocol crates to a git tag and uses Rust nightly.
- Upstreaming adapter fixes could share the maintenance burden. With so few maintainers, though, ostra would likely end up as the de facto maintainer.

#### Multica (multica-ai/multica)
- **What it does:** a team workspace where you "assign work to AI coding agents the way you'd assign it to a teammate." Agents pick up issues on Multica's own Linear-style board, post progress, raise blockers and hand back for review. https://github.com/multica-ai/multica
- **License:** "Multica License", which is Apache-2.0 plus conditions on hosted services, commercial embedding and branding. GitHub reports NOASSERTION, so it is **not OSI open source.**
- **Self-host and team:** Docker Compose or Helm. Workspaces, roles (owner, admin, member), per-agent access scopes, and "Squads" of agents and people.
- **Agents:** 31 runtimes, including Claude Code, Codex, OpenCode, Pi, Cursor, Copilot, Droid, Amp and Kimi. It drives CLIs that are already installed and logged in.
- **Where agents run:**
  - A daemon runs on any laptop or cloud box and holds a persistent WebSocket to the server. Polling is the fallback, with a 15 s heartbeat.
  - A "runtime" is one machine plus one agent tool.
  - Queued runs wait for *their* runtime and never move machines. In-progress runs fail after a 3 h grace period (https://www.multica.ai/docs/daemon-runtimes).
  - Each machine keeps one bare-repo cache per repo, makes a worktree per run, and cleans up after 30 days unused. Task tokens are scoped and expire within 24 h.
- **Trackers:** no Linear; Jira sync is in progress ([#1634](https://github.com/multica-ai/multica/issues/1634)). Git hosts: GitHub, GitLab, Gitea, Forgejo. Chat: Slack, Lark and others.
- **Steering:** replying to a running agent "lands in the current run" for Claude Code, Codex, Grok and Kiro. The run directory is reused for each issue.
- **PRs:** the agent pushes and opens the PR. A read-only GitHub App links PRs by identifier and closes the issue on merge. Users report that agents don't open PRs reliably ([discussion #1380](https://github.com/multica-ai/multica/discussions/1380)).
- **Stack:** Go (Chi, sqlc, gorilla/websocket), Postgres 17, Next.js 16, Electron, Expo.
- **Traction:** 56,470★, v0.10.0 (2026-11-16), near-daily releases.

#### Kandev (kdlbs/kandev)
- **What it does:** an "AI Kanban & Development Environment." It runs tasks in parallel, each in its own workspace, with an IDE-like review screen (editor, terminal, browser preview, diffs) and per-step agent handoffs. https://github.com/kdlbs/kandev
- **License:** AGPL-3.0. **Self-host:** yes, "no telemetry, not tied to any cloud."
- **Team:** not documented. It mentions "shared instances" where private executor ownership limits access. **Unverified** whether it has user accounts.
- **Agents:** about 23 including Claude Code and Codex (through ACP adapters), Pi (through `pi-acp` or CLI passthrough), Copilot, Gemini, OpenCode and Cursor.
- **Trackers:** GitHub, GitLab, Jira, Linear and Sentry, used to "pull issues into the kanban, link tasks to PRs, and surface review activity inline." Whether status syncs back is **unverified**.
- **Executors:** local process, Docker, Kubernetes pods, SSH remote servers, Sprites.
- **Resume:** supported. Subtasks can resume from the parent's session.
- **Stack:** Go binary with an embedded React/Vite UI, SQLite in `~/.kandev`, Tauri desktop.
- **Traction:** 1,139★, v0.101.0 (2026-11-11). VK users have recommended it as a replacement (in VK issue #3354).

#### Cyrus (cyrusagents/cyrus, formerly ceedaragents/cyrus)
- **What it does:** monitors Linear, GitHub, GitLab or Slack issues assigned to it, makes a git worktree per issue and runs an agent. It streams activity into **Linear agent sessions**, including select prompts and approvals, then checks the result against the acceptance criteria and retries up to 3 times. https://github.com/cyrusagents/cyrus, https://www.atcyrus.com/docs/introduction
- **License:** Apache-2.0.
- **Hosting:**
  - Community: fully self-hosted with your own Linear OAuth app, GitHub App and Slack app.
  - Paid self-hosted: your machine is the runtime and their cloud does the networking.
  - Cloud: a dedicated VPS.
- **Team:** a `userAccessControl` allowlist. The team dashboard (app.atcyrus.com) is the paid product. I saw no open-source panel.
- **Agents:** Claude Code, Codex, Cursor, Gemini, OpenCode (since v0.2.69, 2026-08-26). Pi is requested ([#1577](https://github.com/cyrusagents/cyrus/issues/1577)). Routing uses `[agent=…]` and labels.
- **Where it runs:** one runtime per team. Switching between self-hosted and cloud "loses the context of all active issues" (https://www.atcyrus.com/docs/runtimes.md).
- **Resume:**
  - One session per comment thread.
  - With Codex (through `codex app-server`), a comment sent mid-turn joins the current turn. For other agents it is queued.
  - It can **mirror Claude transcripts to the control plane through the Claude Agent SDK `SessionStore` contract**, so a session can be resumed from any host after its worktree is gone (https://www.atcyrus.com/changelog).
- **PRs:** created with `gh`. Since v0.2.78 (2026-11-13), CI failures go back to the session that owns the PR.
- **Traction:** 905★, v0.2.79 (2026-11-17). Its docs warn of 3–5× the token use of running Claude Code locally.

#### OpenHands, now "Agent Canvas" (OpenHands/OpenHands)
- **What it does:** "the self-hosted developer control center for coding agents and automations." It has three parts: the Canvas UI, an Agent Server that owns conversations and resume, and an Automation Server for schedules and webhook triggers. https://github.com/OpenHands/OpenHands, https://docs.openhands.dev/openhands/usage/agent-canvas/architecture.md
- **Agents:** the native OpenHands agent, or Claude Code, Codex, Gemini CLI, Pi and OpenCode over **ACP**. Credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`) are injected into containers (https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents).
- **Where it runs:** local, Docker, VM, Cloud or Enterprise backends. Note the direction: **the Canvas connects inbound** to each backend's Agent Server URL.
- **Open source vs Enterprise:** multi-user orgs, Keycloak RBAC, SAML, **Jira**, Bitbucket and a LiteLLM budget gateway are **Enterprise only** (https://docs.openhands.dev/enterprise/enterprise-vs-oss.md).
- **Trackers:** OpenHands Cloud handles Linear and Jira through `@openhands` or an `openhands` label. The repo is inferred from the synced GitHub issue. The older **GitHub resolver** (a `fix-me` label opens a PR) still exists.
- **Stack:** Python, React. **Traction:** 93,658★, v1.41.0 (2026-11-16).

#### Nuphos (nuphos/nuphos)
- **What it does:** Apache-2.0 team workspace for always-on agent "Bots." **Sessions are shared rooms**: teammates see the same tool calls and steer together. https://github.com/nuphos/nuphos
- **Runtimes:** "a cloud computer Nuphos manages, a remote machine you own, or your laptop." You can "move a conversation between them and it keeps going." The connection mechanics are not documented.
- **Agents:** Claude Code and Codex through ACP; OpenCode, Grok Build, Antigravity.
- **Integrations:** GitHub, GitLab, Linear (repos, PRs, issues), Slack, Discord, cron and webhook triggers. No Jira.
- **Self-host:** Compose, Railway or Helm, one team per deployment.
- **Stack:** Bun/Hono, MongoDB, S3, Electron; native iOS and Android apps; a **Rust** `openab` local binary.
- **Traction:** 683★, Desktop v0.125.0 (2026-11-17).
- **Fit:** strong on team steering and moving between runtimes. Not built around ticket → PR.

#### Open Session (tellahq/opensession)
- **What it does:** MIT, self-hosted "control room for coding agents." A web UI plus Slack, Linear, Plain and GitHub agents. https://github.com/tellahq/opensession
- **Agents:** runs on the **Pi engine** with multiple Claude and Codex subscriptions. It does not wrap several CLIs.
- **Where it runs:** worktrees on your own box, or Daytona or Boat sandboxes.
- **Auth is weak:** by default it "trusts everyone who can reach the address." GitHub sign-in is opt-in, and the docs say to keep it on Tailscale.
- **Stack:** Bun/TS. **Traction:** 425★, v0.4.82 (2026-11-09).

#### Miko (mikoagents/miko)
- **What it does:** Apache-2.0, Node and Postgres. A **Hub dispatches to daemons on laptops and dev boxes** (`miko hub connect <url>`). https://github.com/mikoagents/miko
- **Team and intake:** multi-user orgs with invites. Intake from GitHub, Linear, Slack and Discord. Worktrees.
- **Maturity:** 5★, Hub v0.12.2 (2026-11-13), and the README says "expect data loss."
- **Fit:** the same shape as ostra, but very early.

#### Terragon (terragon-labs/terragon-oss)
- **What it was:** a cloud orchestrator for Claude Code, Codex, Amp and Gemini. Each task had a sandbox and a branch, with automatic commits and PRs. It took GitHub and Slack @-mentions and had a `terry` CLI to **pull a task down and continue locally.** No Linear. https://github.com/terragon-labs/terragon-oss
- **Shutdown:** announced 2026-01-16; the code was published under Apache-2.0. The last commit was 2026-02-10. The exact end-of-service date is **unverified**.
- **Stack:** pnpm/Turborepo, Postgres, Redis, Drizzle, plus a separate WebSocket "broadcast" service.
- **Traction:** 261★. Worth reading, not using.

### B. Local workbenches for parallel agents (single-user)

#### Claude Squad (smtg-ai/claude-squad)
- **What it does:** a Go terminal UI. Each agent runs in a tmux session on its own worktree. You attach to re-prompt, `c` checkpoints or pauses, `r` resumes, and Tab shows the diff. `s` commits and pushes; it does **not create PRs.** https://github.com/smtg-ai/claude-squad
- **Agents:** Claude Code by default; Codex, Gemini, Aider, OpenCode, Amp, or any command.
- **License:** AGPL-3.0.
- **Traction:** 8,825★, v1.0.20 (2026-08-20), slowing.
- **Complaints:**
  - the prompt is sent before the CLI is ready, so it is lost (#266)
  - the Windows build is broken because of pty support (#275)
  - a stdin race with tmux (#325)
  - no setup hook (#260)
  - no multi-repo support (#56)

#### Conductor (conductor.build, Melty Inc.)
- **What it does:** a closed-source macOS app (with an iOS remote).
  - Each workspace is a worktree with its own branch, terminal and diff, and the flow is review → PR → merge → archive.
  - It bundles **version-pinned** Claude Code, Codex, Cursor Agent and OpenCode.
- **Conventions worth copying** (https://www.conductor.build/docs/concepts/workspaces-and-branches):
  - it fetches `origin` before branching
  - the agent renames the branch after the first chat
  - a `.context/` folder for notes and handoffs
  - a `CONDUCTOR_PORT` per workspace
  - setup and archive scripts in `.conductor/settings.toml`
  - `.worktreeinclude`
  - inline diff comments go back to the agent
  - a Checks tab and stacked PRs
- **Team:** "Multiplayer" arrived in July 2026; Teams cost $60 per user per month.
- **Status:** **Meta acquired it on 2026-11-04** (https://axios.com/2026/11/04/meta-acquires-ai-coding-startup-conductor, https://www.infoworld.com/article/4245065/meta-acquires-conductor-as-ai-coding-shifts-toward-multi-agent-development.html).
  - Conductor Cloud goes read-only on Nov 13 and shuts down on Nov 20. The desktop app is updated until early 2027, then winds down.
  - A 2026-11-13 changelog post says "Conductor isn't shutting down" (https://www.conductor.build/changelog), which contradicts this. What actually happens is **unverified**.
  - HN users are moving to open-source tools because of the acquisition risk (https://news.ycombinator.com/item?id=50369503).

#### Sculptor (imbue-ai/sculptor)
- **What it does:** a desktop app (Mac on Apple Silicon, Linux) for parallel agents in worktrees, with an *experimental* Docker or remote backend. https://imbue.com/sculptor/, https://github.com/imbue-ai/sculptor
- **Pairing Mode:** syncs an agent's workspace with your local checkout in both directions, so you can test in your own dev environment.
- **Merge flow:** keep or discard changes, conflicts can be sent back to the agent, and there is a doc for opening PRs.
- **Agents:** Claude Code, Codex (since 2025-12-03), and the **Pi harness**.
- **License and stack:** MIT, Python.
- **Traction:** 254★, v0.50.0 (2026-11-17). Labelled a "research preview" with limited outside contributions.

#### Crystal → Nimbalyst (stravu/crystal → nimbalyst/nimbalyst)
- **Crystal:** MIT, Electron. Ran Claude Code and Codex in worktrees, resumed sessions with full history, and offered in-app rebase and squash. Deprecated in February 2026 (3,128★, last release 0.3.5). https://github.com/stravu/crystal
- **Nimbalyst** (https://nimbalyst.com/):
  - **Workspace:** MIT "visual workspace" with editors for Markdown, mockups, diagrams and sheets. Each session can optionally get a worktree, and there is a **kanban of sessions by phase** (backlog, planning, implementing, complete).
  - **Agents:** Claude Code, Codex and OpenCode, plus Copilot and ACP agents in alpha.
  - **Teams:** shares docs and trackers in real time, and teammates' *local* agents edit the shared documents.
  - **Migration from Crystal:** it reads the same Claude sessions, so there is no migration step.
  - **Traction:** 2,084★, v0.84.1 (2026-11-15), 842 open issues.

#### Orca (stablyai/orca)
- **What it does:** an MIT "ADE" (agent development environment) for Mac, Windows, Linux, iOS and Android. It drives about 40 CLI agents and has a coordinator → worker mode. First commit 2026-03-17. https://github.com/stablyai/orca
- **Trackers:** a **Linear and GitHub tasks view; start a workspace from an issue.**
- **Ways to run** (https://www.onorca.dev/docs/ways-to-run):
  - local
  - SSH targets, where a relay keeps terminals alive and replays output when you reattach
  - **`orca serve`**: one server owns the session state, and the laptop, web, mobile and automation clients all attach to it
  - cloud VMs
- **PR loop:** a PR draft generated from the diff. **Failing checks and PR review comments go back to the agent.**
- **Worktree conventions:** `.worktreeinclude`, and `worktree.sharedDirectories` shares node_modules by APFS clone or symlink.
- **Traction:** 127,664★, v1.4.261 (2026-11-16), **8,529 open issues.**

#### T3 Code (pingdotgg/t3code)
- **What it does:** MIT. A single local server with desktop, web and phone clients that all show the same threads. Agents always run on your hardware; remote access is over LAN, Tailscale or "T3 Connect." https://github.com/pingdotgg/t3code
- **Agents:** Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Kiro, **Pi**, and any ACP agent. You can switch models mid-thread and hand work from one agent to another.
- **PRs:** a one-button commit + push + PR with a generated title and body, including draft and stacked PRs, using your own GitHub auth.
- **Limits:** no team features, no trackers.
- **Traction:** 63,900★, nightly 2026-11-17, 3.5k open issues.

#### Paseo (getpaseo/paseo)
- **What it does:** a TypeScript **daemon** with a WebSocket API and an MCP server. It runs on a laptop, a server or in Docker. Clients (Electron, Expo mobile/web, CLI) connect directly, over Tailscale, or through an **optional E2E-encrypted relay written in Elixir** with QR pairing. https://github.com/getpaseo/paseo
- **Agents:** wraps the first-party CLIs unmodified and does not extract OAuth tokens. Claude Code, Codex, Copilot, OpenCode, **Pi**. CLI verbs: `paseo ls/attach/send`.
- **License:** GitHub reports NOASSERTION; the HN launch said AGPL-3.0. **Unverified.**
- **Traction:** 24,255★, v0.16.1 (2026-11-17), built by one person.

#### Paradev, formerly Superset (ParadevAI/Paradev)
- **What it does:** MIT Electron app. Each workspace gets a worktree, a branch, terminals and port detection. **Workspaces can start from Linear issues or Slack messages.** https://github.com/superset-sh/superset, https://paradev.com/
- **Team and cloud:** remote hosts, members, shared PR review and automations, on paid Team and cloud tiers. Which parts are closed is **unverified**.
- **Traction:** 16,363★.
- **Scale note:** their own post says they "reliably manage 5–7 agents in parallel."

#### Emdash (generalaction/emdash)
- **What it does:** Apache-2.0, YC-backed desktop app (Mac, Windows, Linux). https://github.com/generalaction/emdash
- **Agent status:** it **installs lifecycle hooks into each agent's config** to track status and which sessions can be resumed.
- **Remote:** projects over SSH/SFTP, with credentials in the OS keychain.
- **Broadest tracker intake found** (https://emdash.com/docs/issues):
  - Linear (personal API key, using Linear's branch name), Jira, GitHub, GitLab, Asana, Trello, Monday, Plane, Forgejo, Notion.
  - The issue seeds the task.
- **PR flow:** diff → PR → CI checks → merge, all in the app.
- **Limits:** single-user.
- **Traction:** 6,272★, v1.2.11 (2026-11-06).

#### Agent Orchestrator (OrchestratorInc/agent-orchestrator, formerly ComposioHQ)
- **What it does:** Apache-2.0, Go and TS. A planner agent splits work into workers, each with its own worktree and branch. Supports 35+ agents. https://github.com/OrchestratorInc/agent-orchestrator
- **Board lanes:** **Working / Needs you / In review / Ready to merge.**
- **Feedback routing:** failed checks, review comments and merge conflicts go back to the worker that owns the branch.
- **Limits:** no trackers.
- **Traction:** 14,850★.

#### Groundcrew (ClipboardHealth/groundcrew)
- **What it does:** MIT, single-user CLI. Intake from Linear by default (an `agent-*` label routes the issue), plus Jira and local files. https://github.com/clipboardhealth/groundcrew
- **Execution:** Claude Code, Codex, Cursor or Pi in tmux, cmux or zellij panes, with a worktree per task and optional sandboxing.
- **Verbs:** `crew stop`, `crew resume` (or `--new`), and `crew open` on an existing PR.
- **Traction:** 68★, active.

#### Smaller and related
- **Traycer** (1,748★, MIT): assigns tickets to agents on shareable boards, with paid team sync.
- **coder/mux → coder/xum** (2,079★, AGPL): runs its own agent loop and does not drive CLIs.
- **Agentastic:** a Mac app and the only orchestrator I found that **names oh-my-pi (`omp`) as a supported agent** (https://www.agentastic.dev/agents/omp). License **unverified**.
- **Reeve** (`ianchenx/reeve`): polls Linear and keeps a **"Workpad" comment on the ticket as its checkpoint and resume state.**
- **Long tail:** about 350 entries at https://github.com/andyrewlee/awesome-agent-orchestrators. Not checked.

### C. Hosted and commercial background agents

#### GitHub Copilot cloud agent (formerly "coding agent")
- **What it does:** assign a GitHub issue to Copilot, or hand it work from Linear, Jira, Slack or Teams. It works in the background and opens a PR. https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- **Where it runs:** a GitHub sandbox on Actions, which **supports self-hosted runners**.
- **PR flow** (https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr):
  - creates a `copilot/` branch and a **draft "[WIP]" PR**, then requests your review
  - you iterate by writing **`@copilot` in PR comments**, which it acknowledges with 👀 before pushing to the same branch
  - only comments from users with write access count
  - Actions runs on its PRs need human approval
- **Limits:** one repo, one branch and one PR per task. Actions sessions are capped at 59 minutes.
- **Linear:** GA on 2026-07-23. Assign the issue or mention Copilot, progress streams to the Linear timeline, and model and branch can be set per issue or through Linear agent guidance (https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/).
- **Jira:** GA on 2026-06-25.
- **Agent HQ** (2026-02-04): you can assign issues to Claude or Codex inside GitHub (https://github.blog/2026-02-04-pick-your-agent-use-claude-and-codex-on-agent-hq/).
- **Complaints** (secondary sources, **unverified**): credit caps after billing moved to AI Credits on 2026-06-01, weak results on changes that span many files, slow startup.

#### Cursor cloud agents (formerly background agents)
- **What it does:** isolated cloud VMs with a full desktop and computer use. Started from web, desktop, mobile, Slack, GitHub or Bitbucket comments, Linear, or the API. Pushes a branch and opens a PR. https://cursor.com/docs/cloud-agent
- **Team:** teammates can view runs read-only. An admin has to enable "team follow-ups" before they can send messages.
- **Self-Hosted Machines** (2026-03-25, https://cursor.com/blog/self-hosted-cloud-agents):
  - Workers run the tool calls on your hardware and connect **outbound over HTTPS** with "no inbound ports."
  - Inference, planning and the UI stay in Cursor's cloud.
  - Packaging: `agent worker start`, a Helm chart and a K8s operator (`WorkerDeployment`), and a fleet API.
- **Linear** (https://cursor.com/docs/integrations/linear):
  - Assign the issue or mention @Cursor.
  - **Repo resolution order:** `[repo=owner/repo]` in the issue text, then a "repo" label group, then project labels, then the dashboard default.
  - Also `[branch=…]` and `[model=…]`.
- **Complaints:**
  - runs that freeze and never reach a terminal state (https://forum.cursor.com/t/cloud-agents-freeze-mid-run-and-never-reach-a-terminal-state-60-consecutive-account-wide-since-18-aug/168957)
  - the Linear integration and Linear MCP authenticate separately, which confuses users
  - opaque token cost
  - users ask for a "clarify first" stage before the agent starts coding

#### Devin (Cognition)
- **What it does:** an autonomous cloud agent you reach from Slack, Linear, Jira, the web, Desktop or the CLI. Closed source.
- **Outposts** (2026-07-22): run workloads on your own machines. Sessions wait until the outpost comes online (https://releases.sh/release/rel_vEVK8nfY4fnTwPFHRLUxM-devin-july-2026-adds-outposts-for-self-hosted-workloads-and-smarter-linear). An Enterprise VPC option is **unverified**.
- **Linear** (https://docs.devin.ai/integrations/linear):
  - triggers: assign, mention, `@skills:<name>` labels that select playbooks, or automation filters
  - its todo list syncs to Linear's plan view, the stop signal puts it to sleep, and the PR URL is posted to the session
  - since July 2026, follow-ups on the same issue continue the original session
- **Jira:** a native Jira agent since 2026-09-30.
- **Resume:** sessions can be resumed for **14 days** after they sleep, down from 30 (https://docs.devin.ai/release-notes/overview.md).
- **PR etiquette:** it edits only its own section of a PR description, and Devin Review findings go back into the session before they are posted.

#### Factory (Droids)
- **What it does:** the Droid CLI (including headless `droid exec`), plus "delegations" from web, Slack, Teams, Linear, Jira and Google Chat. Closed source.
- **Remote Control:** `droid daemon --remote-control` runs on your own Linux, macOS or Windows machine and connects out to `relay.factory.ai` using the machine's own git credentials. Default limit is 3 sessions per machine, and machines can be pooled (https://docs.factory.com/remote-control.md).
- **Airgapped:** a fully airgapped Enterprise deployment, bring-your-own-key only.
- **Linear and Jira:**
  - Delegations run as an org **service account**. It moves the issue to In Progress, opens a PR and attaches it.
  - `!connect` gives you SSH into the session's machine.
  - There is no repo picker: you name the repo in the issue (https://docs.factory.com/integrations/linear).

#### OpenAI Codex cloud
- **What it does:** cloud tasks ("cloud chats") in OpenAI-managed containers, with reusable environments: setup scripts, an internet allowlist and secrets. https://learn.chatgpt.com/docs/cloud
- **PRs:** you review the diff, then **click Create PR.** Follow-ups go in the same chat.
- **Linear** (2025-12-04, https://learn.chatgpt.com/docs/third-party/linear):
  - assign the issue or mention @Codex
  - repo: Linear suggests one, or you write "in owner/repo", otherwise it uses your last environment
  - replies in the same thread continue the chat
  - triage-rule delegations run as the **issue creator**
- **Slack:** since GA in October 2025.
- **Self-hosting:** none for the cloud product. The Codex CLI is open source and can run in your own Actions runners through `openai/codex-action`.
- **Complaints** (https://community.openai.com/tag/codex-cloud/1054):
  - "Says it created a PR but none exists"
  - credential errors when continuing old tasks
  - usage-limit storms
  - Linear "Agent did not start"

#### Claude Code: on the web, self-hosted environments, GitHub Action
- **Cloud sessions** (https://code.claude.com/docs/en/claude-code-on-the-web.md):
  - Anthropic VMs with a GitHub proxy.
  - `claude --cloud`, plus queueing a follow-up from any machine.
  - `--teleport` pulls a session into your terminal (one way only).
  - Inline diff comments go back to Claude, and sessions can be shared with the team.
  - Auto-fix subscribes to CI failures and review comments.
  - Expired VMs re-provision on reopen with the conversation restored, but background jobs are lost.
- **Self-hosted environments** (public beta on Team and Enterprise, verified at https://code.claude.com/docs/en/self-hosted-environments.md):
  - Runners register with an environment key and **poll `api.anthropic.com` outbound**.
  - A runner claims a session under a **lease, and each poll refreshes the lease and doubles as the heartbeat.** The lease lapses after about 60 s and the session is requeued.
  - **A runner locks to one owner** when it claims its first session, so code never mixes between users.
  - Flags: `--capacity`, `--drain-grace-sec`, `--retire-at`, `--release-idle-session-min`.
  - Released sessions **resume on a fresh runner on the next message, because Anthropic stores the transcript.**
  - An autoscaling orchestrator is optional.
  - The control plane stays with Anthropic.
- **GitHub Action:** `anthropics/claude-code-action` (9,995★, v1.0.278, 2026-11-16). Mention `@claude` in issues and PRs.
- **Trackers:** no first-party Linear integration. A Claude Agent for Jira exists.

#### Google Jules
- **What it does:** an async cloud agent for GitHub only, triggered by the `jules` label. It has a CLI and an API from October 2025 (https://techcrunch.com/2025/10/02/googles-jules-enters-developers-toolchains-as-ai-coding-agent-competition-heats-up). Closed source.
- **Unverified:** a read-only Linear MCP integration and CI auto-fix (both from secondary sources).

#### Other agents in the Linear directory
- **Tembo** (https://tembo.io, closed): drives Claude Code, Cursor, Codex, Amp and OpenCode. Triggered from Slack, Linear, Jira, GitHub, schedules or webhooks. Cloud, or self-hosted in your VPC (vendor claim). This is the commercial version of ostra's idea.
- **Merlin** (https://usemerlin.ai): sends delegated Linear issues to an **available teammate's** Claude Code or Codex (desktop app or CLI). Moves the issue to In Progress and then to In Review or Done. That is ostra's local-runner idea as a product. Open-source status unknown.
- **Kilo for Linear** (https://kilo.ai/docs/code-with-ai/platforms/linear): a hosted cloud agent that opens a PR linked to the issue. The extension is open source; the cloud is not.
- **Not investigated:** Comma, Kadmo, Boxes.dev, cto.new, Superconductor, Warp, Replicas, Blocks (all listed at https://linear.app/integrations/agents).

### D. The trackers' own agent platforms

#### Linear's agent platform (how a third party plugs in)
Sources: https://linear.app/developers/agents, https://linear.app/developers/agent-interaction, https://linear.app/developers/agent-signals. "Linear for Agents" launched 2025-05-20; the interaction guidelines and SDK followed 2025-07-30.

- **Install:** OAuth with `actor=app`. The app becomes its own workspace identity, is not a billable seat, and cannot request the `admin` scope.
  - Opt-in scopes: `app:mentionable` and `app:assignable`.
  - Distributing to other workspaces requires Integration Directory approval.
- **Delegation, not assignment:** "assigning" the agent sets the issue's `delegate`. The human assignee keeps ownership.
- **Sessions:** created automatically when the agent is delegated an issue or mentioned. You can also create one yourself with `agentSessionCreateOnIssue` or `agentSessionCreateOnComment`.
- **Webhook `AgentSessionEvent`:**
  - `created` carries `promptContext`, the issue, previous comments and guidance.
  - `prompted` is a user follow-up.
  - Answer the webhook within **5 s**. Send an activity or set an external URL within **10 s**, or the session is marked unresponsive.
- **Activities:** `thought`, `action`, `elicitation`, `response`, `error`. `thought` and `action` can be ephemeral.
  - Session state (`pending`, `active`, `awaitingInput`, `error`, `complete`, `stale`) is derived from the activities.
- **Signals:** `stop` from the human; `auth` (account linking) and `select` (choose an option) on elicitations.
- **Extras:** `plan` checklist (preview), `externalUrls` (the PR and a deep link to the ostra panel), and `issueRepositorySuggestions` (ranked repo guesses).
- **Relevant to reopening:** per the changelog, mentioning a third-party agent sends a follow-up to that agent's most recent session on the issue, "working or completed" (https://linear.app/changelog). This maps directly onto ostra's reopen feature (D-011).

#### Linear Agent and Coding Sessions (first party)
- **Launched:** Linear Agent on 2026-03-24, **Coding Sessions** on 2026-06-11 (https://linear.app/changelog/2026-06-11-coding-sessions).
- **What it does:** runs **Claude Code and Codex in Linear's cloud.** It returns a diff for review next to the issue, and further iterations happen "in the same thread."
- **Automation:** Triage can investigate and fix new bugs automatically. Linear says this handles about 30% of its own incoming bugs.
- **Plans:** Basic, Business and Enterprise, billed in AI credits.
- **No self-hosted or local option.** This is the most direct threat to ostra for Linear-only teams that are happy with the cloud.

#### Jira "Agents in Jira"
- **Announced:** 2026-02-24 as an open beta. GA was reportedly announced at Team '26 in May 2026; the date is **unverified** (https://community.atlassian.com/forums/Jira-articles/Introducing-Agents-in-Jira/ba-p/3194583).
- **What it does:** agents appear in the assignee dropdown, can be @-mentioned, can be triggered by workflow transitions, and get a conversation panel.
- **Partners:** Claude Agent for Jira, Devin, Factory (as a Rovo agent), Copilot.
- **Developer protocol:** third parties connect via MCP or Rovo Studio. **Unverified:** I found no developer docs for the protocol.

### E. Pivoted, archived, or building blocks
- **Sweep** (sweepai/sweep, 7,709★): pivoted from an issue → PR bot to a JetBrains plugin. The founders said autonomous "AI junior developers" are "many years out." Last commit 2025-09-18.
- **LangChain Open SWE → "Robin"** (11,232★, MIT, released 2026-03-17): its own Deep Agents/LangGraph loop, triggered from Slack, Linear or GitHub, with a persistent sandbox per thread. Self-hosting needs LangSmith Managed Deep Agents, or "fork and adapt." Not accepting contributions (https://github.com/langchain-ai/open-swe).
- **Coder** (17,411★):
  - Coder Tasks wrapped CLIs using **AgentAPI, which scraped a terminal emulator's screen.** AgentAPI was archived.
  - Tasks was removed in v2.37 (around 2026-09) in favour of **Coder Agents**, which runs its own loop in the control plane (https://coder.com/changelog/coder-2-37).
  - Lesson: **screen scraping does not hold up as agents change.**
- **Ona (formerly Gitpod):** a hosted management plane with runners in your VPC, plus Linear and Jira integrations. OpenAI announced it was acquiring Ona on 2026-06-11 (https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/). Whether the deal closed is **unverified**.
- **Herdr** (herdrdev/herdr, **Rust**, 51,569★): an agent-aware terminal multiplexer. It detects whether each agent pane is working, blocked, idle or done, resumes sessions after a restart, and has a socket API. The best Rust reference for PTY handling and agent-state detection.
- **tsk** (dtormoen/tsk-tsk, **Rust**, MIT, 172★): queues Claude Code or Codex tasks into Docker or Podman. An **egress-proxy sidecar enforces a domain allowlist.** Results come back as branches, and `--parent` chains tasks.
- **container-use** (dagger, 4,095★): an MCP server that gives each agent a container plus a branch. Experimental and quiet.
- **qm** (yc-software/qm, 15,727★, MIT): YC's self-hosted multiplayer harness built on Pi. A general harness, not ticket → PR.

---

## The gap

**Short answer:** no existing tool is open source, self-hosted, multi-user, multi-agent, fed from Linear and Jira, and running on both local and remote runners. The gap is real. It is narrower than a year ago, and each requirement exists somewhere. The nearest candidates and what each lacks:

| Candidate | Has | Lacks for ostra |
|---|---|---|
| **Multica** | team server, roles, daemon fleet on any machine, 31 CLIs, very active | **not OSI** (no-hosting clause); **own board instead of Linear/Jira**; runs never move machines; PRs left to the agent |
| **Kandev** | AGPL, Linear/Jira/GH/GL intake, local/Docker/K8s/SSH executors, Pi | no documented team accounts or permissions; small; single process (no server + runner split documented) |
| **Cyrus** | Apache, deep Linear-agent integration, 5 CLIs, cross-host resume of Claude transcripts | **one runtime per team** (no laptop + server fleet); team panel is paid SaaS; no Jira; Linear-bot UX only, no control panel |
| **OpenHands Agent Canvas** | MIT, ACP multi-agent, several backends, automations | **team, RBAC and Jira are paid Enterprise**; Canvas dials into backends (no NAT-friendly outbound runner) |
| **Nuphos** | Apache, team rooms, laptop/remote/cloud runtimes, moving conversations between runtimes | built for bots and chat, not ticket → branch → PR; no Jira; Mongo stack |
| **Vibe Kanban** | Rust, Apache, best executor layer, resume and rewind | company gone; team boards broken; no trackers; single machine |
| **Vendors** (Copilot, Cursor, Devin, Factory, Claude, Linear Agent) | polished tracker integrations, bring-your-own runners | closed control plane, one vendor's agent, credits pricing, short resume windows |

**What nobody has, and what is ostra's to own:**
1. An open-source **team control plane where the tracker is the source of truth.** Most open tools build their own board (Multica, Vibe Kanban, Nimbalyst, Kandev's kanban).
2. **A mixed runner fleet with policy:** teammates' laptops plus shared servers, owner and credential rules per runner, all through one outbound protocol.
3. **Durable task continuation across months and machines.** Today everyone either pins a task to one machine (Multica, Cyrus) or relies on a vendor-held transcript with a time limit (Devin 14 days, Claude Code).
4. **Drive Claude Code, OpenCode and oh-my-pi from day one.** Pi support is common (Sculptor, T3 Code, Paseo, Multica, OpenHands, Kandev, Groundcrew). Explicit oh-my-pi support appeared only in Agentastic.

**Honest risk:**
- **Multica is the most likely to close this gap.** It would need Linear/Jira intake (Jira is already in progress) and a relaxed license.
- **Kandev could add multi-user accounts.**
- **Linear Coding Sessions will satisfy many Linear teams** that are fine with the cloud.

ostra's case rests on open source, self-hosting, BYO agents and compute, and the tracker as the source of truth. Re-check Multica's and Kandev's changelogs before each milestone.

---

## Borrow

### Agent adapters (executors)
- **Copy Vibe Kanban's trait shape.**
  - Calls: `spawn`, `spawn_follow_up(session_id, reset_to_message_id)`, `normalize_logs → common entry stream`, `discover_options`, `availability` (installed or logged in), `setup_helper`.
  - Capability flags: fork, context usage, setup.
  - Profiles and variants: named presets per agent.
- **Drive each agent through its structured protocol.** Never scrape the screen (Coder abandoned AgentAPI for this reason).
  - Claude Code: `stream-json` in and out, plus the stdio control protocol (`can_use_tool`, `interrupt`, `set_permission_mode`) for approvals and stop.
  - Codex: `codex app-server`.
  - OpenCode: `opencode serve` (HTTP/SSE).
  - **ACP as the fallback for everything else.** VK, OpenHands, Kandev and Nuphos all use ACP. Kandev runs Pi through `pi-acp`. Whether oh-my-pi speaks ACP or needs its own SDK or RPC adapter is **unverified**; see agent-harnesses.md.
- **Store the agent's native IDs for every turn** (`agent_session_id`, `agent_message_id`), as VK's `CodingAgentTurn` does. This enables resume, rewind to a message, and fork.
- **Pin agent CLI versions on each runner** and test against them (Conductor bundles them; VK pins Codex).
- **Tolerate unknown event types.** VK's OpenCode adapter broke on a new `question.asked` event (#2088).
- **Agent status from hooks or structured events** (Emdash, Herdr). Wait until the CLI is ready before sending a prompt (Claude Squad #266).

### Runners and protocol
- **The model is Claude Code self-hosted environments with an open control plane:**
  - Outbound only: polling or WebSocket, with a lease that doubles as the heartbeat. When the lease lapses (about 60 s), the work is requeued.
  - Flags: `capacity`, `drain`, `retire-at`, and **release an idle session so it resumes elsewhere on the next message.**
  - **A runner locks to one owner** on shared machines. This directly informs Q-06 and Q-14.
- **Multica's daemon details:**
  - persistent WebSocket with polling fallback, 15 s heartbeat, reconnect grace period
  - a restarted daemon reclaims its unfinished runs
  - task-scoped tokens that expire within 24 h
  - one bare-repo cache per repo per machine and a worktree per run, cleaned up after N days
  - concurrency caps per daemon and per agent
- **Packaging:**
  - Factory's `droid daemon`: install as a systemd, launchd or Task Scheduler service.
  - Cursor's Helm chart and `WorkerDeployment` operator, for later.
  - Paseo's E2E-encrypted relay with QR pairing, for laptops behind NAT.

### Resume across time and machines (Q-07)
- **Layer three mechanisms:**
  1. resume natively on the same runner
  2. **mirror the transcript to the server** (Cyrus does this through Claude's `SessionStore` contract; Anthropic keeps transcripts server-side) and restore it on another runner
  3. **rebuild** from ticket + summary + branch diff + a `.context/` handoff file
- Notes and handoffs: Conductor's `.context/` folder, and Reeve's "Workpad" comment on the ticket (which also shows progress to ticket authors who never open ostra).
- **Recreate the worktree from the branch on reopen** (VK's `ensure_worktree_exists`), with locks per path.

### Linear and Jira
- **Be a real Linear agent:**
  - `actor=app`, delegation, `thought` within 10 s
  - ephemeral `action`s, `plan`
  - `externalUrls` with the PR and an ostra deep link
  - `select` elicitation to choose a repo (seeded by `issueRepositorySuggestions`)
  - honor `stop`
  - `auth` elicitation for per-user account linking
  - a mention on a completed session continues that session (= reopen)
- **Routing syntax inside the ticket:**
  - Cursor's order: `[repo=owner/repo]` in the text → repo label group → project labels → default
  - plus `[branch=]`, `[model=]`, and `[agent=]` (Cyrus)
  - Devin's `@skills:` labels as playbook selectors
- **Use the tracker's branch name** (Linear's `branchName`, as Emdash does).
- **Ticket status transitions:** In Progress when started → In Review when the PR opens → Done on merge (Factory, Merlin, Multica).

### PR loop
- **Open a draft PR early and link it on the ticket.** Triggers that continue work on the same branch:
  - `@ostra` in PR comments, from users with write access only, with an 👀 acknowledgement (Copilot)
  - **CI failures and review comments routed to the session that owns the branch** (Cyrus v0.2.78, Orca, Agent Orchestrator, Claude auto-fix)
- **Edit only your own section of the PR description** (Devin).
- **Verify side effects through the API** before reporting "PR created." Codex users see this claim when no PR exists.

### Workspace and UX
- **Repo-level config:**
  - setup, cleanup and archive scripts (Conductor's `.conductor/settings.toml`; VK's per-repo scripts)
  - `.worktreeinclude` for gitignored files
  - shared dependency directories (Orca `sharedDirectories`)
  - a port per workspace (`CONDUCTOR_PORT`)
  - **fetch origin before branching**
- **App-owned worktree root,** so cleanup never touches user folders (VK).
- **Queued follow-ups** while the agent runs (VK, Cyrus). Interrupt vs queue is the user's choice (Devin's side-chat).
- **Board lanes:** Working / Needs you / In review / Ready to merge (Agent Orchestrator). A "Needs you" inbox for elicitations and approvals.
- **Inline diff comments go back to the agent** (VK, Conductor, Claude, Orca).
- **Team-visible sessions,** with an admin setting for who may follow up (Cursor). Shared rooms where several people steer one task (Nuphos).
- **`ts-rs`** to generate TypeScript types from the Rust core. Useful if the web app and better-auth are in TypeScript (Q-04).
- **Isolation:** an egress allowlist proxy on remote runners (tsk). Worktrees are not a sandbox; Conductor and Paradev both say so.

---

## Avoid

- **Depending on a vendor or hosted relay that can disappear.**
  - VK's remote access depended on `cloud.vibekanban.com`, and its team boards died with the company. v0.1.44 then broke even self-hosted Projects ([#3396](https://github.com/BloopAI/vibe-kanban/issues/3396)).
  - Conductor (closed source) left users unable to fork it.
  - **Everything ostra needs must run inside the customer's own deployment.**
- **Tying data to a cloud service.** VK users had to rely on data export, pin old versions or use community migration scripts.
- **UI rewrites that drop workflows people use.** VK's most-commented issues are "Bring back old UI" ([#2687](https://github.com/BloopAI/vibe-kanban/issues/2687), 39 comments), "New UI… worst UX" (#2300) and "Can we get back the local only projects?" (#3354).
- **Fragile agent adapters:**
  - VK's OpenCode failures: server didn't print its URL (#2077), unknown SDK event (#2088), "opencode error" (#2134, #3016)
  - Codex login problems (#1374)
  - Claude Squad: prompts lost to tmux races
  - Coder: screen scraping
- **Disk bloat from leaked worktrees and containers.** VK #765 (configurable cleanup) and OpenHands #7914 (containers filling the disk).
- **Zombie runs that never reach a terminal state** (Cursor forum, Codex). Use leases, timeouts and an explicit error state shown on the ticket.
- **Security mistakes seen in Cyrus's issue tracker:**
  - secrets visible in child-process command lines (#1526, #1439)
  - triggers from a public GitHub repo with no author check (#1543)
  - worktree collisions across repos with the same PR number (#1518)
  - no batching or 429 handling for Linear activity calls (#1490)
  - silently falling back to the first repo (#1437)
  - orphaned agent processes (#1479)
  - re-delegating an issue starts nothing (#1600)
- **Security mistakes elsewhere:** Open Session trusts anyone on the network. VK runs agents with skip-permissions by default.
- **Putting team features behind the paid edition** (OpenHands Enterprise) or using a non-OSI license (Multica). Both cause friction with self-hosters and contributors. Decide Q-02 early and stick to it.
- **Short or vague resume windows** (Devin 14 days; Claude cloud loses background jobs). If ostra promises "reopen months later," it has to work after a runner is wiped.
- **Token overhead.** Cyrus warns of 3–5× the tokens of running Claude Code locally. Keep orchestration prompts lean and show cost per task and per merged PR.
- **Two auth paths for one integration** (Cursor's Linear integration vs the Linear MCP).
- **Jumping straight to code.** Users ask for an optional clarify or plan stage, which maps to Linear elicitation.
- **Scope sprawl and churn.** Orca has 8.5k open issues and T3 Code 3.5k open issues. Teams say review is the bottleneck: people run 5–8 agents reliably, not 50.
- **Platform gaps:** Conductor and Sculptor are macOS-only, and Claude Squad is broken on Windows. ostra's runner should run on Windows from day one; the user is on Windows.
- **Treating worktrees as a security boundary.** They isolate files, not the machine.

---

## Differentiation for ostra

Where ostra could credibly be the best option:

1. **The open, self-hosted team control plane that treats Linear and Jira as the source of truth.** ostra would be a real Linear agent (sessions, activities, elicitation, delegation), a Jira agent later, and a web panel for the team. No open tool does both well: Cyrus has the Linear depth without a team panel, and Multica has the team panel without Linear.
2. **A mixed fleet of BYO runners under one outbound protocol.** Teammates' laptops and shared servers sit behind NAT. Runner policy covers owner locks, whose credentials are used (Q-06), capacity, and drain. Vendors offer this only for their own agent and with their own control plane. Open tools either pin to one runtime (Cyrus) or have no policy layer.
3. **Durable, long-lived tasks.** "Reopen in three months and keep going on the same branch and PR" holds even when the original runner is gone, through three layers: native resume, then transcript mirroring, then rebuild from ticket + summary + diff. This answers Devin's 14-day window, Multica's no-migration rule and Cyrus's lost context when switching runtimes.
4. **Agent-neutral from day one:** Claude Code, OpenCode and oh-my-pi through native protocols, with ACP as the generic path. ostra could be the first team tool to support oh-my-pi properly, and could switch agents mid-task through the rebuild layer (Q-08).
5. **A Rust core with a small cross-platform runner binary** that runs on Windows, macOS and Linux with low overhead on laptops. Vibe Kanban proves the Rust backend; Herdr and tsk prove Rust PTY handling and container work. Most competitors are Electron, TypeScript or Go.
6. **Team governance, which single-user tools lack:**
   - an audit log of who prompted what
   - explicit PR authorship policy (Q-10)
   - approvals in the panel (Q-13)
   - shared visibility with follow-up permissions
   - cost per task with BYO credentials, an advantage over credit-priced SaaS
7. **Trust story:** a clear OSI license, no hosted dependency, no telemetry by default. This matters more after the Terragon, bloop, Conductor and Ona exits.

### Recommendation on Vibe Kanban
- Use it as a **reference implementation and a source of code** for adapters and worktrees (Apache-2.0).
- **Do not fork the product or bet on contributing upstream.** Its architecture is a single-machine app with a broken team layer and thin maintenance.
- When extracting `executors`, note two costs: it pins Codex protocol crates to a git tag, and the workspace requires Rust nightly.

---

## Open items and unverified

- Conductor's real end state after the Meta deal: the "isn't shutting down" note (2026-11-13) contradicts press reports.
- Paseo's license (NOASSERTION; Apache vs AGPL). Orca's team features. Which parts of Paradev are closed.
- Whether Kandev has multi-user accounts and permissions, and whether it syncs status back to Linear and Jira.
- Whether Cyrus supports more than one runtime per team (v0.2.79 hints at Slack replies "from [owner]'s device").
- How Nuphos runtimes connect and how it creates PRs.
- Whether the Ona acquisition closed. Devin's VPC option. Factory and Devin pricing. Jira Agents GA date and developer protocol.
- Whether oh-my-pi supports ACP (does `pi-acp` work with `omp`?). Cross-check with agent-harnesses.md.


## Addendum 2026-11-18: Omnara (omnara-ai/omnara)

Checked on 2026-11-18 against the repo, its README and https://docs.omnara.com/llms.txt.

- **What it is now:** "The open-source managed agent platform. A self-hostable alternative to Claude Managed Agents and OpenAI's Agents API" (https://github.com/omnara-ai/omnara). It pivoted from its 2025 origin as a mobile companion for Claude Code.
- **License and activity:** Apache-2.0, about 3.4k stars, release `cluster-v0.2.25` on 2026-11-18. Very active.
- **Stack:** a Go backend and a TypeScript frontend. Runs on Postgres, Redis, blob storage and a memory filesystem.
- **The key difference from ostra:** Omnara runs **its own agent loop**, calling model APIs directly with the customer's keys (OpenAI, Anthropic, OpenRouter, Bedrock, Ollama and others). It doesn't drive Claude Code, Codex or other harnesses. It presents itself as what harness users move to: "Cloud agents that run as a service, across machines and users". Claude Code only connects to it as an MCP client, to launch Omnara agents.
- **Architecture:**
  - an API, plus a Postgres event log that is each agent's state, so any worker resumes after a crash without rerunning tools
  - stateless workers that run the loop
  - "machines": an `omnarad` daemon that connects outbound, from a laptop, VM or container
  - sandboxes from twelve providers: Agent37, Arker, Blaxel, boxd, CreateOS, Daytona, E2B, Freestyle, Modal, Superserve, Tenki and Unikraft
  - an agent can move from an offline laptop to a sandbox and sync its work through git
- **Also:** ask, allow or block permissions per tool; streaming and webhooks; live config changes; cron schedules; Slack, Discord and GitHub integrations; role-based access; multi-tenancy; a REST API, SDK, CLI and MCP server.
- **Trackers:** none. There's an example coding agent for Slack and GitHub that opens PRs.
- **What it means for ostra:**
  - It validates ostra's architecture almost point for point: ADR 0011, 0012 and 0010, and F-026.
  - It can't be ostra's base, for four reasons:
    - it would replace Claude Code with Omnara's loop on API keys, which contradicts ADR 0004, ADR 0018 and the maintainer's "we only have Claude Code"
    - it's Go (ADR 0008)
    - it's heavier to self-host
    - its product direction overlaps ostra's
  - Ideas worth borrowing:
    - elastic sandbox runners from providers
    - pools of machines
    - schedules
    - moving work from an offline laptop to a sandbox
  - A possible later agent adapter, for teams that want any-model agents on API keys.
