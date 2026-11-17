# Feature ledger

Every feature we've decided on, with a checkable "done when". It is the source of truth for what to build and what is finished.

- **Priority:** `v1` (in the first release), `later`, `won't`.
- **Status:** `planned` → `building` → `done`, or `dropped`.
- **Rules:**
  - IDs are permanent: never renumber or reuse one. New features get the next free ID.
  - Change a status in the same commit as the work. Set `done` only when every condition in "done when" holds.
  - Specs in `context/specs/` name the feature IDs they cover.
  - A row that waits on an open question names it (`Q-nn` in `open-questions.md`). Its priority isn't final until that question is settled.
  - *(working value)* marks a number we expect to tune; changing it doesn't need a new ID.
  - The plan was signed off on 2026-11-17. A change to a v1 row's "done when" from then on is agreed with the maintainer and noted in the row.
- Terms follow `context/GLOSSARY.md`.

## Install and accounts

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-001 | One-command install | `docker compose up` with only the required settings brings up a working server with a built-in runner. The first person to sign up on a fresh install becomes its admin. | v1 | planned |
| F-076 | Setup in the panel | After `docker compose up`, everything else happens in the panel: a first-run checklist covering the admin account, the GitHub App, Linear, boards and repos, an environment, a runner and the first task. A new team gets from `docker compose up` to its first agent-made PR in under 30 minutes *(working value)*. | v1 | planned |
| F-002 | Team accounts | Members sign up and sign in with email and password or with GitHub (better-auth, ADR 0003). An admin invites people by email link and removes them. | v1 | planned |
| F-003 | Roles | Admins manage integrations, boards, runners, intake rules, agent profiles and members. Members pick tickets, drive and reopen, and see every task of their team, conversations included. There are no private tasks in v1. | v1 | planned |
| F-004 | Enterprise sign-in | An admin connects the team's identity provider (OIDC or SAML), and members sign in through it. | later | planned |
| F-049 | Several teams | An install holds more than one team. A member of one team never sees another team's tasks, boards, runners, profiles or credentials, and a test proves it for every kind of record (ADR 0010). | v1 | planned |

## Connecting the stack

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-005 | Connect Linear | An admin connects a Linear workspace from the panel, step by step, through a Linear app the team registers itself from a pre-filled link (ADR 0001, ADR 0013). | v1 | planned |
| F-006 | Connect GitHub | An admin creates the team's own GitHub App from the panel in one flow and installs it on the repos ostra may work in. | v1 | planned |
| F-007 | Boards and repos | An admin attaches boards and links each to one or more repos. A task is one ticket in one repo, and a ticket that needs two repos becomes two linked tasks. When a board links several repos, the member picks one when starting the task, and an intake rule names its own. | v1 | planned |
| F-042 | Private installs | An install that Linear can't reach still picks up every ticket change by checking Linear, within 60 seconds *(working value)*, with everything except Linear agent mode. | v1 | planned |
| F-008 | Jira | Everything Linear does in this ledger also works for Jira Cloud, through the same tracker interface (ADR 0013). | later | planned |
| F-009 | More code hosts | GitLab, then others, through the code-host interface. | later | planned |

## Intake

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-010 | Ticket inbox | The panel lists the open tickets of the attached boards, filterable. A member turns one into a task in one action, with the repo, agent profile and runner prefilled from defaults. | v1 | planned |
| F-011 | Intake rules | An admin defines rules (by label, status, assignee, team or project) that turn matching tickets into tasks automatically, each with its repo, agent profile and runner. A dry run shows which current tickets a rule would match. | v1 | planned |
| F-077 | Sub-issues | Each sub-issue of a ticket becomes its own task. The parent isn't run itself, and its page shows its children's progress. | v1 | planned |
| F-064 | Ticket context | The agent receives the ticket's title, description, comments, labels and images, its parent and linked tickets, and the agent profile's instructions. They're put together by a template an admin can edit. | v1 | planned |
| F-012 | Start from Linear | On an install Linear can reach, handing a ticket to ostra inside Linear makes it a task. Its progress shows on the ticket as a Linear agent session, and stopping it or sending a follow-up from Linear works (ADR 0013). | v1 | planned |
| F-040 | Approval for outside tasks | A task started by someone who isn't a member runs on the team's agent profile on a remote runner, and waits in a "needs approval" list until a member approves it. This is on by default, and an admin can switch it off. | v1 | planned |

## Runners and workspaces

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-013 | Runner | The runner installs with one command: `npx ostra-runner` on a laptop, or the runner Docker image on a server (ADR 0023). It signs in to a server from a terminal with a one-time code, connects out (so it works behind NAT), and reconnects on its own. The panel shows each runner as online or offline, with the agents it found (ADR 0012). | v1 | planned |
| F-014 | Local runner | A member runs a runner on their own machine. Tasks dispatched to it run there, on that member's own agent logins (ADR 0014). | v1 | planned |
| F-015 | Remote runner | An admin runs runners on servers or VMs that the whole team can dispatch to. Their agents use the team's API keys, which ostra hands over per task and the runner never saves (ADR 0014). | v1 | planned |
| F-085 | Signed runner downloads | macOS and Windows users download a native runner binary that's notarized or code-signed and opens without a security warning (ADR 0023). | v1 | planned |
| F-039 | Runner image | ostra publishes a Docker image with the runner and every v1 agent installed. A new remote runner is one `docker run` and a sign-in code. | v1 | planned |
| F-016 | Workspace per task | Each task gets its own branch, named from its ticket, and its own workspace on its runner. Two tasks never share a working tree. | v1 | planned |
| F-079 | Cleanup and retention | A workspace is deleted when its PR merges or closes, or after 14 days idle *(working value)*. Session histories are kept as long as their task exists, unless an admin sets a retention period. | v1 | planned |
| F-050 | Environments | An admin defines an environment per repo: a setup script, variables and secrets, and files placed in every workspace (such as `.env`). Every task on that repo starts in a workspace prepared by its environment, on any runner, and the panel shows the setup log. The panel says environments are for dev and test credentials, not production ones (ADR 0020). | v1 | planned |
| F-051 | Environment snapshots | A prepared workspace is cached on each runner, so a new task starts without rerunning the full setup. | later | planned |
| F-052 | Network rules | An environment limits which hosts its agents can reach. | later | planned |
| F-060 | Protected default branch | ostra won't start a task on a repo whose default branch isn't protected, and says why. An admin can override this per repo (ADR 0020). | v1 | planned |
| F-061 | Runner versions | The server accepts runners up to one minor version older than itself, tells older runners to update, and the panel shows each runner's version (ADR 0022). | v1 | planned |
| F-067 | Capacity and queue | Each runner has a capacity for parallel tasks: 2 on a local runner and 4 on a remote one by default *(working values)*. Extra tasks wait in a queue, ordered by ticket priority, which admins can see and cancel from. | v1 | planned |
| F-068 | Runaway protection | Every session stops cleanly after a maximum duration, 2 hours by default *(working value)*, and when it stalls, with no agent event for 10 minutes *(working value)*. The task then goes to "needs you". | v1 | planned |
| F-069 | Choosing a runner | A member's task goes to their own runner when it's online, and otherwise to the team's remote runners. Tasks from intake rules and from Linear go to the remote runners. Runners carry labels (operating system, Docker available) that rules can require. | v1 | planned |
| F-017 | Container per task | On a remote runner, each task's workspace and agent run in their own container. | later | planned |

## Agents

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-018 | Claude Code | Tasks run on Claude Code, with every feature in this ledger that applies to agents. | v1 | planned |
| F-038 | Codex | The same for Codex. | later | planned |
| F-019 | OpenCode | The same for OpenCode. | later | planned |
| F-020 | oh-my-pi | The same for oh-my-pi. | later | planned |
| F-022 | More agents | Copilot CLI, Cursor CLI and the other top-tier coding agents, each as one adapter, in the tiers of ADR 0004. | later | planned |
| F-021 | Agent profiles | An admin defines named agent profiles: an agent, a model, extra instructions, skills, MCP servers, tools, and how much it may do without asking. Intake rules and members choose from them, and every task applies its profile. On permissions and allowed MCP servers, the profile wins over the repo's own files. Its instructions and skills are added beside the repo's own AGENTS.md and skills, never replacing them. Installing and updating the agents themselves isn't part of it: the runner reports what's installed. | v1 | planned |
| F-063 | Plan first | An agent profile can make the agent propose a plan before writing code. The plan shows as "needs you", and the driver approves or edits it before work continues. It's off by default. | v1 | planned |

## Working on a task

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-023 | Live activity | A task's page shows the agent's messages, tool calls and file changes as they happen, and the full history afterwards, the same for every agent. | v1 | planned |
| F-024 | Steer | The task's driver sends a running session a message, and the agent takes it as its next turn. The driver can also interrupt the current turn. Any member can take over as driver in one action, and everyone else watches. | v1 | planned |
| F-025 | Stop | A member stops a task's agent. The workspace and branch stay, ready to reopen. | v1 | planned |
| F-026 | Approvals | Each agent profile picks one of two modes. "Works freely inside its workspace" is the default. "Asks before risky actions" covers commands outside an allowlist, network access, and writing outside the workspace. When the agent asks, the question appears in the panel and on the ticket, and a member approves or denies it. ostra sets each agent's own permission settings from the profile and never relies on its defaults (ADR 0020). | v1 | planned |
| F-027 | Diff | A task's page shows its branch's changes against the base branch. | v1 | planned |
| F-072 | Diff comments | A member comments on lines of a task's diff in the panel. The comments go to the agent together, as one prompt. | v1 | planned |
| F-028 | Take it local | A member can copy the commands to check out a task's branch. On their own runner, they can open the workspace in their editor. | v1 | planned |
| F-070 | Update branch | One action asks the agent, as a new turn, to merge the base branch into the task's branch and fix any conflicts. | v1 | planned |
| F-041 | Attach | On a member's own machine, `ostra attach <task>` checks out the branch, restores the session and opens the agent's own terminal interface. Everything done there becomes a session of the task. | v1 | planned |
| F-029 | Live terminal | A member opens a terminal into a task's workspace from the browser. | later | planned |

## Shipping and coming back

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-030 | Open the PR | When a session ends with changes, ostra pushes the branch and opens a GitHub PR, authored as ADR 0019 says. Its title holds the ticket ID and comes from the ticket, and its body links the ticket and sums up the change. | v1 | planned |
| F-078 | Repo conventions | PRs fill in the repo's PR template when it has one, and the agent writes commits in the repo's style. ostra adds only the driver's `Co-authored-by` (ADR 0019), and the PR body links the ticket and the task. | v1 | planned |
| F-065 | No empty PRs | A session that ends without changes never opens a PR. Its task goes to "needs you" with the agent's summary of what happened. | v1 | planned |
| F-054 | Checks before the PR | An environment can name check commands (such as `pnpm test`). ostra runs them when a session ends and shows the results in the panel and the PR body. Failing checks make the PR a draft. By default there are none. | v1 | planned |
| F-055 | Signed-commit repos | ostra detects a repo that requires signed commits and tells the admin it isn't supported yet, before any task starts on it. | v1 | planned |
| F-056 | Signed commits | ostra creates commits through GitHub's API on repos that require signed commits, so the App signs them. | later | planned |
| F-053 | Prompt from the PR | A member's `@ostra <prompt>` comment on a task's PR reopens the task with that prompt. GitHub logins are matched to members, and comments from non-members are ignored. | v1 | planned |
| F-031 | Ticket sync | ostra posts progress and the PR link on the ticket. It moves the ticket to the board's "started" status when the task starts and to "in review" when the PR opens. On merge, "done" is left to Linear's own GitHub integration, and ostra does it only when that integration isn't installed. Each board can change the mapping, and the defaults come from the tracker's status types. | v1 | planned |
| F-032 | Reopen | Any member reopens any task and keeps prompting on the same branch. New commits update the same PR (ADR 0006). | v1 | planned |
| F-033 | Reopen anywhere | A task started on one runner can be reopened on another, by another member, and with another agent, through the three steps in ADR 0006. That also works after the agent's own copy of the session is gone. | v1 | planned |
| F-066 | After the merge | Reopening a task whose PR is merged starts a fresh branch from the base and a new PR, linked to the same ticket and keeping the task's history. If the ticket is closed or cancelled in the tracker while its task runs, the task pauses and asks whether to stop. | v1 | planned |
| F-034 | Feedback to the agent | Every PR review comment and ticket comment reaches the task's agent as a prompt automatically, without an `@ostra`. | later | planned |
| F-035 | Fix failing CI | When a task's PR fails CI, ostra can send the failure to the agent to fix. | later | planned |
| F-071 | Fix conflicts automatically | When GitHub reports a conflict on a task's PR, ostra runs Update branch (F-070) by itself. | later | planned |
| F-036 | Notifications | "Needs you" moments (an approval, a question from the agent, a PR ready for review) show in the panel and on the ticket in Linear, so Linear's own notifications reach people. | v1 | planned |
| F-057 | Email and Slack | The same moments also reach members by email or Slack, as each member chooses. | later | planned |

## The panel

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-062 | Home | A member's first screen leads with "needs you" (questions, approvals, plans and PRs to review, in amber), then what's running, then what's recent. A board grouped by status is the second view. | v1 | planned |
| F-075 | Responsive panel | Every screen works at phone width, and the "needs you" moments (approve, answer, reopen) are fully usable on a phone. There's no mobile app. The panel is built with shadcn/ui (ADR 0007) and is designed desktop first. | v1 | planned |
| F-080 | Search | Members find tasks by ticket, repo, member, status, or text anywhere in a task's conversation. | v1 | planned |
| F-081 | Keyboard and accessibility | A command palette (⌘K) and shortcuts cover the core actions: jump to "needs you", approve, answer, take over and reopen. Every screen is usable by keyboard and meets WCAG AA contrast. | v1 | planned |
| F-082 | Theme | Dark by default. Each member can choose light or "match my system" (`brand/files/tokens/`). | v1 | planned |
| F-083 | Translatable interface | v1 is in English, and all interface text lives in message files from the first screen, so a translation is a new file, not a rewrite. | v1 | planned |
| F-084 | Usage | Each task shows its agent time and tokens, wherever the agent reports them. | v1 | planned |
| F-073 | Audit log | Every task start, approval, takeover, use of a credential and admin change is recorded with who and when, and admins can view and filter it. | v1 | planned |
| F-074 | Public API | A documented REST API and outgoing webhooks let teams script ostra. v1 keeps its internal API clean enough that publishing it isn't a rewrite. | later | planned |

## Docs

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-058 | Docs site | A public docs site has the self-hosting guide, the configuration reference (every setting with its default), how to set up a runner, and the adapter guide for contributors. | v1 | planned |
| F-037 | Costs and budgets | The panel shows each task's cost in money, and admins set budgets with hard limits per team, member or agent profile. | later | planned |

## Reliability

Each row is one guarantee from ADR 0011.

| ID | Feature | Done when | Priority | Status |
|---|---|---|---|---|
| F-043 | Nothing is lost | Killing the server at any moment and starting it again loses no ticket event, task change or agent event, and every running task carries on. | v1 | planned |
| F-044 | Drift gets fixed | With webhooks switched off, every change in the tracker and on GitHub still reaches ostra within 5 minutes *(working value)*. | v1 | planned |
| F-045 | Runners can drop out | A runner that's offline for up to 10 minutes *(working value)* reconnects, and its tasks carry on without losing an event. After longer than that, its tasks stop cleanly, ready to reopen elsewhere. | v1 | planned |
| F-046 | No duplicates | Replaying any webhook, or retrying any call to a tracker or code host, never creates a second PR, comment or status change. | v1 | planned |
| F-047 | Agent crashes don't kill tasks | Killing an agent mid-turn marks its session as crashed and keeps the workspace and branch, and one action reopens the task. | v1 | planned |
| F-048 | Failure tests | Against the test workspaces, the test suite kills runners, drops webhooks and restarts the server mid-task, and every check passes. | v1 | planned |
