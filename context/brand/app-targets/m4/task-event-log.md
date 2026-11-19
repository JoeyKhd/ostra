# Target: the Event log tab

> **Committed image:** `task-event-log.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The target for the task page's **Event log** tab on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: every event the task recorded, in order, with each tool call's kind, full input, status and error, each approval with the command it asked about, filters by kind, and the line on what a record can't show. The page around it is `../m2/task-ticket.md`, with the tabs from `../m3/task-changes.md` and the Checks tab from `../m3/task-checks.md`. Where the picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-event-log.webp` | `CALC-174`, driven by Alex Kim, in review with the session idle. The log holds 214 events, all kinds shown, oldest first, scrolled to turn 3: Alex's message, a read, a search, a read that failed (no such file), an edit of two files, `pnpm test -- history` failed with exit 1 and open with its full input and error, an approval for `pnpm add json5` that Alex declined and the call it refused, a fetch, and the push. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high), in two generations: the first from the approved `../m3/task-checks` original (2048 px), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`); the second an edit of the first (same references) that set the message row in sans on one line and unstyled the "in Activity" link. Prompts: `task-event-log.prompt.txt`, the edit's after the first.
- **Features:** F-073 audit log (the task's event log view). ADR 0054 ("The task's event log view", "What it can't show"), ADR 0035 (what a tool call records, Q161). Ticket 34 builds it; ticket 25 serves `tasks.eventLog`. Spec section 12, screen 9; section 3, step 10.

## Purpose

The audit's answer to "what did the agent actually do?". An auditor, an admin following an audit entry, or a member reviewing a task reads every event in order: what was asked, what the agent read, searched, wrote, ran and fetched, with the exact input, which calls failed or were refused and why, and which approvals were asked and how they were answered. It reads only what's stored and never re-runs anything. The Activity tab is the readable thread; this tab is the record.

## Route

`/tasks/[task-id]?tab=events`. An audit entry about a task links here (ticket 25, "The link"); `&seq={n}` opens the log scrolled to that event, which is selected and, if it's a tool call, open. The tabs: `../m3/task-changes.md`, "Route".

## Layout

The page's frame, header and tabs as `../m3/task-changes.md`. The tab list gains **Event log** after Checks, with its marker: mono 12px `--faint` total event count (`214`). The tab pins nothing at the bottom: no composer. Its body scrolls under the header; the filter row sticks under the tabs while it scrolls.

1. **Filter row,** 40px, 10px below the tabs, sticky, `--bg` fill:
   - **Kind chips,** 26px, radius 6px, 1px `--line-2`, padding 0 10px, 13px, 6px apart: the label `--muted` + mono 12px `--faint` count. Selected: `--raise` fill, label `--text`. A single choice: `All`, `Tool calls`, `Messages`, `Approvals`, `Turns`, `Session` (below, "The kinds").
   - A 1px × 18px `--line-2` divider, 12px each side, then **`Failed or refused`**: a toggle chip of the same size with `circle-x` 13px `--red` and a mono 12px `--red` count. It narrows whichever kind is chosen. Pressed: `--raise` fill. With no failure, it's disabled with a `--faint` `0`.
   - Right-aligned: the order, a ghost `Button` 13px `--faint` `Oldest first` / `Newest first` that flips it.
2. **The record line,** 32px, no box: `info` 15px `--muted`, 10px, 13px `--faint`: the line on what a record can't show (below). Then a 1px `--line`.
3. **Turn bands,** 32px, `--raise` fill, padding 0 12px, before each turn's first event: `Turn {n}` 14px weight 600 `--text`, 12px, mono 12px `--faint` `{time} · {who started it} · {agent} · {model}`. Events before the first turn (the task's start, the session's start) sit under a band `Before turn 1`. A turn with no events in the current filter has no band.
4. **Event rows,** 34px, 1px `--line` between them, a strict grid:

| Column | Width | Content |
|---|---|---|
| Chevron | 16px | `chevron-right` / `chevron-down` 14px `--muted`, only on rows with a body to open (tool calls, messages cut short) |
| Seq | 44px, right | mono 12px `--faint`: the event's `seq` |
| Time | 84px, 16px left gap | mono 12px `--faint` `HH:MM:SS` in the viewer's zone; `title` holds the full ISO time |
| Kind | 112px | the kind's icon 15px `--muted`, 10px, the kind word mono 12.5px `--muted` |
| Text | `1fr` | the event's one-line summary (below), truncated with an ellipsis |
| Status | 120px, right | 13px, the status word (below) |
| Duration | 56px, right | mono 12px `--faint` |

5. **An open row:** the row gets `--sel` fill, and its body follows with the same fill, padding 4px 0 14px, indented to the Text column:
   - `Input`, 12px `--faint`, 6px, then the input as stored, pretty-printed JSON in a `.code` block (`--surface`, 1px `--line`, radius 8px, padding 10px 14px, mono 12.5px/1.6, `--muted`, `white-space: pre-wrap`, words break anywhere). Keys and strings aren't coloured.
   - For a failed or refused call, 10px, then `Error`, 12px `--faint`, 6px, the error text as stored, mono 12.5px `--muted`, plain text. Then, for an `execute` with output, `Output: {size}, in Activity.` with teal `in Activity` linking to the call in the thread (`?tab=activity&event={seq}`). The log never shows tool output (ADR 0054: output can hold a file's whole content; it stays in the thread).
   - `Copy input`, a teal 12px link with `copy` 13px, right-aligned on the `Input` label's line.
   - Inputs longer than 40 lines show their first 40 with a teal 12px `Show all {n} lines` under the block (ticket 34: "long inputs wrapped with Show all").
6. **Paging:** rows load 200 at a time by `seq` (ticket 25); the next page loads as the list nears its end. Under the last loaded row, 16px, 12px `--faint`: `Showing {shown} of {total} events.` and, while more remain, ` Scroll for more.`

A failed or refused tool call is **not** opened on load (the log is a record, not a to-do list); a row opens with a click, Enter or Space, and arrow keys move between rows. Opening is per viewer, not saved.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. Everything here is **new**.

### The record line (ADR 0054, "What it can't show"; ADR 0035)

| The task's executor | Line |
|---|---|
| `host` | `A record shows what the agent asked for, not what a program it built went on to read. This task ran on host, which has no box.` |
| `docker`, `kubernetes` | `A record shows what the agent asked for, not what a program it built went on to read. The box kept the agent in its workspace.` |
| sessions on several executors | the `host` line, since one session had no box |

### The kinds (the chips) and what each row says

The event types are `packages/protocol/src/events/agent-events.ts`'s. One row per event, in `seq` order, with two folds: a tool call's `tool.completed` or `tool.failed` folds into its `tool.called` row (its status and duration), and its `tool.progress` events aren't rows. Streaming deltas (`agent.content`) and `agent.thought` aren't rows either: the finished `agent.message` is. The total in the tab and on `All` counts rows, not raw events.

| Chip | Event | Icon | Kind word | Text |
|---|---|---|---|---|
| Tool calls | `tool.called`, `read` | `file-text` (`file-x` when it failed) | `read` | the path mono `--text`; `:{startLine}` when given |
| | `edit`, `delete`, `move` | `pencil`, `trash-2`, `move` | `edit`, `delete`, `move` | the paths, mono `--text`, joined by `--faint` `, `; more than 3: the first 3 + `--faint` ` +{n} more` |
| | `search` | `search` | `search` | the query mono `--text` + `--muted` ` in ` + the folder mono `--text` |
| | `execute` | `square-terminal` | `execute` | the command mono `--text`; the folder isn't in the row, it's in the input |
| | `fetch` | `globe` | `fetch` | the URL mono `--text` |
| | `other`, `switch_mode`, an MCP tool | `wrench` | the tool's name | the input's first string field mono `--text`, or `--faint` `(no input)` |
| Messages | `user.message` | `user` | `message` | **`{name}:`** 14px weight 600 `--text` + the message 14px `--muted`, sans, one line |
| | `agent.message` | `message-square` | `agent` | the message 14px `--muted`, sans, one line |
| | `question.asked`, `.answered`, `.closed` | `message-circle-question` | `question` | `Asked: {first line}` / `Answered by {name}: {first line}` / `Closed: {reason}` |
| Approvals | `approval.requested` | `shield-question` | `approval` | `--muted` `Asked to run ` + the command mono `--text` |
| | `approval.answered` | `shield-check` / `shield-x` | `approval` | `--muted` `Approved once by {name}` / `Approved for this task by {name}` / `Declined by {name}` + `: {note}` when there is one |
| | `approval.closed` | `shield` | `approval` | `--muted` `Closed: {reason}` (the session ended, the agent withdrew it) |
| | `plan.updated` | `list-checks` | `plan` | `--muted` `Plan proposed` / `Plan approved by {name}` / `Plan edited by {name}` |
| Turns | `turn.started`, `turn.ended`, `turn.failed` | `play`, `square`, `circle-x` | `turn` | `Turn {n} started by {name}` / `Turn {n} ended` / `Turn {n} failed: {reason}`; ended rows carry the turn's duration |
| Session | `runner.connected`, `.lost`, `session.saved`, `.restored`, `.ended`, `.crashed`, `driver.changed`, `compaction.updated`, `git.pushed`, `pr.opened`, `usage.recorded`, `session.usage` | `plug`, `unplug`, `save`, `rotate-ccw`, `circle-stop`, `circle-x`, `user-round-cog`, `fold-vertical`, `git-commit-horizontal`, `git-pull-request`, `coins`, `coins` | `runner`, `session`, `driver`, `git`, `pr`, `usage` | one plain sentence each: `alex-laptop connected`, `Session saved`, `Driver changed to {name}`, `Pushed {sha7} to {branch}`, `Opened PR #{n} in {repo}`, `{in} in · {out} out · ${cost}` |

The picture shows the answered approval as one row (`Asked to run pnpm add json5 · declined by Alex Kim at 09:39`): **build two rows**, the `approval.requested` and the `approval.answered`, since every event is a row; both are neutral, never amber (the approval is history here; the live one is in Activity).

### Status and duration

| State | Status (13px) | Duration |
|---|---|---|
| a call still running (`tool.called`, nothing after it) | `running` `--muted`, `loader-circle` 13px spinning before it (still with reduced motion) | live, `12 s` |
| `tool.completed` | `ok` `--green` | `0.1 s`, the call's time; `–` when the agent sent no timing |
| `tool.completed`, an `execute` with a non-zero exit | `failed · exit {code}` `--red` | as above |
| `tool.failed`, an error | `failed` `--red` | as above |
| `tool.failed`, refused (a declined approval, the agent's own permission check) | `refused` `--red` | `–` |
| any other event | nothing | nothing, except `turn.ended` (the turn's time) |

Durations as `../m3/task-checks.md`: `{n.n} s`, `{m} min {s} s`, `{m} min`. The `Failed or refused` chip counts the rows with a red status.

### The tab's body

| Condition | Shows |
|---|---|
| loading | the filter row with counts as `–`, then 8 skeleton rows |
| no events yet (queued) | 14px `--muted` `Nothing has happened yet.` and 13px `--faint` `Every message, tool call and approval appears here as it's recorded.` |
| a filter with no rows | 14px `--muted` `No {kind} in this task.` (`No tool calls in this task.`; with `Failed or refused`: `Nothing failed or was refused.`) |
| `tasks.eventLog` failed | red 13px `The event log couldn't be loaded: {error}` + teal `Try again` |
| a session is running | new events append live at the end (oldest first) or the top (newest first), from the task's stream; the list doesn't jump if the viewer has scrolled away, and a 28px `--raise` bar `{n} new events` with teal `Show` appears at that end |
| the viewer can't open the task | the page's `not-found`, as every task route (ticket 25: `NOT_FOUND`) |
| a payload the panel's schemas don't know (`agent.unknown`, an old shape) | the row with kind word `event`, text mono `--faint` the event's type, and its stored JSON in the open body |

### Properties and the header

Unchanged from `../m3/task-checks.md`.

## Tokens and components

Tokens: `app-concepts/html/graphite.css` at the pictures' scale (`../m1/README.md`, "Scale"); nothing new. Red carries every failure and refusal, never amber; no green except `ok`. Icons (Lucide): the kinds table, plus `info`, `circle-x`, `chevron-right`, `chevron-down`, `loader-circle`, `copy`.

| Part | Component |
|---|---|
| Kind chips | `ToggleGroup` (`type="single"`) of `Button` `variant="outline"` `size="sm"`; `Failed or refused` a `Toggle` |
| Rows | a virtualised list (`@tanstack/react-virtual`, approved, ADR 0007; ticket 34), each row a disclosure (`Collapsible`), not a `Table` |
| Turn bands | sticky headers inside the virtual list |
| Input and error | the `.code` block `renderers.tsx` uses for tool output |
| Copy input | `Button variant="link"` |
| Skeleton | `Skeleton` |

New files under `components/tasks/task-event-log/` (ticket 34).

## Differences from the current code

1. **No Event log tab and no `tasks.eventLog` today:** the tab, the filter row, the rows and the open body are new, on ticket 25's `tasks.eventLog` (paged by `seq`, filtered by kind), live from the task's stream.
2. **The tab list** gains `Event log` after `Checks` (`../m1/task` grows, ticket 34's comments).
3. **`?tab=events`** joins the tab parameter's values; `&seq=` is new.

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Rows per event or per call.** The target folds a call's completion into its `tool.called` row (one row per call, its status on it). Say if an audit needs the completion as a row of its own, with its `seq`.
2. **Export.** ADR 0054 exports the audit log as CSV, not the event log. An auditor may want this tab as JSON; nothing in milestone 4 asks for it, so there's no button.

## Wrong in the image

| In the image | Build |
|---|---|
| `"pppm test -- history"` in the open input | `"pnpm test -- history"`: the input exactly as stored |
| `nppm add json5` in the approval row | `pnpm add json5` |
| The answered approval as one row | two rows, `approval.requested` and `approval.answered` (above) |
| Row 198's duration `-` | `–` (an en dash) |
| No chevron on rows other than the open one | every tool call and every cut-short message has the 16px chevron column; rows without a body keep the empty column, so every seq lines up |
| No `Copy input` link on the open row | as "An open row" says |
| The tab's count `214` and the chips' counts in sans | mono 12px `--faint` |
| The `Spend`, `Insights`, `Memory` and `Members` rows in the sidebar | the shared sidebar, with only what's shipped (`../m1/README.md`, "One sidebar") |
| `PR #483` in the top bar with the plain pull-request icon | `git-pull-request-draft`, as `../m3/task-checks.md` says |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| Seqs, times, paths, commands, the URL, durations, counts | demo data, not copy |
