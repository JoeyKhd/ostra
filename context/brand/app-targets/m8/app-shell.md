# Target: the double-sidebar shell (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912) and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. Both are rendered with Playwright from `html/` with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. To re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `shell-home.webp` | Alex Kim (an admin of Acme Corp, and a member of a second organization) on Home. The rail's **Home** is lit. The panel is Acme Corp's: Overview (selected), Board, All tasks, Alex's four live tasks (one needs them) and three recent ones. The page is Home's Overview (`../m1/home.md`, with m3's toggle), unchanged. |
| `shell-home-light.webp` | The same, in the light theme (`../m7/light-home.md`'s tokens). |
| `shell-project-tasks.webp` | **Projects** is lit, with `calculator` open. The panel is the project's: its pages (Tasks selected, Needs approval's amber count), its five live tasks, and three other projects with their amber dots. The page is the project's task list (`../m1/project.md`), unchanged. |
| `shell-project-tasks-light.webp` | The same, in light. |
| `shell-peek.webp` | The panel is collapsed (`[`): the page takes the width, and the top bar gains the button that docks it again. The pointer rests on **Org** in the rail, so the Organization panel floats over the page: a peek. |
| `shell-phone.webp` | Three 390×844 screens: (1) the project's tasks with the spaces in a bottom tab bar; (2) the top bar's panel button has opened the project's panel as a sheet; (3) a task with Chat and Preview as one segmented choice (`task-preview.md`, "Phone"). |

- **Where it comes from:** the maintainer, 2026-11-21: "i like the ux of multica a lot, their double sidebar is nice". Multica's structure is in `context/research/multica-ui.md`. This target takes the structure (a rail of spaces, a contextual panel, one-key collapse with a peek, a sheet on the phone), and keeps ostra's own look: flat graphite, no content card, amber only for "needs you", the Hinge.
- **Route:** every route of milestones 1 to 7 stays where it is. This changes `apps/web/src/components/shell/` (`app-shell.tsx`, `sidebar.tsx`, `project-nav.tsx`, `nav-link.tsx`, `page-frame.tsx`, `destinations.ts`) and nothing under `app/`.
- **Features:** F-146 (the double sidebar), proposed by the milestone 8 spec (`context/specs/m8-previews-and-library/`, ticket 10), and not in `features.md` yet. Also F-075 (touch sizes), F-080 and F-081 (the palette, the shortcuts, the keyboard walk) and F-082 (both themes).
- **Status: a proposed target, waiting for the maintainer's approval.** Ticket 10 builds it once it's approved. Every other milestone 8 target is drawn in this shell.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

Today one 234px sidebar holds everything: personal views, every pinned project with the open one's nine pages, the organization's thirteen pages, and the instance's. It's long, and it grows with each milestone. The double sidebar splits it by question:
1. **Where am I working?** The rail: Home, Needs you, Projects or the organization. It never moves and never scrolls.
2. **What's here?** The panel holds the open space's pages, plus what's live in it: a project's running tasks, or my own.
3. **What is this?** The page, as today, with its properties panel.

## Layout

At 1440 wide, left to right: rail 64 | panel 240 | page 1136. The page is the top bar plus the content, which keeps today's `minmax(0,1fr) 320px` grid when there's a properties panel. The rail and the panel run the full height; the top bar belongs to the page column.

### The rail (64px)

`<nav aria-label="Spaces">`, `--side` fill, a 1px `--line` right edge, padding `8px 0 12px`, a column of centred items with 2px gaps.

1. **The organization tile,** 40×40 with a 9px radius: the Hinge (`--logo-mark`, 24px), the Shell export in dark and the Abyss one in light.
   - A member of more than one organization also sees a **monogram chip** at its bottom-right: 17×17, 5px radius, `--sel` fill, the organization's first letter in Manrope 700 10px `--text`, and a 2px `--side` ring.
   - A click opens today's organization switcher (`sidebar.tsx`'s menu: the organizations with a check on the current one).
   - Its accessible name is `Switch organization, Acme Corp`.
2. **New task,** 32×32, 7px radius, `--primary` fill, Lucide `plus` 17px at stroke 2 in `--on-primary`, 4px above it. It goes to `/tasks/new` (today's `+`), and its tooltip reads `New task · c`.
3. **Search,** 36×34, 8px radius, Lucide `search` 18px `--muted`. It opens the palette (⌘K), as today's search box does.
4. **A rule,** 28×1 `--line`, with a 9px margin above and 7px below.
5. **The spaces,** each a link of 54×50 with a 9px radius: a Lucide icon at 19px, then a label in Plex Sans 500 11px/13px, 3px apart.
   - **Colour:** `--faint` at rest. Hover is a `--hover` fill with `--text-2`. The lit space is a `--sel` fill with `--text`, and `aria-current="page"`.

   | Space | Icon | Label | Tooltip | Home of the space |
   |---|---|---|---|---|
   | Home | `house` | Home | `Home · g h` | `/` |
   | Needs you | `bell` (today's) | Needs you | `Needs you · g n` | `/needs-you` |
   | Projects | `folder` | Projects | `Projects · g p` | the last project opened, else `/projects/new` for a member with none |
   | Organization | `building-2` | Org | `Organization · g o` | `/organization/insights` |

   - **Needs you's count:** a pill 17px tall, at least 17 wide, 4px side padding, at `top 3px; right 6px`. `--amber` fill, `--on-amber` Plex Mono 600 10.5px, with a 2px ring in `--side` (`--sel` while the space is lit). It counts the member's open needs-you items, as today's sidebar does, and it's the only amber in the rail.
   - **No other badges:** a project waiting on the member shows as an amber dot in the Projects panel, not on the rail.
6. **The foot,** pushed down by `margin-top:auto`, 6px apart:
   - **Settings:** Lucide `settings` 18px `--muted` in a 36×34 button. It opens the Settings space (below), and is lit there.
   - **The account:** the member's initials in a 28px circle, `--line-2` fill in dark and `--sel` in light, Plex Sans 600 11px `--text`. It opens today's user menu (`user-menu.tsx`).

**What a space opens:** the last page visited in that space in this organization, kept in memory for the session. Clicking the space that's already lit goes to its home. Changing organization clears the memory.

### The panel (240px)

`<nav aria-label="{space or place}">` on `--bg`, the page's own surface, with a 1px `--line` right edge. No inset card and no shadow: the hairline separates it from the page.

- **Head,** 46px (level with the page's top bar), padding `0 8px 0 16px`:
  - **The title:** Plex Sans 600 15px `--text`, the place's name: `Acme Corp` on Home, a project's name, `Organization`, `Settings`.
  - **On a project,** the title is a button with the project's 9px colour square before its name and Lucide `chevrons-up-down` 14px `--faint` after it. It opens the project switcher: a filter field, the member's projects (needs-you ones first, each with its square and amber dot), `All projects` and `New project`.
  - **Its actions, at the right,** are 28×28 icon buttons, 16px `--faint` icons with a 6px radius. A project's panel has `plus` (`New task in calculator`, which opens `/tasks/new?project=…`), and every panel has `panel-left-close` (`Hide the sidebar · [`).
- **Body,** padding `2px 8px 12px`. It scrolls on its own, with no visible scrollbar until hover.
- **A row,** as today's `nav-link.tsx`: 28px tall, padding `0 8px`, 10px gap, 6px radius. Plex Sans 500 14px `--text-2`, with a 16px Lucide icon in `--faint`.
  - The page's row has a `--sel` fill, with `--text` text and icon.
  - **At its end,** 6px apart: a count in Plex Mono 500 12px `--faint`, or the amber count pill (18px, `--amber`, `--on-amber` mono 600 11px) where something waits on the member.
  - **The label** truncates with an ellipsis.
- **A section label,** Plex Sans 500 12px/1.45 `--faint`, padding `16px 8px 4px`, with its count in mono beside it. A trailing 14px icon button (`list-filter`) can sit at its right.
- **A live task row,** two lines in a `14px 1fr` grid with an 8px gap, padding `5px 8px`, 6px radius:
  - **Line 1:** the state mark (the 7px dot, the 11px spinner, or `git-pull-request` 13px `--muted`) at `margin-top:7px`, then the title in Plex Sans 500 14px/20px `--text-2`, truncated.
  - **Line 2:** Plex Mono 12px/17px `--faint`, the key, ` · ` and what the agent does now (`Editing panel.tsx`). Needs-you words are in Plex Sans 500 `--amber-text`: `Needs you · approval`, `Question`.
  - The open task's row has a `--sel` fill.
  - A click opens the task, and the row updates live from the same stream as the task list.
- **Resizing:** drag the right edge (a 5px hit area, `col-resize`) from 200 to 320. A double-click resets it to 240.

### The page column

Unchanged: the top bar (46px, breadcrumbs left, actions right, a `--line` under it), the page, and its properties panel. With the panel collapsed, the top bar's first item is a 28px `panel-left-open` button (`Show the sidebar · [`), drawn in `shell-peek.webp`.

## The spaces' panels

Every row is a route that exists today, gated by role exactly as `sidebar.tsx` gates it now. A route with no row is a bug: ticket 10's walk over `destinations.ts` fails for it.

### Home (`shell-home.webp`)

Head: the organization's name.
1. **Rows:**
   - `Overview` (`layout-dashboard`, `/`);
   - `Board` (`square-kanban`, Home's Board view, the second half of m3's toggle; the toggle stays on the page, and both lead to the same view);
   - `All tasks` (`list-checks`, `/search`, the task search; `g t` goes there today).
2. **`Yours, live {n}`:** the member's own tasks that need them, run or prepare. Needs-you ones come first, then running, then preparing, newest first in each group. It shows at most 6, then `{n} more`, which goes to `/search` filtered to the member's active tasks.
   - **Empty:** 13px `--faint` `Nothing of yours is running.`, then a teal `New task` link.
3. **`Recent`:** the last 5 tasks the member opened in this organization, as one-line rows with a state icon (`circle-check` done, `git-pull-request` in review, `circle-x` failed, in `--faint`), the key in Plex Mono 12.5px `--faint`, and the title. The list is kept in this browser (`localStorage`, per organization) and never synced. It's empty until a task is opened, and hidden when empty.

### Needs you (no picture)

Head: `Needs you`.
- **Rows that filter the page** (`/needs-you?kind=`), each with its count: `All`, `Approvals`, `Questions`, `Plans to review`, `Pull requests to review` and `Setups that failed`. A kind with none is hidden.
- **`By project`:** each project with items, its square and its count. A click filters the page to that project.
- The page is today's (`../m3/needs-you.md`).

### Projects (`shell-project-tasks.webp`)

**With a project open** (any `/projects/{id}/…` route, or a task of that project):
1. **The project's pages,** with today's icons, in today's order:
   - `Tasks` (count of active tasks);
   - `Needs approval` (the amber pill);
   - `Inbox` (its count);
   - `Boards`, `Environment` and `Automations`;
   - `Memory` (the proposals' count, plain, never amber);
   - `Insights` and `Settings`.

   `Repos` stays a tab of Settings, as today.
2. **`Live {n}`:** the project's active tasks, every driver's, ordered as on the Tasks page: needs you, running, preparing, queued. It shows at most 8, then `{n} more` (to Tasks). The `list-filter` button at the label's right switches between `Everyone's` and `Mine`, kept per member.
   - **Empty:** `No live tasks in {project}.`
3. **`Other projects`:** the member's three most recently opened projects, then `All {n} projects` (`ellipsis`), which opens the switcher. Each row has its square, and an amber dot where something waits on the member.

**With no project open** (`/projects/new`, or a member's first visit):
- Head `Projects`, with `plus` for admins.
- A filter field: 30px, `--surface`, a `--line-2` edge, `search` 14px, `Filter projects`.
- Then every project the member can open, with needs-you ones first: the square, the name, the amber dot, and the running count in mono `--faint`.
- **Empty:** `No projects yet.` For an admin, a teal `New project`. For a member, `An admin adds you to a project.`

### Organization (`shell-peek.webp`)

Head: `Organization`. Rows in groups, each gated as today:
- **Ungrouped:** `Insights`, `Spend` (admins), `Memory` (its proposals' count).
- **`Fleet`:** `Runners` (count), `Box sizes`, `Registry` (admins).
- **`Agents`:** `Agent profiles` (count), **`Skills and MCP`** (new in milestone 8, F-144, `blocks`; `library.md`), and `Models` (admins).
- **`Connections`** (admins): `GitHub`, `Linear`.
- **`People`:** `Members` (count), `Audit log` (admins).
- **`Instance`** (the instance admin): `Accounts`, `Storage`, `Email`.

A group whose rows are all hidden from the member is hidden too.

### Settings (no picture)

Head `Settings`. The member's own pages that exist today (`/account` and its tabs, and `/device`), one row each.

## Collapsing, the peek and narrow widths

- **Collapse:** `[` (outside a text field), the head's `panel-left-close`, or the top bar's `panel-left-open`.
  - The panel's width animates to 0 over 160ms ease-out, or at once with `prefers-reduced-motion`. Its content is `inert` while collapsed.
  - The member's choice and the width are kept in a cookie the server reads (ticket 10), so a reload doesn't flash.
- **The peek** (`shell-peek.webp`): while collapsed, resting a mouse pointer on a rail space for 150ms shows that space's panel over the page.
  - **The overlay:** 240 wide, from 8px below the top to 8px above the bottom, 6px right of the rail. `--raise` fill, a 1px `--line-2` edge, 10px radius, `--shadow-pop`.
  - **Moving between spaces** while it's open switches it at once.
  - **It closes** 200ms after the pointer leaves both the rail and the overlay, on Escape, or on navigation.
  - **Its head's last button** is `panel-left-open` (`Keep it open · [`), which docks it.
  - **Touch and keyboard** never peek: a tap or Enter on a space navigates.
- **1024 to 1279px:** the panel starts collapsed and the peek works. Docking it pushes the page, as at 1440. The automatic collapse happens only when the window crosses into this band, and isn't saved over the member's choice.
- **768 to 1023px:** the rail only. Docking the panel overlays the page, like a pinned peek with a scrim (`--scrim`) that closes it.
- **Below 768px:** the phone pattern below.

## Phone (`shell-phone.webp`)

At 390×844, with every control at least 44px tall (F-075, `globals.css`'s `pointer: coarse` rule).
1. **The top bar,** 54px:
   - **Left:** a 44px `panel-left` button that opens the panel as a sheet.
   - **The title:** Plex Sans 600 16px, the place's name. On a project, it's the project switcher, with its square and `chevron-down`.
   - **Right:** the page's one action as a 44px icon (`plus` on a project).
2. **The bottom tab bar,** 66px plus the safe-area inset, `--side` fill, a 1px `--line` top edge.
   - **Five tabs:** Home, Needs you (the amber count pill, at `top 5px; left: 50% + 4px`), Projects, Org and Search (which opens the palette full-screen, `../m7/command-palette-phone`).
   - **Each tab:** a 21px icon over Plex Sans 500 11px, `--faint` at rest and `--text` when it's the open space.
   - **The tab bar replaces the rail.** It's hidden on a task's page, where the composer takes the bottom (picture 3).
3. **The sheet** (picture 2): from the left, 318 wide, full height, over a `--scrim` that closes it.
   - **Head:** 54px, the panel's own (the switcher, and `x` to close).
   - **Rows** are 44px, Plex Sans 15px with 18px icons, and the live rows are as on desktop.
   - **Its foot,** not drawn, holds the account row (initials, name, which opens the user menu) and `Settings`.
   - **It closes** on navigation, Escape, a tap on the scrim, or a swipe left.

## Keyboard

- **Landmarks:** the rail and the panel are each one `nav`, and the page is `main`. Tab goes rail → panel → page.
- **Inside the rail:** one tab stop with a roving focus. ↑ and ↓ move through the tile, the tools, the spaces, Settings and the account; Home and End jump to the ends. Enter or Space opens.
- **Inside the panel:** ↑ and ↓ move between rows, skipping section labels; Enter opens. On a project, the head's switcher is the first stop.
- **Shortcuts:** added to milestone 7's one registry, so the `?` sheet lists them (`../m7/shortcut-sheet.md`).
  - **New:** `[` hides or shows the panel, `g p` goes to Projects and `g o` to the Organization.
  - **Unchanged:** `g h`, `g n`, `g t`, `c`, `/`, `?` and ⌘K.
- **Tooltips:** on the rail's items, after 500ms of hover or at once on focus. Each gives the full name and its shortcut. A tooltip never replaces the accessible name.
- **Focus:** the panel's 2px `--teal` `:focus-visible` outline (`globals.css`), on the 6px radius of a row and the 9px radius of a space.

## Every state

| State | What shows |
|---|---|
| **Loading** | The rail and the rows draw from the route at once. Counts and live lists show skeleton bars (`--surface`, 12px tall, 6px radius) for at most the first paint. No spinner in the shell |
| **A count fails** | It's left out, never shown as `0`. A live list that fails shows `Couldn't load.` 13px `--faint` with a teal `Retry` |
| **One organization** | The Hinge alone, with no monogram chip. The switcher still opens, with the one organization and `Create organization` where the member may |
| **The runner stream drops** | The live rows keep their last state, and the dots stop pulsing (there's no pulse at rest anyway). The page's own reconnect notice covers it (milestone 1) |
| **Many projects** | `Other projects` keeps three. The switcher lists all of them, with a filter |
| **A restricted project** | Today's 12px `lock` after the name, in the switcher and in `Other projects` |
| **A member, not an admin** | The Org panel shows only their rows (Insights, Memory, Runners, Box sizes, Agent profiles, Skills and MCP, Members). Projects has no `plus` |
| **Collapsed** | `shell-peek.webp` without the overlay: the rail, then the page from x=64 |
| **Light theme** | `shell-home-light.webp`, `shell-project-tasks-light.webp`: `../m7/light-home.md`'s tokens. The rail on `--side` `#F3F3F5`, the panel and page on `--bg` `#FAFAFB`, the abyss Hinge, `--primary` `#141518` on the new-task button |

## Components (shadcn/ui names)

- **From the repo:** `Sheet` (the phone sheet and the 768–1023 overlay), `DropdownMenu` (the switchers, the user menu), `Tooltip`, `nav-link.tsx`, `user-menu.tsx`, `shortcut-sheet.tsx` and the action registry, `destinations.ts`.
- **New:**
  - `components/shell/rail.tsx`: the rail, its spaces and its foot;
  - `components/shell/context-panel.tsx`: head, body and resize;
  - `components/shell/panels/{home,needs-you,project,projects,organization,settings}.tsx`;
  - `components/shell/live-task-row.tsx`;
  - `components/shell/peek.tsx`;
  - `components/shell/tab-bar.tsx`.

  A space is a union `"home" | "needs-you" | "projects" | "organization" | "settings"`, derived from the route in `destinations.ts`. Every `switch` over it is exhaustive.
- **Icons** (Lucide, stroke 1.75): `house`, `bell`, `folder`, `building-2`, `settings`, `plus`, `search`, `panel-left-close`, `panel-left-open`, `panel-left`, `chevrons-up-down`, `list-filter`, `layout-dashboard`, `square-kanban`, `list-checks`, `blocks`, and today's page icons.

## Tokens

These are `globals.css`'s, in both themes, and the shell adds none. `--side` is the rail. `--bg` is the panel and the page. `--sel` is the lit space and the page's row. `--hover` is hover. `--line` is the edges, `--raise` with `--line-2` and `--shadow-pop` is the peek, and `--scrim` is behind the sheet. `--amber` and `--on-amber` are only Needs you's count, the Needs approval pill and the dots; `--amber-text` is the needs-you words. `--primary` is only the new-task button.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--side` (a space's label at rest) | 6.0:1 | 5.3:1 | 4.5 |
| `--text` on `--sel` (the lit space, the page's row) | 15.5:1 | 15.0:1 | 4.5 |
| `--faint` on `--sel` (a count on the selected row) | 5.2:1 | 4.8:1 | 4.5 |
| `--text-2` on `--bg` (a row) | 13.5:1 | 13.2:1 | 4.5 |
| `--faint` on `--bg` (a section label, a live row's line 2) | 5.9:1 | 5.6:1 | 4.5 |
| `--on-amber` on `--amber` (the counts) | 9.6:1 | 10.1:1 | 4.5 |
| `--amber-text` on `--bg` (`Needs you · approval`) | 10.7:1 | 6.1:1 | 4.5 |
| `--faint` on `--raise` (the peek's labels) | 5.4:1 | 5.8:1 | 4.5 |
| `--primary` on `--side` (the new-task button as a control) | 17.3:1 | 16.5:1 | 3 |

## Differences from the current code

1. **`app-shell.tsx`:** the grid becomes `64px | panel | 1fr`. The 234px `<aside>` and its drawer go.
2. **`sidebar.tsx`** splits into the rail and the panels. Its role gates move unchanged with their rows.
3. **`project-nav.tsx`** becomes the project panel: one project at a time, plus the switcher, the live list and the other projects.
4. **New data:** the panel's live lists use the task list's existing queries (the member's active tasks, and a project's active tasks) from the same stream, with no new endpoint. `Recent` is local to the browser.
5. **Messages:** new keys under `shell.rail.*`, `shell.panel.*` and `shell.tabs.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The organization tile:** the Hinge with a monogram chip (as drawn), or the organization's monogram alone, as Multica and Linear do. Recommended as drawn: the Hinge stays the panel's one logo, and the chip shows which organization a multi-organization member is in.
2. **Pinned projects in the rail** (the m8 spec's ticket 10 lists them there): a square per project below the spaces, or the Projects space alone, as drawn. Recommended as drawn: with 18 projects the rail would scroll, and the panel's `Other projects` and the switcher are one click away.
3. **The org label** `Org` under the icon, its tooltip `Organization`. "Organization" doesn't fit 54px at 11px.
4. **The phone:** a tab bar plus a panel sheet, as drawn and as Multica's native app does, or Multica's web pattern of one sheet holding the rail and the panel. Recommended as drawn: on a phone, ostra is mostly Needs you (F-075), one tap from anywhere.
5. **The collapse key:** `[`, as Linear has it, since ostra's shortcuts are single keys and `g` sequences. Multica uses ⌘B, which some browsers take.

## Wrong in the image (build from this file)

- **The live rows' line 2** truncates the agent's activity at 240 wide (`Editing panel…`). That's right for the width. The full line is the row's `title` and its accessible name.
- **`shell-phone.webp`, picture 1:** the needs-you line 2 is all `--amber-text`, including the command. Build the key in `--faint`, then the kind in `--amber-text`, then the command in `--muted` mono, as the desktop row does.
- **`shell-home.webp`:** Home's page keeps its `New task` primary while the rail's new-task button is primary too. That's two Shell fills, as the approved `../m7/light-home` already has. Keep both: the rail's is the shell's, not the page's.
