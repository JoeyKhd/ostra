# The compact thread's parts (approved 2026-11-22)

Every screen in this folder is built from the parts below. Each screen's own `.md` says which parts it shows and in what state; this file gives their sizes, tokens, copy and data once. Sizes are CSS px, as `html/m10.css` draws them. Where a picture and this file disagree, this file wins.

- **Route:** unchanged, the task page's Activity tab (`apps/web/src/app/(panel)/tasks/[task-id]/page.tsx` → `components/tasks/task-view.tsx` → `task/task-thread.tsx`).
- **Replaces:** milestone 1's thread rows (`task/renderers.tsx` `Line`, `MessageView`'s 28px avatar column and header, `TurnUsage`), and milestone 2's message-level system rows. The needs-you blocks, the strip, the file chip and "What the agent got" keep their approved content, restyled where this file says.

## The rule of the column

The reading line holds what a member reads: what people said, what the agent said, what it made, and what waits on them. Everything else folds or moves.

| What | Where it goes |
|---|---|
| A member's message | a right-aligned bubble |
| What ostra sent by itself, or what came from GitHub or Linear | the same bubble, outlined |
| The agent's text | plain prose, full width, no avatar, no header |
| The agent's steps (reads, edits, commands, searches, thoughts, subagents) | one quiet line per run of steps, which opens in place |
| The step it's on, while a turn runs | the live step line, rewritten in place |
| What a turn made (a push, a PR, a posted review, a draft, a preview, a memory) | one result line with an icon, after the prose |
| Screenshots and recordings | milestone 8's strip, under the line of the run that took them |
| A failure the turn didn't recover from | its own red-marked line under its run |
| What waits on a member | the amber block, where milestone 3 and `app-design.md` rule 3 put it |
| Tokens, spend, effort, saved work, archive sizes | the opened run's footer, the time's tooltip, the properties panel and the Event log. Never a line in the column |

## 1. The column

- `max-width: 720px`, left-aligned in the page's padding (`.page`, 26px 36px 20px, milestone 8). The composer below it has the same width.
- The thread scrolls; the header, tabs and composer don't. It opens scrolled to its end.
- Vertical rhythm: prose blocks `margin: 4px 0 6px`; lines `margin: 6px 0`; a member's message `margin: 24px 0 18px` (the space before a person speaks is the turn's boundary, so no header is needed).

## 2. A member's message (`.um`, `.bubble`)

- **The line over it:** right-aligned, 4px in from the bubble's edge, 5px above it. The name 12.5px weight 500 `--muted`, 6px, the time Plex Mono 12px `--faint` (`formatClock(meta.at)`), then any tag as 12.5px `--faint` ` · {tag}`.
- **The bubble:** `max-width: 82%`, `padding: 9px 14px 10px`, `border-radius: 16px`, `--sel` fill, 14.5px/1.55 `--text`. Paragraphs 6px apart. Inline code: Plex Mono 13px, 1px `--line`, radius 5px, `--bg` fill.
- **Attachments** (milestone 9's message files): above the bubble, right-aligned, 8px gaps, 6px above the bubble: images as milestone 8's thumbnails (84px tall here), files as milestone 9's chip at 48px tall on `--bg`. Their behaviour (viewer, download, `text extracted`) is milestone 9's.
- **Tags** after the time (each `--faint`): `queued`, `after an interrupt`, `sending…`, `reopened the task`, `replayed`, `asked for changes` (a plan revision), `{n} comments on the diff`, `asked to fix {n} checks`, `from a comment on {key}` (a Linear follow-up). `held` is `--red` 12.5px (F-037).
- **The first message of a ticket task** is milestone 9's "What the agent got", drawn as this bubble (`.bubble.got`, 82% wide, padding 11px 14px): `ticket` 13px `--faint` + the key mono 12px `--text-2` + `from Linear · what the agent got` 12.5px `--muted`; the title 600; the description; then `paperclip` 13px + `1 image · 2 comments` 13px `--faint` + teal `Show it all ›`. Its states (skipped, failed with Retry) are milestone 9's.
- **What a message carries** for ostra (F-072's `AgentMessage` kinds) is drawn from its data, never its prompt, as today. Inside the bubble a quoted item (a diff comment, a PR comment, a check) has a 2px `--line-3` left line and 10px padding: the place mono 12.5px `--faint`, the quoted line mono 12.5px `--muted` (one line, ellipsis), the words 14px `--text`.

### Outlined: ostra's own, and what came from outside (`.bubble.auto`)

The same bubble with no fill and a 1px `--line-2` edge. It's how a reader tells "a person typed this here" from "ostra sent this by itself" or "this came from GitHub or Linear".

| Message (`AgentMessage.kind` or intent) | Name over it | Tag | Body |
|---|---|---|---|
| `ai-review` | `ostra` | `automatic` | `AI review of PR #{n}` 600 + `, round {n} of {limit}`; then 13.5px `--faint` `{files} files, {+a −d} · the PR's commits, {key} and its criteria` (counts mono 12.5px); then teal `What the agent got ›` (opens today's folded text) |
| `fix-ci` | `ostra` | `automatic` | `CI round {n} of {limit}` 600 + `--faint` ` · automatic turn {k} of {limit}`; one 24px row per failing check: `x` 13px `--red`, the name mono 13px `--text`, the conclusion `--faint`, the log mono 13px teal (opens the tail) |
| `fix-findings` | `ostra` | `automatic` | `Findings round {n} of {limit}` + the automatic turn; 14px `--faint` `Sent {b} blocking finding(s): {titles}. {n} nit(s) listed, not required.`, titles `--text` |
| a held round | | | inside its bubble, 13px `--faint` with `pause-circle` 13px: milestone 6's held copy |
| `closing-turn`, `refine` | `ostra` | `automatic` | their summary, as `agentMessageSummary` gives it |
| `pr-comment` | `{login} on GitHub` | `PR comment` | the place and the words as a quoted item; under it teal `Open on GitHub` and `Remember this` (F-111), 10px apart |
| `changes-requested` | `{login} on GitHub` | `changes requested` | the review's text and its line comments as quoted items |
| `linear-follow-up` | the member | `from a comment on {key}` | the words, filled (a member wrote them) |

## 3. The agent's prose (`.prose`)

14.5px/1.6 `--text`, the full column width, `.agent-md` markdown as today (no raw HTML, safe links, no remote images). Paragraphs and lists 10px apart, list items 5px, bullets `--faint`. No avatar, no name, no time, no status word: the run's line carries the time, the header carries the state.

## 4. A run's line (`.fold`)

A **run** is the steps between two pieces of prose in one turn (or between a turn's start and its first prose, or its last prose and its end). Each closed run is one line.

- **Box:** a `button` with `aria-expanded`, `min-height: 28px`, `padding: 0 6px`, `margin: 6px 0 6px -6px` (so its text lines up with the prose), radius 6px, `width: fit-content`. 14px `--faint`, one line, ellipsis. Hover and focus: `--hover` fill, words `--muted`; focus adds the panel's 2px `--teal` outline. Then `chevron-right` 14px `--faint`, turned 90° when open.
- **The time** (the turn's anchor): on the turn's **first** line only, 4px after the chevron, Plex Mono 12.5px `--faint`: `formatClock(meta.at)`. Hovering or focusing it shows the tooltip (part 9) and draws a dotted `--line-3` underline under it. A turn with no steps has no line and so no time; its numbers are in the Event log and the panel.
- **The words** (`en.json`, `task.run.*`), counts in the order their first step happened, joined by `, `, the first capitalized:

| Steps | Words |
|---|---|
| a thought that starts the run | `Thought for {n}s` (from its start and end). A thought later in a run isn't named. |
| reads | `read {n} file(s)` (distinct paths) |
| edits | `edited {n} file(s)` (distinct paths) |
| commands | `ran {n} command(s)` |
| code searches | `searched the code {n} time(s)` (`twice` for 2) |
| web searches and fetches | `searched the web {n} time(s)`, `fetched {n} page(s)` |
| captures | `took a screenshot`, `took {n} screenshots`, `recorded a video` |
| subagents | `ran {n} subagent(s)` |
| the setup script | `set up the box in {duration}` |
| a compaction | `compacted the context` |
| any other tool (MCP, ostra's own) | `used {n} tool(s)` |

  - Two counts in a row that share a noun drop the second's: `Read 2 files, edited 2`.
  - Over 20 steps the line starts with the total: `23 steps: read 9 files, …`.
- **The tail,** after ` · ` `--faint`:
  - a failure the turn recovered from: `1 failed, then passed` (`{n} failed, then passed`), with `--red` only on `failed`;
  - an answered approval: `1 approved by {name}`; a denied one: `1 denied by {name}` with `--red` only on `denied` (`, with a reason` when there was one).
  - A failure the turn didn't recover from is **not** in the tail: it has its own line (part 7).
- **Subagents:** after the chevron, 6px, milestone 7's badge (24px, `--surface`, 1px `--line-2`, radius 6px, `layers` 13px + `{n} subagents` 12.5px 500 `--text`, then ` · ` and the one state that matters: `{n} need approval` amber dot `--amber-text`, `{n} failed` `--red`, `{n} running` with an 10px spinner, `--teal`). It opens the subagents window (F-138).

**What "recovered" means:** a failed step (a command's exit other than 0, `killed`, or any tool's `output-error`) is recovered when a later step in the same turn, of the same kind and the same subject (the same command line, path or URL), succeeded. Otherwise it isn't. A cancelled step isn't a failure.

## 5. The live step (`.livestep`)

While a turn runs, its open run is drawn as this line, in the place its run's line will take. When the agent writes prose, the run closes into a run's line above the prose and a new live step starts under it. When the turn ends, the last live step becomes the last run's line, in the same place. The line keeps A's order: runs, then prose, never moved after the prose.

- **Box:** as the run's line (28px, `padding: 0 6px`, `margin-left: -6px`, a `button` that opens the run so far), 14px.
- A 12px spinner (milestone 8's `.spin`: 1.75px `--line-2` ring, `--teal` top; still, as a ring, with reduced motion), 8px, then **what the agent does now** in `--text-2`, its subject Plex Mono 13.5px `--text`; then `--faint` the turn's progress, ` · `-joined; then `chevron-right` 14px `--faint`.
- **What it does now** (`task.doing.*`, from the running part): `Thinking`, `Writing`, `Reading {path}` / `Reading {n} files`, `Editing {path}`, `Running {command}`, `Searching the code for {query}`, `Searching the web`, `Fetching {host}`, `Capturing {route}`, `Running a subagent: {type}`, `Setting up the box`, `Compacting the context`, or the tool's own title.
- **Progress:** `{n} steps done` (the turn's finished steps); `, {k} failed` with `--red` only on `failed` while a failure is not yet recovered; the plan step when the turn has a plan with an entry in progress: `Plan step {i} of {n}: {entry}` (the entry's text, ellipsis first); then the turn's elapsed time, Plex Mono 12.5px, `m:ss` from `meta.at`, ticking each second.
- **An approval waits** (part 11): the line holds the step that asks, still, with `pause` 14px `--muted` in the spinner's place: `Wants to run {command}` / `Wants to edit {path}` / `Wants to reach {host}` / `Wants to call {tool}`, then `needs approval` 13px 500 `--amber-text`. The amber block sits under it.
- The page's top-bar `Stop` and the composer's `Interrupt and send` show while it runs (milestone 1).

## 6. A run, opened (`.steps`)

Pressing a run's line (or the live step) opens its steps under it, in order. Nothing else moves.

- **Frame:** `margin: 0 0 10px 1px`, `padding: 2px 0 0 14px`, a 1px `--line-2` left line. No box.
- **A step:** a 28px row on a strict grid, `22px icon | 72px verb | subject`, 14px. Icon 14px `--faint`; verb `--muted`; subject Plex Mono 13.5px `--text-2`, one line, ellipsis, the full value in `title`. Then, 10px apart and inline (never pushed to the far edge): the result in Plex Mono 12.5px, then a teal 12.5px text link with `chevron-right` 12px that opens what it has.

| Step | Icon · verb | Subject | Result | Link |
|---|---|---|---|---|
| reads | `file-text` · `Read` | **every read of the run on one row**: the files' names, `, `-joined, the full paths in `title` | `--faint` `{n} files` | none |
| an edit | `pencil` · `Edited` (`Editing` while running) | the path, relative to the repo | `+{a}` `--green`, `−{d}` `--red` (U+2212) | `diff ›` |
| a command | `terminal` · `Ran` (`Running`) | the command line, relative paths (content fix) | `✓ exit 0` `--green` or `exit {n}` / `killed` `--red`, then `--faint` ` · {duration}` | `output ›` |
| a thought | `brain` · `Thought` | a one-line excerpt of its text, 13.5px sans `--faint`; verb and icon `--faint` | | `show ›` |
| a search | `search` · `Searched` | the query mono + `--faint` ` in {folder}` | `--faint` `{n} matches` | `results ›` |
| a fetch | `globe` · `Fetched` | the URL's host and path | `--faint` the status | |
| a capture | `image` · `Captured` | `a screenshot of` + the route mono; `{n} screenshots of …` | `--faint` the preview `web :5173` | |
| a subagent | `layers` · `Subagent` | its type mono + `--faint` ` · {description}` | `--faint` `{n} calls · {duration}`, then `check` `--green`, `running` `--teal`, `failed` `--red`, `stopped` `--faint` | `open ›` (the window, on it) |
| ostra's tools | their own words: `Submitted the review`, `Handed in the draft`, `Showed the preview` | | `--faint` the outcome (`already submitted, kept as it was`) | |
| another tool | `wrench` · `Used` | the tool's name mono (the MCP server `--faint` before it) | | `input ›` |
| the setup script | `square-terminal` · `Set up` | `the box` | `done · 41 s` `--green` + `--faint` ` · warm cache` | `log ›` |
| the PR's text | `git-pull-request` · `Wrote` | `the PR's text:` + its title | | `body ›` |
| a compaction, an app process, a skipped capture, no browser | `info` · their milestone 8 words | | | |

- **An answered approval** adds, after the result, 13px `--muted` `approved once by {name}` (the receipt words of milestone 3). A denied one: the result `denied` `--red` and the receipt.
- **An opened output or diff** (`.out`): under its row, at the subject's x (94px in from the frame), `padding: 8px 12px`, 1px `--line`, radius 8px, `--surface`, Plex Mono 12.5px/1.6 `--muted`, plain text, at most 320px tall then it scrolls. A diff keeps milestone 1's add and delete fills. The link reads `hide output ›` / `hide diff ›` while open. A running command's output streams into it.
- **The footer** (`.gfoot`), the run's last row: a 1px `--line` above, 30px, Plex Mono 12px `--faint`, its facts ` · `-joined, each kept whole when it wraps; at its right a teal 12.5px sans `Event log ›` to `?tab=events&seq={the turn's first seq}`. The facts, in order:
  1. `Turn {n}` (the task's turn ordinal);
  2. the level it ran at (`High`; left out at `Default`); a clamped turn: `Max, asked Extra high` (F-137);
  3. `{in} in`, `{out} out`, `{r} reasoning` (left out when none), `${spend}`; `≈` before an estimate; ` so far` after the spend while the turn is open;
  4. what was kept: `saved, archive 193 kB` / `not saved yet` / `unfinished work not saved` / `no archive (the upload failed)`; a code task that ended without changes: `ended without changes`. A review or refine task shows none of these.
  5. A turn with subagents adds `subagents {tokens} tokens`.
  Every run of a turn shows the same footer.

## 7. A failure the turn didn't recover from (`.failed`)

Its own line, directly under its run's line, in the reading column: 28px, 14px. `circle-x` 14px `--red`, 8px, the words in `--red` (`Command failed`, `Edit failed`, `Fetch failed`, `{tool} failed`), the subject Plex Mono 13px `--text-2`, then `--muted` ` · {what happened}` (`exit 2 after 38 s`, `403 Forbidden, not retried`), then a teal `output ›` / `details ›` that opens the run at that step with its output open.

The same line, without a subject, says a turn failed or a session crashed: `The turn failed · {error}` and `The box was lost before {agent} answered.` A stop that isn't an error (a time limit, the stall limit, a budget hold) is the same line with its icon `--muted` and its words `--muted` (`.notice`), and its action in teal (`Keep working`, `Open spend`).

## 8. A result line (`.fold.result`)

What a turn made, after its prose: a 14px icon `--faint`, 8px, one line 14px `--faint` with its subject `--text-2`, and either a chevron (it opens in place) or a teal link (it goes somewhere).

| Result | Icon | Words | Opens |
|---|---|---|---|
| a push | `git-commit-horizontal` | `Pushed {branch}` + ` · {n} checks passed in the box`; a failing check: ` · {k} of {n} checks failed in the box, so the PR is a draft` with `--red` only on `failed`. A later push to an open PR: `Pushed {sha7}` + ` · CI passed` once CI says | the commits and the checks, in place |
| the first PR | the PR card (part 10) | | |
| a review posted (a review task) | `message-square-text` | `Review posted on PR #{n}` (teal) ` · {verdict}`; a repeat submission: `Review on PR #{n} confirmed · already posted this round, unchanged` | teal `Open the review` |
| a draft handed in (a refine task) | `file-pen-line` | `Handed in draft v{n} · {criteria} acceptance criteria, {k} sub-tickets` | teal `Open the draft` |
| the preview shown | `app-window` | `Preview` + `{label} :{port}` mono + the path mono `--faint` | teal `Show` |
| a memory proposed | `lightbulb` | `Proposed a memory:` + its title `--text-2` | teal `Review` |

Saving unfinished work to a hidden ref is bookkeeping: it's in the footer, not a result line.

## 9. The time's tooltip (`.ttip`)

On the turn's time, on hover and on focus (keyboard), never on a phone (the footer is the touch path): 268px, `padding: 8px 11px 9px`, `--raise`, 1px `--line-2`, radius 8px, `--shadow-pop`, 12.5px/1.5. Placed above the time, its left edge 10px left of it; flips below when there's no room. Rows `74px key | value`, keys `--faint`, values `--muted` with numbers Plex Mono 12px `--text-2`:

- the head, `--text` 500: `Turn {n} · {start} to {end}` (`to now` while open);
- `Effort`, `Tokens` (`{in} in · {out} out`), `Reasoning`, `Spend`, `Saved` (`archive {size}`, `not yet`, `unfinished work not saved`).

## 10. The PR card (`.pr`)

Drawn once, under the result line of the push that opened it. Cut to what isn't elsewhere (the top bar has `PR #483`, the panel has the branch): 1px `--line-2`, radius 10px, `padding: 9px 14px 9px 12px`, `max-width: 560px`, no fill.

1. `git-pull-request` 16px `--green` (`git-pull-request-draft` `--muted` for a draft, `git-merge` for merged), 9px, the number Plex Mono 13.5px teal (a link to GitHub), the title 14.5px 500 `--text` (ellipsis), and at the right the size mono 12.5px `+{a}` `--green` `−{d}` `--red`.
2. 4px under, at the title's x, 13.5px `--muted`: the live CI line (part 13's words): a 11px spinner + `CI on GitHub: running, {k} of {n} jobs done` + `--faint` ` · then the AI review` (when the project's AI review is on); `CI on GitHub passed · {n} jobs`; `CI on GitHub failed: {job}` (`--red` on `failed`); `No CI on GitHub`. It updates in place.

## 11. Needs you, in the thread

Milestone 1's amber rule, flush with the prose: `margin: 12px 0 8px`, `padding: 2px 0 2px 14px`, a `--rule` (2px dark, 3px light) `--amber` left border. Title 14px 600 `--amber-text` with its 14px icon. Amber stays only here, on the status dot, and on the one amber button.

- **The question** (`data-question`, milestone 3's form, `message-circle-question`): the question 14.5px/1.55 `--text`; then the choices as radio rows, 30px each (44px on a phone), a 16px radio with a 1.5px `--control-line` ring (chosen: a 5px `--text` ring), the label 14px `--text`; the enum's values from the elicitation's schema, then always `Something else…`, which opens a 32px field under it (max 460px, 1px `--control-line`, radius 6px, `--surface`) and focuses it. Choosing never sends. `Send answer` (28px, amber fill, `--on-amber` text, 600) is the panel's disabled button (`--surface`, `--line-2`, `--faint`) until a choice holds a value, and `Sending…` in flight. Beside it, 13px `--faint`: `{agent} waits for your answer. Only the driver answers questions.`
  - **A member who isn't the driver:** the same block with a `--line-2` rule, the title `--muted`, the choices at 50% and `aria-disabled`, and in the button's place `Take over to answer` (outline) + `{driver} answers questions while driving.` (`Nobody is driving. Take over to answer.` with no driver).
  - **Answered:** a receipt line in its place (part 12): `{name} answered {the choice}` (`--text-2`) + the time.
- **The plan** (`data-plan-proposal`, `list-checks`): the entries as a numbered list right inside the rule, no box: 26px rows, the number Plex Mono 12.5px `--faint` in a 24px column, the entry 14.5px/1.5 `--text` with inline code mono. Then `Approve plan` (amber, `check`), `Edit and approve` (outline, `pencil`), `Ask for changes to the plan` (outline), 8px apart, 10px above; then 13px `--faint` milestone 3's footnote. The editor and the watcher's state are milestone 3's.
- **An approval** (`hand`): under the step that asks (part 5), milestone 3's card: the rule's sentence (`{rule} asks before {agent} runs this command:`, the rule 600), the subject chip (mono 13px, 1px `--line`, `--surface`, radius 6px, padding 6px 10px), `Deny` · `Approve once` (amber) · `Approve for this task`, the pattern line 13px `--muted`, the footnote 13px `--faint` `Any member of {project} can answer. The first answer wins.` Deny's reason field is milestone 3's.
- **Every other need** (a reply, a limit, a crash, a restore conflict, a round cap, a closed ticket): one block at the thread's end, as `app-design.md` rule 3 and `needs-you-cards.tsx` draw it today, with this part's sizes.

### Off screen: the pill (`.jumpband`, `.jump`)

When the open block is scrolled out of view, the thread's bottom 46px becomes a solid `--bg` band (an 18px fade from transparent above it), so the pill never sits on text; the thread's text scrolls behind the band, not under the pill. The pill is centred in it: 30px, radius 15px, `--raise`, 1px `--line-2`, `--shadow-pop`, padding `0 12px 0 11px`: the amber 7px dot, `Needs you · {question | plan | approval | reply}` 13.5px 500 `--text`, `arrow-down` 14px `--muted`. A `button`: it scrolls the block into view and focuses it. It goes once the block is in view. The composer stays where it is, 12px below the band.

## 12. Receipts and dividers

- **A receipt** (`.receipt`): a settled need in its place, 28px, 14px `--muted`: `check` 14px `--faint`, the words with the chosen value in `--text-2`, the time mono 12.5px `--faint`, and a teal link when there's more (`Show the plan ›`). Words: `{name} answered {choice}`; `Plan approved by {name}` / `…, with edits`; `Changes asked by {name}`; `{name} pressed Keep working`; `{name} carried on without the saved work`.
- **A divider** (`.divider`): a change a reader needs between turns, centred, 13px `--faint`, a 14px icon, 1px `--line` rules to both sides, `margin: 18px 0`:
  - the day (Plex Mono 12px, no icon): `Today`, `Yesterday`, `Mon 17 Nov`;
  - how a session came back (milestone 2's words): `history` `Restored from the session archive on {runner}` + ` · unfinished work restored`; `square-play` `Resumed in the same box`; `layers` `Rebuilt from the template · {reason}`;
  - the plan turn's and the build turn's markers (milestone 3's words);
  - `user-round` `{name} is driving now ({by} handed it over)`; `sliders-horizontal` `{name} set effort to {level}, from the next turn` + the time; `square` `{name} stopped the turn` + the time.
  Bookkeeping isn't a divider: a runner connecting, a box idling out, a release, a save.

## 13. Checks and CI: one vocabulary

ostra's own checks and the code host's CI are different things, so they keep different words everywhere (line, card, panel, tab):

- **Checks** are the project's environment checks that ostra runs **in the box, before the push** (milestone 3, F-054). Counted as checks: `3 checks passed in the box`, `Checks 3 of 3 passed · in the box`.
- **CI** is the code host's, on the PR, after the push (F-035). Counted as **jobs**: `CI on GitHub: running, 2 of 4 jobs done`, `CI Running · 2 of 4 jobs`.
- The **Checks tab** holds both (milestone 6 grew it); its marker follows whichever runs now: a spinning `loader-circle` while either runs, `circle-check` `--green` when both passed, `circle-x` `--red` + count when one failed.

## 14. The composer (`.cbox`)

One box: `min-height: 52px`, `padding: 9px 9px 9px 7px`, 1px `--control-line` (3.4:1, a field's edge), radius 12px, `--surface`. The paperclip (32px, milestone 9), the field (14.5px/22px, grows to 8 lines), then at the right `Interrupt and send` (32px, outline, `pause` 14px, 13px 500) while a turn runs and `capabilities.interrupt`, and Send: a 32px `--primary` square, radius 8px, `arrow-up` 17px; both disabled (35%) while the field is empty. Milestone 9's tray sits inside the box above the field.

Under the box, 7px, 12.5px `--faint`: the hint at the left (milestone 1–3's per-state hints), and at the right the next turn's model and effort in `--muted` with `chevron-down` 13px (a menu, F-137). The watcher's bar (milestone 3) takes the box's place for a member who can't send.

## 15. The header and the properties panel

- **Status line** (milestone 1): the state's dot and words, then ` · ` parts in `--muted`: the activity while a turn runs (`Running pnpm test history`), the sub-state's place (`PR #483`), and, when no turn runs, the box: `box idle, stops in {n} min`, `box stopped`, `box released`. While a turn runs: `Started {age} ago on {runner}`.
- **Tabs:** `Activity`, `Changes {n}`, `Checks` + its marker (part 13), `Event log {n}`. A review task: `Activity` and `Event log` only. A refine task: `Activity`, `Draft`, `Event log` (milestone 6).
- **The panel's `Session` group** is where the bookkeeping lives for the task as a whole: `Box` (`Running`, `Running · waits on you`, `Idle · stops in 11 min`, `Released`), `Saved work` (`After turn 4 · 193 kB`, `Not yet: the turn is open`), `Turns`. `Code` gains `Checks` and `CI` (part 13). Every other group is as its milestone drew it.

## Tokens

No new colour. `--faint` for lines, times, footers and meta; `--muted` for verbs, receipts and hovered lines; `--text-2` for subjects and live words; `--text` for prose and bubbles; `--sel` for a member's bubble; `--line-2` for an outlined bubble, the opened run's line and the PR card; `--teal` for links, the live spinner and focus; `--green` / `--red` for results and the one red word; `--amber` / `--amber-text` only for what needs you.

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--bg` (a run's line, times, footers) | 5.9:1 | 5.6:1 | 4.5 |
| `--faint` on `--hover` (a hovered line) | 5.4:1 | 5.1:1 | 4.5 |
| `--muted` on `--bg` (verbs, receipts) | 9.6:1 | 8.1:1 | 4.5 |
| `--text-2` on `--bg` (subjects, the live step) | 13.5:1 | 13.2:1 | 4.5 |
| `--text` on `--sel` (a member's bubble) | 15.5:1 | 15.0:1 | 4.5 |
| `--teal` on `--bg` (links) | 8.4:1 | 6.1:1 | 4.5 |
| `--red` on `--bg` (`failed`) | 5.9:1 | 5.7:1 | 4.5 |
| `--green` on `--bg` (`exit 0`, `+n`) | 7.4:1 | 5.5:1 | 4.5 |
| `--amber-text` on `--bg` (needs you) | 10.7:1 | 6.1:1 | 4.5 |
| `--control-line` on `--surface` (the composer's and a field's edge, a radio) | 3.4:1 | 3.4:1 | 3 (a control) |
| `--muted` on `--raise` (the tooltip, the pill) | 8.8:1 | 8.5:1 | 4.5 |

Colour never carries meaning alone: `failed` and `denied` are words, the dot sits beside `Needs you`, `exit 0` has its check.

## Keyboard and screen readers

- A run's line, the live step, a result that opens and the pill are buttons with `aria-expanded` where they open in place. Enter and Space toggle. The live step's words are a polite live region that announces at most once every 10 s (a new step), not each tick.
- The time is focusable (`tabindex="0"`) and shows its tooltip on focus; Escape closes it.
- The opened run is a list (`role="list"`); each step's link names its step (`Show the output of pnpm test history`).
- The question's choices are a `RadioGroup`; `Something else…` moves the focus into its field; `⌘↵` / `Ctrl+↵` sends.
- `j` / `k` (milestone 7's shortcut sheet) move between runs' lines and needs-you blocks.

## Reduced motion

The spinners stand still as rings; the live step's time still ticks; opening a run doesn't animate the chevron.
