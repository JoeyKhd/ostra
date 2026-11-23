# Target: ticket marks, with Trello

- **Pictures:** `ticket-chips-trello` and `ticket-chips-trello-light`: one board of every place a ticket shows, for `calculator` with a Linear team (`CALC`, Acme Linear) and a Trello board (`TR`, Acme Trello), the mark at each size, and the alternative not taken; `ticket-chips-trello-phone` and `-phone-light`.
- **Sources:** `html/chips.html`, `html/phone.html?scene=chips`; `tkey`, `logo` and the marks in `html/tl.js` and `../../m11-trackers/html/tr.js`.
- **Builds on:** `../m11-trackers/ticket-chips.md` (approved), `../m2/inbox.md`, `../m2/task-ticket.md`, `../m9/ticket-context.md` as the live pages draw them.
- **Feature:** F-153 (parity: a Trello card shows everywhere a Linear ticket does). **Status: design target, 2026-11-23**, awaiting approval (`README.md`).

## The rule

Every place a card shows says which tracker it's from, so `TR-12` (Trello) and `CALC-170` (Linear) read apart at a glance:

- **Brand colour** where the mark names the tracker once: a task's header, its Ticket group, New task's line, the mark-size sheet.
- **One colour, the key's own `--faint`,** where it repeats down a list or sits in running text: Inbox rows, the sidebar's live tasks, the thread's meta lines, search results. Trello's one-colour mark is Atlassian's own cut-out.
- The **word** is always there, or in the tooltip: `from Trello` in a header, `Trello · Acme Trello` in the panel, the tooltip on an Inbox row's mark.

## Places

| Place | What shows | Size |
|---|---|---|
| **Inbox row** | the mark before the key, in the key's colour (`--faint`); the key mono 13px. Tooltip on the mark: `Trello · Acme Trello`. No sub-task chip: Trello declares `subIssues: false` | 14px, 6px gap |
| **A task's header** | the eyebrow: the mark in brand colour, then mono `TR-12 · from Trello`; the chips row's status chip is the list's name with `square-kanban`, no category square (a list carries no vendor category); the link reads `Open in Trello ↗` | 14px |
| **The Ticket group** (the panel) | `Key` (teal mono, as today); `Tracker`: the mark in brand colour 16px, `Trello`, `--faint` `· Acme Trello`; `Status`: `square-kanban`, the list's name, `--faint` `· a list`; `Board` (`Calculations`), `Synced`. No `Sub-tasks` row, because the adapter doesn't declare it | 16px |
| **On Trello** (the group under it, today's `On Jira`) | each row and how it was done, 12.5px `--faint`: `Moved to Doing · wrote the list`, `Progress comment · posted`, `Linked the task · attachment` | |
| **What the agent got** | the meta line: `14:02 · ` + the mark in the meta's colour + `TR-12 from Trello`; a note under it names what arrived: `Description, checklists under Checklists, 2 comments, 2 labels, 1 member, 2 files.` Trello's description and checklists are Markdown, the comments are actions | 13px |
| **Sidebar, live** | the second line: the mark + `TR-12 · Editing cart.ts`, all `--faint` mono 12px | 12px |
| **Search** | the mark + key, the title, the connection's name on the right | 14px |
| **New task** | `It gets a card on` + the mark in brand colour + **Calculations** + `as it starts.` The word is `card` for a Trello board (choice 10) | 15px |
| **The mark, at its sizes** | 32px (picker), 20px (Trackers), 16px (Ticket group), 14px (header, Inbox), 12px (meta line). Brand colour above 14px where it names the tracker; the key's colour where it repeats | |
| **Not taken** (the board's last cell) | the brand colour on every Inbox row. A column of blue tiles competes with the Inbox's own colours and says nothing a one-colour mark doesn't | |

## Keyboard and reading

The mark is `role="img"` with the kind as its label when it stands alone (an Inbox row: `Trello, TR-12`); beside a word that already names it (`from Trello`, `Tracker: Trello`), `aria-hidden`. The status chip's icon is `aria-hidden` because the list's name is beside it.

## Data

Every ticket payload already carries its board; it adds the board's `connection` (`kind`, `name`) and, for Trello, the list's `name` and the card's `key` (`TR-12`). There is no sub-task count: `subIssues` is false for Trello, so no chip is drawn, not a disabled one.

## Copy (keys under `inbox.*`, `tasks.*`, `ticket.*`)

`tracker.aria` `{kind}, {key}` · `from.trello` `{key} · from Trello` · `open.trello` `Open in Trello` · `tracker.label` `Tracker` · `tracker.name.trello` `Trello` · `status.list` `a list` · `on.trello` `On Trello` · `on.moved` `Moved to {list}` · `on.wroteList` `wrote the list` · `on.comment` `Progress comment` · `on.posted` `posted` · `on.linked` `Linked the task` · `on.attachment` `attachment` · `got.meta` `{key} from Trello` · `got.trelloSummary` (above) · `newTask.cardOn` `It gets a card on` · `newTask.starts` `as it starts.`

## Tokens

`--faint` (keys and one-colour marks), `--teal` (the panel's key), Trello's mark's own `#1558BC` and white glyph. **No amber.**
