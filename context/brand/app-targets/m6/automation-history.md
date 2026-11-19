# Target: an automation's history (milestone 6, screen 3)

> **Committed image:** `automation-history.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `automation-history.prompt.txt`. GPT Image 2.6 through Higgsfield, 3:2, 2k, high, 1 generation, kept as generated. References: the 2048 original of `app-targets/m4/audit-log` (the screen the spec starts this one from: filters, a hairline table in day bands, a selected row and its properties), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/automations/[automation-id]/history/page.tsx` → `components/automations/automation-history.tsx`.
- **Features:** F-011 (a rule's matches), F-106 (a schedule's occurrences, missed and skipped). Spec section 12, screen 3; section 3, step 9. ADR 0056, ADR 0037 (the 6-hour missed rule, one occurrence per due time). Ticket 24 (`automations.history`, `resume`), tickets 10 and 11 (what's recorded), ticket 31 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 31 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Anyone who can open the project answers "what did this automation do, and why didn't it start that one?": each time it acted, the tickets it matched, and for each whether it started a task (and where that task is now), skipped it and why, or missed the time altogether. A paused automation says so at the top, with who or what paused it and a `Resume` for project admins.

The history reads `AutomationRun` (ticket 05): one row per match or occurrence, never changed. A schedule that checks its filter groups its matches under each occurrence; a rule on a match has no occurrences, so its rows group by day, as the audit log's.

The picture shows `Weekly bug sweep`, a schedule that checks its filter every Monday, paused by Alex Kim, with `CALC-180`'s three sub-issue tasks selected.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px | the shared sidebar, `Automations` selected under the open project |
| Top bar | 46px | breadcrumb `calculator › Automations › {name}`; on the right a secondary `Edit schedule` / `Edit rule` (Lucide `pencil`), project admins only. No primary here: `Resume` is the page's one primary when shown |
| Page | `1fr`, padding `28px 36px` | title, lede, the pause notice, filters, the table |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | the selected run |

The picture draws the panel at about 354px. Build 320px.

### Heading

- Title: the automation's name, Manrope 700 `text-title`.
- Lede, `text-lede` `--muted`, one line: the schedule's sentence, then `Checks {filter in words}.` (a filter schedule), `Starts "{title}".` (a prompt schedule), or for a rule `Starts each ticket that matches {filter in words}, once.`. The sentence and the filter in words are the domain's (`automations.md`).

### The pause notice

Only while paused, 18px under the lede: a box the column's width, 56px, `--surface`, 1px `--line-2`, 8px radius, padding `0 12px 0 14px`. Lucide `circle-pause` 18px `--muted`, then two lines: 14px 500 `--text` and 13px `--muted`. At its right the primary `Resume` (Lucide `play`), project admins only; members see no button.

| `pausedReason` | First line | Second line |
|---|---|---|
| `member` | `Paused by Alex Kim on 18 Nov at 17:40.` | `Occurrences while it's paused are skipped, and none catch up when it resumes.` (a schedule) / `Tickets that match while it's paused don't start, now or when it resumes.` (a rule) |
| `hourly_limit` | `Paused at 14:32 after 20 starts in an hour.` | `The 21st match, CALC-190, was skipped. Check the rule's filter, then resume it.` (the key a link) |

`Resume` calls `automations.resume`; the notice goes at once, and a resumed schedule's next occurrence is computed from now (ticket 10). The needs-you item for `hourly_limit` clears.

### Filters

One row, 20px under the notice (or the lede), as the audit log's: `Outcome` (`All`, `Started`, `Skipped`, `Missed`) and `Period` (`Last 7 days`, `Last 30 days` (default), `Last 90 days`, `All time`). At the right end, 13px `--faint`: `4 occurrences · 7 matches` (a rule: `7 matches`). Both in the URL (`?outcome=&period=`).

### The table

`Table`, borderless, headers 12.5px `--faint`: `Time`, `Ticket`, `Outcome`, `Task`. Rows 38px, `--line` hairlines, newest first, keyset-paged by 100 (`automations.history({ cursor })`) as the end comes into view.

**Bands,** 30px, `--surface`, as the audit log's day bands, sticky under the header:
- A schedule: one per occurrence, `Mon 16 Nov, 09:00` (13px `--muted` 500, in the schedule's zone) then `--faint` ` · 4 matches` / ` · 1 match` / ` · no match` / ` · missed` / ` · skipped: the last task is still open` / ` · skipped: paused`. A missed or skipped occurrence has one row under it (below) and no matches.
- A rule: one per day in the viewer's zone (`Today`, `Yesterday`, `Mon 16 Nov`) with its count.
- `Start all` runs: their own band, `Started by hand · Alex Kim, 18 Nov 10:12` then ` · 2 matches`.

| Column | Width | The picture | Rule |
|---|---|---|---|
| Time | 80px | `09:00` | mono `--faint` `HH:mm` (the run's `createdAt`, in the band's zone); `—` for a missed occurrence |
| Ticket | `1fr` | `CALC-181` `Clear button forgets the memory` | the key mono 13px `--muted`, then the title `--text`, one line with an ellipsis; the ticket's page link. A missed occurrence: `No tickets checked` in `--faint` (roman, not italic) |
| Outcome | 150px | `Started` | `Started` `--text`; `Started 3 tasks` for a parent; `Skipped` and `Missed` in `--muted` |
| Task | 300px | `Running 3f9c21ab` | started: the task's state mark and word as the project's task list draws them (green dot `Running`, `circle-dashed` `Queued` with its wait reason in `--faint`, `git-pull-request` `In review`, `git-merge` `Merged`, `circle-stop` `Stopped`) and the short ID in mono `--faint`, all a link to the task. A parent: `sub-issues CALC-182, CALC-183, CALC-184`. Skipped or missed: the reason in `--faint` (below) |

**The reasons** (`skipReason`, and `missed`):

| Reason | Copy |
|---|---|
| `has_task` | `It already has a task, a17be093` (the ID a link) |
| `last_open` | on the occurrence's band: `skipped: the last task is still open` (`7c1e04d2` linked in the row: `Waited for 7c1e04d2, still in review`) |
| `paused` | on the band: `skipped: paused` |
| `hourly_limit` | `The rule reached 20 starts in an hour and paused` |
| `over_limit` | `Over the 50 a time limit: it starts next time` |
| `budget` | `The project's budget is spent` |
| missed | `Fired 7h late, past the 6-hour limit.` (the lateness, and the install's `OSTRA_SCHEDULE_MISSED_HOURS`) |

A row is a button: click or Enter selects it for the panel (`--sel` fill, `aria-selected`, `?run=` in the URL); `↑`/`↓` move. With none, the newest run.

### Properties panel: the selected run

1. The ticket's key as the group label, mono 12.5px `--faint` (`Occurrence` for a missed or skipped occurrence).
2. `PropRow`s, 30px, key column 96px: `Outcome` (`Started 3 tasks`), `When` (`16 Nov 2026, 09:00:04`, to the second, in the band's zone with UTC in `title`), `Occurrence` (a schedule's, `Mon 16 Nov, 09:00`), `Started by` (`Start all · Alex Kim` for a `start_all` run), `Profile`, `Pool labels` (mono `Chip`s), `Reason` (skipped and missed).
3. `Separator`, then **Tasks** (started runs): one row per task, the short ID in teal mono (a link) and, in `--muted`, `CALC-182 · In review` (the ticket and the task's state).
4. `Separator`, then **The parent** (a parent ticket only): 13px `--muted` `A parent ticket never runs code. Its sub-issues start, one task each.` and a teal link with `arrow-up-right`: `Open CALC-180` → the parent's page (`ticket-parent`).

## States and copy

| State | What changes |
|---|---|
| Not paused | no notice; the filters sit 20px under the lede |
| A rule | day bands; the lede as above; no `Occurrence` row; `Missed` isn't in the Outcome filter |
| A prompt schedule | bands per occurrence, each with one row: the task's title in `--text` (no key), its outcome and task |
| Nothing yet | in place of the table, 13px `--muted`: `Nothing yet. A rule acts when a ticket starts to match after it's saved.` / `Nothing yet. The first occurrence is Mon 23 Nov, 09:00.` No illustration: it's an empty record, not an empty place |
| No match for the filters | `No run matches these filters.` and a teal `Clear filters` |
| Loading / loading more | as the audit log: eight `Skeleton` rows; one at the end while the next page loads |
| Load failed | the error alert in place of the table |
| A deleted automation | reachable from its tasks' `Started by the rule …`; the title gets a `--faint` ` (deleted)`, no notice, no Edit |
| A member | no `Resume`, no `Edit`; everything else |
| Narrow (below 1280px) | the panel drops under the page. Below 640px the notice stacks its button under the text, and each row is the time and key on one line, the outcome and task on the next |

## Components (shadcn/ui names)

`PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, a `Notice` (a box with an icon, two lines and an action; milestone 6's `needs-approval` and `environment-proposal` banners can share it), `DropdownMenu` filters (as the audit log's), `Table` inside `@tanstack/react-virtual` (milestone 4 adds it), `Status` marks (existing), `Chip`, `PropGroup` / `PropRow`, `Separator`, `Skeleton`, `Button`. Lucide 15px, stroke 1.75: `circle-pause`, `play`, `pencil`, `chevron-down`, `arrow-up-right`, `git-merge`, `git-pull-request`, `circle-dashed`.

## Tokens

> **Scale.** The approved pictures' scale wins (`../m1/README.md`, "Scale"): body 14.5px, rows 14px, secondary 13px, small 12px, title 26px, buttons 30px, a 320px panel.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--surface` | `#131416` | the notice, the bands, the filter buttons |
| `--sel` | `#1A1B1E` | the selected row |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines / the notice's and filters' borders |
| `--text` | `#F2F3F4` | titles, `Started`, values |
| `--muted` | `#B4B7BB` | the lede, keys, `Skipped`, `Missed`, band labels |
| `--faint` | `#8B8E93` | times, counts, reasons, IDs |
| `--teal` | `#6FB8AA` | task IDs in the panel, `Open CALC-180`, links |
| `--green` | `#4CC38A` | the dot beside `Running` only |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Resume` |

No amber on this page: a member's pause is a record, and a limit pause is amber where it needs someone (Home and the list), not here.

## Data this screen needs beyond ticket 24

`automations.history` returns runs with their state, reason and task. The picture also needs:

- **Each started task's state and its PR's state,** for `Running`, `In review`, `Merged` (a join on `Task`).
- **A parent's tasks:** the runs for one parent hold one `ticketId`; its leaves' tasks come from `Task.parentTicketId` with the run's `bulkStartId` or `automationId`.
- **Who paused it and when** (`pausedAt` is in section 5.3; the member is not: see `automations.md`).
- **The lateness of a missed occurrence** (its `occurrenceAt` against the tick that recorded it).
- **The counts** per occurrence and in total, for the bands and the filter row.

## Differences from the current code

1. **New route and view** under `automations/[automation-id]/history/`, with `messages/en.json` keys under `automations.history.*`.
2. **The day-band table** is the audit log's (milestone 4, ticket 34). Reuse its band row and virtualisation instead of writing a second one.
3. **The task state marks** are the project task list's (`components/tasks/`); reuse them.

## Wrong in the image

Build the copy and details in this file, not these:

- The panel is about 354px. Build 320px.
- `Mon 2 Nov`'s `CALC-157` is a match skipped with `The last occurrence's task was still open`. "Skip while the last one is open" skips a whole occurrence, not one match (ADR 0056): build that occurrence's band as `skipped: the last task is still open` with no matches, or, for this data, give `CALC-157` a match reason from the table above.
- `No tickets checked` is italic. It's roman `--faint`.
- The missed row's `Missed` and its reason sit further left than the other rows' Outcome and Task columns. Align them to the columns.
- The panel's `When` value is drawn in mono. Dates and times in the panel are sans.
- The picture has no filtered, empty, rule, prompt-schedule, limit-pause, member or narrow state: they're in this file.
- The sidebar's `Tasks` row has a stack icon and `Environment` a terminal; use the project nav's existing icons.

All visible copy in the image is spelled right.
