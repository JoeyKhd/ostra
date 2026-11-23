# Target: a project's Boards with mixed trackers

- **Pictures:** `boards-mixed` and `boards-mixed-light` (a Linear team and a Jira project attached, the Jira board selected), `boards-attach` and `boards-attach-light` (the Linear board selected, the attach picker open), `boards-states` (a disconnected connection's board, the target-status picker, Done by Jira automation, prompt tasks on a Jira board), `boards-phone` (390×844).
- **Sources:** `html/boards.html?view=mixed|attach`, `html/states.html?sheet=boards`, `html/phone.html?scene=boards`; `html/tr.js` (`boardRows`, `attachLine`, `attachMenu`, `jiraMapping`, `jiraBoardPanel`, `linearMapping`, `linearBoardPanel`).
- **Route (existing):** `/projects/[project-id]/boards` → `components/boards/boards-view.tsx`, grown.
- **Builds on:** `../m2/project-boards.md` and `../m10-gaps/prompt-tickets.md` (approved), as the live page draws them.
- **Feature:** F-007, F-008, F-097/c2. ADR 0013, ADR 0047.
- **Status: approved 2026-11-23** ("yes to all", `README.md`).

## Purpose

A project attaches teams and projects from any of the organization's tracker connections, and maps ostra's steps to each board's own statuses. A Jira board moves through its workflow's transitions, so its mapping says which transition ostra uses and warns where none reaches.

## What changes on the page

| Part | Change |
|---|---|
| Lede | `Teams and projects from the organization's trackers whose tickets reach this project's Inbox. Each board maps ostra's steps to its own statuses.` |
| Attached rows | 48px; the board icon gives way to the kind's **mark, 18px, brand colour**; the name (14px 500) over `Acme Linear · team` / `Globex Jira · project` (12.5px `--faint`); then the key (mono), `38 open`, the activity, `Detach`. Grid `24px 1fr 56px 128px 1fr 64px` |
| Attach line | `Attach` + one select (300px) listing every active connection's boards, grouped (below), + `Attach` |
| Prompt tasks | unchanged (`../m10-gaps/prompt-tickets.md`); its board picker shows each board's mark (`boards-states`) |
| Status mapping | the selected board's; for Jira, as below |
| Panel | `Board` group gains `Tracker` (mark 16px + the connection's name); a Linear board keeps `Statuses in CALC`; a Jira board shows `Workflow for PROJ` and `Transitions` |

### The attach picker (`boards-attach`)

A menu, 330px, under the select. A group per connection, headed by its mark 14px, its name (12px 500 `--faint`) and, right, mono 11.5px `teams` / `projects`. Items: Lucide `square-kanban`, the name, ` · ` and the key (mono 13px `--muted`). A board attached here already: `--faint`, `attached` on the right, not pickable (a board attached to another project is pickable: a board can feed several projects, as today). A pending connection: its head says `pending` and one faint line, `Finish connecting it on Trackers first`. A failed one: `failed` and `Reconnect it on Trackers first`. Typing filters across all groups.

### A Jira board's mapping (`boards-mixed`)

Note under the section title: `Drafted from PROJ's workflow. ostra moves a ticket with the workflow's own transitions, never by writing its status.`

| Step | Control | Under it |
|---|---|---|
| `Open` · `Tickets the Inbox shows` | the multi-select of statuses, each chip with its category square | |
| `Started` · `When the task starts` | a **target status** select (300px): the category square, the status | `corner-down-right` 12px + 12.5px `--faint`: `by Start progress, from To Do or Backlog` (the transition names `--muted` 500) |
| `In review` · `At the task's first PR` | the same | `by Ready for review, from In Progress`; then a warning line (red `triangle-alert` 13px, 12.5px `--text-2`): `No transition reaches In Review from Blocked. A ticket there stays put, and ostra says so in its comment.` + teal `Workflow in Jira ↗` |
| `Done` · `When the last PR merges` | the same | `by Done, from any status` (a global transition) |
| `Done is moved by` | a segmented control: `Jira automation` / `ostra` (default `ostra`, choice 8) | beside it, 12.5px `--faint`: `Jira's GitHub integration links the PR, but moves nothing without an automation rule.` |

Linear's `Magic word` row isn't there: it's a Linear capability. A Jira board links its PRs by the key in the branch and the PR's title, which ostra always writes.

The category squares: 8px, 2px radius; `To Do` `--line-3`, `In progress` blue (`#5fa8e8`, light `#2f74c0`), `Done` `--green`, as Jira tells its categories apart. Always beside the status's name.

**The target-status picker** (`boards-states`): grouped by category (`To Do`, `In progress`, `Done`); each status with, on the right, 12px `--faint`, how many of the workflow's statuses reach it (`reached from 3 of 5`, `from any status`), or which can't (`not from Blocked`).

**Done is moved by Jira automation** (`boards-states`): an `info` line, `ostra won't move PROJ tickets to Done. Make sure a Jira automation rule does it when a pull request merges: Jira's GitHub integration alone only links the PR.`, and the numbered "What the next task does on the ticket" lines name the transitions.

### The panel, a Jira board

- **Board:** `Project`, `Key`, `Tracker` (mark + `Globex Jira`), `Tickets`, `Mode`, `Last event`, `Prompt tasks`.
- **Workflow for PROJ** with the count: each status, its square, and its category (12.5px `--faint`).
- **Transitions** with the count: each by name, and `from → to` (12.5px `--faint`; `any → Done` for a global one).

A Linear board's panel is today's, plus `Tracker` and `Agent mode · Takes delegations` when Start from Linear is on (the column of `../m6`'s targets, Linear only).

## States

| State | What shows |
|---|---|
| The connection disconnected | the row stays, `--muted`: `Globex Jira · disconnected`, a grey dot `Paused`; under the rows, `pause` + `Globex Jira was disconnected on 20 Nov, so PROJ's tickets stay as they were and nothing moves on Jira.` + `Trackers →`. Its mapping reads only. Connecting the same site again resumes it (choice 12) |
| The connection failed | the same row with a red dot, `Connection failed`, and `Reconnect on Trackers →` |
| Workflows not readable | the `by …` lines and warnings are gone; one `info` line under the note: `ostra can't read PROJ's workflow (no read:workflow:jira), so it can't check the transitions. It finds one per ticket when it moves it.` |
| A member | the page reads only, as today; the attach line is gone |
| Detach a Jira board | today's dialog, with `Globex Jira` named |

## Phone (`boards-phone`)

Each board a card: the mark 20px, the name and key, `Globex Jira · project`, then open count and last event. The mapping stacks: step, its hint, a 44px select, the `by …` line, the warning.

## Keyboard

As today. The attach select is Radix's: typing filters, `↑`/`↓` cross group heads, a disabled item is skipped. The marks are `aria-hidden` (the via line names the tracker).

## Data

- `boards.list` / `boards.get` add each board's `connection` (`id`, `kind`, `name`, `state`).
- `boards.attachable({ projectId })` → per active connection, its teams or projects, with `attachedHere`.
- `boards.workflow({ boardId })` (Jira) → statuses with categories, transitions (`id`, `name`, `from[]` or global, `to`), `readable`. The mapping stores a **target status** per step; `boards.reachability` gives the `by …` lines and the warnings.
- `boards.setDoneBy({ boardId, by: "tracker" | "ostra" })` (today's switch, named for both kinds).

## Copy (keys under `boards.*`)

`lede` (above) · `via.team` `{connection} · team` · `via.project` `{connection} · project` · `attach` `Attach` · `attach.attached` `attached` · `attach.pending` `Finish connecting it on Trackers first` · `attach.failed` `Reconnect it on Trackers first` · `jira.note` `Drafted from {key}'s workflow. ostra moves a ticket with the workflow's own transitions, never by writing its status.` · `jira.by` `by {transition}, from {statuses}` · `jira.byAny` `by {transition}, from any status` · `jira.unreachable` `No transition reaches {status} from {from}. A ticket there stays put, and ostra says so in its comment.` · `jira.workflowLink` `Workflow in Jira` · `doneBy.jira` `Jira automation` · `doneBy.jiraHelp` `Jira's GitHub integration links the PR, but moves nothing without an automation rule.` · `paused` `{connection} was disconnected on {date}, so {key}'s tickets stay as they were and nothing moves on {kind}.`

## Tokens

The panel's; the marks; Jira's category squares (above). Red on the warning icon only. **No amber.**
