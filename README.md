<p align="center">
  <img src="context/brand/files/readme/banner.png" alt="ostra: self-hosted cloud agents for your team" width="100%">
</p>

<p align="center">
  <a href="#what-ostra-is">What it is</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#a-look-at-the-panel">The panel</a> ·
  <a href="#status">Status</a> ·
  <a href="#the-plan-lives-here">The plan</a>
</p>

> **ostra is being built in the open.** The plan was signed off on 2026-11-17 and reworked on 2026-11-18. The ten short experiments that tested its riskiest assumptions are done, and the eleven build milestones are built: a prompt or a ticket already becomes a pull request through a runner, from a compact thread, on Linear or Jira Cloud. What's left is the launch gate: the load test, a security review and the live end-to-end demos, run once the maintainer calls it. There's nothing to install yet. Star or watch the repo to follow along.

## What ostra is

ostra is a source-available, self-hosted control panel that turns the coding agents your team already uses into **cloud agents**. The code is public, and you can self-host it for your own team ([License](#license)).

A ticket from your tracker, or a plain prompt, becomes a **task**. An agent works on it on its own branch, in an isolated box prepared from your project's environment. Your team can watch it live, steer it, approve risky steps, and reopen it months later. It ships a GitHub pull request for each repo it changes.

- **Your agents.** Any coding agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com): OpenCode, with more agents later through the same interface.
- **Your machines.** Run runners wherever you like: your servers, your Kubernetes cluster, a laptop. They connect out to your ostra, and on Docker and Kubernetes each task gets its own isolated box.
- **Your models.** Any provider with an API base URL and a bearer token. Names, prices and logos come from [models.dev](https://models.dev).
- **Your tracker.** Linear and Jira Cloud, with one connection for each client's workspace or site, all on one Trackers page. The tracker stays the source of truth.

## How it works

```mermaid
flowchart LR
    T["Ticket<br/>or prompt"] --> K["Task"]
    K --> B["A box on a runner<br/>repos, deps, services,<br/>and a sidecar that holds the keys"]
    B --> A["Agent session"]
    A <-->|"steer · approve · answer"| P["Your team<br/>in the panel"]
    A --> C["Checks"]
    C --> R["Pull requests<br/>on GitHub"]
    R -->|"reopen any time"| K
```

1. **Organize by project.** An install runs one organization, your team, which holds its members, its model providers and its runner pools. Each project in it, a product or a client such as `calculator`, holds its repos, its tracker boards if it has any, and its **environment**: the computer every task starts from, with a setup script, services, and variables and secrets that each belong to one repo.
2. **Start tasks.** Start them by hand, from a prompt, or automatically from tickets that match an intake rule or a schedule. A task belongs to one project and can change several of its repos, with one pull request for each. It is a refine, code or review task.
3. **Run anywhere.** A runner dials out to the server, so it works behind NAT. Servers and clusters join a runner pool with a join token, and a pool serves every project that's allowed to use it. A laptop joins as a personal runner that runs only its owner's tasks, and their AI reviews when no pool runner is free.
4. **Keep the keys out of reach.** On Docker and Kubernetes, each task gets its own **box**: the agent's container, a **sidecar** and the environment's services. The sidecar holds the task's credentials and proxies the agent's model calls and its git. The agent only ever sees a fake key, so no model key and no GitHub token enters its container. A runner on the `host` executor, such as a laptop, has no box. It runs the task in a worktree and is labelled "not isolated".
5. **Step in.** Anything that waits on a person shows as **needs you**: an approval, a question, a plan, a PR to review. One person drives a task at a time, and anyone can take over.
6. **Ship and come back.** Checks run before a PR opens. A task is long-lived: it can be reopened months later, with or without a ticket. A box stops when it's idle, so reopening a task starts a fresh box from its saved session and branches, and continues where it stopped.

The whole system on one page: [`context/architecture/system-overview.png`](context/architecture/system-overview.png).

## A look at the panel

These are design concepts built in HTML, not screenshots of shipped software.

<table>
  <tr>
    <td width="50%"><img src="context/brand/app-concepts/html/home-graphite.png" alt="Home: what needs you, projects, runner pools"><br><sub><b>Home.</b> What needs you, every project, and how busy the runners are.</sub></td>
    <td width="50%"><img src="context/brand/app-concepts/html/project-tasks-graphite.png" alt="A project's tasks grouped by state"><br><sub><b>A project's tasks,</b> grouped by state, with what each agent is doing now.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="context/brand/app-concepts/html/environment-graphite.png" alt="A project's environment"><br><sub><b>The environment:</b> repos, services, setup script, secrets per repo.</sub></td>
    <td width="50%"><img src="context/brand/app-concepts/html/runner-pools-graphite.png" alt="Runner pools"><br><sub><b>Runner pools:</b> your servers, your Kubernetes cluster and members' laptops.</sub></td>
  </tr>
</table>

## Status

| Milestone | What it delivers | |
|---|---|---|
| 0 · Spikes | Ten short experiments that test the plan's riskiest assumptions | **done**: all ten have a finding, and the checks that need a Linux machine with Docker or a Mac are tracked in the build order |
| 1 · First PR, from a prompt | Install ostra, add a model provider and the GitHub App, create a project and type a prompt. OpenCode works in a box and opens a pull request | **in progress**: a prompt becomes a pull request through a runner on a developer's machine, and the Docker box still needs a Linux machine to test |
| 2 · Tickets in, nothing lost | A Linear ticket becomes a PR linked back on the ticket. Restarts, dropped runners and duplicate events lose nothing, and a task reopens on a fresh box a day later | **built**, and its demo passed live three times in a row against Linear and GitHub ([`demo.md`](context/specs/m2-tickets-in/demo.md)); part of its failure suite is still open ([ticket 38](context/specs/m2-tickets-in/issues/38-failure-suite.md)) |
| 3 · Step in and come back | Agent profiles, steering, approvals, plan first, comments on the diff, and boxes that start from a snapshot with their services | **in progress**: built, and its demo ran live on a developer's machine, the second time from a fresh clone, with 59 of its 60 checks passing; the one that failed found a bug, since fixed ([`demo.md`](context/specs/m3-step-in/demo.md)). The panel's browser tests, `@ostra` on a PR, mail through Resend, and snapshots and services on Docker are still to come |
| 4 · The organization | Several projects with their own access, two roles at each level, spend and budgets, and project memory. One organization serves several clients: each project uses only its client's model keys, and holds repos from its client's GitHub organization. Each agent profile sets how much its model reasons, from that model's own levels, and a task's driver can change it for the next turn | **in progress**: built, and its scripted demo ran live on a developer's machine against Linear and GitHub, the last time from a fresh clone with all 161 of its checks passing ([`demo.md`](context/specs/m4-the-organization/demo.md)). Accounts and invitations, roles, project access, organization isolation, the audit log, search, costs and budgets, Insights, memory notes and memory for agents, email notifications, tasks across several repos and reasoning effort are done. The manual run with real mail, branch protection on the review check, and a second client's own key and GitHub organization wait on the maintainer's tickets 42 and 55; "Remember this" on an AI finding and Spend by key are still open |
| 5 · The fleet | Runner pools on Docker hosts and Kubernetes, plus laptops, joined with a token and load-tested at 1,000 tasks at once | **in progress**: built, and its demo passed all 69 checks on a developer's Windows machine (a re-run from a fresh clone passed 67, its two misses in the demo's own checks, since fixed), with pool runners joining by token and approval, the queue, drain and resume, the HTTP fallback, and Kubernetes against a fake cluster ([`demo.md`](context/specs/m5-the-fleet/demo.md)). Docker boxes, a real cluster and registry, and macOS wait for the Linux and macOS proof jobs, which run once, at the launch gate, with the 1,000-task load test; this machine held 250 tasks |
| 6 · The whole team, and autonomy | Refine, code and review tasks, intake rules, schedules and webhooks, and review loops for CI and the AI review | **in progress**: built and reviewed, with its end-to-end demo held for the launch gate. Intake rules, webhook automations, starting many tickets at once, sub-issues, approval for outside tasks, the AI review (on by default, and a project admin turns it off), review rounds, the review screen and reviewers, fixing failing CI and "changes requested" are done. Refine tasks and the onboarding task wait on Docker boxes on Linux; schedules on how late a start comes; and starting from Linear on the maintainer's Authorize click ([spec](context/specs/m6-whole-team/spec.md)) |
| 7 · Launch | Docs, accessibility, the load test and a security review, then the public release on OpenCode. A new install goes from `docker compose up` to its first agent-made PR in under 30 minutes, following only the docs | specced: [`context/specs/m7-launch/`](context/specs/m7-launch/spec.md). Its launch gate waits for milestones 8 to 11 |
| 8 · Previews and the library | Lands before milestone 7's launch gate. Screenshots and recordings of the app a task builds, in its thread; the app live beside the thread, from the box's own browser, on a member's own `localhost`, or, with an optional preview domain (`preview.localhost` by itself on one machine), in the member's browser; sharing a preview with named people or a link. Skills and MCP servers installed by reference into an organization library, pinned and hashed, and attached to agent profiles, with a marketplace browser. A rail and a second sidebar for the panel's navigation | **built**: app processes, screenshots and recordings, preview views and sharing in core and the API, the box's browser streamed live, the preview domain, `ostra preview` on a member's own `localhost`, the library and its marketplace search in core, the API and the panel (its pages, the install sheet, suggestions and a profile's library items), the double-sidebar shell, the app processes' and attachments' screens, the task page's live preview pane with sharing and a link's viewer page, the native preview in the pane with the instance's preview settings, and their docs have landed; the milestone's end-to-end demo runs at the launch gate ([`context/specs/m8-previews-and-library/`](context/specs/m8-previews-and-library/spec.md)) |
| 9 · Attachments | Lands before milestone 7's launch gate. Any file in the new-task box and in every message after it, by paste, drag and drop or a paperclip: the agent finds each in its workspace, outside the repos, sees screenshots and mocks when its model can see images, and reads Word, PDF, Excel and PowerPoint files through their text. A task started from a Linear ticket gets the whole ticket, every screenshot and document in it included | **built**: files in the runner protocol and the adapter SDK, the migration and the domain, the text out of documents in core, every file of a Linear ticket, OpenCode seeing a model's images, uploads and their sweep, the files in a task's spec and in its box, the API (uploads, sending with files, downloads and the ticket's context), the panel's screens (files in every message box, under each message and in the viewer, the ticket's "What the agent got", and a model's "Reads images"), and their docs have landed; the milestone's end-to-end demo runs at the launch gate ([`context/specs/m9-attachments/`](context/specs/m9-attachments/spec.md)) |
| 10 · The compact thread | Lands before milestone 7's launch gate. A task's thread as calm as a chat: your messages as bubbles, the agent's prose as the page, its steps folded into one line per run that opens in place, the step it's on as one live line, what each turn made as one line, and what waits on you unmissable. A turn's tokens and spend are in the opened run's footer, a tooltip and the task's panel, not under every turn; ostra's checks and the code host's CI keep their own words | **built**: its design targets were approved on 2026-11-22, and its tickets 01 to 18 landed; the browser pass over the seeded thread worlds and the live demo are held for the launch gate, and F-151's row stays `building` until that ticket sets it ([`context/specs/m10-compact-thread/`](context/specs/m10-compact-thread/spec.md)) |
| 11 · Trackers and Jira | Lands before milestone 7's launch gate. Each client's tracker, Linear or Jira Cloud, connected on one Trackers page, and a project's boards from any of them. Jira connects through a service account's scoped token, read back before it's saved, and an admin webhook or polling; its tickets move through their workflow's transitions and show everywhere a Linear ticket does, each with its tracker's logo | **built**: its design targets were approved on 2026-11-23, and its tickets 01 to 17 landed; the browser pass and the scripted run on the fakes are before the gate, and the live run on the maintainer's Jira Cloud test site is at it, so F-152's and F-008's rows stay `building` until the gate sets them ([`spec.md`](context/specs/m11-trackers-jira/spec.md)) |

Signed runner binaries come after v1. The details, and which feature lands where, are in [`context/build-order.md`](context/build-order.md) and the feature ledger [`context/features.md`](context/features.md).

## The plan lives here

ostra is planned in this repo, in plain Markdown.

| Read | For |
|---|---|
| [`context/project.md`](context/project.md) | The brief: the problem, the core loop, the principles |
| [`context/features.md`](context/features.md) | Every feature, with its "done when" and its milestone |
| [`context/decisions/`](context/decisions/) | Architecture decisions (ADRs) and why we made them |
| [`context/domain-model.md`](context/domain-model.md) | Organizations, projects, tasks, boxes, runners and their lifecycles |
| [`context/open-questions.md`](context/open-questions.md) | What's still undecided |
| [`context/history/`](context/history/) | The reasoning behind settled questions, such as the answers of 2026-11-18 |
| [`context/research/`](context/research/) | Research on agents, trackers, sandboxes and similar tools, with sources |
| [`context/brand/`](context/brand/) | The brand and the panel's design |

## Built with

TypeScript end to end, strictly typed:
- **The panel:** Next.js, React, shadcn/ui and tRPC
- **Data:** Prisma on Postgres, the only database
- **Sign-in:** better-auth
- **Agents:** the Agent Client Protocol

Every integration is an adapter with a shared contract: trackers, code hosts, agents, executors, model providers, notifications, secret stores and blob stores.

## Contributing

Ideas and questions are welcome in [issues](https://github.com/JoeyKhd/ostra/issues), and code in pull requests. ostra is still on its way to v1, so open an issue before a big change. How to build and test, and the proof rule every feature meets, are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

A pull request needs one tick: its author agrees to the short contributor agreement in [`CONTRIBUTING.md`](CONTRIBUTING.md). You keep your copyright, and you let the licensor license your contribution on any terms. That lets commercial licenses include contributed code.

Coding agents working in this repo follow [`AGENTS.md`](AGENTS.md).

## License

ostra is source-available, not open source. The code is public, and anyone can self-host it for their own team. Two licenses apply ([ADR 0048](context/decisions/0048-license-sustainable-use-and-apache.md)):
- **The Sustainable Use License, version 1.0**, for the server, the web app and every package that isn't Apache-2.0: [`LICENSE`](LICENSE)
- **Apache-2.0** for the runner, the protocol, the adapter SDK, the adapters and the docs site (`apps/docs`), so companies can run runners, write adapters and copy the guides freely. Each of those packages carries its own `LICENSE`.

In short, you may self-host ostra for your own team, or use it for personal and non-commercial purposes, for free. Nobody else may sell the server or the panel, or offer them as a paid service; sharing is allowed only free of charge, for non-commercial purposes. The Apache-2.0 packages carry no such limit. ostra is an app you host yourself: there is no hosted version, and none is planned. Read the license itself for the exact terms.

A check in CI keeps an Apache-2.0 package from depending on one that isn't. The copyright holder, and the notices that go with the code, are in [`NOTICE`](NOTICE).

The copies published under AGPL-3.0 on 2026-11-18, before this change, stay AGPL-3.0 for anyone who already has them. Every version from this change on is under the terms above.
