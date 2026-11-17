# ostra: the brief

**Status:** Draft (2026-11-17), shaped by grilling round 1. Items marked *(proposed)* are not yet agreed. Terms follow `GLOSSARY.md`; what's in v1 and what comes later is in `features.md`.

## One-liner

ostra is an open-source, self-hostable control panel that connects a team's tracker to its coding agents. You pick a ticket, an agent works it on its own branch, you step in whenever you want, and it ships a PR. You can come back later and keep going.

**Tagline:** Self-hosted cloud agents for your team. The maintainer's framing: ostra turns the coding agents you already use into cloud agents, with the control plane as the one place everyone works from, and your own machines doing the work.

**Positioning:** the open-source, self-hosted control plane for coding agents, where your tracker stays the source of truth. The proof points: your agents, your machines, your tracker, and tasks you can reopen months later. It contrasts with Linear's Coding Sessions (Linear's cloud), Multica (not open source, its own board) and Cyrus (one machine, paid team panel) (`research/landscape.md`).

## The job

ostra does three jobs, all equally:

1. **Throughput.** The backlog is full of tickets that agents could do, and ostra turns them into PRs in parallel while people review.
2. **Coordination.** Agent work today is invisible and scattered across laptops and terminals. ostra makes it shared and visible, and any member can pick it up.
3. **Control.** One place owns the team's agent setup and applies it to every task, through agent profiles: models, instructions, skills, MCP servers and permissions.

It serves two kinds of work equally:
- small tickets an agent finishes alone, many at once
- bigger features a member pairs on live with the agent

Today the maintainer's team runs several agents by hand in terminals and worktrees, and the hosted options feel locked in: one agent, their cloud, their pricing. ostra is the answer to both.

## Who it's for

Software teams of any size that keep their tickets in a tracker (Linear first, later Jira), keep their code on GitHub, and use or want to use CLI coding agents. A team deploys ostra itself and connects its own tracker, GitHub org, agents, model credentials and compute (ADR 0001). A paid hosted version comes later.

**First users:** the maintainer and their team.

| Role | What they do |
|------|--------------|
| **Admin** | Deploys ostra, connects the tracker and GitHub, registers runners, sets intake rules and agent profiles |
| **Member** | Picks tickets, drives and steers tasks, reopens them, reviews PRs, mostly from the panel |
| **Anyone in the tracker** | Can start a task from the tracker, and follows its progress on the ticket without opening ostra |

## Core loop

1. **Intake.** A ticket becomes a task. A member picks it in the panel, someone hands it to ostra in the tracker, or an intake rule matches it.
2. **Dispatch.** ostra resolves the task's repo, agent profile and runner.
3. **Work.** On the runner, the task gets its own branch and workspace, and the agent starts with the ticket as context. Its activity streams live to the panel and is mirrored onto the ticket.
4. **Steer.** The task's driver can send more prompts at any point. Any member can take over as driver.
5. **Ship.** ostra pushes the branch and opens a GitHub PR, links it on the ticket and moves the ticket's status.
6. **Reopen.** For review feedback or small tweaks, any member reopens the task. Prompting continues on the same branch, and the PR updates (ADR 0006).

## Shape (ADR 0012)

```
                 ┌──────────────── ostra server (self-hosted) ────────────────┐
  Linear  ◀────▶ │  web panel · team accounts (better-auth) · API · rules      │ ◀────▶ GitHub
  Jira    ◀────▶ │  task orchestration · session history · database            │       (GitHub App)
                 └──────────────▲────────────────────────────▲─────────────────┘
                                │ the runner connects out     │
                                │ (works behind NAT)          │
                     ┌──────────┴──────────┐      ┌──────────┴──────────┐
                     │ local runner         │      │ remote runner        │
                     │ (a member's machine) │      │ (a VM or server)     │
                     │ claude code          │      │ claude code          │
                     │ (more agents later)  │      │ (more agents later)  │
                     └──────────────────────┘      └──────────────────────┘
```

- The **server** is the control plane. It knows about tickets, tasks, members, rules and history, and never needs to run an agent itself.
- A **runner** is a single binary (TypeScript compiled with Bun, ADR 0008) that runs agents in workspaces:
  - Run it on your own machine and it's a local runner. Run it on a VM and it's a remote one.
  - It connects outbound to the server, so laptops behind NAT work without tunnels.
- For a one-box install, the server can include a built-in runner.

## Principles

0. **Robust above all.** The maintainer: connecting GitHub repos and attaching Linear or Jira boards "must be very robust". Six guarantees make that concrete: nothing lost, drift fixed, runners can drop out, no duplicates, crashes don't kill tasks, and failure tests prove it (ADR 0011).
1. **Bring your own everything.** Tracker, code host, agent, model credentials and compute are each an adapter behind a shared interface (ADR 0001, ADR 0013).
2. **Agent-agnostic by design, Claude Code first.** v1 ships Claude Code only. The interface is built for every top-tier agent, and each one after v1 is one adapter (ADR 0004).
3. **Run anywhere.** Local and remote runners are the same to the server (ADR 0005).
4. **A cockpit for engineers, a mirror for everyone else.** Engineers live in the panel. Everyone else follows along in Linear and GitHub, where ostra posts what's happening.
5. **The team owns the work.** Every task belongs to the team. One member drives it at a time, and anyone can take over or reopen it.
6. **Humans in the loop.** Every task can be steered and reopened. *(proposed)* ostra opens PRs and never merges them.
7. **Configurable, with good defaults.** Intake, dispatch and agent profiles are configurable, and a fresh install works without touching any of them.
8. **Easy to self-host.** One `docker compose up` gets you a working server, and the server and runners upgrade on each team's own schedule (ADR 0022).
9. **Private by default.** No usage data leaves an install unless its admin turns it on (ADR 0021).
10. **Strictly typed, end to end.** The maintainer: "everything needs to be STRICTLY typed" (`AGENTS.md`).

## Non-goals *(proposed)*

- **Not a tracker or a code host.** We link to Linear and GitHub; we don't copy their UI.
- **Not an agent.** We drive existing coding agents; we don't build one or call model APIs ourselves.
- **Not an IDE.** You open the workspace in your own editor or in the agent's own interface.
- **No auto-merge.**
- **No hosted version in v1.** It comes later (ADR 0001).
