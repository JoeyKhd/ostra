# Target: the project's Inbox (`/projects/[project-id]/inbox`)

> **Committed images:** `inbox.webp` (tickets, one selected) and `inbox-empty.webp` (no boards yet), each downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Images:**
  - `inbox.webp`: Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. References: the approved milestone 1 originals `project.png` and `task-new.png`, `app-concepts/html/home-graphite.png`, and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `inbox.prompt.txt`.
  - `inbox-empty.webp`: a composite, not a second screen generation. The base is `inbox.webp`'s generation with its lede, filters, list and panel erased. On it sits the empty-state illustration, and the copy and button are drawn with the brand's real fonts (`fonts/`) by a script. The illustration is its own Higgsfield `gpt_image_2_6` generation (1 generation, prompt `inbox-empty.prompt.txt`). Its references were the sign-in illustration (B-017, "Deep water") and the Hinge logo. It was graded by the same script: ×0.9, then an elliptical falloff into `--bg`.
  - `inbox-empty-illustration.webp`: that graded illustration at 1120×746, for a 560×373 CSS box. It's the file the build uses. Once approved, it belongs in `files/web/` with its row in `../../assets.md`.
- **Status:** a candidate target for milestone 2, not yet approved by the maintainer (ticket 32).
- **Starts from:** `app-concepts/03-inbox.png` (its structure only: the filter row, ticket rows and a Start task form beside them), restyled to the approved graphite targets (`../m1/project`, `../m1/task-new`).
- **Features:** F-010 (the Inbox), F-007 (boards: the list's source, the mapped open statuses), F-064 (the context line), F-055 and F-060 (the start refusals). Data, from ticket 29: `inbox.list`, `inbox.get` and `tasks.startFromTicket` (`packages/api/src/routers/inbox.ts`, `tasks.ts`), plus `projects.get`, `runners.mine` and the project's default agent profile per kind. Builder: ticket 35.

## Purpose

The project's open tickets, straight from the ticket cache, and the one action that turns a ticket into a task. A member scans the list, picks a ticket, reads enough of it to know it's the right one, and starts it. The kind and the agent profile are already chosen from the project's defaults, and the runner is picked as in milestone 1. Tickets that already have a task show it, so nobody starts the same work twice. It's a working list, like Linear's: dense rows, no cards, one selected row, and its properties panel holding the one primary button.

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, the shared shell | Build it from `components/shell/sidebar.tsx`, never from the picture. The open project gains two rows: **Inbox** (`inbox` icon, between Tasks and Environment, selected here) and **Boards** (ticket 34's). The Inbox count is mono 11px `--faint`: the number of tickets matching the default filter. It's a plain count, never amber. Organization gains **Linear** (screen 1's target sets its icon and route) |
| Top bar | 44px, hairline under | Breadcrumb `calculator › Inbox`. Nothing on the right |
| Main column | `1fr`, padding `28px 40px` | Title, lede, filter row, the list |
| Properties panel | **340px** (it holds a form: `PageFrame wideProperties`), `border-left: 1px var(--line)`, padding `20px 18px` | The selected ticket, and "Start a task" |

### Main column, top to bottom

1. **Title** `Inbox` (`PageHeading`: Manrope 700 24px, letter-spacing −0.015em).
2. **Lede** (13.5px `--muted`): `Open tickets from {board} on Linear · updated {age}`. `{board}` is the board's name in `--text`. With several boards it reads `Open tickets from {n} boards on Linear · updated {age}`. `{age}` is the cache's age, from the newest of the boards' last event or last poll (`8s ago`, `4 min ago`). It ticks every second while it reads in seconds, then every minute. In polling mode it appends ` · polling every 60 s`.
3. **Filter row**, 18px under the lede: flex, gap 8px, every control **28px** tall, radius 7px.
   - **Text filter**, 240px: `Input` with a 14px `search` icon inside on the left, `--surface` fill, `--line-2` border. Placeholder `Filter by title or key`, in `--faint`. It filters as you type, debounced 250ms.
   - **Four filter triggers**: `Button variant="outline"` (1px `--line-2`, no fill, 12.5px, weight 500), each ending in a 12px `chevron-down` in `--faint`. Each opens a `Popover` + `Command` with checkable items:
     - `Status`. Default `Open`: the board's mapped open statuses. The value shows after a colon in `--text`, e.g. `Status: Open, started`.
     - `Label`
     - `Priority`
     - `Assignee`
     - A filter with a value shows it the same way (`Label: bug`, `Priority: 2`).
   - Every filter lives in the URL (`?status=open,started&label=bug&q=…`), so a filtered Inbox can be linked.
   - On the right (`margin-left: auto`): `{n} tickets` in mono 12px `--faint`. That's the total for the filter, not the page.
4. **The list**, 14px under the filters. Rows are 40px, with a 1px `--line` hairline under each. There's no header row and no box. **One CSS grid template for every row**, so every column starts at the same x:

| Column | Width | Contents |
|---|---|---|
| Priority | 16px + 14px gap | The ticket's priority icon, 14px, `--muted` (the icon set below) |
| Key | 80px | `CALC-174`, IBM Plex Mono 12.5px, `--faint` |
| Title | `minmax(0,1fr)` | 13px `--text`, one line, ellipsis |
| Labels | 150px | Up to two `Chip`s (22px, `--line-2` border, radius 6px, 12px `--muted`), left-aligned, then `+{n}` in `--faint` |
| Board | 120px, **only when the project has several boards** | The board's name, 12.5px `--muted` |
| Status | 120px | The status-type icon (13px, `--muted`) + the status's own name from Linear, 12.5px `--muted` |
| Task | 160px | Empty, or the ticket's task: the task's state mark (as on the project screen: green dot `Running`, amber dot `Needs you`, `loader-circle` `Preparing`, `circle-dashed` `Queued`, `git-pull-request` `In review`), the state word 12.5px `--text`, then the short task ID in mono 12px `--faint`. It's a link to `/tasks/{id}` |
| Age | 40px, right-aligned | Time since the ticket's last change, mono 12px `--faint` (`3m`, `2h`, `1d`) |

   - **Order:** newest change first (spec section 11, item 10). Paged by cursor: the next 50 load when the last row scrolls into view, with three `Skeleton` rows while they load. There's no "Load more" button.
   - **Selecting:** a click selects the row, and so does Enter on a focused row. `↑`/`↓` move the selection, and `Enter` opens it on a phone. The selected row gets a `--sel` fill with a 6px radius, and no border. The selection lives in the URL (`?ticket=CALC-174`). With nothing selected, the first row is selected on load.
   - **Hover:** `--raise`. **Focus:** a 2px `--muted` outline, inset.
   - A ticket's task link doesn't select the row: it navigates.

### Properties panel: the selected ticket

`PropGroup`/`PropRow` (96px key column, 30px rows, 12.5px; keys `--muted`, values `--text`), groups split by the `--line` hairline.

1. **Head line:** the key in mono 12px `--faint` on the left. On the right, a teal `Open in Linear` link with a 12px `arrow-up-right` (it opens the ticket's URL in a new tab, `rel="noopener noreferrer"`).
2. **Ticket title:** 15px, weight 600, `--text`, wrapping, 4px under the head line, 10px above the rows.
3. **Rows:**
   - `Status`: the status-type icon + the status name
   - `Priority`: the icon + `Urgent` / `High` / `Medium` / `Low` / `No priority`
   - `Labels`: the chips, wrapping
   - `Assignee`: an 18px `Avatar` + the name, or `Unassigned` in `--muted`
   - `Board`: shown only with several boards
   - `Updated`: mono `3 min ago`, with the exact time in a `title` attribute
4. **Description:** the cached description, **rendered as untrusted markdown**. That means no raw HTML, no images inline (a line `{n} images` in `--faint` instead), and links open in a new tab with `rel="noopener noreferrer"`. It's set in 12.5px/1.6 `--muted`, clamped to 4 lines, with a teal `Show more` that expands it in place (and `Show less`). With no description: `No description.` in `--faint`.
5. **Start a task**, after a hairline. The group label is `Start a task`.
   - **Kind:** a `Select`, 28px, `--surface`, `--line-2` border, radius 7px. It lists the task kinds the project has a default agent profile for, and a ticket can start `code` and `refine` (`domain-model.md`). With only one kind available, the value renders as plain text (`Code`) with no chevron.
   - **Agent profile:** a `Select`. Its value is a `bot` icon + `{agent} · {model}`. The default is the project's profile for the chosen kind, and the list holds the profiles the member may use for that kind. With F-021 not shipped, it's read-only like New task's (`../m1/task-new.md`): no chevron, and a `Tooltip` "The project's default profile for this kind."
   - **Run on:** a `Select` with milestone 1's choices and default (`../m1/task-new.md`, "Run on"): each personal runner as `laptop` + mono `{name}` + `· yours` and its state, then "The project's pools" (`server`).
   - **Context line:** 12px `--faint` with a 13px `info` icon: `The agent gets the title, the description, {n} comments and the labels.`, built from what the cached ticket holds. Images and the parent are added when present: `…, 2 images and the parent ticket.`
   - **The repo check line** (F-060, F-055), shown only when it applies, 12px with a 13px icon:
     - an unprotected default branch: `triangle-alert` in `--muted`, `acme/calculator-web's default branch isn't protected.`
     - a signed-commit repo: `circle-alert` in `--red`, `acme/x requires signed commits, which ostra doesn't support yet.` The button is then disabled.
   - **The button:** the page's one primary button. Full panel width, **32px**, `--shell` fill, `--ink` text, weight 600, `arrow-up` icon + `Start task`.

## States

| State | What shows |
|---|---|
| Ready, one ticket selected (`inbox.webp`) | As above |
| Loading | Title and lede `Skeleton` lines, the filter row drawn but disabled, 8 skeleton rows (key, title and status widths). The panel shows 5 skeleton rows and the form disabled |
| **No Linear connection** in the organization | No filter row, no panel (`.content.full`). The illustration (as below), `Linear isn't connected` (15px, 600), `An admin connects Linear once for the organization. Then a project attaches its teams as boards.` (13px `--muted`), and for admins the primary `Button` `Connect Linear` → screen 1's route. Members get no button |
| **No boards yet** (`inbox-empty.webp`) | Lede `Open tickets from this project's boards, ready to become tasks.` No filter row, no panel, no sidebar count. The illustration centred on the column (560×373 CSS box, 40px under the lede), then `No boards yet` (15px, 600, `--text`), `Attach a Linear team to this project, and its open tickets show here.` (13px `--muted`, 8px under), and for project admins the primary `Button` `Attach a board` with `plus` (32px, 16px under) → `/projects/{id}/boards`. Members see `A project admin attaches boards.` in `--faint` instead of the button |
| **Nothing open** (boards attached, the default filter returns nothing) | The filter row stays, and there's no panel. The same illustration, `Nothing open on {board}`, and `New tickets show here as they arrive.` (`--muted`). No button |
| **No match** (a filter or text narrows to nothing) | No illustration: it's not an empty place, only an empty result. One 13px `--muted` line 24px under the filters, `No ticket matches these filters.`, then a teal `Clear filters` |
| A ticket with an **active task** selected | The "Start a task" group becomes `Task`: `State` (its mark + word), `Task` (mono short ID), `Driver` (avatar + name), then an outline `Button`, full width, 32px, `arrow-right` + `Open task`. No primary button on the page |
| A ticket whose earlier task is stopped or merged | The form shows (it doesn't count: spec section 11, item 12), with a 12px `--faint` line above the button: `An earlier task, {id}, is {stopped / merged}.`, where the ID links to it |
| Starting | The button is disabled, with a 13px spinning `loader-circle` and `Starting…`. The selects are read-only |
| Started | The member stays in the Inbox. The row's Task column shows `Queued · {id}` at once, and the panel turns into the active-task state above. `tasks.startFromTicket` answers with the task's ID |
| Refused | A 12.5px `--red` line under the button with `circle-alert` and `role="alert"`, reading `errorText(error)`. A second active task reads `This ticket already has an active task, {id}.`, with the ID linking to it. The form re-enables |
| The cache is stale (Linear unreachable, or the token needs re-authorizing) | The lede's `updated {age}` turns into `--red` `Linear isn't answering. These are the tickets as of {age}.`, with a 13px `circle-alert`. The list still shows. Starting still works: it uses the cached ticket |
| Error loading the list | `role="alert"`, `--red`, `errorText(error)` where the list would be. The filters stay usable |
| Live | A change notice for the project's tickets refetches the first page and the selected ticket. A new ticket appears at the top without a reload, with no animation. The selection is kept by key |

## The ticket icon set

Lucide has no priority or ticket-status glyphs that match Linear's, and members know Linear's. Draw them once in `components/inbox/ticket-icons.tsx` as small inline SVGs on Lucide's 24-unit grid (stroke 1.75, `currentColor`), always `--muted`, never coloured, and always next to their word:

- **Priority:** three ascending bars, with 3 lit for `High`, 2 for `Medium` and 1 for `Low` (lit bars `currentColor`, unlit `--line-2`); a rounded square with `!` for `Urgent`; three dots for `No priority`.
- **Status type** (Linear's `type`, not the name):
  - `triage`: a dashed circle with a centre dot
  - `backlog`: a dotted circle
  - `unstarted`: a plain circle
  - `started`: a circle half-filled
  - `completed`: a filled circle with a check
  - `canceled`: a circle with a cross
  - The name beside it is the team's own (`Todo`, `In Review`).

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `wideProperties`), `PageHeading`, `PropGroup`, `PropRow`, `Chip`, `Status` (`components/ui/status.tsx`) and `Button`.
- **New in `components/ui/`:** `Input` (exists) with a leading icon, `Popover` + `Command` (`CommandInput`, `CommandList`, `CommandItem` with a check) for the four filters, `Select`, `Tooltip`, `Skeleton`, `Avatar` and `AvatarFallback`, and `Separator`.
- **Icons:** Lucide 15px stroke 1.75 (13px in the panel): `inbox`, `search`, `chevron-down`, `arrow-up-right`, `arrow-up`, `arrow-right`, `bot`, `laptop`, `server`, `info`, `triangle-alert`, `circle-alert`, `loader-circle`, `circle-dashed`, `git-pull-request`, `plus`, plus the ticket icon set above.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the illustration's falloff |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | text filter, selects |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | the selected row, the selected nav row |
| `--line` | `#1F2023` | row hairlines, panel border, group separators |
| `--line-2` | `#2A2C30` | control borders, label chips, unlit priority bars |
| `--text` | `#EDEDEE` | titles, values, filter values |
| `--muted` | `#9A9DA3` | lede, status names, icons, description, keys in the panel |
| `--faint` | `#64676D` | ticket keys, ages, counts, chevrons, context line |
| `--teal` | `#6FB8AA` | `Open in Linear`, `Show more`, `Clear filters` |
| `--green` | `#4FB286` | a Running task's dot |
| `--amber` | `#FFB224` | **only** a task that needs you, in the Task column (its dot), and the sidebar's project dot |
| `--red` | `#E5675C` | refusals, a stale cache, the signed-commit line |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Start task`, `Attach a board`, `Connect Linear` |

- **Type:** Manrope 700 24px for the title; IBM Plex Sans 13px rows, 12.5px panel and filters, 15px/600 for the panel's ticket title and the empty-state titles; IBM Plex Mono for keys, task IDs, runner names, ages and the ticket count.
- **Radii:** 7px controls, 6px chips and the selected row.
- **Heights:** controls 28px, the panel's button 32px, rows 40px, panel rows 30px.

## Differences from the current code

1. **There's no Inbox.** No route `app/(panel)/projects/[project-id]/inbox/`, no `components/inbox/`, no `inbox` router (ticket 29), no `inbox.*` messages. Everything here is new.
2. **Project navigation** (`components/shell/project-nav.tsx`) has only Tasks and Environment. It gains `Inbox` with its count (it needs an open-ticket count per project, from `projects.list` or `inbox.count`) and `Boards` (ticket 34). The organization section (`sidebar.tsx`) gains `Linear` (ticket 33).
3. **`components/ui/`** holds only `button`, `field`, `input`, `label`, `sheet`, `status` and `switch`. The filters and the form need `Popover`, `Command`, `Select`, `Tooltip`, `Skeleton`, `Avatar` and `Separator` (shadcn/ui, on the `radix-ui` package already used by `sheet.tsx`). Check with the maintainer before adding `cmdk` for `Command`: it's a new dependency.
4. **`PageFrame`** already has the 340px `wideProperties` column and stacks the panel below the page under `xl`. On the Inbox, below `xl` the panel isn't stacked under a long list: the selection opens it as a right `Sheet` (`components/ui/sheet.tsx`, 340px), and at phone width as a bottom sheet (`phone-inbox.md`).
5. **Start task** reuses New task's runner choice (`components/tasks/new-task-form.tsx`): pull the `Run on` logic out so both forms share it, rather than copying it.
6. **New message keys** (`apps/web/messages/en.json`):
   - `shell.inbox`, `shell.boards`, `shell.linear`
   - `inbox.title`, `inbox.lede`, `inbox.ledeBoards`, `inbox.polling`, `inbox.stale`
   - `inbox.filterText`, `inbox.status`, `inbox.statusOpen`, `inbox.label`, `inbox.priority`, `inbox.assignee`, `inbox.count`
   - `inbox.openInLinear`, `inbox.showMore`, `inbox.showLess`, `inbox.noDescription`, `inbox.images`, `inbox.unassigned`, `inbox.updated`
   - `inbox.startTitle`, `inbox.kind`, `inbox.profile`, `inbox.runOn`, `inbox.context`, `inbox.start`, `inbox.starting`, `inbox.earlierTask`, `inbox.taskTitle`, `inbox.openTask`
   - `inbox.unprotected`, `inbox.signedCommits`, `inbox.alreadyActive`
   - `inbox.noConnection`, `inbox.noConnectionBody`, `inbox.connect`
   - `inbox.noBoards`, `inbox.noBoardsBody`, `inbox.attach`, `inbox.attachMember`
   - `inbox.nothingOpen`, `inbox.nothingOpenBody`, `inbox.noMatch`, `inbox.clearFilters`
   - the priority words
   - Reuse `newTask.*` for the runner choices.

## Wrong in the image (build from this file)

The image's text is legible and spelled right everywhere. These details differ from what to build:

- **The panel is about 386px wide** (from x 1054). Build 340px (`wideProperties`).
- **The filter controls are 32px tall.** Build 28px, the house control height.
- **Priority icons:** the three `Medium` rows (CALC-170, CALC-161, CALC-165) draw all three bars lit, the same as `High`, and the two `Low` rows differ from each other. Build from the icon set above.
- **Status icons:** `Todo` is drawn as a dashed circle, like `Triage` and `Backlog`, and `In Review` as a three-quarter circle. Build by status type: `Todo` (unstarted) is a plain circle, and `In Progress` and `In Review` (both `started`) share the half-filled circle.
- **Labels column:** the `design` `ui` pair starts left of the other chips. Chips start at the column's left edge.
- **The sidebar's Inbox count** reads `9`, the number of rows under `Status: Open, started`. The badge counts the default filter (open statuses only): `7` here.
- **The sidebar's `Linear` icon** is the image model's guess. Use screen 1's target.
- **The sidebar** is drawn from the image's own shell. Build it from `sidebar.tsx`; the image's type is a little larger than 13px.
- **The ticket and task data** (CALC-157 to CALC-174, Sam Rivera, the task IDs) are demo data. Build from `inbox.list` and `inbox.get`.
- **`inbox-empty.webp`:** the copy and button are drawn by a script, so their rendering is approximate (no hinting, the `plus` drawn as two strokes). Build them with the real components. The illustration's 560×373 box is the size to build.
