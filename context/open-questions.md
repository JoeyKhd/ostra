# Open questions

**Who answers:** 👤 = the maintainer's call · 🔬 = research informs it, then we decide together.

A settled question leaves this file. Its answer lives on in the ADR (`decisions/`) or ledger row (`features.md`) that settles it. IDs are permanent.

## Settled

| Question | Settled in |
|---|---|
| Q-01 name | "ostra" |
| Q-02 | ADR 0009 |
| Q-03 | ADR 0010 |
| Q-04, Q-18 | ADR 0008 |
| Q-05 | ADR 0012 |
| Q-06 | ADR 0014 |
| Q-07, Q-08 | ADR 0006 |
| Q-09 | F-007 |
| Q-10 | ADR 0019 |
| Q-11, Q-19 | ADR 0013 |
| Q-12 | F-053 and ADR 0013 now; F-034 later |
| Q-13 | F-026 |
| Q-14 | ADR 0020 |
| Q-15 | ADR 0017 |
| Q-16 | F-041 in v1; F-029 later |
| Q-17 | F-054 |
| Q-21 | F-055 in v1; F-056 later |
| Q-22 | ADR 0018 |
| Q-23 | ADR 0016 |
| Q-24 | F-021 |
| Q-25 | ADR 0004: Claude Code only in v1, then the researched tiers |
| Q-26 | F-050 to F-052 |
| Q-27 | F-058 in v1 |
| Q-28 | ADR 0018: Claude Code through ACP |
| Q60–Q63, the panel's look (asked in chat 2026-11-18) | `brand/app-design.md`: neutral graphite chrome with brand accents, denser type, few boxes, concepts in real HTML; direction B picked |

## Open

**Q-20 🔬 Jira's sign-in model** (F-008, ADR 0001). Atlassian says integrations that have each customer create their own OAuth app don't comply with its rules. How that applies to self-hosted tools is unverified. The safer route is a service account the team owns, plus webhooks an admin registers. Settle before Jira work starts.

## Round 7 (asked 2026-11-18, waiting for the maintainer)

The maintainer: the product "doesnt feel like a HUGE tool", and "i want to be able to scale infinitely". Each line below is followed by my recommendation.

**Making it a big tool**

| # | Question | Recommendation |
|---|---|---|
| Q1 | What "huge" means | Scale and autonomy in v1; enterprise depth later |
| Q2 | Environments at scale | Team templates plus auto-detection from every repo the App sees (lockfiles, tool versions, `.env.example`, `devcontainer.json`), reviewed in bulk |
| Q3 | Setup step 5 | Renamed "Prepare your repos" |
| Q4 | Starting many tickets at once | From the Inbox and from a rule's dry run, in v1 |
| Q5 | Runners page | A fleet view: slots, queue, versions, labels |
| Q6 | Insights | In v1: throughput, time to PR, time waiting on people, merge rate, tokens |
| Q7 | Tickets spanning several repos | Their tasks shown as one group |

**After looking at Omnara and its alternatives**

| # | Question | Recommendation |
|---|---|---|
| Q8 | Elastic runners | Design for them in v1, ship the first provider right after |
| Q9 | Runner pools | In v1 |
| Q10 | Schedules on intake rules | In v1 |
| Q11 | Spike 1 | **Settled 2026-11-18: Rivet Sandbox Agent drives the agents (ADR 0024).** Spike 1 validates it for OpenCode and carries the Q46 bake-off |
| Q12 | CI failures and review comments sent to the owning agent | Move F-035 into v1 |
| Q13 | Reviewer agent as a profile option | In v1 |
| Q14 | Variants ×2/×3 | Soon after v1 |
| Q15 | YAML workflows | After v1 |

**Scaling without limits**

| # | Question | Recommendation |
|---|---|---|
| Q16 | Secrets | **Settled 2026-11-18: per repo** ("16 per repo ofc"). Recorded in F-050 |
| Q17 | Keys the agent can see | Model keys and GitHub tokens added by a proxy on the runner, never visible to the agent, in v1 |
| Q18 | Scale target | 1,000 tasks at once per install *(working value)*, the core service running as several copies |
| Q19 | Subscriptions versus scale | Subscriptions only on members' own laptops; pools and automation on team API keys, Bedrock or Vertex |
| Q20 | Rate limits | Tracked per provider and key; tasks wait instead of failing |

**Not reinventing the wheel**

| # | Question | Recommendation |
|---|---|---|
| Q21 | Copy specific Apache/MIT modules (Cyrus's Linear agent handling, Vibe Kanban's agent drivers, Cezar's variants and workflows) with attribution and a `NOTICE` file, instead of rewriting them | Yes, one module at a time, each in an ADR. The product as a whole stays our own (ADR 0015) |
| Q22 | Run the Tier 1 research | **Settled 2026-11-18: yes.** Running: `research/durable-execution.md`, `elastic-sandboxes.md`, `live-sync.md`, `integrations-platform.md`, `credential-proxy.md`, `runner-transport.md` |

**From the Tier 1 research**

| # | Question | Recommendation |
|---|---|---|
| Q23 | Token-level text deltas versus "saved before acted on" (ADR 0011), raised by `research/live-sync.md` | Stream deltas to the browser without saving them. Save each completed message and every event ostra acts on (tool calls, approvals, state changes). Deltas are display only, and nothing acts on them |
| Q24 | The durable queue (ADR 0017), from `research/durable-execution.md` | Adopt the MIT core of **DBOS Transact**, pending spike 6 (its nine pass/fail scenarios), with pg-boss as the fallback. Keep every DBOS import in one package, so swapping it out stays possible if DBOS drifts toward open core |
| Q25 | Integrations | **Settled 2026-11-18:** the official SDKs, each wrapped in an adapter on its kind's abstract base class (ADR 0025). No integrations platform |
| Q26 | Keeping keys from the agent (Q17), from `research/credential-proxy.md` | **Model key:** a small loopback proxy in the runner (`node:http`, no MITM CA); Claude Code gets `ANTHROPIC_BASE_URL` plus a per-task fake key, and the proxy swaps in the real one. Off on subscription laptops (Anthropic's terms). **GitHub:** the agent gets no credential at all, and the runner does every fetch and push. **Allowlists (F-052, later):** `@anthropic-ai/sandbox-runtime`. **Per-repo `.env` secrets:** accepted as visible to the code under test (ADR 0020) |
| Q27 | Separate OS user on remote runners, raised by `research/credential-proxy.md` | Yes, in v1. On remote runners the agent runs as a different OS user from the runner, so it can't read the runner's memory or files, where the real keys live. Laptops keep one user: it's the member's own machine and their own login |

## Round 8 (asked 2026-11-18): ostra as a platform with Projects

The maintainer: "you are taking this project from being an actual full-fledged framework setup enterprise thing. You're creating a small tool out of it." Their picture: a dashboard where you create a **project** (e.g. "calculator") and hook it up to Jira or Linear. **Runners are pre-configured in the framework** and do all the work: check out the repo, install dependencies, provide the env vars for a test environment. You keep prompting it, or it picks up tracker tasks manually or automatically, "the same way as Claude has their Claude Code in the cloud". **Models:** use models.dev for logos and names, and any API base with a bearer token. This round reshapes several of the open questions in rounds 7 and earlier.

| # | Question | Recommendation |
|---|---|---|
| Q28 | Is the playback right: organization → model providers, runner pools → projects (repos, tracker, environment, agent defaults, automations, tasks)? | Yes |
| Q29 | What a project contains: one repo, or several | Several repos allowed. The environment checks them out side by side, and each changed repo gets its own PR |
| Q30 | Above projects | An **organization** (members, SSO, roles), with access per project. It replaces "team" |
| Q31 | Tasks without a ticket | Yes: prompt a project directly. When a tracker is connected, ostra creates the matching ticket by default (a project setting) |
| Q32 | Runners | Pools managed at the organization level by admins. Each project chooses which pools it may use. Laptops stay possible as personal runners |
| Q33 | Environment as the project's computer | A base image (ostra's default or a custom Dockerfile), a setup script, env vars and secrets, network rules, and a snapshot after setup so tasks start in seconds |
| Q34 | Models | A model registry from models.dev plus custom providers (API base, bearer token, model ID). Claude Code serves Anthropic-compatible endpoints, and **OpenCode joins v1** for every other provider. This reverses "Claude Code only" (ADR 0004) |
| Q35 | Enterprise depth in v1 | **Partly settled 2026-11-18:** sign-in is username and password only in v1, and SSO comes later (F-002, F-004). Still open: roles per project and the audit log in v1 |
| Q36 | Elastic runners, from `research/elastic-sandboxes.md` | **First hosted provider: E2B.** Firecracker microVMs, per-project templates that boot from snapshots in about 80 ms, sandboxes that stay paused indefinitely, egress rules, and a mature TS SDK; about $16.56 for 100 one-hour tasks. **Self-hosters:** Kubernetes `agent-sandbox` with gVisor or Kata, plus Cilium; Docker plus gVisor for small installs. Daytona self-hosted (now closed source) and Runloop (shutting down) are out |
| Q37 | Tasks that outlive a sandbox (no provider runs more than 24 h continuously) | When a task waits a long time on a person or hits a sandbox's limit, the runner pushes its uncommitted work to a hidden ref on the task's branch, releases the sandbox, and reopens on a fresh one later (ADR 0006). Nothing is lost, and nobody pays for idle sandboxes |

## Round 9 (asked 2026-11-18): the runner

The maintainer: "So what exactly will be executing the code? How will all of that work?" The answer given: the agent (Claude Code or OpenCode) runs inside an isolated box, a microVM, container or laptop. The ostra runner inside the box prepares it, starts the agent, streams every event to the server, commits, pushes and cleans up. The box is disposable, and the server holds all state (`research/runner-transport.md`, `research/elastic-sandboxes.md`, `research/credential-proxy.md`).

| # | Question | Recommendation |
|---|---|---|
| Q38 | One box per task | Yes: a fresh microVM, pod or gVisor container per task. Fixed VMs and laptops can run several tasks in worktrees as a lighter mode with less isolation |
| Q39 | The project's snapshot | Built per project and repo: base image, checkout and installed dependencies, never secrets. Rebuilt when the environment changes, when a lockfile changes on the default branch, and nightly |
| Q40 | Services for tests | In v1: an environment declares services (a compose file or a list), started inside the box (Docker inside the box on E2B, extra containers on Kubernetes) |
| Q41 | Who commits | The agent may commit locally. The runner commits whatever is left and pushes after every turn. The agent never holds git credentials |
| Q42 | After a turn | Warm for 15 minutes *(working value)*, then paused or released, with unfinished work saved to a hidden ref |
| Q43 | Box sizes | Per project (small, medium, large). Pools cap totals and per-project use |
| Q44 | Laptop runners | The same runner program. Worktrees on the host, your own login, only your own tasks, labelled "personal, not isolated" |

## Round 10 (asked 2026-11-18): the agent, and Omnara again

The maintainer: "why aren't we using that library [Omnara]? Is it because of Claude Code? ... we can just skip Claude Code because all the other models will be provided by a base URL ... it's illegal to use the Claude Code subscription anyways."

- **Correction given:** Anthropic's terms allow a member's own subscription in the real Claude Code on their own machine. They forbid third-party tools routing, storing or sharing subscription logins (`research/agent-harnesses.md` §1.4). The conclusion still stands: a shared platform runs on provider keys.
- **What still rules Omnara out as the foundation:**
  - Its general-purpose agent loop is unproven for coding against dedicated coding agents.
  - It's Go with Redis, blob storage and a memory filesystem, against ADR 0008 and ADR 0017.
  - Its product overlaps ostra's, and the company has already pivoted once.
  - ostra would give up its own robustness core (ADR 0011).

| # | Question | Recommendation |
|---|---|---|
| Q45 | Default agent | **OpenCode** in v1: any model via API base, key and model ID, with its catalog from models.dev. Claude Code becomes a later, optional harness on keys. This replaces ADR 0004's "Claude Code only" and ADR 0018's "Claude Code through ACP" |
| Q46 | Omnara bake-off | In milestone 0: the same 10 real tickets and the same model through Omnara's loop, OpenCode and Claude Code. Compare mergeable PRs, cost and time, and revisit Omnara only if its loop clearly wins |
| Q47 | Keys everywhere | v1 runs only on provider keys and base URLs, including personal laptop runners. No subscription logins anywhere |
| Q48 | Pool join tokens (the maintainer: "I can basically deploy as many Rivet instances as I want ... the more Rivet agents that we have, the faster") | Admins create a join token per pool. Any number of runner containers (ostra runner + Rivet Sandbox Agent + OpenCode) started with it join and register automatically, and get short-lived credentials. That's how GitHub Actions and Buildkite runners scale. The one-time sign-in code stays for personal laptop runners. ostra ships a Helm chart and a compose `--scale` example |
| Q49 | Onboarding a new project. The maintainer asked whether Rivet "becomes the computer". Answer given: no. The computer is the box, built from the project's environment (an ostra snapshot plus secrets added at start). The ostra runner prepares it, and Rivet is only the agent's remote control. How to run and test comes from the repo (`AGENTS.md`, scripts), the project's environment in ostra (setup, services, env vars, check commands) and the agent profile | A project's first task is an onboarding task. The agent explores the repo and drafts the environment (setup script, services, check commands, needed env vars from `.env.example`), and writes an `AGENTS.md` if missing. The environment is reviewed in ostra, and the `AGENTS.md` arrives as a PR |
| Q50 | The live agent UI. The maintainer wants the official Vercel AI SDK, with assistant-ui on top. **Researched in `research/agent-ui-stream.md`** | Use the **AI SDK's message format and types** (UIMessage parts and tool states, approvals included), which can represent every ACP update, plus a few ostra conventions. Render with **assistant-ui's external store runtime**. **Don't use `useChat`, chat transports or `resumable-stream`**: they assume one browser, one request and one response, with Redis. ostra streams many turns to many viewers and resumes by `seq`. Live text comes through ostra's own tRPC SSE subscription per task: committed events plus 250 ms partial-text frames that aren't saved (Q23). One shared function folds events into `UIMessage[]`. Watchers get a disabled composer and no approval controls. Fallback renderer: shadcn's AI Elements. A 4-day spike in milestone 0 |
| Q51 | Keep Rivet Sandbox Agent? From `research/rivet.md`; the key facts were re-checked on 2026-11-18 | **Take it out of the runtime path; the runner drives agents directly with the official ACP SDK 2.x over stdio** (back to ADR 0018's driver; keep ADR 0024's one-package rule and ostra's own event model). The re-checked facts:<ul><li>It's built on ACP SDK `^0.16.1` while the current version is 2.7.0</li><li>Of 14 non-release commits since March, only one is a code fix</li><li>Issue #407 is open: deleting a session never kills the agent</li></ul>The research also reports, unverified by me:<ul><li>no universal schema since v0.2.0, only raw ACP passed through</li><li>telemetry on by default, against ADR 0021</li><li>no questions or steering</li></ul>Spike 1 validates ACP direct on the doc's 17 test cases |
| Q52 | Steering with OpenCode. Per `research/rivet.md`, OpenCode 2 runs one prompt at a time and can't take input mid-turn | "Steering" mid-turn becomes a declared agent capability (ADR 0025). For OpenCode, sending while it runs interrupts the turn and sends the new message as the next prompt, and the panel says so. Agents that support true mid-turn input (e.g. Claude Code through `claude-agent-acp`) get it natively |
| Q53 | Reopening on another runner (ADR 0006 step 2) | Use each agent's own session export and import, plus ACP `session/load`, not Rivet's 12,000-character text replay. Step 3 (rebuild from ticket, summary and branch) stays the fallback |

## Round 11 (asked 2026-11-18): the whole team, before and after the code

The maintainer wants ostra to serve "the entire team", not only the coders.
- **Before the code:** a ticket may still need work on the product side (planning, screenshots) before it's marked ready for coding.
- **After the code:** review is done by the system or by a developer by hand.

| # | Question | Recommendation |
|---|---|---|
| Q64 | Kinds of task | One Task with three **kinds**, each ending in its own outcome:<ul><li>**refine:** a ready ticket</li><li>**code:** a PR</li><li>**review:** a PR review</li></ul>They share everything else: the box, the agent session, steering, the driver, "needs you". The kind is in the data model from milestone 1, before refine and review ship |
| Q65 | What to call the work before the code | **Refine**, from "backlog refinement", the word product people already use in Jira and Linear. "Plan first" (F-063) stays a step inside a code task |
| Q66 | What a refine task may do | It may:<ul><li>read the code and answer questions about it</li><li>run the app and take screenshots</li><li>prototype on a throwaway branch</li></ul>It **never pushes to a real branch or opens a PR**. Its default agent profile is read-only, on a cheaper model |
| Q67 | How refine ends | The agent drafts:<ul><li>a clearer description</li><li>acceptance criteria and edge cases</li><li>screenshots</li><li>open questions</li><li>a split into sub-tickets</li></ul>A finished draft is a new "needs you" item. The person edits it in ostra, then:<ul><li>**"Update ticket"** writes it to Linear or Jira. Nothing reaches the tracker without a person</li><li>**"Mark ready"** moves the ticket to the board's ready status, where an intake rule turns it into a code task</li></ul>The refine conversation becomes part of the code task's context (F-064) |
| Q68 | Seeing the running app | The environment gains "how to start the app" (a command, a port, a health check). The runner image ships a headless browser. That enables:<ul><li>screenshots of the current app while refining</li><li>before-and-after screenshots on every code task's review</li><li>later, a live preview link into the box for members</li></ul> |
| Q69 | Mockups | The default is a prototype: the agent uses the repo's real components on a throwaway branch and screenshots the result, so the mockup looks like the product. Members can always upload their own images to a draft. Mockups from image models come later, through a new `ImageProvider` adapter kind |
| Q70 | Who uses ostra | Non-coders are ordinary members, with no new role. An admin can limit an agent profile to some members, such as a refine profile for product people |
| Q71 | AI review | After the checks pass, a **review agent** reviews the PR before any person is asked:<ul><li>against the ticket's acceptance criteria and the repo's review rules (such as `AGENTS.md` or `REVIEW.md`)</li><li>on its own agent profile, ideally with a different model from the coder's</li></ul>Its findings show in the panel and post to GitHub as a PR review with line comments, a CodeHost capability |
| Q72 | Fixing what the AI review finds | Blocking findings go back to the coding agent automatically, for at most 2 rounds *(working value)*. After that, a person decides. Nits are only listed. Every round shows in the task's activity |
| Q73 | Human review in ostra | A review screen holds:<ul><li>the diff with a file tree</li><li>the ticket and its acceptance criteria</li><li>the AI's findings inline, each with "Fix this"</li><li>before-and-after screenshots</li></ul>Line comments go to the agent as one prompt (F-072). A **reviewer** becomes a role on the task next to the driver, taken from the PR's requested reviewers or CODEOWNERS, and "PR ready for review" becomes their "needs you". Approving and merging stay on GitHub in v1, where the person's own identity counts for branch protection |
| Q74 | Changing the code by hand | `ostra checkout CALC-161`, or plain git, puts the task's branch on the developer's machine, and they push as usual. When the task reopens, the agent starts from the branch as it is, including the human commits. A browser editor or a shell into the box comes later |
| Q75 | Reviewing PRs that people wrote | A review task can start for any PR opened in a linked repo, opt-in per repo, so human code gets the same AI review. After v1 |
| Q76 🔬 | Where screenshots and files live | Research first:<ul><li>ADR 0017 keeps ostra on Postgres only. Small files under a size cap could live there, with S3-compatible storage optional</li><li>Copies go to the tracker as attachments; Linear and Jira both take uploads</li><li>As far as I know, GitHub has no API for uploading images into PR comments, so reviews would link to images that ostra serves. To verify</li></ul> |
| Q77 | What ships in v1 | **v1:**<ul><li>the task kind in the data model</li><li>AI review (Q71–Q72) and the review screen (Q73)</li><li>hand edits (Q74)</li><li>refine without screenshots (Q64–Q67)</li></ul>**After v1:**<ul><li>seeing the running app (Q68)</li><li>prototype mockups (Q69)</li><li>reviewing people's PRs (Q75)</li></ul> |

## Round 12 (asked 2026-11-18): the repo's layout

ADR 0007 already chose a pnpm + Turborepo monorepo. Three earlier decisions shape its layout:
- **ADR 0016:** two processes, the panel and the core service, share domain packages.
- **ADR 0009:** the runner and the adapter SDK are Apache-2.0, and the server is AGPL-3.0.
- **ADR 0023:** the runner runs on Node and compiles with Bun.

| # | Question | Recommendation |
|---|---|---|
| Q78 | The layout | **Apps:**<ul><li>`web`: Next.js, the panel, better-auth</li><li>`core`: runner gateway, webhooks, queue</li><li>`runner`: the `ostra` CLI</li><li>`docs`: later</li></ul>**Packages:**<ul><li>`db`: Prisma</li><li>`domain`: lifecycles and use cases</li><li>`api`: tRPC routers</li><li>`protocol`: Zod schemas for the runner protocol, agent events and config</li><li>`adapter-sdk`: the seven base classes and contract tests</li><li>`adapters/*`: one package per adapter</li><li>`tooling`</li></ul>**Outside the packages:** `e2e/` runs ticket → task → PR against the test workspaces, and `spikes/` stays outside the workspace. Start with few packages: no `ui` package until a second app needs shadcn components, and one `domain` package split only when it hurts |
| Q79 | Enforcing the license line | Every package declares its license in `package.json`. A CI check fails when an Apache-2.0 package depends on an AGPL-3.0 one. So `protocol`, `adapter-sdk`, `adapters/*` and `runner` never import `db`, `domain` or `api` |
| Q80 | One CLI | `apps/runner` builds one Apache-2.0 `ostra` CLI with three commands: `ostra runner` (a local runner), `ostra login` and `ostra checkout CALC-161` (Q74). It talks to the server only through schemas in `protocol`, never through the AGPL tRPC types |
| Q81 | Publishing to npm | Publish the CLI, `protocol`, `adapter-sdk` and the adapters, so others can write adapters. Version them with Changesets, which is **a new dev dependency, your call**. The server is never published to npm; it ships as the Docker image |
| Q82 | The server image | One image with one entrypoint: `ostra-server web`, `core` or `all`. Docker Compose installs run `all` in one container, and Kubernetes runs `web` and `core` as separate deployments of the same image. Built with `turbo prune --docker` |

## Round 13 (asked 2026-11-18): project memory

**Answered "yes" to all on 2026-11-18.** These questions leave this file when the plan's rework (Organization → Project → Task) writes their ledger rows and the glossary term "memory note". The research in Q91 comes first.

The maintainer asked how each project gets its own memory, shared across the project. Each task starts in a fresh box, so whatever one task learns is lost unless ostra keeps it. Examples:
- "regenerate the Prisma client before the API tests"
- "percent math uses decimal.js, never floats"
- "Sam wants PRs under 400 lines"

Agents' own memory features are tied to one person or one machine. ostra can hold memory once per project, for every member, every runner and every agent.

| # | Question | Recommendation |
|---|---|---|
| Q83 | Scopes | **Organization → project → repo (or a path in it).** A task sees the notes from its organization, its project and its repo, and the most specific note wins. Personal notes come later |
| Q84 | What a note is | **One fact per note.** A note has:<ul><li>a title and a short body</li><li>a kind: convention, command, gotcha, decision, preference or term</li><li>a scope</li><li>its source (a task, a review comment or a member)</li><li>its author and status</li></ul>Notes are versioned and stored in Postgres (ADR 0017), with Postgres full-text search. Vector search (pgvector, still Postgres) only if full-text proves too weak |
| Q85 | How agents receive it | It works the same for every agent:<ul><li>At session start, the runner gives the agent **a short index** (each note's title and one line) plus the notes marked "always", as extra instructions. They're never written into the repo or committed</li><li>An **ostra MCP server in the box** lets the agent search and read the rest, and propose new notes</li></ul>Memory is a declared agent capability (ADR 0025): an agent without MCP gets the index only. This is the same pattern Claude Code's file memory uses |
| Q86 | Who writes | Members write and edit notes directly. Agents and the AI review only **propose**, and a member approves a proposal before any agent sees it. Ticket text and agent output are untrusted (AGENTS.md), and an unchecked note would steer every future task in the project. Proposals show as a count on the project's Memory page, not as amber "needs you" |
| Q87 | Where proposals come from | <ul><li>At the end of each task, the agent is asked what the next task should know</li><li>A **"Remember this"** action on any review comment or AI review finding, so a correction made twice becomes a rule</li><li>Decisions made in refine conversations (Q64)</li></ul> |
| Q88 | Keeping it true | <ul><li>Every note links to its source and shows when it was last used.</li><li>When the snapshot rebuilds, notes that name files, commands or packages that no longer exist get flagged.</li><li>A proposal that contradicts an existing note is shown beside it, to merge or replace.</li><li>Every note is scanned for secrets. Memory never holds credentials, and logs carry note IDs only</li></ul> |
| Q89 | Memory, repo files and the environment | <ul><li>The repo's `AGENTS.md` and `CLAUDE.md` stay the repo's own, and agents read them natively.</li><li>The environment holds the machine's setup. Memory holds the team's knowledge.</li><li>**"Promote to repo"** turns a note into a PR to `AGENTS.md`, so it helps people and tools outside ostra too.</li><li>A note that's really setup gets **"Move to setup script"**</li></ul> |
| Q90 | Where it shows | <ul><li>A **Memory** page in each project (and one for the organization), with search, kinds and the proposals.</li><li>The task page lists the notes a session used, and the notes it proposed.</li><li>Every change goes to the audit log</li></ul> |
| Q91 🔬 | Prior art | Research before building: how Devin Knowledge, Cursor Memories, GitHub Copilot Memory, Windsurf Memories and Claude Code's memory files capture, approve, retrieve and expire memory. The findings go in `research/project-memory.md` |
| Q92 | What ships in v1 | **v1:**<ul><li>organization and project notes</li><li>written by members</li><li>delivered as an index plus MCP search</li><li>proposals from agents, with approval</li></ul>**Later:**<ul><li>staleness checks</li><li>"Promote to repo"</li><li>vector search</li><li>personal notes</li></ul> |

## Answers on 2026-11-18, from chat

These are recorded here until the plan's rework moves them into ADRs and the ledger.

- **Q36: no E2B, and no hosted sandbox vendor.** The maintainer: "People should be able to run their runners wherever they want and just host it, and then it should have like an authentication key." So runners are self-hosted anywhere, and round 14 below works out how.
- **Q45: yes, OpenCode is the default agent.**
- **Q48, confirmed without Rivet:** a runner joins with a key, a join token per pool. The details are Q94.
- **Models: list them from the endpoint itself.** When a member adds a provider (an API base URL and a bearer token), ostra calls the endpoint's own model list, the way the New API gateway fetches a channel's models:
  - `GET /v1/models` on OpenAI-compatible APIs and on Anthropic's API
  - OpenRouter's model list, which also includes prices
  ostra then matches the IDs against models.dev for names, logos, limits and prices. IDs without a match, such as self-hosted or fine-tuned models, are custom models with editable fields. The list refreshes daily. Endpoints with no model list let the member type model IDs. "Test connection" is the same call.
- **Local secrets live outside the repo,** in `~/.config/ostra-dev/` (`docs/development.md`). The `keys/` folder is gone.

## Round 14 (asked 2026-11-18): runners without a sandbox vendor

**Answered yes to all on 2026-11-18** ("Sure, I guess"). These leave this file when the plan's rework writes them into ADRs and the ledger.

The runner becomes a small controller that people run on their own machines. Its **executor** creates each task's box. GitLab Runner's executors and Buildkite's Kubernetes stack work this way.

| # | Question | Recommendation |
|---|---|---|
| Q93 | Executors | Three executors, built in this order:<ul><li>**`host`:** laptops. Worktrees, not isolated, only the member's own tasks (Q44)</li><li>**`docker`:** a container per task, with gVisor as an optional runtime</li><li>**`kubernetes`:** a pod per task. The cluster's own autoscaler supplies the elasticity, with no vendor</li></ul>All three in v1 |
| Q94 | How a runner joins | **A personal runner:** `ostra runner`, signed in with a device code that the member approves in the browser. It runs only that member's tasks.<br>**A pool runner:**<ul><li>It starts with the pool's join token, `OSTRA_JOIN_TOKEN`.</li><li>On first contact it trades the token for its own identity, a key pair whose private half never leaves the runner.</li><li>After that, it uses short-lived access tokens.</li></ul>Each runner can be revoked on its own. Rotating a join token doesn't disconnect runners that already joined. Join tokens are per pool, revocable, and can expire. GitHub Actions and Buildkite runners register this way |
| Q95 | The snapshot as an image | A runner builds the project's OCI image (base image, checkout and dependencies, never secrets) and pushes it to the team's own registry, such as GHCR, ECR or Harbor.<ul><li>Docker hosts pull it, or build and cache it themselves when no registry is set.</li><li>Kubernetes pulls it.</li><li>Laptops use a worktree and a dependency cache instead.</li></ul>The registry is an optional setting |
| Q96 | Services (Q40, without E2B) | <ul><li>**`docker`:** sidecar containers on a private network per task.</li><li>**`kubernetes`:** sidecar containers in the task's pod</li></ul> |
| Q97 | The Docker socket | The `docker` executor needs the Docker socket, which means root on that host. So:<ul><li>it runs on dedicated runner hosts</li><li>the docs recommend rootless Docker or the gVisor runtime</li><li>the `kubernetes` executor needs only its own namespace and a service account scoped to it</li></ul> |
| Q98 | Hosted sandboxes later | ADR 0025's `RunnerProviderAdapter` becomes an **`ExecutorAdapter`**. Hosted sandboxes (E2B, Daytona, Modal) can be community executors later. None in v1 |
| Q99 | Q37, revisited | Without a provider's time limits, the rule stays: after 15 idle minutes (Q42), the runner pushes unfinished work to a hidden ref, releases the box, and the task reopens on a fresh one later |

## Round 15 (asked 2026-11-18): what really needs the maintainer

Most open questions in rounds 7–12 are engineering choices with a safe default, or later answers have already replaced them. These are the ones that need the maintainer.

| # | Question | Recommendation |
|---|---|---|
| Q100 | Defaults for the rest | Every open recommendation in rounds 7–12 that this round doesn't name is accepted as written, except where a later answer replaced it (E2B, Rivet). Any of them can be reopened at any time |
| Q101 | The first users | Who uses ostra first? Is it the maintainer's own team, and if so, how many people, which tracker, which code host, and which stacks? **v1 is done when that team runs its daily work through ostra**: "ostra builds ostra", plus the team's own product |
| Q102 | Organizations per install | **Many organizations in the data model from day one.** Every row carries its organization (ADR 0010). A self-hosted install has one organization by default, and the hosted version turns on sign-up for new ones. Retrofitting this later is a rewrite |
| Q103 | Rivet | **Drop it** (Q51). The runner drives agents directly over ACP with the official SDK |
| Q104 | Jira | **The first adapter after v1.** The `TrackerAdapter` and its contract tests are written against both Linear's and Jira's models from day one, so adding Jira doesn't force a redesign |
| Q105 | Spend limits | A monthly budget per organization and per project. At 80%, the admins are told. At 100%, new tasks wait, and running tasks finish their current turn. Home shows it, as in the concept |
| Q106 | Test accounts for the spikes | <ul><li>a GitHub org for ostra's tests</li><li>a Linear workspace for its tests</li><li>a model key. OpenRouter is recommended: one key reaches every model</li></ul>They're kept in `~/.config/ostra-dev/`, never in chat. Which accounts, and when? |
