# Target: a project's Boards with a Trello board

- **Pictures:** `boards-trello` and `boards-trello-light` (Calculations selected, its prefix, steps and lists), `boards-attach-trello` and `boards-attach-trello-light` (attaching Calculations, the picker and the prefix), each at 390×844 as `boards-trello-phone`, `boards-trello-phone-light`, `boards-attach-trello-phone`, `boards-attach-trello-phone-light`; a paused board and a taken prefix on `trello-states`.
- **Sources:** `html/boards.html?view=mapping|attach`, `html/phone.html?scene=boards|attach`, `html/states.html`; the parts in `html/tl.js` (`boardRows`, `attachLine`, `attachMenu`, `trelloMapping`, `trelloBoardPanel`) and `html/tl.css` (`.prefixrow`, `.mapgrid`, `.ltable`).
- **Route (existing):** `/projects/[project-id]/boards` → `components/boards/boards-view.tsx`, grown by milestone 11.
- **Builds on:** `../m11-trackers/boards-mixed.md` (approved), as the live page draws it.
- **Feature:** F-153, F-007, F-097/c2. ADR 0072.
- **Status: design target, 2026-11-23**, awaiting approval (`README.md`).

## Purpose

A project attaches boards from any connection. A Trello board is different from a Linear team or a Jira project in two ways: it has no key of its own, so the admin gives it a **prefix**, and its statuses are **lists** with no category, so the admin maps every list to one of ostra's categories and picks the list each step writes.

## What changes on the page

| Part | Change |
|---|---|
| Lede | `Teams, projects and boards from the organization's trackers whose tickets reach this project's Inbox. Each board maps ostra's steps to its own statuses.` |
| Attached rows | 48px; the kind's mark 18px, brand colour; the name (14px 500) over `Acme Trello · board` (12.5px `--faint`); then the key `TR` (mono), `12 open`, the activity, `Detach`. Grid `24px 1fr 56px 128px 1fr 64px` |
| Attach line | `Attach` + one select (300px) listing every active connection's boards, grouped, + `Attach`; for a Trello board a **prefix** line sits under it: `Prefix` `[TR]` and `Cards show as TR-12. Two to eight letters or digits, unique in this project.` |
| Status mapping | The selected board's. For Trello: a prefix row, the step rows, and `Lists on Calculations` with a category per list |
| Panel | `Board` group gains `Prefix` (`TR`); `Lists on Calculations` with each list's category; `What Trello does here` |

### The attach picker (`boards-attach-trello`)

A menu, 330px, under the select. A group per connection, headed by its mark 14px, its name (12px 500 `--faint`) and, right, mono 11.5px `teams` / `projects` / `boards`. Items: Lucide `square-kanban`, the name and, where it has one, the key (mono 13px `--muted`). A board attached here already is `--faint`, `attached` on the right, not pickable. A pending connection: its head says `pending` and one faint line, `Finish connecting it on Trackers first`. A failed one: `failed` and `Reconnect it on Trackers first`. Typing filters across all groups.

Choosing a Trello board reveals the prefix line; `Attach` is disabled until the prefix is valid. The prefix is 2–8 `[A-Z0-9]`, unique among the project's attached boards (`keyPrefixTakenBy`). A taken prefix puts a red edge on the field and the line `TR is used by Calculations in this project. Pick another prefix.` (`trello-states`).

### A Trello board's mapping (`boards-trello`)

Note under the section title: `Each list is a status, and ostra writes the list directly: Trello has no workflow and no transitions. The admin maps every list to a category and to the steps ostra moves.`

A prefix row, full width: `Prefix` `[TR]` + `Cards show as TR-12. Two to eight letters or digits, unique in this project.`

Then two columns, aligned at the top:

| Step | Control | Under it |
|---|---|---|
| `Open` · `Cards the Inbox shows` | the multi-select of lists, each chip with its category square | |
| `Started` · `When the task starts` | a list select (300px): the category square, the list | a hint line, 12.5px `--faint`: `writes Doing directly: a list always takes a card` |
| `In review` · `At the task's first PR` | the same | `writes Review directly` |
| `Done` · `When the last PR merges` | the same | `writes Done directly` |
| `Done is moved by` | a fixed `ostra` segment (no alternative) | 12.5px `--faint`: `Trello has no GitHub integration to move a card.` |

The right column is `Lists on Calculations` and the count, then one 34px row per list: the list's name, a 138px category select (`To Do`, `In progress`, `Done`, `Cancelled`), and the step it maps (`Open`, `Open`, `Started`, `In review`, `Done`, `–`). Under it, 12.5px `--faint`: `Each list carries the category its cards take. ostra writes the chosen list directly: a list always takes a card, so there is no unreachable status.`

The category squares are Jira's (`../m11-trackers/boards-mixed.md`): `To Do` `--line-3`, `In progress` blue (`#5fa8e8`, light `#2f74c0`), `Done` `--green`; `Cancelled` a faded `--line-3`. Always beside the category's word.

No magic word, no transitions, no target-status picker, no `by <transition>` lines: those are Linear's and Jira's capabilities. Trello has none of them.

## The panel, a Trello board

- **Board:** `Board` (`Calculations`), `Prefix` (`TR`), `Tracker` (mark 16px + `Acme Trello`), `Cards` (`12` open), `Mode` (`Webhooks`), `Last event` (mono `3m ago`).
- **Lists on Calculations** with the count 6: each list, its category square, and its category (12.5px `--faint`).
- **What Trello does here:** `Moves status` `Directly, by list`; `Sub-tasks` `– not in Trello`; `Files` `Attachments`.

## States

| State | What shows |
|---|---|
| The connection disconnected | the row stays, `--muted`: `Acme Trello · disconnected`, a grey dot `Paused`; under the rows, `info` + `Acme Trello was disconnected on 20 Nov, so TR's cards stay as they were and nothing moves on Trello.` + `Trackers →`. Its mapping reads only. Connecting the same bot member again resumes it |
| The connection failed | the same row with a red dot, `Connection failed`, and `Reconnect on Trackers →` |
| A member | the page reads only, as today; the attach line is gone |
| Detach a Trello board | today's dialog, naming `Acme Trello`; ostra deletes the webhook it made on the board |
| A board attached to another project | pickable (a board can feed several projects); its prefix is the one it already has in that project |

## Phone

Each board a card: the mark 20px, the name and key, `Acme Trello · board`, then the open count and last event. The prefix is one row (`Prefix`, a 44px field, the help). Each list is a 38px row with its category select; the three steps follow as `Started`, `In review`, `Done`, each with a 44px select. The attach picker is a bottom sheet with the groups and the prefix above `Attach`.

## Keyboard

As today. The attach select is Radix's: typing filters, `↑`/`↓` cross group heads, a disabled item is skipped. The prefix field accepts `[A-Z0-9]` only, uppercases what's typed, and announces its error. The marks are `aria-hidden` (the via line names the tracker).

## Data

- `boards.list` / `boards.get` add each board's `connection` (`id`, `kind`, `name`, `state`) and, for Trello, the `statusCategories` and the `keyPrefix`.
- `boards.attachable({ projectId })` → per active connection, its teams, projects or boards, with `attachedHere`; a Trello board also carries its `lists`.
- `boards.attach({ projectId, connectionId, boardId, keyPrefix })` → refuses a missing, malformed or taken prefix (`key-prefix-taken`); registers the board's webhook.
- `boards.mapping({ boardId, statusCategories, open, started, inReview, done })` → a list that isn't on the board is `unknown-mapped-statuses`.
- `boards.get` returns the lists with `pos` order for the mapping.

## Copy (keys under `boards.*`, Trello's under `boards.trello.*`)

`lede` (above) · `via.trello` `{connection} · board` · `attach` `Attach` · `attach.attached` `attached` · `attach.pending` `Finish connecting it on Trackers first` · `attach.failed` `Reconnect it on Trackers first` · `prefix` `Prefix` · `prefix.hint` `Cards show as {key}. Two to eight letters or digits, unique in this project.` · `prefix.taken` `{prefix} is used by {board} in this project. Pick another prefix.` · `trello.note` (above) · `trello.direct` `writes {list} directly` · `trello.directHelp` `a list always takes a card` · `trello.lists` `Lists on {board}` · `trello.category` `Category` · `trello.step` `Step` · `trello.categoriesHelp` (above) · `doneBy.ostra` `ostra` · `doneBy.trelloHelp` `Trello has no GitHub integration to move a card. ostra moves it when the last PR merges and attaches the PR's link.` · `paused.body` (above).

## Tokens

The panel's; Trello's mark; Jira's category squares (above), reused for a list's category. Red on an error edge only. **No amber.**
