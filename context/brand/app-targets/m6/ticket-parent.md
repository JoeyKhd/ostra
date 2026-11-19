# Target: a parent ticket's page (milestone 6, screen 5)

> **Committed image:** `ticket-parent.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `ticket-parent.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: `app-targets/m2/task-ticket.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/tickets/[ticket-id]/page.tsx` → `components/tickets/ticket-parent-view.tsx`. Ticket 32 names the route `src/routes/projects/$projectId/tickets/$ticketId.tsx`; the panel is Next's app router, so this is the same route in its folder form. The Inbox's parent rows, the sub-issue line on a child's task page (`Sub-issue of CALC-180`) and the start sheet's "This starts N tasks" link here.
- **Features:** F-077 (sub-issues), F-031 (the parent's progress comment, shown here), F-099 (the parent's refine task). Spec section 12, screen 5; section 3, step 3; section 4, "Sub-issues". Ticket 25 (`tickets.parent`, `tickets.startSubIssues`), ticket 32 (this screen), ticket 12 (the start and the comment). ADR 0056.
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A code start on a ticket with open sub-issues starts one task per leaf and none for the parent (ADR 0056). The parent is still where people think about the work, so it gets a page that follows its children. It answers, in this order:

1. **How far along is it?** One progress bar and one sentence of counts.
2. **Where is each sub-issue?** One row per sub-issue on this project's boards: its task's state, what it's doing or waiting on, its PRs, and the one action it needs, if any.
3. **What's left out, and why?** Children on no board of this project are listed apart and never started here. A child added after the start shows `No task`, and the page offers to start it.
4. **Where did the sub-issues come from?** The parent's own refine task, when it had one.

The parent never runs code, so the page has **no thread, no tabs and no composer**. It isn't a task page: its URL is the ticket's, under the project.

The picture shows Alex Kim on `CALC-180` "Show the app's version" in `calculator`: six sub-issues on the `Calculator` board (one merged, one in review, one needing an answer, one running, one queued, one added later with no task), one child on the `Mobile` board of `mobile-app`, and the refine task that wrote two of the sub-issues (`refine-draft`).

## Layout (CSS px at 1440 wide)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture. The project's `Inbox` row is selected: a parent ticket is reached from the Inbox (folded sub-issues, ticket 32) or from a child's task page.

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell | as the shell, `calculator › Inbox` selected |
| Top bar | 44px, hairline below | crumbs `calculator › Inbox › CALC-180`. Right: the copy-link ghost icon button, then `Start {n} sub-issue(s)` (outline, Lucide `play`) only while a child on this project's boards has no task |
| Main column | `1fr`, padding `28px 40px`, content `max-width: 1120px` | header, progress, Sub-issues, Not on this project's boards, Refined |
| Properties panel | 300px, left hairline, padding `20px 18px` | Ticket, Sub-issues, On Linear, Started |

### Header (as `m2/task-ticket`'s, without the context row)

1. **Key line,** IBM Plex Mono 12px `--faint`: `CALC-180 · from Linear · parent ticket` (the tracker's name, as on the task page).
2. **Title,** Manrope 700 24px/1.25, −0.015em: the ticket's title from the cache.
3. **Status line,** 13px `--muted`: `{n} sub-issues on calculator's boards · {m} tasks started {age} ago by {name}`. The start's age and member come from the first start of a child's task with origin `sub-issue`. Before any start: `{n} sub-issues on calculator's boards · none started yet`.
4. **Ticket strip,** 12px below, exactly `m2/task-ticket`'s: the Linear status chip with its category glyph, at most 3 label chips then `+{n}`, the priority, `Open in Linear ↗` (teal, through `safeHref`).

### Progress

18px under the strip, no box:
- A line: `Progress` (13px 600) left; right, Plex Mono 12px `--faint` `{merged} of {total} merged`. "Done" here means merged or done; a child whose task was stopped or closed unmerged counts as not done.
- A 6px track, radius 3px, `--surface`, full width. Fills, left to right, in one bar: merged (`--green`), then in review or running (`--muted`). The rest is the empty track. Two fills only: needs you, queued and not started stay in the track, and the sentence under it says how many (one meaning per colour; amber stays on the one row that needs someone).
- Under the track, 12px `--muted`: `{a} merged · {b} in review or running · {c} needs you · {d} queued · {e} not started`, leaving out every part that is 0. `role="img"` on the track, with that sentence as its label.
- One `--line` hairline 16px below.

### Sub-issues

- Section line, 22px below: `h2` `Sub-issues` (13px 600) and the count in Plex Mono 11.5px `--faint`: the children on this project's boards, at every depth the walk reached, leaves only (a child with its own children is a parent too: it shows as one row with `{n} sub-issues` in the Now column and links to its own parent page).
- A `Table`, no box. Header 28px, 11.5px `--faint` 500: `Ticket`, `Title`, `Task`, `Now`, `PRs`, `Age`, and an empty action column. Body rows 40px, `--line` under each. One grid: `84px minmax(0,1fr) 130px 260px 90px 50px 100px`.

| Column | Contents |
|---|---|
| Ticket | the child's key, Plex Mono 12.5px `--faint`. Links to the child's task when it has one, else to Linear |
| Title | the child's title, 13px `--text`, one line, ellipsis (full title in `title`) |
| Task | the task state's dot and word, the task page's: `Merged` (`--green` dot), `In review` (`--green` dot at 60%), `Running` (`--text` dot, pulsing), `Queued` (hollow `--muted` dot), `Needs you` (amber dot and amber word: the only amber in the table), `Stopped` (`--red` dot), `Done` (`--muted` dot). No task: Lucide `circle-dashed` 12px `--faint` + `--faint` `No task` |
| Now | 12.5px `--muted`, Home's reason line (`home-words.ts`): what the agent does now (`Editing` + mono path), what it waits on (`Waiting for a reviewer`, `Waiting for a runner on pool` + mono pool), or the needs-you reason (`Question: …`, ellipsis). Merged: `Merged by {name}`. No task: `Added after the start`, or `Closed on Linear` for a closed child (closed children are listed last and never started) |
| PRs | the task's PRs, teal mono `#495`, comma-separated, at most 2 then `+{n}`; `–` `--faint` when none |
| Age | Plex Mono 12px `--faint`: since the task's last state change |
| Action | one outline `Button` 26px, right-aligned, only when the row needs it: `Answer` / `Review plan` / `Approve` (the needs-you action words, `actionKey`, opening the task with the answer open), or `Start` for a child with no task (`tickets.startSubIssues` with that one ticket) |

- **Order:** the tracker's own order of the children (Linear's `sortOrder`), so the list doesn't reshuffle as tasks move.
- **Live:** the rows follow `tasks.changed` for the children's tasks; a row's state changes in place, without moving.

### Not on this project's boards

22px below: `h2` `Not on calculator's boards` + count. One 12px `--faint` line: `Listed, never started here. Start it from its own project.` Then rows in the same grid: key `--faint` mono, title `--muted`, Task column `Board {name}` (`--muted`), Now column `in {project}` (project name in mono `--muted`; `on no project's board` when no project has its board), and a teal `Open in Linear ↗` at the right. These rows have no task, no PRs and no age. The section is gone when it's empty.

### Refined

22px below, only when the parent had a refine task: `h2` `Refined`. One 40px row: Lucide `list-checks` 14px `--faint`, the key mono `--faint`, `Refine task` 13px `--text`, the state dot and word, then 12.5px `--muted` `Draft v{n} applied by {name}, {date} · {k} sub-issues created` (or `Draft ready, not applied yet`, or `Stopped`), and a teal `Open task` at the right. Several refine tasks: the newest, and a `--faint` `+{n} earlier` link under it.

### Properties panel

`PropGroup`s, 11px 500 `--faint` labels; `PropRow`s 28px, 84px key column, 12.5px.

1. **Ticket:** `Key` teal mono, links to Linear · `Status` the tracker's status name (`In Progress`) · `Board` · `Synced` mono `--muted` age.
2. **Sub-issues:** `On this board` mono count (on this project's boards, any board of the project) · `Tasks` mono · `Elsewhere` mono · `Depth` `{n} levels` (how deep the walk went, at most `OSTRA_SUB_ISSUES_DEPTH`).
3. **On Linear:** the parent's ticket writes, as `m2/task-ticket`'s sync list: `Progress comment` · `--faint` `edited {age} ago` (or `posted`), `Moved to In Progress` · `--green` `done`. Under them, 12px `--faint`: `One comment on CALC-180, edited as the sub-issues move.` A failed write shows `--red` `failed` and the teal `Retry sync`.
4. **Started:** `By` 18px avatar + name · `When` mono age · `Profile` the profile the children run on.

## States and copy

| State | What shows |
|---|---|
| **Following** (the picture) | as above |
| **Nothing started yet** (a parent nobody started, opened from the Inbox) | status line `… · none started yet`; progress `0 of 6 merged`, empty track, sentence `6 not started`; every row `No task` with `Start`; the top bar's button `Start 6 sub-issues` (the page's one primary, Shell, in this state only). Pressing it opens the start sheet (`m1/task-new` grown: kind fixed to code, the profile, pool labels) with `This starts 6 tasks, one for each sub-issue` |
| **Starting** | the pressed button shows `Starting…` with a spinning `loader-circle`; each row gets its task as `tasks.changed` arrives |
| **Over the limit** | more than `OSTRA_SUB_ISSUES_MAX` (50) leaves: nothing starts. Under the top bar's button, a 12.5px `--red` line, `role="alert"`: `CALC-180 has 63 sub-issues on calculator's boards. ostra starts at most 50 at once: split the ticket, or start the sub-issues one by one.` The per-row `Start` still works |
| **All merged** | progress `6 of 6 merged`, the bar all green; the status line adds ` · all merged`. No `Start` button. Linear's parent status is the tracker's business; ostra doesn't move the parent |
| **A child elsewhere only** | the Sub-issues section reads `0` with one 13px `--faint` row `None of CALC-180's sub-issues are on calculator's boards.`; the Not on … section lists them |
| **No sub-issues any more** (all removed in Linear) | the page redirects to the Inbox row's ticket view with the 12.5px `--muted` status line `CALC-180 has no sub-issues now.`; a task already started stays a task |
| **A tracker without sub-issues** (`subIssues` false; the Jira fake declares it) | never reached: the start uses linked tickets, and no parent page is linked |
| **Loading** | header from the cache at once; the bar as an empty track; three 40px `Skeleton` rows; panel values `–` |
| **Error** | under the header, 12.5px `--red`, `role="alert"`: `errorText(error)` and a teal `Try again` |
| **Not allowed** | a member who can't open the project gets the panel's `not found` page |
| **Narrow (below 1280px)** | the panel drops under the page (`PageFrame`). Below 760px each row becomes two lines: key, title and the action on the first; the state, Now and PRs on the second; Age goes. The progress sentence wraps |

## Components (shadcn/ui names)

- The shell: `Sidebar`, `Breadcrumb`, `PageFrame`, `PropGroup`, `PropRow`, `Separator`.
- The header strip: `m2/task-ticket`'s components (`Badge variant="outline"` as `.chip`, `Button variant="link"` as `<a>`).
- `Progress` (shadcn) with two indicators, or a plain `div` track with two fill `div`s and `role="img"` (recommended: plain, since `Progress` takes one value).
- `Table` and its parts; `Button` (`outline` for the row action and the top bar, `ghost` icon for copy-link); the task page's state dot (`components/ui/status.tsx`); `Skeleton`.
- Icons: Lucide 15px, stroke 1.75: `play`, `link`, `circle-dashed`, `list-checks`, `arrow-up-right`, `loader-circle`, the status-category glyphs.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg`, `--side` | `#0D0E10`, `#0A0B0C` | page, sidebar |
| `--surface` | `#131416` | the progress track, skeletons |
| `--line`, `--line-2` | `#1F2023`, `#2A2C30` | hairlines; chip and button borders |
| `--text`, `--muted`, `--faint` | `#EDEDEE`, `#9A9DA3`, `#64676D` | titles; Now, the second fill, sentences; keys, ages, heads |
| `--green` | `#4FB286` | `Merged`, the merged fill, `done` |
| `--amber` | `#FFB224` | the one needs-you row's dot and word, and the sidebar. Never on the bar |
| `--teal` | `#6FB8AA` | PR numbers, `Open in Linear ↗`, `Open task`, the parent key |
| `--red` | `#E5675C` | a stopped child, a failed write, the over-limit line |

Type: Manrope 700 24px (title); IBM Plex Sans 13px rows, 12.5px Now and panel, 11.5px heads, 600 for section titles; IBM Plex Mono for keys, PR numbers, counts and ages.

## Data this screen needs beyond ticket 25

`tickets.parent({ ticketId })` covers the children, their tasks and PRs, the children elsewhere and the refine task. The page also needs:
- each child's **needs-you reason and action** (Home's `reasonParts` input) and **what its task does now**, as `tasks.list` gives them, so the Now column matches Home;
- **the start's member and time**, and the **profile** the children ran on (from the first child task's origin `sub-issue`);
- **the walk's depth** and, for a child that is itself a parent, its own sub-issue count;
- the parent's **ticket writes** (the progress comment and moves) as `m2/task-ticket`'s sync list reads them;
- each child's **board name and project** when it's elsewhere (`on no project's board` when none).

## Open points (the build takes the recommendation and records it in ticket 32's `## Comments`)

1. **Does a stopped or closed-unmerged child count toward the bar?** Recommended: no. The bar counts merged (or done) over every child on the boards, so a stopped child keeps the parent visibly unfinished.
2. **A mid-level child (a parent of its own).** The walk starts only leaves. Recommended: show it as one row linking to its own parent page, with `{n} sub-issues` in Now and no task state, rather than flattening the tree.
3. **Who may press `Start`.** Recommended: any member who can open the project, as for any start; the start goes through admission, the pool cap and the budget like the first one.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19), which holds milestone 1's panel; milestones 2 to 5 build the Inbox, the ticket strip and the sync list this page reuses.

1. **New route** `projects/[project-id]/tickets/[ticket-id]/page.tsx` and `components/tickets/ticket-parent-view.tsx`. Nothing under `tickets/` exists.
2. **Shared pieces from the task page:** the ticket strip and the sync list (`m2/task-ticket`, ticket 36 of milestone 2) move into `components/tickets/` so both pages use one.
3. **The Inbox** (milestone 2) folds sub-issues under their parent and links the parent's row here (ticket 32).
4. **Messages:** a `ticketParent` namespace in `messages/en.json` for every string above, with plurals for the counts (`Start 1 sub-issue`, `Start 6 sub-issues`).

## Wrong in the image

Build the copy and details in this file, not these:

- **The panel's group labels** (`Ticket`, `Sub-issues`, `On Linear`, `Started`) are drawn 13px semibold white. They're 11px 500 `--faint` `PropGroup` labels.
- **Mono where it shouldn't be:** the panel draws `2 levels`, `2 h ago` and `edited 3 min ago` all in mono. Ages and counts are mono as `m2/task-ticket` sets them (`30 s ago`, `2 h ago`); `levels` and `edited` are sans. In the elsewhere row, `Board Mobile` is sans `--muted`, and in `in mobile-app` only the project name is mono.
- **The progress bar's second fill** is drawn up to the half; it covers the in-review-or-running children only (two sixths after the green sixth).
- **The `In review` dot** is drawn grey-green; use `--green` at 60%.
- **The sidebar's rows** (Automations, Memory, Repos, Runner pools with counts, Insights, Background work) come from the shell, not the picture.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no nothing-started, over-limit, all-merged, loading or narrow states: they're in the table above.

All visible copy in the image is spelled right.
