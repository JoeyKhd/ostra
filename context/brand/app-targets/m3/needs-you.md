# Target: Needs you (`/needs-you`)

> **Committed image:** `needs-you.webp`, downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. References: the approved milestone 1 original `home.png`, `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `needs-you.prompt.txt`.
- **Status:** a candidate target for milestone 3, not yet approved by the maintainer (ticket 41).
- **Starts from:** `../m1/home`: its sidebar, top bar, heading, 40px hairline rows, the Needs you section's column grid and buttons, and the 300px right panel.
- **State shown:** Alex Kim's Open tab: nine open notifications in four projects, six unread. The newest, an approval in `calculator`, is expanded with its inline answer.
- **Features:** F-036 (the panel channel: the notification list with unread state), F-062 (needs you across the organization), F-026 (answering an approval), F-063 and F-024 (answering a plan and a question, described below). Data, from ticket 36: `notifications.list({ tab, cursor })`, `notifications.markRead(ids)`, `notifications.unreadCount`; answers through ticket 35's `approvals.answer`, the plan and question answers; the member's choices from ticket 37. Builder: ticket 44.

## Purpose

The panel's own notification channel. Every needs-you moment that reached this member lands here: approvals, questions, plans, PRs ready, stalls, crashes, closed tickets. Home shows the five newest needs-you items; this page is the whole list, with what the member has and hasn't seen. A member opens it from the sidebar's count, or from a mail's or ticket comment's link, and works down it: answer what can be answered in place, open the task for the rest. Answered items move to Done, so the Open tab is a list that empties.

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, the shared shell | Build it from `components/shell/sidebar.tsx`, never from the picture. **New row** `Needs you` (`hand` icon) under Home, selected here, with the amber count pill: `notifications.openCount`, hidden at 0. *Changed 2026-11-20: the pill counts what waits on the member, the same number as Home's total and the Open tab's count (`domain-model.md`, "An item never outlives its reason"). It was the unread notifications, which could count what no longer waited and miss what no notification reached.* `My tasks` follows when it exists |
| Top bar | 44px, hairline under | Crumbs `Acme Corp › Needs you`. Right: `Mark all as read`, `Button variant="outline"` with `check-check`, shown only on the Open tab while something is unread |
| Main column | `1fr`, padding `28px 40px` | Title, lede, tabs, the grouped list |
| Properties panel | 300px, `border-left: 1px var(--line)`, padding `20px 18px` | Where these notifications reach the member |

### Main column, top to bottom

1. **Title** `Needs you` (`PageHeading`: Manrope 700 24px, −0.015em).
2. **Lede**, 13.5px `--muted`: `What waits on you across your projects. {n} unread.` With nothing unread: `What waits on you across your projects.`
3. **Tabs**, 16px under the lede: underline tabs, 32px tall, 13px weight 500, 20px apart, a 1px `--line` rule under the whole row.
   - `Open` + its count in mono 12px `--faint` (everything that waits on the member, read or not: Home's total). Selected: `--text` with a 2px `--text` underline on the tab.
   - `Done`, no count. Unselected: `--muted`.
   - The tab lives in the URL (`?tab=done`).
4. **The list**, 16px under the tabs. **Grouped by project**, each group 12px under the last:
   - **Group band**, 30px: `--surface` fill, radius 6px, padding `0 10px`. The 8px project square (`projectColour(project.id)`), the name 13px weight 600 `--text`, then the group's count in mono 12px `--faint`. The name links to the project.
   - **Rows**, 40px, a 1px `--line` hairline under each, no boxes. **One grid for every row** on the page:

| Column | Width | Contents |
|---|---|---|
| Unread | 14px | A 6px `--text` dot when unread (`aria-label="Unread"`); empty when read |
| Key | 80px | The ticket key or the task's short ID, mono 12px `--faint` |
| Title | `minmax(0,1fr)` | The task's title, 13px, one line, ellipsis. Unread: `--text` weight 500. Read: `--muted` weight 400 |
| Reason | 300px | Home's reason line (`home-words.ts`, `reasonParts`), 12.5px `--muted`, commands and paths in mono `--text`, ellipsis with the full line in a `Tooltip` |
| Age | 44px, right | Time since the moment, mono 12px `--faint` (`4m`, `2h`, `1d`) |
| Action | 112px, right | One `Button variant="outline"`, 26px, 112px wide, Home's action words (`actionKey`). An expanded row shows a 15px `chevron-up` ghost button here instead |

   - **Order:** groups by their newest unread notification, then by their newest one; inside a group, unread first, then newest first.
   - **The key and the title** link to the task (`/tasks/{id}`). Hover: `--raise` on the row. Focus: a 2px `--muted` outline, inset.
   - **The action:** for `approval`, `plan` and `question` it expands the row in place (`aria-expanded`); for every other reason it opens the task, as on Home.
   - **One row expanded at a time.** On load, the first unread row whose reason answers inline opens by itself; nothing opens if there's none.

### The inline answers

The expanded part sits under its row, indented to the title column (94px), padding `12px 0 14px`, with a hairline under it. It's the shared `NeedsYou` block (`components/ui/needs-you.tsx`): a 2px amber rule, 12px padding, no fill. Its title is a 14px `hand` icon and amber 13px weight 600 text: the only amber words on the page, one block at a time.

- **Approval** (in the picture). Title `Needs you · approval`.
  - Line, 13px: `{agent} wants to {summary}. Rule: {rule}`, with the rule's name in `--text` weight 500 (`Adding a dependency`, or `custom rule` for a custom one).
  - The subject in a code chip: mono 12.5px, `--surface`, 1px `--line`, radius 6px, padding `6px 10px` (a command, a path or a URL).
  - Buttons, 28px, 8px apart: `Deny` (outline), `Approve once` (amber fill, `--ink` text, weight 600), `Approve for this task` (outline).
  - Footnote, 12px `--faint`: `For this task adds {pattern} to the task's rules. Any member of {project} can answer.`, the pattern in mono `--text` (`pnpm add`).
  - `Deny` opens a one-line `Input` under the buttons, placeholder `Why, for the agent (optional)`, with `Deny` (outline) and `Cancel` (ghost) after it.
- **Plan.** Title `Needs you · plan`.
  - The plan's entries (as the task page's plan: 12px glyph + text, 24px rows), at most 8, then a teal `{n} more on the task` link.
  - Buttons: `Ask for changes` (outline), `Approve plan` (amber), `Edit on the task` (outline, it opens `/tasks/{id}` with the plan editor open: editing a plan needs the room).
  - `Ask for changes` opens a 2-row `Textarea`, `What should change?`, with `Send` (outline) and `Cancel`.
  - Answered only by the driver. Anyone else sees, in place of the buttons, 12px `--muted`: `{driver} is driving. Open the task to take over.` with `Open the task` in teal.
- **Question.** Title `Needs you · question`.
  - The question, 13px `--text`, clamped to 4 lines with a teal `Show more`.
  - A 2-row `Textarea`, `Your answer`, and under it `Send answer` (amber). With options the agent gave, they show first as outline buttons, each sending its own answer.
  - Answered only by the driver (spec section 11, item 4). Anyone else sees `{driver} is driving. Open the task to take over.`
- **Answering:** the buttons disable and the pressed one shows a 13px spinning `loader-circle`. On success the block collapses to one 12px `--muted` line under the row, `Approved once by you`, and the row's action column shows `Done` in `--faint`; it moves to the Done tab on the next load, so nothing jumps under the pointer. Refused: a 12.5px `--red` line with `circle-alert`, `role="alert"`, `errorText(error)`; **lost the race:** `Someone answered this first.` and the block shows the receipt it lost to.

### Properties panel: where these reach you

`PropGroup`/`PropRow` (84px key column, 30px rows, 12.5px; keys `--muted`, values `--text`).

1. Group label `Where these reach you` (11px weight 500 `--faint`).
2. Rows, from the member's choices (ticket 37):
   - `Panel`: `Always`
   - `Ticket`: `A comment on {tracker}` (`Linear`), or `Off` in `--muted` when the member turned every moment off for the ticket
   - `Email`: the member's address in mono, and under it 12px `--muted` `after {n} min, if unread` (`OSTRA_EMAIL_DELAY_SECONDS`, in minutes). When the member turned every moment off: `Off` in `--muted`. When the install has no email: `Mail is off on this install` in `--muted`
3. 12px `--faint`, 10px under the rows: `A mail waits {n} minutes and isn't sent once you've read it here.` Hidden when mail is off.
4. A teal `Notification choices →` link to the notification-settings page (target `notification-settings`).

## Reading

- A notification is **read** when the member has seen it here, or opened its task. On this page: rows on the Open tab are marked read (`notifications.markRead`) once the page has been visible for 2 seconds (`document.visibilityState`), in one call for the rows rendered.
- **The dots stay for this visit**, so the list doesn't re-sort under the reader; the lede's unread count drops at once. The sidebar's count is what waits, so it drops when an item is answered, not when it's read. The next load shows the new order.
- `Mark all as read` marks every open notification read, clears the dots and hides the button.
- Read state is per member: Sam reading an item doesn't read it for Alex.

## States

| State | What shows |
|---|---|
| **Open, items** (`needs-you.webp`) | As above |
| Loading | Title at once; the lede and tabs as `Skeleton` lines; two group bands and 6 skeleton rows (key, title and reason widths). The panel's values show `–` |
| **Open, empty** | No groups. The illustration centred on the column: `../m2/inbox-empty-illustration.webp` (Deep water, B-017), 560×373 box, 40px under the tabs. Under it `Nothing waits on you` (15px, 600, `--text`) and `Approvals, questions and plans show here first, and on Home.` (13px `--muted`, 8px under). No button. `Mark all as read` hides |
| **Done** | No grouping: one list, newest answer first, paged by cursor (50, loading as the last row scrolls in). No unread column. The project shows as a 150px column after the title (8px square + name, `--muted`). The action column holds the outcome in 12.5px `--muted`, right-aligned, up to 220px: `Approved once by Sam Rivera`, `Approved for this task by you`, `Denied by you`, `Approved by rule`, `Plan approved by Sam Rivera`, `Answered by you`, `Expired`, `Cancelled`, or `Closed` when the item closed without an answer (the task stopped, the PR merged). Titles in `--muted` |
| Done, empty | One faint line, 24px under the tabs: `Nothing answered yet.` |
| Answered by someone else while open here | The live change notice updates the row: the action column shows the outcome (`Approved once by Sam Rivera`) in `--muted`, an expanded block collapses to that line. It leaves Open on the next load |
| A delivery failed (mail or ticket) | In the expanded block, or under a row that doesn't expand, one 12px `--red` line with a 13px `circle-alert`: `The mail didn't send: {error}. ostra retries.` (`The ticket comment didn't post: …` for the tracker). Only for this member's own deliveries |
| A project the member can no longer open | Its notifications don't show (ticket 36's scoping) |
| Error loading | `role="alert"`, `--red`, `errorText(error)` where the list would be, with a teal `Retry` |
| Live | A change notice for the member's notifications refetches the first page and the count. A new notification appears in its group without a reload, with no animation; an expanded row stays expanded |
| Phone width (F-075) | Target `phone-approval`. Rows wrap to two lines (key + title, then reason + age); the action becomes the row's tap target; the inline answers render full width below the row |

**Keyboard:** `↑`/`↓` move focus between rows, `Enter` on a focused row runs its action (expand, or open the task), `Esc` collapses an expanded row and returns focus to it.

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Button`, `Status`, `Skeleton`, `Input`, `NeedsYou` (`components/ui/needs-you.tsx`), and `home-words.ts`'s `reasonParts` and `actionKey`, shared with Home rather than copied.
- **New in `components/ui/`:** `Tabs`, `TabsList`, `TabsTrigger` (underline style, on `radix-ui`), `Tooltip`, `Textarea`.
- **New:** `src/app/(panel)/needs-you/page.tsx` and `components/needs-you/` (the list, the row, the three inline answers). The approval answer is the task page's (ticket 43), shared, not copied.
- **Icons:** Lucide 15px stroke 1.75 (14px in the block): `hand`, `check-check`, `chevron-up`, `loader-circle`, `circle-alert`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | group bands, the code chip, outline buttons |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | the selected sidebar row |
| `--line` | `#1F2023` | row hairlines, the tabs' rule, the chip's border, the panel border |
| `--line-2` | `#2A2C30` | button borders |
| `--text` | `#EDEDEE` | unread titles, the unread dot, commands, the selected tab and its underline |
| `--muted` | `#9A9DA3` | lede, reasons, read titles, outcomes, panel keys |
| `--faint` | `#64676D` | keys, ages, counts, group labels, the panel's note |
| `--teal` | `#6FB8AA` | `Notification choices →`, `Show more`, `Open the task`, `Retry` |
| `--amber` | `#FFB224` | **only** the sidebar's count pill and project dots, the open block's rule and title, and its one amber button |
| `--red` | `#E5675C` | refusals, failed deliveries, load errors |
| `--ink` | `#0C1D21` | text on the amber button |

- **The unread dot is `--text`, never amber or blue.** Every row here needs the member; amber on each would be nine amber marks, and the brief keeps it to one thing at a time.
- **Type:** Manrope 700 24px title; IBM Plex Sans 13px rows, 12.5px reasons and panel, 13px/600 group names and the block title; IBM Plex Mono for keys, ages, counts, commands and the mail address.
- **Heights:** rows 40px, group bands 30px, tabs 32px, row buttons 26px, the block's buttons 28px. **Radii:** 6px bands and chips, 7px buttons.

## Differences from the current code

1. **There's no Needs you page.** No route `src/app/(panel)/needs-you/`, no `components/needs-you/`, no `notifications` router (ticket 36), no `needsYou.*` page messages. Everything here is new.
2. **The sidebar** (`sidebar.tsx`) goes from Home straight to Projects. Add the `Needs you` row with its amber pill from `notifications.unreadCount`, live through the change notices (ticket 44). Home's `Open all →` points here.
3. **Reasons and actions:** `home-words.ts` maps `NeedsYouReason`. A notification's `kind` (ADR 0050) also has `pr_ready` and `test`: map `pr_ready` to the `draft_ready` line and action, and never list `test` (a test notification only proves a channel, in the settings page).
4. **`components/ui/`** has no `Tabs`, `Tooltip` or `Textarea`. Add them from shadcn/ui on `radix-ui` (no new dependency).
5. **`NeedsYou`** exists and takes `title`, `children`, `actions` and `footer`, which is all the inline answers need.
6. **New message keys** (`apps/web/messages/en.json`): `shell.needsYou`; `needsYouPage.title`, `.lede`, `.ledeNone`, `.open`, `.done`, `.markAll`, `.unread`, `.empty`, `.emptyBody`, `.doneEmpty`, `.reach`, `.panel`, `.always`, `.ticket`, `.email`, `.emailDelay`, `.mailOff`, `.off`, `.mailNote`, `.choices`, `.deliveryFailedMail`, `.deliveryFailedTicket`, `.driving`, `.openTask`, `.moreOnTask`, the outcomes, and the inline answers' words (`.askChanges`, `.approvePlan`, `.editOnTask`, `.whatChange`, `.yourAnswer`, `.sendAnswer`, `.denyReason`, `.forThisTaskAdds`, `.lostRace`). Reuse `home.reason.*`, `home.action.*` and the task page's approval words.

## Wrong in the image (build from this file)

The image's copy is spelled right everywhere. These details differ from what to build:

- **The block's buttons** are about 30px tall. Build 28px.
- **The footnote sets `calculator` in mono.** Project names are sans; only the pattern (`pnpm add`) is mono.
- **The group counts** (`3`, `2`) render in the sans face. Build mono 12px `--faint`.
- **The rule's name** `Adding a dependency` renders bold. Build weight 500.
- **The sidebar** is drawn from the image's own shell, with Organization rows from later milestones (Agent profiles lands in milestone 3; Insights and others don't show). Build it from `sidebar.tsx`.
- **The right panel** starts at x 1122 (318px). Build 300px.
- **The tasks, keys, ages and `alex@acme.dev`** are demo data. Build from `notifications.list`.

Right as drawn: the white unread dots, read titles in `--muted`, the group bands, every action button the same width on one right edge, the single amber button, and the panel's copy.
