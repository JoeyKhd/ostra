# Target: the double-sidebar shell (approved 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912) and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. Both are rendered with Playwright from `html/` with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. To re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `shell-home.webp` | Alex Kim (an admin of Acme Corp, and a member of a second organization) on Home. The rail's **Home** is lit. The panel is Acme Corp's: Overview (selected), Board, All tasks, Alex's four live tasks (one needs them) and three recent ones. The page is Home's Overview (`../m1/home.md`, with m3's toggle), unchanged. |
| `shell-home-light.webp` | The same, in the light theme (`../m7/light-home.md`'s tokens). |
| `shell-project-tasks.webp` | **Projects** is lit, with `calculator` open. The panel is the project's: its pages (Tasks selected, Needs approval's amber count), its five live tasks, and three other projects with their amber dots. The page is the project's task list (`../m1/project.md`), unchanged. |
| `shell-project-tasks-light.webp` | The same, in light. |
| `shell-peek.webp` | The panel is collapsed (`[`): the page takes the width, and the top bar gains the button that docks it again. The pointer rests on **Org** in the rail, so the Organization panel floats over the page: a peek. |
| `shell-phone.webp` | Two 390×844 screens, dark, with no bottom tab bar: (1) the project's tasks, the menu closed: the top bar's menu button with its amber dot, the breadcrumb `calculator › Tasks` and `plus`; (2) a task with Chat and Preview as one segmented choice (`task-preview.md`, "Phone"), under the same top bar. |
| `shell-phone-menu.webp` | The menu button has opened the sheet over (1): the rail (Projects lit, Needs you's `5`) and the project's panel side by side, with a strip of the dimmed page at the right. Dark on the left, light on the right. |

- **Where it comes from:** the maintainer, 2026-11-21: "i like the ux of multica a lot, their double sidebar is nice". Multica's structure is in `context/research/multica-ui.md`. This target takes the structure (a rail of spaces, a contextual panel, one-key collapse with a peek, a sheet on the phone), and keeps ostra's own look: flat graphite, no content card, amber only for "needs you", the Hinge.
- **Route:** every route of milestones 1 to 7 stays where it is. This changes `apps/web/src/components/shell/` (`app-shell.tsx`, `sidebar.tsx`, `project-nav.tsx`, `nav-link.tsx`, `page-frame.tsx`, `destinations.ts`) and nothing under `app/`.
- **Features:** F-146 (the double sidebar), proposed by the milestone 8 spec (`context/specs/m8-previews-and-library/`, ticket 10), and not in `features.md` yet. Also F-075 (touch sizes), F-080 and F-081 (the palette, the shortcuts, the keyboard walk) and F-082 (both themes).
- **Status: approved 2026-11-21** (the maintainer: "yes to all"), with the phone redrawn the same day without a tab bar ("no need for a bottom tab bar btw"). Ticket 10 builds it. Every other milestone 8 target is drawn in this shell.

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

## Phone (`shell-phone.webp`, `shell-phone-menu.webp`)

*Changed 2026-11-21. The maintainer: "no need for a bottom tab bar btw". The first draft's tab bar is gone: the menu button opens the rail and the panel together, as one sheet, which is Multica's web pattern (`context/research/multica-ui.md`, "On a phone").*

Below 768px; drawn at 390×844. Every control is at least 44px tall (F-075, `globals.css`'s `pointer: coarse` rule).
1. **The top bar,** 54px, on every page, a task's included. `--bg`, a 1px `--line` under it, padding `0 6px`:
   - **Left, the menu button:** 44×44, Lucide `menu` at 20px in `--muted` (`page-frame.tsx` has it today).
     - Its accessible name is today's `Open navigation`. While something needs the member, it's `Open navigation, {n} need you`.
     - It has `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls` naming the sheet.
   - **The menu button's amber dot:** 8px `--amber`, at `top 10px; right 9px` of the button, with a 2px `--bg` ring. In light it adds `--dot-amber`'s 1px inset edge.
     - It shows while the member's needs-you count is above 0. The count comes from the query that feeds the rail's count.
     - It's the top bar's only amber.
   - **The breadcrumb,** as the desktop top bar's, at Plex Sans 16px: the parents in 500 `--muted`, Lucide `chevron-right` 15px `--faint` between, and the page in 600 `--text` (`calculator › Tasks`).
     - A parent is a link. The parents truncate first.
     - On a task, it's the title (600 15px) over mono 12px `--faint` `CALC-192 · ● Running` (`task-preview.md`, "Phone").
   - **Right, the page's one main action,** a 44px icon button: `plus` (`New task in calculator`) on a project's pages, `ellipsis` on a task. A page with no main action leaves the place empty.
2. **No bottom tab bar.** The page runs to the bottom of the screen, and a task's composer docks there (`shell-phone.webp`, picture 2).
3. **The sheet** (`shell-phone-menu.webp`): the menu button opens one sheet from the left. It holds the rail and the open space's panel, side by side.
   - **Size:** the screen's width less 56px, full height. That's 334 at 390: the rail's 64, and the panel at the sheet's full width beside it, 270.
     - The 56px strip of the page left at the right is what a tap outside lands on.
     - On a wider phone the sheet stops at 384 (the rail plus the panel's widest, 320): `min(100vw - 56px, 384px)`.
   - **Surface:** the rail on `--side` and the panel on `--bg`, with a 1px `--line-2` right edge and `--shadow-pop`. `--scrim` covers the page.
   - **Motion:** it slides in with the repo's `Sheet`, and appears at once with `prefers-reduced-motion`.
   - **The rail,** as on desktop with touch sizes:
     - padding `5px 0 10px`, so the tile lines up with the panel's 54px head;
     - the tile, Search, Settings and the account each in a 44×44 target;
     - New task, a 36×36 `--primary` fill with an 8px radius and 4px above and below;
     - the spaces at 54×52.
     - **Needs you keeps its amber count** (`5` in the picture), and Projects is lit on a project.
     - **The foot** keeps Settings and the account, so the sheet needs no other foot.
   - **The panel:** the open space's, as on desktop, with phone sizes.
     - **Head:** 54px, padding `0 4px 0 14px`. It has the title or the project switcher at 16px, then one 44×44 `x` (`Close navigation`, Lucide 19px `--muted`).
     - **Not in the sheet:** the head's `plus` and `panel-left-close`. The top bar has the page's action, and the sheet doesn't collapse.
     - **Rows:** 44px, padding `0 10px`, a 12px gap, Plex Sans 500 15px with 18px icons. Counts are mono 12.5px, and the amber pill is 20px.
     - **Section labels:** 12.5px, padding `16px 10px 4px`.
     - **Live rows:** padding `7px 10px`. The title is 15px/21px, and line 2 is mono 12.5px/18px.
     - **Scrolling:** the panel's body scrolls on its own, and the rail doesn't.
   - **What a tap does:**
     - A panel row or a live task opens that page.
     - A rail space opens its last page, as a click does on desktop ("What a space opens").
     - New task opens `/tasks/new`.
     - Search opens the palette full-screen (`../m7/command-palette-phone`).
     - Each of those closes the sheet.
     - The organization tile, the project switcher and the account open their menus inside the sheet, and it stays open until a choice is made.
   - **It closes** on Escape, a tap on the scrim, the `x`, and after a page is chosen (any navigation). There's no swipe to close: the repo's `Sheet` has none.
4. **Needs you is two taps from anywhere:** the menu button, which carries the dot, then Needs you in the rail, which carries the count.

## Keyboard

- **Landmarks:** the rail and the panel are each one `nav`, and the page is `main`. Tab goes rail → panel → page.
- **Inside the rail:** one tab stop with a roving focus. ↑ and ↓ move through the tile, the tools, the spaces, Settings and the account; Home and End jump to the ends. Enter or Space opens.
- **Inside the panel:** ↑ and ↓ move between rows, skipping section labels; Enter opens. On a project, the head's switcher is the first stop.
- **Shortcuts:** added to milestone 7's one registry, so the `?` sheet lists them (`../m7/shortcut-sheet.md`).
  - **New:** `[` hides or shows the panel, `g p` goes to Projects and `g o` to the Organization.
  - **Unchanged:** `g h`, `g n`, `g t`, `c`, `/`, `?` and ⌘K.
- **Tooltips:** on the rail's items, after 500ms of hover or at once on focus. Each gives the full name and its shortcut. A tooltip never replaces the accessible name.
- **Focus:** the panel's 2px `--teal` `:focus-visible` outline (`globals.css`), on the 6px radius of a row and the 9px radius of a space.
- **The phone sheet** is a modal dialog: the repo's `Sheet` (Radix Dialog), `role="dialog"` with `aria-modal="true"`, named `Navigation` (today's `shell.navigation`).
  - **On open,** focus goes to the current page's row in the panel (the one with `aria-current="page"`). With no such row, it goes to the lit space in the rail.
  - **Focus is trapped in the sheet.** Tab goes rail → the panel's head (the switcher, then `x`) → the panel's rows, then wraps to the rail. Shift+Tab goes back.
  - **The page behind** is `inert`, so a screen reader doesn't reach it either.
  - **Inside,** the rail and the panel keep their arrow keys (above).
  - **On close,** whichever way it closes, focus returns to the menu button. That holds after a navigation too: the top bar stays, and Next.js's route announcer reads the new page's title.

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
| **Nothing needs you (phone)** | The menu button has no dot, and its name is plain `Open navigation`. The rail's Needs you shows no count |
| **Light theme** | `shell-home-light.webp`, `shell-project-tasks-light.webp`, and the right of `shell-phone-menu.webp`: `../m7/light-home.md`'s tokens. The rail on `--side` `#F3F3F5`, the panel and page on `--bg` `#FAFAFB`, the abyss Hinge, `--primary` `#141518` on the new-task button |

## Components (shadcn/ui names)

- **From the repo:** `Sheet` (the phone's menu sheet and the 768–1023 overlay), `DropdownMenu` (the switchers, the user menu), `Tooltip`, `nav-link.tsx`, `user-menu.tsx`, `shortcut-sheet.tsx` and the action registry, `destinations.ts`.
- **New:**
  - `components/shell/rail.tsx`: the rail, its spaces and its foot;
  - `components/shell/context-panel.tsx`: head, body and resize;
  - `components/shell/panels/{home,needs-you,project,projects,organization,settings}.tsx`;
  - `components/shell/live-task-row.tsx`;
  - `components/shell/peek.tsx`;
  - `components/shell/nav-sheet.tsx`: the phone's menu button, its dot, and the sheet holding `rail.tsx` and `context-panel.tsx`.

  A space is a union `"home" | "needs-you" | "projects" | "organization" | "settings"`, derived from the route in `destinations.ts`. Every `switch` over it is exhaustive.
- **Icons** (Lucide, stroke 1.75): `house`, `bell`, `folder`, `building-2`, `settings`, `plus`, `search`, `panel-left-close`, `panel-left-open`, `menu`, `x`, `chevron-right`, `chevrons-up-down`, `list-filter`, `layout-dashboard`, `square-kanban`, `list-checks`, `blocks`, and today's page icons.

## Tokens

These are `globals.css`'s, in both themes, and the shell adds none. `--side` is the rail. `--bg` is the panel and the page. `--sel` is the lit space and the page's row. `--hover` is hover. `--line` is the edges, `--raise` with `--line-2` and `--shadow-pop` is the peek, and `--scrim` is behind the sheet. `--amber` and `--on-amber` are only Needs you's count, the Needs approval pill and the dots (the phone's menu-button dot among them); `--amber-text` is the needs-you words. `--primary` is only the new-task button.

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
| `--muted` on `--bg` (the phone's breadcrumb parents and top-bar icons) | 9.6:1 | 8.1:1 | 4.5 |
| `--amber` on `--bg` (the menu button's dot, a graphic) | 10.7:1 | 1.7:1, and 3.2:1 for its `--dot-amber` edge | 3 |

## Differences from the current code

1. **`app-shell.tsx`:** the grid becomes `64px | panel | 1fr`. The 234px `<aside>` goes. Below 768px, its phone drawer becomes the menu sheet, which holds the rail and the panel.
2. **`sidebar.tsx`** splits into the rail and the panels. Its role gates move unchanged with their rows.
3. **`project-nav.tsx`** becomes the project panel: one project at a time, plus the switcher, the live list and the other projects.
4. **New data:** the panel's live lists use the task list's existing queries (the member's active tasks, and a project's active tasks) from the same stream, with no new endpoint. `Recent` is local to the browser.
5. **Messages:** new keys under `shell.rail.*` and `shell.panel.*`. The phone keeps today's `shell.openNavigation` and `shell.navigation`, and adds the menu button's name with the needs-you count.

## Open points (recommendations; the maintainer's approval settles them)

1. **The organization tile:** *settled 2026-11-21, as drawn: the Hinge with a small letter chip, not a plain letter tile* (the maintainer approved the targets: "yes to all"). The other choice was the organization's monogram alone, as Multica and Linear do. The Hinge stays the panel's one logo, and the chip shows which organization a multi-organization member is in.
2. **Pinned projects in the rail:** *settled 2026-11-21, as drawn: one Projects space in the rail, not pinned projects* ("yes to all"; ticket 10 now says so). With 18 projects the rail would scroll, and the panel's `Other projects` and the switcher are one click away.
3. **The org label** `Org` under the icon, its tooltip `Organization`. "Organization" doesn't fit 54px at 11px.
4. **The phone:** *settled 2026-11-21: no bottom tab bar* (the maintainer: "no need for a bottom tab bar btw"). One sheet holds the rail and the panel, Multica's web pattern, redrawn in `shell-phone.webp` and `shell-phone-menu.webp`. Needs you stays two taps away, with the menu button's amber dot ("Phone").
5. **The collapse key:** `[`, as Linear has it, since ostra's shortcuts are single keys and `g` sequences. Multica uses ⌘B, which some browsers take.

## Wrong in the image (build from this file)

- **The live rows' line 2** truncates the agent's activity at 240 wide (`Editing panel…`). That's right for the width. The full line is the row's `title` and its accessible name.
- **`shell-home.webp`:** Home's page keeps its `New task` primary while the rail's new-task button is primary too. That's two Shell fills, as the approved `../m7/light-home` already has. Keep both: the rail's is the shell's, not the page's.
