# Domain model

**Status:** draft (2026-11-17), from grilling rounds 1–5. Terms follow `GLOSSARY.md`; this document says how they relate and how they change. Features are cited by ledger ID (`features.md`), decisions by ADR number (`decisions/`).

## What exists

```
Team ─┬─ Member (admin | member)
      ├─ Board ───────── links ─────────▶ Repo ── has one ──▶ Environment
      ├─ Runner (local: owned by one member | remote: shared)
      ├─ Agent profile
      ├─ Intake rule ── names ──▶ Board, Repo, Agent profile, runner labels
      ├─ Credential (team API keys, the GitHub App, the Linear app)
      └─ Audit entry

Ticket (lives in the tracker) ──▶ Task (per repo) ──┬─ Session ── Turn ── Event
                                                   ├─ Needs-you item
                                                   ├─ branch, workspace (on a runner)
                                                   └─ PR (lives on the code host)
```

| Thing | Belongs to | Notes |
|---|---|---|
| **Team** | the install | Every other record belongs to exactly one team (ADR 0010). |
| **Member** | a team | Is an admin or a member (F-003). Links a GitHub login, used for PR authorship and `@ostra` (ADR 0019, F-053). |
| **Board** | a team | A Linear team or project, later a Jira project or board. Links to one or more repos, and maps ticket statuses (F-007, F-031). |
| **Repo** | a team | A GitHub repo the team's App is installed on. Has one environment (F-050). |
| **Environment** | a repo | Setup script, variables and secrets, files like `.env`, and optional check commands (F-050, F-054). |
| **Runner** | a team | A local runner is owned by one member and runs only that member's tasks (ADR 0014). A remote runner is shared. Each has labels, a capacity and a version (F-067, F-069, F-061). |
| **Agent profile** | a team | Agent, model, instructions, skills, MCP servers, permission mode and plan-first (F-021, F-026, F-063). |
| **Intake rule** | a team | A tracker filter plus the board, repo, agent profile and runner labels it dispatches with (F-011). |
| **Ticket** | the tracker | ostra stores a reference and a cached copy, never the source of truth. |
| **Task** | a team | One ticket in one repo. Holds the branch, the current workspace, the PR, the driver and its sessions (ADR 0006). |
| **Session** | a task | One conversation with one agent profile on one runner. Its full history is kept on the server (ADR 0006). |
| **Turn** | a session | One prompt and the agent's full response. |
| **Event** | a session | One thing the agent or ostra did: a message, a tool call, a file change, a question, a state change. Events are saved before ostra acts on them (ADR 0011). |
| **Needs-you item** | a task | A question, an approval, a plan, or a reason the task stopped. It has a state of open, answered or dismissed. |
| **Audit entry** | a team | Who did what, when: task starts, approvals, takeovers, credential use, admin changes (F-073). |

## A task's lifecycle

```
 awaiting approval ─┐   (tasks from outside ostra, F-040)
                    ▼
 ──▶ queued ──▶ preparing ──▶ running ──▶ in review ──▶ merged
                                │  ▲         │   ▲        │
                                ▼  │         │   │        │ reopen: new branch (F-066)
                             needs you ◀─────┘   │        ▼
                                │                │      queued …
                                └── reopen ──────┘
                  any state ──▶ stopped (by a member; can be reopened)
```

| State | Means | Leaves when |
|---|---|---|
| **awaiting approval** | Started by someone outside ostra; nothing runs yet (F-040) | A member approves it (→ queued) or rejects it (→ stopped) |
| **queued** | Waiting for a runner with capacity, ordered by ticket priority (F-067, F-069) | A runner takes it (→ preparing) |
| **preparing** | The runner is creating or restoring the workspace and running the environment's setup (F-016, F-050) | Setup succeeds (→ running) or fails (→ needs you) |
| **running** | A session is active | The session ends with changes (→ in review, through checks and the PR), or anything in the "needs you" list below happens |
| **needs you** | A person has to act (below) | A member answers, approves, steers or reopens (→ queued or running), or stops it |
| **in review** | The PR is open and no session runs | A member reopens it, writes `@ostra`, uses Update branch or comments on the diff (→ queued); the PR merges (→ merged) or closes (→ stopped) |
| **merged** | The PR is merged | Reopening starts a fresh branch and a new PR (→ queued, F-066) |
| **stopped** | A member stopped it, or the PR closed unmerged | Reopening (→ queued) |

**A task needs you when** (each case is a needs-you item):
- the agent asks a question or wants an approval (F-026)
- the agent proposes a plan, under plan-first (F-063)
- a session ends without changes (F-065)
- a session times out or stalls (F-068)
- a session or the environment setup crashes (F-047)
- the ticket was closed or cancelled while the task ran (F-066)

## A session's lifecycle

```
 starting ──▶ running ⇄ waiting (on a needs-you item)
                │
                ├──▶ ended (with changes | without changes)
                ├──▶ stopped (by a member, or by runaway protection)
                └──▶ crashed (the agent or runner died; the workspace stays)
```

Only one session per task is starting, running or waiting at any time.

## Rules that always hold

- **One team.** Every record belongs to one team, and no query crosses teams (ADR 0010).
- **One ticket, one repo.** A ticket that needs two repos becomes two linked tasks (F-007). A ticket with sub-issues becomes one task per sub-issue (F-077).
- **One driver.** At most one member drives a task at a time. Taking over is a recorded event (F-024, F-073).
- **One active session per task**, as above.
- **The branch is the task's.** It's named from the ticket, and only the task's sessions push to it (F-016).
- **Saved before acted on.** Every event, state change and outside call is written down first. A restart picks up from what's written (ADR 0011).
- **Rebuildable.** A task can always be rebuilt from its branch and its stored history. That's why workspaces can be cleaned up (ADR 0006, F-079).
- **The tracker owns the ticket, and the code host owns the PR.** ostra keeps references and caches. Drift is fixed by regular checks (F-044).
- **Branded IDs.** `TeamId`, `TaskId`, `SessionId`, `RunnerId`, `TicketKey` and the rest are distinct types (`AGENTS.md`).
