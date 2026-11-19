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
ostra's long-lived unit of work in one project. It has a kind, and it starts from a ticket or from a prompt. It can change any of the project's repos, on one branch name, and opens one PR for each repo it changes. Each one is a task repo. A task can be reopened any number of times.
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

**Automation**:
A project's rule that starts tasks by itself: an intake rule, which acts on matching tickets, or a schedule, which acts at set times.
_Avoid_: workflow, trigger

**Occurrence**:
One due time of an automation's schedule. Each occurrence is a row with a unique key on the automation and the time, saved in the same transaction as the job that starts its tasks, so it starts them once. One job a minute, the scheduler tick, finds the occurrences that are due.
_Avoid_: tick (the tick is the job that finds occurrences), run, fire

**Intake rule**:
An automation that turns the tickets matching a condition into tasks, with the agent profile that rule names.
_Avoid_: trigger, workflow

### Acting on a task

**Needs you**:
A task waiting on a person: a question, an approval, a plan to approve, a finished draft, a session that ended without changes, or a PR ready for review. Each item is for the driver, a reviewer or the members of the project. Amber in the panel, and the first thing on the home screen.
_Avoid_: blocked, pending, waiting, attention

**Approval**:
The agent's request to do something its profile's rules hold back, such as adding a dependency or running a migration. It waits as a needs-you item, and any member of the project may answer it once, for this task, or deny it.
_Avoid_: permission, confirmation
_Not_: a reviewer's approval of a PR, which is given on the code host

**Dispatch**:
Choosing where a task runs, on a runner in one of its project's pools or on its member's personal runner, and starting its box and its session.
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

### Review

**Finding**:
One point an AI review raises about a PR, with a file and a line: blocking, or a nit.
_Avoid_: comment (people write those), issue

**Reviewer**:
A member asked to review a task's PR, taken from the PR's requested reviewers or CODEOWNERS.
_Avoid_: approver
_Not_: an agent's review, which is a review task

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

**Executor**:
How a runner gives a task its place to run: `docker` (a box of containers), `kubernetes` (a box as a pod) or `host` (a worktree on the machine, no box, so no services and no box sizes).
_Avoid_: "host" alone (the code host is something else), runner provider

**Box**:
A task's own isolated computer: the agent's container, the sidecar and the environment's services. It serves one task and can be thrown away at any time.
_Avoid_: sandbox, VM, container (a box has several)

**Sidecar**:
The ostra container in a box that holds the task's credentials, proxies its model calls and its git, and drives the agent. On the `host` executor, the runner process does its work.
_Avoid_: proxy (it does more), agent

**Key proxy**:
The part of the sidecar that swaps the agent's fake key for the real one and counts usage.
_Avoid_: gateway

**Git proxy**:
The part of the sidecar that the agent's own `git` fetches and pushes through. It adds the credential and accepts only the task's refs.
_Avoid_: gateway

**Lease**:
The server's grant that lets one box work on a task. Each dispatch raises its epoch, and writes from an older epoch are refused.
_Avoid_: lock

**Hidden ref**:
The commit at `refs/ostra/wip/<task>` that a box writes to in each repo after every turn, by a forced push. It sits outside the task's branches and holds the working tree as `git add -A` reads it, so unfinished work from a cut-short turn survives without landing on a branch. Ignored files aren't in it. A fresh box restores it.
_Avoid_: backup branch, stash, wip branch

**Session archive**:
The agent's own export of a session, uploaded to the server after every turn and kept in the blob store. A fresh box imports it so the agent can carry on the session. It holds the session's content and never a credential.
_Avoid_: transcript, history (the task's history is ostra's own record), backup

**Rebuild template**:
The fixed text a task's third way of reopening starts a new session from, when the session archive can't be restored or another agent takes the task over: the ticket, the PR's text, every member message, every agent message, an interrupted turn's text in a section of its own, and the branch's log. ostra assembles it as a string and calls no model. It holds no tool output.
_Avoid_: summary (nothing summarizes it), recap

**Command**:
A numbered instruction from the server to a runner or a sidecar: dispatch, steer, interrupt, stop, an approval's answer.
_Avoid_: message, job

### The environment

**Workspace**:
The checkouts of a project's repos inside a task's box, on the task's branches.
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
A command the environment names that ostra runs before it opens a PR. The code host's own pipeline is "CI".
_Avoid_: test, CI (for ostra's checks)

### Agents and models

**Agent**:
A coding harness that ostra drives, such as OpenCode, Claude Code or Codex.
_Avoid_: bot, model, AI, assistant

**Agent profile**:
A named setup of an agent (model, instructions, tools, how much it may do without asking) that automations and members choose from. It belongs to the organization, and a project picks a default for each task kind.
_Avoid_: preset, config, persona

**Model provider**:
An endpoint an organization adds for models: an API base URL and a token. ostra lists the models from the endpoint itself.
_Avoid_: vendor, LLM

### Memory and budgets

**Memory note**:
One fact an organization or project wants every task to know.
_Avoid_: rule, knowledge

**Proposal**:
A memory note suggested by an agent or a review, waiting for a member to approve it.
_Avoid_: draft (that's refine)

**Budget**:
A monthly spend limit for an organization or a project.
_Avoid_: quota, credits

### Who

**Organization**:
The people and settings that share one space in an ostra install: its members, projects, runner pools and model providers. An install holds one or more, and every record belongs to one.
_Avoid_: team (a Linear team is something else), tenant, workspace

**Member**:
A person who belongs to an organization, and may belong to several. A restricted project lists the members who can open it.
_Avoid_: user, seat

**Setup token**:
A one-time secret that the server prints in its log at first start. Creating the first account needs it, so a fresh install belongs to whoever can read the log. It stops working once that account exists.
_Avoid_: install key, license key

**Admin**:
A member who manages an organization or a project. An organization admin manages its integrations, runner pools, model providers and members. A project admin manages one project's repos, environment and access. The first account of an install is also its instance admin, who can create more organizations.
_Avoid_: owner, operator

### Integrations

**Tracker**:
The tool where an organization keeps its tickets: Linear, later Jira.
_Avoid_: PM tool, project management tool, issue tracker

**Code host**:
The service where an organization's repos live and pull requests are reviewed: GitHub, later others.
_Avoid_: VCS, forge, git provider

**Adapter**:
ostra's connection to one specific tracker, code host, agent, model provider, executor, notification channel, secret store or blob store, behind the interface all of its kind share.
_Avoid_: plugin, connector, driver

**Heartbeat**:
A small post to a Linear agent session during a long silent turn, so Linear doesn't mark the session stale. ostra sends one after 20 minutes without a post to that session. It is an ephemeral thought, and a plain thought if Linear doesn't count an ephemeral one as activity.
_Avoid_: ping, keepalive (a keepalive is the browser stream's own message, ADR 0035)

**Capability**:
Something an adapter may or may not support, which it declares, for example Linear's native agent sessions, an agent taking a message mid-turn, a code host's list of LFS hosts, or an executor that starts services.
_Avoid_: feature (that word belongs to the ledger), flag
