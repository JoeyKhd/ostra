# Target: the Checks tab

> **Committed image:** `task-checks.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The target for the task page's **Checks** tab on `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`: the environment's checks after each turn that changed code, their output, "Ask the agent to fix", and what the checks did to the PR. The page around it is `../m2/task-ticket.md`, with the tabs from `task-changes.md`. Where the picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `task-checks.webp` | `CALC-174`, driven by Alex Kim, is in review with the session idle. Turn 3 ran the project's three checks: `whitespace` and `unit-tests` passed, `settings-json` failed with exit 1, so ostra made PR #483 a draft. The failed check is open with its output's tail and "Ask the agent to fix". Turn 2's checks all passed; turn 1 had one that timed out. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high), in one generation. References: the `task-changes` generation (2048 px, itself from the approved `../m2/task-ticket` original), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `task-checks.prompt.txt`.
- **Features:** F-054 checks before the PR. ADR 0052. Ticket 47 builds it; ticket 39 serves `tasks.checks` and `tasks.fixChecks`; ticket 23 holds the core side (check runs, the PR body's section, drafts).

## Purpose

After every turn that changes code, the runner runs the project's checks before it pushes. A member sees which passed and which didn't, reads a failure's output without leaving ostra, and hands the failure back to the agent with one press. The PR's draft state follows the checks, and the tab says why.

## Route

`/tasks/[task-id]?tab=checks` (the tabs: `task-changes.md`, "Route").

## Layout

The page's frame, header and tabs as `task-changes.md`. The Checks tab pins nothing at the bottom: no composer, no bar. Its body scrolls under the header.

1. **PR line,** 40px, 8px below the tabs, no box, one per task repo whose PR's draft state comes from the checks (below): `git-pull-request-draft` 15px `--muted`, then 13px: `PR #483 is a draft` weight 600 `--text`, the reason `--muted`, then 12px gap and teal `Open on GitHub` with `arrow-up-right` 12px. Then a 1px `--line`.
2. **Turns,** newest first. The newest turn with checks is open; the others are folded rows.
   - **Turn header,** 40px: a 16px chevron column (`chevron-down` open, `chevron-right` folded, 14px `--muted`), `Turn {n}` 13px weight 600 `--text`, 12px gap, mono 12px `--faint` `{time} · {sha7}` (the commit the checks ran on), then right-aligned the summary: counts in 12.5px sans (`{n} failed` `--red`, `{n} timed out` `--red`, `{n} couldn't run` `--red`, `{n} passed` `--green`, joined by `--faint` ` · `), then 16px gap and the turn's total time mono 12px `--faint`. The whole header is the fold's button.
   - **Check rows,** 40px, 1px `--line` between them, a strict grid: the 16px chevron column (`chevron-right`/`chevron-down`, for every row with output), a 16px status icon, 10px, the check's name in mono 12.5px `--text` in a 150px column (truncated, full in `title`), the command in mono 12px `--faint` (one line, truncated, full in `title`), then right-aligned the status word 12.5px and the duration in mono 12px `--faint` in a 56px right-aligned column. A check that runs in one repo of several adds the repo's name as a `.chip` after the name (milestone 4 replaced the chip with a section per repo: "Several repos", below).
   - **Output,** under an open row, indented to the name column: a 12px `--faint` label, 6px, then the output block (`.code`: `--surface`, 1px `--line`, radius 8px, padding 12px 14px, mono 12px/1.6, `--muted`, `white-space: pre-wrap`), the last 40 lines. Plain text: no ANSI colours, no links, nothing interpreted. ANSI escapes are stripped.
   - **Fix row,** 44px, after the last failing check's output in the newest turn only, indented to the name column: `Ask the agent to fix` (primary: `--shell` fill, `--ink` text, `wrench` icon), 16px, teal `Download the full output` with `download` 13px (this check's blob), then 12px gap and the hint 12px `--faint`.
3. **Footnote,** 16px below the last turn, 12px `--faint`: `Checks run after every turn that changes the code, before the push. They come from the project's environment.` + teal `Edit checks` to the project's Environment page, for project admins only.

A failed or timed-out check opens on load; a passed one is folded. Opening and folding is per viewer, not saved.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. Everything in this section is **new**.

### The tab's marker (in the tab list, every tab)

| The newest turn's checks | After `Checks` |
|---|---|
| all passed | `circle-check` 13px `--green` |
| some failed, timed out or couldn't run | `circle-x` 13px `--red` + mono 12px `--red` count of them |
| running | `loader-circle` 13px `--muted`, spinning (still with reduced motion: no spin) |
| none ever ran | nothing |

### Check rows

| `check` status | Icon (16px) | Word (12.5px) | Duration |
|---|---|---|---|
| waiting (in the spec, not started) | `circle-dashed` `--faint` | `waiting` `--faint` | none |
| running (`check.started`, no `check.finished`) | `loader-circle` `--muted`, spinning | `running` `--muted` | live, mono `--faint`, `12 s` |
| `passed` | `circle-check` `--green` | `passed` `--green` | `1.2 s` |
| `failed` | `circle-x` `--red` | `failed · exit {code}` `--red` | `0.4 s` |
| `timed-out` | `timer-off` `--red` | `timed out after {limit}` `--red` | none (the limit says it) |
| `error` (it couldn't start) | `triangle-alert` `--red` | `couldn't run` `--red` | none |

- Durations: under 60 s as `{n.n} s`; then `{m} min {s} s`; whole minutes as `{m} min`. Mono.
- **Output label:** `Output, last 40 lines`; a shorter tail `Output, {n} lines`. A tail longer than 40 lines starts folded at its last 40 with a teal 12px `Show all {n} lines` above the block (the tail is at most 16 KiB).
- **No output:** the block is replaced by 12px `--faint` `No output.`
- **`couldn't run`:** the output block holds the runner's reason as plain text, for example the shell's `command not found`.
- **Download:** `Download the full output` serves the blob as `text/plain`, attachment (ticket 39). No blob: 12px `--faint` `The full output wasn't saved.` in its place.

### Ask the agent to fix

One action per turn: it sends every failing check's command and output tail as one message (`intent: "fix-checks"`, ticket 23), by the composer's rule. It shows only in the newest turn with checks, and only when one failed, timed out or couldn't run.

| Condition | Hint | Button |
|---|---|---|
| one failing check, the viewer drives, the session idle | `Sends this check's output to {agent} as the next turn.` | `Ask the agent to fix` |
| several failing | `Sends the {n} failing checks' output to {agent} as the next turn.` | the same |
| a turn is running | `Sends it to {agent} after the current turn.` | the same |
| no session going | `Sending reopens the task with the output.` | the same |
| a session is going and the viewer isn't the driver | `{name} is driving.` + teal `Take over` | disabled |

- **In flight:** `Sending…`, disabled.
- **Sent:** the button and hint are replaced by 12px `--muted` `Asked {agent} to fix it at {time}.` + teal `See it in Activity`. It stays until a newer turn's checks arrive.
- **Refused:** a red 12px line under the row with the API's message (spend cap and the rest: `../m2/task-reopen.md`).

### The PR line

One line per task repo, for the PR's draft state as the checks left it. `{pr}` is `PR #483`; with several repos, `PR #483 in calculator-web`.

| State | Icon | Text |
|---|---|---|
| ostra made it a draft (`draftByOstra`) | `git-pull-request-draft` `--muted` | **`{pr} is a draft`** + ` because a check failed after turn {n}. ostra marks it ready when every check passes.` |
| ostra marked it ready again | `git-pull-request` `--green` | **`{pr} is ready for review`** + `: every check passed after turn {n}.` |
| a person made it a draft | `git-pull-request-draft` `--muted` | **`{pr} is a draft`** + ` on GitHub, so it stays one when the checks pass.` |
| it opened ready and every check passed | none: no line |
| no PR yet | none: no line |

Each line ends with teal `Open on GitHub`.

### The tab's body

| Condition | Shows |
|---|---|
| loading | 4 skeleton rows |
| the environment has no checks | centred, 13px `--muted`: `No checks for this project.` and 12px `--faint` `Checks are commands from the project's environment that run after every turn that changes the code.` + teal `Add checks` (project admins) |
| checks set, no turn has changed code yet | the footnote alone, above it 13px `--muted` `Checks run after the first turn that changes the code.` |
| the task's runner is too old to run checks (a minor-1 runner) | 13px `--muted`: `This task's runner doesn't run checks. Update the runner to get them.` |
| `tasks.checks` failed | red 12px `The checks couldn't be loaded: {error}` + teal `Try again` |
| a turn whose checks are running | its header shows `Turn {n}` + mono `{time}` + right `running` `--muted`, and its rows as the table says, live from `check.started` and `check.finished` |

### Properties

The Code group gains one row after the repos' PRs, on every tab:

| Row | Values |
|---|---|
| Checks **new** | `{n} failed` `--red` + `--muted` ` · {m} passed`; `All {n} passed` `--green`; `Running` `--muted`; hidden when no check ran. Sans 12.5px, the key `--muted` like the others |
| PR (per repo) | `#483` teal + `--muted` ` · draft` when it's a draft (`task-ticket.md`'s `· open` otherwise) |

### The top bar

A draft PR's button uses `git-pull-request-draft` in place of `git-pull-request`: `PR #483`.

### Several repos (milestone 4, F-098)

The m4 spec grows this screen with a section per repo for a task with several (section 12, "Screens that only grow"). Built 2026-11-20:

- **An open turn** of a task with two or more repos holds a section per repo a check ran in, in the project's order, then the checks that ran at the workspace root. A repo the turn didn't change runs none of its checks, so it has no section that turn.
- **Section heading,** 32px, 1px `--line` above, the 16px chevron column left empty: the repo's full name in mono 12.5px `--text` (truncated, full in `title`), 10px, the commit its checks ran on there, mono 12px `--faint` (7), then right-aligned the section's own summary in 12px sans with the turn summary's tones. The workspace root's heading is 12px `--muted` `Workspace root`, with no commit.
- **The turn's header** keeps its time and summary and drops the commit: each section names its own.
- **Check rows** as above, without the repo's chip: the section names the repo.
- **Ask the agent to fix** follows the last failing check as the sections order them, and still sends every failing check of the turn.
- A task with one repo keeps the one list, with the commit in the turn's header.

## Tokens and components

Tokens: `app-concepts/html/graphite.css`; nothing new. Red carries every failure, never amber: a failing check doesn't wait on a person, it waits on whoever presses "Ask the agent to fix" (`app-design.md`, one meaning per colour). Icons (Lucide): `circle-check`, `circle-x`, `circle-dashed`, `loader-circle`, `timer-off`, `triangle-alert`, `chevron-down`, `chevron-right`, `wrench`, `download`, `git-pull-request`, `git-pull-request-draft`, `arrow-up-right`.

| Part | Component |
|---|---|
| Turn and check folds | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` (a disclosure each; the rows aren't a table) |
| Output | the `.code` block `renderers.tsx` already uses for tool output |
| Ask the agent to fix | `Button` `default` |
| Download, Open on GitHub, Take over | `Button variant="link"` / `a` |
| Chips | `.chip` / `Badge variant="outline"` |
| Skeleton | `Skeleton` |

New files under `components/tasks/task-checks/` (ticket 47).

## Differences from the current code

1. **No Checks tab and no check runs today:** the tab, its rows, the output block and the fix row are new, on `tasks.checks` and `tasks.fixChecks` (ticket 39), live from `check.started` and `check.finished` in the task's stream.
2. **Properties:** the Code group gains the `Checks` row, and each PR's value its `· draft`.
3. **Top bar:** the PR button picks its icon from the PR's draft state (`task-view.tsx` always draws `GitPullRequestIcon`).

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Checks in several repos.** The spec lets a check name a repo (`repoId`) or none. A check with no repo in a task with two repos: the target shows it once, without a chip. Say if it should run, and show, once per changed repo.
2. **A turn without changes runs no checks** (ADR 0052), so it has no section here. The turn numbers can then skip (`Turn 3`, `Turn 1`); the target keeps the real turn numbers rather than renumbering.

## Wrong in the image

| In the image | Build |
|---|---|
| `PR #483` in the top bar with the plain pull-request icon | `git-pull-request-draft`, since the PR is a draft |
| The PR line's icon as a plain pull-request icon | `git-pull-request-draft` |
| The `Turn 3` header without a chevron, and `Turn 2` / `Turn 1` indented after theirs | every turn header has the 16px chevron column first, so all three `Turn` labels start at the same x |
| `whitespace` and `unit-tests` rows without a chevron | every row with output has one (`chevron-right` folded) |
| Turn 3's summary all `--faint` mono | sans, `1 failed` `--red`, `2 passed` `--green`, `--faint` separators; the total mono `--faint` |
| Turn 1's `10 min` beside `1 timed out` | the turn's total time, which includes the timed-out check's limit |
| The `SyntaxError` line in red | every output line `--muted`: ostra doesn't parse output |
| A vertical divider between `Download the full output` and the hint | 12px gap, no divider |
| `Checks` in the properties panel in mono, and `1 failed` in mono | sans 12.5px, key `--muted` |
| The Code group lists only `calculator-web` | every task repo with its PR, as the Changes tab's picture shows (`calculator-api #91`) |
| The `Linear` sidebar icon as bars | the shared sidebar's icon |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| Check names, commands, output, SHAs, durations, times, `$1.12` | demo data, not copy (the check names follow the demo's `whitespace` and `settings-json`) |
