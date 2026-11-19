# Target: the rule and schedule editor (milestone 6, screen 2)

> **Committed image:** `automation-edit.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `automation-edit.prompt.txt`. GPT Image 2.6 through Higgsfield, 3:2, 2k, high, 1 generation. References: the 2048 original of `app-targets/m3/agent-profile` (the screen the spec starts this one from: a form of titled sections with a column beside it), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. One word was corrected after generation: the preset chip `Weedays` was redrawn as `Weekdays` with the brand's Plex Sans, at the measured size and colour.
- **Routes (new):** `apps/web/src/app/(panel)/projects/[project-id]/automations/new/page.tsx` (`?starts=match|schedule`, from `New rule` and `New schedule`) and `automations/[automation-id]/page.tsx`, both → `components/automations/automation-editor.tsx`.
- **Features:** F-011 (intake rules, the dry run), F-106 (schedules), F-107 (`Start all` is a bulk start). Spec section 12, screen 2; section 3, step 9. ADR 0056, ADR 0037, ADR 0011 (nothing acted on before it's saved), ADR 0031 (nothing automatic without a limit). Ticket 24 (`create`, `update`, `dryRun`, `startAll`, `previewSchedule`, `delete`), ticket 11 (the dry run and bulk starts), ticket 10 (the evaluator), ticket 31 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 31 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A project admin writes what starts tasks by itself, and sees what it would do before it does anything. One editor holds both kinds, because they share everything but the trigger: a filter over the project's tickets, the task each match becomes (kind, profile, pool labels, whether a member approves it first), and either **on a match** (a rule: a ticket starts once, when it starts to match) or **on a schedule** (cron, zone, and each time either check the filter or start one prompt task).

Saving starts nothing (ADR 0056). The dry run beside the form lists the tickets that match right now and what starting each would do, and updates as the filter changes; `Start all N` starts them, by hand, as one bulk start. A schedule shows its cron as a sentence and its next three times, so "every Monday at 9" can't silently mean 9 UTC.

The picture shows Alex Kim editing `Weekly bug sweep`, a saved schedule that checks its filter every Monday at 09:00 Amsterdam time; four tickets match now.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px | the shared sidebar, `Automations` selected under the open project |
| Top bar | 46px, 1px `--line` below | breadcrumb `calculator › Automations › {name}` (`New rule` / `New schedule` before the first save); on the right the one primary button: `Save rule` / `Save schedule`, `Create rule` / `Create schedule` when new. Disabled until something changed or while invalid |
| Form | `1fr`, max 760px, padding `28px 36px` | the eyebrow, title, lede and five sections |
| Dry run | 380px (the form-panel width), 1px `--line` on its left, padding `20px 18px`, sticky under the top bar | the dry run, or for a prompt schedule the occurrences |

The picture draws the right column at about 430px. Build 380px.

### Heading

- Eyebrow, 12.5px mono `--faint`: `Automation · saved 2h ago` (`· not saved yet` when new; `· unsaved changes` in `--muted` when dirty).
- Title, Manrope 700 `text-title`: the name as typed (`New rule` while it's empty).
- Lede, `text-lede` `--muted`: `Saving starts nothing. Tickets that already match are in the dry run, to start by hand.` For a prompt schedule: `Saving starts nothing. The first task starts at the next occurrence.`

### Sections

Section titles 14.5px 600 `--text`, each with a 13px `--muted` note on the same line, 26px between sections, as the agent profile's.

**1. Name and trigger.** A row: `Name` (`Input`, 34px, sans, required, at most 80 characters) and `Starts` (a two-segment `ToggleGroup`, 34px, `--surface` with `--line-2`, the selected segment `--sel` and 600): `On a match` (Lucide `zap`) | `On a schedule` (Lucide `clock`). Switching keeps the filter and the task; it shows or hides section 2.

**2. Schedule** (only `On a schedule`), note `at least an hour apart` (from `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`; `at least {n} minutes apart` when the install sets it under 60).

- **Presets,** a row of `ToggleGroup` chips, 30px, 7px radius, `--surface`, `--line-2`; the chosen one has `--text` text and a 1px `--text` border:

| Preset | Cron |
|---|---|
| `Every hour` | `0 * * * *` |
| `Every day` | `0 9 * * *` |
| `Weekdays` | `0 9 * * 1-5` |
| `Every Monday` | `0 9 * * 1` |
| `Custom` | keeps the current expression and focuses the field |

  A preset writes its cron; typing in the field selects the preset whose cron it equals, else `Custom`. A day preset keeps the time already in the field (choosing `Weekdays` after editing `0 7 * * 1` gives `0 7 * * 1-5`).
- A row: `Cron` (`Input`, mono, 200px) and `Time zone` (a searchable `Select` of IANA zones, grouped by region, default the viewer's zone for a new schedule and `UTC` when the browser gives none).
- **The sentence,** 14px `--text` with Lucide `calendar` 15px `--muted`, from `automations.previewSchedule` (debounced 250ms after typing). The grammar, one function in `packages/domain` (ticket 06), so the list and history say it the same:

| Cron | Sentence |
|---|---|
| `0 * * * *` | `Every hour, on the hour` |
| `30 */2 * * *` | `Every 2 hours at :30` |
| `0 9 * * *` | `Every day at 09:00` |
| `0 9 * * 1-5` | `Every weekday at 09:00` |
| `0 9 * * 1` | `Every Monday at 09:00` |
| `0 9 * * 1,3` | `Every Monday and Wednesday at 09:00` |
| `0 9,17 * * *` | `Every day at 09:00 and 17:00` |
| `0 9 1 * *` | `On the 1st of every month at 09:00` |
| `0 9 1 1,7 *` | `On the 1st of January and July at 09:00` |
| `0 9 1 * 1` | `On the 1st of every month and every Monday at 09:00` (cron's either-day rule, said out loud) |

  Then `, {city} time` from the zone's last segment with `_` as spaces (`Amsterdam time`, `New York time`), or `, UTC`. Times are 24-hour `HH:mm`. Lists of three or more read `Monday, Wednesday and Friday`. An expression the grammar has no sentence for reads `At {cron}, {city} time` with the cron in mono, and the next occurrences carry the meaning.
- **Next,** 12.5px `--muted`, then the next three occurrences in the zone, mono 13px `--faint`, 24px apart: `Mon 23 Nov, 09:00`. When the zone isn't the viewer's, each has the viewer's own time in its `title` (`08:00 your time`). A daylight-saving change between them shows as it falls (`Mon 30 Mar, 09:00` stays 09:00 in the zone).
- **Each time,** a two-option `RadioGroup` under Next (missing in the picture, see below): `Check the filter` (starts each match the rule hasn't started, up to 50) | `Start one prompt task`. With the prompt, section 3 becomes **Prompt**: `Title` (`Input`, the task's title) and `Prompt` (`Textarea`, 6 rows, sans, required), with the note `sent as the task's first message; it never shows in logs`.
- **`Skip while the last one is open`,** a teal `Checkbox`, on by default, and its note in 13px `--muted`: `an occurrence waits until the previous task is merged, done or stopped`. It is recorded as skipped, not delayed: the note says `waits` because the next one runs.

**3. Filter,** note `the tickets it checks each time` (a schedule) or `a ticket starts once, when it starts to match` (a rule). Condition rows, 38px, 8px apart: a field `Select` (190px), an operator `Select` (120px), a value area (`1fr`, chips with their `x` and an inline `+ {thing}` combobox), and a ghost `x` button to remove the row.

| Field | Operators | Values |
|---|---|---|
| `Labels` | `any of`, `all of`, `none of` | the board's labels |
| `Status` | `is`, `is in category` | the board's statuses, or `Backlog`, `Unstarted`, `Started` |
| `Assignee` | `is` | `Unassigned`, `ostra`, the tracker's users |
| `Board` | `is` | the project's boards (only when it has more than one) |
| `Project` | `is` | the tracker's projects |

  Then a ghost `+ Condition` (each field once), and at the row's right, 13px `--muted`, `Board: {name}` when the project has one board. An empty filter matches every open ticket of the project's boards; the dry run says so with its count.

**4. Each task.** A row of three: `Kind` (`Select`: `Code`, `Refine`), `Agent profile` (`Select`: the profiles the project's members may use; the built-in `Refine` profile for refine), `Pool labels` (a chip input, mono chips, validated as `runnerLabelSchema`). A label no runner in the project's pools has shows a 12.5px `--muted` line under the field: `No runner in the project's pools has tier:gpu yet: its tasks would wait.` Then a `Switch` row: `Wait for a member's approval`, note `off: a rule's tasks start on their own` / `on: each task waits in Needs approval until a member approves it`.

**5. Delete** (saved automations only), after a `Separator`: a ghost `Button` with Lucide `trash-2`, `Delete rule` / `Delete schedule`, and 12.5px `--faint` `Its history and the tasks it started stay.` It opens an `AlertDialog`: `Delete Weekly bug sweep?` / `It stops at once. Its history and the tasks it started stay.` / `Cancel`, `Delete` (the destructive variant).

### The dry run (right column)

From `automations.dryRun({ filter })` on the form's current filter, debounced 400ms after the last change to it; the task section's kind and profile change the outcomes too.

1. **Head:** `Dry run` (13px `--muted` 600) and at its right mono 12.5px `--faint` `updated 1s ago`; while a new run is out, `updating…` with a 12px spinning `loader-circle`, and the list stays as it was (no skeleton flash).
2. **Count,** 17px 600 `--text`: `4 tickets match now` (`1 ticket matches now`; `No ticket matches now`). Under it 13px `--muted`: `What starting each would do. Nothing has started.`
3. **Matches,** rows of 52px with `--line` hairlines: the key mono 13px `--muted` (80px), then the title 14px `--text` (one line, ellipsis) over the outcome 13px `--muted`. Up to 50 shown, newest first; past 50, the last line reads `and 12 more. Start all starts 50 at a time.`

| Outcome | Copy |
|---|---|
| starts | `Starts a code task` / `Starts a refine task` |
| sub-issues | `Starts 3 tasks, one per sub-issue` (a code start on a parent, ADR 0056) |
| queued | `Queued: build-fleet is full` (only when the dry run returns admission, below) |
| has a task | `Skipped: it has a task, a17be093` (`--faint`, the ID a teal link) |
| started before | `Skipped: this rule started it before` (`--faint`) |
| no leaf on a board | `Skipped: none of its sub-issues is on this project's boards` (`--faint`) |

4. **`Start all N`,** a full-width primary button, 36px, Lucide `play`, where N is the tasks that would start (the picture: three tickets, five tasks). Under it 12.5px `--faint`: `{n} tasks from {m} tickets. One is skipped. Each starts as if started by hand, through the queue and the budget.` (`{k} are skipped`; the sentence drops when none is).
   - It calls `automations.startAll` with a request key, so a double click starts nothing twice. It needs the saved automation: while the form has unsaved changes, it reads `Save to start these` and is disabled; on a new rule, `Save the rule first`.
   - Pressed: `Starting… 2 of 5` with `loader-circle`; each row turns into its result as the bulk start streams (`Started · 3f9c21ab`, `Queued · c51a09de · build-fleet is full`, `Skipped: …`, `Failed: {errorText}` in `--red`), task IDs linking to the tasks. Done: the button becomes a secondary `Started 5 tasks` with `check`, disabled, and the count line reads `Started 5 tasks from 3 tickets just now`. The history has them as `start_all` runs.
5. **Prompt schedule:** no dry run. The head reads `Next occurrences`, then the next five in the zone, each a row with its date and `Starts "{title}"`, and 13px `--muted`: `A prompt schedule starts one task each time. Nothing starts until the first.`

## States and copy

| State | What changes |
|---|---|
| New rule | breadcrumb `… › New rule`, eyebrow `Automation · not saved yet`, `On a match` selected, empty filter with one `Labels` row open, `Create rule`; the dry run works (`dryRun({ filter })`), `Start all` reads `Save the rule first` |
| New schedule | `On a schedule`, preset `Every Monday`, the viewer's zone, `Check the filter` if the project has a board, else `Start one prompt task` |
| Dirty | eyebrow `· unsaved changes`; leaving asks `Leave without saving?` (`AlertDialog`: `Leave`, `Stay`) |
| Too frequent | under the cron field, 12.5px `--red`, `role="alert"`: `Occurrences must be at least an hour apart. This one fires every 30 minutes.`; no sentence, no Next; Save disabled |
| Not a cron | `Not a cron expression: the hour must be 0 to 23.` (the evaluator's message); `L`, `W`, `#` or a sixth field: `Schedules take five fields, without L, W or #.` |
| Saving | the button `Saving…` with `loader-circle`; the form read-only |
| Saved | eyebrow `saved just now`; the editor stays; an edited schedule's Next recomputes from now (ticket 10: an edit never fires a past time) |
| Save refused | under the top bar's line, 13px `--red`, `role="alert"`: `errorText(error)` (a profile members can't use, a label too long, …), with the field's own error under it |
| Paused automation | a 44px notice under the lede, as the history's (`automation-history.md`): `Paused by Alex Kim on 18 Nov.` / `Paused after 20 starts in an hour.` and a primary `Resume`; the form stays editable |
| Dry run failed | in the column, 13px `--red` `errorText(error)` and a teal `Try again` |
| No board | the filter section reads `Attach a board to filter tickets.` with a teal link to Boards; `On a match` is disabled with that as its tooltip; prompt schedules still work |
| A member | the editor read-only (inputs disabled, no Save, no Delete), the dry run shown, `Start all` hidden (ticket 24: `startAll` is a project admin's) |
| Narrow (below 1280px) | the dry run moves under the form, its head sticky with the count and `Start all N`. Below 640px the condition rows stack (field and operator on one line, values under), and the three task fields stack |

## Components (shadcn/ui names)

`PageFrame` with `Breadcrumb` and `wideProperties` (380px), `PageHeading`, `Field` + `Label` + `Input`, `Textarea`, `Select` (existing; searchable for the zone, as the audit log's menus), `ToggleGroup` (the trigger and the presets; from `radix-ui`, already a dependency), `RadioGroup` (existing), `Checkbox` (existing), `Switch` (existing), `Chip` with an inline combobox, `Button` (default, `secondary`, `ghost`, `link`), `AlertDialog` (existing), `Separator`, `Skeleton`. Lucide 15px, stroke 1.75: `zap`, `clock`, `calendar`, `plus`, `x`, `play`, `loader-circle`, `check`, `trash-2`, `chevron-down`.

## Tokens

> **Scale.** The approved pictures' scale wins on size, spacing and contrast: body 14.5px, dense 14px, secondary 13px, small 12px, title 26px, inputs 34px, buttons 30px (the dry run's 36px), the 380px form panel (`../m1/README.md`, "Scale").

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, the dry run column |
| `--surface` | `#131416` | inputs, selects, chips, presets, the segmented control |
| `--sel` | `#1A1B1E` | the chosen segment, the selected nav row |
| `--line` | `#1F2023` | the column's edge, the dry run's hairlines, separators |
| `--line-2` | `#2A2C30` | control borders, a switch that's off |
| `--text` | `#F2F3F4` | values, titles, the sentence, the chosen preset's border |
| `--muted` | `#B4B7BB` | section notes, outcomes, keys, labels over fields |
| `--faint` | `#8B8E93` | the eyebrow, Next's dates, skipped outcomes, footnotes |
| `--teal` | `#6FB8AA` | the checked checkbox, a switch that's on, links |
| `--red` | `#E5675C` | errors only |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save …`, `Start all N` |

Type: Manrope 700 for the title; IBM Plex Sans for everything else (600 for section titles and the count); IBM Plex Mono for the cron, ticket keys, task IDs, pool labels, the eyebrow and Next's dates.

## Data this screen needs beyond ticket 24

- **The dry run's admission:** section 4 lists the dry run's outcomes as start, `has_task` and started-before. `Queued: build-fleet is full` needs the admission check (`chooseRunner`, milestone 5) run read-only per would-be task; add it to `dryRun`, or drop the queued outcome and let the bulk start's results say it.
- **The sub-issue count** per match, for `Starts 3 tasks` (ticket 12's leaf walk, read-only).
- **The task IDs** of `has_task` skips, for the link.
- **`previewSchedule` with the viewer's zone,** for the occurrences' `title` (or the client converts; the zone math is the domain's either way).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New routes.** No `automations/` exists. Add `new/page.tsx`, `[automation-id]/page.tsx` and the shared `automation-editor.tsx`; `messages/en.json` keys under `automations.editor.*`.
2. **`components/ui/`** has `select`, `radio-group`, `checkbox`, `switch`, `alert-dialog`, `input`, `field`, `label`, `skeleton`. It needs `ToggleGroup` and `Textarea` (shadcn/ui on `radix-ui`, no new dependency) and milestone 2's `Chip`.
3. **The sentence and the evaluator** are `packages/domain`'s (ticket 06, ticket 10). The panel never parses cron itself: it shows what `previewSchedule` returns.
4. **The zone list** comes from `Intl.supportedValuesOf("timeZone")`, no dependency.

## Wrong in the image

Build the copy and details in this file, not these:

- The right column is about 430px. Build 380px.
- The `Name` input's value is in mono. Names are sans.
- The `Each time` choice (`Check the filter` / `Start one prompt task`) is missing under Next. It belongs there; the picture is the `Check the filter` case.
- The sentence's time (`09:00`) is drawn in mono inside a sans line. The sentence is all sans.
- The picture has no Delete section, no dirty, invalid, saving, paused, member, prompt-schedule or narrow state, and no `Start all` progress: they're in this file.
- The sidebar's `Linear` row has a generic circle icon. Use the icon milestone 2's Linear page settled on.

All visible copy in the image is spelled right after the one correction above.
