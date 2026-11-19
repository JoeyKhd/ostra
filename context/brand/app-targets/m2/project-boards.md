# Target: the project's boards (`/projects/[project-id]/boards`)

- **Image:** `project-boards.webp`, 1440×956, one image pixel per CSS pixel. Downscaled from a 2048×1360 generation (3:2), a 1440×960 layout drawn at about 1.42×.
- **Prompt:** `project-boards.prompt.txt`. Higgsfield `gpt_image_2_6`, 3:2, 2k, high, 2 generations. The first used `m1/project.png`, `m1/environment.png`, `app-concepts/html/home-graphite.png` and `kit/logo/export/ostra-hinge-single-color-2048.png` as references. The second, the one kept, was a revision of the first (attached as the first image, with `m1/project.png`, `home-graphite.png` and the logo) that fixed a typo, the panel's label style and the Linear icon. The prompt file holds the revision header followed by the full first prompt.
- **Screen:** spec section 12, screen 3. Starts from `m1/project` and `app-concepts/07-project-dashboard.png`.
- **Features:** F-007 (boards), F-031 (ticket sync: the mapping, `doneBy`, the magic word). Tickets 28 (API) and 34 (web).
- **Status:** a proposed target, not yet approved by the maintainer (ticket 32's `## Comments`).

> `app-design.md` rule 5: concepts are built as real HTML, not image-model mockups. This image is a visual target for the build, not a concept to approve as-is. Build it in real HTML/React, then screenshot that build and compare it with the image.

## Purpose

A project admin connects the project to the Linear teams whose tickets it works on, and decides how ostra moves those tickets: which statuses count as open (they fill the Inbox), which status a ticket moves to when its task starts, at its first PR and when its last PR merges, whether ostra or Linear's own GitHub integration moves it to done, and the PR body's magic word. The admin should leave the page knowing, in plain sentences, what the next task will do on the ticket. Members see the same page read-only.

## Layout (CSS px at 1440×960)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | as the shell. The open project expands into `Tasks`, `Inbox`, `Environment`, `Boards` (selected, `--sel`) and `Repos`. Organization gains `Linear` (screen 1) |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Boards`. Right: the page's one primary `Button` `Save mapping` (Shell fill, Abyss text, 600, 28px tall). Disabled until the mapping changes; hidden for members |
| Main column | flexible, padding `28px 40px`, content `max-width: 760px` | title, lede, Attached, Status mapping, the ticket preview |
| Properties panel | 300px (read-only, so not the 340px form width), 1px `--line` on its left, padding `20px 18px` | Board, Linear, Statuses in the team |

### Main column, top to bottom

1. **Title:** `Boards`, Manrope 700, 24px, letter-spacing −0.015em.
2. **Lede** (13.5px, `--muted`, max 720px): `Linear teams whose tickets reach this project's Inbox. Each board maps ostra's steps to the team's statuses.`
3. **Attached** (about 24px below the lede). Section line: `h2` `Attached` (13px, 600), the count in faint mono 11.5px.
   - Rows: 38px tall, no box, a 1px `--line` hairline under each. One CSS grid for every row: `24px 1fr 72px 140px 1fr auto`.

| Column | Style |
|---|---|
| Icon | Lucide `square-kanban`, 15px, `--faint` |
| Team | the team's name, 13px, 500, `--text` |
| Key | the team key (`CALC`), Plex Mono 12.5px, `--faint` |
| Tickets | `38 open tickets`, the number in mono, the words in Plex Sans, 12.5px `--muted` |
| Activity | a 7px dot and the last poll or event, 12.5px `--muted`: green dot + `Last event 2m ago` when the connection receives webhooks; `--faint` dot + `Polled 40s ago` when it polls. The age is in mono |
| Detach | a ghost `Button` (`--muted`, no border, 24px), `Detach` |

   - The selected board's row is `--sel` with a 6px radius; hover is `--raise`. Clicking a row selects it: the mapping and the panel below show that board. The URL carries it (`?board=<boardId>`), and the first board is selected by default.
   - **Attach a team:** one line under the rows, 12px below the last hairline. `Attach a team` (12.5px, `--muted`), a `Select` 260px wide and 28px tall, then an outline `Button` `Attach` (28px). The select's options are the connection's teams from `boards.available`, each as `Name · KEY` (key in mono). A team already attached to this project is listed but disabled, with `attached` in faint text after it; a team attached to another project stays pickable and says `also on billing-platform` in faint text (a team may be a board in several projects). With no team left to attach, the select shows `Every team is attached` and is disabled.
4. **Status mapping** (28px below the Attached section). Section line: `h2` `Status mapping`, then `Calculator · CALC` in `--faint` (the key in mono). A 12.5px `--muted` note under it: `Drafted from Linear's status types. Every status of the team is in each picker.`
   - A form of hairline rows, 48px tall, grid `200px 1fr`, the control column starting at the same x in every row. Left: the step's name (13px, **500**, `--text`) and a description under it (12px, `--faint`). Right: the control.

| Step | Description | Control |
|---|---|---|
| `Open` | `Tickets the Inbox shows` | a multi-select, 360px wide, 32px tall: one chip per status (the status-type icon, the name, an `x` to remove), a chevron to open the list |
| `Started` | `When the task starts` | `Select`, 360px: the status-type icon, the status name |
| `In review` | `At the task's first PR` | `Select`, 360px |
| `Done` | `When the last PR merges` | `Select`, 360px |
| `Done is moved by` | (none) | a two-option `ToggleGroup` (segmented, 28px): `Linear's GitHub integration` / `ostra`. After it, the detected state (below) |
| `Magic word` | `In each PR's body` | a two-option `ToggleGroup`: `Closes` / `Refs`. After it, faint mono: `Closes CALC-142` (the word, then the board's key and a sample number) |

   - **The pickers list every status of the team, grouped by its category**, in Linear's order: Triage, Backlog, Unstarted, Started, Completed, Canceled. Each group is a `SelectGroup` with a `SelectLabel` (11px, 500, `--faint`), each status an item with its status-type icon. Status-type icons are Lucide, grey (`--muted`), never Linear's colours: `circle-dashed` for triage, `circle` for backlog and unstarted, `contrast` (the half-filled circle) for started, `circle-check` for completed, `circle-x` for canceled. Linear's own state colours would put yellow next to amber's meaning.
   - **The detected state** next to `Done is moved by` (12.5px): green `circle-check` + `Integration installed`, or `--faint` `circle-minus` + `Integration not installed`, or `--faint` `circle-help` + `Couldn't check: {reason}`. It's what `detectCodeHostIntegration` returned at attach time, refreshed when the page loads.
5. **What the next task does on the ticket** (24px below the form). A label in 12px `--muted`, then one numbered line per step, 12.5px `--muted`, the target status in `--text` 500. The numbers are faint mono, in a 28px column. Rebuilt live from the unsaved mapping, so the admin sees an edit's effect before saving:
   1. `When the task starts, ostra moves it to {started} and comments once with a link to the task.`
   2. `At the first PR, ostra moves it to {inReview} and links the PR.`
   3. With `doneBy: "integration"`: `When the last PR merges, Linear's GitHub integration moves it to {done}. ostra doesn't.` With `doneBy: "ostra"`: `When the last PR merges, ostra moves it to {done}.`

   With `started` and `inReview` on the same status, line 2 reads `At the first PR, the ticket stays in {inReview}, and ostra links the PR.`

### Properties panel

Group labels are 11px, 500, `--faint` (`PropGroup`), with 8px below. Rows are 30px, grid `96px 1fr`, 12.5px; key `--muted`, value `--text`. A `Separator` with 14px of margin between groups.

| Group | Key | Value |
|---|---|---|
| `Board` | `Team` | `Calculator` (Plex Sans) |
| | `Key` | `CALC` (mono) |
| | `Tickets` | `38 open` (the number in mono) |
| | `Mode` | green dot + `Webhooks`, or `--faint` dot + `Polling every 60 s` |
| | `Last event` | `2m ago` (mono), or `–` |
| | `Attached` | `18 Nov 2026` (mono, from the board's `createdAt`) |
| `Linear` | `Workspace` | the connection's workspace name (Plex Sans) |
| | `GitHub integration` | green `circle-check` + `Installed`, or `Not installed`, or `Couldn't check` |
| `Statuses in CALC` {count} | | the team's statuses, grouped by category: the category as an 11px `--faint` label, then 26px rows with the grey status-type icon, the status name (12.5px `--text`) and, right-aligned in 12px `--faint`, the step it's mapped to (`Open`, `Started`, `In review`, `Done`) or `–`. This is the same data as the pickers, read the other way round |

`GitHub integration` is 18 characters, more than a 96px key column fits at 12.5px. Let the panel's key column grow to `auto` for this group, or name the key `GitHub`.

## States and copy

| State | What shows |
|---|---|
| **Loading** | title and lede render; two `Skeleton` rows for Attached; the mapping section as five 48px skeleton rows; the panel's groups as skeleton lines |
| **No Linear connection** | No Attached section and no mapping. Under the lede, one line in 13px `--muted`: `This organization isn't connected to Linear yet.`, then a teal link `Connect Linear →` to `/organization/linear` (instance or organization admins), or for others `Ask an admin to connect Linear.` No `Save mapping` |
| **Connected, no boards** | `Attached` with count `0`, then 13px `--muted`: `No boards yet. Attach a team, and its open tickets fill the Inbox.` and the Attach line under it. No mapping section; the panel shows only the `Linear` group |
| **Attaching** | the `Attach` button reads `Attaching…`, disabled. On success the new board is selected, its drafted mapping shows, and a 12.5px `--muted` line under the Attach row says `Attached. The first poll is filling the Inbox.` until the poll finishes |
| **Mapping edited, unsaved** | `Save mapping` enabled; the preview lines show the edit. Leaving the page asks `Discard the changes to the mapping?` (`AlertDialog`: `Discard` / `Keep editing`) |
| **Saving** | `Save mapping` reads `Saving…`, disabled. Success: `toast` `Mapping saved.` |
| **A status disappeared** | a status picked in the saved mapping no longer exists on the team (renamed or deleted in Linear). The picker shows it as a chip or value with a `--red` `circle-alert` icon and its old name struck through, and the row's description becomes `--red` 12px: `This status is gone from Linear. Pick another.` `Save mapping` stays disabled until it's replaced. The server checks again on save (`boards.saveMapping`) and answers with the same message |
| **Open is empty** | the Open row's description turns `--red`: `Pick at least one status, or the Inbox stays empty.` Save disabled |
| **Save error** | a `--red` line under the preview, `role="alert"`, `errorText(error)` |
| **Detach** | `AlertDialog`: title `Detach Calculator?`, body `ostra stops polling CALC. Its tickets stay in the Inbox's history and its tasks keep their links, but no new task starts from it.`, buttons `Detach` (destructive, `--red` text, outline) and `Cancel`. After it the next board is selected |
| **Polling mode** | the row's activity is `--faint` dot + `Polled 40s ago`; the panel's `Mode` is `Polling every 60 s` |
| **Integration not installed** | detected state `Integration not installed`; the `ostra` option is preselected by the drafted mapping; preview line 3 is the `ostra` sentence |
| **Member (not a project admin)** | the same page read-only: no `Save mapping`, no `Detach`, no Attach line. The pickers render as plain values (the status-type icon and the name, 13px), the toggle groups as their chosen value. A 12px `--faint` note under the lede: `Only the project's admins change boards.` |

The demo data in the image (fixtures, not real): boards `Calculator` (`CALC`, 38 open tickets, last event 2m ago, webhooks) and `Web platform` (`WEB`, 12, polled 40s ago); the team `Mobile · MOB` in the Attach select; CALC's statuses Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate; the workspace `acme`. The real demo uses team `OST` in `ostra-test`.

## Components (shadcn/ui names)

- The shell: `Sidebar` and its parts as in `m1/project.md`, `Breadcrumb`.
- `Button` (`variant="primary"` for `Save mapping`, `outline` for `Attach`, `ghost` for `Detach`)
- `Select`, `SelectTrigger`, `SelectContent`, `SelectGroup`, `SelectLabel`, `SelectItem` (the single pickers and the Attach select)
- The `Open` multi-select: a `Popover` with a `Command` (`CommandInput`, `CommandGroup` per category, `CommandItem` with a check), and `Badge` (`variant="outline"`) chips in the trigger. shadcn/ui has no multi-select of its own; build it from these.
- `ToggleGroup` with `ToggleGroupItem` (`Done is moved by`, `Magic word`)
- `AlertDialog` (detach, discard changes), `Sonner` `toast` (saved)
- `Skeleton` (loading), `Separator` (panel groups)
- The repo's `PageFrame`, `PropGroup`, `PropRow` and `Status` dot (`components/shell/page-frame.tsx`, `components/ui/status.tsx`)
- Icons: Lucide 15px, stroke 1.75: `square-kanban`, `chevron-down`, `x`, `circle-dashed`, `circle`, `contrast`, `circle-check`, `circle-x`, `circle-minus`, `circle-help`, `circle-alert`, `arrow-right`. The sidebar's `Linear` row uses Linear's mark from the brand's integration icons, not a Lucide glyph.

## Tokens (`app-concepts/html/graphite.css`)

`--bg #0D0E10`, `--side #0A0B0C`, `--surface #131416` (selects, chips, the toggle groups), `--raise #17181B` (row hover), `--sel #1A1B1E` (selected board, the toggle's chosen option), `--line #1F2023`, `--line-2 #2A2C30` (control borders), `--text #EDEDEE`, `--muted #9A9DA3`, `--faint #64676D`, `--green #4FB286` (webhooks dot, installed check), `--teal #6FB8AA` (`Connect Linear →`), `--red #E5675C` (a status that's gone, errors, Detach's confirm), `--shell #F3F0E8` / `--ink #0C1D21` (`Save mapping`). **No amber on this page**: nothing here waits on the member. Radii: 7px controls, 6px selected row and chips, 8px popovers.

Type: body 13px Plex Sans; descriptions and panel 12–12.5px; title Manrope 700 24px; section titles Plex Sans 600 13px; step names 500; keys, counts, ages, dates and the magic-word sample in Plex Mono.

## Differences from the current code

1. **The route and its files are new:** `src/app/(panel)/projects/[project-id]/boards/page.tsx`, `src/components/boards/` (`boards-view.tsx`, `board-mapping-form.tsx`, `board-properties.tsx`, `status-icon.tsx`). It reads `boards.available`, `boards.get`, and writes `boards.attach`, `boards.saveMapping`, `boards.detach` (ticket 28).
2. **`ProjectNav` gains rows.** Today the open project expands into `Tasks` and `Environment` only (`components/shell/project-nav.tsx`). Milestone 2 adds `Inbox` (screen 4), `Boards` (this screen, `square-kanban`) and `Repos` (screen 8, `git-branch`), in the order `Tasks, Inbox, Environment, Boards, Repos`. `app-design.md` puts Repos and Settings last; Boards sits before Repos until a Settings page exists.
3. **New UI primitives:** `components/ui/` has only `button`, `field`, `input`, `label`, `sheet`, `status` and `switch`. This screen needs `select`, `popover`, `command`, `badge`, `toggle-group`, `alert-dialog`, `skeleton` and a toast. `radix-ui` (1.8.1) is already a dependency of `apps/web`, so the Radix-based shadcn/ui sources add no package, but `cmdk` (for `Command`) and `sonner` (for the toast) are packages: ask the maintainer before adding them, or build the multi-select as a `Popover` with a checkbox list and use an inline status line instead of a toast.
4. **The project's properties panel** (`project-properties.tsx`) should gain a `Boards` row under `Runs`: the boards' keys (`CALC, WEB`) as a teal link to this page, or `–`. That's the project page's change, noted here because this screen is where it leads.
5. **Copy:** every string above is new, under a `boards` namespace in `messages/en.json`.

## Wrong in the image (use the copy and sizes above, not the pixels)

- **The panel is too wide:** it starts at about x=1090, about 350px. It's 300px (`app-design.md`: 340px only when it holds a form).
- **Step names are bold.** They're weight 500, like nav. Only the section titles (`Attached`, `Status mapping`) are 600.
- **Mono where it shouldn't be:** `38 open tickets` and `Last event 2m ago` render wholly in mono, and the panel's `acme` and `38 open` too. Only the numbers, keys, ages and dates are mono; the words are Plex Sans.
- **The panel's `Statuses in CALC` rows** are taller (about 28px) and their names larger than 12.5px. Use 26px rows and 12.5px names.
- **The step column** is about 250px wide in the image, and the selects start at x≈522. Use the `200px 1fr` grid, so the controls start at x≈472.
- **Status-type icons:** the image draws `In Progress` and `In Review` as half-filled circles and `Done` as a filled check, which is close; use the Lucide icons listed above, all `--muted`.
- **The Linear icon** in the sidebar is a hatched circle. Use Linear's real mark (from the brand's integration icons), monochrome `--muted`.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- **Sidebar sizes:** rows render taller than 26px and type larger than 13px. Keep the shell's sizes.
- **The `x` on each chip** sits close to the text. 6px gap, 12px icon, and a hit area of at least 20px.
