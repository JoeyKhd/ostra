# Target: a project's runners (milestone 5, screen 7)

> **Committed image:** `project-runners.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `project-runners.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: `app-targets/m4/project-access`'s 2048 original (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[slug]/settings/runners/page.tsx` (ticket 32 names `[slug]`; use the segment milestone 4's settings routes use on `main`) → `components/projects/project-runners-view.tsx`. A new tab in the project's settings row, between `Access` and `Audit log`.
- **Features:** F-069 (choosing a runner), F-095 (box sizes), F-086 (projects: the pool list in order, with its shares). Spec section 12, screen 7; section 3, step 1 (and steps 6 and 7 for what the order and the share do); section 11, items 4, 6 and 7. Ticket 27 (`projects.setPools`, `projects.setDefaultBoxSize`, `boxSizes.list`), ticket 32 (this screen). ADR 0059.
- **Status:** a proposed target, waiting on approval (ticket 29's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A project admin decides where the project's tasks run. The page answers four questions, in this order:

1. **Which pools may this project use, and in what order?** ostra tries the project's pools in this order (Q235): in each, the fitting runner with the most free room. The order is the list's, and it's changed by drag or by keyboard.
2. **How much of each pool may it hold?** A share is a cap in boxes per project and pool (`ProjectPool.maxBoxes`), none by default (Q233). A project at its share is passed over, so another project's task starts. The row shows how many boxes the project holds there now, against the share.
3. **What size do its boxes get?** One of the organization's three sizes (Q236). A task can't pick another in v1.
4. **What about members' own machines?** A member's personal runner takes only the tasks that member starts and picks it for. Those don't use this list or its shares, and tasks no member started go only to these pools (Q235).

Every change applies at once and writes an audit entry (ticket 27). There's no Save button.

The picture shows Alex Kim, an organization admin, on `calculator`: three pools in order, `build-fleet` at its share of 2, `k8s-east` being moved with the keyboard, `Default` without a share, and `small` as the default size.

## Layout (CSS px at 1440 wide)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | as the shell. The open project expands into its rows, `Settings` (Lucide `settings`) selected (`--sel`) |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Settings › Runners`. **No button:** each change applies on its row |
| Main column | flexible, padding `28px 40px`, content `max-width: 760px` | the settings tabs, title, lede, Pools, Default box size, the personal runners line |
| Properties panel | 300px (no form in it), 1px `--line` on its left, padding `20px 18px` | the project's use, the organization's sizes, the last change |

### Main column, top to bottom

1. **Settings tabs,** as `m4/project-access`: `Ticket template`, `Repos`, `Access`, `Runners`, `Audit log`, each a link (`/settings/runners` for this one). `Runners` is for project admins and organization admins; a project member doesn't see it (the pools and shares are an admin's settings; the member sees where their task runs on the task page).
2. **Title** `Runners`, Manrope 700 24px, letter-spacing −0.015em, 24px under the tabs.
3. **Lede,** 13.5px `--muted`, one line: `Where calculator's tasks run: the pools ostra tries, in this order, and how much of each it may take.`
4. **Pools** (26px below). Section line: `h2` `Pools` 13px 600, the count in faint mono 11.5px. Then the list, a `Table` with no box:
   - Header row 30px, 11.5px `--faint`, 500: an empty handle column, `Pool`, `Share`, `In use`, an empty last column.
   - Body rows 44px, 1px `--line` under each. One grid: `56px 1fr 200px 220px 72px`.

| Column | Contents |
|---|---|
| Handle | the drag handle, a 24px ghost button with Lucide `grip-vertical` 15px `--faint` (`aria-label="Move build-fleet"`, `aria-roledescription="sortable"`), then the position in Plex Mono 12.5px `--faint` |
| Pool | the pool's name (Plex Sans 500 13px `--text`, as `m1/runners` sets pool names), then an outline `Badge` in Plex Mono 11px `--faint` with its executor: `docker`, `kubernetes` or `host`. A pool whose runners use more than one executor shows each. The name links to the pool's page (`m5/pool`) for organization admins; plain text for a project admin who isn't one |
| Share | a Plex Mono `Input`, 56×28px, `--surface`, 1px `--line-2`, 7px radius, the share or empty with the placeholder `–`; then 12.5px `--faint`: `of 6 boxes` (the pool's cap, `RunnerPool.maxBoxes`) or, with no share, `no cap`. In a pool with no cap of its own, the hint after a value reads `boxes`. Saves on Enter or blur through `projects.setPools` with the whole list; Escape restores the saved value. A whole number from 1 to the pool's cap (or 1 to 999 without one) |
| In use | with a share: the meter (below), 120px, then Plex Mono 12.5px `--text` `2 / 2`, and at the share, 12.5px `--muted` `at share`. Without a share: no meter, Plex Mono `0` and 12.5px `--muted` `running` |
| Remove | a ghost `Button`, 24px, `--muted`: `Remove`, right-aligned. Opens the remove dialog |

   - **The meter** (the `dataviz` skill; one series, so no legend: the number beside it is the direct label). A plain `div` with `role="meter"`, `aria-valuenow` the boxes held, `aria-valuemax` the share, `aria-label="calculator's boxes in build-fleet"`. 6px tall, 3px radius, track `--line`, fill `--chart` (Mist `#CFD8D4`) to `held ÷ share`, at least 4px when one box is held. At the share the fill is the whole track and stays Mist: being at a share is the setting working, not an error, so no red and no amber. Hover or focus shows a `Tooltip`: `calculator holds 2 of its 2 boxes in build-fleet. Its next task there waits for one of them.` (at the share) or `calculator holds 1 of its 4 boxes in k8s-east.` A held count can exceed a share that was just lowered: the fill stays full and the number reads `3 / 2`; the boxes finish, none is stopped.
   - **Light theme** (when the panel gains one; app-design defines dark only): surface `#FFFFFF`, track `#E6E8EA`, fill `#56625D`. Both fills pass the `dataviz` validator's 3:1 contrast against their surface (run on 2026-11-19); its lightness and chroma checks are for categorical palettes and don't apply to a one-series meter.
   - **Reorder by drag:** the handle starts a drag of the whole row (`--sel` fill, 6px radius, the other rows shift); dropping saves the new order at once. Built with the browser's pointer events on the handle; no new dependency without the maintainer's yes.
   - **Reorder by keyboard:** Tab reaches each handle. Space or Enter lifts the row (the picture's row 2: `--sel` fill and a 1px `--line-2` focus ring on the handle); ↑ and ↓ move it; Space or Enter drops and saves; Escape puts it back. A visually hidden live region (`aria-live="polite"`) says each step: `build-fleet lifted, position 1 of 3.`, `build-fleet moved to position 2 of 3.`, `build-fleet dropped at position 2 of 3.`, `Move cancelled.`
   - **Add pool,** one line 12px under the last hairline (as `m4/project-access`'s Add member): `Add pool` (12.5px `--muted`), a `Select` 240px × 28px of the organization's pools not on the list (each its name and its executor badge), and an outline `Button` `Add` (28px). The new pool goes last, with no share. With every pool listed, the select shows `Every pool is listed` and is disabled, and `Add` too. Organization admins make pools on Runners, not here.
   - **The hint,** 8px under the Add line, 12px `--faint`: `Drag a pool by its handle, or focus the handle and press ↑ or ↓. A share is the most boxes calculator holds in that pool at once.`
5. **Default box size** (32px below). `h2` 13px 600, then 12.5px `--muted`: `Every task in calculator gets this size. A task can't pick another.` A `RadioGroup` of three hairline rows, 36px, no box: a 16px radio, the size's name (13px 500 `--text`, a 90px column), then its values in Plex Mono 12.5px `--muted`: `2 vCPU · 4 GB`, from `boxSizes.list` (`cpuMillis ÷ 1000`, `memoryMiB ÷ 1024`, whole numbers or one decimal). The chosen row has the `--sel` fill and a 6px radius. Choosing one calls `projects.setDefaultBoxSize` at once (no dialog: it applies to new boxes only). Under the rows, 12px `--faint`: `host pools count slots, not sizes: there a task takes one slot whatever its size.` (`host` in Plex Mono). The line shows only when one of the listed pools has a `host` runner, or always when none of the list's executors is known yet.
6. **The personal runners line** (24px below), no box: Lucide `laptop` 13px `--faint`, then 12.5px `--muted`: `Members can also send their own tasks to their own machine. Those skip this list and these shares; tasks nobody started go only to these pools.`

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s (key column 104px, 12.5px; key `--muted`, value `--text`). Values are Plex Sans; numbers in Plex Mono.

1. **{project name}** (`calculator`):
   - `Pools` · `3 allowed`
   - `Running now` · `3 boxes`: the project's boxes that hold a slot, across its pools (spec section 5.4's count)
   - `Waiting` · `4 tasks`: its queued tasks in any of its pools, or `none` in `--faint`
   - `Default size` · `small`
2. **Box sizes:** one row per size, the name as key and Plex Mono values, the project's default not marked again (the radio says it). Under them a teal link `Box sizes →` to `/organization/box-sizes` (`m5/box-sizes`), for organization admins only.
3. **Last change:** the newest audit entry of `project.pools-set` or `project.box-size-set` for this project (ticket 10's list owns the names; these are this file's proposal) as one 12.5px `--muted` sentence (`Alex Kim set calculator's share of build-fleet to 2`, `Sam Rivera moved k8s-east to position 1`, `Alex Kim added gpu-lab`, `Alex Kim set the default size to small`) with its age in Plex Mono `--faint` at the right. Under it a teal link `Audit log →` to the project's `Audit log` tab filtered to those actions.

## States and copy

| State | What shows |
|---|---|
| **Pools listed** (the picture) | as above |
| **One pool** (a fresh project: the organization's `Default`, milestone 4's seed) | one row; the handle is disabled (`aria-disabled`, `--faint` at 50%), and the hint reads `A share is the most boxes calculator holds in that pool at once.` only |
| **No pools** | the count `0`, one 44px row in 13px `--faint`: `No pools. calculator's tasks wait until one is added; members' own machines still run theirs.` and the Add line under it |
| **Reordering** | as above; on drop the row shows a 12px `Loader` in the handle's place until saved. On success a 12.5px `--muted` status line under the hint, `role="status"`, Lucide `check`: `Saved. build-fleet is first.` gone after 4s |
| **Share saved** | the status line: `Saved. calculator may hold 2 boxes in build-fleet.` / `Saved. calculator has no cap in Default.` |
| **Invalid share** | the input gets a `--red` border and, under the row, 12px `--red`: `A whole number from 1 to 6, or empty for no cap.` Nothing is saved |
| **Remove** | `AlertDialog`: title `Remove build-fleet from calculator?`, body `calculator's tasks won't start there any more. Its 2 running tasks there keep running, and its 3 queued tasks there move to the next pool in the list.` (counts from the project's use; with none, `Nothing of calculator's runs there now.`); buttons `Cancel` and `Remove` (destructive: `--red` text on `--surface`). Removing the last pool adds: `calculator will have no pool. Its tasks wait until one is added.` |
| **A `kubernetes` pool without a registry** | under the pool's name in that row, 12px `--muted` (not amber: nobody is waiting on this page): `needs a registry for snapshots` and, for organization admins, a teal `Registry →` to `m5/registry`. The row is 56px |
| **A `host` pool** | its badge `host`; the In use column counts slots the same way. The size line shows (item 5) |
| **Default size changed** | the status line under the radio group: `Saved. New boxes in calculator get medium.` Boxes already running keep theirs |
| **Error** | under the section that failed, `role="alert"`, 12.5px `--red`: `errorText(error)`. The list returns to its saved order, the input to its saved value |
| **Loading** | tabs, title and lede at once; the table shows three 44px `Skeleton` rows; the radio rows render with skeleton values; the panel's values are skeleton bars |
| **A project member** | no `Runners` tab, and `/settings/runners` redirects to the first tab they may open |
| **Narrow (below 1280px)** | the panel drops under the page (`PageFrame`). Below 640px each pool is a two-line row: handle, position, name and badge on the first line; the share input, its hint and `Remove` on the second, with the meter full width under them. The keyboard reorder stays the same |

The demo data in the image (fixtures, not real): the organization `Acme Corp`, the project `calculator`, the pools `build-fleet` (`docker`, cap 6), `k8s-east` (`kubernetes`, cap 20), `Default` (`docker`, cap 8) and `gpu-lab` (not listed), the default sizes (2/4, 4/8, 8/16). The real demo (spec step 1) uses `test1` with `build-fleet` then `Default`, `test1`'s share of `build-fleet` at 2 and its size `small`.

## Components (shadcn/ui names)

- The shell: `Sidebar` and its parts as in `m1/project.md`, `Breadcrumb`.
- `Tabs` as links (the settings row, shared with `m4/project-access` and `m4/project-repos`)
- `Table` and its parts (already in `components/ui/`), `Badge` outline (the executor), `Input` (share), `Select` (Add pool), `Button` (`ghost` handle and Remove, `outline` Add)
- `RadioGroup`, `RadioGroupItem` (default size), `AlertDialog` (remove), `Tooltip` (the meter), `Skeleton`, `PageFrame`, `PropGroup`, `PropRow`, `Separator`
- The meter: a plain `div role="meter"` as `m4/spend-budgets`' 6px bar, or that ticket's restyled `Progress` if it landed
- Icons: Lucide 15px, stroke 1.75: `settings`, `grip-vertical`, `laptop`, `check`, `chevron-down`, `arrow-right`, `loader`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | share inputs, selects, the destructive button's fill, skeletons |
| `--sel` | `#1A1B1E` | the lifted row, the chosen size, the `Settings` nav row |
| `--line` | `#1F2023` | row hairlines, the tab row's line, the meter's track, panel edge |
| `--line-2` | `#2A2C30` | control borders, the handle's focus ring, executor badges |
| `--text` | `#EDEDEE` | pool names, held counts, size names, the active tab |
| `--muted` | `#9A9DA3` | lede, `at share`, `running`, size values, the personal runners line, keys |
| `--faint` | `#64676D` | positions, handles, `of 6 boxes`, table heads, the hint, the `host` line |
| `--chart` | `#CFD8D4` (Mist) | the meter's fill |
| `--teal` | `#6FB8AA` | `Box sizes →`, `Audit log →`, `Registry →` |
| `--red` | `#E5675C` | an invalid share, errors, `Remove` in its dialog |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |

No green and no amber on this page: a share reached is the setting doing its job. Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels and heads, 600 for section titles, 500 for labels and buttons; IBM Plex Mono for executors, positions, shares, counts, sizes and ages.

## Data this screen needs beyond ticket 27

- `projects.pools(projectId)`: the list in order, each with its `poolId`, name, executors (from its runners), the pool's `maxBoxes`, the project's share and **the boxes the project holds there now** (the slot-holding count of spec section 5.4), plus whether a `kubernetes` pool lacks a registry. Ticket 27 lists `setPools` but no read: add it there, behind the project-admin check.
- **The project's queued tasks** count, for `Waiting`, and per pool for the remove dialog.
- **The organization's pools not on the list**, for Add pool (names and executors only, which a project admin may read).
- **The last change:** ticket 25's `audit.list` with a project and action filter, limit 1.

## Open points (the build takes the recommendation and records it in ticket 32's `## Comments`)

1. **A removed pool's queued tasks.** Ticket 27 doesn't say. Recommended: they're queued again through `chooseRunner` in the same transaction, so they go to the next pool in the list or wait with its reason; running ones finish where they are.
2. **A share above the pool's cap.** Recommended: refused (the input's range), since it could never be reached.
3. **The audit actions' names** (`project.pools-set`, `project.box-size-set`): ticket 10 owns the list; these are a proposal.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route** `settings/runners/page.tsx` in milestone 4's settings layout, and its tab in the layout's row.
2. **No sortable list** exists in `components/ui/`. Build the handle and its keyboard model in the view (pointer events and a live region); ask before adding a drag-and-drop package.
3. **The meter** is shared with `m4/spend-budgets`; reuse whichever form that ticket landed.
4. **Messages:** a `projectRunners` namespace in `messages/en.json` for every string above, with plurals for the counts.

## Wrong in the image

Build the copy and details in this file, not these:

- **The panel's group labels** (`calculator`, `Box sizes`, `Last change`) are drawn 13px bold white. They're 11px 500 `--faint` `PropGroup` labels.
- **The panel** starts at about x=1090, about 350px. It's 300px.
- **The sidebar** reads `Medels` and draws its own Organization rows and icons. Build it from the shell (`../m1/README.md`, "One sidebar"); the Box sizes and Registry rows are `m5/box-sizes`' and `m5/registry`'s.
- **The executor badges** are drawn with a serif mono and a heavier border. They're Plex Mono 11px with a 1px `--line-2` border.
- **The Default row's input** shows a dash inside a filled field; it's the empty input's `–` placeholder in `--faint`.
- **The size rows** set the chosen row's name in 500 and the others in 400; all three are 500.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no one-pool, empty, saving, invalid, remove, registry, loading or narrow states: they're in the table above.

All visible copy in the image is spelled right except the sidebar's `Medels`.
