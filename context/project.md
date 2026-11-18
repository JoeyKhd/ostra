# ostra: the brief

**Status:** Signed off 2026-11-17, reworked 2026-11-18 from the maintainer's delegated answers (`history/answers-2026-11-18.md`). Items marked *(proposed)* are not yet agreed. Terms follow `GLOSSARY.md`; what's in v1 and what comes later is in `features.md`.

## One-liner

ostra is an open-source, self-hostable control panel that connects a team's tracker to its coding agents. You pick a ticket, an agent works it on its own branch, you step in whenever you want, and it ships a PR. You can come back later and keep going.

**Tagline:** Self-hosted cloud agents for your team. The maintainer's framing: ostra turns the coding agents you already use into cloud agents, with the control plane as the one place everyone works from, and your own machines doing the work.

**Positioning:** the open-source, self-hosted control plane for coding agents, where your tracker stays the source of truth when you use one. The proof points: your agents, your models, your machines, your tracker, and tasks you can reopen months later. It contrasts with Linear's Coding Sessions (Linear's cloud), Multica (not open source, its own board) and Cyrus (one machine, paid team panel) (`research/landscape.md`).

## The job

ostra does three jobs, all equally:

1. **Throughput.** The backlog is full of tickets that agents could do, and ostra turns them into PRs in parallel while people review.
2. **Coordination.** Agent work today is invisible and scattered across laptops and terminals. ostra makes it shared and visible, and any member can pick it up.
3. **Control.** One place owns the organization's agent setup and applies it to every task. Agent profiles hold the agent, its model, instructions, skills, MCP servers and approval rules. Budgets cap what the work spends (F-021, F-037).

It serves two kinds of work equally:
- small tickets an agent finishes alone, many at once
- bigger features a member pairs on live with the agent

It also serves everyone who touches a ticket, not only engineers. A task has a **kind** (ADR 0028, Q64):
- **refine** turns a rough ticket into a ready one, and ends in a draft a member approves
- **code** ends in one or more PRs
- **review** ends in a review of a PR

Today the maintainer's team runs several agents by hand in terminals and worktrees, and the hosted options feel locked in: one agent, their cloud, their pricing. ostra is the answer to both.

## Who it's for

Software teams of any size, each set up in ostra as an **organization**. They keep their tickets in a tracker (Linear first, later Jira) or work from prompts alone, keep their code on GitHub, and use or want to use coding agents. An organization deploys ostra itself, or shares an install with others, and connects its own tracker and GitHub org (each organization registers its own GitHub App and Linear app), its model providers and its compute (ADR 0001, ADR 0026). A paid hosted version comes later.

**First users:** the maintainer and their team.

| Role | What they do |
|------|--------------|
| **Instance admin** | The first account on an install. Creates organizations, and decides whether sign-up for new ones is open (Q102) |
| **Organization admin** | Sets up the organization: connects its GitHub App and Linear app, adds model providers, creates runner pools and their join tokens, defines agent profiles and budgets, invites members |
| **Project admin** | Owns one project: its repos, boards, environment and automations, and its member list when access is restricted (Q35) |
| **Member** | Picks tickets or types prompts, drives and steers tasks, answers "needs you" items, reopens tasks and reviews PRs, mostly from the panel. Sees every task in the projects they can open. Product people who refine tickets are ordinary members (Q70) |
| **Anyone in the tracker** | Can hand a ticket to ostra from the tracker, and follows its progress on the ticket without opening ostra |

Two more roles live on a task, not in the organization. The **driver** is the one member steering it. A **reviewer** is a member asked to review its PR.

## How work is organized (ADR 0026, ADR 0027)

- An **install** holds many organizations. A self-hosted install starts with one.
- An **organization** holds its members, its GitHub App and Linear app, its model providers, its runner pools, its agent profiles, its memory notes and its budgets.
- A **project** is a product the organization works on: one or more repos, boards (or none), one environment, automations, memory and tasks. It is open to the whole organization, or restricted to listed members.
- A **task** belongs to one project. It starts from a ticket or from a prompt, and it may change any of the project's repos. It uses one branch name across them and opens one PR per repo it changed (Q29).
- The **environment** is the project's computer: a base image, a setup script, services, checks, and variables and secrets that each belong to one repo. Every box starts from its snapshot (ADR 0038).

## Core loop

1. **Intake.** A task starts from a ticket or from a prompt. A member picks a ticket in the panel, someone hands it to ostra in the tracker, or an automation (an intake rule or a schedule) starts it. Or a member types a prompt straight to a project, with no ticket at all, and ostra writes nothing to the tracker unless a person asks (Q31, F-097). Every task has a kind: refine, code or review.
2. **Dispatch.** ostra picks the agent profile (the project's default for the task's kind) and one of the project's runner pools, by labels and free capacity. The queue, the project's cap on that pool and the budget decide when it starts.
3. **Work.** A runner in the pool gives the task a **box**: the agent's container with every repo of the project checked out side by side, an ostra **sidecar** that holds the credentials, and the environment's services. The agent starts with the ticket or the prompt as context, and never sees a model key or a GitHub token (Q17, Q26). Its activity streams live to the panel and is mirrored onto the ticket, if there is one.
4. **Steer.** The task's driver can send more prompts at any point. If the agent can't take a message mid-turn, the message queues, and "Interrupt and send" is a separate choice (Q52). Any member can take over as driver.
5. **Ship.** The box runs the environment's checks. ostra pushes the task's branches, and the organization's GitHub App opens one PR per repo the task changed, with the member as co-author (Q55). ostra links the PRs on the ticket and moves its status. An AI review task can read the PR and post findings. Failing CI and blocking findings go back to the coding agent for a capped number of rounds (Q12, Q72).
6. **Reopen.** For review feedback or small tweaks, any member reopens the task, however long after. It usually starts on a fresh box: ostra restores the agent's session and the unfinished work, or else rebuilds the context from the ticket, the PRs and the branches. Prompting continues on the same branches, and the PRs update (ADR 0006, ADR 0039).

Refine and review tasks run the same loop and end differently. A refine task ends in a draft that a member sends to the tracker. A review task ends in findings posted on a PR (Q66, Q67, Q71).

## Shape (ADR 0026, ADR 0029)

```
                 ┌──────────────── ostra server (self-hosted) ────────────────┐
  Linear  ◀────▶ │  web panel · accounts (better-auth) · API · automations    │ ◀────▶ GitHub
  Jira    ◀────▶ │  organizations · projects · tasks · session history        │       (a GitHub App
                 │  background jobs (pg-boss) · budgets · Postgres            │        per organization)
                 └──────────────▲───────────────────────────────▲─────────────┘
                                │ runners connect out           │
                                │ (works behind NAT)            │
                 ┌──────────────┴───────────────────┐   ┌───────┴──────────────────────┐
                 │ pool runner                      │   │ personal runner              │
                 │ joined with a join token         │   │ a member's own machine       │
                 │ executor: docker, kubernetes,    │   │ executor: host               │
                 │ or host (opt-in, not isolated)   │   │ a worktree, no box           │
                 │ one box per task:                │   │                              │
                 │ ┌─ box ─┐ ┌─ box ─┐ ┌─ box ─┐    │   │ only that member's tasks     │
                 │ └───────┘ └───────┘ └───────┘    │   │                              │
                 └──────────────────────────────────┘   └──────────────────────────────┘
```

Inside one box (ADR 0029, ADR 0030):

```
┌── one box, one task ─────────────────────────────────────────┐
│  agent container           sidecar                           │ ───▶ ostra server
│  the repos, side by side   the task's keys                   │
│  the tools                 key proxy                         │ ───▶ model provider (an API base URL + a token)
│  no credentials            git proxy                         │ ───▶ GitHub (the task's refs only)
│                            the agent driver (ACP)            │
│                            the event spool                   │
│                                                              │
│  services: a database, a cache, ...                          │
└──────────────────────────────────────────────────────────────┘
```

- The **server** is the control plane. It knows organizations, projects, tickets, tasks, members, automations and history, and never needs to run an agent itself. Every server process is stateless, so any number of replicas run over one Postgres. The floor we test is 1,000 tasks at once (Q18, F-117). It connects to Linear in v1 and to Jira right after (F-008, ADR 0013).
- A **runner** is the `ostra` program, run as `ostra runner`. It's TypeScript, shipped as an npm CLI and in a container image (ADR 0008, ADR 0046). Signed binaries come after v1 (F-085).
  - A runner joins a **runner pool** with a **join token**, or it's a member's **personal runner** and runs only that member's tasks.
  - It connects outbound to the server, so laptops and hosts behind NAT work without tunnels.
  - Its **executor** gives each task a place to run: `docker` (a box of containers), `kubernetes` (a box as one pod) or `host` (a worktree on the machine, with no box).
  - A pool may use `host` when an admin opts in, for machines that can't run containers for the job, such as Macs that build iOS apps. The panel labels it "not isolated", and the agent runs as a separate OS user (Q44, Q27).
  - The `host` executor has no services and no box sizes. An ADR records that difference (ADR 0029).
- A **box** serves one task and is never reused. It stops after 15 idle minutes *(working value)* and can vanish at any time, so a reopen on a fresh box is the normal case, not the rare one (Q42, ADR 0039).
- The **sidecar** holds the task's credentials and drives the agent over ACP. It connects to the server itself, with a short-lived token for that one task.
  - Its **key proxy** swaps the agent's fake key for the real one and counts the tokens.
  - Its git proxy fetches and pushes for the agent's own `git`, and accepts only the task's branches.
- A **model provider** is an API base URL and a token, so any model works (ADR 0033).
- For a one-box install, one `docker compose up` brings up the server, Postgres and a first pool runner on the `docker` executor (F-001).

## Principles

0. **Robust above all.** The maintainer: connecting GitHub repos and attaching Linear or Jira boards "must be very robust". Six guarantees make that concrete: nothing lost, drift fixed, runners can drop out, no duplicates, crashes don't kill tasks, and failure tests prove it (ADR 0011).
1. **Bring your own everything.** Tracker, code host, agent, model provider, executor, blob store, notifications and secret store are each an adapter behind a shared interface (ADR 0001, ADR 0013, ADR 0025). Any model works: a provider is an API base URL and a token (Q34).
2. **Agent-neutral by design: OpenCode first, Claude Code before launch.** OpenCode is the default and the only agent from milestone 1. Claude Code, on keys through the key proxy, joins it in milestone 7, before launch, so that two real agents prove the interface (Q45, F-019, F-018). Both run over ACP through ostra's own driver, on provider keys, with no subscription logins. The interface is agent-neutral, and each agent after those two is one adapter, with Codex next (ADR 0032, ADR 0018).
3. **Run anywhere.** Runners are programs people host anywhere: a laptop, a VM, a Docker host, a Kubernetes cluster. A task behaves the same on all of them, except where an ADR records a difference (ADR 0005, ADR 0029).
4. **A cockpit for engineers, a mirror for everyone else.** Engineers live in the panel, and so do the product people who refine tickets. Everyone else follows along in Linear and GitHub, where ostra posts what's happening.
5. **The organization owns the work.** Every task belongs to a project, and every project to an organization. A member sees every task in the projects they can open. One member drives a task at a time, and anyone who can open the project can take over or reopen it.
6. **Humans in the loop.** Every task can be steered and reopened. *(proposed)* ostra opens PRs and never merges them. Nothing an agent writes reaches the tracker or the organization's memory until a member approves it. Nothing automatic runs without a limit: every loop has a cap of rounds, a spend cap and a budget above it.
7. **Configurable, with good defaults.** Automations, dispatch, agent profiles, box sizes and budgets are configurable, and a fresh install works without touching any of them.
8. **Easy to self-host.** One `docker compose up` gets you a working server, and Postgres is the only store an install needs (ADR 0017). The server and runners upgrade on each organization's own schedule, and a runner may be one minor version older or newer than its server (ADR 0022).
9. **Private by default.** No usage data leaves an install unless its admin turns it on (ADR 0021). The one outbound fetch an install makes that an admin didn't set up is the daily model catalog from models.dev. One setting turns it off, and each release bundles a copy (Q34).
10. **Strictly typed, end to end.** The maintainer: "everything needs to be STRICTLY typed" (`AGENTS.md`).
11. **The agent never holds a credential.** No model key and no GitHub token ever enters the agent's container. Both stay in the box's sidecar, behind the key proxy and the git proxy (ADR 0030, Q17, Q26).

## Non-goals *(proposed)*

- **Not a tracker or a code host.** We link to Linear and GitHub; we don't copy their UI. A project can run with no tracker at all.
- **Not an agent.** We drive existing coding agents; we don't build one. ostra passes the agent's model calls through its key proxy, counting them, and never makes a model call of its own. What ostra needs back from an agent, such as PR text, drafts and findings, comes through ostra's MCP tools.
- **Not a compute provider.** Runners are programs you host yourself and join with a key (Q36).
- **Not an IDE.** You change a task's code by hand in your own editor, on the task's branch. `ostra checkout` puts it on your machine (F-103).
- **No auto-merge.**
- **No hosted version in v1.** It comes later (ADR 0001).
