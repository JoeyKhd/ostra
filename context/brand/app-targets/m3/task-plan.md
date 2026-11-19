# Target: plan first on the task page

> **Committed images:** `task-plan.webp`, `task-plan-edit.webp` and `task-plan-approved.webp`, each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The targets for plan first (F-063) on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: the plan turn's marker, the proposed plan as a needs-you block, its three answers, the editor, and the approved plan's receipt. The page is `../m2/task-ticket.md` (itself `../m1/task.md` plus the ticket) with milestone 3's growth (the tabs, the `Profile` row, the usage rows); this file only adds the plan. Where a picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-plan.webp` | Ticket `CALC-196` from Linear, started by Alex Kim on the `Careful` profile, which has plan first on. The first turn ran in plan mode: OpenCode read two files and searched, then proposed a plan. The task needs Alex, its driver: `Needs you · plan`. The ticket already has ostra's needs-you comment (F-036). |
| `task-plan-edit.webp` | Alex pressed `Edit and approve`: the message and the steps are fields. He changed step 5 and added step 6. |
| `task-plan-approved.webp` | Five minutes later. Alex approved the edited plan; its block became one receipt line; the build turn runs from it and the plan view tracks its progress. Nothing waits on Alex. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high), one generation each. `task-plan`: references the approved `../m2/task-ticket` original, the approved `../m1/task` original, `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). `task-plan-edit` and `task-plan-approved`: reference the `task-plan` generation, the `m1/task` original and the logo. Prompts: `task-plan.prompt.txt`, `task-plan-edit.prompt.txt`, `task-plan-approved.prompt.txt`.
- **Features:** F-063 plan first, F-021 (the `Profile` row), F-036 (the ticket's needs-you comment in "On Linear"), F-084 (the usage rows). Ticket 43 builds it; ticket 35 serves `plans.answer` and the pending plan on `tasks.get`; ticket 18 raises and answers the item; ticket 31 runs the plan turn; ADR 0049 holds the rules.

## Purpose

Before an agent touches the repo, the driver reads what it intends to do and decides: start it as proposed, fix the plan and start it, or send it back with a request. The plan stays in the thread as the record of what was agreed, and the build turn's progress is read against it.

## Layout

Unchanged from `../m2/task-ticket.md`: sidebar 232px, top bar 44px, thread column `padding: 28px 40px 20px`, properties 300px. Milestone 3's tabs sit under the context row (`Activity`, `Changes` + `--faint` count, `Checks`: 36px, 13px weight 500, `--muted`, the selected one `--text` with a 2px `--shell` underline on the header's hairline; the same component as `task-approval.md` and the other task targets). This screen changes four places:

1. **The thread:** the plan turn's marker, the plan block, its receipt, and the build turn's marker.
2. **The composer** while the plan waits.
3. **The header status** and the top bar (Stop stays: the session is live).
4. **The properties panel:** `Profile` and `Plan`.

### The plan turn's marker

A message-level row (`../m2/task-reopen.md`'s rows between turns: a 14px icon centred in the 40px gutter, **no circle**, 13px `--muted` text in the content column, then mono 12px `--faint` detail after 12px). Icon `list-checks`. It sits before the plan turn's agent message. One line; the detail truncates first.

### The plan block (pending)

No card: the approval's block (`../m1/task.md`). A 2px `--amber` left rule, 12px left padding, indented to the content column, 10px above and below. It follows the plan turn's tool rows, inside that agent message. Top to bottom:

1. **Title:** `list-checks` 14px + `Needs you · plan`, `--amber` 13px 600.
2. **Message:** `plan.proposed.message`, the turn's last agent message, 13px/1.5 `--text`, as `.agent-md` (markdown, no raw HTML). At most 12 lines, then `Show the rest` (milestone 1's teal 12px disclosure).
3. **Plan:** label `Plan` 12px `--faint`, 8px above; then one 24px row per entry: a mono 12px `--faint` number in a 24px column, then the entry's text 13px `--text` (inline code in the entry renders mono). No status glyphs: nothing has started.
4. **Buttons,** 28px, 8px apart, 12px above: `Approve plan` (amber: `--amber` fill, `--ink` text, 600), `Edit and approve` (outline, `pencil` 13px), `Ask for changes` (outline).
5. **Footnote,** 12px `--faint`.

A plan with no entries (the agent wrote only prose) shows the message and no `Plan` label; `Edit and approve` then edits the message only.

### The editor (`Edit and approve`)

The same block, rows 2 to 5 replaced:

- Title gains ` · editing` in 12px `--faint`.
- `Message`: label 12px `--faint`, then a `Textarea` (`--surface`, 1px `--line-2`, radius 8px, 13px, 3 rows growing to 12) holding the message as markdown text.
- `Plan`: label, then one 32px row per step: `grip-vertical` 14px `--faint` (drag to reorder; also `Alt+↑` / `Alt+↓` in a field), the number mono `--faint`, an `Input` 28px (radius 6px, 13px) filling the width, then a ghost icon button `x` 14px `--faint` to remove it (`aria-label` `Remove step {n}`). `Enter` in a step adds a step after it; `Backspace` in an empty step removes it.
- `+ Add a step`: teal 12.5px text button with `plus` 13px, aligned with the inputs.
- Buttons: `Approve edited plan` (amber; `Approve plan` while nothing changed), `Cancel` (ghost), which restores the proposal and keeps no draft. `⌘↵` / `Ctrl+↵` approves.
- Footnote.

At most 50 steps of 500 characters, and the whole plan at most 64 KiB (spec 5.1); over a limit, a red 12px line under the buttons and the button disabled.

### The composer while the plan waits

The driver's composer stays and changes its job: a message now asks for another plan (ADR 0049's "Ask for changes"). `Ask for changes` in the block focuses it; there's no second field in the block. Only `Send`: no `Interrupt and send`, since no turn runs.

### The receipt (answered)

The block becomes one 12px `--muted` line under the plan turn's tool rows, aligned with the message text, with `check` 12px `--muted` before it: the answer, then the time mono `--faint`, then the teal 12px disclosure `Show the plan` / `Hide the plan` (no underline), which opens the plan as approved (message and numbered steps, as the pending block draws them, without the rule and buttons). No amber.

### The build turn's marker

A message-level row, icon `play`, before the build turn's agent message. The build turn's `data-plan` is milestone 1's plan view (green check, teal `circle-dot`, `--faint` circle), fed by the agent's updates from the approved plan.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json` under `task.plan.*`. All of it is **new** unless it says milestone 1.

### Markers

| Event | Icon | Text | Detail (`--faint`, mono) |
|---|---|---|---|
| `turn.started { mode: "plan" }`, first plan turn | `list-checks` | `Plan first: {agent} reads the code and proposes a plan. It can't edit files or run commands in this turn.` | `profile {profile}` |
| `turn.started { mode: "plan" }` after `Ask for changes` | `list-checks` | `{agent} plans again with {name}'s changes. It can't edit files or run commands in this turn.` | `plan {n}` |
| `turn.started { mode: "build" }` after an approve | `play` | `{agent} works from the approved plan. Plan mode is off.` | |
| a plan turn that left a change in the tree (`turn.failed` with paths) | `triangle-alert`, `--red` text | `The plan turn changed files, so nothing was kept: {paths}` | |

### The agent message's status word

While the plan turn runs: teal `planning` (milestone 1's `working` slot). After it: `--faint` `proposed a plan`. A revise turn: the same.

### The plan block

| Part | Copy |
|---|---|
| Title | `Needs you · plan` (+ ` · editing`) |
| Footnote, driver | `Nothing in the repo has changed. {agent} starts the work from the plan you approve.` |
| Footnote, editing | `{agent} starts the work from the plan as you leave it.` |
| A watcher | the block in `--muted` with a `--line-2` rule and no buttons, its title in `--text`, and 12px `--faint` `{driver} answers the plan. ` + teal `Take over to answer` |
| In flight | `Approving…`, buttons disabled |
| Error | red 12px line under the buttons, the block kept (an edit kept too) |
| The box idled out while waiting | the block stays answerable; footnote gains ` Approving reopens the task on a fresh box.` (ticket 18: the answer reopens in the right mode) |

### The composer

| State | Placeholder | Hint | Button |
|---|---|---|---|
| the plan waits, driver | `Ask for changes to the plan…` | `Send asks {agent} for another plan. To start the work, approve the plan.` | `Send` (primary) |
| the plan waits, watcher | the watcher's bar (`task-approval.md`) | | `Take over` |
| the plan turn runs | `Message the agent…` | milestone 1's per-agent hint | milestone 1's |

A message sent while the plan waits is `plans.answer(taskId, "revise", text)`; the thread shows it as a member message with ` · asked for changes` in `--faint` 12px after the time (the reopen tag's style, `../m2/task-reopen.md`).

### Receipts

| Answer | Line |
|---|---|
| Approved as proposed | `Plan approved by {name}` |
| Approved with edits | `Plan approved by {name}, with edits` |
| Asked for changes | `Changes asked by {name}`; the request is the member message under it |
| Closed without an answer (the task stopped) | `The plan wasn't answered: the task stopped.` |

`Show the plan` opens the plan as approved. With edits, the steps the member changed or added carry a 12px `--faint` `edited` after them; removed ones aren't shown.

### Header and properties

| Place | Value |
|---|---|
| Status line | amber dot + `Needs you · plan` (`--text`), then milestone 1's elapsed part. While the plan turn runs: teal dot + `Running` · `Planning` (the activity) |
| Properties `Status` | as the status line |
| `Profile` | the profile's name, plain |
| `Plan` | `Proposed · turn {n}` while it waits; `Approved`, or `Approved · edited`; `Changes asked` while the revise turn runs; the row is hidden for a task whose profile has no plan first |
| `On Linear` | F-036's comment row, `Needs you comment` with `posted {age} ago` / `edited {age} ago` (ticket 11; its copy is the needs-you target's) |

## Tokens and components

Tokens: `app-concepts/html/graphite.css`; nothing new. Icons (Lucide, 14px in the thread): `list-checks`, `play`, `pencil`, `grip-vertical`, `x`, `plus`, `check`.

| Part | Component |
|---|---|
| Markers | the message-level variant of `Line` (`../m2/task-reopen.md`) |
| Plan block | the shared `NeedsYou` block; `Button` amber and `outline` |
| Plan entries | plain `ol`, the milestone 1 plan row's 24px rhythm |
| Editor | `Textarea`, `Input`, `Button variant="ghost" size="icon"`, drag with the browser's own drag events (no new dependency) |
| Receipt | plain `p` + `Collapsible` for `Show the plan` |
| Composer | assistant-ui `ComposerPrimitive` as today, with the revise mode's placeholder, hint and call |

## Differences from the current code

1. **`data-plan`** (`renderers.tsx`) is the live progress view, and the fold has no proposal. Ticket 43 adds `data-plan-proposal` in `packages/task-view` from `plan.proposed` and `plan.answered`: the entries, the message, the state (`pending`, `approved`, `revised`, `closed`), the approved text and who answered.
2. **Turn markers:** `turn.started` has no row today; its `mode` (spec 5.1) draws the plan and build markers.
3. **The composer** has no revise mode; it gains one while `tasks.get` returns a pending plan and `capabilities.answerPlan`.
4. **Status:** `taskState` gains `Needs you · plan` (the `plan` reason exists in `NeedsYouReason`; the panel has no text for it).
5. **Properties:** `Profile` and `Plan` rows are new.

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **The approved plan's text.** ADR 0049 says the edited list and message become the plan. The build prompt then carries the edited text; the thread's receipt shows it. Whether the original proposal stays viewable after an edit (a "Show what was proposed" toggle) is open; this file shows only the approved version.
2. **The status during the plan turn.** The picture shows `Running`; a `Planning` state word in the status line itself (instead of the activity) would need a task state the domain doesn't have. This file keeps `Running · Planning`.
3. **Reordering by drag** works with the keyboard too (`Alt+↑/↓`). If drag adds more code than it's worth, ship the keyboard and the remove button only.

## Wrong in the image

| In the image | Build |
|---|---|
| `task-plan`, `task-plan-edit`: the plan-first marker wraps, with `profile Careful` on a second line | one 28px line; the detail truncates first |
| `task-plan-approved`: the build turn's status dot reads green | teal, milestone 1's running dot |
| `task-plan-approved`: the calculator project keeps its amber dot in the sidebar | no amber dot once nothing in the project waits on the viewer (it may still, for another task: real data decides) |
| `task-plan-edit`: `Add toCsv(results) in src/history/csv.ts` mixes mono and sans inside an input | an `Input` is plain text; inline code renders mono only in the read view |
| `task-plan-edit`: the composer sits about 25px lower than in `task-plan` | the composer is pinned; the thread scrolls |
| `task-plan-approved`: `Show the plan` on its own line under the receipt | inline after the receipt, 12px |
| The `x` remove icons bright | `--faint`, `--muted` on hover |
| Sidebar rows that don't exist yet (Automations, Memory, Insights, Members, Audit log, Background work, Runner pools) | the shared sidebar's real routes |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| `CALC-196`, `alex-desktop`, the plan's steps, `$0.21`, the token counts, names and times | demo data, not copy |
