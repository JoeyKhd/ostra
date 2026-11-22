# Target: "Make a ticket for every prompt task" (a project's Boards page)

- **Pictures:** `prompt-tickets` and `prompt-tickets-light` (the page), `prompt-tickets-states` (every state of the setting, and the Detach dialog), `prompt-tickets-new-task` (the line New task gains), `prompt-tickets-phone` (390×844). Desktop: a 2880×1912 `.png` and a 1440×956 `.webp`; the phone: 780×1688 and 390×844.
- **Sources:** `html/boards.html`, `html/new-task.html`, `html/states.html?sheet=prompt`, `html/phone.html?scene=prompt`; the parts in `html/gaps.js` (`promptSetting`, `boardPanel`) and `html/gaps.css` (".pset").
- **Route (existing):** `/projects/[project-id]/boards` → `components/boards/boards-view.tsx`, grown. New task: `components/tasks/new-task-view.tsx`.
- **Feature:** F-097/c2 (Q31). API, built: `projects.setPromptTickets({ projectId, boardId | null })` (project admins, audited as `project.prompt-tickets-set`) and `projects.get`'s `promptTicketBoardId`.
- **Builds on:** `../m2/project-boards.md` (approved), redrawn in milestone 8's shell as the live page draws it; `../m9/new-task-attachments.md` (approved) for New task.
- **Status:** a proposal, 2026-11-22. Nothing is built from it until the maintainer approves.

## Purpose

A project can make a ticket for every task a member starts from a prompt, so the tracker stays the source of truth even for work that began in ostra. It's off by default. A project admin turns it on and, with several boards attached, picks the board the tickets go to. The admin should leave knowing, in one sentence, what happens to the next prompt task.

## Where it sits

On the Boards page, as a section of its own, **Prompt tasks**, between **Attached** and **Status mapping**. It's a project-wide setting that names one of the boards listed just above it, and members can read the Boards page (Settings' Ticket template tab is for admins only). The page's `Save mapping` doesn't save it: the switch and the board picker apply at once, as the per-board `Start from Linear` switch already does.

## Layout (CSS px at 1440×956)

The live page, unchanged above and below the new section: `PageFrame` with the 320px panel, the main column `max-width: 760px` (744px at 1440 with the double sidebar).

| Part | Size and style |
|---|---|
| Section head | `Section` title `Prompt tasks` (Plex Sans 600, 15px), 26px above it, as `Attached` and `Status mapping`. No count |
| The row | one block between hairlines (1px `--line` above and below), padding `13px 8px 14px`. Grid `30px 1fr`, 14px column gap |
| Switch | `Switch` (30×18), 2px from the top. On: `--teal` track, `--on-primary` knob. Off: `--surface` track, `--control-line` edge, `--text` knob |
| Label | `Make a ticket for every prompt task`, Plex Sans 500, 14.5px / 22px, `--text`. It's the switch's `<label>` |
| Explanation | 13.5px / 1.5, `--muted`, `max-width: 620px`, 2px under the label. The board's name in `--text` 500 |
| Board picker | only with two or more boards and the setting on: 10px under the explanation, `Board` (13.5px `--muted`) then a `Select` 240×30px: Lucide `square-kanban` 15px `--faint`, the team's name, ` · ` and the key in mono 13px `--muted`. Its items: every attached board whose connection is active, the same way |

The properties panel's `Board` group gains a last row, `Prompt tasks`: Lucide `ticket-plus` 14px `--muted` + `Get their tickets here` on the board that takes them, `–` (`--faint`) on any other.

## States and copy

| State | What shows |
|---|---|
| **Off** (the default) | switch off; `Off: a prompt task makes no ticket. A member can still use **Create ticket** on one.` |
| **On, one board** | switch on, no picker; `Each task a member starts from a prompt gets a ticket on **Calculator** as it starts. Refine tasks make theirs from their draft.` |
| **On, several boards** (the picture) | the same sentence, then the picker. Turning the switch on picks the board selected on the page (`?board=`), else the first in Attached, and saves it. Changing the picker saves at once |
| **No board attached** | switch off and disabled (45% opacity); `A ticket needs a board. Attach a team above, then turn it on.` With no Linear connection at all the page shows only its no-connection line, as today, and no section |
| **Saving** | the switch and picker disable until `setPromptTickets` answers (no spinner: it's quick) |
| **A failed save** | the switch and picker go back to what's saved; under the row, 13.5px `--red`, `role="alert"`, `triangle-alert` 14px: the server's message (`That isn't one of this project's boards, or its tracker connection isn't active.`, `Only a project admin changes which prompt tasks get a ticket`) |
| **Linear's connection isn't active** | the board keeps the setting, but no ticket is made until the connection is back (`promptTicketBoardInTx`). Switch on, picker disabled: `On, but the Linear connection isn't active, so prompt tasks get no ticket on **Calculator** until it is.` + teal `Reconnect Linear →` (`/organization/linear`, organization admins; others see no link). Needs the data below |
| **A member** | the page's existing note under the lede, `Only the project's admins change boards.` The switch shows its state, disabled; the picker is plain text (`square-kanban`, the name, the key in mono). The same sentences |
| **Detaching the board that takes them** | the Detach dialog gains a sentence: `Detach Calculator?` / `ostra stops polling CALC. Its tickets stay in the Inbox's history and its tasks keep their links, but no new task starts from it. Prompt tasks stop getting tickets: **Make a ticket for every prompt task** turns off.` / `Cancel`, `Detach`. Detaching any other board says nothing new |
| **Loading** | the section's row as one 48px `Skeleton`, as the mapping's rows |

Everything the admin changes is in the audit log (`project.prompt-tickets-set`, with the board). Turning it on makes no ticket for tasks already running: only starts after it.

### New task (`prompt-tickets-new-task`)

While the project's setting is on and a **Code** task is being started:
- **What happens next** gains a line after the attachments' line (or after the box's line when there are none): Lucide `ticket-plus` 15px `--muted`, `It gets a ticket on **Calculator** as it starts, linked to the task both ways.`
- The panel's **This task** group gains `Ticket` · `made on` (`--muted`) `CALC` (mono) `when it starts` (`--muted`).
- **Refine** shows neither: a refine task's ticket comes from its draft (F-097, milestone 5's refine). Off, or no `promptTicketBoardId`: neither.

## Data

- `projects.get` → `promptTicketBoardId` (built). It's `null` while the board's connection isn't active, so the **paused** state needs more: `boards.get` (the page's own query) adds `ticketsForPromptTasks: boolean` per board, which the row already has (`Board.ticketsForPromptTasks`). Without it, the page shows **Off** while the connection is down; recommended: add it (choice 5 in `README.md`).
- `projects.setPromptTickets({ projectId, boardId })` (built): `boardId: null` turns it off. The page invalidates `projects.get` and `boards.get` on success.
- New task reads `projects.get` → `promptTicketBoardId` and the board's name and key from `boards.get`.

## Keyboard

- `Tab` reaches the switch, then the picker; `Space` toggles the switch; the picker is Radix's `Select` (`Enter`/`Space` opens, arrows move, `Enter` picks, `Esc` closes).
- The switch is `role="switch"` with `aria-checked`, labelled by the label; the explanation is its `aria-describedby`. The picker's `aria-label` is `Board for prompt tasks' tickets`.
- A failed save's line is `role="alert"`; a save that succeeds announces nothing (the switch's own state changes).

## Components

`Switch` (`components/ui/switch.tsx`, teal on), `Select` (existing), `AlertDialog` (Detach, existing), `PropRow`, `Skeleton`. Icons, Lucide 0.460, stroke 1.75: `ticket-plus`, `square-kanban`, `chevron-down`, `triangle-alert`, `arrow-right`.

## Tokens

The panel's (`../../app-design.md`, both themes): `--teal` (the switch on, `Reconnect Linear →`), `--surface` / `--control-line` (the switch off, the picker), `--muted` (the explanation), `--text` (the label, the board's name), `--faint` (the panel's `–`), `--red` (a failed save). **No amber:** nothing here waits on anyone.

## Copy (new keys under `boards.promptTickets.*`)

`title` `Prompt tasks` · `label` `Make a ticket for every prompt task` · `on` `Each task a member starts from a prompt gets a ticket on {board} as it starts. Refine tasks make theirs from their draft.` · `off` `Off: a prompt task makes no ticket. A member can still use Create ticket on one.` · `none` `A ticket needs a board. Attach a team above, then turn it on.` · `paused` `On, but the Linear connection isn't active, so prompt tasks get no ticket on {board} until it is.` · `reconnect` `Reconnect Linear` · `board` `Board` · `boardAria` `Board for prompt tasks' tickets` · `panelKey` `Prompt tasks` · `panelHere` `Get their tickets here` · `detachMore` `Prompt tasks stop getting tickets: Make a ticket for every prompt task turns off.` New task: `newTask.next.ticket` `It gets a ticket on {board} as it starts, linked to the task both ways.` and `newTask.panel.ticket` / `newTask.panel.ticketValue`.

## Not in the pictures

- The phone's picker opens Radix's `Select` as on desktop; it isn't drawn open.
- The section on a Jira board (later): the same words, the board being a Jira project.
