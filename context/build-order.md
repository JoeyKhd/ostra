# v1 build order

**Status:** agreed (2026-11-18, from the delegated answers in `history/answers-2026-11-18.md`). It replaces the order agreed on 2026-11-17, which assumed Claude Code on a subscription login and one repo per task. **Amended 2026-11-18, once the first spikes had run:** the spikes' findings are folded in (the pass bars of spikes 1, 3, 6 and 7 are reworded below, a status table is added, and milestone 1 runs its demo on the `host` executor). **Amended again 2026-11-19, once all ten had a finding:** spikes 2, 3, 8 and 10 are folded in too. The bars of spikes 3, 8 and 10 are reworded, spike 10's "realistic tickets" becomes a gate after milestone 1's demo, and a workflow in the test repo joins "Outside the code". **Amended again 2026-11-19, on the maintainer's word:** Claude Code (F-018) moves after v1, so milestone 7 is the launch alone and OpenCode is the only agent at launch (the maintainer: "I think we agreed to only use Open Code, which is perfectly fine. So perhaps we can just skip Claude Code with its ACP for now."). **Amended again 2026-11-19, on the maintainer's word:** ostra is self-hosted only, so the hosted version leaves "After v1" (the maintainer: "For now, forget that we will be selling this software as a cloud solution. It will only be an app that people self host themselves for now."). **Amended again 2026-11-19, on the maintainer's word:** one team runs each install, with its clients as projects inside one organization, so v1 ships one organization per install. The lead proposed moving F-049's multi-organization features after v1, and the maintainer answered "sure": creating more organizations, belonging to several with the switcher, links across organizations and the instance's Organizations page are F-134, after v1, and milestone 4 keeps F-049's data model and isolation test. Each milestone ends in something people could actually use, and builds only on what's already done. Feature IDs come from `features.md`, and every v1 row appears below exactly once, or once per milestone that grows it.

## Built in from the first milestone

These aren't a milestone of their own. Every milestone is built on them, and they're checked at each milestone's end:

- **Organization-scoped data**, with the project on every project record (ADR 0026). It's the model from the first migration, even with one organization and one project. v1 ships one organization per install (2026-11-19), and the isolation test makes its second organization from fixtures (F-049).
- **The task kind, and the task's repos** (the "task repo" record), in the schema before refine tasks, review tasks and several repos ship (ADR 0027, ADR 0028).
- **The event log and the durable queue** (ADR 0011, ADR 0035, ADR 0017, ADR 0037). Nothing is acted on before it's saved.
- **No credential in the agent's container** (ADR 0030).
- **ACP as the only way to talk to an agent** (ADR 0018, ADR 0032).
- **Strict typing end to end** (`AGENTS.md`).
- **Dark first, responsive, English text in message files:** F-082, F-075 and F-083.

## Milestones

**Milestone demos move to the launch gate too (2026-11-20).** Milestones 4, 5 and 6 keep their per-ticket proofs, CI, the browser suite and their review, but their scripted end-to-end demos (tickets m4 41, m5 37, m6 39) run once, at the launch gate, with milestone 7's ticket 32. The maintainer: "i think this 'demo' thing you are doing is taking a loooooong time".

**Milestone 8 lands before the launch gate (2026-11-21).** The maintainer approved three features on 2026-11-21 ("yes" to each), to land before the launch gate: screenshots and recordings of the running app (F-121, moved forward from "After v1"), live previews (F-140 to F-144), and a skills and MCP library (F-145, F-146). The double sidebar (F-147) joins them, on the maintainer's request the same day. Milestone 8 is numbered after 7 but built before 7's held gate tickets (25 to 28, 32 and 33), so the load test, the security review, the measure and the launch demo run once, on a product that has it. Its own demo (ticket 33) runs at the gate with milestone 7's ticket 32. Its spec is `specs/m8-previews-and-library/spec.md`, with ADRs 0068 and 0069.

**Milestone 9 lands before the launch gate too (2026-11-21).** The maintainer called attachments a top priority on 2026-11-21: "one of the top priorities now is to add image support and file support to our chat text box thing, LOL no attachements?!?!?!?!", and a ticket's whole content, its screenshots and documents included, as a task's context. The lead's proposal was accepted the same day. Files in messages (F-148), ticket files as context (F-149) and text out of documents (F-150) are built before milestone 7's held gate tickets, beside milestone 8's last ones, so the gate runs once on a product that has them. Its own demo (ticket 18) runs at the gate with milestone 7's ticket 32 and milestone 8's ticket 33. Its spec is `specs/m9-attachments/spec.md`, with ADR 0070.

**Milestone 10 lands before the launch gate too, and is the current work (2026-11-22).** The maintainer, on the task thread: "our chatbox is soooo verbose and ugly compared to claude code on claude.ai". The compact thread's design targets (`brand/app-targets/m10-thread/`) were approved the same day ("yes to all"), each of their fifteen choices as recommended. A calm thread (F-151) restyles what every earlier milestone put in the thread: a member's messages as bubbles, the agent's prose as the page, its steps folded into one line per run that opens in place, the step in progress as one live line, results as one line each, and bookkeeping moved to the opened run's footer, a tooltip, the properties panel and the Event log. ostra's checks and the code host's CI keep their own words everywhere. Its own demo (ticket 19) runs at the gate with milestone 7's ticket 32 and the demos of milestones 8 and 9. Its spec is `specs/m10-compact-thread/spec.md`; it needs no new ADR, and amends ADR 0036.

**Milestone 11 lands before the launch gate too (2026-11-23).** The maintainer decided on 2026-11-23 that an organization holds several tracker connections, of any kind, the way model keys work per client; that a project's Boards attach boards from any connection; that the organization page is called "Trackers" and replaces Organization › Linear; that "Jira Cloud is built now"; and that Trello and Notion show in the picker as "Coming soon". The design targets (`brand/app-targets/m11-trackers/`) were approved the same day ("yes to all"), and the maintainer said "start building immediately", so Jira's adapter was started beside the spec. Trackers (F-152) and Jira (F-008, moved from "After v1") are built beside milestone 10's last tickets and before milestone 7's held gate tickets. Its own demo (ticket 18) runs at the gate with the others, its live part on the maintainer's Jira Cloud test site. Its spec is `specs/m11-trackers-jira/spec.md`, with ADR 0071.

**The launch gate waits for the maintainer (2026-11-20).** Milestone 7's whole-product checks run last, only when the maintainer says it's time, so features added in between don't force a redo: the load test as the gate (ticket 26), the security review (27, 28), the launch's end-to-end demo and ledger (32), the 30-minute measure (25) and the launch itself (33). Each milestone's own demo, review and fixes still run as it finishes. The maintainer: "make sure you skip the things that you might need to redo later ... a security review should come at the absolute end when i tell you it's time to do it".

**The Proof workflow runs once, at the launch gate (2026-11-21).** `proof.yml`'s jobs (the panel's e2e suite, milestone 6's Linear rehearsal, the docs' commands, and the live jobs on Linux with Docker, on kind and on macOS) run once, as a gate step beside the load test and the security review: `gh workflow run Proof -f jobs=all`, dispatched by the lead on the maintainer's word, and never while building. A "done when" condition that only those jobs show waits for that run, with a dated note, and its row stays `building` until the run passes. The proof paperwork went the same day: a feature is `done` when a test named with each condition's key passes in CI, with no proof file, no break-it pass and no live-evidence log (`AGENTS.md`, "Proof"). The maintainer: "stop doing all those Proof github actions going forward they slow things down a lot", and "keep tests, drop extras". The Linear rehearsal (milestone 6's ticket 38, F-012/c6) moved there from CI the same day: it's a load check (50 delegations, each first thought under 10 s), it took about 4.5 minutes of every CI run and missed its timings on a busy runner, so `pnpm test` skips it, and the gate's e2e job runs it with `OSTRA_LINEAR_REHEARSAL=1`. *Note 2026-11-22: a `failure-cases` job joined it, for F-048/c2: spike 8's kill points and F-106's schedule hunt on the fakes, which `pnpm test` skips for their length (about 20 minutes together).*

| # | Milestone | Features | Ends with |
|---|---|---|---|
| 0 | Spikes | None. Ten throwaway experiments (below), whose findings go into `research/` | Every assumption the plan rests on has been tried for real. **Done 2026-11-19:** all ten ran and have a finding. The checks that need a Linux host with Docker, a Mac or a person wait in "Where the spikes stand" |
| 1 | First PR, from a prompt | F-001 one-command install · F-076 setup in the panel (first version) · F-002 accounts (the first admin) · F-086 projects (one repo) · F-088 model providers · F-089 key proxy · F-090 git proxy · F-006 GitHub App · F-013 runner (the built-in pool runner, WebSocket) · F-017 a box per task (the `docker` executor) · F-016 workspace per task · F-050 environment · F-112 environment detection · F-019 OpenCode · F-097 prompt tasks · F-023 live activity · F-025 stop · F-030 open the PR · F-078 repo conventions · F-065 no empty PRs | An admin installs ostra on one machine, adds a model provider and the GitHub App, creates a project and types a prompt. They watch OpenCode work in a box and get a PR |
| 2 | Tickets in, nothing lost | F-005 Linear, plain API · F-007 boards · F-010 ticket inbox · F-064 ticket context · F-031 ticket sync · F-042 private installs · F-043 to F-048 (nothing is lost, drift gets fixed, runners can drop out, no duplicates, agent crashes don't kill tasks, failure tests) · F-068 runaway protection · F-079 cleanup and retention · F-114 blob storage · F-096 idle, stop and release · F-032 reopen · F-033 reopen anywhere · F-055 signed-commit repos · F-060 default-branch warning | A ticket picked from the Inbox becomes a PR linked on the ticket. The failure suite passes: kill the runner, drop webhooks, restart the server mid-task, and nothing is lost or duplicated. A task reopens on a fresh box a day later, with its context. **Where it stands (2026-11-19):** built, and its demo passed live three times in a row (`specs/m2-tickets-in/demo.md`); part of its failure suite (ticket 38) is still open |
| 3 | Step in and come back | F-021 agent profiles · F-024 steer (queue or interrupt) and take over · F-026 approvals · F-063 plan first · F-062 home ("needs you") · F-036 notifications in the panel and Linear · F-115 email notifications · F-027 diff · F-072 diff comments · F-028 take it local, with F-103 `ostra checkout` · F-070 update branch · F-054 checks before the PR · F-051 environment snapshots · F-094 services · F-053 `@ostra` on the PR · F-119 verified GitHub link · F-066 after the merge · F-084 usage | A member steers, approves, answers and comments on the diff. Boxes start from a snapshot with their services. **ostra's own tickets run through ostra from here on** |
| 4 | The organization | F-002 accounts (invites, resets) · F-003 roles at two levels · F-087 project access · F-049 organization isolation · F-073 audit log · F-080 search · F-037 costs and budgets · F-108 Insights · F-109 memory notes · F-110 memory for agents · F-111 memory proposals · F-098 tasks across several repos · F-104 the `ostra/independent-review` check · F-135 model keys per project · F-136 repos from several GitHub organizations · F-137 reasoning effort | The maintainer's team works in several projects with their own access. Spend is visible and limited. Projects remember what they learned. One organization serves several clients: each client's project uses only its client's model key, and holds repos from its client's GitHub organization (ADR 0065). Each profile sets how much its model reasons, from that model's own levels, and a task's driver changes it for the next turn (ADR 0066) |
| 5 | The fleet | F-091 runner pools and join tokens · F-092 fleet view · F-014 personal runners · F-015 pool runners · F-093 `kubernetes` executor · F-120 snapshot registry · F-095 box sizes · F-067 capacity and queue · F-069 choosing a runner · F-061 runner versions · F-039 three images · F-116 egress baseline · F-118 Helm chart · F-117 scale-out and the load test · F-013 runner (the HTTP fallback) | Pools on Docker hosts and on a Kubernetes cluster, plus laptops. Any number of runners join with a token. The load test holds 1,000 tasks |
| 6 | The whole team, and autonomy | F-011 intake rules · F-106 schedules · F-139 webhook automations · F-107 start many at once · F-012 start from Linear (agent mode) · F-040 approval for outside tasks · F-077 sub-issues · F-099 refine tasks · F-100 AI review · F-101 review rounds · F-102 review screen and reviewers · F-035 fix failing CI · F-105 a "changes requested" review reopens the task · F-113 onboarding task | Product people refine tickets. Rules, schedules and webhooks start tasks. PRs arrive green and already reviewed by an agent, and a reviewer finds them under "needs you". Anyone in Linear hands a ticket to ostra |
| 7 | Launch | F-058 docs site · F-081 keyboard and accessibility · the final check of F-075, F-082 and F-083 · F-076 setup in the panel (complete, measured) · F-117 the load test as the gate · a security review of the box · publishing (ADR 0045) | Public v1, on OpenCode. A team new to ostra goes from `docker compose up` to its first agent-made PR in under 30 minutes, following only the docs. **Its launch gate waits for milestones 8 to 11** (below) |
| 8 | Previews and the library (**before milestone 7's launch gate**) | F-121 seeing the running app (screenshots and recordings) · F-140 app processes · F-141 live preview · F-142 sharing a preview · F-143 `ostra preview` · F-144 preview domain · F-145 skills and MCP library · F-146 marketplace browser · F-147 double sidebar | A reviewer sees the app, not only the diff: screenshots and recordings in the thread, the box's own browser live beside it, any port on a member's own `localhost`, and, with an optional preview domain, the app itself in the member's browser. An organization installs skills and MCP servers by reference, pinned and hashed, and attaches them to its profiles. The panel's navigation is a rail and a second sidebar. `specs/m8-previews-and-library/` |
| 9 | Attachments (**before milestone 7's launch gate**) | F-148 files in messages · F-149 ticket files as context · F-150 text out of documents | A member pastes, drops or picks any file in the new-task box and in every message after it, and the agent finds each in its workspace, outside the repos, with a document's text beside it and an image shown to a model that can see it. A task started from a ticket gets the whole ticket, every screenshot and document in it included, and a reopen passes on what changed. `specs/m9-attachments/` |
| 10 | The compact thread (**before milestone 7's launch gate**; the current work) | F-151 a calm thread | A member opening a task reads it like a conversation: their messages as bubbles, the agent's prose, one quiet line per run of its steps that opens in place, the step in progress, what each turn made, and what waits on them, with a pill when it's scrolled away. A turn's numbers are one press or one hover away, never a line under every turn. A review task's page speaks only of what a review does, and checks and CI keep their own words. `specs/m10-compact-thread/` |
| 11 | Trackers and Jira (**before milestone 7's launch gate**) | F-152 trackers (several connections per organization) · F-008 Jira | An organization connects each client's tracker, Linear or Jira, on one Trackers page, and a project's Boards attach teams and projects from any of them. Jira Cloud connects through a service account's scoped token, checked and read back, and an admin webhook or polling; its tickets move through their workflow's transitions, read as markdown, and show everywhere a Linear ticket does, with each tracker's mark. Disconnecting pauses a connection's boards until it's connected again. `specs/m11-trackers-jira/` |

Notes on the order:

- **Milestone 1 on a machine with no Docker.** The plan's author works on a Windows machine with no Docker, so milestone 1's end-to-end demo runs on the `host` executor: a personal runner with a worktree, which holds no credential. The key proxy and the git proxy still run, as the work of the runner's own process, which is how ADR 0029 and ADR 0030 say the `host` executor works. The `docker` executor is written in full with unit tests, and its live test, F-017's "done when" and spike 3's real-box half wait for a Linux machine with Docker. Until it runs, F-017 stays `planned` and the milestone's "a box" reads as "a worktree". The development database is an `embedded-postgres` dev dependency started by a dev script, and `DATABASE_URL` overrides it (ADR 0007). **Where milestone 1 stands (2026-11-19):** it is in progress. A typed prompt became a PR on the test repo through a personal runner on the `host` executor, five times in a row from an empty data folder (`specs/m1-first-pr/demo.md`), and every milestone 1 row but F-017 is `done` or `building` in the ledger. F-017 waits for Docker.
- **One agent at launch.** OpenCode is the default and the only agent, from milestone 1 through the launch (ADR 0032). *Changed 2026-11-19 (the maintainer):* Claude Code (F-018) no longer ships in milestone 7; it comes after v1, near Codex (F-038). The agent interface stays as it is: ostra's own ACP driver, the `AgentAdapter` base class, and the agent contract suite with its scripted fake agents, which declare what OpenCode lacks and keep adapter parity (`AGENTS.md`) tested with one real agent. So a second agent later is one adapter. Claude Code's plan (ADR 0062, postponed, and milestone 7's tickets marked `wontfix`) waits for it. No subscription login is used anywhere (Q45, Q47).
- **Money before loops.** Budgets and Insights (F-037, F-108) are built in milestone 4, before any loop that spends without a person: the CI loop and the review rounds (F-035, F-101) in milestone 6 (Q105).
- **Jira is checked from milestone 2.** The tracker contract suite runs against a Jira fake as well as Linear, so the interface isn't shaped only for Linear. The fake models a status graph with transitions, rich text that isn't markdown (ADF) and issue keys that change. Jira itself is the first tracker after v1 (Q104, F-008). *Changed 2026-11-23: Jira is built in milestone 11, in v1 (ADR 0071).*

## The v1 cut

The maintainer asked that v1 not shrink the product, and the cut keeps its shape. Three rules decide it:

1. **Every noun in the plan exists in v1,** and is in the first migration where it shapes the data: organization, project, environment, pool, provider, the task kinds, repos per task. Adding a noun later is a rewrite.
2. **Each noun gets the least depth that works:** two trackers (Linear, and Jira since 2026-11-23), one code host, one agent (OpenCode; Claude Code after v1), one organization per install (several after v1, F-134), password sign-in, two roles per level, one model catalog. The exception is executors: `docker`, `host` and `kubernetes` all ship. Adding depth later is one adapter or one setting.
3. **Anything that spends money or widens access ships with its limit:** loops with caps and budgets, pools with join-token rules, boxes with the egress baseline.

A fourth rule keeps it honest: **the maintainer's team uses it early.** From milestone 3, ostra's own tickets run through ostra (Q101).

This is a large v1: 105 ledger rows against 66. It's shippable because the depth is thin and because nothing in it is a research project. Each hard part has a spike with a pass bar and a named fallback (below).

### In v1

- **The organization:** one per install, kept apart from any other by the data model and a test for every kind of record, accounts with a username or email and a password, invite and reset links, two organization roles, the audit log, search, budgets and Insights.
- **Projects:** several repos, from several GitHub organizations, boards from any of the organization's tracker connections (Linear or Jira) or none at all, open or restricted access, two project roles, and the model keys each project may use.
- **The environment:** detection, a setup script, variables and secrets per repo, services, checks, snapshots, and the onboarding task that tests it.
- **Models:** any endpoint with a base URL and a token, in either API format, with the models.dev catalog. An organization holds several keys for the same models, one per client, and each project uses only those on its list. Keys never reach the agent, and every call is counted.
- **Runners:** pools and join tokens, the fleet view, the `docker`, `host` and `kubernetes` executors, a box per task, box sizes, the queue with a cap per project, an egress baseline, personal runners, the HTTP fallback, a Helm chart.
- **The agent:** OpenCode, over ACP through ostra's own driver, with agent profiles, approval rules, plan first, and queue or interrupt. Skills and MCP servers from an organization library, installed by reference, pinned and hashed, with a marketplace browser (milestone 8).
- **Seeing the app** (milestone 8): the app's processes in the environment, screenshots and recordings in the thread, a live preview beside it, sharing, `ostra preview`, and the optional preview domain.
- **Files for the agent** (milestone 9): any file in any message, a ticket's every file as context, images shown to a model that can see them, and the text of Word, PDF, Excel and PowerPoint files.
- **A calm thread** (milestone 10): the task's thread as compact as a chat, its steps folded into runs, its numbers in the footer and the panel, and checks and CI in their own words.
- **Trackers and Jira** (milestone 11): several tracker connections per organization, one per client's Linear workspace or Jira site, on one Trackers page; Jira Cloud through a service account and an admin webhook or polling, its tickets moved by their workflow's transitions; boards from any connection; each tracker's mark wherever a ticket shows.
- **Tasks:** from a ticket, a prompt, an intake rule, a schedule, Linear's agent mode, or `@ostra` on a PR. Three kinds. Live activity for many viewers, one driver, take over, stop, reopen on any box months later.
- **Shipping:** checks before the PR, one PR per changed repo, opened by the GitHub App with co-authors, ticket sync, update branch, a new branch after a merge.
- **Review:** the CI loop, AI review and its fix rounds, the review screen, reviewers, the "changes requested" loop, the independent-review check, `ostra checkout`.
- **Memory:** notes for organizations and projects, the index and MCP search for agents, and proposals that a member approves.
- **Robustness:** the six guarantees and their failure suite, runaway protection with a spend cap, cleanup, and the load test at 1,000 tasks.
- **The rest:** notifications in the panel, on the ticket and by mail; dark first, responsive, keyboard-driven, translatable; the docs site.

### After v1, in this order

1. **Right after:** network allowlists (F-052), Slack (F-057), signed runner binaries (F-085), and Trello, the next tracker, once someone asks (`research/trello-and-notion.md`: a small adapter on the Jira pattern; no ledger row yet).
2. **Then:** AI review of people's PRs (F-123), Notion as a tracker, behind a spike on its property mapping and its webhook verification (`research/trello-and-notion.md`; no ledger row yet), prototype mockups (F-122), variants (F-124), memory depth (F-129), SSO and custom roles (F-004), several organizations per install (F-134, after v1 since 2026-11-19), providers that sign requests (F-130), a secret store adapter for a vault (F-133), GitLab (F-009), the public API (F-074).
3. **Later still:** attach (F-041), a terminal in the browser (F-029), bulk onboarding (F-126), community executors (F-127), workflows (F-125) and signed commits (F-056). *Changed 2026-11-19: the hosted version, last on this list until then, is not planned. ostra is an app people host themselves (`history/self-hosted-only-2026-11-19.md`).*

*Changed 2026-11-23: Jira (F-008), first in "Right after" until then, moved into v1 with milestone 11, on the maintainer's word ("Jira Cloud is built now"). Trello is next after it, and Notion later, behind a spike; both show in the picker as "Coming soon" until then.*

*Changed 2026-11-21: seeing the running app (F-121), first in "Right after" until then, moved into v1 with milestone 8, on the maintainer's word.*

*Changed 2026-11-21: Claude Code (F-018) and Codex (F-038), in "Right after" until then, are set aside with no date, on the maintainer's word: "so let's skip Claude code then for now and Codex". OpenCode stays the only agent. A Claude subscription can't be used through ostra under Anthropic's terms (ADR 0005, Q45, Q47), which made Claude Code on keys less useful; the agent interface stays ready for both.*

### What slips first if v1 runs long

In this order, and none of them changes the data model:

1. the onboarding task (F-113): detection alone still drafts the environment
2. schedules (F-106)
3. refine tasks (F-099): the kind stays in the schema
4. PRs across several repos (F-098): the schema stays, and v1 would run one repo per task
5. building snapshots inside Kubernetes: a `docker` runner would build them for the cluster

What never slips: the organization and project model, the box with its sidecar, the failure suite, and budgets before any loop.

## Milestone 0: spikes

Throwaway code in `spikes/<kebab-question>/` (`AGENTS.md`). Each finding goes into `research/`. No spike assumes a model provider, and none uses a subscription login. Each reads its endpoint from `~/.config/ostra-dev/model.env`: a base URL, a token and a model ID (Q106). Claude Code isn't spiked: it comes after v1 (F-018, moved from milestone 7 on 2026-11-19), and spike 1's cases and the agent contract suite are the bar it has to meet.

1. **`how-should-the-runner-drive-opencode`** (6 days)
   - **Question:** can ostra's own driver, on the official ACP SDK, run OpenCode for real work through the key proxy, on any endpoint?
   - **Tests the decisions:** Q11, Q45, Q51, Q52, Q103.
   - **Passes when:**
     - Cases T1, T3–T11, T13, T14 and T16 of the test list in `research/rivet.md` pass on Linux in a container, on Windows 11 without WSL, and on macOS. **Three cases are reworded after the Windows run** (ADR 0032): T5's plan passes with "a plan, or a todo list ostra maps"; T7's reject passes with "a reject ends the turn, and the agent can be re-prompted to continue"; T13's reap passes with "the runner's reap works from the agent's tree, and a box or a job object closes the rest". T7's held-request wait is 15 minutes, matching ADR 0039, not the 10 in the test list.
     - A 20-minute turn ends cleanly. A question reaches the driver, and its answer reaches the model. A cancel returns within 5 s and leaves no process behind.
     - A turn completes against the endpoint in `model.env`, and against a local stub in each of the two API formats.
     - The agent's environment holds only the fake key, and the proxy's token count is within 2% of what the endpoint reports.
     - Recorded: events per minute (448 in one small turn, on one model; spike 10's 30 real runs give a median of 259 and a maximum of 415), and whether OpenCode's own HTTP API can steer mid-turn (it can, and so can ACP, through `_session/steering`: ADR 0032).
   - **If it fails:** try OpenCode's HTTP API for the capability that failed. If that fails too, the choice of default agent is reopened.

2. **`can-a-session-move-to-a-fresh-box`** (4 days)
   - **Question:** can a task carry on in a new box, with its context and its unfinished work?
   - **Tests the decisions:** Q42, Q53, Q99. F-033 rests on it.
   - **Passes when:**
     - After export, upload, a fresh container, import and `session/load`, the agent answers 5 of 5 questions about earlier turns and finishes an edit it was interrupted in.
     - Uncommitted and untracked files come back from the hidden ref. GitHub accepts that ref and starts no CI for it. (The "no CI" half needs a push-triggered workflow in `test1`, which has none: "Outside the code".)
     - It still works after OpenCode's patch version changes.
     - A 200-turn session restores in under 30 s *(working value)*. The archive's size is recorded.
     - The rebuild template alone gets at least 4 of 5. (Every agent message plus an interrupted-turn section scored 5 of 5 in all four runs; Q128.)
   - **If it fails:** pin another OpenCode version, or make the rebuild template the normal path and say so in F-033.

3. **`what-is-inside-a-box`** (7 days)
   - **Question:** does the box (agent container, sidecar, services) hold on Docker and on Kubernetes?
   - **Tests the decisions:** Q26, Q27, Q38, Q95, Q96.
   - **Passes when:**
     - From a shell in the agent's container, none of these works: reading a model key or a GitHub token from the environment, the process list, files or the network; answering its own approval; reaching a private address, the metadata address or another box, another box's git proxy port included (the proxy has no per-task secret in its URL, ADR 0030). The shell also can't use OpenCode's loopback port: it calls the port with no password and fails, and no process's `environ` or `cmdline` that the shell can read holds the password (spike 1, item 5; a marker as the password, if `opencode acp` honors `OPENCODE_SERVER_PASSWORD`: ADR 0030). The git proxy's URL holds no credential and a random path segment per box (Q152).
     - Each network check has a positive control, a timeout is inconclusive and not "blocked", and a control pod that must be refused tells a cluster that enforces NetworkPolicy from one that doesn't. On `kubernetes` the agent keeps direct public egress by design (ADR 0029, Q151). A canary file outside the workspace, read by a shell call, shows in the event log (ADR 0031).
     - The bridge between sidecar and agent carries a 20-minute turn, and stopping a task leaves no process.
     - A box is ready in under 10 s on Docker with the image present, and under 60 s on a warm Kubernetes node *(working values)*. 50 boxes run on one host, with the executor owning the Docker subnets (ADR 0029, Q154). The sidecar stays under 100 MB, a number to set after measuring the driver alone on Linux first: it was 83 to 88 MB on Windows in spike 1.
     - A snapshot builds from a generated Dockerfile on both. A box started from it sees its repos. A setup secret isn't found in any layer, the scan runs before the push and has a negative control, and a database service is reachable from the agent's container (ADR 0038, Q153). The `kubernetes` half needs Kubernetes 1.29 or later (Q155).
     - The same checks pass with gVisor as the runtime.
   - **If it fails:** one container per box, with the runner as a separate OS user (Q27 as first written).

4. **`github-app-and-git-proxy`** (5 days)
   - **Question:** can the App and the git proxy carry all of a task's work on GitHub?
   - **Tests the decisions:** Q26, Q41, Q55.
   - **Passes when:**
     - The manifest flow creates the App from a local server, with the permissions v1 needs, `checks: write` among them.
     - Through the proxy, stock git clones, fetches and pushes the task's branch. A push to the default branch, a delete and a push to another repo are refused before a byte reaches GitHub. The token never appears in the agent's container.
     - LFS, a shallow clone and a 500 MB pack work, or their limits are written down.
     - A PR the App opened with a co-author trailer shows the member as co-author. The App can post a comment-type review with line comments on its own PR. A check run flips when someone approves.
     - Linear's GitHub integration links a PR the App opened.
   - **If it fails:** the sidecar pushes from its own clean clone instead of proxying.

5. **`linear-agent-mode`** (4 days)
   - **Question:** can the server alone meet Linear's agent deadlines from a self-hosted install?
   - **Tests the decisions:** ADR 0013, Q25. F-012 rests on it.
   - **Passes when:**
     - The app installs from a manifest link, as its own workspace user.
     - Across 50 delegations, the webhook is answered in under 5 s and the first activity lands in under 10 s, with no runner involved.
     - Stop and follow-up arrive. A silent turn of 35 minutes stays alive. A stop always comes from a signed-in user pressing Send stop request, since an API key can't post an agent activity, so a person does that step in the real run (ADR 0013, Q125).
     - `@linear/sdk` typechecks under ostra's strict flags and adds under 20 s to `tsc` *(working value)*.
   - **If it fails:** agent mode (F-012) moves after v1. The plain API stays.

6. **`runner-transport`** (6 days)
   - **Question:** does the protocol lose nothing, through real networks, at the scale floor?
   - **Tests the decisions:** ADR 0034 and `research/runner-transport.md`, Q18. F-045 and F-061 rest on it.
   - **Passes when** (on Node only, on Windows, macOS and Linux):
     - Through a CONNECT proxy, a TLS-inspecting proxy and nginx's defaults, the runner connects, or falls back to HTTP by itself within 30 s.
     - After `kill -9`, and after network cuts of 30 s, 5 min and 11 min, every event the server received before the grace ran out is stored exactly once. After the grace the task stops cleanly and stale writes are refused, events that arrive late included (ADR 0034, Q111). (The earlier wording, "every event is stored exactly once", contradicted its own ADR and could never pass.)
     - With two core replicas, a steer reaches the runner in under 500 ms at p99, and in under 2.5 s with notifications off.
     - One replica holds 2,000 connections. Three replicas and one Postgres carry 1,000 sessions at the event rates spikes 1 and 10 recorded.
     - A runner one minor older or newer works, or is refused with a clear message.
     - A laptop that sleeps through the grace period can't write afterwards.
   - **If it fails:** batch harder first. Then weigh another WebSocket server.

7. **`live-stream-and-task-view`** (6 days)
   - **Question:** can a task page on the AI SDK's types and assistant-ui show a real session live to two viewers, from ostra's own stream?
   - **Tests the decisions:** Q23, Q50, Q18.
   - **Passes when:**
     - Two legs, both with partial text on for some tasks (1 task in 4 in the spike): runner to the stream's viewer, at 5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms with Postgres under 50% of 4 vCPU, partial text counted; and runner to a row in the DOM, for a sample of real browsers. The Postgres line counts the partial-text table (ADR 0035, Q113).
     - Every kind of event in the recorded sessions renders, and nothing is dropped silently.
     - A reload shows the partial text again within 1 s. A 10 s network drop leaves no gap and no duplicate.
     - A watcher can't send, in the UI or by calling the API. When two members answer one approval, one wins.
     - The default view of a 5,000-event task renders in under 1.5 s on a mid laptop, measured unthrottled in a production build, with list virtualization for long tasks (ADR 0036, Q112).
     - Strict typecheck and lint pass with only documented suppressions. The page calls no third party.
   - **If it fails:** if assistant-ui fails, render with AI Elements. If live text fails, carry it in the notification. If fan-out fails, evaluate Centrifugo, as `research/live-sync.md` suggests.

8. **`durable-queue-choice`** (3 days)
   - **Question:** does pg-boss cover ostra's background work?
   - **Tests the decisions:** Q24, ADR 0037.
   - **Passes when:**
     - A job enqueued inside a Prisma 7 transaction exists only if the transaction commits.
     - `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate.
     - A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded.
     - 200 automations created at runtime each start once per tick, through ostra's scheduler tick, while every replica but one is killed, aimed at the one holding the work. (pg-boss's own cron failed this on 2026-11-18: ADR 0037, Q156.)
     - Delayed jobs survive a restart and can be cancelled.
     - The panel process enqueues without running workers.
     - It compiles under ostra's strict flags.
   - **If it fails:** run the failed scenario on DBOS and compare. (Done for C3 and C4: DBOS passed both, and pg-boss stays, ADR 0037.)

9. **`auth-foundation`** (2 days)
   - **Question:** does better-auth give ostra organizations, usernames and runner sign-in on its stack?
   - **Tests the decisions:** Q35, Q54, Q102, ADR 0026.
   - **Passes when:**
     - With Prisma 7 on Postgres: sign up, sign in by username and by email, two organizations with one member in both, an invite link with no mail server, an admin's reset link, and a device-code sign-in for a personal runner.
     - A member of one organization can't read the other's rows.
     - Strict typecheck passes, the version is pinned exactly, and a contract test (sign up, session, role) is green.
   - **If it fails:** sign in by email only, or ostra keeps its own invitations.

10. **`is-opencode-good-enough`** (4 days)
    - **Question:** does OpenCode, on an ordinary model, turn realistic tickets into PRs a reviewer would merge?
    - **Tests the decisions:** Q45, Q46.
    - **Passes when:**
      - 10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in `model.env`.
      - Rated blind by two AI reviewers, each alone (the maintainer chose AI reviewers in place of a human): at least half are "merge as it is" or "merge with small edits" *(working value)*. A person's rating joins the score if one is added.
      - Recorded per run: spend from the proxy, time, turns, approvals and events.
    - **If it fails:** repeat on a second model. If both miss the bar, compare agents before milestone 1 builds further on OpenCode.
    - **Reworded after the run (Q159).** What the spike measured is "the 10 spike tickets, on a toy repo (a 400-line calculator), rated blind by two AI reviewers", and it passed. "Realistic tickets" moves to **a gate after milestone 1's end-to-end demo** (ticket 39): one ticket of each kind (a bug fix, a feature, a refactor, an "add tests") through the real flow, from a tracker issue or a prompt to a PR, on a repo in `ostra-test`, rated blind by two AI reviewers and by at least one person, with at least half mergeable. A model that misses it twice triggers the fallback above.

### Where the spikes stand (2026-11-18)

All ten spikes have a finding in `research/`, so milestone 0 is done. None sets a ledger row to `done`, because a spike is throwaway code (`AGENTS.md`). Milestone 1 started on what the first six found, and the other four (2, 3, 8 and 10) are folded in too, with the decisions they changed already in the ADRs. Several spikes still have checks that wait for a Linux machine with Docker, a Mac or a person. The last column lists them.

| Spike | Finding | State | Waiting on |
|---|---|---|---|
| 1 `how-should-the-runner-drive-opencode` | `research/spike-how-should-the-runner-drive-opencode.md` | Windows 11 only. B3 and B5 pass. B1 fails as written on plan, reject and reap, and the bar is reworded (above, ADR 0032) and the default agent is not reopened. B2 and B4 skipped | A Linux container with `NET_ADMIN` and `NET_RAW` (T1's packet capture, T3's `/proc` check, the POSIX paths), a Mac, one `SPIKE_LONG=1` run (about 25 minutes), a steer on a real model, the deny re-prompt end to end |
| 2 `can-a-session-move-to-a-fresh-box` | `research/spike-can-a-session-move-to-a-fresh-box.md` | Windows only, in directory boxes with no containers. B3, B4 and B5 pass and nothing failed. B1 (four container checks) and B2 (the CI check) are skipped. The template's wording, the moved branch and the lost box are decided (ADR 0039, Q128, Q150) | Docker (spike 3's box), a push-triggered workflow in `test1`, a real long session with compaction on, other models, Linux and macOS, several repos |
| 3 `what-is-inside-a-box` | `research/spike-what-is-inside-a-box.md` | Windows only, a rehearsal with no containers: 33 checks pass, none fail and 17 are skipped, so 0 of 5 bullets are met. It found eight places where a first real run will likely fail or overstate, and decided the Docker subnets, the Kubernetes egress difference, the git proxy's URL, the snapshot's mount, the scan order and Kubernetes 1.29 (ADRs 0029, 0030, 0038) | A Linux host with Docker and both images, a cluster that enforces NetworkPolicy, `runsc`, `buildctl` with `rootlesskit`, a registry; the real-box mode has never run. Milestone 5's ticket 35 wrote these checks as the `live-docker` and `live-kind` jobs of `proof.yml`, which haven't run yet (2026-11-20) |
| 4 `github-app-and-git-proxy` | `research/spike-github-app-and-git-proxy.md` | Mostly done on real GitHub: bullet 1 is met and nothing failed. Four rows skipped | The token in the agent's container (spike 3's box), the 500 MiB pack, a token for a second sandbox user who can approve (the check flip), Linear's GitHub app on `ostra-test` (the Linear link) |
| 5 `linear-agent-mode` | `research/spike-linear-agent-mode.md`, updated after the real run, and the spike's README | Real run of 2026-11-18: the install and the keep-alive pass, the 50 delegations pass server-side (end to end inconclusive: clock skew), the SDK bullet passes, the stop and follow-up bullet is not verified. A personal API key can't post an activity | A second real run with a person pressing Send stop request, after a clock resync |
| 6 `runner-transport` | `research/spike-runner-transport.md` | Windows only. No check failed. Criteria 3 and 5 pass on Windows, most of 2 passes, 5 checks skipped. The 11-minute line is reworded (above). Milestone 5's demo (2026-11-20) ran a runner built one minor behind the server, which worked, and one two minors behind, which stopped with the fix (`specs/m5-the-fleet/demo.md`) | macOS and Linux, real nginx, 2,000 connections and 1,000 sessions on Linux, a real laptop sleep (ticket 35's Linux and macOS jobs are written and haven't run) |
| 7 `live-stream-and-task-view` | `research/spike-live-stream-and-task-view.md` | Windows, headless Edge. Two checks fail (the render bar, now decided, and the recorded sessions) and two are skipped. The bar isn't met | The load bar's shape on a Linux host, spike 1's recordings, a render measurement on the reference laptop |
| 8 `durable-queue-choice` | `research/spike-durable-queue-choice.md` | Windows only. Six of seven criteria pass. C4 fails on pg-boss's own cron, and the fallback was run: DBOS passed it. pg-boss stays, with schedules that start work on ostra's own table (ADR 0037, F-106) | The scheduler tick built and the hunt run against it, Linux and macOS, Postgres 16 and 17, a pooler |
| 9 `auth-foundation` | `research/spike-auth-foundation.md` | Every row passes on embedded Postgres 18.6, on Windows. Neither fallback is needed | A Postgres of its own, Linux and macOS, the browser side, rate limits, the upgrade path |
| 10 `is-opencode-good-enough` | `research/spike-is-opencode-good-enough.md` | Windows, a toy repo. 30 of 30 runs completed, CI green and the hidden checks passed on 30 of 30, $0.2040 in all, and two blind AI reviewers rated 100% mergeable. The bar is reworded and a realistic gate added (Q159). OpenCode stays the default agent (ADR 0032) | The realistic gate (needs milestone 1's flow), a rerun of `pnpm spike` for the key scan, Linux and macOS, a person's rating (optional) |

**What milestone 1 can build on now:** the ACP driver, the key proxy and the stub models (spike 1); the git proxy, App authentication and the PR flow (spike 4); the runner protocol (spike 6); the event stream, the fold and the task page (spike 7); better-auth (spike 9); the session archive, the hidden ref and the rebuild template (spike 2); pg-boss behind `packages/jobs`, with schedules on ostra's own table (spike 8); OpenCode as the default agent (spike 10). The box (spike 3) is the one thing that builds on a design and not on a run, because its real-box mode has never run. Product code ports these and never imports from `spikes/`.

**Order.** Spikes 1, 2 and 3 run in sequence, because each builds on the one before. Spikes 4 to 9 are independent and can run beside them. Spike 10 runs last, on what 1 to 4 built. That's about 47 working days in a row, and fewer in parallel.

**What happened to the first six.** The old spike 1 (Claude Code through ACP, on a subscription login) is spike 1 with OpenCode, on keys. Claude Code on keys moves to milestone 7 and isn't spiked (and, on 2026-11-19, after v1). The old 2 is spike 2. The old 3 is spike 5. The old 4 is spike 4, with the git proxy in place of a credential helper. The old 5 (the runner on Node and Bun) is spikes 3 and 6, without Bun. The old 6 is spike 8, with the order of the two libraries reversed. Spikes 7, 9 and 10 are new. The sync-engine spike, the hosted-sandbox spike and the Rivet arm are dropped.

## Outside the code (long lead times)

Secrets for development live in `~/.config/ostra-dev/`, never in the repo.

| What | Needed for | Status |
|---|---|---|
| A GitHub org used only as a sandbox. It holds the test repos and the test GitHub App, so no real repo is ever touched. The public ostra repo is separate | Spikes 2, 3, 4 and 10, and every end-to-end test after them | **Done 2026-11-18:** `ostra-test`, with two private test repos, and the test GitHub App, created by spike 4's manifest flow |
| A Linear workspace for tests | Spikes 5 and 10 | **Done 2026-11-18:** the maintainer named a workspace for tests, and its key is in `linear.env` |
| `~/.config/ostra-dev/model.env`: any base URL, token and model ID | Spikes 1, 2, 3, 7 and 10 | **Done 2026-11-18:** filled in and checked: the endpoint lists the model, and a request succeeds |
| An endpoint that speaks Anthropic's Messages API, from any provider or gateway that serves it, for Claude Code (F-018). `model.env` may already serve it. If its endpoint speaks only the other API format, a second endpoint is needed | After v1, with F-018 (it was milestone 7 until 2026-11-19) | **Not needed for v1 (2026-11-19).** Checked by names only, 2026-11-19: `model.env` names one endpoint and no format. Milestone 7's demo tests it in Anthropic's format first; if that fails, the maintainer adds `OSTRA_DEV_ANTHROPIC_BASE_URL`, `OSTRA_DEV_ANTHROPIC_API_KEY` and `OSTRA_DEV_ANTHROPIC_MODEL_ID` (`specs/m7-launch/spec.md` section 3, Q253) |
| A public HTTPS address for the dev server (any tunnel or reverse proxy) | Spike 5, and the webhooks in spike 4 | A Cloudflare quick tunnel (`cloudflared`, free, no account), started when spikes 4 and 5 need it. Installing it asks the maintainer first |
| A Linux machine with Docker, for gVisor and a small Kubernetes cluster | Spikes 1, 2, 3, 6 and 7, and the `docker` executor's live test (F-017) | Later, by the maintainer's choice. Until then, those spikes run only their parts that work without it, and milestone 1 demos on the `host` executor |
| A push-triggered workflow in the test repo `test1`, for example `.github/workflows/ci.yml` with `on: push` and one `echo` step | Spike 2's B2 (whether GitHub starts CI for the hidden ref), and F-096's test | For the maintainer |
| A second sandbox GitHub user who isn't the driver and can approve, with a token in `GITHUB_TEST_REVIEWER_TOKEN` | Spike 4's check flip, and F-104's test | For the maintainer |
| Any container registry the test cluster can pull from | Spike 3 | Any registry will do |
| A free name for the CLI's npm package, and a namespace for the images (Q80, Q82) | Milestone 7 | For the maintainer to check and register |
| The name check of 2026-11-17. **Taken:** npm `ostra` (abandoned since 2023), GitHub `ostra` (a personal account), ostra.dev, ostra.ai, ostra.app (a board game) and ostrahq.com. **Free:** GitHub `ostrahq` and `getostra`, and getostra.com. npm `ostra-runner` was free too, but ADR 0046 retired that name, so it isn't a candidate for the CLI's package. **To confirm at a registrar:** ostra.sh, ostra.so and ostra.io showed no record | Milestone 7 | Recorded; confirm before registering |
| Signing certificates for runner binaries: an Apple Developer Program membership and a Windows code-signing certificate (F-085) | After v1 | Not needed for v1: signed binaries are dropped from the v1 list |
| A Mac | The `host` executor's containment case on macOS (ADR 0029, Q126; milestone 2's ticket 42), which F-014's "done" waits on, and the macOS halves of spikes 1 and 6 | For the maintainer |
| Whether Anthropic's terms let ostra's public images include Claude Code (Q266, ADR 0062) | After v1, with F-018 (it was milestone 7 until 2026-11-19); nothing waits for it | For the maintainer, when F-018 is built |
| The contributor agreement and the licensor (ADR 0048, Q109, Q110) | Before anyone but the licensor contributes code, the maintainer's team included | **Done 2026-11-19:** the agreement is in `CONTRIBUTING.md`, a check on each pull request asks for its box, and the licensor line stays as it is. No lawyer's review is waited for. Before someone else gets write access, they agree in one pull request of their own |

## How each milestone runs

1. The milestone's panel screens are designed first, image first, through the `ui-taste` skill against `brand/brief.md`. The approved pictures land in `brand/app-targets/`.
2. A spec in `context/specs/<slug>/spec.md` (the `to-spec` skill) names the milestone's feature IDs. Its test seams and schema changes are agreed before building.
3. Tickets come from the spec (the `to-tickets` skill), each with its blocking edges.
4. The milestone ends with a demo against the test workspaces. Every feature it finished is set to `done` in the ledger in the same commit.

## ostra builds ostra

Once the maintainer provides Linear access, ostra's own tickets move from `context/specs/` into a Linear workspace. From milestone 3 on, ostra's development runs through ostra itself, which makes the maintainer's team its first real users (Q101).
