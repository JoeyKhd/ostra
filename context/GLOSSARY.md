# ostra

A self-hostable control panel that turns a team's tickets into work for coding agents and ships the result as pull requests. These terms are the ones used in code, docs and the interface.

## Language

### Work

**Ticket**:
A unit of work in a team's tracker (a Linear issue, a Jira issue). ostra reads and updates it but never owns it.
_Avoid_: issue (when meaning ostra's own work), card, story

**Task**:
ostra's long-lived unit of work for one ticket in one repo, with its branch, workspace, sessions and eventually its PR. A task can be reopened any number of times.
_Avoid_: job, run, assignment

**Session**:
One conversation with an agent within a task. A task can hold several, for example after reopening it or switching agent.
_Avoid_: chat, thread, run

**Turn**:
One prompt and the agent's full response to it within a session.
_Avoid_: message, step, round

**Board**:
The part of a tracker an admin attaches to ostra: a Linear team or project, or a Jira project or board. Each board links to one or more repos.
_Avoid_: project (Linear and Jira each mean something else by it), source, workspace

**Intake rule**:
A team's configured condition under which a ticket becomes a task, and with which repo, agent profile and runner.
_Avoid_: trigger, automation, workflow

### Acting on a task

**Needs you**:
A task waiting on a person: a question, an approval, a plan to approve, a session that ended without changes, or a PR ready for review. Amber in the panel, and the first thing on the home screen.
_Avoid_: blocked, pending, waiting, attention

**Dispatch**:
Choosing a task's runner and agent profile and starting its first session.
_Avoid_: schedule, assign (assigning is something done in the tracker)

**Driver**:
The one member who steers a task right now. Any member can take over as driver, so two people never prompt the same agent at once.
_Avoid_: owner (the team owns every task), assignee (assigning is something done in the tracker)

**Steer**:
Sending a running session a message that changes what the agent does next.
_Avoid_: intervene, nudge, interrupt (interrupting is only one way to steer)

**Reopen**:
Continuing a task after it has stopped, with a new turn or session on the same branch and PR.
_Avoid_: restart, retry, rerun (each suggests starting over)

### Execution

**Runner**:
A machine running ostra's runner, which executes agents for tasks. It is a local runner on a member's own machine and a remote runner when it's shared by the team.
_Avoid_: worker, executor, host, node

**Workspace**:
The isolated checkout of a task's branch on a runner, where its agent works.
_Avoid_: sandbox, worktree, checkout
_Not_: a Linear workspace, which is a team's account in Linear

**Environment**:
A repo's recipe for preparing every workspace: a setup script, variables and secrets, and files such as `.env`.
_Avoid_: computer, machine (those are runners), sandbox, container, image

**Agent**:
A coding harness that ostra drives, such as Claude Code, OpenCode or oh-my-pi.
_Avoid_: bot, model, AI, assistant

**Agent profile**:
A named setup of an agent (model, instructions, tools, how much it may do without asking) that intake rules and members choose from.
_Avoid_: preset, config, persona

### Who

**Team**:
The people who share one ostra install's tasks, integrations and runners.
_Avoid_: org, organization, workspace, tenant

**Member**:
A person with an account on a team's ostra.
_Avoid_: user, seat

**Admin**:
A member who manages the team's integrations, runners, intake rules and members.
_Avoid_: owner, operator

### Integrations

**Tracker**:
The tool where a team keeps its tickets: Linear, later Jira.
_Avoid_: PM tool, project management tool, issue tracker

**Code host**:
The service where a team's repos live and pull requests are reviewed: GitHub, later others.
_Avoid_: VCS, forge, git provider

**Adapter**:
ostra's connection to one specific tracker, agent or code host, behind the interface all of its kind share.
_Avoid_: plugin, connector, driver

**Capability**:
Something an adapter may or may not support, which it declares, for example Linear's native agent sessions.
_Avoid_: feature (that word belongs to the ledger), flag
