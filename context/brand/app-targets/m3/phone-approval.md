# Target: answering an approval and a plan from Needs you, at phone width (`/needs-you`, under 640px)

> **Committed image:** `phone-approval.webp`, 980×778: both screens of one 2048×1360 picture, cropped to them with a margin and downscaled so each screen is **390 CSS px wide**. One image pixel is one CSS pixel. The left screen sits at x 24–414, the right one at x 564–954, both at y 12–766 (754 tall). Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), one generation, not retouched. References: the approved milestone 2 phone original (`m2/phone-inbox` and `m2/phone-task`'s shared 2048 picture), the approved milestone 1 original `m1/task.png` (for the approval's amber rule and the amber "Approve once"), `app-concepts/html/home-graphite.png`, and the Hinge logo. Prompt: `phone-approval.prompt.txt`.
- **Status:** a candidate target for milestone 3 (ticket 41), not yet approved.
- **Starts from** `../m2/phone-task.md`: the same top bar, page padding, hairline rows, bottom sheet and type scale. Where this file is silent on a phone rule (iOS zoom, safe areas, the drawer), that file holds.
- **Pairs with** the desktop targets `needs-you` (the page), `task-approval` (the approval card, its receipts and the question form) and `task-plan` (the plan, its editor and its receipt). **Where this file and those disagree on copy or data, theirs wins.** This file fixes how answering reflows under 640px.
- **Features:** F-075 (the needs-you moments, approve, answer and reopen, fully usable on a phone), F-026 (approvals), F-063 (plan first), F-036 (the panel's notification list). Data: `notifications.list(tab, cursor)`, `.markRead(ids)` and `.unreadCount` (ticket 36), `approvals.preview` and `approvals.answer`, `plans.answer` (ticket 35). Builders: ticket 44 (the page), ticket 43 (the approval and plan blocks it reuses).

## Purpose

A member's phone buzzes: a mail, a Linear notification or the panel's count says ostra waits on them. They open Needs you and want to unblock the agent without opening the task, in this order:
1. what waits, in which project, since when
2. exactly what they're approving: the command or the file, the rule that asked, and what "for this task" would allow from now on
3. one thumb-sized answer

An approval fits inline: it's a command and three buttons. A plan doesn't: it's a message and a list, and editing it needs room. So an approval opens **in the list** and a plan opens **in a bottom sheet** over it. A question opens in the same sheet as a plan (its form is `task-approval`'s).

## Layout (CSS px at 390 wide)

One column. The page scrolls; nothing is pinned (there's no composer here).

| Region | Size | Contents |
|---|---|---|
| Top bar | 44px, hairline under, padding `0 12px` | `menu` (opens the sidebar drawer), then `Needs you` in 13px 500 `--text` |
| Header | padding `20px 16px 0` | Title `Needs you`, Manrope 700 24px. Lede, 13px `--muted`: `{n} open across {p} projects · newest first` (`1 project` in the singular; `Nothing waits on you` at zero, with no `· newest first`) |
| Tabs | 36px, hairline under the row, 16px side margins | `Open` + its count (`--faint`), `Done`. The active tab: `--text` 500 with a 2px `--text` underline; the other `--muted` |
| Groups | full bleed | One per project, in the order of its newest item. A band 32px, `--surface`, padding `0 16px`: the 8px project square, the project's name 13px 600, its open count `--faint` |
| Items | padding `14px 16px 14px 14px`, hairline between items | A 2px `--amber` rule on the left, full height, 12px gap to the text (the `NeedsYou` block). Unread items keep the rule; read ones keep it too (they still wait), and lose the hand icon's fill only |

### An item, collapsed (the image's `CALC-150` and `BIL-88`), 64px

- **Line 1:** `hand` 14px `--amber` + `Needs you · {reason}` 12.5px 500 `--amber`. On the right, the age in mono 12px `--faint` (`11m`).
- **Line 2:** the key in mono 13px `--faint`, then the task's title in 14px `--text`, one line, ellipsis.
- **The action** on the right, vertically centred, `outline` 32px: the reason's verb (below). The whole item is a link to the task; the button is its own target, at least 44×32.

| Reason | Verb | What it does here |
|---|---|---|
| `approval` | none: the item opens inline (it's never collapsed while open, see below) | |
| `plan` | `Review plan` | Opens the plan sheet |
| `question` | `Answer` | Opens the question sheet (fields from `task-approval`) |
| every other reason (setup failed, stalled, spend cap, crashed, `ticket_closed`, a PR ready) | `Open task` | Goes to `/tasks/[id]`, where `m2/phone-task.md`'s needs-you block answers it |

### An approval, open (the image's `CALC-142`)

Open approvals are always expanded: answering one is the page's point, and two lines of command cost less than a tap.
1. Line 1 and line 2 as collapsed, the title 15px 500.
2. What it wants, 14px `--text`, from `approvals.preview`: `OpenCode wants to run a command:`, `… to edit a file:`, `… to reach the network:`, `… to call an MCP tool:`. A preset rule may name itself instead (`… to add a dependency:` for "Adding a dependency").
3. The subject in a code box: `--surface`, 1px `--line-2`, radius 6px, padding `10px 12px`, mono 13px, wrapping (never a sideways scroll; a long command breaks anywhere).
4. `Rule: {rule's name}` 12.5px `--muted`. A custom rule shows its own name.
5. **`Approve once`**, `amber`, full width, **44px**, `check` icon.
6. Two `outline` buttons side by side, 44px, 8px gap, 50/50: `Approve for this task`, `Deny`.
7. The pattern line, 12px `--faint`: `For this task allows {pattern} in {key}` with the pattern in mono `--muted`. The patterns are spec section 11, item 3: `pnpm add …, with any package` (the program and its first argument), the exact path for a file (`config/settings.json`), the host for a URL (`registry.npmjs.org`), the tool's name for MCP (`release-names.lookup`).
8. The audience line, 12px `--faint`: `Any member of {project} can answer. The first answer wins.`

Two open approvals on one task show as two items, the newer first.

### The plan sheet (the right screen)

The `Sheet` with the `bottom` side (`m2/phone-inbox.md`): `--side` background, 1px `--line-2` top border, radius 14px on top, a 36×4 grab handle, the list behind dimmed by a flat 55% black overlay. Height: its content, at most `90dvh`, scrolling inside; padding `12px 16px max(16px, env(safe-area-inset-bottom))`. Drag down, the overlay, or Escape closes it.
1. Key line: the key in mono 13px `--faint` + ` · {project}` `--muted`. On the right, teal `Open task` + `arrow-up-right` (a link to the task page).
2. Title, 18px 600 `--text`.
3. `hand` + `Needs you · plan` in `--amber` 13px 500, then ` · you're driving` in `--muted`.
4. A hairline, then the plan turn's last agent message as a thread message: the 28px round outlined `bot`, `OpenCode` 600 + `plan turn · 14:20` mono 12px `--faint`, the text 13.5px `--muted`, at most 4 lines with `Show more` (teal). It's agent output: rendered as untrusted markdown, as the thread does.
5. `Plan`, 13px 600, then one 40px row per entry, hairline between: the number in mono 12px `--faint` (24px column), the entry 14px `--text`, wrapping (the row grows, the number stays top-aligned). Code in an entry (`prorate()`, `src/billing/proration.ts`) in mono.
6. **`Approve plan`**, `amber`, full width, 44px, `check`.
7. Two `outline` buttons, 44px, 50/50: `pencil` `Edit and approve`, `message-square` `Ask for changes`.
8. A line, 12px `--faint` with `info`: `Only the driver answers a plan. The agent starts from the approved text.`

## States

| State | At phone width |
|---|---|
| Open, mixed reasons (the left screen) | As above. Viewing the page marks what's on screen read (`notifications.markRead`, after 1 second visible); the sidebar's amber count drops live |
| Answering, in flight | The pressed button shows `loader-circle` and the item's other buttons disable. Nothing else moves |
| Approved once | The item collapses in place to a receipt row for 4 seconds, then leaves `Open` for `Done`: `check` `--green` + `Approved once by you` 13px `--text`, the time mono `--faint`. The group's count drops; an emptied group leaves with it |
| Approved for this task | Receipt: `Approved for this task by you`, and under it 12px `--faint`: `Rule added: {pattern}` (mono) |
| Deny | Pressing `Deny` doesn't answer yet: the two buttons give way to a textarea (16px, 2 rows, placeholder `Why? The agent gets this (optional)`) and a row: `Cancel` (ghost) and `Deny` (`danger`, 44px). Receipt: `circle-x` `--red` + `Denied by you`, and the reason in `--muted` on the next line, quoted |
| Someone answered first | `approvals.answer` returns `CONFLICT`: the buttons go; a 12.5px `--muted` line with `info`: `Someone answered this first: approved once by Sam Rivera.` The item moves to `Done` on the next refresh |
| Expired (15 min, the turn cancelled) | The item stays in `Open` (spec section 4): line 1 reads `Needs you · approval, expired`, and a 12px `--faint` line above the buttons: `The turn stopped waiting. Answering reopens the task with your answer.` The buttons stay |
| Cancelled (a deny closed the session's other approvals) | Moves to `Done` with `Cancelled · the agent was denied another request` in `--faint` |
| Plan: approve | The sheet's buttons disable with the loader on `Approve plan`; the sheet closes on success, and the item becomes the receipt `Plan approved by you` in the list, then moves to `Done` |
| Plan: edit and approve | The plan's rows turn into one textarea per entry (16px, autosize), each with a `grip-vertical` handle and an `x` to remove; `+ Add a step` (teal) under them; a last field `A note for the agent (optional)`. The buttons become `Approve plan` (amber, full width) and `Cancel` (ghost). The sheet takes `90dvh` and scrolls; the buttons stay pinned at its bottom, above the keyboard (`visualViewport`) |
| Plan: ask for changes | One textarea (16px, 3 rows, placeholder `What should change?`, required) and `Send to the agent` (primary, full width) + `Cancel`. Receipt: `Changes asked by you`; the item leaves until the next plan raises a new one |
| Plan, not the driver | The amber line reads `Needs you · plan` then ` · Sam Rivera is driving`; the three buttons give way to one `outline` full-width `Take over to answer`, and the info line `Only the driver answers a plan.` (Normally a plan's item reaches only the driver; this shows when another member opens it from the task's link) |
| Question | The same sheet: the question's text, its fields (`task-approval`), `Send answer` (amber). A member who isn't the driver gets `Take over to answer`, as the plan |
| Done tab | Rows 56px, no amber rule, newest first, grouped by day (`Today`, `Yesterday`, a date): the receipt's icon, the key mono `--faint` and the title, and the receipt line `--muted` (`Approved for this task by Sam Rivera · 14:31`) |
| Empty (Open) | No groups. Centred, 48px from the tabs: the Deep water illustration (`../../files/web/sign-in-illustration.webp`) cropped to 358×160 with radius 10px, then `Nothing waits on you` 15px 500 and `New approvals, plans and questions show here and on Home.` 13px `--muted` |
| Loading | 2 group bands and 3 item `Skeleton`s (64px each) |
| Error | A `--red` line with `role="alert"`: `Needs you didn't load.` and `Try again` (teal) |

## Components

From the repo: `PageFrame`, `NeedsYou` (the amber rule block; its `actions` become a vertical stack under 640px, see below), `Button` (`amber`, `outline`, `danger`, `ghost`, `link`), `Sheet`, `Skeleton`, the thread's message renderer for the plan turn's message. New: the `bottom` side of `Sheet` (if milestone 2's ticket hasn't added it), `Tabs` (underline), `Textarea` with autosize. Icons, Lucide: `menu`, `hand`, `check`, `circle-x`, `pencil`, `message-square`, `info`, `bot`, `arrow-up-right`, `loader-circle`, `grip-vertical`, `x`, `plus`.

## Tokens

As `../m1/task.md` and `../m2/phone-task.md`. Amber is only the needs-you lines, the left rules, the hand icons and the two amber buttons (`Approve once`, `Approve plan`), on `--ink` text. Red is only the deny receipt and the `Deny` that confirms. Green is only the approved receipts' `check`. Teal is only links (`Open task`, `Show more`, `+ Add a step`, `Try again`).

## Differences from the current code

1. **There's no Needs you page**, and no `Needs you` row in the sidebar (`components/shell/sidebar.tsx` has Home, Projects and Organization). Both are new (ticket 44): the row under Home, with its amber count from `notifications.unreadCount`.
2. **`NeedsYou`** lays its `actions` out as `flex-wrap` of 28px buttons (`Button` `default` size). Under 640px they must be 44px: `Approve once` full width, then the other two 50/50. Add a `stack` layout (or a size the block passes down) rather than restyling per page.
3. **`Button`** has no 44px size (`xl` is 36px). Add one for phone actions (`touch`: `h-11 px-4 text-body`), used by every needs-you answer under 640px.
4. **`Sheet`** has `left` and `right` sides only. The plan sheet needs `bottom` (shared with `m2/phone-inbox`).
5. **Home's Needs you rows** (`components/home/home-sections.tsx`) show one amber button per task and link to the task. The page's items answer inline instead; Home keeps its rows, and on a phone its `Approve` opens this page at the item (`/needs-you#{itemId}`) rather than answering blind from one line.

## Wrong in the image (build from this file)

- **The screens are 390×754, not 844** (as in milestone 2's phone pair). Positions from the top hold.
- **`Ask for changes`** has a laptop icon. Use `message-square`.
- **The pattern line** sets `pnpm add …` in Plex Sans. Set the pattern in mono `--muted`, as item 7 says. The image also merges it and the audience line into one block; they're two lines, with the pattern first.
- **`Needs you · setup failed`** has no hand icon. Every item's line 1 has it.
- **The amber rule** of the open approval stops above the audience line. It runs the item's full height.
- **The items' buttons** `Open task` and `Review plan` are about 28px tall. Build 32px, with a 44px tap area.
- **The plan sheet's** key line is 13px and the title about 17px; build 13px and 18px. Its message text is 13.5px `--muted` as drawn.
- **The plan's numbers** sit in a column narrower than 24px, and the rows are about 34px. Build 24px and 40px.
- **The tabs' underline** spans `Open 5` with extra padding; it spans the label and its count only.
- **No `Done` content, deny, edit or receipt state is drawn.** Build them from the States table.
- **Demo data:** Acme Corp's projects, `CALC-142`, `CALC-150`, `BIL-88`, the ages, `14:20`, the command and the plan's four entries are fixtures (the same as `../m1/home`'s Needs you rows).
