# Target: Home's board view (milestone 3, screen 9)

> **Committed image:** `home-board.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `home-board.prompt.txt`. GPT Image 2.6 through Higgsfield, 2 generations: the first from the full spec, the second an edit of the first that set the cards' status lines in sans and aligned the board with the heading. References: `app-targets/m1/home.png` (the approved Home this view belongs to), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** `/` with `?view=board` → `apps/web/src/app/(panel)/page.tsx` → `components/home/home-view.tsx`, which renders a new `components/home/home-board.tsx` when the view is `board`.
- **Features:** F-062 (Home: "A board grouped by status is the second view"). Spec section 12, screen 9. Ticket 36 (`home.board`), ticket 44 (this screen).
- **Status:** a proposed target, waiting on the maintainer's approval (ticket 41's `## Comments`). Ticket 44 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Home's first view (`m1/home`) answers "what waits on me, and how is each project doing?" in sections. The board answers the other question a lead asks: **where is all the work right now?** Every task the member can open in the organization, as cards in columns by lifecycle state, in `domain-model.md`'s order. Each card carries its project's colour square, so five projects' work reads apart at a glance, and the project filter narrows it to one.

The board is for looking, not for acting: cards link to their task, and nothing on a card answers, approves or drags. A task changes state by what happens to it, never by moving its card (there's no state a person can set by hand).

The picture shows Acme Corp's board across all projects, with demo data matching the Home target's figures.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar; **Home** selected (`--sel`). Build it from `components/shell/sidebar.tsx`, never from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Home`; on the right the page's one primary button `+ New task`, as on the overview |
| Page | `1fr`, padding `28px 40px` | heading, toolbar, board. **No properties panel in the board view:** `PageFrame` gets no `properties`, so the board has the full width. The overview keeps its panel |

### Heading

The overview's heading, unchanged, so switching views doesn't move it:
- Eyebrow, Plex Mono 12px `--faint`: `Thursday 19 November` (the member's locale date, `en-GB`).
- Title, Manrope 700 24px, −0.015em: the organization's name, `Acme Corp`.
- Lede, 13.5px `--muted`: the overview's live sentence (`home.summary`): `238 tasks running across 18 projects, 41 queued. 37 pull requests merged today.`

### Toolbar (new, on both views)

20px under the lede, one 28px row:
1. **View toggle,** a two-segment `ToggleGroup`, 28px tall, 1px `--line-2`, 7px radius, each segment 12px padding, 13px 500: `Overview` (Lucide `list`) and `Board` (Lucide `columns-3`). The selected segment is `--sel` with `--text`; the other `--muted`. It writes `?view=board` (the overview has no parameter), so the view survives a reload and a shared link, and the member's last choice is kept in `localStorage` as a convenience (read in `try`/`catch`).
2. **Project filter,** 12px to the right, a `Select` trigger 28px tall, 1px `--line-2`, 7px radius, 13px: `All projects` with `chevron-down`. The menu lists the member's projects, each with its 8px colour square, sorted by name. With one picked, the trigger reads its square and name, and the URL gains `&project=<id>`. Only on the board (the overview already covers every project).
3. **At the right,** 12.5px `--faint`: `Finished: last 7 days`. It explains the fifth column's window.

### The board

16px under the toolbar. **Five equal columns,** 12px apart, `grid-template-columns: repeat(5, minmax(0, 1fr))`. At 1440 the board is 1128px wide, so a column is 216px. No box around a column: a column is a header band and cards (rule 3: a card is the one box here, never a box inside a box).

**Columns,** in `domain-model.md`'s order. The board groups the `TaskState` values into five columns:

| Column | Header mark | Holds | Card's status line |
|---|---|---|---|
| `Needs you` | 7px `--amber` dot | `needs_you` | the needs-you line from `m1/home.md`'s reason table (`Approval: `+command, `Plan ready for review`, `Draft PR #2213 ready, checks passed`, `Question: `+first line, `Setup failed: `+command+` exited `+code, …) |
| `Queued` | Lucide `circle-dashed`, `--muted` | `queued` | `Waiting for a box on ` + the pool or runner in mono (`build-fleet`), or `Waiting for your runner` on a personal runner |
| `Running` | 7px `--green` dot | `preparing` and `running` | running: what the agent is doing now, from the latest event (`Running pnpm test percent`, `Editing src/settings/theme.ts`, `Reading …`); preparing: `Preparing · ` + the step (`restoring snapshot`, `starting services`, `checking out branches`) with a 15px `loader-circle` instead of nothing |
| `In review` | Lucide `git-pull-request`, `--muted` | `in_review` | `PR #481 · ` + the sub-state in words: `CI running`, `fixing CI`, `AI review`, `fixing findings`, `waiting for a reviewer`. Several PRs: `3 PRs · CI running` |
| `Finished` | Lucide `git-merge`, `--muted` | `merged`, `done` and `stopped` that ended in the last 7 days | merged: 13px `git-merge` in `--green`, `Merged · PR #2207` (several: `Merged · 2 PRs`); done: `circle-check` `--green`, `Done`; stopped: `circle-x` `--muted`, `Stopped: ` + the stop reason (`spend cap reached`, `by Sam Rivera`, `ticket closed`) |

- `awaiting_approval` (F-040) gets its own column, first, the day outside tasks ship. Until then no task reaches it, and the board doesn't draw an empty column for it.
- Why `Finished` folds three states: a board's last column would otherwise hold every task ever merged. The window keeps it a week, and each card says how it ended. A finished task reopened goes back to `Queued`.

**Column header band:** 32px, `--surface`, 7px radius, padding `0 12px`: the mark, 8px, the title (600 13px `--text`), and at the right the count (Plex Mono 12px `--faint`, tabular). 8px under it, the cards.

**Card:** a link (`<a>`) to `/tasks/[task-id]`, `--surface` fill, 1px `--line`, 8px radius, padding 12px, 8px between cards, no shadow. Four lines:
1. 20px: 8px colour square (`projectColour(project.id)`, 2px radius), 8px, the key (Plex Mono 12px `--faint`; a prompt task shows `Prompt`, as the project list does), and at the right the age (Plex Mono 12px `--faint`: time in the current state, `4m`, `2h`, `3d`).
2. The title, 13px `--text`, line height 18px, at most two lines, then an ellipsis (`line-clamp-2`), the full title in a `Tooltip`.
3. The status line (table above), 12px `--muted`, one line, truncated, the full line in the tooltip. Sans; commands, paths and pool names inside it in Plex Mono 11.5px `--text`.
4. 20px: the project's name, 12px `--faint`, truncated; at the right the driver's 18px `Avatar` (initials, `--line-2` fill, 9px 600). No driver: no avatar.

6px between lines. Hover: the border turns `--line-2` and the card `--raise`. Focus: the panel's focus ring.

**Order inside a column:** newest first by time in the state, as the overview's Needs you section is sorted (newest first, the picture's order), except `Queued`, which is the queue's own order (ticket priority, then age), so the card at the top is the next to run.

**How many:** each column shows its first **20** cards (`home.board` pages per column), then a teal link, 13px, no underline: `38 more` (the count minus what's shown). It loads the next 20 into that column. The header count is always the column's full total.

**Height:** the page scrolls, not the columns. Columns end at their own height; the empty space below the short ones stays `--bg`.

## States and copy

| State | What changes |
|---|---|
| Loading | heading at once; the toolbar is live; each column shows its header with `–` as the count and three `Skeleton` cards (100px, `--surface`, no shimmer) |
| Full (the picture) | as above |
| A column with no tasks | its header with `0` (Plex Mono `--faint`), and under it one 12.5px `--faint` line, no card: `Nothing needs you.`, `Nothing queued.`, `Nothing running.`, `Nothing in review.`, `Nothing finished this week.` The column keeps its width, so the board doesn't shift |
| No tasks at all | the five headers with `0`, and under the board, 13px `--muted`, centred in the page: `No tasks yet. Start one with New task, or from a ticket.` No illustration: the empty columns already say it |
| A project picked | the cards and counts are that project's only; the lede stays the organization's; `Finished: last 7 days` unchanged. The filter's own empty: `No tasks in calculator yet.` |
| First run (setup not done) | the toolbar hides and Home shows the overview with the checklist (`m1/home.md`, "First run"); `?view=board` is ignored until setup is done |
| Live updates | cards move between columns on the change notices that already refresh the overview (no reload). A card that changes column moves without animation; with `prefers-reduced-motion: no-preference` it may fade in over 150ms |
| Load failed | each column keeps its header and shows one row: `Couldn't load this. Retry`, with `Retry` as a teal link |
| Narrow (below 1280px) | the board scrolls sideways inside the page (`overflow-x: auto`), each column 240px, snap to columns; the heading and toolbar stay put |
| Phone (below 640px, F-075) | the board becomes one column at a time: the toolbar's view toggle stays, and a second `ToggleGroup` under it picks the state (`Needs you 5`, `Queued 41`, …), scrolling sideways. Cards take the full width |

## Components (shadcn/ui names)

`Sidebar` (existing), `PageFrame` with `Breadcrumb` and no `properties`, `PageHeading`, `Button` (`+ New task`, existing), `ToggleGroup` / `ToggleGroupItem` (new, on `radix-ui`, already a dependency), `Select` (existing `ui/select.tsx`), `Avatar` (existing), `Skeleton` (existing), `Tooltip` (new, `radix-ui`), and the board's own `HomeBoard`, `BoardColumn` and `TaskCard` in `components/home/`. Lucide 15px, stroke 1.75: `list`, `columns-3`, `chevron-down`, `circle-dashed`, `git-pull-request`, `git-merge`, `circle-check`, `circle-x`, `loader-circle`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, the space under short columns |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | header bands, cards, skeletons |
| `--raise` | `#17181B` | a hovered card |
| `--line` | `#1F2023` | card borders, top bar hairline |
| `--line-2` | `#2A2C30` | toggle and select borders, a hovered card's border, avatar fill |
| `--text` | `#EDEDEE` | titles, column titles, commands in status lines |
| `--muted` | `#9A9DA3` | status lines, header icons, the unselected toggle segment |
| `--faint` | `#64676D` | keys, ages, counts, project names, `Finished: last 7 days` |
| `--sel` | `#1A1B1E` | the selected toggle segment, the Home row |
| `--amber` | `#FFB224` | only the `Needs you` column's dot and the sidebar's count. No card, line or button on the board is amber |
| `--green` | `#4FB286` | the `Running` dot, the merged and done icons |
| `--teal` | `#6FB8AA` | `38 more` links, `Retry` |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `+ New task` |

Project squares (demo): calculator `#6FB8AA`, billing-platform `#8C7CF0`, web-storefront `#E0A458`, mobile-app `#5FA8E8`, data-pipeline `#C27BA0`. In the app they come from `projectColour(project.id)`.

Type: Manrope 700 24px (title); IBM Plex Sans 13px (titles, toggle), 12px (status lines, project names), 600 13px (column titles); IBM Plex Mono 12px for keys, ages, counts and commands.

## Data this screen needs

`home.board` (ticket 36) returns the tasks grouped by state, each with its project, key, title, driver and age, with a filter by project. The picture also needs, per card:
- **The status line's source:** the open needs-you item's reason and its detail (as the overview already reads), the queue's pool or runner, the latest activity event for running and preparing (the overview's "what the agent is doing" already exists in the project list, F-086), the in-review sub-state and PR numbers, and the stop reason.
- **The column totals** separate from the page of cards, and a cursor per column.
- **The 7-day window** for `merged`, `done` and `stopped`, by the time the task entered that state.

Ticket 36 should return these, or the card drops line 3 for the states it lacks.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **No view toggle.** `home-view.tsx` renders the overview only. Add the toolbar (toggle and filter) under `PageHeading`, and branch on `?view=board`.
2. **`PageFrame` with no panel** for the board: it already renders without `properties`; check the page then uses the full width at `xl`.
3. **New pieces:** `ToggleGroup` and `Tooltip` aren't in `components/ui/` yet (`radix-ui` is). `Select`, `Avatar` and `Skeleton` exist.
4. **`home.board`** doesn't exist in `packages/api/src/routers/home.ts`; ticket 36 adds it.
5. **Messages:** new keys under `home.board.*` (the toggle, the filter, the column titles, the empty lines, `{count} more`, `Finished: last 7 days`, the status lines per state) in `messages/en.json`, with plurals where counts appear.

## Wrong in the image

Build the copy and details in this file, not these:

- The board starts at about x 265 and ends at about 1410, with 14px gaps and 222px columns. Build it on the page's padding (x 272 to 1400 at 1440), 12px gaps, 216px columns.
- The column titles render at about 15px bold. They're 600 13px. The card titles render at about 14px; they're 13px.
- `Running pnpm test percent`, `Waiting for a box on` and the `N more` links are partly or wholly in mono. Only the command, path or pool name is mono; `Running`, `Waiting for a box on`, `Editing`, `Reading` and the links are sans.
- `Waiting for a box on build-fleet` wraps to two lines, and `Draft PR #2213 ready, checks passed` and `Setup failed: pnpm install exited 1` wrap too. The status line is one line, truncated, with the full line in the tooltip.
- The cards are taller than needed (about 110 to 130px). With the sizes above a two-line-title card is about 104px.
- The Stopped card's icon is a `circle-x` in `--text`. It's `--muted`: stopped isn't an error.
- The sidebar is drawn, not built: its rows happen to match milestone 3 (Runners, Models, Agent profiles, GitHub, Linear, Storage), but its spacing doesn't. Build it from the shared shell.
- The logo mark is approximate. Use the real Hinge SVG.

All visible copy in the image is spelled right.
