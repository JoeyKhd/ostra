# Target: ticket chips, with the tracker's mark

- **Pictures:** `ticket-chips` and `ticket-chips-light`: one board of the places a ticket shows, for `calculator` with a Linear team (`CALC`, Acme Linear) and a Jira project (`PROJ`, Globex Jira), and the alternative not taken.
- **Sources:** `html/chips.html`; `tkey` and `logo` in `html/tr.js`.
- **Builds on:** `../m2/inbox.md`, `../m2/task-ticket.md`, `../m9/ticket-context.md` (approved) as the live pages draw them (`inbox-view.tsx`, the task page, `ticket-icons.tsx`).
- **Feature:** F-008 (parity: a Jira ticket shows everywhere a Linear one does). **Status: approved 2026-11-23** ("yes to all", `README.md`).

## The rule

Every place a ticket shows says which tracker it's from, so `PROJ-12` (Jira) and `CALC-170` (Linear) read apart at a glance:

- **Brand colour** where the mark names the tracker once: a task's header, its Ticket group, New task's line.
- **One colour, the key's own `--faint`,** where it repeats down a list or sits in running text: Inbox rows, the sidebar's live tasks, the thread's meta lines, search results. The one-colour marks are Atlassian's own cut-outs for Jira and Trello, and Linear's and Notion's paths in `currentColor` (`README.md`, "The marks").
- The **word** is always there, or in the tooltip: `from Jira` in a header, `Jira · Globex Jira` in the panel, the tooltip on an Inbox row's mark.

## Places

| Place | What shows | Size |
|---|---|---|
| **Inbox row** | the mark before the key, in the key's colour (`--faint`); the key mono 13px. Tooltip on the mark: `Jira · Globex Jira`. A Jira parent's chip counts its sub-tasks (`list-tree` + `2`, tooltip `2 sub-tasks`); Linear's says `sub-issues` | 14px, 6px gap |
| **A task's header** | the eyebrow: the mark in brand colour, then mono `PROJ-12 · from Jira`; the chips row's status chip carries Jira's category square; the link reads `Open in Jira ↗` | 14px |
| **The Ticket group** (the panel) | `Key` (teal mono, as today); new `Tracker`: the mark in brand colour 16px, `Jira`, `--faint` `· Globex Jira`; `Status` with its category square (Jira) or its icon (Linear); new `Sub-tasks` / `Sub-issues`: count and `· 1 done`; then `Board`, `Synced` | 16px |
| **On Jira** (the group under it, today's `On Linear`) | the same rows, each with how it was done, 12.5px `--faint`: `Moved to In Progress · by Start progress`, `Progress comment`, `Linked the task · remote link` | |
| **What the agent got** | the meta line: `14:02 · ` + the mark in the meta's colour + `PROJ-12 from Jira`. Jira's description and comments arrive as ADF; the adapter turns them into the same markdown, so the message reads alike | 13px |
| **Sidebar, live** | the second line: the mark + `PROJ-12 · Editing cart.ts`, all `--faint` mono 12px | 12px |
| **Search** | the mark + key, the title, the connection's name on the right | 14px |
| **New task** | `It gets a ticket on` + the mark in brand colour + **Globex Calculator** + `as it starts.` (`../m10-gaps/prompt-tickets.md`'s line) | 15px |

**Not taken** (the board's last cell, for comparison): the brand colour on every Inbox row. A column of blue tiles and purple discs competes with the Inbox's own colours (the task marks, needs-you) and says nothing a one-colour mark doesn't (choice 9).

## Keyboard and reading

The mark is `role="img"` with the kind as its label when it stands alone (an Inbox row: `Jira, PROJ-12`); beside a word that already names it (`from Jira`, `Tracker: Jira`), `aria-hidden`.

## Data

Every ticket payload already carries its board; it adds the board's `connection` (`kind`, `name`). Sub-task counts come from the adapter's `ChildTicket`s (m6 ticket 02).

## Tokens

`--faint` (keys and one-colour marks), `--teal` (the panel's key, links), the marks' own colours, Jira's category squares. **No amber.**
