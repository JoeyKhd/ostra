# Target: Insights (`/organization/insights`, `/projects/[project-id]/insights`)

> **Committed image:** `insights.webp`, downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. References: the approved milestone 1 original `../m1/home.png`, `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `insights.prompt.txt`.
- **Status:** a candidate target for milestone 4, not yet approved (ticket 31).
- **Starts from:** `../m1/home`: its sidebar, top bar, title and lede, section header lines, hairline rows, the right panel's bar chart, figures and 4px meters, and the properties panel.
- **State shown:** the organization's Insights for Acme Corp, the last 30 days, computed 3 minutes ago. Alex Kim can open every project.
- **Features:** F-108 (Insights), with spend from F-037. Definitions: ADR 0055, "Insights". Data, from ticket 28: `insights.get({ projectId | null, period })`, read only from `InsightDaily`, `TaskMetric`, `SpendDaily` and `InsightRun` (ticket 14's job). Builder: ticket 37.

## Purpose

What the agents shipped over a period, how long they waited on people, and what it cost. An admin or a lead opens it once a week or before a budget talk: six figures to read at a glance, then the two charts that explain them, then where the money went. It isn't live (ADR 0035): the numbers are what `insights.compute` last wrote, and the page says when that was. The same page serves the organization and one project; a project's version drops the "By project" group.

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`, never from the picture. **New row** `Insights` (`chart-no-axes-column` icon) under Organization, after Members and Spend, selected here; and `Insights` under each open project, after Memory. No count |
| Top bar | 46px, hairline under | Crumbs `Acme Corp › Insights` (a project: `calculator › Insights`). Nothing on the right |
| Main column | `1fr`, padding `28px 36px` | Title, lede, the period row, the six figures, two sections |
| Properties panel | 320px, `border-left: 1px var(--line)`, padding `20px 18px` | Tokens and spend: the total, the four token kinds, by project, by model |

### Main column, top to bottom

1. **Title** `Insights` (`PageHeading`: Manrope 700 26px, −0.015em).
2. **Lede**, 15px `--muted`: organization `What the agents shipped across {n} projects, and what it cost.` ({n} the projects the member can open, plus one for "Other projects" when it shows); project `What the agents shipped in {project}, and what it cost.`
3. **The period row**, 16px under the lede, 30px tall, flex:
   - **Segmented control** (`ToggleGroup`, single, on `radix-ui`): `--surface` fill, 1px `--line-2` border, radius 7px, segments padding `0 14px`, 14px weight 500. `7 days`, `30 days`, `90 days`, and `Dates` with a 14px `calendar` icon. Selected: `--sel` fill, `--text`; others `--muted`. Default `30 days`.
   - `Dates` opens a `Popover` with a two-month `Calendar` (range mode, UTC days, nothing after today, at most 366 days), and `Apply` (outline) under it. Picked, the segment reads `Dates` still and the range shows beside it.
   - **The range**, 12px after the control, mono 13px `--faint`: `19 Oct – 17 Nov` (`en-GB`, the period's first and last UTC day; with a different year, `19 Dec 2025 – 17 Jan`).
   - **Computed**, right (`margin-left: auto`): a 14px `clock` icon and 13px `--muted` `Computed {age} ago` from `computedAt` (`3 min`, `1 h`). The exact time in a `Tooltip`. It re-renders every minute. Older than three intervals (`OSTRA_INSIGHTS_INTERVAL_MINUTES` × 3): the icon and words turn `--red`, `Computed {age} ago. The Insights job hasn't run since.`
   - The period lives in the URL: `?period=7d|30d|90d` or `?from=2026-10-19&to=2026-11-17`.
4. **The six figures**, 20px under the period row: a 3×2 grid, no boxes. A 1px `--line` rule above and below the grid and between its rows; 1px `--line` vertical rules between the columns. Cells 100px tall, padding `16px 18px` (the first column has no left padding, as the picture's).
   - **Label**, 13px `--muted`.
   - **Figure**, Manrope 700 28px `--text`, tabular, 6px under the label.
   - **Note**, 13px `--muted`, 4px under the figure.
   - **Sparkline**, right of the figure, vertically centred on it: 100×30, a 1.5px `--chart` line, round joins, a 4px `--chart` dot on the last point, no axes, no fill. One point a day of the period (7, 30, 90 or the picked days). Hidden under 3 points. `aria-hidden`; each cell's `aria-label` reads the figure and its note.

| Cell | Label | Figure | Note | Sparkline, a day's point |
|---|---|---|---|---|
| 1 | `PRs opened` | the count | `across {n} repos` | PRs opened that day |
| 2 | `PRs merged` | the count | `{n} a day on average` (one decimal under 10) | PRs merged that day |
| 3 | `Merge rate` | `87%`, or `—` when no PR closed | `of {n} PRs closed`; none: `No PR closed in this period` | that day's rate; a day with none closed is a gap |
| 4 | `Median time to a first PR` | `23 min`, `2.4 h`, `1.2 d`; `—` with no first PR | `over {n} tasks` (the count the median is over) | the median of that day's first PRs; gap on a day with none |
| 5 | `Time waiting on people` | the total: `41 h`, `52 min`, `3.1 d` | `{d} median per item` | that day's total |
| 6 | `Tokens and spend` | the money, `$4,212` (no cents from $100 up; `$12.40` under) | `{n} tokens` (`182.4M`, `9.1k`) | that day's money |

   - Each figure follows ADR 0055's table, exactly. **No comparison with the previous period:** the ADR defines none, so there's no delta and no green or red.
   - A cell is a link where there's a page behind it: none in milestone 4. Don't make them buttons.
5. **Pull requests by day**, 26px under the grid.
   - **Header line**, 28px: `Pull requests by day` 15px weight 600 on the left; on the right the legend, 13px `--muted`: an 8px radius-2 `--chart-2` square + `Opened`, 16px gap, an 8px `--chart` square + `Merged`.
   - **The chart**, 150px plot + 22px labels, the column's full width. One pair of bars per day: `Opened` (`--chart-2`) on the left, `Merged` (`--chart`) on the right, 2px apart; pairs share the width with a gap of 40% of a pair. Bars have 3px rounded tops and stand on a 1px `--line` baseline. **No gridlines, no y axis.** One scale for both series, zero-based.
   - **Today** (the last day when the period ends today) is a partial day: both bars at 50% opacity, and its label `today`.
   - **Labels**, mono 12.5px `--faint`, under the baseline: the first day, then every 7th day, and `today` (or the last day). 7 days: every day, as `T F S S M T today` on Home. 90 days: every 14th.
   - **Direct labels** only on the tallest `Opened` bar and on the last day (mono 12.5px `--muted`, 6px above the bar): the `Opened` count. Never a number on every bar.
   - **Hover:** a full-height `--raise` column behind the pair (a hit target wider than the bars), and a `Tooltip`: `Mon 9 Nov` (13px weight 600), `58 opened`, `51 merged`, mono for the numbers. Keyboard: the chart is one tab stop; `←`/`→` move the day and show the tooltip.
   - **Table view:** a teal `Table` link at the end of the header line toggles a plain `Table` (Day, Opened, Merged) in place of the chart, for screen readers and copying. The chart has `role="img"` and an `aria-label` with the period's totals.
   - At 90 days the pairs become single bars of `Merged` with `Opened` as a 1.5px `--chart-2` line over them, since 180 bars don't fit: same legend, same scale.
6. **Waiting on people, by reason**, 26px under the chart.
   - **Header line**: `Waiting on people, by reason` 15px weight 600; on the right mono 13px `--faint` `{n} items`.
   - **Rows**, 38px, a 1px `--line` hairline under each. One grid:

| Column | Width | Contents |
|---|---|---|
| Reason | 190px | 14px `--text`: `Approvals`, `Plans`, `Questions`, `Draft PRs to review`, `Stalled tasks`, `Crashes`, `Setup failures`, `Spend caps`, `Closed tickets`, `Budgets` (one per `NeedsYouReason` with items in the period, and the budget kinds) |
| Bar | `minmax(0,1fr)`, 24px gap each side | An 8px `--chart` bar with a 4px rounded end, on an 8px `--line-2` track, radius 4px. Its length is the row's total over the largest total |
| Total | 80px, right | mono 14px `--text`, weight 400: `17.6 h` |
| Items | 90px, right | mono 13px `--faint`: `142 items` |
| Median | 120px, right | mono 13px `--faint`: `6 min median` |

   - Sorted by total, largest first. At most 6 rows; the rest fold into one `Other reasons` row.
   - No items in the period: one 13px `--faint` line, `Nothing waited on people in this period.`, and no header count.

### Properties panel: tokens and spend

Groups split by the `--line` hairline, 18px apart. Group labels 12px weight 500 `--faint` (`PropGroup`).

1. **`Spend, {period}`** (`Spend, last 30 days`; `Spend, 19 Oct – 17 Nov` for picked dates).
   - The money, Manrope 700 30px `--text`, 8px under the label.
   - 14px `--muted`: `{n} tokens · {m} models`.
   - Four `PropRow`s, 28px, keys 14px `--muted`, values mono 14px `--text` right-aligned: `Fresh input`, `Output`, `Cache reads`, `Cache writes`.
   - **Unpriced:** when `SpendDaily.unpricedTokens` is above 0 in the period, a fifth row `Unpriced` with its tokens, and under the group 12px `--muted` with a 13px `info` icon: `{n} tokens had no price and aren't in the money.` with a teal `Models →` link for admins.
2. **`By project`**, with the count in mono `--faint` on the right (organization Insights only).
   - Rows 48px: the 8px project square and the name (14px `--text`) on the left, the money mono 14px `--text` on the right; under them, 8px down, a full-width 4px meter (`--chart` on `--line-2`, radius 2px), its length the project's money over the largest.
   - Sorted by money. At most 4 named rows, then `{n} more` (14px `--muted`, no square) with the rest's sum; it links to Spend (target `spend-budgets`).
   - **Other projects:** a member who can't open a restricted project sees its share in one row, `Other projects` (`--muted`, no square, no link), never its name (ADR 0055). It never folds into `{n} more`: it shows on its own, last, so the member knows part of the total is hidden from them.
3. **`By model`**: the same rows, the model's ID in mono 14px (`claude-sonnet-5-5`), no square. At most 4, then `{n} more`.
   - **Hover** on any row: a `Tooltip` with the four token kinds for that project or model.

The panel's sums equal the figure in cell 6: the money of every row, `{n} more` and `Other projects` adds up to the total.

## A project's Insights

`/projects/[project-id]/insights`, for members who can open the project. The same page with:
- crumbs `calculator › Insights`, lede `What the agents shipped in calculator, and what it cost.`;
- cell 1's note `across {n} repos` counts the project's repos (`in 1 repo` with one);
- no `By project` group in the panel.

## States

| State | What shows |
|---|---|
| **Ready** (`insights.webp`) | As above |
| Loading | Title, lede and the period row at once (the control usable). The six cells show their labels, and `Skeleton` bars for figure and note. Chart and reasons: one 150px `Skeleton` block and 4 skeleton rows. The panel's values show `–` |
| Changing the period | The old numbers stay, at 60% opacity, until the new ones arrive (no skeleton flash). The URL changes at once |
| **Never computed** (a new organization, the job hasn't run) | No grid, charts or panel groups. The Deep water illustration (`../m2/inbox-empty-illustration.webp`, B-017) centred in a 560×373 box, 40px under the period row; `No Insights yet` (15px, 600) and `ostra computes them every {n} minutes. The first numbers show after the first run.` (13px `--muted`). The period control stays |
| **Nothing in the period** (computed, no PRs, no waiting, no spend) | The grid shows, figures `0`, `—` where ADR 0055 says so; the chart's baseline with the day labels and one 13px `--faint` line over it, `No pull requests in this period.`; the reasons' empty line; the panel `$0` with no project or model rows |
| Stale | The `Computed` line turns `--red` as above. Nothing else changes: the numbers are still the last ones computed |
| Error loading | `role="alert"`, `--red`, `errorText(error)` under the period row with a teal `Retry`. The period control stays |
| A member can't open a restricted project | The organization's numbers include it; its share is `Other projects` in the panel; nothing names it (ticket 28) |
| Phone width (F-075) | The panel stacks under the page. The grid becomes 2 columns × 3 rows, sparklines stay. The chart keeps its width and drops to every 14th label; at 90 days it shows the line form. Reasons drop the Items and Median columns into a second 12px `--faint` line under the reason |

## Light and dark

The panel's light theme isn't built yet (`globals.css`: "light theme is left for later"). The charts use two tokens so the theme can swap them:

| Token | Dark | Light (when it lands) | Why |
|---|---|---|---|
| `--chart` | Mist `#CFD8D4` (13.3:1 on `--bg`) | `#2F3734`, a deep Mist (12.2:1 on white) | Mist on white is 1.5:1: invisible. The light step keeps Mist's green-grey hue |
| `--chart-2` | `#62656B` (3.3:1 on `--bg`, 4.0:1 against Mist) | `#8A8F95` (3.3:1 on white) | The quieter series. It must stay above 3:1 for a graphic (WCAG 1.4.11) |

The picture draws `Opened` at about `#53575A` (2.6:1): too faint. Build `#62656B`. Opened and Merged differ by lightness and by position in the pair, and the legend names both, so colour never carries identity alone. Meter tracks are `--line-2` in both themes.

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Button`, `Skeleton`, `Tooltip`, `Table`.
- **New in `components/ui/`:** `ToggleGroup` (segmented style), `Popover`, `Calendar` (range) on `radix-ui` and the date helpers already in the repo; ask before adding `react-day-picker` if no calendar exists (AGENTS.md: no new dependency without asking).
- **New:** `src/app/(panel)/organization/insights/page.tsx`, `src/app/(panel)/projects/[project-id]/insights/page.tsx`, and `components/insights/` (`period-picker`, `figure-grid`, `sparkline`, `pr-chart`, `waiting-by-reason`, `spend-panel`). Charts are hand-written SVG; no chart library.
- **Shared with Home:** the bar chart's geometry and the meter (`components/home/`), moved to `components/charts/` rather than copied. Home's chart takes `--chart` too.
- **Icons:** Lucide 15px stroke 1.75 (14px in the period row): `chart-no-axes-column`, `calendar`, `clock`, `info`.

## Tokens (`app-concepts/html/graphite.css`, at the pictures' scale)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the segmented control |
| `--raise` | `#17181B` | a chart day's hover column |
| `--sel` | `#1A1B1E` | the selected segment, the selected sidebar row |
| `--line` | `#1F2023` | the grid's rules, row hairlines, the chart's baseline, the panel border |
| `--line-2` | `#2A2C30` | control borders, bar and meter tracks |
| `--text` | `#F2F3F4` | figures, totals, values |
| `--muted` | `#B4B7BB` | labels, notes, reasons' secondary text, legend |
| `--faint` | `#8B8E93` | the range, day labels, items, medians, counts |
| `--teal` | `#6FB8AA` | `Table`, `Retry`, `Models →` |
| `--red` | `#E5675C` | a stale `Computed` line, load errors |
| `--chart`, `--chart-2` | above | every mark |
| `--amber` | `#FFB224` | **not on this page.** Only the sidebar's own dots and pill |

- **No green, red or amber in the charts.** A figure going down isn't an error, and nothing here needs anyone.
- **Type:** Manrope 700 26px title, 28px figures, 30px panel total; IBM Plex Sans 14.5px body, 15px/600 section titles; IBM Plex Mono for the range, totals, items, medians, token counts, money in rows and day labels.
- **Heights:** the period row 30px, figure cells 100px, reason rows 38px, panel rows 28px (48px with a meter). **Radii:** 7px controls, 3px bar tops, 4px bar ends, 2px meters.

## Differences from the current code

1. **There's no Insights page.** No routes, no `components/insights/`, no `insights` router (ticket 28), no `InsightDaily`, `TaskMetric` or `InsightRun` (ticket 05), no job (ticket 14). Everything is new.
2. **Ticket 28's `insights.get` returns a daily series for PRs opened and merged only.** The sparklines need one per figure: merge rate, the first-PR median, waiting and money per day too. Add them to the same response (all from the daily rows and `TaskMetric`, so nothing reads live tables), and say so in ticket 28's `## Comments`.
3. **The sidebar** (`sidebar.tsx`) has no Insights row. Add it under Organization and under each open project.
4. **Home's chart** draws Mist from a literal. Move it to `--chart` and share the component.
5. **`components/ui/`** has no `ToggleGroup`, `Popover` or `Calendar`.
6. **New message keys** (`apps/web/messages/en.json`): `shell.insights`; `insights.title`, `.ledeOrganization`, `.ledeProject`, `.period7`, `.period30`, `.period90`, `.dates`, `.apply`, `.computed`, `.stale`, `.prsOpened`, `.acrossRepos`, `.inOneRepo`, `.prsMerged`, `.perDay`, `.mergeRate`, `.ofClosed`, `.noneClosed`, `.firstPr`, `.overTasks`, `.waiting`, `.medianPerItem`, `.tokensSpend`, `.tokens`, `.prsByDay`, `.opened`, `.merged`, `.table`, `.today`, `.byReason`, `.items`, `.median`, `.otherReasons`, `.nothingWaited`, `.noPrs`, `.empty`, `.emptyBody`, `.spendFor`, `.freshInput`, `.output`, `.cacheReads`, `.cacheWrites`, `.unpriced`, `.unpricedNote`, `.byProject`, `.byModel`, `.more`, `.otherProjects`, and one per reason.

## Wrong in the image (build from this file)

The image's copy is spelled right everywhere. These details differ from what to build:

- **`Opened` bars** are about `#53575A`, under 3:1. Build `--chart-2` `#62656B`.
- **Today's pair** isn't drawn at half opacity. Build 50%.
- **The direct labels** `58` and `21` are `--text`. Build `--muted`, and `58` belongs to the tallest `Opened` bar (the picture puts it there; keep it).
- **The waiting totals** (`17.6 h`) render bold. Build weight 400 `--text`.
- **`13 more`** in the panel is `--text` and indented. Build `--muted`, aligned with the names after their squares' column.
- **The sidebar** is drawn from the image's own shell. Build it from `sidebar.tsx`: `Spend` and `Members` show only when their tickets land, and `Memory`'s count is proposals (target `memory`).
- **The panel** starts at x 1121 (319px) and the sidebar is 234px: right at the pictures' scale (`../m1/README.md`, "Scale").
- **Every number** is demo data, checked to add up (the panel's projects and models each sum to $4,212, the token kinds to 182.4M, the reasons to 41 h and 318 items, 849 ÷ 976 = 87%). Build from `insights.get`.

Right as drawn: the period row, the six cells with their hairline grid and sparklines, Mist as the one chart colour, the legend, the labels only every 7 days, the reasons' aligned columns, and the panel's groups and meters.
