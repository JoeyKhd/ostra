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
| Q35 | Enterprise depth in v1 | SSO (OIDC/SAML), roles per project, and the audit log in v1. Budgets and quotas soon after |
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
| Q50 | The live agent UI. The maintainer wants the official **Vercel AI SDK** for live typing and the message format, with **assistant-ui** on top | Pending `research/agent-ui-stream.md`: map Rivet's events into AI SDK UI parts, the transport from ostra's SSE event log, many viewers with only the driver sending, approvals end to end, typed parts. Then decide |
