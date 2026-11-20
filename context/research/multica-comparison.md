# Research: Multica compared with ostra, feature by feature

**Status:** Research v1 · **Checked:** 2026-11-20 (every source below was read on this date) · **Informs:** the launch scope (`build-order.md`, "After v1" and "What slips first"), F-018, F-038, F-009, F-121, F-074, F-057, F-011 and F-106 (ADR 0056), F-021, F-125. Nothing here is a decision. The lead will take it to the maintainer.

**Question.** The maintainer, 2026-11-20: "so what does https://multica.ai/docs do better or different from us? what important features are we missing?"

**How it was read.**
- **Multica's docs:** every English page a Tavily map of `multica.ai/docs` listed, read with `tavily_extract`. That covers getting started, concepts, workspaces, roles, sign-in and tokens, agents, the coding-tool matrix, the daemon and runtimes, runs, environments, the security model, issues, comments, mentions, projects and their resources, workflows, quick actions, squads, chat, the inbox, autopilots, wakeups, skills, analytics, GitHub and self-hosted Git, chat integrations, desktop, mobile, the CLI, environment variables, search, themes, troubleshooting and the architecture page. The Chinese copies weren't read.
- **Multica's site:** the home page, `/licensing`, `/about` and `/changelog` (through v0.9.0). `/pricing` couldn't be fetched.
- **The repo, `multica-ai/multica` on `main`:** `README.md`, `LICENSE`, `VISION.md`, `SELF_HOSTING.md`, and `server/ee/README.md` with its `LICENSE`. Through GitHub's public API: the repo's metadata, the release notes of v0.10.0 to v0.11.1, and the issues and PRs cited below.

**Markers.** Facts about ostra come from this repo; an F-ID and its status are from `context/features.md` on this date. **Unconfirmed** marks anything no primary source confirmed. *(inference)* marks my own reasoning, and sizes are *(estimates)*: S is a ticket or two, M a handful of tickets, L a slice of a milestone.

**Builds on** `research/landscape.md`, whose "Multica" entry was checked on 2026-11-17. It isn't repeated here, except where something changed.

---

## Summary

- **Multica is a team issue board where coding agents are assignees** [M-CONCEPTS; GH-README]. A daemon on any machine drives one of 31 agent CLIs, each already logged in there [GH-README; M-INST]. It's shipping: v0.11.1 came out on 2026-11-19, it has 56,904 stars, and it releases "most weekdays" [GH-API; GH-README].
- **Where Multica is ahead:**
  - **Agent breadth.** 31 CLIs against ostra's one, OpenCode, at launch.
  - **Coordination.** Squads, workflow handoffs, wakeups, and autopilots fired by webhooks.
  - **Reach.** Six chat platforms, a desktop app, an iOS app, a CLI that covers nearly everything, and PATs.
  - **Previews.** A dev server's link shows in the issue's sidebar, and members can start and stop it there.
  - **Skills.** A managed library, with imports from GitHub, ClawHub and skills.sh.
- **Where ostra is ahead:**
  - **Isolation.** Multica "makes no filesystem-sandbox guarantee" and runs Claude Code with `bypassPermissions` [M-SEC].
  - **Credentials.** Multica stores an agent's `custom_env` in plaintext in its database [M-AGC].
  - **PRs.** Multica's agents push with the machine's own git credentials [M-VCS].
  - **Durable tasks.** A Multica run is bound to its runtime and never moves to another machine [M-ASSIGN].
  - **Spend.** Multica's costs are estimates from what each tool reports, and there are no budgets; spend caps are an open request [M-ANALYTICS; GH-4076].
  - **Approvals and the tracker.** Multica auto-answers every approval [M-SEC], and still has no Linear or Jira [GH-1634].
- **Since landscape.md (2026-11-17):**
  - v0.11.0 started an open-core split. `server/ee/` and `packages/ee/` sit outside the Multica License, under a commercial placeholder: until its text is final, "no license is granted" [GH-LICENSE; GH-EE].
  - v0.11.1 added Free, Pro and Business plans for its cloud [GH-R0111].
  - Jira is still missing. Both Jira PRs were closed unmerged [GH-5919; GH-10235].
- **The ten missing features that matter most to a team running agents on its own machines,** ranked in section 4:
  1. a second agent, Claude Code or Codex;
  2. GitLab and self-hosted Git;
  3. live previews;
  4. a public API and PATs;
  5. inbound webhook triggers;
  6. two-way Slack;
  7. event-driven follow-ups;
  8. a skills and MCP library;
  9. agent-to-agent handoffs;
  10. one-click laptop onboarding.
- **Two of them are worth weighing before launch:**
  - **A second agent:** the plan exists and is postponed (ADR 0062).
  - **Inbound webhook triggers:** small, and they fit ADR 0056's automations.
- **One small fix should go before launch:** a repo's own skills don't reach the agent (`research/skills-and-mcp-marketplaces.md`, summary 5, inferred from source).

---

## 1. What Multica is today

**The product.**
- **The shape.** A workspace holds members, issues, projects, agents, skills, runtimes and automations. Workspaces are fully isolated from each other [M-WS].
- **Agents on the board.** An agent is "a reusable configuration: name, instructions, model, skills, Access, and runtime". It runs only when triggered: by an assignment, an @-mention, a chat or an autopilot [M-CONCEPTS; M-HOW].
- **Its pitch:** "Agents that show up on the board", and "Your next 10 hires won't be human" [GH-README].

**The agents.**
- **31 CLIs.** They include Claude Code, Codex, Cursor, Copilot, OpenCode, Pi, Oh-My-Pi, Devin CLI, Amp and Factory Droid [GH-README; M-PROV]. The home page's FAQ still says 29 [M-HOME].
- **Each CLI's own login.** Multica drives the CLI "already installed and signed in", and "never receives login tokens from Claude, Codex, Cursor, or any other CLI" [M-INST]. Runtime pages show how much of a Claude Code or Codex plan's 5-hour and weekly windows is used [M-DAEMON].
- **Per tool,** the matrix records session resumption, MCP managed by Multica, model choice and the skill path [M-PROV].

**The runtimes.**
- **One runtime per machine and CLI.** A daemon on a laptop or server connects to the server, claims runs and invokes the CLI. A runtime is one machine plus one CLI [M-DAEMON].
- **Timings.** The daemon sends a heartbeat every 15 s, and a runtime counts as offline within about 3 minutes. A queued run waits for its own runtime, and an in-progress run fails after a 3-hour grace [M-DAEMON; M-RUNS].
- **Cloud options.** Multica's cloud also offers "managed cloud sandboxes" [M-HOME]. A self-hosted install can add Qoder Cloud Agents as a remote runtime [M-DAEMON].

**The board.**
- **Issues** carry statuses (seven built in, plus custom ones), up to 20 custom properties, sub-issues with stages, and five layouts, Gantt included. Views can be saved [M-ISSUES].
- **Projects** group issues, link repos or local folders, can be private, and choose a workflow [M-PROJ; M-RES; M-WF].

**Integrations.**
- **Code hosts.** A read-only GitHub App links PRs, and self-hosted Forgejo, Gitea or GitLab can be connected [M-GH; M-VCS].
- **Chat:** Feishu/Lark, Slack, DingTalk, WeCom, Telegram and WeChat [M-CHAN]. DingTalk, WeCom and Telegram are community-maintained, with no support SLA [M-COMM].
- **Tools:** Composio connections [M-ENV], and a Plugin Public API [GH-7446; GH-7450].

**The licence and the pricing.**
- **The Multica License** is Apache-2.0 plus conditions. A hosted service for third parties, or embedding Multica in a product you sell, needs a commercial licence. The Multica logo, name and attribution must stay [GH-LICENSE; M-LIC].
- **Internal use is free,** "including self-hosting it for your whole team" [M-LIC].
- **The open-core split.** Since v0.11.0, `server/ee/` and `packages/ee/` are excluded from that licence. Their commercial licence is "being finalized", and until then "no license is granted". Today they hold project folders [GH-LICENSE; GH-EE; GH-R0110].
- **The cloud's plans.** A Free workspace has up to 5 members. Pro and Business are charged per seat, and a self-hosted workspace has no member limit [M-ROLES]. v0.11.1 added checkout by plan and a "no-card Business trial" [GH-R0111].
- **Prices are unconfirmed.** `/pricing` couldn't be fetched. Two reviews (secondary) also found no published prices [SEC-PQ; SEC-TULSK].
- **The private-project limit.** A plan can block new private projects [M-PROJ]. Whether that limit applies on self-hosted installs is **unconfirmed**.

---

## 2. Area by area

| Area | Multica | ostra (F-ID, status) | Ahead |
|---|---|---|---|
| **Tracker and issues** | <ul><li>Its own board: custom statuses and properties, five layouts, saved views, sub-issues in stages [M-ISSUES].</li><li>No Linear.</li><li>Jira has been asked for since 2026-04, with 25 👍 [GH-1634]. A Jira Cloud PR was closed unmerged [GH-5919], and so was a plugin-based Jira example [GH-10235].</li></ul> | <ul><li>Linear stays the source of truth: connect (F-005, building), boards (F-007, building), the inbox (F-010, building), ticket sync (F-031, building), agent mode (F-012, building), sub-issues (F-077, building).</li><li>Prompt tasks need no tracker (F-097, building).</li><li>Jira comes after v1 (F-008, later).</li></ul> | Different by design (`project.md`, "Not a tracker"). ostra for Linear teams, Multica for teams with no tracker. |
| **Agents** | <ul><li>31 CLIs on their own logins [GH-README; M-INST].</li><li>Per agent: a model, a thinking level, skills, MCP, environment variables, CLI arguments, and a concurrency cap of 6 by default [M-AGC].</li><li>An Agent Builder can write the configuration [M-AGC].</li></ul> | <ul><li>OpenCode only through launch (F-019, building).</li><li>Claude Code, Codex, oh-my-pi and more come after v1 (F-018, F-038, F-020, F-022, later).</li><li>Agent profiles (F-021, building); reasoning effort (F-137, done).</li><li>Provider keys only, with no subscription login (ADR 0030).</li></ul> | **Multica**, clearly. |
| **Where the agent runs, and isolation** | <ul><li>A daemon on any machine [M-DAEMON].</li><li>"Treat every run as unsandboxed"; a run has "the full permissions of the operating-system user running the daemon". Codex runs with `danger-full-access` and Claude Code with `bypassPermissions` [M-SEC].</li><li>The task token sits in the process's environment, and every child inherits it [M-DAEMON].</li><li>A request for an official sandboxed runtime image was closed with documentation only [GH-10354].</li></ul> | <ul><li>Pools and join tokens (F-091, done), personal runners (F-014, building).</li><li>The `docker`, `kubernetes` and `host` executors (F-017, planned; F-093, building).</li><li>A box per task whose sidecar holds the keys, with a key proxy and a git proxy (F-089, F-090, building) and an egress baseline (F-116, building).</li><li>`host` is labelled "not isolated" (ADR 0029).</li></ul> | **ostra** |
| **Steering and approvals** | <ul><li>A reply can "Add to current run", "Start after this run", "Stop and start over", or not start the agent. It needs the CLI's support [M-MENTION].</li><li>An agent can send a correction into another agent's running run [M-CL v0.7.2].</li><li>"Approval prompts are answered automatically" [M-SEC].</li></ul> | <ul><li>Steer with queue or interrupt, and take over as driver (F-024, building); stop (F-025, done).</li><li>Approval rules per profile (F-026, building); plan first (F-063, building).</li><li>"Needs you" on Home (F-062, building).</li></ul> | Steering: even. Approvals: **ostra**. |
| **Review and PRs** | <ul><li>Agents push branches and open PRs "using the runtime host's own Git credentials" [M-VCS].</li><li>The GitHub App "never pushes commits, comments, or status checks". It links a PR by the issue's key in its branch, title or a closing keyword, shows CI and mergeability, and moves the issue on merge [M-GH].</li><li>Review is a second agent, @-mentioned, or a workflow step [M-TUT; M-WF].</li><li>The tutorial's agent forgot the issue key, so its PR didn't link. Later it merges the PR when asked [M-TUT].</li></ul> | <ul><li>The GitHub App opens one PR per changed repo (F-030, F-098, building); checks run before the PR (F-054, building); no empty PRs (F-065, done).</li><li>The diff and its comments (F-027, F-072, building).</li><li>AI review with capped rounds (F-100, F-101, planned); fix failing CI (F-035, planned).</li><li>"Changes requested" reopens the task (F-105, done); `@ostra` on the PR (F-053, building).</li><li>No auto-merge (`project.md`).</li></ul> | **ostra** |
| **Automations and schedules** | <ul><li>Autopilots run on cron or a webhook. Webhooks get event and action filters, payload conditions, `Idempotency-Key` and replay. An autopilot creates an issue or runs only, and pauses itself when at least 50 runs in 7 days fail at a rate of 90% [M-AUTO].</li><li>Issue wakeups fire on a time, a reply, a field change, a run's end, finished sub-issues, a PR's CI, merge or conflict, another issue's state, or 25 raw events. Agents schedule their own [M-WAKE].</li><li>Chat wakeups [M-CHAT]; saved quick actions [M-QA].</li></ul> | <ul><li>Intake rules (F-011, building) and schedules (F-106, building), each started exactly once (ADR 0056).</li><li>Start many at once (F-107, building); approval for outside tasks (F-040, building).</li><li>The CI and review loops (F-035, F-101, planned).</li><li>No inbound webhook trigger, and no general wakeup.</li></ul> | **Multica** on breadth; ostra on exactly-once starts and caps. |
| **Multi-agent and subagents** | <ul><li>A squad's leader agent delegates by @-mention and is woken by replies [M-SQUAD].</li><li>A workflow hands each status to an agent, a member, a squad or the project lead, with "When done, move to" and "If rejected, send back to" [M-WF].</li><li>Agents @-mention each other, and the system merges duplicate runs but "does not decide whether the collaboration should end" [M-MENTION].</li><li>Codex's native subagents are off by default, because results from subagents still working are lost [M-DAEMON].</li></ul> | <ul><li>Refine, code and review are task kinds (ADR 0028), chained by the review loop (F-099, building; F-100, planned).</li><li>A subagent tree on the task page (F-138, planned).</li><li>Workflows as configuration come only if automations prove too rigid (F-125, later).</li></ul> | **Multica** |
| **Skills, MCP and memory** | <ul><li>Workspace skills imported from GitHub, ClawHub or skills.sh, updated from their source, with a version history (v0.8.1). They are "not sandboxed" or reviewed [M-SKILLS; M-CL v0.8.1].</li><li>MCP per agent, plus a workspace MCP library whose configuration is write-only [M-AGC]. The machine's own MCP config is merged in [M-DAEMON].</li><li>A workspace "Context" goes to every agent [M-WS]. No memory feature is documented, and Codex's own memory is off by default [M-DAEMON].</li></ul> | <ul><li>A profile carries skills and MCP servers, and an HTTP MCP server's secret stays in the sidecar (F-021, building; ADR 0049).</li><li>Memory notes, an index and MCP search for agents, and proposals a member approves (F-109, F-111, building; F-110, planned).</li></ul> | Skills and MCP: **Multica**. Memory: **ostra**. |
| **Previews** | <ul><li>Environments: the daemon finds servers listening inside a run's directory.</li><li>`.multica/environments.toml` declares `start`, `stop`, `ready` and `ttl`, with 10 ports each.</li><li>Members start, stop, restart and read the logs from the sidebar.</li><li>macOS and Linux only, and "a localhost URL opens only on the machine running it" [M-ENVS].</li></ul> | <ul><li>Seeing the running app (F-121, later, first in "Right after").</li><li>The designs are in `research/live-previews.md`.</li></ul> | **Multica**, today |
| **Notifications and chat tools** | <ul><li>An inbox with subscriptions, snooze and per-kind switches [M-INBOX].</li><li>DMs, channel mentions and `/issue` on six chat platforms [M-CHAN; M-SLACK].</li><li>System and browser notifications [M-INBOX].</li></ul> | <ul><li>"Needs you" in the panel and on the ticket (F-036, building), and by email (F-115, building).</li><li>Slack comes after v1, and only for those same moments (F-057, later).</li></ul> | **Multica** |
| **Team and roles** | <ul><li>Many workspaces per install. The roles are owner, admin and member, plus guests on selected projects [M-ROLES; GH-README]. Projects can be private [M-PROJ].</li><li>Per agent, Access is "Only me", the workspace, or specific people. Admins can't bypass it [M-AG].</li><li>A runtime is private, public, or shared with members [M-DAEMON].</li><li>Sign-in by email code or Google, with signup allowlists [M-AUTH]. No SSO is documented (**unconfirmed**).</li></ul> | <ul><li>One organization per install in v1 (F-049, planned; F-134, later).</li><li>Admin and member at two levels (F-003, planned); restricted projects (F-087, planned); profiles limited to members (F-021).</li><li>Invite links and passwords (F-002, building).</li><li>SSO, SCIM and custom roles later (F-004); the audit log (F-073, planned).</li></ul> | **Multica** today; ostra's plan is close, except guests. |
| **Self-hosting and ops** | <ul><li>Docker Compose (`make selfhost`) or Helm; migrations run at start; `/readyz` [M-SELF; GH-SELF].</li><li>Redis is optional, but shared rate limiting and the realtime relay across replicas use it [M-ENV; M-CHAN].</li><li>S3 or local disk; Prometheus metrics [M-ENV].</li><li>Telemetry is on by default, and `DO_NOT_TRACK=1` turns it off [GH-SELF]. The theme store fetches from GitHub [M-THEMES].</li></ul> | <ul><li>`docker compose up` (F-001, building); Helm charts for the server and a `kubernetes` pool (F-118, building).</li><li>Postgres is the only store (ADR 0017); no telemetry (ADR 0021).</li><li>Scale-out to 1,000 tasks (F-117, building); six guarantees and a failure suite (F-043 to F-048, building).</li></ul> | Maturity: **Multica**, which ships today. Design: **ostra**. |
| **API, CLI and IDE** | <ul><li>A CLI that covers issues, projects, agents, autopilots and the inbox, with JSON output. Agents use it inside runs with a task token [M-CLI; M-TOK].</li><li>PATs that expire after 30 days, 90 days, a year or never [M-TOK].</li><li>A Plugin Public API v1 on an OpenAPI 3.1 contract, merged 2026-08-23 [GH-7446; GH-7450]. It has no docs page: `/docs/plugins` is a 404.</li><li>A CLI skill for Claude Code, Codex and Cursor [M-CLI]; a desktop app [M-DESK]; iOS built from source [M-MOBILE].</li></ul> | <ul><li>`ostra runner` (F-013, done) and `ostra checkout` (F-103, building), behind "take it local" (F-028, building).</li><li>Attach (F-041), a browser terminal (F-029) and a public API (F-074) come later.</li><li>A responsive panel (F-075, building).</li></ul> | **Multica** |
| **Observability and spend** | <ul><li>Analytics shows cost, tokens, run time, runs, a leaderboard, and an Errors tab in seven classes [M-ANALYTICS]. Each issue has cost bars per run [M-RUNS].</li><li>Costs are estimates from the tokens the CLI reports; a CLI that reports none adds no cost. Custom prices are kept only on one device [M-ANALYTICS].</li><li>No budgets: caps are open requests [GH-4076; GH-7536].</li></ul> | <ul><li>The key proxy counts every call (F-089, building); usage per task (F-084, building).</li><li>Spend, with budgets that warn at 80% and stop at 100% (F-037, building).</li><li>Insights (F-108, done); live activity (F-023, done).</li></ul> | Spend: **ostra**. Failure analytics: **Multica**. |
| **Pricing and licence** | <ul><li>The Multica License, with `ee/` under a commercial licence [GH-LICENSE; GH-EE].</li><li>Free internal use; cloud plans per seat [M-LIC; M-ROLES].</li></ul> | <ul><li>The SUL for the server and panel; Apache-2.0 for the runner, protocol, adapter SDK, adapters and docs (ADR 0048).</li><li>No hosted version (ADR 0001).</li></ul> | Even: both are source-available. |

---

## 3. What Multica does better or differently

**Better, with the evidence, and why it matters to a team:**

1. **The agents the team already uses, signed in as they are.**
   - 31 CLIs, and "switching providers is a dropdown, not a migration" [GH-README]. The machine's own login is used, and plan limits show on the runtime page [M-INST; M-DAEMON].
   - *Why it matters:* nothing to buy and nothing new to learn. Multica's home page leads with "Turn Claude Code, Codex, Hermes, or OpenCode into a teammate" [M-HOME].
   - ostra uses keys on purpose: Anthropic's terms forbid third-party tools from passing on subscription credentials (ADR 0014, ADR 0030). The gap that counts is the number of agents, not the logins.
2. **Low ceremony to pull an agent in.**
   - Plain replies route to the agent in the thread. A trigger preview shows who will start, `/note` starts nobody, and consecutive comments merge into one pending run [M-MENTION; M-COMMENTS].
   - *Why it matters:* a second agent, a reviewer, is one @-mention away.
3. **Coordination without a person in the middle.**
   - Squads route work through a leader agent [M-SQUAD]. Workflows hand each step to its owner [M-WF]. Wakeups bring an agent back when CI finishes, a PR merges, someone replies or a time comes [M-WAKE].
   - *Why it matters:* work that waits on people, on CI or on other issues keeps moving.
4. **Automations from any outside event.**
   - Webhook triggers parse GitHub and GitLab events, take payload conditions and an idempotency key, and record every delivery for replay [M-AUTO].
   - *Why it matters:* a Sentry alert or a failed pipeline on `main` can start work.
5. **The running app beside the issue.**
   - Detected and declared environments, with start, stop and logs in the sidebar [M-ENVS].
   - *Why it matters:* web teams review the result, not only the diff.
6. **Skills and MCP as a managed library.**
   - Imports from GitHub, ClawHub and skills.sh are updated in place and keep a version history. Each run carries a "Context received" receipt [M-SKILLS; M-CL v0.8.1, v0.9.0]. A workspace MCP library keeps its secrets write-only [M-AGC].
7. **It meets people where they talk.**
   - Six chat platforms [M-CHAN], desktop and iOS [M-DESK; M-MOBILE].
   - Docs in English plus four languages [GH-README], and an app translated into more, Spanish and Russian among them [M-CL v0.8.1, v0.8.2].
8. **Everything is scriptable.**
   - A full CLI with PATs. Agents drive Multica through the same CLI, under their own task token [M-CLI; M-TOK].
9. **Onboarding in minutes.**
   - Desktop registers the machine and detects its CLIs [M-QS]. "Let AI write it" drafts an agent [M-AGC]. "Create with agent" turns a sentence into an issue [M-ISSUES].
10. **Self-hosted Git.**
    - Forgejo, Gitea and GitLab, offered on self-hosted installs only, because "you usually self-host Multica so it can reach a Git instance on your own network" [M-VCS].
11. **Traction.**
    - 56,904 stars, and the latest release is v0.11.1 of 2026-11-19 [GH-API].

**Different, and weaker for a team running agents on its own machines** *(inference, from the sources cited)*:
- **The boundary is the daemon's OS user.** "If the daemon runs as your personal user account, a run can read your SSH keys" [M-SEC]. A run's token is inherited by every child process it starts [M-DAEMON].
- **Secrets are stored in the clear.** `custom_env` values are plaintext in the server's database [M-AGC].
- **PRs depend on the agent.** The machine's git credentials push, and the link depends on the agent writing the issue key [M-VCS; M-TUT]. Users report agents that don't open PRs reliably (`landscape.md`).
- **Runs don't move machines.** A run is bound to its runtime [M-ASSIGN]. Codex sessions are deleted after 14 days unused, and managed run folders 14 days after completion [M-DAEMON]. Queued runs do follow an agent that is rebound to another runtime [M-CL v0.8.1].
- **Costs are estimates.** A CLI that reports no tokens adds no cost [M-ANALYTICS].
- **Data leaves by default.** Telemetry is on unless `DO_NOT_TRACK=1` [GH-SELF], and a server-side LLM writes chat titles when it's configured [M-ENV].

---

## 4. What ostra is missing, ranked

Ranked by impact for ostra's target user, a team running coding agents on its own infrastructure. Each row is checked against the ledger, so nothing here is something ostra has under another name. What ostra rejected on purpose is listed below the table.

| # | Missing | Impact | Size | Where it sits in ostra's plan | Before launch? |
|---|---|---|---|---|---|
| 1 | **A second agent: Claude Code on keys, then Codex** | High: most teams already pick Claude Code or Codex, and Multica names both first [M-HOME] | M: ADR 0062 is written, and milestone 7's tickets 06, 07 and 10 exist, marked `wontfix` | F-018 and F-038: after v1, "Right after" | **Revisit.** It's the strongest case of the ten. Ask whether F-018 returns to milestone 7. |
| 2 | **GitLab, and self-hosted Git** | High for GitLab shops, who can't use ostra at all. Multica offers it for exactly this reason [M-VCS] | L: a code-host adapter, its auth, and the git proxy | F-009: after v1, "Then" | No. Move it up to "Right after", next to Jira. |
| 3 | **A live preview of the running app** | High for web work: review the result, not the diff | L: the proxy, the origin and the browser stream (`research/live-previews.md`) | F-121: after v1, first in "Right after" | No. Keep it first after launch. ostra's design reaches a remote box, which Multica's localhost links don't [M-ENVS]. |
| 4 | **A public API, PATs and a scriptable CLI** | High for platform teams who wire ostra into CI and their portals | M to L: publish a REST contract over the domain, plus PATs | F-074: after v1, "Then" | No. Move it to "Right after". Keep v1's API clean, as F-074 asks. |
| 5 | **Inbound webhook triggers for automations** | Medium to high: "an alert or a failed pipeline starts a task" is the autonomy story [M-AUTO] | S to M: a third trigger kind beside rules and schedules, using ADR 0056's one-start-per-occurrence key | Not planned: ADR 0056 has rules and schedules only | **Consider, for milestone 6.** It needs a new F-ID and the maintainer's word. |
| 6 | **Two-way Slack: start a prompt task, answer "needs you"** | Medium: Linear agent mode (F-012) covers the tracker, but not chat | M | F-057 is after v1, and covers notifications only; two-way isn't planned | No. Widen F-057's scope after launch. |
| 7 | **Event-driven follow-ups: come back when X happens** | Medium: an agent that waits on a reply, a merge, CI or a time [M-WAKE] | M for a general version | Partly v1: CI rounds (F-035), "changes requested" (F-105), `@ostra` (F-053). F-034 and F-071 are later and unordered | No for a general version. F-071, conflicts fixed by itself, is small (it reuses F-070) and could move. |
| 8 | **An organization library of skills and MCP servers, imported by reference and updated** | Medium; the maintainer asked about it on 2026-11-20 | M | No ledger row. `research/skills-and-mcp-marketplaces.md` recommends it, in four steps | Fix the repo-skill gap before launch (S, if the inference holds). The library comes after v1. |
| 9 | **Agent-to-agent handoffs: workflow steps, squads** | Medium: a team's own process across agents [M-WF; M-SQUAD] | L | F-125 is later ("Later still") and conditional; squads aren't planned | No. ostra's review loop covers code, review and fix. Revisit with real use. |
| 10 | **One-click laptop onboarding** | Medium: Desktop joins a laptop with no terminal [M-QS] | L for an app; S for a one-line `ostra runner` join | F-014 is v1 (npm CLI); F-085 signed binaries are "Right after" | No app. Do make the personal-runner join a single copy-paste command in the docs (F-058). |

**Smaller gaps, not ranked:**
- **Sign-in through an outside account.** Multica has Google sign-in [M-AUTH]. ostra's F-004 (GitHub, OIDC or SAML) is later.
- **Guests on selected projects** [GH-README]. Not planned. It's relevant to ostra's clients-as-projects model (ADR 0065).
- **Failure reasons in Insights.** Multica's Errors tab sorts failures into seven classes [M-ANALYTICS]. Not planned; it could join F-108.
- **Quick actions, saved prompts on a task** [M-QA]. Not planned.
- **A run's "context received" receipt** of the skills, MCP servers and instructions it got [M-SKILLS; M-CL v0.9.0]. Partly planned: the task page lists the memory notes a session used (F-110).
- **Shipped translations.** ostra is translatable (F-083, done), with English text only; Multica ships several languages [GH-README].

**Not counted: ostra rejected these on purpose, or has them under another name.**
- **Rejected on purpose:**
  - Its own issue board, custom statuses and properties, saved views and Gantt (`project.md`, Non-goals: "Not a tracker").
  - Subscription logins (ADR 0014, ADR 0030).
  - Server-side model calls for titles and follow-up questions [M-ENV]: ostra "never makes a model call of its own" (`project.md`).
  - Agents that merge PRs [M-TUT] ("No auto-merge").
  - Agents that rewrite their own instructions [M-TUT]. Nothing an agent writes reaches memory without a member (`project.md`, principle 6; F-111).
- **Under another name:**
  - Private 1:1 chat [M-CHAT] is close to prompt tasks (F-097) and refine tasks (F-099). Only the privacy differs: v1 has no private tasks (F-003).
  - Automatic retries [M-RUNS] are ostra's guarantees (F-045, F-047).
  - Concurrency caps [M-AGC] are F-067.
  - Several repos per project [M-RES] are F-086 and F-098.

**No evidence says the own-board decision should be revisited.** Multica's Jira request has 25 👍 and 12 comments, and is still open [GH-1634]. Its users want their tracker connected, not replaced *(inference)*.

---

## 5. Where ostra is ahead

- **Isolation and credentials.**
  - Each task gets its own box, and its sidecar holds the keys. The agent sees a fake key, and the git proxy accepts only the task's branches (ADR 0029, ADR 0030; F-089, F-090).
  - Multica puts the boundary "outside the daemon" and asks the user to supply it [M-SEC]. Users ask for a sandboxed runtime, and got documentation [GH-10354].
- **Approvals and plan first** (F-026, F-063), against approval prompts "answered automatically" [M-SEC].
- **PRs that don't depend on the agent.**
  - ostra's App opens them. Checks run before the PR, there are no empty PRs, and there's one PR per repo (F-030, F-054, F-065, F-098).
  - Multica leaves the push and the link to the agent [M-VCS; M-TUT].
- **Long-lived tasks.**
  - A task reopens months later on a fresh box (F-032, F-033; ADR 0039).
  - A Multica run is bound to its runtime [M-ASSIGN], and its run folders and Codex sessions expire after 14 days [M-DAEMON].
- **Metered spend with budgets.**
  - Every call is counted at the key proxy and priced from models.dev. A budget warns at 80% and stops new work at 100% (F-037, F-089; ADR 0042).
  - Multica's costs are estimates, its custom prices live on one device, and it has no budgets [M-ANALYTICS; GH-4076].
- **The tracker as the source of truth.** Linear in v1, with agent mode and sync (F-005, F-012, F-031). Multica has neither Linear nor Jira [GH-1634; GH-5919].
- **Review loops with caps.** AI review, CI fix rounds, and at most 4 automatic turns before a person (F-035, F-100, F-101; ADR 0041).
- **Memory that a member approves** (F-109 to F-111; ADR 0044). Multica has a workspace "Context" text [M-WS].
- **A `kubernetes` executor:** a pod per task (F-093). Multica's Helm chart installs the server; agents run wherever a daemon runs [GH-SELF; M-DAEMON].
- **Privacy by default.** No telemetry (ADR 0021), against Multica's daily snapshot, sent unless `DO_NOT_TRACK` is set [GH-SELF].
- **One store.** Postgres is the only store (ADR 0017). Multica uses Redis for its cross-replica relay, and a WeCom bot without Redis must run on a single replica [M-CHAN; M-ENV].
- **Several clients in one organization.** Each project spends only its own client's model keys (F-135; ADR 0065).

---

## 6. Questions for the maintainer

1. **One agent at launch.** Multica leads with Claude Code and Codex, and ostra launches with OpenCode alone. F-018's plan is written (ADR 0062, milestone 7's tickets 06, 07 and 10). Should Claude Code on keys return to milestone 7, or ship as the first release after launch, with a date?
2. **Webhook triggers.** Should automations get a third trigger, an inbound webhook with filters and an idempotency key, in milestone 6? That's a new F-ID.
3. **GitLab.** Move F-009 from "Then" to "Right after", beside Jira, for teams on self-hosted GitLab?
4. **Slack.** Should F-057 stay notifications only, or become two-way: start a prompt task and answer "needs you" from Slack?
5. **Repo skills.** Should the repo-skill gap fix (`research/skills-and-mcp-marketplaces.md`, summary 5) land before launch?
6. **Guests.** With clients as projects (ADR 0065), should a client's own people get guest access to their project? Multica has guests.

---

## Sources

**Multica docs and site** (read 2026-11-20)

- [M-HOME] https://multica.ai/
- [M-CONCEPTS] https://multica.ai/docs/concepts
- [M-HOW] https://multica.ai/docs/how-multica-works
- [M-TUT] https://multica.ai/docs/tutorial
- [M-QS] https://multica.ai/docs/cloud-quickstart
- [M-SELF] https://multica.ai/docs/self-host-quickstart
- [M-WS] https://multica.ai/docs/workspaces
- [M-ROLES] https://multica.ai/docs/members-roles
- [M-AUTH] https://multica.ai/docs/auth-setup
- [M-TOK] https://multica.ai/docs/auth-tokens
- [M-AG] https://multica.ai/docs/agents
- [M-AGC] https://multica.ai/docs/agents-create
- [M-PROV] https://multica.ai/docs/providers
- [M-INST] https://multica.ai/docs/install-agent-runtime
- [M-DAEMON] https://multica.ai/docs/daemon-runtimes
- [M-RUNS] https://multica.ai/docs/tasks
- [M-ENVS] https://multica.ai/docs/environments
- [M-SEC] https://multica.ai/docs/security-model
- [M-ASSIGN] https://multica.ai/docs/assigning-issues
- [M-MENTION] https://multica.ai/docs/mentioning-agents
- [M-WAKE] https://multica.ai/docs/issue-wakeups
- [M-ISSUES] https://multica.ai/docs/issues
- [M-COMMENTS] https://multica.ai/docs/comments
- [M-PROJ] https://multica.ai/docs/projects
- [M-RES] https://multica.ai/docs/project-resources
- [M-WF] https://multica.ai/docs/workflows
- [M-QA] https://multica.ai/docs/quick-actions
- [M-SQUAD] https://multica.ai/docs/squads
- [M-CHAT] https://multica.ai/docs/chat
- [M-INBOX] https://multica.ai/docs/inbox
- [M-AUTO] https://multica.ai/docs/autopilots
- [M-SKILLS] https://multica.ai/docs/skills
- [M-ANALYTICS] https://multica.ai/docs/analytics
- [M-GH] https://multica.ai/docs/github-integration
- [M-VCS] https://multica.ai/docs/vcs-integration
- [M-CLI] https://multica.ai/docs/cli
- [M-CHAN] https://multica.ai/docs/channels
- [M-SLACK] https://multica.ai/docs/slack-bot-integration
- [M-DESK] https://multica.ai/docs/desktop-app
- [M-MOBILE] https://multica.ai/docs/mobile-app
- [M-ENV] https://multica.ai/docs/environment-variables
- [M-THEMES] https://multica.ai/docs/themes
- [M-COMM] https://multica.ai/docs/community-maintained
- [M-LIC] https://multica.ai/licensing
- [M-CL] https://multica.ai/changelog (cited by release: v0.7.2 of 2026-10-30, v0.8.1 of 2026-11-06, v0.8.2 of 2026-11-10, v0.9.0 of 2026-11-13)

**The repo, `multica-ai/multica`** (read 2026-11-20)

- [GH-README] https://github.com/multica-ai/multica/blob/main/README.md
- [GH-LICENSE] https://github.com/multica-ai/multica/blob/main/LICENSE
- [GH-EE] https://github.com/multica-ai/multica/blob/main/server/ee/README.md and https://github.com/multica-ai/multica/blob/main/server/ee/LICENSE
- [GH-SELF] https://github.com/multica-ai/multica/blob/main/SELF_HOSTING.md ("Anonymous Deployment Telemetry", "Kubernetes Deployment")
- [GH-API] https://api.github.com/repos/multica-ai/multica: 56,904 stars, the licence reported as `NOASSERTION`, last push 2026-11-20
- [GH-R0110] https://github.com/multica-ai/multica/releases/tag/v0.11.0 (2026-11-18): "project folders, with server/ee and packages/ee"; "paid-feature restrictions with read-only downgrade, starting with private projects"
- [GH-R0111] https://github.com/multica-ai/multica/releases/tag/v0.11.1 (2026-11-19): "Free / Pro / Business plans, checkout by plan"; "the no-card Business trial"
- [GH-1634] https://github.com/multica-ai/multica/issues/1634: "[Feature]: JIRA integration", open, 25 👍
- [GH-5919] https://github.com/multica-ai/multica/pull/5919: Jira Cloud integration, closed unmerged
- [GH-10235] https://github.com/multica-ai/multica/pull/10235: plugin API metadata writes and a Jira Link example, closed unmerged
- [GH-7446] https://github.com/multica-ai/multica/pull/7446: "expose globally versioned Plugin Public API", merged 2026-08-23
- [GH-7450] https://github.com/multica-ai/multica/pull/7450: "establish Public API v1 foundation" on OpenAPI 3.1, merged 2026-08-23
- [GH-4076] https://github.com/multica-ai/multica/issues/4076: "Spend guardrails — workspace/agent budget caps", open
- [GH-7536] https://github.com/multica-ai/multica/issues/7536: "Per-member token budgets for shared agents", open
- [GH-10354] https://github.com/multica-ai/multica/issues/10354: an official Docker setup for sandboxed runtimes; closed on 2026-11-20 with a docs fix only, "The PR does not add an official Docker image or Compose configuration"

**Secondary** (no published prices found)

- [SEC-PQ] https://www.promptquorum.com/power-local-llm/multica-review
- [SEC-TULSK] https://tulsk.io/compare/multica

**ostra** (this repo, 2026-11-20)

- `README.md`, `context/project.md`, `context/features.md`, `context/build-order.md`
- ADRs 0001, 0014, 0017, 0021, 0028, 0029, 0030, 0039, 0041, 0042, 0044, 0048, 0049, 0056, 0062, 0065
- `context/research/landscape.md`, `context/research/live-previews.md`, `context/research/skills-and-mcp-marketplaces.md`
- `context/specs/m7-launch/issues/06-claude-code-adapter.md`, `07-claude-code-agent-suite.md`, `10-runner-key-proxy-claude-code-calls.md` (each `Status: wontfix`)
