# Target: the task page for a ticket task

> **Committed image:** `task-ticket.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

`task-ticket.webp` is the target for `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` when the task came from a ticket (`source: "ticket"`). The page is milestone 1's task page (`../m1/task.md`), which still holds for everything this file doesn't change: the sidebar, the top bar, the thread's row grid, the plan, the tool rows, the approval block and the composer. This file adds the ticket: its header, the context the agent got, the sync state on Linear, the PRs per repo and the box's state. Where the picture and this file disagree, this file wins.

- **Image:** `task-ticket.webp`. Generated with Higgsfield `gpt_image_2_6` (3:2, 2k, high), as an edit of a first generation, with the approved `../m1/task` original, `home-graphite.png` and the Hinge logo as references. Prompt: `task-ticket.prompt.txt` (the edit, then the full prompt of the first generation).
- **State shown:** ticket `CALC-174` from Linear, one turn done, two PRs open (one per repo), the session idle on a warm box that stops in 11 minutes, the task in review. One ticket write failed (`Linked PR #91`), so "Retry sync" shows. The viewer is Alex Kim; Sam Rivera drives.
- **Features:** F-064 ticket context, F-031 ticket sync, F-096 idle (the box's state), F-097 "Create ticket" (the prompt-task variant, below). Ticket 36 builds it; ticket 30 serves the data on `tasks.get`.

## Purpose

A member opens a task that came from a ticket and sees, without leaving the page: which ticket it is and where it stands on Linear, exactly what the agent was given, whether ostra's writes to the ticket landed (and a way to retry the ones that didn't), each repo's PR and its state, and whether the box is still warm. The thread stays what happened, in order; the ticket's facts that don't change turn to turn live in the properties panel.

## Layout (1440 × 956 CSS px)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px | The shared sidebar (`components/shell/sidebar.tsx`), `calculator › Tasks` selected. Build only the routes that exist; never copy the picture's rows. |
| Top bar | 44px, `padding: 0 18px` | Crumbs `calculator › Tasks › CALC-174`. Right: copy-link ghost icon button, then one outline `PR #<n>` button per open or merged PR, each with `git-pull-request`. **No Stop on a task in review** (ticket 36). |
| Thread column | `1fr`, `padding: 28px 40px 20px` | Header (key line, title, status line, ticket strip, context row), one hairline, the thread (scrolls), the composer (pinned). |
| Properties | 300px, left hairline, `padding: 20px 18px` | Four groups: Properties, Ticket, On Linear, Code. The panel scrolls on its own when it's taller than the viewport. |

### Header (not scrolling)

1. **Key line:** `CALC-174 · from Linear`, IBM Plex Mono 12px `--faint` (milestone 1's change, the tracker's name).
2. **Title:** the ticket's title as the task holds it, Manrope 700 24px/1.25, -0.015em.
3. **Status line,** 13px: dot + state text (`--text`, 500), ` · ` `--faint`, the box's phrase in `--muted`, ` · `, `Started {age} ago on` `--muted` + runner name mono `--faint`. Idle phrase: **new** `Idle, the box stops in {minutes} min`. No amber unless the task needs you.
4. **Ticket strip,** 12px below the status line, one row, 8px gaps, no background:
   - The ticket's status on Linear as a `.chip` (22px, 1px `--line-2`, `--muted` 12px text, radius 6px) with a 12px status-category glyph in `--muted`: `circle-dashed` open, `contrast` (the half-filled circle in the picture) started, `circle-check` done, `circle-x` cancelled. Neutral, never Linear's own colours.
   - Each label as a `.chip`, at most 3, then `+{n}`.
   - Priority, when the ticket has one: ` · ` + `High priority` (`--faint` dot, `--muted` text). Words: `Urgent`, `High`, `Medium`, `Low` + ` priority`; nothing for none.
   - `Open in Linear` + `arrow-up-right` 12px, teal, 12.5px, `target="_blank" rel="noopener noreferrer"`, through `safeHref`.
5. **Context row** (F-064), 8px below the strip, 32px tall: `chevron-right` 14px `--muted` (rotates 90° open), `What the agent got` 13px `--text` 500, then 12px `--faint` the summary: `title, description, {n} comment(s), {n} label(s), {n} image(s) · rendered with the project's template` (or `· rendered with the built-in template`). Collapsed by default. Open, it shows below the row, indented 22px:
   - The rendered first prompt as a `.code` block (`--surface`, 1px `--line`, radius 8px, IBM Plex Mono 12px/1.6, `max-height: 320px`, scroll), shown as text, never as HTML.
   - Under it, the ticket's files: one 26px row each, `image` (or `file-text` for a PDF) 13px `--muted`, the workspace path mono 12px `--text`, faint mono size. A file that wasn't fetched: `triangle-alert` `--red` + `{name}: not fetched ({reason})`.
6. One hairline (`--line`) 16px below the context row.

### Thread: what this screen adds

Milestone 1's rows hold (`../m1/task.md`, "Thread"). Rows that belong to a turn (tool rows, pushes, work saved, PRs) sit in the turn's tool grid: 24px icon column, verb, mono subject, inline result. Rows between turns sit at message level: the icon 14px centred in the 40px gutter, **no circle**, text in the content column.

| Row | Level | Icon | Copy |
|---|---|---|---|
| `ticket.files_ready` | message, before the first agent message | `image` | **new** `Ticket files ready` + mono `--faint` paths, comma-separated; more than 2: the first, then `+{n} more` |
| a file skipped | under that row | `triangle-alert` `--red` | **new** `{path}: not written ({reason})` |
| `session.saved` | turn | `archive` | **new** `Work saved after turn {n}` + mono `--faint` `archive {size} · hidden ref {sha7}` (all variants in `task-reopen.md`) |
| PR opened, one repo | turn | `git-pull-request` | `Opened a pull request` green + teal `#483` + `--muted` title (milestone 1) |
| PR opened, a task with several repos | turn | `git-pull-request` | the same + `--muted` `in {owner/repo}` in place of the title on every repo but the first |
| the session went idle | message | `moon` | **new** `The session is idle.` |

### Composer

On a warm idle session the composer sends the next turn (`tasks.send`). One primary `Send`; no `Interrupt and send` (no turn runs).

| Condition | Placeholder | Hint (12px `--faint`, `info` 13px) | Buttons |
|---|---|---|---|
| idle session on a warm box | `Message the agent…` | **new** `The session is idle in the same box. Send starts the next turn.` | `Send` |
| a turn running | as milestone 1 | as milestone 1 | `Interrupt and send`, `Send` |
| box stopped or released, task stopped, in review, merged, done or needing you | see `task-reopen.md` | | `Reopen` |

### Properties panel

Milestone 1's rules: group labels 11px 500 `--faint`; `.row2` rows, 84px key column, 28px min height, 12.5px; no icons in values; groups split by `.sep`.

| Group | Row | Value in the image | Source (ticket 30's `tasks.get`) |
|---|---|---|---|
| Properties | Status | green dot + `In review` | `task.state` |
| | Driver | 18px avatar + name (+ teal `Take over` when allowed) | milestone 1 |
| | Agent, Model | `OpenCode`, `Claude Sonnet 5.5` | the session |
| | Runner | mono name, chips `Personal` `host` on the next line | milestone 1 |
| | Box | **new** `Idle · stops in 11 min` | the box's state |
| | Tokens | mono `96k in · 14k out` | milestone 1 |
| | Spend | **new** mono `$0.84` + `--muted` ` of $25.00` | spend so far against the cap |
| | Time | mono `42 min` (not in the image: keep it, below Spend) | milestone 1 |
| Ticket | Key | teal mono `CALC-174`, links to Linear | the ticket |
| | Status | `In Review` (the tracker's status name, as Linear spells it) | the cache |
| | Board | `Calculator` (the board's name) | the board |
| | Synced | mono `--muted` `40 s ago` | the cache's age |
| On Linear | one row per ticket write, step left (`--text` 12.5px), state right | see "Sync steps" below | each `TicketWrite` |
| | `Retry sync` | teal 12.5px text button, under the list, only while a write has failed | `tasks.retrySync` |
| Code | Branch | mono, truncated with the full name in `title` | `repo.branchName` (one branch name for every repo) |
| | one row per repo | mono repo name (no owner when every repo shares one) left; right: teal `#<n>` + `--muted` ` · open` | `repo.pr` |

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. **New** strings are marked.

### The box (`taskPage.box.*`, **new**)

| Box state | Properties `Box` | Status-line phrase |
|---|---|---|
| running | `Running` (`Running · fresh box` right after a reopen onto a new box) | the activity, as milestone 1 |
| idle | `Idle · stops in {minutes} min` (`under a minute` below 1) | `Idle, the box stops in {minutes} min` |
| stopped | `Stopped` | `The box stopped {age} ago` |
| released | `Released` | `The box was released {age} ago` |
| none yet | `--faint` `Not picked up yet` | none |

### Spend (`taskPage.spend*`, **new**)

- Priced model: mono `$0.84` + `--muted` ` of $25.00`.
- No known price (spec section 11, item 8): mono `1.2M` + `--muted` ` of 10M tokens`, and under the row a 12px `--faint` line `Counted in tokens: this model has no price.`
- At or over the cap: screen 7's target (limits) owns it.

### Sync steps (`taskPage.sync.*`, **new**)

One row per `TicketWrite`, in the order they were made. Step text by kind:

| Kind | Step |
|---|---|
| `move` to started | `Moved to {status}` (the mapped status's name, `In Progress`) |
| `comment` | `Progress comment` |
| `comment_update` | folded into the `Progress comment` row; its state becomes `edited {age} ago` |
| `link_task` | `Linked the task` |
| `link_pr` | `Linked PR #{n}` |
| `move` to in review / done | `Moved to {status}` |
| `create` (a prompt task) | `Created {key}` |
| done left to Linear's GitHub integration (`doneBy: "integration"`) | `Moved to Done` with state `--muted` `by Linear's GitHub integration`, once the ticket reads done |

| State | Right-hand text |
|---|---|
| `pending` | `--faint` `pending` |
| `done` | `--green` `done` (the progress comment: `--muted` `posted` / `edited {age} ago`) |
| `failed` | `--red` `failed`; the row's `title` holds the error words (IDs and words only, never content) |
| retrying | `--faint` `retrying…`, and `Retry sync` reads `Retrying…`, disabled |

No ticket writes yet (the task is queued): the group shows one `--faint` line, `Nothing written to Linear yet.`

### Ticket group

- Normal: Key, Status, Board, Synced.
- The ticket was removed or archived on Linear: Status `--faint` `Removed from Linear`; the strip's chip reads the same; `Open in Linear` stays.
- The connection is broken (token revoked): Synced `--red` `Not syncing: the Linear connection needs an admin`, linking to the organization's Linear page (screen 1).

### A prompt task (F-097)

The page is milestone 1's prompt-task page (`CALC-175 · from a prompt`, no strip, no context row). The properties panel gets the Ticket group with one row: `Ticket` `--faint` `None`, and, when the project has a board, a teal `Create ticket` text button beside it. Pressed: `Creating…`, then the group becomes the normal Ticket group and the header gains the strip. With several boards, `Create ticket` opens a `DropdownMenu` of the boards' names. Failure: a `--red` 12px line under the row with the error.

### PR states (`taskPage.prState.*`, **new**)

`open`, `draft`, `merged` (`--green` word), `closed` (`--muted` `closed unmerged`). The top bar shows one button per PR in every state but `closed`.

### Page states

Milestone 1's loading and error states hold. While the ticket's context is being fetched (`ticket.fetch-context`), the context row's summary reads `--faint` `Fetching the ticket…`, and the strip shows what the cache has.

## Tokens and components

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

Tokens: `app-concepts/html/graphite.css`, as `../m1/task.md` lists them. No new tokens. Amber stays off this page unless the task needs you.

| Part | Component |
|---|---|
| Ticket strip chips | `Badge variant="outline"` styled as `.chip` |
| `Open in Linear` | `Button variant="link"` rendered as `<a>` |
| Context row | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`; the prompt in a `ScrollArea` inside a `.code` block |
| Properties groups | the existing `PropGroup` / `PropRow` (`components/shell/page-frame.tsx`), `Separator` |
| Sync list | plain rows (a `ul`), `Button variant="link" size="sm"` for `Retry sync` |
| PR buttons | `buttonVariants({ variant: "outline" })` on `<a>` |
| Create ticket | `Button variant="link"`, `DropdownMenu` for several boards |
| Box countdown | text, re-rendered once a minute from `idleSince` and the idle setting (no client timer per second) |

`components/ui/` holds only `button`, `field`, `input`, `label`, `sheet`, `status` and `switch` today: `badge`, `collapsible`, `dropdown-menu`, `scroll-area` and `separator` are added through the shadcn CLI when ticket 36 needs them.

## Differences from the current code

1. **Key line** (`task-view.tsx`): `from a ticket` → `from Linear` (milestone 1's change; the tracker's name from the connection).
2. **New header rows:** the ticket strip and the context row, from `tasks.get`'s new `ticket` and context fields. Neither exists.
3. **Status line:** adds the box phrase and `Started {age} ago on {runner}`; the reconnecting text loses `text-amber` (milestone 1's spec: `--muted`).
4. **Top bar:** Stop shows on a task in review today (`data.capabilities.stop && !stopped`); hide it for `in_review`, `merged` and `done`. Add the copy-link ghost button.
5. **Properties:** add Agent, Model, Box, Spend, Time; remove the icons in values (`LaptopIcon`, `ServerIcon`, `GitBranchIcon`, `GitPullRequestIcon`); add the Ticket and On Linear groups.
6. **Code group:** today one Repo/Branch/PR trio per repo; the target shows the branch once and one row per repo with its PR and state.
7. **Thread:** `ticket.files_ready` and `session.saved` have no renderer (they'd show as unsupported); the PR row names the repo when there are several; `The session is idle.` is new.
8. **Composer hint:** today one fixed string (`task.composer.hint`); it becomes per state (idle, running, reopen).

## Wrong in the image

| In the image | Build |
|---|---|
| `PR #91` in the top bar with a square (Stop) icon | `git-pull-request`, like `PR #483` |
| Properties `Status` reads `In Review` | `In review` (the task's state, `taskState.inReview`); `In Review` is only Linear's status name in the Ticket group and the strip |
| `−6` drawn as a hyphen | U+2212, as `renderers.tsx` does |
| `Ticket files ready` with its icon in a round outlined circle | message-level row: icon in the gutter, no circle |
| Ticket strip chips 26px tall | 22px `.chip` |
| No `Time` row | keep milestone 1's `Time` row after Spend |
| Sidebar rows (Needs you, My tasks, Automations, Memory, Repos, Runner pools, Agent profiles, Insights, …) | only the routes that exist, from the shared sidebar |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg` (`/brand/ostra-mark.svg`), 20px |
| `CALC-174`, `alex-laptop`, `$0.84`, `96k in · 14k out`, `#483`, `#91`, names, ages | demo data, not copy |
