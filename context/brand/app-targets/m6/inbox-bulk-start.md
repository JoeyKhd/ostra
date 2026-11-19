# Target: starting many from the Inbox (milestone 6, screen 4)

> **Committed image:** `inbox-bulk-start.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `inbox-bulk-start.prompt.txt`. GPT Image 2.6 through Higgsfield, 3:2, 2k, high, 1 generation, kept as generated. References: the 2048 original of `app-targets/m2/inbox` (the screen the spec starts this one from), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** milestone 2's Inbox, `apps/web/src/app/(panel)/projects/[project-id]/inbox/page.tsx` (`../m2/inbox.md`); this target is its selection, in `components/inbox/inbox-selection.tsx` and `bulk-start-panel.tsx`.
- **Features:** F-107 (starting many), F-077 (sub-issues: a parent starts its leaves), F-010 (the Inbox, several at once). Spec section 12, screen 4; section 3, step 4. ADR 0056 ("Starting many", "Sub-issues"). Ticket 25 (`inbox.startMany`, `inbox.bulkStart` and its subscription, the sub-issue count), ticket 11 (bulk starts), ticket 12 (the leaf walk), ticket 32 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A member who has triaged the Inbox starts the tickets they picked in one action, through the same gates as one start: the one-active-task rule, admission and the pool caps, the budget. Before pressing, they see what each ticket will do: start a task, start one per sub-issue, wait in a pool's queue, or be skipped and why. After pressing, each ticket's result arrives on its own, because each starts in its own transaction; one that fails doesn't undo the others.

The picture shows Alex Kim with five tickets ticked in `calculator`'s Inbox, before pressing `Start 6 tasks`: `CALC-180` is a parent with three open sub-issues, `CALC-170` would wait for `build-fleet`, and `CALC-169` already has a task.

## Layout (CSS px at 1440 wide)

As `../m2/inbox.md`, with these changes while one ticket or more is ticked:

| Region | Size | Contents |
|---|---|---|
| Top bar | 46px | breadcrumb `calculator › Inbox`, nothing on the right |
| Page | `1fr`, padding `28px 36px` | title, lede, the **selection bar** in place of the filter row, the ticket rows with their checkbox column |
| Properties panel | 380px (the form width), 1px `--line` on its left, padding `20px 18px` | the **bulk start** in place of the selected ticket |

The picture draws the panel at about 387px. Build 380px.

### The checkbox column

Every row gets a 36px leading column with a 16px `Checkbox` (`--line-2` border, 4px radius; ticked: `--teal` fill with an `--ink` check), before the priority icon (the Inbox growing, spec section 12's second list). Ticking a row never opens it: a click on the checkbox ticks, a click elsewhere on the row selects it as before. `x` ticks the focused row, `Shift`-click ticks a range, `⌘A` / `Ctrl+A` ticks every loaded row. A ticked row has the `--sel` fill.

A parent ticket (one with open sub-issues on the project's boards) has a 14px `chevron-right` before its key that unfolds its children as indented rows (the Inbox growing), a `--faint` `Chip` `3 sub-issues` after its title, and while ticked, in its Task column, `--muted` `starts 3 tasks`. Ticking a parent ticks it, not its children: starting it starts its leaves (ADR 0056). A child can be ticked on its own; a child and its ticked parent count once.

### The selection bar

In place of the filter row, the same 44px height, `--surface`, 1px `--line-2`, 8px radius, padding `0 8px 0 12px`:

- the header checkbox (ticked with a minus while some are ticked, ticked while all loaded are; clicking it clears), `5 selected` 14px 500 `--text`, a `--faint` ` · `, a ghost `Clear` (`Esc` does the same);
- on the right two `Select`s, 30px, label-and-value as the filters: `Kind  Code` (`Code`, `Refine`), `Profile  Careful` (the profiles members may use, the project's default for the kind first);
- the primary `Start 6 tasks` (Lucide `arrow-up`), where 6 is the tasks the preview says will start, queued ones included, skipped ones not. `Start 1 task`; `Start 0 tasks` disabled when every ticked ticket would be skipped.

The bar's selects and the panel's are one state: changing either changes both.

### The panel: the bulk start

1. **Head:** `5 tickets, 6 tasks` (17px 600 `--text`), and 13px `--muted`: `Each ticket starts on its own. One that can't start doesn't stop the others.`
2. **Start,** `PropRow`s with full-width `Select`s (as the single start's form, `../m2/inbox.md`): `Kind`, `Agent profile` (bot icon, `Careful · Claude Opus 5.5`), `Run on`: `The project's pools` (a bulk start never goes to a personal runner: milestone 5's choosing a runner, a task no member pressed Start on alone is a pool's; ticket 25 decides it, the picture's copy follows). With the kind `Refine`, a parent refines itself, so the counts change (`5 tickets, 5 tasks`).
3. **What each one does,** the preview: one row per ticked ticket in the list's order, 48px (two lines for a long reason), `--line` hairlines: the key mono 13px `--faint` (90px), then the outcome 14px 500 `--text` over its reason 13px `--muted`.

| Outcome | Reason |
|---|---|
| `Starts a task` | `build-fleet has a free box` (or `on your machine` when the profile allows it; ticket 25) |
| `Starts 3 tasks` | `one for each sub-issue: CALC-182, CALC-183, CALC-184` (more than three: `CALC-182, CALC-183 and 4 more`) |
| `Queued` | `build-fleet is full. It's 2nd in line.` / `calculator's share of build-fleet is reached.` / `The project's budget is spent; it starts when it's raised.` (milestone 5's and milestone 4's wait reasons, as the task page says them) |
| `Skipped` (`--muted`) | `It already has a task, a17be093` (the ID a link) / `None of its sub-issues is on this project's boards` / `It has 64 sub-issues, over the limit of 50` / `You can't use the Careful profile` |

4. The primary `Start 6 tasks`, full width, 36px, `arrow-up`, the same action as the bar's. Under it 12.5px `--faint`: `Up to 50 tickets at once. Each goes through the queue and the budget like any start.`

## States and copy

| State | What changes |
|---|---|
| Nothing ticked | the Inbox as `../m2/inbox.md`: the filter row, the selected ticket in the panel. The checkbox column stays |
| One ticked | the bar and panel as above, `1 selected`, `1 ticket, 1 task`, `Start 1 task` |
| Previewing | while `inbox.list`'s counts and the preview load after a change, the outcome lines are `Skeleton` bars and the buttons stay enabled with the last count |
| Over 50 | the bar reads `62 selected` in `--text` and, in `--red` 13px after it, `Up to 50 at once`; both buttons disabled |
| Starting | both buttons read `Starting… 4 of 6` with `loader-circle`; the checkboxes and selects are read-only; the panel's head reads `Starting 6 tasks`. `inbox.startMany` is called once with a request key, so a second press or a retry starts nothing twice |
| Results (streamed) | each row's outcome turns past tense as its item lands, with its task: `Started` `Running · 3f9c21ab`; `Started 3 tasks` `b20e7f31, c51a09de, d7f3c842`; `Queued` `c51a09de · build-fleet is full, 2nd in line`; `Skipped` and its reason; `Failed` in `--red` with `errorText`. The list's Task column fills in at the same time, and the started rows untick |
| Done | the head reads `Started 6 tasks from 4 tickets. 1 skipped.`; the panel keeps the results until the member ticks something else or presses `Done` (secondary, replacing the primary), which returns the Inbox to its normal state. The results stay reachable from each task (`Started with 4 others by Alex Kim`) |
| Refused as a whole | (no access, the bulk limit) a 13px `--red` line under the button, `role="alert"`, `errorText(error)`; nothing started |
| Lost connection | the stream reconnects and re-reads `inbox.bulkStart({ id })`; items keep their state |
| A ticket changes while ticked | it keeps its tick; its preview line refreshes (a ticket that gains a task becomes `Skipped`) |
| Phone width | the bar becomes a bottom bar over the list (count, `Clear`, `Start 6 tasks`); `Start` opens the panel as a bottom sheet with the selects and the preview (`../m2/phone-inbox.md`) |

## Components (shadcn/ui names)

The Inbox's (`../m2/inbox.md`), plus `Checkbox` (existing, with the indeterminate state), a `SelectionBar` (a toolbar, `role="toolbar"` with `aria-label="5 tickets selected"`), `Select` (existing), `PropGroup` / `PropRow`, `Skeleton`, `Button`. Lucide 15px, stroke 1.75: `arrow-up`, `chevron-right`, `chevron-down`, `bot`, `server`, `loader-circle`, `check`.

## Tokens

> **Scale.** The approved pictures' scale wins (`../m1/README.md`, "Scale").

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--surface` | `#131416` | the selection bar, selects, chips |
| `--sel` | `#1A1B1E` | ticked rows, the selected nav row |
| `--line` / `--line-2` | `#1F2023` / `#2A2C30` | hairlines / the bar's and checkboxes' borders |
| `--text` | `#F2F3F4` | titles, outcomes, `5 selected` |
| `--muted` | `#B4B7BB` | reasons, `starts 3 tasks`, `Skipped` |
| `--faint` | `#8B8E93` | keys in the panel, ages, footnotes |
| `--teal` | `#6FB8AA` | ticked checkboxes, task links |
| `--green` | `#4CC38A` | the dot beside `Running` only |
| `--red` | `#E5675C` | errors and `Failed` only |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Start 6 tasks`, the check in a ticked box |

## Data this screen needs beyond ticket 25

- **The preview.** Ticket 25 gives each ticket's sub-issue count and "starts N tasks" in `inbox.list`, and the results after the start. The per-ticket preview (`Queued: build-fleet is full`, `Skipped: you can't use Careful`) needs a read-only pass of the start use case's checks for the ticked tickets: add `inbox.previewStart({ ticketIds, kind, agentProfileId })`, sharing the dry run's code (`automation-edit.md`), or show only what `inbox.list` already knows (has a task, sub-issues) and let the results say the rest.
- **The sub-issues' keys,** for `one for each sub-issue: …` (ticket 12's leaf walk).

## Differences from the current code

1. **The Inbox doesn't exist on `main` yet** (milestone 2, ticket 35). This target builds on `../m2/inbox.md`; build that first.
2. **`components/ui/checkbox.tsx`** exists; check it has the indeterminate state (Radix's `checked="indeterminate"`), else add it there.
3. **The streamed results** use the app's existing tRPC subscription path (milestone 1's task stream), keyed by the bulk start's ID.

## Wrong in the image

Build the copy and details in this file, not these:

- The panel is about 387px. Build 380px.
- `CALC-169`'s row shows `In Progress` and `Running` in a smaller size than the other rows. Rows share one size.
- The selection bar's checkbox shows a minus (some ticked) and is filled teal; that's right, but it's drawn at 20px. Checkboxes are 16px.
- The panel's `Run on` reads `The project's pools`, which ticket 25 hasn't settled (above).
- The panel's keys (`CALC-174`) are vertically centred on two-line rows; align them to the outcome's line.
- The parent's children aren't shown unfolded anywhere; the chevron's unfolded state is in `../m2/inbox.md`'s growth list (spec section 12).
- The picture has no starting, results, done, over-limit, refused or phone state: they're in this file.

All visible copy in the image is spelled right.
