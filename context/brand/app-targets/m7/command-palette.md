# Target: the command palette with actions (milestone 7, screen 5)

> **Committed images:** `command-palette.webp` (desktop) and `command-palette-phone.webp` (phone width, two screens), each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

| Picture | State shown |
|---|---|
| `command-palette.webp` | Alex Kim, an organization admin, pressed ⌘K on Home with nothing typed. The palette lists the page's actions first (`Approve…`, `Deny…`, `Answer…`, `Reopen a task…`), then the actions anywhere, then `Go to` with the two-key sequences, then the recent tasks. `Approve…` is selected. |
| `command-palette-phone.webp` | The same palette at 390px as a bottom sheet (left), and the second step of `Reopen a task…` with CALC-161 chosen and a message typed (right). |

- **Prompts:** `command-palette.prompt.txt` and `command-palette-phone.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation each, kept. References: the approved 2048 original of `../m4/search-palette` (the screen spec section 13 names as the start) for the desktop picture, the approved 2048 original of `../m3/phone-approval` (the approved phone pair) for the phone picture, plus `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png` for both.
- **Feature:** F-081 (keyboard and accessibility). Spec section 4 ("The palette's actions"), section 5.4 (`PaletteAction`), section 12 item 11 (the actions and shortcuts, Q260), section 3 step 7. Ticket 05 (the registry's type), ticket 13 (this screen), ticket 16 (the keyboard paths of the core actions), ticket 17 (the walk and the contrast check).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 13 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and at 390×844 and compare them with the pictures.

## Purpose

One place to do anything in the panel from the keyboard. Milestone 1's ⌘K jumped to pages and milestone 4's searched tasks; milestone 7 adds **actions**: approve, deny, answer, take over, reopen, stop, message the agent, new task, new project, switch organization, the theme. The F-081 tests do "jump to needs you", approve, answer, take over and reopen from here with the keyboard only, so every one of them has to be reachable in a few keys and say what it will do before it does it.

The palette, the single-key shortcuts and the `?` sheet (`shortcut-sheet.md`) read **one registry** (ticket 13, typed by the domain's `PaletteAction`: ID, message key, shortcut or none, scope, role, the procedure it calls). The palette shows each action's shortcut, so using the palette teaches the keys.

## Route

No route: the milestone 4 `Dialog` over every panel page (`components/shell/command-menu.tsx`, grown into search by milestone 4, `../m4/search-palette.md`). Opened by ⌘K or Ctrl+K, by the sidebar's Search box, and by `/` (which opens it straight into search, as milestone 4 had it). New: the registry under `components/shell/actions/`, read by the palette.

## Layout (desktop)

The page underneath stays as it was, under the current overlay (`bg-black/50`).

**The palette:** as milestone 4's: `Dialog.Content` 680px (`min(680px, 100vw - 32px)`), centred, top at `14vh`, `--surface` fill, 1px `--line-2`, radius 12px, the menu's current shadow. The list scrolls inside a palette at most `min(560px, 70vh)` tall.

1. **Query row,** 52px, padding 0 16px, a 1px `--line` under it: `search` 16px `--muted`, 12px gap, the input (15px `--text`), `esc` as a `Kbd` at the right. Placeholder with nothing typed: `Type a command, or search tasks` `--faint`. In a second step, the step's chip comes first (below).
2. **Groups.** A group label row 28px, padding 0 16px: the label 12px weight 500 `--faint`; for `On this page`, the page's name right-aligned in 12px `--faint` (`Home`, `CALC-174`). A 1px `--line` between groups, none between rows of a group.
3. **Action row,** 36px, padding 0 16px, one grid for every row:

| Column | Width | Content |
|---|---|---|
| Icon | 28px | the action's Lucide icon, 15px `--muted` |
| Label | `1fr` | 14px `--text`; an action that needs a choice ends in `…` (`Approve…`). Then, 12px after, a hint in 13px `--faint`: what waits (`3 waiting`, `1 question`) |
| Shortcut | auto, right | `Kbd`s: one key (`a`); a sequence as two `Kbd`s with `then` 11px `--faint` between them, 6px each side (`g` then `n`); a chord as two `Kbd`s 4px apart, no word (`⌘` `K`). None for an action with no shortcut |
| Next step | 20px, right | `chevron-right` 14px `--faint` on an action that opens a second step; empty otherwise |

4. **Task row** (the `Recent tasks` group with nothing typed; the `Tasks` group with text): milestone 4's result row (key 72px mono `--faint`, title, project square and name, age), unchanged.
5. **Selected row:** `--sel` fill, radius 8px, inset 6px from the palette's sides, **and a 2px `--text` bar inside its left edge** (the contrast rule below). The mouse moves the selection, as today.
6. **Footer,** 36px, padding 0 16px, a 1px `--line` above, 12px `--faint`, `Kbd` + word pairs 14px apart: `↑` `↓` `Move`, `↵` `Run`, `→` `Next step`, `?` `All shortcuts`, `esc` `Close`. While the query holds filter tokens it's milestone 4's footer (`⌘↵` `See all`, `Filters: …`).

### The groups, in order

| Group | When | Rows |
|---|---|---|
| `On this page` | the page has actions in scope | the registry's actions whose scope is the current page or the focused item, and that the member's role allows (below). Label suffix: the page's name |
| `Actions` | always | the actions in scope anywhere: `New task` (`c`), `New project`, `Switch to the light theme` / `Switch to the dark theme`, `Switch organization…` (only with more than one organization, which is after v1 since 2026-11-19: F-134, so v1 never shows it) |
| `Go to` | always | `Needs you` (`g` then `n`), `Home` (`g` then `h`), `Tasks` (`g` then `t`), then milestone 1's destinations without shortcuts (Runners, Models, Agent profiles, each project's Tasks and Environment). With nothing typed only the three with shortcuts show |
| `Recent tasks` / `Tasks` | nothing typed / text typed | milestone 4's: the 5 most recently opened, or the top results from `search.suggest` with their snippets and `See all {n} results` |

With text typed, every group filters on the label and the action's keywords (`approve` also matches `allow`, `accept`; `stop` matches `cancel`; the message file holds them), and a group with no match is hidden. With a filter token (`repo:`, `status:`…) the palette is milestone 4's search alone: actions and `Go to` hide.

### `On this page`, by page

| Page | Rows |
|---|---|
| Home, Needs you, a project's Tasks | `Approve…` `a`, `Deny…` `d`, `Answer…` `r` (each with its count; hidden at 0), `Reopen a task…` |
| A task that needs you | `Approve` `a`, `Deny` `d`, `Answer` `r` (whichever the open item is: no `…`, no second step, it acts on this task's item), `Message the agent`, `Take over` `t`, `Stop` `s` |
| A running task | `Message the agent`, `Take over` `t`, `Stop` `s` |
| A stopped or finished task | `Reopen…` `o` (straight to the message step for this task) |
| Any other page | no group |

## The second step

An action whose label ends in `…` opens a second step **inside the palette** (Enter or `→` on it). Nothing is done until the second step's Enter.

- **The query row** shows the step's chip first: 24px, radius 5px, 1px `--line-2`, `--bg` fill, 12.5px sans `--text` (`Approve`, `Reopen`), then the input, which now filters the step's list. `chevron-left` 15px `--muted` before the chip on a phone (below); on desktop, Backspace in an empty input or `←` goes back a step, and `esc` goes back a step before it closes.
- **`Approve…`, `Deny…`:** the open approval requests the member may answer, oldest first (milestone 3's needs-you items of kind approval), rows 52px: key mono `--faint`, title 14px `--text`, under it what's asked 13px (`OpenCode wants to run` + mono `pnpm add p-retry`), project and age at the right. Enter on a row: **approve once** (as `a` and the card's `Approve once`); for `Deny`, the row opens an inline reason line under it (`Input`, placeholder `Why, for the agent (optional)`), and Enter sends the denial. The footer reads `↵` `Approve once` (or `Deny`) and `esc` `Back`. On success the palette closes and the shell's toast says `Approved CALC-142's request.` / `Denied CALC-142's request.`
- **`Answer…`:** the open questions, the same rows with the question's first line. A question of one choice list or one text field is answered inline under its row (radio rows or an `Input`, Enter sends). A question with more fields opens the task page at its question card with the first field focused, and the palette closes (`Opens CALC-150 to answer`, as the row's hint).
- **`Reopen a task…`:** the member's stopped and finished tasks they may reopen, most recent first, rows as `Recent tasks`. Enter picks one, and the step becomes **the message**: the task's key, project, title (16px 600) and state line (`Stopped 1h ago by Alex Kim · its worktree is kept`), the label `Message to the agent` 12px `--muted`, a `Textarea` (3 rows, grows to 8, `--bg`, 1px `--line-2`, radius 8px) focused, then 12.5px `--faint` where it resumes (`It resumes on the same worktree, from its own session.`; `It resumes on a fresh worktree, from the archive.`; or `It starts again from the task's record.`, from milestone 2's reopen rule), then the footer `⌘` `↵` `Reopen task`, `esc` `Back`. Enter adds a line; ⌘↵ (Ctrl+↵) sends. An empty message is allowed (`Reopen task` sends "carry on" as milestone 2's reopen does).
- **`Switch organization…`:** the member's organizations, the current one with a `check`; Enter switches (the switcher of milestone 4's ticket 44). *Not built in v1 (2026-11-19): it comes with several organizations, F-134.*

A step that fails keeps the palette open with 13px `--red` `role="alert"` under the query row: `errorText(error)` (`That approval was answered by Sam Rivera a moment ago.` when someone else answered first).

## Hidden by role

The registry's `role` and scope decide what's offered, and **the API checks the same condition** (ticket 05), so a hidden action is also refused if called. Nothing is shown disabled: an action the member can't take isn't listed, and no row says why.

| Action | Listed for |
|---|---|
| `Approve…`, `Deny…`, `Answer…` | members of the item's project (milestone 3: any member of the project may answer; the first answer wins). The counts count only those items |
| `Take over` | a member who may drive the task (milestone 3's driver rule); not on a task they already drive |
| `Stop`, `Message the agent` | the task's driver, and an organization admin |
| `Reopen…` | members of the task's project |
| `New project` | organization admins |
| `New task` | members of at least one project |
| `Go to` rows | the destinations the member can open (milestone 1's `destinations.ts` rules: no `Runners` admin pages for members) |

A member with nothing in scope on a page sees no `On this page` group, never an empty one.

## Phone width (`command-palette-phone.webp`)

- **A bottom sheet,** full width, from the bottom edge to 64px under the top bar; `--surface`, 1px `--line-2` top border, top corners radius 14px; a 36×4 grabber `--line-2` centred 8px from its top; the page under it dimmed (`bg-black/50`). Dragging the grabber down or `Cancel` closes it.
- **The query row** 52px: `search` 16px, the input 16px (no zoom on iOS), and a teal text button `Cancel` at the right in place of `esc`.
- **Rows 48px** (touch size), label 15px, the hint right-aligned before the chevron. **No `Kbd`s and no footer** on a phone: there's no keyboard to teach.
- **The second step** replaces the list in the same sheet: `chevron-left` (a 44px target) to go back, then the step's chip and the chosen task's key in 16px 600. Its action is a full-width primary 44px button (`Reopen task`, with `corner-down-left` 16px) and an outline 44px `Back` under it. The sheet grows to fit the keyboard (`visualViewport`), so the button stays above it.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json` under `palette.*`. New unless marked.

| State | Shows |
|---|---|
| **Nothing typed, on Home** (`command-palette.webp`) | As above |
| Text typed | the matching rows in each group, then `Tasks` with milestone 4's results; the first row selected |
| Nothing matches | in place of the groups, padding 28px 16px, centred: 14px `--muted` `No command or task matches.` and 13px `--faint` `Try a task's key, a word from its thread, or Go to.` |
| A second step's list empty | `Nothing waits for your approval.` / `No question waits for you.` / `No task of yours to reopen.` 14px `--muted`, and `esc` `Back` |
| A step working | the selected row's chevron turns into `loader-circle` 14px (spinning, still with reduced motion); the input is read-only |
| A step failed | the `role="alert"` line above, the step stays |
| Done | the palette closes; the toast (`Approved CALC-142's request.`, `Reopened CALC-161.`, `Took over CALC-174.`, `Stopped CALC-174.`) |
| `Stop` | the shortcut `s` asks to confirm (ticket 13); from the palette the row itself is the confirmation, so it runs with Enter |
| The theme | the row reads `Switch to the light theme` in dark and `Switch to the dark theme` in light; with `Match my system`, the opposite of what's showing. It calls `account.setTheme` and repaints at once |
| Loading the counts | the hints (`3 waiting`) are a 40px `Skeleton`; the rows are there at once |

## Keys

| Key | Does |
|---|---|
| ⌘K / Ctrl+K | opens the palette; closes it when open (as today) |
| `/` | opens the palette for search (as milestone 4) |
| `↑` `↓` | move through every row of every group, wrapping |
| Enter | runs the selected action, or opens its second step, or opens the task |
| `→` | opens the second step of a `…` row (nothing on others) |
| `←`, Backspace in an empty input | back one step |
| Escape | back one step; at the first, closes |
| ⌘↵ / Ctrl+↵ | sends the reopen message; on search, milestone 4's `See all` |
| `?` in an empty query | opens the shortcut sheet in place of the palette |

The single-key shortcuts don't fire while the palette is open (its input has focus): `a` types an `a`.

## Components (shadcn/ui names)

- **From the repo:** milestone 4's palette (`Dialog` from `radix-ui`, `role="combobox"` with `aria-activedescendant`, `role="listbox"` / `role="option"` rows), `Kbd` (`components/ui/kbd.tsx`), `Textarea`, `Input`, `Skeleton`, `Sheet` for the phone (`side="bottom"`), the toast.
- **New:** `components/shell/actions/registry.ts` (the actions, typed by `PaletteAction`), `components/shell/actions/use-scope.ts` (the page and focused item in scope), `palette-step.tsx` (the second step), `kbd-sequence.tsx` (a sequence or chord of `Kbd`s, used here and in the sheet).
- **Groups** are `role="group"` with `aria-labelledby` on their label; a `…` row has `aria-haspopup="true"`; the step's chip is part of the input's label (`aria-label="Reopen: search tasks"`).
- **Icons** (Lucide 15px, stroke 1.75): `search`, `check`, `x`, `message-square-reply`, `rotate-ccw`, `plus`, `folder-plus`, `sun` / `moon`, `arrow-left-right`, `hand`, `house`, `list-checks`, `steering-wheel` (take over), `circle-stop` (stop), `message-square` (message the agent), `chevron-right`, `chevron-left`, `corner-down-left`, `loader-circle`.

## Tokens

The measured dark tokens (`apps/web/src/app/globals.css`, `../m1/README.md` "Scale"); the light ones from `light-home` and `light-task` once approved. No amber inside the palette: an approval waiting is counted in `--faint` words, and amber stays on the page's own needs-you markers. The primary button exists only in the phone's second step (`Reopen task`); on desktop the action runs from the row.

## Contrast (WCAG AA, F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text` #F2F3F4 on `--surface` #131416 (labels) | 16.6:1 | 4.5 |
| `--text` on `--sel` #1A1B1E (the selected label) | 15.5:1 | 4.5 |
| `--muted` #B4B7BB on `--surface` (icons, the page name) | 9.2:1 | 4.5 / 3 |
| `--faint` #8B8E93 on `--surface` (group labels, hints, `then`) | 5.6:1 | 4.5 |
| `--faint` on `--bg` #0D0E10 (`Kbd` text) | 5.9:1 | 4.5 |
| teal #6FB8AA on `--surface` (`Cancel`) | 8.0:1 | 4.5 |
| Shell #F3F0E8 / ink #0C1D21 (`Reopen task`) | 15.2:1 | 4.5 |
| **`--sel` against `--surface` (the selected row's fill alone)** | **1.1:1** | **3 (a state)** |

The fill alone doesn't meet 1.4.11, so the selected row also carries the 2px `--text` bar on its left edge (16.6:1). The `Kbd` border (`--line-2`, 1.3:1) is decoration: the key's letter carries it. Ticket 17 checks the light theme's pairs the same way.

## Data this screen needs

- **The counts** for `Approve…`, `Deny…`, `Answer…`: the open needs-you items the member may answer, by kind, from milestone 3's needs-you query (`needsYou.list` with counts), refreshed on open.
- **The second steps' lists:** the same query's items; for reopen, `tasks.list` filtered to stopped and finished tasks the member may reopen (milestone 2's rule), recent first, with each task's reopen route (in place, archive, rebuild) for the line under the message.
- **The role and scope** from the session and the page (ticket 05's `PaletteAction.role`; the API refuses the same).
- **The procedures** are milestone 2 and 3's: `approvals.answer`, `questions.answer`, `tasks.takeOver`, `tasks.stop`, `tasks.reopen`, `tasks.steer`; `account.setTheme` (ticket 11).

## Differences from the current code

1. **`command-menu.tsx`** jumps to destinations (and, once milestone 4 lands, searches). It gains the registry's groups, the second step and the phone sheet. One dialog, as milestone 4 says.
2. **The `Go to` rows** come from `destinations.ts` as today; three of them gain shortcuts from the registry.
3. **No registry, no scope hook, no `kbd-sequence.tsx`** exist yet.
4. **The theme row** needs ticket 18's theme; until it lands, the row isn't registered.
5. **Messages:** `palette.*` for every line above; each action's label, hint, keywords and toast under `actions.<id>.*`, which the sheet reads too.

## Open points (recommendations; ticket 13 records the answer)

1. **Where the global actions sit.** Spec section 4 orders the page's actions, then go-to, then search. The target puts `Actions` (anywhere) between the page's and `Go to`, since `New task` is the most-used command. Recommended: as drawn.
2. **`Approve…` approves once.** `Approve for this task` stays on the card (milestone 3), not in the palette, so a keyboard approval never widens a rule by accident. Recommended: as written.
3. **`Stop` from the palette without a second confirm.** The row names the task and Enter is deliberate. Recommended: as written; the bare `s` key asks (ticket 13).

## Wrong in the image (build from this file)

- **The palette is about 756px wide and its top at about 153px.** Build 680px at `14vh`, as milestone 4.
- **The group labels** (`On this page`, `Actions`, `Go to`, `Recent tasks`) are drawn bright and semibold. Build 12px weight 500 `--faint`.
- **The hints** (`3 waiting`) sit at different x after each label. They follow the label 12px after it.
- **The selected row** has no left bar. Build the 2px `--text` bar (contrast, above).
- **`Signed in as an admin`** in the footer is invented. Drop it: the palette never announces the role.
- **The scrim** reads lighter than `bg-black/50` on the right panel. Use the current overlay.
- **On the phone, the page behind the sheet** is barely dimmed. Use the same overlay.
- **On the phone, `Tasks` has a `layers` icon.** It's `list-checks`, as on desktop.
- **The hinge mark** is redrawn. Use `kit/logo/export/ostra-hinge-single-color.svg`.
- **The sidebar** is milestone 4's picture's, with rows from other milestones. Build it from `sidebar.tsx`.
- **Task keys, titles, counts and ages** are demo data, not copy.
