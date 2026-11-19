# Target: the search page (milestone 4, screen 11)

> **Committed images:** `search.webp` (results for `apiVersion`, the first selected) and `search-empty.webp` (before a query), each downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Images:**
  - `search.webp`: Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. References: the approved milestone 2 original `inbox.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. Prompt: `search.prompt.txt`.
  - `search-empty.webp`: a composite, not a second generation. The base is `search.webp`'s generation with the query, the count, the results and the panel erased. On it sits the Deep water illustration (`../../files/web/sign-in-illustration.webp`, B-017), cropped to the hinge, ×0.9 and feathered into `--bg` by an elliptical falloff, and the placeholder and empty-state copy drawn with the brand's real fonts (`fonts/`) by a script (described in `search.prompt.txt`).
  - `search-empty-illustration.webp`: that graded crop at 960×640, for a 480×320 CSS box. It's the file the build uses. Once approved, it belongs in `files/web/` with its row in `../../assets.md`.
- **Route (new):** `apps/web/src/app/(panel)/search/page.tsx` → `components/search/search-view.tsx`. The Ctrl+K palette (`search-palette`, screen 10) opens this page with its query and tokens through "See all results".
- **Features:** F-080 (search). ADR 0054, "Search"; spec section 4 (`search.query`), section 3 step 11, section 11 item 8. Tickets 11 (search entries), 26 (`search.query`), 35 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 35 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A member finds a task by what was said or done in it: a word from a message, a command an agent ran, a path it touched, a ticket key, a prompt. The page is the full list behind the palette: the query, the filters as controls, and every matching task once, ranked, each with the snippets that matched and what kind of thing they matched (an agent message, a command, a path). Selecting a result shows the task's properties and every match, each linking to its place in the thread. Results are only ever tasks the member can open: access is in the query, so a hidden project's task is never fetched, ranked or counted.

The picture shows Alex Kim searching `apiVersion` over the last 30 days: five tasks in four projects, the billing task selected.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`, never from the picture. No row is selected on this page: search isn't a nav destination. The sidebar's search field opens the palette (screen 10), not this page |
| Top bar | 46px, hairline under | Breadcrumb `Acme Corp › Search` (`Search` in `--text` 500). Nothing on the right |
| Main column | `1fr`, padding `28px 36px` | Title, lede, query, filter row, results |
| Properties panel | **320px** (no form), `border-left: 1px var(--line)`, padding `20px 18px` | The selected result's task and its matches. Hidden before a query and when nothing matches (`.content.full`) |

### Main column, top to bottom

1. **Title** `Search` (`PageHeading`).
2. **Lede** (`text-lede`, `--muted`): `Every task you can open: titles, prompts, tickets, messages, and the commands and paths agents used.` It says what's searched, and that access limits it.
3. **Query**, 18px under the lede: one `Input`, full column width, **36px** tall, radius 8px, `--surface` fill, `--line-2` border, a 15px `search` icon inside on the left (12px in), text 14.5px `--text`. Placeholder `Search tasks, tickets, messages and commands` in `--faint`. At the right, a `Kbd` `Esc` in `--faint`, shown only while the field holds text: Esc clears it. It's focused on load.
   - It searches as you type, debounced 250ms, with `websearch_to_tsquery` and the last word as a prefix (`migr` finds `migration`), so quotes and `-word` work as on the web.
   - **Typed tokens become controls.** `repo:`, `status:`, `by:`, `project:`, `ticket:` typed in the query (the palette's syntax) leave the text when the space after them is typed and set the matching filter control. So a link from the palette, `/search?q=apiVersion&repo=acme/billing-api&state=merged`, opens with the controls set.
4. **Filter row**, 12px under the query: flex, gap 8px, every control **30px** tall (the house button height), radius 7px. Each is a `Button variant="outline"` (1px `--line-2`, no fill, `text-ui`, weight 500) ending in a 12px `chevron-down` in `--faint`, opening a `Popover` + `Command` with a search field and checkable items. A set filter shows its value after a colon in `--text`.
   - `Project` (default `Project: All`): the projects the member can open, each with its 8px colour square.
   - `Repo`: the repos of the chosen projects (all the member can open with no project chosen), in mono.
   - `Ticket`: type a key (`BIL-91`) or pick from the tickets of the results; matches the task's ticket.
   - `Member`: the organization's members, avatar + name. Matches a task's creator, its driver, or the author of a message in it (ADR 0054).
   - `State` (default `State: Any`): the task's lifecycle states, in `domain-model.md`'s order: Needs you, Running, Queued, Preparing, In review, Merged, Stopped, Failed. Several can be checked.
   - `Period` (default `Period: Last 30 days`): `Last 7 days`, `Last 30 days`, `Last 90 days`, `Any time`, `Between…` (two dates). It filters on when the matched entry was written (UTC days).
   - Every filter lives in the URL (`?q=…&project=…&repo=…&ticket=…&by=…&state=…&period=30d`), so a search can be linked.
   - At the right (`margin-left: auto`): `5 tasks` (`1 task`) in mono 12px `--faint`, the total for the query and filters, not the page.
5. **Results**, 16px under the filters. A list with no box; each result is a block with a 1px `--line` hairline under it, padding `12px 14px`, one result per task. **One grid for every block**, so the columns line up:
   - **Line 1** (22px): the task's state mark and word (as on the project screen: green dot `Running`, amber dot `Needs you`, `loader-circle` `Preparing`, `circle-dashed` `Queued`, `git-pull-request` `In review`, `git-merge` `Merged`, `circle-slash` `Stopped`, `circle-x` `Failed`) in a 110px column, `text-sm`, the word `--muted`; the task's title, `text-body` `--text`, one line, ellipsis, with any matched word in weight 600; at the right the age of the newest match, mono 12px `--faint` (`2h`, `3d`, `2w`).
   - **Line 2** (20px), from the title's x: the project's 8px colour square and name, then ` · ` and the repo, the ticket key and the task's short ID in mono, then ` · ` and the driver's name; all 13px `--faint` (`--muted` for the project name). A task with several repos shows the first and `+1`. No ticket: the key is left out.
   - **Snippets**, up to two, 6px under line 2, each on one line: a label in the 110px column (12.5px `--faint`) saying what matched, then the snippet from `ts_headline` in 13.5px `--muted`, ellipsis at the end. The matched words are `<mark>`: `--text`, weight 600, on `--line-2` with a 3px radius and **no extra padding**, so the words around them keep their spacing. A command or path snippet is mono 13px.
     - The labels, from `SearchEntry.kind`: `Title`, `Prompt`, `Ticket`, `Member message`, `Agent message`, `Command`, `Path`, `URL`, `PR`. A tool call's input is `Command` (an `execute`), `Path` (a `read`, `search` or write's paths) or `URL` (a fetch).
     - More than two matches: the second snippet line ends with `+2 more` in `--faint`; the panel lists them all.
   - **Order:** best rank first (`ts_rank`, grouped by task). Paged by cursor: the next 25 load when the last result scrolls into view, with three `Skeleton` blocks while they load.
   - **Selecting:** a click selects the block (`--sel` fill, radius 6px, no border), and so do `↑`/`↓`. `Enter` or a double-click opens the task at its best match (`/tasks/{id}?event={seq}`). A click on a snippet opens the task at that snippet's place in the thread. The selection lives in the URL (`?task=t-8c41d2e`). The first result is selected on load.
   - **Hover:** `--raise`. **Focus:** a 2px `--muted` outline, inset.

### Properties panel: the selected result

`PropGroup`/`PropRow` (96px key column, 30px rows, `text-ui`; keys `--muted`, values `--text`), groups split by the `--line` hairline.

1. **Head line:** the task's short ID in mono 12px `--faint` on the left; on the right a teal `Open task` link with a 12px `arrow-right`.
2. **Title:** 15px, weight 600, wrapping, 4px under the head line, 10px above the rows. No highlight in the panel.
3. **Rows:** `State` (mark + word), `Project` (square + name), `Repo` (mono; several repos, one per line), `Ticket` (mono key, or `–` in `--faint` for a prompt task), `Driver` (18px `Avatar` + name; none: `Nobody` in `--faint`), `PR` (`git-merge` / `git-pull-request` + mono `#418`, a link to GitHub; several, one per line; none: `–`), `Updated` (mono `3 days ago`, the exact time in a `title`).
4. **Matches** with the count in mono `--faint`: every match in the task, newest turn last, one 30px row each: the label (12px `--faint`, 96px column), the excerpt (one line, ellipsis, mono for commands and paths, the match in weight 600 with no fill), `turn 2` in mono 11.5px `--faint` at the right. Each row links to that place in the thread. At most 20, then `Open the task to see all 34.` in `--faint`.
5. 16px down, **Open task**: an outline `Button`, full width, 30px, `arrow-right` + `Open task`. The page has no primary button.

## States

| State | What shows |
|---|---|
| Results, one selected (`search.webp`) | As above |
| **Before a query** (`search-empty.webp`) | The query field empty and focused, the filter row (usable: filters with no text list every task they match, newest first), no count, no panel (`.content.full`). The illustration (`search-empty-illustration.webp`, 480×320 CSS box) centred on the query's column, 32px under the filters, then `Search every task` (15px, 600, `--text`) and `Type a word, a ticket key or a command. Typing repo:, status: or by: sets a filter.` (13.5px `--muted`, 8px under). No button |
| Filters set, no text | The list shows the tasks the filters match, newest first, with no snippets: line 1 and line 2 only, 56px blocks. The count reads `{n} tasks` |
| Searching | The previous results stay, dimmed to 60%, with a 13px spinning `loader-circle` in the query field's right edge in place of `Esc`. The first search shows five `Skeleton` blocks (a 110px bar and a title bar, a 320px meta bar, a 480px snippet bar). The panel shows skeleton rows |
| **Nothing matches** | No illustration: it's an empty result, not an empty place. No panel. 24px under the filters, 13.5px `--muted`: `No task matches apiVersion.` (the query in `--text`), or with filters set `No task matches apiVersion with these filters.` and a teal `Clear filters` after it. Under it, 12.5px `--faint`: `Search covers titles, prompts, tickets, messages, and the commands, paths and URLs agents used. It doesn't search agent output or thinking.` |
| A query too long | Over 500 characters, the field stops taking text and says under it, 12px `--faint`, `A search is at most 500 characters.` |
| Error | `role="alert"`, `--red`, `errorText(error)` with `circle-alert` where the results would be. The query and filters stay usable |
| A result's task opened elsewhere and changed | Results don't live-update. A change notice for a listed task updates its state mark and age in place, never its rank or snippets; the order holds until the next search |
| Narrow (below `xl`) | The panel isn't stacked under the list: a click opens the task directly, and the panel opens as a right `Sheet` (320px) only from the `Matches` button that each block then shows at its right (`{n} matches`, 12.5px `--muted`) |
| Phone (F-075) | One column. The filter row scrolls sideways inside its own strip, never the page. Blocks drop line 2's repo and ID, keep one snippet, and open the task on tap |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (properties at the default 320px, `full` when there's no panel), `PageHeading`, `PropGroup`, `PropRow`, `Status` (`components/ui/status.tsx`), `Button`, `Input`, `Kbd`, `Avatar`, `Skeleton`, `Tooltip`, `Sheet`.
- **New in `components/ui/`:** `Popover` + `Command` (`CommandInput`, `CommandList`, `CommandItem` with a check) for the six filters, unless milestone 2's Inbox already added them (it names the same pair; build once). A date-range picker for `Between…`: two `Input type="date"`, no new calendar dependency.
- **New in `components/search/`:** `search-view.tsx`, `search-result.tsx` (the block), `search-filters.tsx`, `search-matches.tsx` (the panel group), `highlight.tsx` (renders `ts_headline`'s marked text).
- **Icons:** Lucide 15px stroke 1.75 (13px in the panel): `search`, `chevron-down`, `arrow-right`, `loader-circle`, `circle-dashed`, `git-pull-request`, `git-merge`, `circle-slash`, `circle-x`, `circle-alert`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the illustration's falloff |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the query field |
| `--raise` | `#17181B` | result hover |
| `--sel` | `#1A1B1E` | the selected result |
| `--line` | `#1F2023` | result hairlines, panel border, group separators |
| `--line-2` | `#2A2C30` | control borders, the `<mark>` fill |
| `--text` | `#EDEDEE` | titles, values, matched words, filter values |
| `--muted` | `#9A9DA3` | lede, snippets, state words, project names, panel keys |
| `--faint` | `#64676D` | meta line, match labels, ages, counts, chevrons, placeholder |
| `--teal` | `#6FB8AA` | `Open task` (head line), `Clear filters` |
| `--green` | `#4FB286` | a Running task's dot |
| `--amber` | `#FFB224` | **only** a task that needs you (its dot), and the sidebar's count |
| `--red` | `#E5675C` | errors |

- **Type:** Manrope 700 for the title; IBM Plex Sans for titles, snippets, labels and controls; IBM Plex Mono for task IDs, ticket keys, repos, commands, paths, PR numbers, ages and the count.
- **Radii:** 8px the query, 7px controls, 6px the selected block, 3px `<mark>`.
- **Heights:** query 36px, controls 30px, panel rows 30px; blocks 76px with one snippet, 96px with two.

## Data this screen needs beyond ticket 26

`search.query({ q, projectIds, repoIds, ticketKey, memberId, states, period, cursor })` returns, per task: the task's ID, title, state, project (ID, name, colour), repos, ticket key, driver, PRs, updated time, rank, the total count, and its matches: each `SearchEntry`'s kind, `ts_headline` text (with the marks as start and end offsets, not HTML), the event sequence and the turn number. The page shows the best two as snippets and the panel all of them (up to 20). The highlight comes back as offsets so the panel renders it as React text: no raw HTML from the database reaches the page.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **No search exists.** No `search` router, no `SearchEntry`, no route `app/(panel)/search/`, no `components/search/`. Everything here is new (tickets 11, 26, 35).
2. **`components/shell/command-menu.tsx`** is a destinations palette (Home, a project's tasks, Runners, Models). Screen 10 (`search-palette`) grows it into the task search; its "See all results" opens this page with the query and tokens as URL parameters.
3. **`components/ui/`** has `select`, `tooltip`, `skeleton`, `avatar`, `kbd`, `sheet` and `dropdown-menu`, but no `Popover` or `Command`. The Inbox's spec names them too; check with the maintainer before adding `cmdk`: it's a new dependency. Without it, the filters are `DropdownMenu`s with `DropdownMenuCheckboxItem`s and a plain `Input` on top.
4. **New message keys** (`apps/web/messages/en.json`): `search.title`, `search.lede`, `search.placeholder`, `search.count`, `search.project`, `search.projectAll`, `search.repo`, `search.ticket`, `search.member`, `search.state`, `search.stateAny`, `search.period`, `search.period7`, `search.period30`, `search.period90`, `search.periodAny`, `search.periodBetween`, `search.kind.*` (the nine labels), `search.more`, `search.matches`, `search.turn`, `search.openTask`, `search.emptyTitle`, `search.emptyBody`, `search.noMatch`, `search.noMatchFiltered`, `search.clearFilters`, `search.covers`, `search.tooLong`; reuse the state words from the project screen.

## Wrong in the image (build from this file)

The image's text is legible and spelled right everywhere. These details differ from what to build:

- **The highlights** carry padding on both sides, so `rg -n " apiVersion " src/stripe` and `src/config/ apiVersion .ts` show gaps that aren't in the text. Build `<mark>` with no padding.
- **The state column** is followed by a `|` separator. There's no separator: the title starts at its column's x.
- **The `Merged` icon** is drawn as `git-pull-request` on results 1 and 4 and in the panel. Merged is `git-merge`.
- **The panel's head link** reads `Open task` with an `arrow-up-right`. It's `arrow-right`: the task opens in the panel, not a new tab.
- **The panel is about 385px wide** (from x 1055). Build 320px: it holds no form.
- **The panel's Matches rows** set their labels at about 11px. They're 12px `--faint`, in the 96px key column.
- **The sidebar** is drawn from the image's own shell, with its Spend icon a database and Linear's a guess. Build it from `sidebar.tsx`; its icons come from the m4 sidebar change (spec section 12, "The sidebar").
- **The demo data** (the tasks, IDs, `BIL-91`, Sam Rivera) is invented. Build from `search.query`.
- **`search-empty.webp`:** the placeholder and copy are drawn by a script, so their rendering is approximate. Build them with the real components. The illustration's 480×320 box is the size to build.
