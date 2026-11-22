# Domain model

**Status:** draft (2026-11-17), from grilling rounds 1–5. Reworked on 2026-11-18 from the delegated answers in `history/answers-2026-11-18.md` (section 4.5). Amended on 2026-11-19 from the questions milestone 1 raised (`history/answers-2026-11-19.md`): how a code task's PRs end (Q107), a runner's drain, resume and revoke (Q108, Q131), the task token (Q129), a queued task's offer (Q132) and files outside every repo (Q133). Terms follow `GLOSSARY.md`; this document says how they relate and how they change. Features are cited by ledger ID (`features.md`), decisions by ADR number (`decisions/`), and the answers by question ID (Q-numbers in the answers file).

## What exists

```
Install ── Organization ─┬─ Member (admin | member)
                         ├─ Connection (GitHub Apps, the Linear app) ── Installation (linked)
                         ├─ Model provider ── Model
                         ├─ Runner pool ── Runner        (a personal runner belongs to one member)
                         ├─ Agent profile ── Library item (attached, or on every profile)
                         ├─ Library item ── Version (its pin); Library source (the allowlist), Library suggestion
                         ├─ Memory note, Budget, Audit entry
                         └─ Project ─┬─ Project member (admin | member), when the project is restricted
                                     ├─ Repo (linked), Board
                                     ├─ Provider list (its own, or the organization's default) ── Model choice
                                     ├─ Environment ── Variable or secret (per repo), Service, Check, Snapshot, App process
                                     ├─ Automation (intake rule | schedule)
                                     ├─ Memory note, Proposal, Budget
                                     └─ Task (refine | code | review)
                                          ├─ Session ── Turn ── Event
                                          ├─ Needs-you item, Approval
                                          ├─ Task repo (branch, PR)        one per repo the task changed
                                          ├─ Box (through a lease) ── App process in the box, View of a preview
                                          ├─ Attachment (screenshot | recording), Announced preview
                                          ├─ Preview access (level, named people), Preview link, One-time code
                                          └─ Draft (refine) · Finding (review)

Outside ostra:  Ticket (the tracker) ── source of ──▶ Task ──▶ PR (the code host), one per task repo
```

### The organization

| Thing | Belongs to | Notes |
|---|---|---|
| **Organization** | the install | The data model holds many. An install starts with one, and the first account is the instance admin (Q102, F-049). In v1 an install runs that one organization, with a team's clients as projects inside it; installs with several come after v1 (F-134, 2026-11-19). Every other record belongs to exactly one organization (ADR 0026). |
| **Member** | an organization | An account with a unique username, an email address and a password (Q54, F-002). One account can be a member of several organizations in the data model, and in the product after v1 (F-134). Is an admin or a member of the organization (Q35, F-003). Links a GitHub account once, for identity only: co-author credit, `@ostra` and matching reviewers (Q55, F-119, F-053). |
| **Connection** | an organization | The organization's own GitHub App and Linear app, and any App a client's GitHub organization owns, connected beside it. Webhooks are routed by connection, not by one install-wide address (Q102, F-005, F-006, F-136). |
| **Installation** | a connection | A GitHub account's install of the App, with the repos that account chose. ostra works only through a linked one: the App owner's own account is linked when seen, any other waits until an organization admin links it. For an installation that isn't linked, ostra mints no token, offers no repo and stores no webhook delivery (Q279, Q280, F-136). |
| **Model provider** | an organization | An API base URL and a token, in one of the two API formats that "Test connection" detects (Q34, F-088). Each is one key, and an organization may hold several that serve the same models, one per client (F-135). Usable on personal runners only when an admin allows it for that provider; off by default (Q47). |
| **Model** | a model provider | Listed from the endpoint itself. Names, limits and prices come from the models.dev catalog, the endpoint's own list, or a price an admin enters (Q34, Q105). |
| **Runner pool** | an organization | A named set of runners that projects send tasks to (Q9, F-091). Has its join tokens, may require an admin to approve each new runner, and caps its total boxes and each project's share (Q43, Q48). |
| **Join token** | a runner pool | The key a runner joins the pool with. Shown once, stored hashed, expires after 30 days by default *(working value)*, and can be revoked. Any token of the pool that hasn't expired or been revoked lets a runner join, and every join is an audit entry that names the token (Q48, Q94, Q130). |
| **Runner** | a runner pool, or one member | ostra's runner program, `ostra runner`. A pool runner gives tasks of any allowed project a place to run. A personal runner belongs to one member and runs only that member's tasks, and their follow-ups (Q32, Q44, F-013, F-014, F-015; ADR 0059 amended 2026-11-21). Each reports its executor (`docker`, `host` or `kubernetes`), capacity, labels and version (F-061, F-067). |
| **Agent profile** | an organization | Agent, its model provider and one of that provider's models by its model name (Q271, Q272 as changed 2026-11-20), instructions, skills, MCP servers, approval rules and plan-first. Its tasks use that provider's key and base URL alone, so it runs only in projects whose provider list allows it. One saved before 2026-11-20 may name no provider; each project's list then serves its model by name. Can be limited to some members. A project picks a default per task kind, among the profiles it allows (Q28, Q70, F-021, F-026, F-063, F-135). |
| **Memory note** | an organization or a project | One fact every task in its scope should know. Written by members, scanned for secrets and model-control tokens (Q84, Q86, Q88, Q91, F-109). Agents get an index and search the rest through ostra's MCP tools; only a read counts as a note's use (Q85, Q91, F-110). Repo and path scopes come later (F-129). |
| **Budget** | an organization or a project | A monthly spend limit. At 80% admins are told; at 100% new tasks and automatic rounds wait, and running tasks finish their current turn (Q105, F-037). |
| **Audit entry** | an organization | Who did what, when: task starts, approvals, takeovers, joins, credential use, provider, budget, pool and memory changes, admin changes (F-073). |

### The project

| Thing | Belongs to | Notes |
|---|---|---|
| **Project** | an organization | A product the organization works on: its repos, boards, environment, automations, memory and tasks (Q28, Q29, F-086). Open to the whole organization, or restricted to listed members (Q35, F-087). Names the pools it may use, a default box size and a default agent profile per task kind (Q32, Q43). Follows the organization's default provider list or has its own, which only an organization admin edits. The list decides which agent profiles run there (those whose provider it holds), and serves each model of a profile with no provider from exactly one provider on it (Q270, Q272, Q273, F-135). |
| **Project member** | a project | A member's role in a restricted project: admin or member (Q35, F-087). |
| **Repo** | a project | A GitHub repo from a linked installation of one of the organization's Apps, linked to the project. A project's repos may come from several GitHub accounts (F-136). A repo linked to two projects is two links, with a separate set of secrets in each environment (Q29). |
| **Board** | a project | A Linear team or Linear project, later a Jira project or board. Maps ticket statuses, "ready" among them (Q67, F-007, F-031). A project may have no board and run on prompts only (Q31). |
| **Environment** | a project | One per project: the recipe for every box. A base image, a setup script, services, checks, and variables, secrets and files that each belong to one repo (Q33, F-050). Drafted by detection (Q2, F-112), and checked by the onboarding task (Q49, F-113). |
| **Variable or secret** | an environment | Names one repo. A secret marked "available during setup" is mounted for the snapshot's build only (Q39). Secrets stay visible to the code under test (Q17). |
| **Service** | an environment | A program started beside the agent for its tests, such as a database: image, variables, port, health check (Q40, Q96, F-094). The `host` executor starts none (ADR 0029). |
| **Check** | an environment | A command ostra runs before it opens a PR (F-054). The code host's own pipeline is CI. |
| **Snapshot** | an environment | The environment prepared ahead of time: an OCI image with the base image, every repo checked out and the setup's result, never a secret. One per project (Q39, Q95, F-051). Pushed to the organization's registry, which a `kubernetes` pool requires (F-120). |
| **Automation** | a project | A rule that starts tasks by itself: an intake rule (a ticket filter) or a schedule. Names a task kind, an agent profile and pool labels, never a repo (Q10, F-011, F-106). |
| **Proposal** | a project | A memory note suggested by an agent or a review, waiting for a member (Q86, Q87, F-111). Shown as a count on the project's Memory page, not as a needs-you item. |
| **Ticket** | the tracker | ostra stores a reference and a cached copy, never the source of truth. |

### The task

| Thing | Belongs to | Notes |
|---|---|---|
| **Task** | a project | ostra's long-lived unit of work in one project (ADR 0006, ADR 0027). Has a kind (refine, code or review) and a source (a ticket, a prompt, or later a PR) (Q64, Q31, F-097). Holds the driver, its sessions and its task repos. May change any of the project's repos (Q29, F-098). A review task links to the code task it reviews (Q71): it's that task's follow-up, which ostra starts for the code task's member, runs where the code task ran or on the pools, and the panel shows under it (ADR 0059 amended 2026-11-21). |
| **Task repo** | a task | One per repo the task changed: the branch and the PR. The branch name is the same in every repo, and the PRs link to each other and to the ticket (Q29, F-030, F-031). |
| **Workspace** | a task | The checkouts of the project's repos inside the task's box, side by side, on the task's branches (F-016). The agent starts inside the repo when the project has one, and at the workspace root when it has several, with instructions that name each repo's folder. A file left in the root, outside every repo, belongs to no branch: ostra says so and never moves it (Q133). |
| **Box** | a task, through a lease | The task's own isolated computer: the agent's container (the repos and the tools, no credentials), the sidecar, and the environment's services (Q38, ADR 0029). Serves one task and can be thrown away at any time. The `host` executor has no box: the task runs in a worktree, and the runner process does the sidecar's work. |
| **Sidecar** | a box | The ostra container that holds the task's credentials, runs the key proxy, the git proxy, ostra's MCP tools and the ACP driver, and spools events. It connects to the server itself, with a task token: a token for that one task, valid exactly as long as the task's lease, and the only thing the box's credentials are given to (Q26, Q38, Q129, ADR 0030, ADR 0034). |
| **Lease** | a task | The server's grant that lets one box work on the task. Each dispatch raises its epoch, and writes from an older epoch are refused (ADR 0034, F-045). |
| **Session** | a task | One conversation with one agent profile in one box. Records how it began (below). Its full history is kept on the server (ADR 0006). |
| **Turn** | a session | One prompt and the agent's full response. After every turn, unfinished work goes to a hidden ref and the agent's session archive goes to the server (Q42, Q53, F-096). |
| **Event** | a session | One thing the agent or ostra did: a message, a tool call, a file change, a question, a state change. Saved before ostra acts on it, and carries two numbers (below) (ADR 0011). |
| **Command** | a task | A numbered instruction from the server to a runner or a sidecar: dispatch, steer, interrupt, stop, an approval's answer. |
| **Needs-you item** | a task | Something a person has to act on, shown to its audience (below). Open, answered or dismissed. |
| **Approval** | a task | The agent's request to do something its profile's rules hold back, such as a new dependency or a migration (F-026). Shown as a needs-you item. Has its own lifecycle (below). |
| **Draft** | a refine task | What a refine task hands in, as typed fields: description, acceptance criteria, edge cases, open questions and sub-tickets (Q67, F-099). |
| **Finding** | a review task | One point an AI review raises about a PR: blocking or a nit, with a file and a line (Q71, F-100). |

## Task kinds

A task's kind is in the schema from the first migration (Q64, ADR 0028). It fixes what the box may do and how the task ends.

| Kind | Starts from | The box may | Hands in | Ends |
|---|---|---|---|---|
| **refine** | a ticket or a prompt | read the code, answer questions, prototype. Its git proxy accepts fetches only (Q66) | a draft, through ostra's MCP tools (Q67) | **done** when a member accepts the draft |
| **code** | a ticket or a prompt | change any of the project's repos and push the task's branches and its hidden ref (Q29, Q41) | the PR text, through ostra's MCP tools; one PR per changed repo | **merged** when none of its PRs is open and at least one merged (Q107) |
| **review** | a code task's PR (later, a PR people wrote: F-123) | read the PR's head, read-only (Q71) | findings, through ostra's MCP tools | **done** when its findings are posted |

The onboarding task is a code task from a built-in template, not a fourth kind (Q49).

## A task's lifecycle

A task's state is a discriminated union per kind (Q64). Every kind shares the first six states.

### Every kind

```
 awaiting approval ─┐   (tasks from outside ostra, F-040)
                    ▼
 ──▶ queued ──▶ preparing ──▶ running ──▶ the kind's own states (below)
                   │            │  ▲
                   ▼            ▼  │
                needs you ◀─────┘  │
                   │               │
                   └── answer, steer or reopen ──▶ queued …
                  any state ──▶ stopped (by a member; can be reopened)
```

| State | Means | Leaves when |
|---|---|---|
| **awaiting approval** | Started by someone outside ostra; nothing runs yet (F-040) | A member approves it (→ queued) or rejects it (→ stopped) |
| **queued** | Waiting for a place to run: a runner in one of the project's pools, by labels, box size and free capacity, within the project's cap on that pool and its budget. Or the member's own personal runner, when they chose it. A follow-up of a member's code task (its AI review) waits for the pools or for a personal runner of that member that its code task ran on, whichever is free first (ADR 0059, amended 2026-11-21). Ordered by ticket priority (Q4, Q32, Q43, Q105, F-067, F-069). A dispatch reaches a runner as an offer, and the task is still queued while the offer is out: its page says which runner it was offered to, or why no runner fits (Q132) | A runner accepts the offer (→ preparing). An offer that is refused, or not answered in 2 minutes *(working value)*, changes nothing: the task is still queued |
| **preparing** | The executor is creating the box from the snapshot, starting its services, checking out the task's branches and restoring the session (F-016, F-050, F-051, F-094) | The box is ready (→ running), or setup fails (→ needs you) |
| **running** | A session is active | The session ends with what the kind hands in (→ the kind's states), or anything in the "needs you" list below happens |
| **needs you** | A person has to act (below) | A member answers, approves, steers or reopens (→ queued, or → running while the box is still warm), or stops it |
| **stopped** | A member stopped it, a code task's PRs all closed with none merged (Q107), or its runner was lost or revoked (F-045, Q131) | Reopening (→ queued) |

A task that is queued after a stop or a long wait almost always lands on a fresh box. That's the normal path, not the exception (Q42, Q53, F-033).

### Code tasks

```
 running ──▶ in review ──▶ merged ── reopen ──▶ queued …   (a fresh branch in each repo whose PR merged, F-066)
               │
               ├──▶ needs you   (a round cap or the spend cap is reached)
               ├──▶ queued      (reopen, @ostra, Update branch, a diff comment, a "changes requested" review)
               └──▶ stopped     (no PR is open, and none merged)
```

**In review** holds while any of the task's PRs is open (Q29).

**How it ends** (Q107). The task follows its PRs, whichever order their events arrive in, so a webhook and the reconcile (F-044) always agree:

| The task's PRs | The task is |
|---|---|
| at least one is open | in review |
| none is open, and at least one merged | merged |
| none is open, and none merged | stopped |

A repo whose PR closed unmerged shows that on the task. After a reopen that repo keeps its branch, and the task's next push to it opens a new PR. A PR that someone reopens on GitHub puts the task back in review, waiting for a reviewer.

While the task is in review, its sub-state says what it's waiting on:

```
 CI running ── fails ──▶ fixing CI ── pushed ──▶ CI running
     │ passes
     ▼
 AI review ── blocking findings ──▶ fixing findings ── pushed ──▶ CI running
     │ no blocking findings, or AI review is off for the project
     ▼
 waiting for a reviewer
```

| Sub-state | Means | Leaves when |
|---|---|---|
| **CI running** | The code host's CI runs on the task's PRs | It passes (→ AI review) or fails (→ fixing CI) |
| **fixing CI** | The coding agent has the failing checks and their logs, for at most 2 rounds *(working value)* (Q12, F-035) | It pushes (→ CI running), or the cap is reached (→ needs you) |
| **AI review** | The linked review task reads the PR's head (Q71, F-100) | Its findings are posted: blocking ones (→ fixing findings), none (→ waiting for a reviewer) |
| **fixing findings** | The coding agent has the blocking findings, for at most 2 rounds *(working value)*. Nits are only listed (Q72, F-101) | It pushes (→ CI running), or the cap is reached (→ needs you) |
| **waiting for a reviewer** | The PRs are green and reviewed by the agent. A reviewer has it under "needs you" (Q73, F-102) | A "changes requested" review (→ queued, F-105), or the last open PR merges or closes (→ merged, or → stopped when none merged) |

In the two fixing sub-states a session runs in a box, and the task stays in review because its PRs stay open. Together, the CI and AI review rounds give a task at most 4 automatic turns *(working value)* before a person has to act. Every automatic turn also stops at the task's spend cap, and waits while its budget is full (Q72, Q105, ADR 0041, ADR 0042).

| State | Means | Leaves when |
|---|---|---|
| **in review** | At least one PR is open. The sub-state above says what it waits on | As the diagram shows |
| **merged** | None of the task's PRs is open, and at least one merged (Q107) | Reopening (→ queued). A repo whose PR merged gets a fresh branch and a new PR (F-066). A PR reopened on GitHub (→ in review) |

### Refine and review tasks

```
 refine:  running ──▶ needs you (the draft is handed in) ── a member accepts it ──▶ done ── reopen ──▶ queued …
 review:  running ──▶ done (the findings are posted) ── the next round ──▶ queued …
```

| State | Means | Leaves when |
|---|---|---|
| **done** | Refine: a member accepted the draft, with "Update ticket" or "Mark ready" (Q67). Review: ostra posted the findings to GitHub as a comment-type review with line comments. The review agent never approves and never requests changes (Q71) | Reopening (→ queued). For a review task, the code task's next round of review reopens it on the new head |

A review task never stays running with nothing to hand in (2026-11-23, the stuck review). A turn that ends after its round's review posted, or after the round ended without it (a head moved under it, its code task left the AI review), rests it as done: a member's message to a posted review is answered in a turn of its own, and the review stands as posted. While its round still waits for the review, a turn's end keeps it running on its warm box, so a message still reaches its agent; once its session ends without the review, it needs its driver as stalled, and one click carries it on. A crash under it, such as a runner's restart, needs its driver as crashed, as for any task (F-047).

### When a task needs you

Each case is a needs-you item:
- the agent asks a question or wants an approval (F-026)
- the agent proposes a plan, under plan-first (F-063)
- a session ends without changes (F-065)
- a turn leaves files in the workspace outside every repo (Q133). This item sits beside the turn's result: a repo that changed still gets its PR
- a session times out, stalls or reaches the task's spend cap (F-068)
- a session, the box or the environment's setup crashes (F-047)
- the ticket was closed or cancelled while the task ran (F-066)
- a refine task hands in its draft (Q67)
- a fixing round reaches its cap (Q12, Q72)
- a code task's PRs wait for a reviewer (Q73)
- an onboarding task proposes a corrected environment, for a project admin to accept (Q49)

A turn that waits on a person follows the box's idle timer: after 15 minutes *(working value)* the turn is cancelled and the box stops. The needs-you item stays open, and answering it reopens the task with the decision (Q42).

**An item never outlives its reason** (2026-11-20). It closes when what it waits on ends:
- a member answers it, or dismisses one that sits beside the task (a restore conflict, files outside the repos);
- a member's message that starts the task's next turn answers what the last turn's end raised: no changes, a stall, the spend cap, a crash, a failed setup, a closed ticket, a draft, a round cap. An approval, a question and a plan wait on their own answer;
- a reopen answers what the task needed;
- the task stops, merges or is done: its open items are dismissed with it, with nobody's answer;
- a newer item of the same reason on the same task supersedes it (2026-11-20): the older is dismissed by ostra, its notifications closed, and the newer is the moment, with its own notifications. A task that ends three turns without changes needs you once, with the last turn's summary. Approvals, questions and plans don't supersede: each waits on its own request's answer, and so does a runner's approval. Core's clean-up collapses the duplicates older releases left, keeping the newest.

What waits on a member is one rule, read the same everywhere: Home's needs-you section and its total, the Needs you page's Open tab and its count, and the sidebar's count all count the open items the member is the audience of or can answer, so they never disagree. Whether the member has read an item is their notification's business, and changes only the page's unread marks.

**Each item has an audience** (Q73, F-036):

| Audience | Gets |
|---|---|
| **the driver** | the task's questions, approvals, plans, drafts, stops and crashes, and files left outside its repos, while the task has a driver |
| **the reviewer** | a code task waiting for a reviewer. The reviewer comes from the PR's requested reviewers or CODEOWNERS, matched to members by their linked GitHub account (Q73) |
| **the members of the project** | items on a task with no driver, such as one an automation or someone outside ostra started, and environment proposals |

Any member who can open the project may answer an approval, whoever its audience is. The first answer wins, and it's an audit entry.

## A session's lifecycle

```
 starting ──▶ running ⇄ waiting (on a needs-you item)
                │  ▲
                ▼  │
               idle (the turn is over; the box stays warm)
                │
                ├──▶ ended (the box stopped: with changes | without changes)
                ├──▶ stopped (by a member, by runaway protection, or at the spend cap)
                └──▶ crashed (the agent, the sidecar or the box died; the branches stay, and the hidden ref and archive are those of the last finished turn)
```

Only one session per task is starting, running, waiting or idle at any time. A session that ends, stops or crashes ends the task's lease with it, so its runner's slot is free for the next task (ADR 0034).

**A session records how it began** (Q53, ADR 0006, ADR 0039):

| Origin | When | From |
|---|---|---|
| **new** | the task's first session | the ticket or the prompt |
| **resumed** | the task's stopped worktree is still kept, on the `host` runner that ran it (Q343) | the agent's own session, in place |
| **restored** | a fresh box: the normal case once boxes stop after 15 idle minutes, and every reopen on `docker` and `kubernetes`, whose box goes with its session (F-033, Q343) | the session archive and the hidden ref |
| **rebuilt** | the archive can't be restored | a fixed template: the ticket, the PRs' text, every member message, every agent message, an interrupted turn's text in a section of its own, and the branches' log (Q128). ostra calls no model to write it |

## A box's lifecycle

```
 creating ──▶ preparing ──▶ ready ⇄ idle ──▶ stopped ──▶ released
     │            │           │       │
     └────────────┴───────────┴───────┴──▶ failed
```

| State | Means | Leaves when |
|---|---|---|
| **creating** | The executor is creating the box's containers (`docker`) or pod (`kubernetes`). An autoscaled pool reports "waiting for a node" here, so the dispatch doesn't time out | The containers run (→ preparing) |
| **preparing** | The box pulls the snapshot, starts its services, checks out the branches and restores the session. The sidecar connects to the server with its task token | It's ready (→ ready), or setup fails (→ failed) |
| **ready** | A session runs a turn, or one can start at once | The turn ends (→ idle) |
| **idle** | No turn is running. The hidden ref and the archive were saved when the last turn ended | A new turn starts (→ ready), or 15 minutes pass *(working value)* (→ stopped) (Q42) |
| **stopped** | The session ended and the agent stopped. Only a `host` worktree waits here, kept for the task's next session on its runner | That session resumes it (→ ready), or it's released (→ released): its task's last PR merged or closed, or 14 idle days *(working value)* passed (F-079). A `docker` box or a `kubernetes` pod goes with its session's sidecar, so it moves on at once (→ released), and is never kept (Q343) |
| **released** | The box is gone and its lease has ended (F-079) | Never: a box is never reused |
| **failed** | Creating or preparing failed, or the box was lost with its host | Never. The task reopens on a fresh box (F-045, F-047) |

The `host` executor has no box. Its worktree goes through the same states, so a task behaves the same on every executor. It starts no services, has no box sizes, and keeps its stopped worktree for the task's next session, where a box goes at its stop: three of the differences ADR 0029 records (the last since Q346, 2026-11-22; ADR 0039).

## A runner's lifecycle

```
 joining ──▶ online ⇄ offline
                │         │
          drain ▼         ▼ drain
               draining ── resume ──▶ online, or offline when it isn't connected

 any state but revoked ── revoke ──▶ revoked     (a rejected join is a revoke from joining)
```

| State | Means | Leaves when |
|---|---|---|
| **joining** | A pool runner has traded its join token for its own identity, a key pair whose private half never leaves it. A personal runner is signing in with a device code. A pool that requires it waits here for an admin to approve, connected or not, and is offered no task until then (Q48, Q94, Q130). The runner is pinned to its server's version (F-061) | It's accepted (→ online), or rejected (→ revoked) |
| **online** | Connected, and takes dispatches up to its capacity. A runner that is shutting down by itself, for an upgrade or a restart, stays online with no free slots until it disconnects. That isn't a drain, and it needs no admin (Q108) | The connection drops (→ offline), or an admin drains it (→ draining) |
| **offline** | Not connected. On `docker` and `kubernetes` its boxes keep working, because each sidecar connects on its own (Q38). Leases that outlive the grace period end, and their writes are refused (F-045) | It reconnects (→ online), or an admin drains it (→ draining) |
| **draining** | An admin's hold: it takes no new tasks, and its running tasks finish. It stays draining whether it is connected or not, through disconnects and restarts, and the panel shows its connection beside the state (Q108) | An admin resumes it (→ online, or → offline when it isn't connected) |
| **revoked** | Its identity is revoked, and it can't connect again. An admin can revoke a runner in any other state, and a member their own personal runner. A connected runner is disconnected at once. Its leases end with the revoke, with no grace: its tasks stop, and each is ready to reopen on another runner (Q131, F-045). Each runner is revoked on its own; rotating a join token disconnects no runner that already joined (Q94) | Never |

## A join token's lifecycle

```
 active ──▶ expired      (its lifetime passed: 30 days by default, another, or none)
    └─────▶ revoked      (an admin revoked it)
```

| State | Means | Leaves when |
|---|---|---|
| **active** | A runner can join the token's pool with it. It is stored hashed and was shown once (Q48) | Its lifetime passes (→ expired), or an admin revokes it (→ revoked) |
| **expired** | No runner can join with it. Runners that joined with it stay | Never |
| **revoked** | The same, by an admin's hand. Rotating a token disconnects no runner (Q94) | Never |

## A queued task's place

A task in `queued` waits in the pool queue of every pool of its project that could run it (ADR 0059). Its place is its ticket priority (Urgent, High, Medium, Low; a prompt task and a ticket without a priority are Medium), then the time it was first queued. A task that goes back to the queue (an offer declined or timed out, a box with no node, a revoked runner) keeps its first queued time. A pool admits a task when one of its runners fits it and its project is under its share of the pool; a project at its share is passed over and the next task considered. An admin cancels a queued task from the pool's queue, and a member their own: it moves to `stopped` with the reason `cancelled`.

## A snapshot's lifecycle

```
 queued ──▶ building ──▶ ready ──▶ replaced
   ▲          │
   └──────────┤ refused, or its runner went offline
              └──▶ failed
```

| State | Means | Leaves when |
|---|---|---|
| **queued** | A rebuild is due: the environment changed, a lockfile changed on a default branch, or a default branch moved since last night (Q39) | A runner takes the build (→ building) |
| **building** | A runner builds the image: a `docker` runner itself, a `kubernetes` pool in a rootless BuildKit pod. Setup secrets are mounted for the build only (Q39, Q95) | The image is pushed and checked (→ ready), or the build fails (→ failed). The runner refused the build, or went offline before it reported (→ queued, for another runner; milestone 3, ticket 26) |
| **ready** | New boxes of the project start from it | A newer snapshot is ready (→ replaced) |
| **replaced** | A newer snapshot took its place. Boxes that already started from it keep it | Never |
| **failed** | The build failed, or a setup secret's value was found in the image (Q39) | Never. The previous ready snapshot stays in use |

## An approval's lifecycle

```
 open ──┬──▶ answered (once | for this task | deny)
        ├──▶ answered by a rule
        └──▶ closed (cancelled | expired)
```

| State | Means | Leaves when |
|---|---|---|
| **open** | The agent asked, and the turn waits. It's a needs-you item | A member answers (→ answered), a rule answers (→ answered by a rule), or the turn ends without an answer (→ closed) |
| **answered** | A member answered: once, for this task, or deny. "For this task" adds an ostra rule to the task; the agent is always answered "once" (F-026) | Never |
| **answered by a rule** | A rule in the agent profile, or one added to the task, answered without a person | Never |
| **closed** | **cancelled:** the turn was interrupted or the task stopped. **expired:** the turn waited 15 minutes and was cancelled. The needs-you item stays open, and an answer then reopens the task with the decision (Q42) | Never |

## A proposal's lifecycle

```
 proposed ──┬──▶ approved
            ├──▶ rejected
            └──▶ merged into another note
```

| State | Means | Leaves when |
|---|---|---|
| **proposed** | An agent called the "propose a note" tool while it worked, or a member used "Remember this" on a review comment or a finding (Q87). It was scanned for secrets (Q88). A proposal that contradicts an existing note is shown beside it | A member approves it (→ approved), rejects it (→ rejected), or merges it into the note it overlaps (→ merged into another note) |
| **approved** | It became a memory note. Agents see it from their next session (Q86) | Never |
| **rejected** | No agent ever sees it | Never |
| **merged into another note** | Its content went into an existing note | Never |

## A membership's lifecycle

*Added 2026-11-19 for milestone 4 (ADR 0053).*

```
 (invitation accepted) ──▶ pending verification ──▶ active ──▶ removed
                     └─────────────────────────────▲
```

| State | Means | Leaves when |
|---|---|---|
| **pending verification** | The invitee signed up through an invitation on an install with email, and hasn't opened the verification mail. They see nothing of the organization | They open the link (→ active), or an admin removes them (→ removed) |
| **active** | A member, with their organization role and project roles. Without email, a membership starts here | An admin removes them (→ removed). The last admin can't be removed |
| **removed** | Kept for history: their name shows with "(removed)". Their project roles, personal runners, CLI sessions, driving and pending invitations ended with the removal | Never. Invited again, they get a new membership |

An **invitation** is `pending` until it's accepted, revoked or expired (7 days *(working value)*), and works once. Its link is its ID.

## The library's lifecycles

*Added 2026-11-21 for milestone 8 (ADR 0069, F-145). The code: `packages/domain/src/lifecycles/m8-library.ts`.*

An organization's library holds items, each a skill or an MCP server, pinned to one version at a time. Nothing moves by itself: the update check finds a newer version, and an organization admin decides (Q323).

**A version** is one pin of an item: a skill's commit and content hash, or a server's registry version.

```
 available ──┬──▶ current ──▶ superseded
             ├──▶ dismissed
             └──▶ superseded (a newer update found while it waited)
 (an install's first version starts current)
```

| State | Means | Leaves when |
|---|---|---|
| **available** | The update check found the pin moved and the content changed, and wrote its diff against the current version. A quiet count shows it to admins. An item has at most one waiting | An admin accepts it (→ current), or dismisses it (→ dismissed). A newer update found before anyone decided takes its place (→ superseded), so an accept always names the content the admin saw |
| **current** | The item's pin. Every attached profile's tasks take it at their next session | A newer version is accepted (→ superseded) |
| **dismissed** | An admin left the item where it was. The same content found again stays dismissed; a newer one shows again | Never |
| **superseded** | A newer version took its place | Never |

**A suggestion** is a member's reference and note (the note is never logged).

```
 open ──┬──▶ installed
        └──▶ dismissed
```

| State | Means | Leaves when |
|---|---|---|
| **open** | Admins see it in the library's count. One whose source isn't on the allowlist says so | An admin installs it (→ installed) or dismisses it (→ dismissed) |
| **installed** | It became an item, which it names | Never |
| **dismissed** | Nothing was installed | Never |

**An item** is `installed` until an admin removes it (→ `removed`), which detaches it from every profile; tasks lose it at their next session. A removed item is kept for history and never comes back: installing it again makes a new item.

## The previews' lifecycles

*Added 2026-11-21 for milestone 8 (ADR 0068, F-140 to F-144). The code: `packages/domain/src/lifecycles/m8-previews.ts`; the rules beside it in `packages/domain/src/previews/`.*

**An app process in a box** is the environment's process as one box runs it. Nothing starts it until something asks: the agent's `start_app`, the after-turn screenshots, an opened view, or "Start the app". Every process stops with its box. A stop wins over every start asked before it: a start that hasn't gone up `starting` yet starts nothing, one that has goes up `stopped` once, and `ready` never follows a stop. A start asked after a stop starts the process again once it has ended.

```
 stopped ──▶ starting ──┬──▶ ready ──┬──▶ exited
    ▲            │       │            └──▶ stopped (app.stop, or the box stops)
    │            │       └──▶ failed
    │            └──▶ stopped
    └── exited or failed ── start again ──▶ starting
```

| State | Means | Leaves when |
|---|---|---|
| **stopped** | Not running: the box just started, or it was stopped | Something asks for it (→ starting) |
| **starting** | Its command runs; its ready check is tried every 2 s for at most 120 s *(working values)* | The check passes (→ ready), it couldn't start, didn't get ready or exited first (→ failed, with its log's tail), or it's stopped (→ stopped) |
| **ready** | It serves its port: previews and screenshots reach it | It exits on its own (→ exited, with its log's tail), or it's stopped (→ stopped) |
| **exited** | It ended after it was ready | It's started again (→ starting) |
| **failed** | It never got ready; `app.process` names why, never its log | It's started again (→ starting) |

**A view** is one opening of a preview: the browser view, a tunnel, the native preview, or `ostra preview`, by a member or a link.

```
 opening ──▶ open ──▶ closed
    └──────────────▶ closed
```

| State | Means | Leaves when |
|---|---|---|
| **opening** | Its row and its `preview.opened` event are written, and `preview.open` went to the box's runner | The box's preview connection reaches a replica, which writes its presence (→ open), or it's refused, or its box refuses the `preview.open`, or takes it and then drops the view before it connects (`preview.dropped`) (→ closed at once, keeping the box's reason, which the pane's stream says), or 2 minutes pass without it (→ closed) |
| **open** | Its stream or tunnel runs; the pane's heartbeat comes every 30 s and keeps a watched box warm, up to `OSTRA_PREVIEW_WARM_MINUTES`. For `ostra preview` the core replica that has the CLI's socket writes that heartbeat while the tunnel is open, and checks the CLI session every 5 minutes. A native preview's view is core's own, one per viewer and lease, opened for its cookie on a new connection: the replica with the browser's traffic writes its heartbeat while a request or a socket is on it, and checks the viewer and the lease on each new connection and every 5 minutes. While it's open the runner's idle timer doesn't end the box | Its viewer closes it (for `ostra preview`, the CLI's socket closes), 2 minutes pass with no heartbeat (`preview.views-sweep`), its link ends, its CLI session ends, its box goes, or its box passes the warm cap (→ closed, and the box idles out). A native view also closes when its cookie's check refuses (a revoked link, a removed member, a signed-out session) or its box connection goes, and its cookie's next request opens one on the task's lease then |
| **closed** | Over; the page shows the last frame | Never |

**A preview link** opens one preview for whoever holds it: an expiring one (24 hours by default, `OSTRA_PREVIEW_LINK_MAX_DAYS` at most), or a public one where the organization allows them. Watch-only unless it allows input. Its token is kept as a hash.

```
 active ──┬──▶ expired
          └──▶ revoked
```

| State | Means | Leaves when |
|---|---|---|
| **active** | It opens its preview's viewer page | Its time passes (→ expired; a public link has none), a member revokes it, or a member sets the preview's level to its members or named people (→ revoked) |
| **expired** | Its page says it expired | Never |
| **revoked** | Its page says it was revoked | Never |

**A lease's purpose** says why its box runs: a `turn` of the agent, or the `app` alone. "Start the app" admits a lease with the purpose `app`: the box starts as for a reopen, runs the setup, restores the hidden ref, starts the app's processes, and launches no agent, so the key proxy counts no model call. The task's own state doesn't move while it runs; a declined or timed-out offer ends it with no requeue.

```
 app ── a member's message ──▶ turn      (the agent starts in the same box and session; the task moves as a reopen does)
```

**Who may open a preview** is its level: the project's members (the default, with no row), or named people, who see that preview and nothing else of the task, watch-only; and its links. It fails closed: a level, a link or a runner it can't read gives no view, and the page says why (`previewAccess`). Any member who can open the task sets it. Narrowing it ends every viewer who no longer qualifies, at once: setting the level to the members or named people revokes the preview's active links, and closes the views of those links and of members it no longer names; revoking a link closes its views; an organization admin turning public links off closes every public link's view. A viewer's access is read again at each heartbeat and each batch of input. A person newly named is told (a `preview_shared` notification, in the panel and by mail), and watches at the preview's own page, `/previews/<the level's ID>`, signed in; taking a name off tells no one.

## Files for the agent

*Added 2026-11-21 for milestone 9 (ADR 0070, F-148, F-149, F-150). The code: `packages/domain/src/lifecycles/m9-files.ts`; the rules beside it in `packages/domain/src/files/`.*

A **message file** is a file the agent gets with a message: a member's, attached in a message box, or a ticket's, fetched by core. Its bytes and its document's text are blobs; once sent they're the task's, so they follow its retention (F-079). Its name is made safe (letters, digits, spaces and `._-()`, at most 120 characters, its extension kept), and its kind is told from its bytes, never its name. Every sent file of a task is written under the workspace root's `.ostra/`, outside every repo: a message's in `attachments/<n>/`, `<n>` the message's number in the task's log, the ticket's in `ticket/`, each document's text beside it as `<name>.md`, again on every fresh box.

**A member's file** is an upload until a message takes it.

```
 uploaded ──┬──▶ sent      (bound to the message that took it)
            └──▶ expired   (no message took it within a day, or its member removed it: swept, with its blobs)
```

| State | Means | Leaves when |
|---|---|---|
| **uploaded** | The member's, in a project, no task's; its blobs the project's. Only that member can send or discard it. A member holds at most twice `OSTRA_MESSAGE_FILES_MAX` in a project at once, and core refuses the next upload | A message of that member in that project takes it, within the limits again (→ sent); left out at send, it stays an upload. A day passes unsent, or the member removes it from the box (`files.discard`) (→ expired, its blobs deleted by `files.sweep-unsent`) |
| **sent** | Its message's: its task, its place in the message and in the box, and whether it went to the model as an image too | Never |
| **expired** | No message can take it. Its blobs deleted by the sweep (removed by its member, within the hour), the row kept as its record; a store that didn't answer leaves them for the next hour's sweep | Never |

**A ticket's file** is what one read of the ticket made of a file it holds.

```
 sent | left_out | failed ── Retry, once ──▶ a new file (retryOfId)
```

| State | Means | Leaves when |
|---|---|---|
| **sent** | Fetched within the ticket's limits, in the box under `ticket/` | Never |
| **left_out** | Over a limit, or not fetched (a tracker whose `ticketFiles` leaves it out): named in the prompt and the thread with why | Never |
| **failed** | Its download failed: named with why, and the task starts anyway | A member's Retry fetches it again as a new file, once; this one keeps its record |

**A file's text** is set once, when the file comes in.

| State | Means |
|---|---|
| **none** | Not a document: an image, a text file or any other file has no text to read |
| **ready** | Core read a `.docx`, `.xlsx`, `.pptx` or `.pdf`, and its text sits beside the file |
| **failed** | Core couldn't read the document (encrypted, damaged, too big, no text layer): still attached, marked "no text" with the reason |
| **off** | The install reads no text (`OSTRA_FILE_TEXT_EXTRACTION=false`): the document goes as a file alone |

An image (PNG, JPEG, GIF or WebP) also goes to the model as an image when the session's agent takes images in its prompt and its model sees them (an admin's "Reads images", then the catalog's inputs; unknown counts as no), at most 10 of 10 MiB *(working values)*. Otherwise it's a file only, and the message says why (`imagesNotSent`: the model, or the agent).

One **read of a ticket** for its task is a round: 1 at the start, one more for each reopen, "Send ticket updates" or Retry. It records digests and IDs (the description's SHA-256, each comment's ID and edit time, each file's source key), never the ticket's text, so the next read passes on only what changed. Every round has its `ticket.context_read` for the thread: what the agent got; nothing, when nothing changed ("Nothing new on the ticket since the agent read it"); or `unreadable`, when the tracker didn't answer after the read's tries or the ticket is gone, and a reopen then goes on without the ticket's changes. A tracker whose `ticketFiles` is `none` marks its rounds `filesNotFetched`. A task started before milestone 9 has no round 1: its first read after is a baseline, which passes nothing on.

## Events and their two numbers

Every event carries two numbers (ADR 0011, ADR 0035):

- **The session number.** The sidecar, or the runner on `host`, numbers events per session as it spools them. A replayed event has a number the server already holds, so saving is idempotent.
- **The task number.** The server numbers events per task as it saves them. It's the cursor a browser resumes from after a reload or a dropped connection.

Text the agent is still writing isn't an event. It reaches browsers at most every 250 ms, is never saved, and nothing acts on it (Q23).

## Rules that always hold

- **One organization.** Every record belongs to one organization, and records inside a project also carry the project. No query crosses organizations. A restricted project's records are visible only to its members and the organization's admins (ADR 0026, F-003, F-049).
- **One ticket, one active code task per project.** A ticket with sub-issues still becomes one task per sub-issue (F-077). Variants, later, are the one exception (Q14).
- **One driver.** At most one member drives a task at a time. Taking over is a recorded event (F-024, F-073).
- **One active session per task**, as above.
- **The branches are the task's.** The git proxy enforces it: only the task's sessions can push to them, and a refine or review task can't push at all (Q26, Q66, F-090).
- **A box serves one task** and is never reused for another (Q38).
- **No credential in the agent's container.** Model keys and GitHub tokens stay in the sidecar. The agent holds a fake key valid for one task (Q17, Q26, ADR 0030, F-089).
- **A project's keys are its own.** A task gets the token of a model provider only when its project's provider list holds it and its session recorded it. A task on a profile with a provider uses that provider alone, and only where the project's list allows it; for a profile with none, each model in a project is served by one provider, which only an admin's save moves. A task never moves to another provider on its own (ADR 0065, amended 2026-11-20; F-135).
- **Only linked installations.** ostra mints a GitHub token, lists a repo and keeps a webhook delivery only for an installation an organization admin linked, or the App owner's own (ADR 0065, F-136).
- **Saved before acted on.** Every event, state change and outside call is written down first. A restart picks up from what's written. Partial text is the one thing shown without being saved, and nothing acts on it (ADR 0011, Q23).
- **Rebuildable.** A task can always be rebuilt from its branches, its hidden ref, its session archive and its stored history. That's why boxes can be thrown away (ADR 0006, F-079).
- **Nothing reaches the tracker or memory from an agent without a person.** Drafts and proposals wait for a member (Q67, Q86).
- **Nothing automatic runs without a limit.** Every loop has a cap of rounds, a spend cap and a budget above it (Q72, Q105).
- **The tracker owns the ticket, and the code host owns the PR.** ostra keeps references and caches. Drift is fixed by regular checks (F-044).
- **Branded IDs.** `OrganizationId`, `ProjectId`, `TaskId`, `SessionId`, `RunnerId`, `PoolId`, `BoxId`, `ProviderId`, `NoteId`, `TicketKey` and the rest are distinct types (`AGENTS.md`).

## What changed on 2026-11-18

The eight changes of section 4.5 of the answers, for tracing:

1. **Organization replaces Team** as the owner of every record. Records inside a project also carry the project (Q28, Q30, Q102, ADR 0026).
2. **The environment moves** from the repo to the project. Its secrets, variables and files each name one repo (Q33, Q16, F-050).
3. **A task gains a kind and a source.** "Task repo" replaces the task's single repo, branch and PR. A review task links to the code task it reviews (Q29, Q31, Q64, Q71, ADR 0027, ADR 0028).
4. **A task's lifecycle is a discriminated union per kind,** with code's "in review" sub-states (Q12, Q64, Q72).
5. **A session records how it began** (Q53).
6. **Box, runner, snapshot, approval and proposal** gain lifecycles of their own (Q38, Q39, Q42, Q48, Q86, Q94).
7. **Events get two numbers** (Q23).
8. **Needs-you items gain an audience** (Q73, F-036).

## What changed on 2026-11-19

From the questions milestone 1 raised (`history/answers-2026-11-19.md`), for tracing:

1. **A code task's end follows the set of its PRs,** whatever the order of their events, and a PR reopened on GitHub puts it back in review (Q107).
2. **A runner's drain is an admin's hold that only an admin lifts,** and a revoke is possible from any state and ends the runner's leases at once (Q108, Q131).
3. **A joined runner waits in `joining`** when its pool requires approval, and any live token of the pool lets a runner join (Q130).
4. **The sidecar's token is the task token:** valid as long as the task's lease (Q129).
5. **A queued task says why it waits,** an open offer included (Q132).
6. **Files left outside every repo are a needs-you item** (Q133).

For milestone 5's spec (`specs/m5-the-fleet/spec.md`, the same night):

7. **A join token has a lifecycle,** and a queued task has a place in each of its pools' queues, by ticket priority and then queued time; a cancelled queued task stops with the reason `cancelled` (Q232, Q248).
8. **A box takes a slot and its size's room on a runner,** and a project holds at most its share of a pool's boxes (Q231, Q233, Q236).

For several clients in one organization (ADR 0065, the same night):

9. **A session records its model provider and model row,** resolved at its start: its profile's own provider, which its project's provider list must allow, else (a profile with no provider) the provider the list serves the model's name from. An agent profile names its provider and its model by name (Q271, Q272, Q273, F-135).
10. **A connection has installations,** and only linked ones are used (Q280, F-136).
