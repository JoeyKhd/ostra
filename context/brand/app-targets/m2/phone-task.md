# Target: a ticket task at phone width (`/tasks/[task-id]`, under 640px)

> **Committed image:** `phone-task.webp`, 390×756: the right screen of the same 2048×1360 picture as `phone-inbox.webp`, cropped and downscaled to its CSS width, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), the same single generation as `phone-inbox.webp`. References: the approved milestone 1 originals `task.png` and `project.png`, `app-concepts/html/home-graphite.png`, and the Hinge logo. Prompt: `phone-task.prompt.txt` (identical to `phone-inbox.prompt.txt`: one prompt drew both screens). This screen was not retouched.
- **Status:** a candidate target for milestone 2, not yet approved by the maintainer (ticket 32).
- **Pairs with screen 5** (the task page for a ticket task, at desktop width) and screens 6 and 7 (reopening, limits). Those targets set the desktop layout, the exact sync-step copy and the thread's markers. **Where this file and screen 5's disagree on copy or data, screen 5's wins.** This file only fixes how the page reflows under 640px.
- **Features:** F-075 (responsive panel: the needs-you moments, approve, answer and reopen, fully usable on a phone), F-064 and F-031 (the ticket, its context, its sync), F-032 (the composer reopens or sends). Data: `tasks.get` with the ticket, sync and per-repo PR fields from ticket 30, and the event log's new markers from ticket 36. Builder: ticket 36.

## Purpose

A member who opens a ticket task on a phone, usually from a Linear notification or the Inbox, needs four things, in this order:
1. what state it's in
2. that Linear is in step (status, PR linked)
3. the PR
4. a way to send the next message or reopen it

The thread is history. So on a phone the ticket, its sync and its PRs come first, above the thread, and the composer is pinned to the bottom, where the thumb is.

## Layout (CSS px at 390 wide)

One column. The page scrolls as a whole, and only the composer is fixed.

| Region | Size | Contents |
|---|---|---|
| Top bar | 44px, hairline under, padding `0 12px` | The `menu` button, then the last crumb, the ticket key in **IBM Plex Mono** 13px 500 `--text` (`CALC-161`). On the right, the PR as an outline button, 30px: `git-pull-request` + `PR #483`. With several PRs it's one button, `PRs · 2`, that opens a bottom `Sheet` listing them. `Stop` moves into the composer's menu on a phone (below); it's not in the bar |
| Page | padding `20px 16px`, `padding-bottom` = the composer's height + 16px | Header, Ticket, Sync on Linear, Pull requests, the thread |
| Composer | fixed to the bottom, 16px side margins, `bottom: max(12px, env(safe-area-inset-bottom))` | The milestone 1 composer, reflowed |

### Header

1. Key line, mono 12px `--faint`: `CALC-161 · from Linear`.
2. Title, Manrope 700 **24px** (`page-title`), wrapping.
3. Status line, 13px: the state's mark (`git-pull-request` `--muted` for in review; the dot otherwise) + the state in `--text` weight 500, then ` · ` and the box's state in `--muted`: `idle, stops in 11 min` / `running` / `stopped` / `released`.
4. A needs-you item, when there is one (screens 6 and 7), sits right here under the status line. It has milestone 1's amber left rule, its text, and its action as a **full-width 44px** button. This is the one place amber appears.

### Ticket (a section: a title line, then rows; no box)

`h2` `Ticket` (13px, 600), rows **40px**, hairline under each:
- The status-type icon (`inbox.md`, the ticket icon set) + `{status} on Linear` in `--text`. On the right, teal `Open in Linear` + `arrow-up-right`.
- `chevron-right` + `What the agent got`. On the right, `--faint` 12px: `title, description, 1 comment, 2 labels` (and `, 1 image` when there are any). Tapping it expands the rendered context under the row, as untrusted markdown in a `.code`-style block (`--surface`, 1px `--line`, radius 8px, max-height 50dvh, scrolls), with the ticket's files listed by name (mono). The chevron turns to `chevron-down`.

### Sync on Linear

`h2` `Sync on Linear`, then one 40px row per step:
- **Done:** a 15px `circle-check` in `--green`, then the step and what happened (`Started · moved to In Progress`), and the time in mono 12px `--faint` on the right.
- **Pending:** a `circle` in `--faint`, with the text in `--muted`.
- **Failed:** a `circle-x` in `--red`, the error's short reason, and a teal `Retry sync` on the right (ticket 36).

Wrapping lines are allowed: the row grows and keeps its icon top-aligned. The steps and their copy come from screen 5's target.

### Pull requests

`h2` `Pull requests`. One 40px row per repo the task changed:
- `git-pull-request` (open), `git-merge` (merged) or `git-pull-request-closed` (closed unmerged), 15px `--muted`
- the repo in mono 13px `--text`, then the PR number in teal mono as a link
- on the right, the state in `--muted`: `open`, `merged`, `closed`

A repo without a PR yet shows `None yet` in `--faint`.

### Thread

Milestone 1's thread (`../m1/task.md`, "Thread"), 14px text on a phone, with its 28px icon gutter. It's separated from Pull requests by a hairline 16px above. It starts with the newest turns, with milestone 1's "load earlier". The new markers (ticket 36) render as 28px system rows: an `info` icon, `--muted` text (ellipsis on one line, the full text on tap), and the time in mono on the right. For example `Work saved · the hidden ref and the session archive, 2.1 MB`.

### Composer (pinned)

One box: `--surface`, 1px `--line-2`, radius 10px, padding `12px 14px 10px`, `--bg` behind it to the screen's bottom edge.
- **Textarea:** 1 row, growing to 5. Placeholder `Message the agent…`. Its font is **16px** under 640px, not the image's 14px: iOS zooms the page on focusing any field set below 16px.
- **Bottom row:** the hint at 12px `--faint` with `info`, truncating. On the right, the primary button, 36px tall: `arrow-up` + its label:
  - `Send` on a warm idle session (`tasks.send`). Hint: `Send starts its next turn.`
  - `Reopen` on a stopped, merged or in-review task without a warm session, or one that needs you (`tasks.reopen`). Hint: `Reopening restores the session on a box.`
  - While a turn runs: `Send`, with `Interrupt and send` moved into a `⋯` menu button (32px ghost) left of it, beside `Stop`.
- A refusal shows as a `--red` line above the box, with `role="alert"`.

### What leaves the page at this width

The desktop properties panel (Driver, Agent, Model, Runner, Tokens, Context, Time, the Changes list) doesn't stack under the thread, where nobody would reach it. A last row in the Ticket section, `sliders-horizontal` + `Details` with `chevron-right`, opens it as a bottom `Sheet` (`phone-inbox.md`'s bottom side). The image doesn't show this row.

## States

| State | At phone width |
|---|---|
| In review, idle (the image) | As above; composer `Send` |
| Running | Status line `Running` with the green dot and the activity (`Editing src/history/panel.tsx`, one line, ellipsis); composer `Send` + `⋯` (Interrupt and send, Stop) |
| Needs you (screens 6 and 7: stalled, maximum duration, spend cap, crashed, restore conflict) | The amber item under the status line, its action full width |
| Stopped, released | Status `Stopped` (`square`, `--faint`) · `released`; composer `Reopen` |
| Prompt task (no ticket) | No Ticket or Sync sections; Pull requests stays. `Create ticket` (outline, full width, 40px) under the status line when the project has a board (F-097, ticket 36) |
| Sync failed | That step's `circle-x` row with `Retry sync` |
| Loading | Header `Skeleton`s; the three sections as 2 skeleton rows each; the composer disabled |

## Components

From the repo: `PageFrame`, `Status`, `Button`, the task thread and composer (`task/task-thread.tsx`), and `Sheet` with the new `bottom` side. New: `Collapsible` (What the agent got), `DropdownMenu` (the `⋯` menu). Icons, Lucide: `menu`, `git-pull-request`, `git-pull-request-closed`, `git-merge`, `arrow-up-right`, `chevron-right`, `chevron-down`, `circle-check`, `circle`, `circle-x`, `info`, `bot`, `arrow-up`, `ellipsis`, `square`, `sliders-horizontal`, and the ticket status icons from `inbox.md`.

## Tokens

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

As `inbox.md` and `../m1/task.md`. On the phone, green is only the done sync steps and a Running dot, always with words. Amber is only a needs-you item. Teal is only links (`Open in Linear`, `#483`, `Retry sync`).

## Differences from the current code (`components/tasks/task-view.tsx`, `task/task-thread.tsx`)

1. **The top bar** shows every PR as its own button plus `Stop`. On a phone: one PR button (or `PRs · n`), and `Stop` moves into the composer's `⋯` menu.
2. **The crumb** `data.key` renders in Plex Sans. On a phone, set the ticket key in mono.
3. **No Ticket, Sync on Linear or Pull requests sections exist.** They're new (ticket 36). On a phone they stack under the header, in this order.
4. **The properties panel** stacks under the thread today (`PageFrame`'s `border-t` aside), out of reach. On a phone, hide it behind the `Details` row and its sheet.
5. **The composer** isn't pinned on a phone today, and its textarea is 13px with 2 rows. Pin it, make it 16px with 1 row growing, and give it the `Send`/`Reopen` label and hint logic.
6. **The status line** shows `reconnecting` in amber. That's against "amber only for needs you": make it `--muted` with a `loader-circle` (on every width).

## Wrong in the image (build from this file)

- **The screen is 390×756, not 844** (as `phone-inbox.webp`). Positions from the top hold.
- **The ticket status icon** beside `In Review on Linear` is drawn as a clock. Use the `started` icon from the ticket icon set.
- **The rows** are about 34–36px. Build 40px.
- **The title** is about 22px. Build 24px.
- **The composer's text** is 14px. Build 16px on a phone (iOS zoom). The composer is about 100px tall; with 1 row it's about 84px.
- **There's no `Details` row,** and no `⋯` menu (the image's task is idle, so the menu wouldn't show anyway). Add `Details` as specified.
- **`Done · when the PR merges, by Linear's GitHub integration`** is this target's wording. Screen 5's step copy wins.
- **Demo data:** CALC-161, PR #483, the times and the 2.1 MB archive are fixtures.
