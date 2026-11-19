# Target: Automations (milestone 6, screen 1)

> **Committed images:** `automations.webp` (five automations, one selected) and `automations-empty.webp` (none yet), each downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Images:**
  - `automations.webp`: GPT Image 2.6 through Higgsfield, 3:2, 2k, high, 1 generation. Prompt: `automations.prompt.txt`. References: the 2048 original of `app-targets/m1/runners` (the screen the spec starts this one from: a hairline table with a selected row and its properties), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. One word was corrected after generation: the paused row's `Pausks` was redrawn as `Paused` with the brand's Plex Sans, at the measured size and colour.
  - `automations-empty.webp`: a composite, no generation. The base is the same picture with its section, table, note, panel and top-bar buttons erased. On it sit milestone 2's graded Deep water illustration (`../m2/inbox-empty-illustration.webp`, the file the Inbox's empty state already uses), the copy and the two buttons, drawn with the brand's fonts by a script.
- **Routes (new):** `apps/web/src/app/(panel)/projects/[project-id]/automations/page.tsx` → `components/automations/automations-view.tsx`. Ticket 31 writes the folder as `src/routes/projects/$projectId/automations/`; the app is Next's App Router, so it lives under `app/(panel)/projects/[project-id]/`.
- **Features:** F-011 (intake rules), F-106 (schedules). Spec section 12, screen 1; section 3, step 9. ADR 0056 (automations), ADR 0037 (schedules on ostra's own table). Ticket 24 (`automations.list`, `pause`, `resume`), ticket 31 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 31 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A project admin sees everything that starts tasks in this project without a person pressing Start: the intake rules, which act when a ticket starts to match, and the schedules, which act at set times. One list holds both, because a member asking "why did this task start?" shouldn't have to know which kind did it. Each row answers four questions at a glance: what makes it start (the filter or the schedule, in words), what it starts (kind and profile, and the pool labels), when it last started something, and when it will next, or why it won't (paused, and by whom or by what). The switch turns one off and on again without opening it.

Members who can open the project see the list and the history read-only; only a project admin sees the switches, `New rule`, `New schedule` and `Edit` (ticket 24).

The picture shows Alex Kim, an admin of `calculator`, with five automations and `Triage bugs` selected.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, `--side`, 1px `--line` on its right | the shared sidebar; under the open project, a new row `Automations` (Lucide `zap`) after `Environment`, selected here. Build it from `components/shell/project-nav.tsx`, not from the picture |
| Top bar | 46px, 1px `--line` below | breadcrumb `calculator › Automations`; on the right a secondary `New schedule` (Lucide `clock`) and, 8px after it, the page's one primary button `New rule` (Lucide `plus`). Both for project admins only |
| Page | `1fr`, padding `28px 36px` | title, lede, the list's heading, the table, the limit note |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | the selected automation |

The picture draws the sidebar at about 238px and the panel at about 342px. Build 234px and 320px.

### Heading

- Title `Automations`, Manrope 700, `text-title`.
- Lede, `text-lede` `--muted`, one line: `Rules and schedules that start tasks in {project}. A rule starts each matching ticket once; a schedule starts work at set times.`

### The list

- **Section line,** 26px under the lede: `Automations` (14.5px 600 `--text`) and its count in `--faint`; at the right end a ghost `DropdownMenu` trigger `All kinds` with `chevron-down`, choices `All kinds`, `Rules`, `Schedules`, `Paused`. It lives in the URL (`?kind=`).
- **Table,** borderless, headers 12.5px `--faint`: (none over the switch), `Name`, `Starts when`, `Profile`, `Pool labels`, `Last start`, `Next`. Rows are two lines, 56px, with `--line` hairlines; the selected row has the `--sel` fill and a 6px radius. Order: enabled first, then paused, each by name.

| Column | Width | The picture | Rule |
|---|---|---|---|
| Switch | 52px | teal on, `--line-2` off | the `Switch` (36×20 as the app's `switch.tsx`, the picture draws it a little larger). On = enabled; off = paused. Toggling calls `automations.pause` / `resume` at once, optimistic, with the row's Next cell updating; no confirm. Disabled (and `aria-disabled`, with a `Tooltip` `Only project admins turn automations on and off.`) for members |
| Name | 200px | `Triage bugs` / `Rule` | the name 14px 500 `--text`; under it 13px `--faint` with a 13px icon: Lucide `filter` `Rule` or `clock` `Schedule` |
| Starts when | `1fr` | `label bug, status Todo, unassigned` | `--muted`, wrapping to two lines at most, then an ellipsis with the whole sentence in `title`. A rule: its filter in words (below). A schedule: its sentence (`automation-edit.md`), then ` · checks its filter` for one that checks the filter, or nothing for a prompt schedule |
| Profile | 140px | `Code · Careful` | the task kind's word, a `--faint` ` · `, the profile's name |
| Pool labels | 110px | `tier:fast` | each label a mono `Chip`; `—` `--faint` when none. More than one: the first and `+N` |
| Last start | 120px | `CALC-181` / `12m ago` | a rule: the last started ticket's key (mono, a link to its task) over its age in `--faint`. A schedule: the last occurrence's date and time in the zone (`Mon 16 Nov, 09:00`), `--faint`. Never started: `—` |
| Next | 150px | `on a match` / `Mon 23 Nov, 09:00` | a rule on a match: `on a match` `--faint`. A schedule: the next occurrence in its zone, `--text`. Paused: the reason in `--muted` instead (below) |

**The filter in words** (one function in `packages/domain`, shared with the editor and the history's lede): its clauses in a fixed order, joined by `, `: labels (`label bug`; `label bug or crash` for any of; `labels bug and ui` for all of; `not label wontfix` for none of), status (`status Todo`; `status category started`), assignee (`unassigned`, `assigned to ostra`, `assigned to {name}`), board (only when the project has more than one: `board Calculator`), the tracker's project (`in Q4 roadmap`). An empty filter reads `every open ticket`. `any status` shows only when the status clause is absent and the filter has another clause, as in the picture's `label docs, any status`.

**Paused, in the Next cell:**

| Reason (`pausedReason`) | Copy |
|---|---|
| `hourly_limit` | a 6px `--amber` dot, then `Paused: 20 starts in an hour` (the install's `OSTRA_INTAKE_STARTS_PER_HOUR`). The dot is amber because it's a needs-you item for the project's admins |
| `member` | `Paused by {name}`, no dot |

- **The note,** 18px under the table, 13px `--faint` with Lucide `shield` 14px: `A rule never starts more than 20 tasks an hour. Saving a rule starts nothing: its dry run lists the tickets that already match.` (the number from the install's setting).
- **Selecting:** a click or Enter selects the row for the panel; `↑`/`↓` move. The selection is in the URL (`?automation=`). With none, the first row. Double-click or the panel's `Edit` opens the editor.

### Properties panel: the selected automation

`PropGroup` / `PropRow` (96px key column, 30px rows), groups split by `--line`.

1. **Head:** the name as the group label (13px `--muted` 500), with its `Switch` at the right (the same as the row's).
2. **Trigger rows:** `Kind` (`Rule · on a match`, `Schedule · every Monday at 09:00`), then one row per filter clause: `Labels` (`any of` and `Chip`s), `Status`, `Assignee`, `Board`, `Project`. A prompt schedule shows `Prompt` (the first line, `--muted`, ellipsis; the whole prompt only in the editor) instead of the filter rows.
3. **Starts:** `Kind` (`Code task`, `Refine task`), `Profile` (a link to the profile for organization admins), `Pool labels` (mono `Chip`s or `—`), `Approval` (`Not needed` or `A member approves each task`), and for a rule `Limit`: `{n} of 20 this hour`.
4. **History:** `Started` (`14 tasks`), `Skipped` (`2`), `Missed` (schedules, when not 0), then a teal text button with `arrow-right`: `Open history` → `automations/{id}/history`.
5. **Actions:** two secondary buttons, 30px, side by side: `Edit rule` / `Edit schedule` (Lucide `pencil`) → the editor, and `Dry run` (Lucide `play`) → the editor with the dry run in view. Members see neither; they see `Open history` only.
6. 12.5px `--faint`: `Created {date} by {name}`, and `· edited {age} by {name}` when it was.

## States and copy

| State | What changes |
|---|---|
| **None yet** (`automations-empty.webp`) | Lede as above. No section line, table, note or panel; no top-bar buttons. The Deep water illustration centred on the column (560×373 CSS box, 150px from the top bar's line, `../m2/inbox-empty-illustration.webp`), then `No automations yet` (15px 600 `--text`), `A rule turns matching tickets into tasks. A schedule starts work at set times.` (13px `--muted`, 8px under), then the two buttons centred, 8px apart: primary `New rule` (`plus`) and secondary `New schedule` (`clock`), 32px, 16px under; then 12px `--faint`, 18px under: `Members see the list. Only a project's admins make rules and schedules.` A member sees the illustration, the title and the copy, and in place of the buttons `A project admin makes automations.` in `--faint` |
| No board yet | the same empty layout, copy `Attach a board first: rules act on its tickets.` and the primary button `Attach a board` → Boards. `New schedule` stays (a prompt schedule needs no board) |
| Loading | five 56px hairline rows with `Skeleton` bars; the panel's values `Skeleton` |
| A filter with no match | `No automation matches.` 13px `--muted` and a teal `Show all` |
| Toggling | the switch moves at once; on failure it moves back and a 13px `--red` line under the table reads `errorText(error)` with `role="alert"` |
| Paused by the limit | the row as the picture's `Docs fixes`; Home's needs-you row for admins reads `{rule} paused after 20 starts in an hour` with `Review` → this page with the rule selected; resuming clears it |
| A deleted automation | gone from the list (`deletedAt`); its tasks keep `Started by the rule {name}` and its history stays reachable from them |
| A member | no switches (disabled with the tooltip), no top-bar buttons, no `Edit`/`Dry run`; the rest as an admin sees it |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`). Below 900px the table hides `Pool labels` and `Last start`; below 640px each row is the switch, the name over its kind, and `Starts when` and `Next` as a second `--muted` line |

## Components (shadcn/ui names)

`Sidebar` (plus the project's `Automations` row), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Table` (selectable rows, as runners' pools), `Switch` (existing), `DropdownMenu` (existing), `Chip`, `PropGroup` / `PropRow`, `Separator`, `Skeleton`, `Tooltip` (existing), `Button` (default = the Shell primary; `variant="secondary"`; `variant="link"` for the teal text buttons). Lucide 15px, stroke 1.75: `zap`, `filter`, `clock`, `plus`, `pencil`, `play`, `arrow-right`, `shield`, `chevron-down`.

## Tokens

> **Scale.** The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, buttons 30px, a 46px top bar and a 320px properties panel (`../m1/README.md`, "Scale").

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | `New schedule`, chips, skeletons |
| `--sel` | `#1A1B1E` | the selected row, the selected nav row |
| `--line` | `#1F2023` | row hairlines, the panel's edge, group lines |
| `--line-2` | `#2A2C30` | button and chip borders, a switch that's off |
| `--text` | `#F2F3F4` | names, profiles, next occurrences, values |
| `--muted` | `#B4B7BB` | the filter in words, paused reasons, keys |
| `--faint` | `#8B8E93` | kinds, headers, ages, `on a match`, `—`, the note |
| `--teal` | `#6FB8AA` | a switch that's on, `Open history`, links |
| `--amber` | `#FFB224` | the sidebar's Needs you count, and the dot on a rule paused by the limit |
| `--red` | `#E5675C` | errors only |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `New rule` |

Type: Manrope 700 for the title; IBM Plex Sans for everything else (500 for names, buttons and the panel's head, 600 for the section line); IBM Plex Mono for ticket keys and pool labels. The picture sets dates (`Mon 16 Nov, 09:00`) partly in mono; dates are sans.

## Data this screen needs beyond ticket 24

`automations.list` returns each automation with its filter, schedule, zone, kind, profile, pool labels, `enabled`, `pausedAt`, `pausedReason` and `nextOccurrenceAt`. The picture also shows these; add them to the list or drop the element:

- **The last start:** the latest `AutomationRun` with `state = started`, its ticket key and task ID, or its `occurrenceAt`.
- **Who paused it,** for `Paused by {name}`: `pausedByMemberId` isn't in section 5.3's columns (`pausedAt`, `pausedReason` are). Add it, or read the `automation.paused` audit entry.
- **The hour's count** (`3 of 20 this hour`) and the history's counts (`Started`, `Skipped`, `Missed`): counts over `AutomationRun`.
- **The filter in words** is the domain's (ticket 06), so the list, the editor and the history say it the same way; it needs the board's labels, statuses and members by ID, which milestone 2's ticket cache has.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** `app/(panel)/projects/[project-id]/` has only `page.tsx` and `environment/`. Add `automations/page.tsx`, `components/automations/`, and `messages/en.json` keys under `automations.*`.
2. **Project navigation.** `components/shell/project-nav.tsx` expands the open project into Tasks and Environment (milestone 2 adds Inbox and Boards). Add `Automations` with `ZapIcon` after Environment.
3. **`components/ui/`** has `switch`, `table`, `dropdown-menu`, `tooltip` and `skeleton`; nothing new is needed. `Chip` is milestone 2's; if it hasn't landed, make it there, not here.
4. **The empty state** reuses `inbox-empty-illustration.webp` (milestone 2). Once milestone 2 moves it to `files/web/` with its row in `../../assets.md`, import it from there; it's the same file, not a second asset.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 238px and the panel about 342px. Build 234px and 320px.
- The schedules' `Last start` and `Next` dates are drawn in mono. Dates are sans.
- The switches are drawn about 36×22 and slightly glossy. Use the app's `Switch` as it is.
- The panel's values are drawn a step larger than its keys. They're the same size, `text-ui`.
- `Weekly bug sweep`'s cell wraps to three lines. Clamp `Starts when` at two lines with an ellipsis.
- The panel has no `Missed` row, the list no member, loading, no-match or narrow state, and the top bar's buttons show for everyone: those are in this file.
- The sidebar's `Linear` row has a stack icon. Use the icon milestone 2's Linear page settled on.

All visible copy in `automations.webp` is spelled right after the one correction above.
