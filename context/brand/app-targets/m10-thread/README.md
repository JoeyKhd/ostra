# Milestone 10's thread targets: the compact thread

The design targets for the task thread, made as calm and compact as Claude Code on the web, in ostra's own look. They restyle the thread every earlier milestone built; they add no feature.

**Status: a proposal, 2026-11-22.** Nothing is built from these until the maintainer approves them. The choices to settle are at the end, each with its recommendation.

**Why:** the maintainer, 2026-11-22: "our chatbox is soooo verbose and ugly compared to claude code on claude.ai". Every thought, command (with full raw paths), `Show the output` and tool call was its own row; bookkeeping (`Work saved after turn 3 · archive 193 kB · unfinished work not saved`, `The session ended without changes: no pull request.`) sat in the conversation; a token line (`Max · 13.4k in · 2.6k out · 1.6k reasoning`) followed every turn. The reference: a member's messages as right-aligned bubbles, the agent's prose as the page, activity folded into one quiet line (`Ran 5 commands ›`) that opens on click, and one clean box to write in.

**What must not be lost,** and where each one is: failures stay visible, compact (a red word on the run's line, or their own line when the turn didn't recover); needs-you stays unmissable (the amber rule, and a pill when it's scrolled away; amber means only that); the agent's question with its choices; screenshots and attachments; PRs and checks; plan approval; the agent's current step while it works (the live step).

## How they're made

As milestone 9's (`../m9/README.md`, "How they're made"): real HTML on the panel's own CSS and fonts, not image-model pictures (`../../app-design.md`, rule 5).

- **Loaded, not copied:** each page in `html/` loads `../../m8/html/m8.css` (the panel's tokens for both themes, IBM Plex Sans and Mono and Manrope from `apps/web/src/fonts/`, the shell's styles), `../../m8/html/shell.js` (the double sidebar), `../../m8/html/app-fixture.js` (Tally, the demo app), and `../../m9/html/m9.css` and `m9.js` (the strip, the file chip, the needs-you rule). Icons are Lucide 0.460.
- **This milestone's parts:** `html/m10.css` (every part, tokens only, no new colour) and `html/m10.js` (the parts as HTML and the scenes' data). Pages: `thread.html` (desktop scenes), `phone.html`, `states.html`.
- **Where they come from:** three directions were drawn (A "prose-first, like the reference", B, C); a critique picked A and listed grafts from B and C and fixes. These targets are A with those grafts and fixes, as one set.
- **The render:** Playwright's Chromium (`playwright@1.65.1` from the repo's `node_modules`) at each target's exact viewport and 2×, to `<name>.png`; `html/to-webp.py` writes `<name>.webp` at one image pixel per CSS pixel:

  ```
  node html/render.mjs <path to playwright/index.mjs> [name ...]
  python -I html/to-webp.py [name ...]
  ```

- **No Higgsfield credits were used.**
- **All data is demo data:** Acme Corp, `calculator`, `CALC-192`, `CALC-196`, PR #483, Sam Rivera, Alex Kim, Priya Shah, the runners, paths, numbers and times. Model names are milestone 8's.

## Screens

| Scene | Targets | Build spec |
|---|---|---|
| **S1.** A code task mid-turn: the live step running (`Running pnpm test history · 8 steps done, 1 failed · 3:52`), `Interrupt and send` | `s1-working` | `s1.md` |
| **S1.** The same turn paused on OpenCode's question: one line per run, `1 failed, then passed`, the capture `1280 · /history`, prose ending in the question, the choices with `Something else…`, `Send answer` asleep | `s1` | `s1.md` |
| **S2.** Three turns later: earlier turns compact with their times, the last turn's summary, `Pushed ostra/calc-192-history-panel · 3 checks passed in the box`, the PR card cut to title, size and `CI on GitHub: running, 2 of 4 jobs done`; the turn's numbers in the time's tooltip | `s2` | `s2.md` |
| **S3.** A review task: Activity and Event log only, `Open the code task` and `PR #483` in the top bar, ostra's outlined `AI review of PR #483, round 2 of 3`, 23 steps on one line, the one unrecovered failure on its own line, the outcome as prose, no PR or archive lines | `s3` | `s3.md` |
| **S4.** A run opened: reads on one row, each command with its exit and duration and `output ›`, edits with `+/−` and `diff ›`, a thought's excerpt with `show ›`, the footer with the turn's numbers and `Event log ›`; the question scrolled away, so the pill | `s4` | `s4.md` |
| **S5.** Plan first: the plan as a numbered list inside the amber rule with `Approve plan`, `Edit and approve`, `Ask for changes to the plan` | `s5-plan` | `s5.md` |
| **S5.** After approval: `Plan approved by Alex Kim, with edits · 14:09 · Show the plan`, the build turn, the live step naming the plan step | `s5-approved` | `s5.md` |
| **S6.** S1 on a phone (390×844) | `s6-phone` | `s6.md` |
| **S6.** A run tapped open on a phone: the footer is how a phone reaches the numbers and the Event log | `s6-phone-open` | `s6.md` |
| **S7.** S1 and S3 in the light theme | `s7-s1-light`, `s7-s3-light` | `s7.md` |
| The steps' states: the live step's words, a running command opened, a recovered and an unrecovered failure, a failed turn, a limit, subagents, effort marks | `states-steps` | `states-steps.md` |
| What waits on a person: an approval pending and answered, the question for a watcher, `Something else…`, a reply, a round limit | `states-asks` | `states-asks.md` |
| Messages, dividers and results: CI and findings rounds, a held round, a PR comment, diff comments, a reopen, a new driver, `queued`, the result lines | `states-messages` | `states-messages.md` |

**The parts** (sizes, tokens, copy, data and keyboard, once for every screen): `parts.md`.

## Files

- **Build specs:** `parts.md`, `s1.md` to `s7.md`, `states-steps.md`, `states-asks.md`, `states-messages.md`.
- **Pictures:** each desktop target a 2880×1912 `.png` and a 1440×956 `.webp`; the phone targets 780×1688 and 390×844.
- **Sources** in `html/`: `thread.html`, `phone.html`, `states.html`, `m10.css`, `m10.js`, `render.mjs`, `to-webp.py`.

## Rules

The earlier milestones' rules hold (`../m1/README.md` to `../m9/README.md`): the build spec wins on copy, states and behaviour; the picture wins on size, spacing and contrast, and here a picture is HTML, so its sizes are exact CSS px; real data only in the build; check each screen by eye against its picture at its viewport after the build.

New for milestone 10:
- **The reading line holds only what a member reads** (`parts.md`, "The rule of the column"). Bookkeeping is one press or one hover away, never a line.
- **Activity has no icon; results do.** A run's line is words and a chevron; a push, a PR, a review, a draft, a preview and a memory each have an icon.
- **Filled is a person typing here; outlined is ostra by itself, or GitHub or Linear.**
- **One red word, not a red row,** for a failure the turn recovered from. A red line only for one it didn't.
- **Checks are ostra's, in the box; CI is the code host's, counted in jobs** (`parts.md` part 13).
- **Never a box inside a box,** as before: the plan's list sits in the amber rule.

## The choices to settle

Each with the recommendation the pictures follow.

| # | Choice | Recommended | The alternative |
|---|---|---|---|
| 1 | Where a turn's numbers go (tokens, reasoning, effort, spend, saved work) | The opened run's footer (with `Event log ›`), a tooltip on the turn's time, the panel's Usage and Session, the Event log | A line under every turn (today), or the Event log alone |
| 2 | The time anchor | On each turn's first line, mono `--faint`; no turn header | The time only in the tooltip, or a header per turn |
| 3 | A failure the turn recovered from | `1 failed, then passed` on the run's line, red only on `failed`; its own red line only when not recovered | Every failure as its own line |
| 4 | "Recovered", exactly | A later step of the same kind and subject (command line, path, URL) in the same turn succeeded | The agent's own word for it, or any later success |
| 5 | `Something else…` on an enum question | ostra adds an optional free-text field to every enum question it relays; the agent gets the words as the answer (ACP elicitation forms take strings) | The form closes as declined and the words go as the member's next message |
| 6 | ostra's own messages and GitHub's | Right-aligned, outlined (`ostra · automatic`, `{login} on GitHub`) | Left-aligned system rows |
| 7 | Checks and CI | Two words: checks (ostra's, in the box) and CI (the code host's, counted in jobs) in the line, the card, the panel and the tab | One word, "checks", for both, with the place after it |
| 8 | The PR card | Once, under the push that opened it: title, size, the live CI line; later pushes are one line | A card per push, or no card (the top bar's button only) |
| 9 | A pending approval during a run | Its step leaves the run and stands where the live step was, the block under it | The run opens to show the step |
| 10 | A review task's page | Tabs `Activity` and `Event log`; top bar `Open the code task`, `PR #483`; no `Take it local`, `Changes`, `Checks`, `Code` group, saved-work or PR lines | The code task's page with empty tabs |
| 11 | Names over bubbles | Always (several members steer one task) | Only when the author changes |
| 12 | The needs-you pill | On a solid 46px band above the composer, only while the block is out of view | A floating pill over the thread, or none |
| 13 | Captures | Visible under their run's line | Folded with the run |
| 14 | The composer | One box with an icon Send, the hint and the model under it; `Interrupt and send` labelled while a turn runs | Milestone 9's two-row box with labelled `Send` |
| 15 | The status line when no turn runs | Names the box: `box idle, stops in 11 min`, `box released` | The elapsed time and runner, as now |

## The content fixes the build must also make

These aren't visual; the screens depend on them.

1. **Runs in the fold** (`packages/task-view`): group a turn's consecutive non-text parts into runs, each with its counts by kind, its first thought's duration, its failures with a `recovered` flag (choice 4), and its approvals' outcomes. Results (push, PR, posted review, draft, preview, memory) and needs-you parts break a run.
2. **Bookkeeping leaves the parts:** `session.saved`, `session.ended` (`data-session-end`), `runner.connected`, a box's idle stop and release, `session.config_changed` made by ostra, and each turn's usage line become fields of the turn (`meta.saved`, `meta.ended`) and the task, not thread rows. The Event log keeps every event.
3. **Step durations:** keep each tool call's start and end (from `tool.called` and its `tool.completed` / `tool.failed`, already stored) and each reasoning part's, so commands show `4.1 s` and a run says `Thought for 6s`.
4. **Spend per turn:** the fold carries the turn's spend from the key proxy's `usage.recorded` (today only tokens per turn), for the footer and the tooltip.
5. **Review and refine tasks get no PR, push, archive or "ended without changes" lines:** the core doesn't save an archive's line for a read-only kind's turns, and the panel hides `Changes`, `Checks`, `Take it local` and the Code group for them (a refine task keeps its Draft tab).
6. **A repeat `ostra_submit_review` isn't a failure:** a second submission for a round already posted answers success, `already submitted, kept as it was`, so the thread shows a neutral result (`Review on PR #483 confirmed · already posted this round, unchanged`), never `other ostra_submit_review … failed` in red. ostra's own tools (`submit_review`, `submit_draft`, `show_preview`) are recognised by kind, with their own words, never shown as `other`.
7. **Paths read relative:** a command's line and a step's subject show paths relative to the workspace root (the runner's `…\.ostra\runner\tasks\{id}\agent\…` and `/workspace/{repo}/` prefixes stripped, the home folder as `~`); the full path stays in the `title` and the Event log.
8. **Tool names:** a generic tool's row says `Used {tool}`, never the kind word `other`; an MCP tool's server is shown faint before it.
9. **The live step's words** come from the running part, `task.doing.*`, with the turn's `{n} steps done`, the unrecovered failures and, for a plan, the entry in progress (`Plan step 1 of 6: …`); the elapsed time from the turn's start.
10. **Answers become receipts:** a `question-answer`, `plan-approved` or `approval-answer` message isn't drawn as a member's bubble; its needs-you block becomes the receipt (`Sam Rivera answered Replace the display`).
11. **`Something else…`** (choice 5): ostra adds the free-text field to every enum question, and `questions.answer` takes it.
12. **CI is counted in jobs:** the PR card, the panel's `CI` row, milestone 6's stage words and the home board's sub-state say `{k} of {n} jobs`; `checks` means only ostra's checks in the box (`Passed · 3 checks` in `../m6/review-screen.md` becomes `Passed · 3 jobs`).
13. **Turn ordinals:** the fold numbers a task's turns (`Turn 4`) across sessions, for the footer, the tooltip and the Event log link (`?tab=events&seq={first seq}`).
14. **A capture's route:** the capture row and caption read the attachment's own `target.path` (`/history`), never `/` by default.
15. **The status line** gains the box's state when no turn runs (`box idle, stops in 11 min`, from `tasks.get`'s box and idle timer).
16. **Copy:** new strings under `task.run.*` (a run's words), `task.doing.*` (the live step), `task.result.*` (result lines) and `task.footer.*` in `apps/web/messages/en.json`; milestone 1's `Show the output` / `Show the diff` become `output ›` / `diff ›` (`hide output ›` / `hide diff ›`).
