# ostra

A self-hostable platform for cloud agents. It turns an organization's tickets and prompts into work for coding agents, on runners that anyone can host, and ships the result as pull requests. These terms are the ones used in code, docs and the interface.

## Language

### Work

**Project**:
A product an organization works on in ostra: its repos, boards, environment, automations, memory and tasks.
_Avoid_: "project" alone when you mean a tracker's own project (write "Linear project" or "Jira project")

**Ticket**:
A unit of work in an organization's tracker (a Linear issue, a Jira issue). ostra reads and updates it but never owns it. A task can start without one.
_Avoid_: issue (when meaning ostra's own work), card, story

**Task**:
ostra's long-lived unit of work in one project. It has a kind, and it starts from a ticket or from a prompt. It can change any of the project's repos, on one branch name (a repo that merged and was reopened moves to its own fresh `-2` branch), and opens one PR for each repo it changes. Each one is a task repo. A task can be reopened any number of times.
_Avoid_: job, run, assignment

**Task repo**:
The record of one repo a task changed: the repo, its branch and its PR. A task has one for each repo it changed, and none for a repo it left alone.
_Avoid_: "repo" alone (that's the project's linked repository), PR record

**Task kind**:
What a task is for, which fixes how it ends: refine (ends in a ready ticket), code (ends in one or more PRs) or review (ends in a PR review).
_Avoid_: type, mode

**Draft**:
What a refine task hands in: the proposed ticket text, acceptance criteria, questions and sub-tickets, waiting for a member. Nothing reaches the tracker until a member sends it.
_Avoid_: proposal (that's memory), plan (that belongs to a code task)

**Session**:
One conversation with an agent within a task. A task can hold several, for example after reopening it or switching agent.
_Avoid_: chat, thread, run

**Turn**:
One prompt and the agent's full response to it within a session.
_Avoid_: message, step, round

**Event**:
One thing the agent or ostra did in a session: a message, a tool call, a file change, a question or a state change. It is saved before ostra acts on it, and it carries two numbers: one per session, which makes saving it idempotent, and one per task, which a browser resumes from. Text the agent is still writing is not an event.
_Avoid_: log entry, activity, message (a message is one kind of event)

**Board**:
The part of a tracker that is attached to a project: a Linear team or Linear project, or a Jira project or board. Each board belongs to one project.
_Avoid_: source, workspace

**Status mapping**:
A board's choice of which tracker statuses count as open, and which ones ostra moves a ticket to when its task starts, when its first PR opens and when it merges. Drafted from the tracker's own status types, and changed by a project admin.
_Avoid_: workflow, state map

**Inbox**:
A project's list of the open tickets on its boards, from ostra's cached copy, where a member turns a ticket into a task.
_Avoid_: backlog, queue (the queue holds tasks waiting for a runner), triage

**Ticket template**:
The text a ticket task's first prompt is rendered from: the ticket's title, description, comments, labels, images, parent and linked tickets, and the agent profile's instructions, each piece of the ticket's own text in a marked block. A project has the built-in one until an admin edits it. It holds placeholders and sections, and no code.
_Avoid_: prompt template (the rebuild template is another thing), context

**Ticket write**:
One change ostra makes on a ticket (a status move, the progress comment or its edit, a PR or task link, a new ticket), saved in the same transaction as the task change that caused it and applied later with a key fixed by the task and the step, so a replay never makes a second one.
_Avoid_: sync job, update

**Automation**:
A project's rule that starts tasks by itself: an intake rule, which acts on matching tickets, or a schedule, which acts at set times.
_Avoid_: workflow, trigger

**Occurrence**:
One due time of an automation's schedule. Each occurrence is a row with a unique key on the automation and the time, saved in the same transaction as the job that starts its tasks, so it starts them once. One job a minute, the scheduler tick, finds the occurrences that are due.
_Avoid_: tick (the tick is the job that finds occurrences), run, fire

**Intake rule**:
An automation that turns the tickets matching a condition into tasks, with the agent profile that rule names. It starts one task per ticket, once, when the ticket starts to match after the rule exists.
_Avoid_: trigger, workflow

**Dry run**:
An intake rule's list of the tickets it matches right now, with what starting each would do. Its "Start all" is how a rule's existing matches start.
_Avoid_: preview, test run
_Not_: plan first, which is a code task's first turn

**Parent ticket**:
A ticket with sub-issues. A code start on it starts one task per open sub-issue at the bottom of its tree, and the parent itself never runs code; its page follows its children.
_Avoid_: epic (that's one tracker's word), umbrella

### Acting on a task

**Needs you**:
A task waiting on a person: a question, an approval, a plan to approve, a finished draft, a session that ended without changes, files an agent left outside every repo, or a PR ready for review. Each item is for the driver, a reviewer or the members of the project. Amber in the panel, and the first thing on the home screen.
_Avoid_: blocked, pending, waiting, attention

**Approval**:
The agent's request to do something its profile's rules hold back, such as adding a dependency or running a migration. It waits as a needs-you item, and any member of the project may answer it once, for this task, or deny it.
_Avoid_: permission, confirmation
_Not_: a reviewer's approval of a PR, which is given on the code host

**Approval rule**:
A line in an agent profile that says what needs a person: a tool (edit, run a command, fetch, an MCP tool) and what it matches, such as a path glob or the commands outside an allowlist. Its effect is always to ask. It keeps a person in the loop and doesn't contain the agent: the box does that (ADR 0049).
_Avoid_: policy, permission (the agent's own settings are its permissions, which ostra writes from the rules)

**Task rule**:
What "Approve for this task" adds: an approval rule on one task, with a narrow pattern (the exact path, a command's program and first argument), that answers later matching requests without a person.
_Avoid_: exception, allowlist

**Marked block**:
How a prompt carries text that isn't ostra's (a member's reason or plan, a PR comment, a ticket, the agent's own output): fenced as data between an opening and a closing line whose number the text can't hold, so the text can't end its block early or pose as ostra's instructions (`@ostra/protocol`, `markedBlock`).
_Avoid_: quote, escaping

**Plan first**:
An agent profile's switch: the task's first turn only proposes a plan, reading and never writing, and the driver approves or edits it before the work starts.
_Avoid_: plan mode (that's how the agent is made read-only for that turn), dry run

**Notification**:
A needs-you moment delivered to one member on one channel: the panel's "Needs you" page, a comment on the task's ticket, or an email. Each member chooses which moments reach them on which channel.
_Avoid_: alert, inbox (the Inbox is a project's tickets), message (members send messages to the agent)

**Delivery**:
One channel's sending of one notification: the panel's row, the ticket's comment or the mail, each sent once by its idempotency key, retried on its own, and shown on the notification when it fails.
_Avoid_: send, job

**Check run**:
One check's run after one turn of a session: its status, exit code, time and full output. A PR reads the latest run of each check that applies to its repo.
_Avoid_: CI run, build (those are the code host's)

**Dispatch**:
Choosing where a task runs, on a runner in one of its project's pools or on its member's personal runner, and starting its box and its session. A dispatch reaches the runner as an offer, and the task stays queued until the runner accepts it.
_Avoid_: schedule (a schedule is a kind of automation), assign (assigning is something done in the tracker)

**Driver**:
The one member who steers a task right now. Any member who can open the project can take over as driver, so two people never prompt the same agent at once. The independent-review check (F-104) means something wider by "someone who didn't drive the task": it excludes every member credited with a co-author trailer on the task.
_Avoid_: owner (the project owns every task), assignee (assigning is something done in the tracker)

**Steer**:
Sending a running session a message that changes what the agent does next. Send queues the message until the turn ends, unless the agent can take a message mid-turn. Interrupt and send cancels the turn and sends the message as the next prompt.
_Avoid_: intervene, nudge, interrupt (interrupting is only one way to steer)

**Reopen**:
Continuing a task after it has stopped, with a new turn or session on the same branches and PRs. It usually lands on a fresh box.
_Avoid_: restart, retry, rerun (each suggests starting over)

**Outside task**:
A task started by someone in the tracker whom ostra can't match to a member who can open the project. It waits in "Needs approval" until a member of the project approves it, and runs on the project's default profile, on a pool.
_Avoid_: external task, guest task
_Not_: a task an automation started, which a project admin's rule stands behind

### Review

**Finding**:
One point an AI review raises about a PR, with a file and a line: blocking, or a nit.
_Avoid_: comment (people write those), issue

**Reviewer**:
A member asked to review a task's PR, taken from the PR's requested reviewers or CODEOWNERS.
_Avoid_: approver
_Not_: an agent's review, which is a review task

**Diff comment**:
A member's comment on a line of a task's diff in the panel. It stays a draft until its member sends their drafts to the agent together, as one prompt, and it shows as outdated when a later turn changes its line.
_Avoid_: review comment (those are written on the code host), finding (an AI review writes those)

**Round**:
One time a code task goes back to its coding agent because of its PRs: a CI round (failing checks and their logs), a findings round (an AI review's blocking findings) or a "changes requested" round (a member's GitHub review). CI and findings rounds are capped at 2 each.
_Avoid_: iteration, retry, loop (the loop is all the rounds together)

**Automatic turn**:
A turn of the coding agent that no person asked for: a CI round's or a findings round's. A task gets at most 4, counted since a person last acted on it, before a person has to act. A question the agent asks in one gets a fixed neutral reply.
_Avoid_: auto-fix, background turn

### Execution

**Runner**:
The ostra program (`ostra runner`) on one machine. It gives each task a place to run through its executor. A pool runner joins a runner pool. A personal runner belongs to one member.
_Avoid_: worker, host, node, local runner, remote runner

**Runner pool**:
A named set of runners in an organization that projects send tasks to.
_Avoid_: cluster, queue

**Personal runner**:
A runner on a member's own machine that runs only that member's tasks.
_Avoid_: local runner

**Runner key**:
The credential a runner holds: an Ed25519 key pair whose private half never leaves its machine. A pool runner gets it by trading its join token, and a personal runner by trading its device-code session, which the server then revokes. It lets a runner connect and receive its dispatches, and does nothing a member can.
_Avoid_: runner token, API key

**Join token**:
The key a runner uses to join a pool. It is shown once, stored hashed and set to expire.
_Avoid_: API key, registration code

**Drain**:
An admin's hold on a runner: it takes no new tasks and finishes the ones it has, until an admin resumes it. A disconnect or a restart doesn't lift it.
_Avoid_: pause, cordon, disable
_Not_: a runner shutting down by itself, which needs no admin and ends when it reconnects

**Revoke**:
Ending a credential for good: a runner's identity, a join token or a CLI session. A revoked runner is disconnected at once, its tasks stop and can be reopened on another runner, and it can't connect again.
_Avoid_: delete, remove, ban

**Executor**:
How a runner gives a task its place to run: `docker` (a box of containers), `kubernetes` (a box as a pod) or `host` (a worktree on the machine, no box, so no services and no box sizes).
_Avoid_: "host" alone (the code host is something else), runner provider

**Box**:
A task's own isolated computer: the agent's container, the sidecar and the environment's services. It serves one task and can be thrown away at any time.
_Avoid_: sandbox, VM, container (a box has several)

**Sidecar**:
The ostra container in a box that holds the task's credentials, proxies its model calls and its git, and drives the agent. On the `host` executor, the runner process does its work.
_Avoid_: proxy (it does more), agent

**Task token**:
The credential a box's sidecar holds: a token for one task, valid exactly as long as that task's lease. The sidecar connects with it and fetches the task's credentials with it, and it does nothing for any other task. The runner hands it over when it makes the box.
_Avoid_: sidecar token, session token, access token (that's the runner's own, good for ten minutes)

**Key proxy**:
The part of the sidecar that swaps the agent's fake key for the real one and counts usage.
_Avoid_: gateway

**Git proxy**:
The part of the sidecar that the agent's own `git` fetches and pushes through. It adds the credential and accepts only the task's refs.
_Avoid_: gateway

**Lease**:
The server's grant that lets one box work on a task. Each dispatch raises its epoch, and writes from an older epoch are refused.
_Avoid_: lock

**Process containment**:
How an executor ends every process of a task together: the box's container, a Windows job object, a Linux cgroup, or, where the machine gives no such unit, the agent's process tree and a sweep for the task's marker. A runner reports which one it has.
_Avoid_: isolation (only a box isolates), sandboxing (containment ends processes, it doesn't limit what they reach)

**Hidden ref**:
The commit at `refs/ostra/wip/<task>` that a box writes to in each repo after every turn, by a forced push. It sits outside the task's branches and holds the working tree as `git add -A` reads it, so unfinished work from a cut-short turn survives without landing on a branch. Ignored files aren't in it. A fresh box restores it.
_Avoid_: backup branch, stash, wip branch

**Session archive**:
The agent's own export of a session, uploaded to the server after every turn and kept in the blob store. A fresh box imports it so the agent can carry on the session. It holds the session's content and never a credential.
_Avoid_: transcript, history (the task's history is ostra's own record), backup

**Rebuild template**:
The fixed text a task's third way of reopening starts a new session from, when the session archive can't be restored or another agent takes the task over: the ticket, the PR's text, every member message, every agent message, an interrupted turn's text in a section of its own, and the branch's log. ostra assembles it as a string and calls no model. It holds no tool output.
_Avoid_: summary (nothing summarizes it), recap

**Restore conflict**:
What happens when a task's saved unfinished work can't be merged with commits pushed to its branch since: nothing is restored, the agent carries on from the branch's head, and the task's driver gets a needs-you item about it. The task doesn't stop for it.
_Avoid_: merge failure, failed restore

**Command**:
A numbered instruction from the server to a runner or a sidecar: dispatch, steer, interrupt, stop, an approval's answer, (from protocol minor 1) release a box, and (from minor 4) resume a drained runner.
_Avoid_: message, job

**Carrier**:
How a runner's session travels: a WebSocket, or HTTP requests when a proxy blocks WebSockets. A runner falls back to HTTP by itself and tries the WebSocket again later; the session is the same on both.
_Avoid_: transport mode, protocol (the protocol is what both carry)

**Box size**:
One of an organization's three named sizes (small, medium, large), each a CPU and memory limit for a box's agent container. A project picks its default. The `host` executor counts slots instead.
_Avoid_: instance type, tier, flavour

**Slot**:
Room for one box on a runner. Every runner reports how many it has free; `docker` and `kubernetes` runners also report CPU and memory, which a box's size must fit.
_Avoid_: seat, worker, concurrency

**Share**:
How many boxes of one pool one project may hold at once, set by an admin. A project at its share waits while others' tasks start.
_Avoid_: quota (Kubernetes uses that word for something else), limit (a box size is a limit)

**Pool queue**:
The queued tasks a pool could run, in the order it starts them: ticket priority, then the time each was queued. A task allowed on several pools is in each of their queues and starts in whichever has room first.
_Avoid_: backlog, the queue (ostra's background jobs are a queue too)

**Runner label**:
A word a runner carries, such as `tier:fast`, that a profile can require of the runners its tasks go to. ostra adds `executor:`, `os:` and `arch:` labels itself.
_Avoid_: tag, selector

**Registry**:
The organization's own container registry, where runners push environment snapshots and boxes pull them. A `kubernetes` pool needs one.
_Avoid_: image store, repository (a registry holds repositories)

### The environment

**Workspace**:
The checkouts of a project's repos inside a task's box, on the task's branches. A file in it outside every checkout belongs to no branch.
_Avoid_: sandbox, checkout, worktree (a worktree is how the `host` executor makes a workspace)
_Not_: a Linear workspace, which is an account in Linear

**Environment**:
A project's recipe for every box: a base image, a setup script, services, checks, and variables, secrets and files such as `.env` that each belong to one repo. The panel may call it "the computer every task starts from".
_Avoid_: machine (that's a runner), sandbox, container (a box has several), image (the image is its snapshot)

**Snapshot**:
An environment prepared ahead of time, so a box starts in seconds: an image with the repos checked out and the dependencies installed, never a secret.
_Avoid_: cache, template

**Service**:
A program the environment starts beside the agent for its tests, such as a database. The `host` executor can't start one.
_Avoid_: dependency

**Check**:
A command the environment names that ostra runs after every turn with changes, before it pushes and opens or updates a PR. A failing one makes the PR a draft. The code host's own pipeline is "CI".
_Avoid_: test, CI (for ostra's checks)

**Environment proposal**:
The corrected environment an onboarding task hands in after running the setup, the services and the checks: scripts, checks and variable names per repo, never a secret's value. A project admin accepts, edits or rejects it.
_Avoid_: suggestion, draft (a refine task hands in drafts), proposal (alone, that's memory)

### Agents and models

**Agent**:
A coding harness that ostra drives, such as OpenCode, Claude Code or Codex.
_Avoid_: bot, model, AI, assistant

**Agent profile**:
A named setup of an agent (a model by its model name, instructions, tools, how much it may do without asking) that automations and members choose from. It belongs to the organization, and a project picks a default for each task kind.
_Avoid_: preset, config, persona

**Model provider**:
An endpoint an organization adds for models: an API base URL and a token. ostra lists the models from the endpoint itself, except a model's batch listing (`x:batch` beside `x`, the endpoint's asynchronous batch API), which it keeps unlisted. Each one is one key: an organization may hold several that serve the same models, one per client, and a project uses only those on its provider list.
_Avoid_: vendor, LLM, key (alone, when you mean the provider: the key is its token)

**Model name**:
A model as ostra knows it apart from who serves it: its models.dev catalog ID, or, for a model the catalog lacks, the ID its endpoint lists it under. An agent profile names its model this way, and each project serves it from one provider on its list.
_Avoid_: model ID (that's one provider's listing of the model), model (alone, when you mean the name)

**Reasoning effort**:
How much a model reasons before it answers, as one of the levels its model has: models.dev's effort values (`none` to `max`), `on` for a model that can only switch reasoning on, or Default, which sends nothing and leaves the endpoint's own. An agent profile sets it for its model; a task starts with its profile's level, its driver changes it for the next turn, and each turn records the level it ran at. A level the model doesn't have is clamped to its nearest, never refused.
_Avoid_: thinking level, reasoning mode, variant (that's OpenCode's name for how it sends a level)

**Provider list**:
The model providers a project may use: the organization's default list, which a project follows until it has its own, or the project's own. Only an organization admin edits it. In each project, each model is served by exactly one provider on the list, and a task gets credentials for no provider outside it.
_Avoid_: allowlist, key ring, fallback (no task ever moves to another provider on its own)

**Agent image**:
An image a runner builds itself from the base image, adding an agent the published base image doesn't carry (Claude Code, until its terms allow ostra to ship it), pinned and checked. Built once per base image and agent version, kept by the runner or in the organization's registry, never published. Not in v1: v1's one agent, OpenCode, is in the base image, and agent images come with Claude Code (F-018) after v1 (2026-11-19).
_Avoid_: custom image (that's an environment's own image), snapshot (that's a project's, built on top)

**Launch gate**:
A condition that must hold, with its evidence in the repo, before v1 is published: the ledger, the agent's suite (OpenCode's, since Claude Code moved after v1 on 2026-11-19), the 30-minute measure, the load test, the security review, the maintainer's legal items and names, and the maintainer's go (ADR 0064).
_Avoid_: release criteria, checklist

### Memory and budgets

**Memory note**:
One fact an organization or project wants every task to know.
_Avoid_: rule, knowledge

**Proposal**:
A memory note suggested by an agent or a review, waiting for a member to approve it.
_Avoid_: draft (that's refine)

**Memory index**:
What an agent receives about memory at a session's start: each note's title and one line, within a size limit, beside the notes marked "always" in full. The agent searches and reads the rest through ostra's memory tools. A note's place in the index isn't a use: a note's last use is the last time a session read it, through a read or a search result it then read, and the index lists the most recently read notes first.
_Avoid_: memory dump, context file

**Budget**:
A monthly spend limit for an organization or a project. At 100%, no new task or turn starts until an admin raises it or the month turns; a turn the budget stops waiting is "held".
_Avoid_: quota, credits

**Insights**:
The figures an organization or project sees about its work over a period: PRs opened and merged, the merge rate, the median time to a first PR, the time waiting on people, tokens and spend. Computed every few minutes, not live.
_Avoid_: analytics, metrics, dashboard

### Who

**Organization**:
The people and settings that share one space in an ostra install: its members, projects, runner pools and model providers. Every record belongs to one. In v1 an install runs one organization, the one it starts with, and a team's clients are projects inside it; the data model holds several, and installs with several come after v1 (F-134).
_Avoid_: team (a Linear team is something else), tenant, workspace

**Member**:
A person who belongs to an organization (to several, after v1: F-134). A restricted project lists the members who can open it.
_Avoid_: user, seat

**Admin**:
A member who manages an organization or a project. An organization admin manages its integrations, runner pools, model providers and which projects may use each, and members. A project admin manages one project's repos, environment and access. The first account of an install is seeded by the server when it starts with no account, and is also its instance admin and the admin of its one organization.
_Avoid_: owner, operator

**Instance admin**:
The account that manages the install itself: its email, its storage, its accounts' reset links and who else is an instance admin (creating more organizations comes after v1, F-134). Separate from any organization's admin: it sees nothing inside an organization it isn't a member of.
_Avoid_: superuser, root, owner

**Invitation**:
An organization admin's offer of membership to one address, with a role and, optionally, restricted projects. Its link is its secret: it works once and expires. With email set up, the invitee's address is also verified.
_Avoid_: invite code, sign-up token

**Reset link**:
A one-time link that lets an account choose a new password. With email set up, a member asks for one by mail; without it, only the instance admin creates one. Using it signs out the account's other sessions.
_Avoid_: recovery code, password token

**Audit log**:
The organization's record of who did what and when: people's and the system's actions, each credential issued, every admin change. What an agent ran and read is in the task's event log, which the audit log links to.
_Avoid_: activity log, history (a task's history is its event log)

**CLI session**:
What `ostra login` makes: a member's own credential for the `ostra` CLI, made by a device code the member approves in the browser, listed and revocable in their Account. It can read a task's branches for `ostra checkout`, and nothing else.
_Avoid_: CLI token, API key, runner key (a runner's credential is a different one)

### Integrations

**Tracker**:
The tool where an organization keeps its tickets: Linear, later Jira.
_Avoid_: PM tool, project management tool, issue tracker

**Code host**:
The service where an organization's repos live and pull requests are reviewed: GitHub, later others.
_Avoid_: VCS, forge, git provider

**Installation**:
A GitHub account's install of an App, which grants the App the repos that account chose. ostra works only through a linked installation: one on the App owner's own account, which is linked when ostra sees it, or one an organization admin linked. A client's GitHub organization installs the organization's App, or has its own App connected beside it.
_Avoid_: integration, connection (that's ostra's record of the App itself)

**Adapter**:
ostra's connection to one specific tracker, code host, agent, model provider, executor, notification channel, secret store or blob store, behind the interface all of its kind share.
_Avoid_: plugin, connector, driver

**Agent session**:
Linear's own view of a ticket handed to ostra: a live thread on the ticket where ostra posts, in its own words, that it received the task, is working, opened a PR, needs someone, or finished, and where people in Linear send a follow-up or a stop.
_Avoid_: session (alone, that's the agent's conversation in ostra), agent mode (that's the connection's switch)

**Heartbeat**:
A small post to a Linear agent session during a long silent turn, so Linear doesn't mark the session stale. ostra sends one after 20 minutes without a post to that session. It is an ephemeral thought, and a plain thought if Linear doesn't count an ephemeral one as activity.
_Avoid_: ping, keepalive (a keepalive is the browser stream's own message, ADR 0035)

**Capability**:
Something an adapter may or may not support, which it declares, for example Linear's native agent sessions, an agent taking a message mid-turn, a code host's list of LFS hosts, or an executor that starts services.
_Avoid_: feature (that word belongs to the ledger), flag
