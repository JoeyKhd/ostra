# Target: the audit log (milestone 4, screen 8)

> **Committed image:** `audit-log.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `audit-log.prompt.txt`. GPT Image 2.6 through Higgsfield, 3:2, 2k, high, 1 generation. References: the 2048 original of `app-targets/m1/runners` (the screen the spec starts this one from: a hairline table with a selected row and its properties), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Routes (new):** `apps/web/src/app/(panel)/organization/audit/page.tsx` → `components/organization/audit-view.tsx`; the project's view at `apps/web/src/app/(panel)/projects/[project-id]/settings/audit/page.tsx`, the same view fixed to the project (ticket 34). The CSV at `apps/web/src/app/api/audit/export/route.ts` (ticket 25).
- **Features:** F-073 (the audit log). Spec section 12, screen 8; section 3, step 10. ADR 0054 (the audit log and search), ADR 0035 (the event log records every tool call's input). Ticket 10 (the actions), ticket 25 (`audit.list`, the export, the link to the event log), ticket 34 (this screen and the event log view, `task-event-log`).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 34 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin answers "who did what, and when" for the organization: who started a task, answered an approval, changed a role, added a provider, set a budget, made a reset link, and which runner was handed a task's credentials. They narrow it by actor, action, project and period, open one entry to see its data, jump from a task's entry to the task's event log (what the agent ran and read, ADR 0054: "two records, one answer"), and export what they see as CSV.

The log is append-only and holds IDs and settings, never content (ADR 0054), and the page says both. A project admin reads the same table for their project only, from its settings; a member reads none.

The picture shows Alex Kim, an admin of Acme Corp, on the last 7 days with no other filter, with Sam's `task.created` for `CALC-161` selected.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, `--side`, 1px `--line` on its right | the shared sidebar, `Audit log` (Lucide `scroll-text`) selected under Organization, for organization admins only. Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 46px, 1px `--line` below | breadcrumb `Acme Corp › Audit log`; on the right the page's one primary button, `Export CSV` with Lucide `download` |
| Page | `1fr`, padding `28px 36px`, no max width (the table takes the column) | title, lede, the filter row, the table |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | the selected entry |

The picture draws the sidebar at about 237px and the panel at about 355px. Build 234px and 320px.

### Heading

- Title `Audit log`, Manrope 700, `text-title`.
- Lede, `text-lede` `--muted`, one line: `Who did what in Acme Corp. Entries are never changed or deleted. What an agent ran is in each task's event log.` (the organization's name). On the project's view: `Who did what in calculator. What an agent ran is in each task's event log.`

### Filters

One row, 20px under the lede, four `DropdownMenu` triggers 8px apart: secondary buttons, 30px, `--surface`, 1px `--line-2`, 7px radius, each a `--muted` label, a `--text` value and Lucide `chevron-down` 14px. At the row's right end, 13px `--faint`, the count of the filtered entries: `41 entries` (`1 entry`; past 10,000, `10,000+ entries`).

| Filter | Default | Choices |
|---|---|---|
| `Actor` | `All` | a searchable list (an `Input` at the menu's top): the organization's members, removed ones last with ` (removed)`; then `Runners` (any runner) and `System`. One choice |
| `Action` | `All` | a searchable list grouped by prefix: each group's header is a choice of its own (`task.*`, `member.*`, `budget.*`, …, the prefix filter ticket 25 names), then its actions in Plex Mono. One choice |
| `Project` | `All` | the organization's projects, then `No project` (entries about the organization itself). One choice. Hidden on the project's view |
| `Period` | `Last 7 days` | `Today`, `Last 7 days`, `Last 30 days`, `Last 90 days`, `All time`, and `Custom…`, which opens two date inputs (from, to; whole days in the viewer's time zone) in the menu |

A filter that isn't its default shows its value in `--text` and a 14px Lucide `x` inside the button's right edge that resets it (the chevron gives way to it). Every filter lives in the URL (`?actor=&action=&project=&from=&to=`), so a filtered view is a link, and the export reads the same parameters. Changing a filter keeps the selected entry if it's still in the results, else clears it.

A fifth filter, **entity**, has no button: the panel's `Entries about this task` (below) sets it, and it shows as a removable chip after the four buttons: `task CALC-161` with its `x`.

### The table

`Table`, borderless, column headers in 12.5px `--faint` (`Time`, `Actor`, `Action`, `Entity`, `Project`), 18px under the filters. Rows 38px with `--line` hairlines. Virtualised with `@tanstack/react-virtual` (ADR 0007; ticket 34), loading the next page of 100 by keyset (`createdAt`, `id`) as the end comes into view; newest first.

**Day bands:** before each day's first row, a 28px band, `--surface` fill, the day in 12.5px `--muted` 500 (`Today`, `Yesterday`, then `Mon 17 Nov`, and `17 Nov 2025` past this year) and its count in Plex Mono `--faint`. The count is that day's entries under the current filters. Days are the viewer's time zone. The band sticks under the header while its rows scroll.

| Column | Width | The picture | Rule |
|---|---|---|---|
| Time | 80px | `14:07` | Plex Mono `--faint`, `HH:mm` in the viewer's time zone (the day is in the band) |
| Actor | 190px | `Sam Rivera` | a member's name in `--text`; a removed member as `Rae Okafor (removed)` in `--muted` (`actorName`, as it was); a runner as `runner` in `--faint` then its name in Plex Mono; the system as `System` in `--muted` |
| Action | 220px | `task.created` | Plex Mono, `--muted` |
| Entity | `1fr` | `task CALC-161` | the kind in `--faint` (`task`, `member`, `project`, `pool`, `provider`, `budget`, `note`, `invitation`, …), then the entity's label in `--text`: a ticket key or a task's short title for a task, a name for the rest. Keys, pool and runner names in Plex Mono, names of people and projects in sans. An entity since deleted (a revoked token, an archived note) keeps the label the entry recorded |
| Project | 140px | `calculator` | `--muted`; `—` in `--faint` for an entry about the organization |

A row is a button: clicking it (or Enter, with arrow keys moving between rows) selects it for the panel, with the `--sel` fill and `aria-selected`; the selection is in the URL (`?entry=`). With nothing picked, the newest entry is selected.

### Properties panel: the selected entry

1. **The action** as the group's label, in Plex Mono 12.5px `--faint`: `task.created`.
2. **`PropRow`s,** 30px, key column 96px:

| Key | The picture | Rule |
|---|---|---|
| When | `19 Nov 2026, 14:07:33` | sans, the full time to the second, in the viewer's time zone, with the UTC time in its `title` |
| Actor | `Sam Rivera` | as the table, plus the actor's kind for a runner (`build-01 · runner`) |
| Entity | `Task CALC-161` | a teal link, no underline, to the entity's page: a task to `/tasks/[id]`, a project to its page, a pool to Runners with it selected, a provider to Models, a member or invitation to Members, a note to its Memory page. No link when the entity is gone or the admin can't open it |
| Project | `calculator` | a teal link to the project when there is one; `—` otherwise |

   Under the rows, a teal text button `Entries about this task` (`… this member`, `… this pool`): it sets the entity filter.
3. **`Separator`,** then **Data:** the group label `Data`, then a `Code` box the panel's width, Plex Mono 12px, one line per key of the entry's `data`, the key in `--muted` and the value in `--text`, nested keys dotted (`grants.0.role`). Values that are IDs show as IDs; a long value wraps (`break-all`). With no data: `No data.` in 13px `--faint`, no box. Under it, 12px `--faint`: `IDs and settings only. Entries never hold prompts, ticket text or tokens.`
4. **`Separator`,** then **Event log,** only for an entry whose entity is a task: the group label `Event log`, 13px `--muted` `What the agent ran and read in this task, with every tool call's input.`, then a teal text button with Lucide `arrow-up-right`: `Open the event log`, to `/tasks/[id]?view=event-log` (the `task-event-log` target, screen 9). When the entry carries an event sequence (an approval, a credential issuance), the link opens the log at that event.
5. **The entry's ID,** after a `Separator`, Plex Mono 12px `--faint` (`0193f2c4-7b1e-7c2a…`, the full UUID on hover and copied on click, with `Copied` for 1.5s).

### Export CSV

`Export CSV` downloads `/api/audit/export` with the current filters, entity included: `audit-<organization-slug>-<yyyy-mm-dd>.csv`, streamed (no row limit, ticket 25). One header row, then one row per entry, newest first, every field quoted: `time` (ISO 8601, UTC), `actor_kind`, `actor_id`, `actor_name`, `action`, `entity`, `entity_id`, `entity_label`, `project_id`, `project_name`, `data` (the JSON). It's a plain link with `download`, so the browser shows its own progress; the button reads `Exporting…` with `loader-circle` until the response starts. Disabled with `0 entries`.

## States and copy

| State | What changes |
|---|---|
| Loading | the filter buttons render; the table is eight 38px hairline rows with `Skeleton` bars where values go; the count and the panel's values are `Skeleton` bars |
| Filtered (step 10: Actor `Sam Rivera`) | the Actor button reads `Actor  Sam Rivera` with its `x`; the rows and day counts follow; `Export CSV` exports these only |
| Prefix filter (`budget.*`) | the Action button reads `Action  budget.*` (Plex Mono value) |
| No match | in place of the table, 13px `--muted`: `No entries match these filters.` and a teal `Clear filters`; the panel reads `No entry selected.` in `--faint`; `Export CSV` disabled |
| Loading more | a 38px row at the end with a `Skeleton` bar; never a spinner |
| A removed member | their entries keep their name with ` (removed)`, and they stay in the Actor list, after the active members |
| Not a task entry | the panel has no Event log group |
| Entity gone | the Entity value is plain `--text`, no link, and `Entries about this …` still works (it filters by the ID) |
| Export failed | under the filter row, `role="alert"`, 13px `--red`: the error text (`errorText`) |
| Load failed | the error alert in place of the table |
| The project's view (a project admin) | in the project's settings, `Audit` beside its other tabs: the same table with the Project filter and column gone (every entry is the project's), the lede naming the project. ADR 0054 gives the export to organization admins, so a project admin who isn't one sees no `Export CSV`. Organization admins see the button here too, exporting the project's entries |
| A member | no `Audit log` row in the sidebar, no Audit tab in a project's settings; a direct URL shows `AdminOnly` (`Only admins can open this.`) |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`), showing the selected entry; below 640px the filter row wraps, the count goes under it, the table keeps Time, Actor and Action and moves Entity and Project into a second line of each row in `--muted` |

The page has no decorative area, so no illustration: an organization's log always holds at least `organization.created`, and an empty filtered view says so in words.

## The actions (ticket 10)

The picture uses milestones 1 to 3's names where they exist (`task.created`, `task.credentials-issued`, `task.stopped`, `member.role-changed`, `provider.added`, `join-token.created`) and names ticket 10 hasn't fixed yet for the rest (`budget.set`, `memory.proposal-approved`, `project.access-changed`, `invitation.accepted`). Ticket 10's closed union decides the spellings; the page shows whatever it holds and needs no change when they do.

## Components (shadcn/ui names)

`Sidebar` (existing, plus the Audit log row), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Table` (selectable rows, as runners' pools) inside `@tanstack/react-virtual`, `DropdownMenu` with an `Input` at its top for the searchable filters, `Popover` for the custom period's dates, `Input` (`type="date"`), `Button` (default = the Shell primary; `variant="secondary"` for the filters; `variant="link"` for the teal text buttons), `Chip` (the entity filter), `PropGroup` / `PropRow`, `Code` (the data box), `Separator`, `Skeleton`. Lucide 15px, stroke 1.75: `scroll-text`, `download`, `chevron-down`, `x`, `arrow-up-right`, `loader-circle`.

## Tokens

> **Scale.** The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, buttons 30px, a 46px top bar and a 320px properties panel. The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the filter buttons, the day bands, the data box, skeletons |
| `--sel` | `#1A1B1E` | the selected row, the selected nav row |
| `--line` | `#1F2023` | row hairlines, the data box's border, panel edge, group lines |
| `--line-2` | `#2A2C30` | the filter buttons' and the chip's borders |
| `--text` | `#F2F3F4` | actors, entity labels, values |
| `--muted` | `#B4B7BB` | filter labels, actions, projects, removed actors, data keys, day labels |
| `--faint` | `#8B8E93` | times, headers, entity kinds, counts, the data line, the entry ID |
| `--teal` | `#6FB8AA` | entity and project links, `Entries about this …`, `Open the event log`, `Clear filters` |
| `--red` | `#E5675C` | errors only |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber, and nothing is green: an entry is a record, not a state |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Export CSV` |

Type: Manrope 700 for the title; IBM Plex Sans for everything else (500 for buttons and day labels); IBM Plex Mono for times, actions, keys, runner and pool names, counts, the data box and the entry ID.

## Data this screen needs beyond ticket 25

Ticket 25's `audit.list` returns each entry with the actor's name (and "(removed)"), the action, the entity with a link target, the project and its `data`. The picture also shows these; add them to that query or drop the element:

- **The filtered count,** total and per day, for the count and the day bands (a `count` over the same `where`, capped at 10,001).
- **The entity's label** as recorded (a ticket key, a name), so a deleted entity still reads; `AuditEntry` holds `entity` and `entityId` only, so either the writer adds a label to `data` (ticket 10) or the query joins the live record and falls back to the ID.
- **The filters' choices:** the members (removed ones included) and the actions present in the organization's log, for the two searchable menus.
- **The event's sequence** on a task entry that has one, for opening the event log at it.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New routes and view.** Nothing exists: add `organization/audit/page.tsx`, the project settings' `audit` page, the view, and `messages/en.json` keys under `audit.*`. Home's recent activity already reads `AuditEntry`; reuse its entity label and actor formatting rather than writing them twice.
2. **Sidebar.** Add `Audit log` (`scroll-text`) under Organization, for organization admins.
3. **`@tanstack/react-virtual`** is approved (ADR 0007) but not yet a dependency of `apps/web`; ticket 34 adds it, with the lockfile.
4. **The searchable menus.** `components/shell/command-menu.tsx` already filters a list by typing on top of `radix-ui`'s `Dialog`; build the Actor and Action menus the same way (a `DropdownMenu` with an `Input` at its top and the filtered items under it), with no new dependency. `Popover` comes from `radix-ui`, already a dependency.
5. **`Table`** exists; the day band is a new full-width row inside it (`TableRow` with one cell spanning the columns, `role="rowgroup"` heading semantics through `aria-label`).

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 237px and the panel about 355px. Build 234px and 320px.
- The day bands' labels (`Today`, `Yesterday`) are drawn at body size in `--text`. They're 12.5px 500 `--muted`.
- The Action column is drawn in `--text`. It's `--muted` Plex Mono.
- Entity labels are all drawn in mono (`Sam Rivera`, `Settings keys`, `calculator`). Only keys and pool, runner and provider names are mono; names of people, notes and projects are sans.
- `Task CALC-161` in the panel has `Task` underlined. The link has no underline.
- The panel's `When`, `Actor` and `Project` values are drawn a step larger than the keys. They're the same size, `text-ui`.
- The table ends after `join-token.created`, with empty space under it. The log continues: rows run to the bottom of the page column and load more as it scrolls.
- The picture has no `Entries about this task` button, no filtered, prefix, no-match, loading, export or project-view state: they're in this file.
- The sidebar's Linear row has a generic circle icon. Use the icon milestone 2's Linear page settled on.

All visible copy in the image is spelled right.
